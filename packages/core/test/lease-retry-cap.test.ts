/**
 * Acceptance tests of the abandoned-attempt cap at the lease grant (t1312, AT1–AT11).
 *
 * The incident behind this ticket (t1311, job 2): the runner threw AFTER the
 * agent had finished, never closed the session, and the next tick leased the
 * same job again — fourteen paid sessions with nothing in the way. The t265 cap
 * only counts sessions closed `failed`, and a session that is never closed is
 * never counted.
 *
 * So `POST /v1/leases`, the one choke point every redispatch passes, counts the
 * trailing run of ABANDONED attempts on the job's current node — a session left
 * `open` while the job holds no active lease. At the graph's
 * `max_consecutive_failures` (default 3) it blocks the job and answers
 * `retry_cap_reached`; below it, it spaces the attempts with a growing backoff
 * and answers `retry_backoff`.
 *
 * Every state is built through the real API. The passage of time is simulated
 * by backdating `lease.released_at` through `ctx.db`, the same device
 * `lease-dispatch-hold.test.ts` uses for setup.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as ServerModule from '../src/server.ts';
import type * as IndexModule from '../src/index.ts';
import {
  MIGRATIONS_DIR,
  PACKAGE_ROOT,
  request,
  resolvePins,
  type Event,
  type TestContext,
  type TestHook,
} from './support.ts';

const MINIMAL_GRAPH = path.resolve(PACKAGE_ROOT, '../../schema/examples/graph-valid-minimal.json');

/** The cap when the graph declares nothing (`DEFAULT_MAX_CONSECUTIVE_FAILURES`). */
const DEFAULT_CAP = 3;

interface LeaseAnswer {
  lease: { id: number; job_id: number } | null;
  reason?: string;
  retry_after?: string;
}

interface JobRead {
  id: number;
  blocked: boolean;
  block_reason: string | null;
  current_node_id: string;
}

async function load<T>(relative: string): Promise<T> {
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

/**
 * A control plane like `startControlPlane`'s, with the backoff option handed to
 * `createApp` — and `runner-a` already paired.
 *
 * @param t Test hook for the teardown.
 * @param retryBackoffSeconds Base of the backoff; omitted, the app's default.
 */
async function bench(t: TestHook, retryBackoffSeconds?: number): Promise<TestContext> {
  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');
  const { createApp } = await load<typeof ServerModule>('src/server.ts');
  const { issueCredential } = await load<typeof CredentialsModule>(
    'src/repositories/credentials.ts',
  );

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1312-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);
  const { token } = issueCredential(db, { type: 'user' });

  const app = createApp({
    db,
    ...(retryBackoffSeconds === undefined ? {} : { retryBackoffSeconds }),
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  const ctx: TestContext = { db, url, token };
  const paired = await request(ctx, 'POST', '/v1/runners', { id: 'runner-a' });
  assert.equal(paired.status, 201);
  return ctx;
}

/** Registers the minimal graph, optionally declaring a cap of its own. */
async function registerGraph(ctx: TestContext, cap?: number): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  if (cap !== undefined) {
    document.problem_class = `nota-curta-retry-cap-${String(cap)}`;
    document.max_consecutive_failures = cap;
  }
  await resolvePins(ctx, document);
  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  return response.body.graph_version.id;
}

/** Creates a job standing on `redigir` and returns its id. */
async function create(ctx: TestContext, body: Record<string, unknown> = {}): Promise<number> {
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/jobs', {
    title: 'the job whose runner keeps throwing after the session',
    entry_node_id: 'redigir',
    ...body,
  });
  assert.equal(response.status, 201, `POST /v1/jobs returned ${response.status}`);
  return response.body.id;
}

/** Asks for a lease over a job as `runner-a`. */
async function ask(ctx: TestContext, jobId: number): Promise<{ status: number; body: LeaseAnswer }> {
  return request<LeaseAnswer>(ctx, 'POST', '/v1/leases', {
    runner_id: 'runner-a',
    project_id: 1,
    job_id: jobId,
    runner_cap: 50,
    project_cap: 50,
    ttl_seconds: 60,
  });
}

/** Opens a session on a node and returns its id; the session is never finished here. */
async function openSession(ctx: TestContext, jobId: number, nodeId: string): Promise<number> {
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'Draft the note.',
  });
  assert.equal(opened.status, 201, `POST /v1/sessions returned ${opened.status}`);
  return opened.body.id;
}

/** Releases a lease through the real route. */
async function release(ctx: TestContext, leaseId: number): Promise<void> {
  const released = await request(ctx, 'POST', `/v1/leases/${leaseId}/releases`, {});
  assert.equal(released.status, 200, `the release returned ${released.status}`);
}

/**
 * One abandoned attempt, the way the incident made them: the lease is granted, a
 * session opens, and the lease goes back with the session never closed.
 *
 * @returns The lease and the session the attempt left behind.
 */
async function abandon(
  ctx: TestContext,
  jobId: number,
  nodeId = 'redigir',
): Promise<{ leaseId: number; sessionId: number }> {
  const granted = await ask(ctx, jobId);
  assert.equal(granted.status, 201, `the attempt's lease was refused: ${JSON.stringify(granted.body)}`);
  const leaseId = granted.body.lease?.id ?? -1;
  const sessionId = await openSession(ctx, jobId, nodeId);
  await release(ctx, leaseId);
  return { leaseId, sessionId };
}

/** Moves a lease's release instant into the past, and returns the instant written. */
function backdateRelease(ctx: TestContext, leaseId: number, secondsAgo: number): string {
  const instant = new Date(Date.now() - secondsAgo * 1000).toISOString();
  ctx.db.prepare('UPDATE lease SET released_at = ? WHERE id = ?').run(instant, leaseId);
  return instant;
}

function plusSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString();
}

async function readJob(ctx: TestContext, id: number): Promise<JobRead> {
  const response = await request<JobRead>(ctx, 'GET', `/v1/jobs/${id}`);
  assert.equal(response.status, 200);
  return response.body;
}

async function blockEvents(ctx: TestContext, jobId: number): Promise<Event[]> {
  const response = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);
  return response.body.events.filter((event) => event.type === 'job.blocked');
}

function leasesOf(ctx: TestContext, jobId: number): number {
  return (
    ctx.db.prepare('SELECT count(*) AS n FROM lease WHERE job_id = ?').get(jobId) as { n: number }
  ).n;
}

/** Asserts the cap answer, and that it granted nothing. */
async function assertCapped(ctx: TestContext, jobId: number): Promise<void> {
  const before = leasesOf(ctx, jobId);
  const answer = await ask(ctx, jobId);
  assert.equal(answer.status, 200, 'the cap is a refusal, not an error');
  assert.equal(answer.body.lease, null);
  assert.equal(answer.body.reason, 'retry_cap_reached');
  assert.equal(leasesOf(ctx, jobId), before, 'the cap grants nothing');
}

test('t1312 AT1 — a job with no sessions is leased as before', async (t) => {
  const ctx = await bench(t);
  const job = await create(ctx);
  const answer = await ask(ctx, job);
  assert.equal(answer.status, 201);
  assert.equal(answer.body.lease?.job_id, job);
});

test('t1312 AT2 — one abandoned attempt, backoff off: the next lease is granted', async (t) => {
  const ctx = await bench(t, 0);
  const job = await create(ctx);
  await abandon(ctx, job);

  const answer = await ask(ctx, job);
  assert.equal(answer.status, 201, `below the cap: ${JSON.stringify(answer.body)}`);
});

test('t1312 AT3 — N-1 abandoned attempts are granted; the N-th makes the next ask the cap', async (t) => {
  const ctx = await bench(t, 0);
  const job = await create(ctx);
  await abandon(ctx, job);
  await abandon(ctx, job);

  // The third attempt's own lease is still granted: two abandoned is below three.
  await abandon(ctx, job);

  await assertCapped(ctx, job);
});

test('t1312 AT4 — after the cap the job reads blocked, leaves the candidates and has one event', async (t) => {
  const ctx = await bench(t, 0);
  const job = await create(ctx);
  await abandon(ctx, job);
  await abandon(ctx, job);
  const last = await abandon(ctx, job);
  await assertCapped(ctx, job);

  const read = await readJob(ctx, job);
  assert.equal(read.blocked, true);
  const reason = read.block_reason ?? '';
  assert.ok(reason.includes('redigir'), `the reason names the node: ${reason}`);
  assert.ok(reason.includes(String(DEFAULT_CAP)), `the reason carries the count: ${reason}`);
  assert.ok(reason.includes(String(last.sessionId)), `the reason names the last session: ${reason}`);
  assert.ok(reason.includes('open'), `the reason names the last session's status: ${reason}`);

  const listed = await request<{ jobs: Array<{ id: number }> }>(ctx, 'GET', '/v1/jobs');
  assert.equal(listed.status, 200);
  assert.ok(
    !listed.body.jobs.some((candidate) => candidate.id === job),
    'a blocked job is no longer a candidate',
  );

  const events = await blockEvents(ctx, job);
  assert.equal(events.length, 1, 'one block, one event');
  assert.equal(events[0].data.consecutive_failures, DEFAULT_CAP);
  assert.equal(events[0].data.reason, read.block_reason);

  await assertCapped(ctx, job);
  assert.equal((await blockEvents(ctx, job)).length, 1, 'asking again writes no second event');
  assert.equal((await readJob(ctx, job)).block_reason, read.block_reason);
});

test('t1312 AT5 — the graph\'s max_consecutive_failures is the cap; none declared is 3', async (t) => {
  const ctx = await bench(t, 0);

  const capTwo = await create(ctx, { graph_version_id: await registerGraph(ctx, 2) });
  await abandon(ctx, capTwo);
  await abandon(ctx, capTwo);
  await assertCapped(ctx, capTwo);
  const events = await blockEvents(ctx, capTwo);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.consecutive_failures, 2);

  const capDefault = await create(ctx, { graph_version_id: await registerGraph(ctx) });
  await abandon(ctx, capDefault);
  await abandon(ctx, capDefault);
  assert.equal((await readJob(ctx, capDefault)).blocked, false, 'two is below the default');
  await abandon(ctx, capDefault);
  await assertCapped(ctx, capDefault);
});

test('t1312 AT6 — a live dispatch is not counted: active lease plus open sessions', async (t) => {
  const ctx = await bench(t, 0);
  const job = await create(ctx);

  const granted = await ask(ctx, job);
  assert.equal(granted.status, 201);
  for (let i = 0; i < DEFAULT_CAP + 1; i += 1) await openSession(ctx, job, 'redigir');

  const answer = await ask(ctx, job);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { lease: null, reason: 'job_already_leased' });
  assert.equal((await readJob(ctx, job)).blocked, false, 'a live dispatch blocks nothing');
  assert.equal((await blockEvents(ctx, job)).length, 0);
});

test('t1312 AT7 — the run stops at a completed session, and other nodes do not count', async (t) => {
  const ctx = await bench(t, 0);

  // open, open, completed, open: the trailing run is one.
  const job = await create(ctx);
  await abandon(ctx, job);
  await abandon(ctx, job);
  const worked = await openSession(ctx, job, 'redigir');
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${worked}/finish`, {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(finished.status, 200);
  await abandon(ctx, job);

  // One behind, so two more attempts are granted and the third trips it.
  await abandon(ctx, job);
  assert.equal((await readJob(ctx, job)).blocked, false, 'the completed session reset the run');
  await abandon(ctx, job);
  await assertCapped(ctx, job);

  // Open sessions of a previous node: three on `redigir`, then the job moves on.
  const version = await registerGraph(ctx);
  const moved = await create(ctx, { graph_version_id: version });
  for (let i = 0; i < DEFAULT_CAP; i += 1) await openSession(ctx, moved, 'redigir');
  const transition = await request(ctx, 'POST', `/v1/jobs/${moved}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(transition.status, 200);
  await abandon(ctx, moved, 'revisar');

  const answer = await ask(ctx, moved);
  assert.equal(answer.status, 201, `sessions of a previous node do not count: ${JSON.stringify(answer.body)}`);
});

test('t1312 AT8 — an unblock gives a fresh count', async (t) => {
  const ctx = await bench(t, 0);
  const job = await create(ctx);
  await abandon(ctx, job);
  await abandon(ctx, job);
  await abandon(ctx, job);
  await assertCapped(ctx, job);

  const unblocked = await request(ctx, 'POST', `/v1/jobs/${job}/unblocks`, {
    reason: 'fixed the runner',
  });
  assert.equal(unblocked.status, 200);

  // The three old sessions were opened before `job.unblocked`: not recounted.
  await abandon(ctx, job);
  await abandon(ctx, job);
  assert.equal((await readJob(ctx, job)).blocked, false, 'two after the unblock do not block');
  await abandon(ctx, job);
  await assertCapped(ctx, job);
  assert.equal((await blockEvents(ctx, job)).length, 2, 'one block before the unblock, one after');
});

test('t1312 AT9 — the backoff grows with the run and is capped at one hour', async (t) => {
  const ctx = await bench(t, 60);
  const job = await create(ctx);

  // A run of one, released ten seconds ago: wait until release + 60 s.
  const first = await abandon(ctx, job);
  let released = backdateRelease(ctx, first.leaseId, 10);
  let answer = await ask(ctx, job);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    lease: null,
    reason: 'retry_backoff',
    retry_after: plusSeconds(released, 60),
  });

  // Sixty-one seconds later the wait is over.
  backdateRelease(ctx, first.leaseId, 61);
  answer = await ask(ctx, job);
  assert.equal(answer.status, 201, `past the backoff: ${JSON.stringify(answer.body)}`);
  const secondLease = answer.body.lease?.id ?? -1;
  await openSession(ctx, job, 'redigir');
  await release(ctx, secondLease);

  // A run of two doubles it: 61 s is not enough any more.
  released = backdateRelease(ctx, secondLease, 61);
  answer = await ask(ctx, job);
  assert.deepEqual(answer.body, {
    lease: null,
    reason: 'retry_backoff',
    retry_after: plusSeconds(released, 120),
  });
  backdateRelease(ctx, secondLease, 121);
  assert.equal((await ask(ctx, job)).status, 201);

  // The cap: base 3000 with a run of two would be 6000 s; it is 3600 s.
  const capped = await bench(t, 3000);
  const slow = await create(capped);
  const a = await abandon(capped, slow);
  backdateRelease(capped, a.leaseId, 3001);
  const b = await abandon(capped, slow);
  released = backdateRelease(capped, b.leaseId, 10);
  answer = await ask(capped, slow);
  assert.deepEqual(answer.body, {
    lease: null,
    reason: 'retry_backoff',
    retry_after: plusSeconds(released, 3600),
  });
});

test('t1312 AT9 — an expired lease anchors the backoff at its deadline', async (t) => {
  const ctx = await bench(t, 60);
  const job = await create(ctx);
  const granted = await ask(ctx, job);
  assert.equal(granted.status, 201);
  const leaseId = granted.body.lease?.id ?? -1;
  await openSession(ctx, job, 'redigir');

  // The runner died: its deadline passed ten seconds ago.
  const deadline = new Date(Date.now() - 10_000).toISOString();
  ctx.db.prepare('UPDATE lease SET expires_at = ? WHERE id = ?').run(deadline, leaseId);

  const answer = await ask(ctx, job);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, {
    lease: null,
    reason: 'retry_backoff',
    retry_after: plusSeconds(deadline, 60),
  });
});

test('t1312 AT10 — 0 disables the backoff, the default is 60 s', async (t) => {
  const off = await bench(t, 0);
  const job = await create(off);
  await abandon(off, job);
  assert.equal((await ask(off, job)).status, 201, 'with 0 there is no wait');

  const byDefault = await bench(t);
  const other = await create(byDefault);
  const attempt = await abandon(byDefault, other);
  const released = backdateRelease(byDefault, attempt.leaseId, 1);
  const answer = await ask(byDefault, other);
  assert.deepEqual(answer.body, {
    lease: null,
    reason: 'retry_backoff',
    retry_after: plusSeconds(released, 60),
  });
});

test('t1312 AT10 — the env resolver: unset, valid, zero, and invalid values', async () => {
  const { ENV_RETRY_BACKOFF_SECONDS, retryBackoffSeconds } =
    await load<typeof IndexModule>('src/index.ts');
  assert.equal(ENV_RETRY_BACKOFF_SECONDS, 'CARTOGRAFO_RETRY_BACKOFF_SECONDS');

  const cases: Array<[string | undefined, number]> = [
    [undefined, 60],
    ['', 60],
    ['  ', 60],
    ['0', 0],
    ['30', 30],
    [' 90 ', 90],
    ['abc', 60],
    ['-5', 60],
    ['1.5', 60],
  ];
  for (const [value, expected] of cases) {
    const env: NodeJS.ProcessEnv =
      value === undefined ? {} : { [ENV_RETRY_BACKOFF_SECONDS]: value };
    assert.equal(retryBackoffSeconds(env), expected, `value ${JSON.stringify(value)}`);
  }
});

test('t1312 AT11 — the t265 path is unchanged, and a t265 block is not overwritten', async (t) => {
  const ctx = await bench(t, 0);
  const version = await registerGraph(ctx);
  const job = await create(ctx, { graph_version_id: version });

  for (let i = 0; i < DEFAULT_CAP; i += 1) {
    const sessionId = await openSession(ctx, job, 'redigir');
    const finished = await request(ctx, 'PATCH', `/v1/sessions/${sessionId}/finish`, {
      status: 'failed',
      exit_code: 1,
    });
    assert.equal(finished.status, 200);
  }

  const stopped = await readJob(ctx, job);
  assert.equal(stopped.blocked, true, 'the third failed close still blocks');
  const oldReason = stopped.block_reason ?? '';
  assert.ok(oldReason.includes('failed 3 sessions in a row'), `the old reason: ${oldReason}`);
  assert.equal((await blockEvents(ctx, job)).length, 1);

  // Failed sessions are not abandoned ones: the grant still leases (job-blind
  // as it always was), and adds no block of its own.
  const granted = await ask(ctx, job);
  assert.equal(granted.status, 201);
  await openSession(ctx, job, 'redigir');
  await release(ctx, granted.body.lease?.id ?? -1);
  await abandon(ctx, job);
  await abandon(ctx, job);

  await assertCapped(ctx, job);
  const after = await readJob(ctx, job);
  assert.equal(after.block_reason, oldReason, 'the reason that stopped it first stays');
  assert.equal((await blockEvents(ctx, job)).length, 1, 'and no second event is written');
});
