/**
 * Acceptance tests of the dispatch hold at the lease grant (t636, AT19–AT21).
 *
 * The runner is out of this ticket's scope, so the one place the core can keep
 * a held job from being dispatched is `POST /v1/leases`: a job with a non-null
 * `dispatch_hold` is answered `200 {lease: null, reason: 'job_held',
 * dispatch_hold}` — the "not now, try the next one" shape a full cap already
 * uses — and nothing is granted.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  request,
  resolvePins,
  startControlPlane,
  type TestContext,
} from './support.ts';

const MINIMAL_GRAPH = path.resolve(PACKAGE_ROOT, '../../schema/examples/graph-valid-minimal.json');

interface LeaseAnswer {
  lease: { id: number; job_id: number } | null;
  reason?: string;
  dispatch_hold?: string;
}

/** Registers the minimal graph, pins resolvable, and returns its version. */
async function registerMinimalGraph(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  await resolvePins(ctx, document);
  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201);
  return response.body.graph_version.id;
}

/** Creates a job and returns its id. */
async function create(ctx: TestContext, body: Record<string, unknown>): Promise<number> {
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/jobs', {
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

/** How many lease rows name a job. */
function leasesOf(ctx: TestContext, jobId: number): number {
  return (
    ctx.db.prepare('SELECT count(*) AS n FROM lease WHERE job_id = ?').get(jobId) as { n: number }
  ).n;
}

/** Asserts the held answer and that nothing was granted. */
async function assertHeld(ctx: TestContext, jobId: number, hold: string): Promise<void> {
  const answer = await ask(ctx, jobId);
  assert.equal(answer.status, 200, `job ${jobId}: a hold is a refusal, not an error`);
  assert.deepEqual(answer.body, { lease: null, reason: 'job_held', dispatch_hold: hold });
  assert.equal(leasesOf(ctx, jobId), 0, `job ${jobId} got no lease row`);
}

/** Walks a minimal-graph job to `revisar` and runs that pinned final step. */
async function arrive(ctx: TestContext, id: number): Promise<void> {
  const moved = await request(ctx, 'POST', `/v1/jobs/${id}/transitions`, { to_node_id: 'revisar' });
  assert.equal(moved.status, 200);
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'review and close',
  });
  assert.equal(opened.status, 201);
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    output: { outcome: 'pass', evidence: 'the note answers the stated theme' },
  });
  assert.equal(finished.status, 200);
}

/** A control plane with `runner-a` paired and the minimal graph registered. */
async function bench(t: Parameters<typeof startControlPlane>[0]): Promise<{
  ctx: TestContext;
  version: string;
}> {
  const ctx = await startControlPlane(t);
  const paired = await request(ctx, 'POST', '/v1/runners', { id: 'runner-a' });
  assert.equal(paired.status, 201);
  return { ctx, version: await registerMinimalGraph(ctx) };
}

test('t636 AT19 — a held or cancelled job is refused a lease with job_held', async (t) => {
  const { ctx, version } = await bench(t);

  const parent = await create(ctx, { title: 'parent' });
  await create(ctx, {
    title: 'child',
    parent_job_id: parent,
    parent_node_id: 'fan-out',
    graph_version_id: version,
  });
  await assertHeld(ctx, parent, 'children');

  const draft = await request<{ draft: { id: number } }>(ctx, 'POST', '/v1/intake', {
    class: 'nota-curta',
    request: 'two notes in order',
    items: [
      { ref: 'first', title: 'first' },
      { ref: 'second', title: 'second', depends_on: ['first'] },
    ],
  });
  assert.equal(draft.status, 201);
  const confirmed = await request<{ draft: { created_jobs: Record<string, number> } }>(
    ctx,
    'POST',
    `/v1/intake/${draft.body.draft.id}/confirmations`,
    {},
  );
  assert.equal(confirmed.status, 201);
  await assertHeld(ctx, confirmed.body.draft.created_jobs.second, 'dependencies');

  const cancelled = await create(ctx, { title: 'cancelled' });
  assert.equal((await request(ctx, 'POST', `/v1/jobs/${cancelled}/cancellations`, {})).status, 200);
  await assertHeld(ctx, cancelled, 'cancelled');

  const top = await create(ctx, { title: 'top' });
  const below = await create(ctx, { title: 'below', parent_job_id: top, parent_node_id: 'fan-out' });
  assert.equal((await request(ctx, 'POST', `/v1/jobs/${top}/cancellations`, {})).status, 200);
  await assertHeld(ctx, below, 'cancelled');
});

test('t636 AT20 — once the child arrives, the same request grants a lease', async (t) => {
  const { ctx, version } = await bench(t);
  const parent = await create(ctx, { title: 'parent' });
  const child = await create(ctx, {
    title: 'child',
    parent_job_id: parent,
    parent_node_id: 'fan-out',
    graph_version_id: version,
  });
  await assertHeld(ctx, parent, 'children');

  await arrive(ctx, child);
  const answer = await ask(ctx, parent);
  assert.equal(answer.status, 201);
  assert.equal(answer.body.lease?.job_id, parent);
  assert.equal(answer.body.reason, undefined);
});

test('t636 AT21 — a job with no relations, and an id naming no row, lease as before', async (t) => {
  const { ctx } = await bench(t);
  const plain = await create(ctx, { title: 'plain' });

  const granted = await ask(ctx, plain);
  assert.equal(granted.status, 201);
  assert.equal(granted.body.lease?.job_id, plain);

  const ghost = await ask(ctx, 9999);
  assert.equal(ghost.status, 201, 'an id naming no row is still leased over without comment');
  assert.equal(ghost.body.lease?.job_id, 9999);
});
