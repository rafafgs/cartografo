/**
 * Acceptance tests of `cartografo watch` (t543, D26).
 *
 * Every case drives a real control plane over its public API — no mock, no
 * in-process shortcut — the same posture as every other `cli-*.test.ts`. Two
 * things these tests need that `cli-support.ts`'s `runCli` does not give:
 *
 * - a way to run the command in the BACKGROUND, reading its live stdout while
 *   it is still open, and to signal it — `spawnCliBackground` below, since
 *   `runCli` only resolves once the child has already closed;
 * - for AT2 alone, a control plane pinned to a FIXED port and database path
 *   across two separate process starts — `spawnControlPlaneOnFixedPort`,
 *   since `cli-support.ts`'s own `startControlPlane` always picks its own free
 *   port.
 *
 * Neither is exported from `cli-support.ts`: it is not in this ticket's
 * declared shared-file surface, and both needs are specific to this one file.
 *
 * The graph every test transitions a job across is
 * `schema/examples/graph-valid-minimal.json` (`redigir` → `revisar`), the same
 * fixture `executions.test.ts`'s t245 cases register, with its skill pins
 * resolved by `resolvePinsOver` — a job needs no graph at all to fire
 * `job.created` (AT2, AT5 use nothing but that), but `job.transitioned` and
 * `execution.finished` need a real edge to walk.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { serverDownMessage } from '../src/cli/url.ts';
import type { EventEnvelope } from '../src/cli/watch.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';
import {
  BIN_PATH,
  CONTROL_PLANE_ONLY,
  REPO_ROOT,
  freePort,
  runCli,
  startControlPlane,
  temporaryArea,
  type TestHook,
} from './cli-support.ts';
import { resolvePinsOver } from './support.ts';

/* -------------------------------------------------------------- fixtures */

const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

/** Registers `graph-valid-minimal.json` (`redigir` → `revisar`) and returns its version id. */
async function registerMinimalGraph(url: string): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  await resolvePinsOver(document, {
    get: async (routePath) => ({ status: (await fetch(`${url}${routePath}`)).status }),
    post: async (routePath, body) => ({
      status: (
        await fetch(`${url}${routePath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    }),
  });

  const response = await fetch(`${url}/v1/graphs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(document),
  });
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  const body = (await response.json()) as { graph_version: { id: string } };
  return body.graph_version.id;
}

/** A job, in the fields these tests read off `POST /v1/jobs`. */
interface CreatedJob {
  id: number;
  execution_id: number | null;
}

/** Creates a job standing on `redigir`, optionally of one round. */
async function createTraveller(
  url: string,
  version: string,
  title: string,
  executionId?: number,
): Promise<CreatedJob> {
  const response = await fetch(`${url}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title,
      entry_node_id: 'redigir',
      graph_version_id: version,
      ...(executionId === undefined ? {} : { execution_id: executionId }),
    }),
  });
  assert.equal(response.status, 201, `POST /v1/jobs returned ${response.status}`);
  return (await response.json()) as CreatedJob;
}

/** Moves a job to a node, failing loudly instead of leaving a silent 4xx behind. */
async function moveTo(url: string, jobId: number, node: string): Promise<void> {
  const response = await fetch(`${url}/v1/jobs/${jobId}/transitions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to_node_id: node }),
  });
  assert.equal(response.status, 200, `transition to ${node} returned ${response.status}`);
}

/** Opens and finishes the session that closes `revisar`, the graph's one final node. */
async function runFinalNode(url: string, jobId: number): Promise<void> {
  const opened = await fetch(`${url}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'review and close',
    }),
  });
  assert.equal(opened.status, 201, `POST /v1/sessions returned ${opened.status}`);
  const session = (await opened.json()) as { id: number };

  const finished = await fetch(`${url}/v1/sessions/${session.id}/finish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      exit_code: 0,
      output: { outcome: 'passou', evidencia: 'the note answers the stated theme' },
    }),
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);
}

/** Walks a job to `revisar` and runs it — the whole of one traveller's arrival. */
async function arrive(url: string, jobId: number): Promise<void> {
  await moveTo(url, jobId, 'revisar');
  await runFinalNode(url, jobId);
}

/* ------------------------------------------------------ background runs */

/** One run of `watch`, still open, with its live output readable. */
interface BackgroundCli {
  stdout: () => string;
  stderr: () => string;
  /** Waits for a stdout line that, parsed as JSON, satisfies `predicate`. */
  waitForJsonLine: <T>(predicate: (parsed: T) => boolean, timeoutMs?: number) => Promise<T>;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal: (value: NodeJS.Signals) => void;
}

/**
 * Spawns the real binary and keeps it running, unlike `cli-support.ts`'s
 * `runCli`, which only resolves once the child has closed.
 */
function spawnCliBackground(
  t: TestHook,
  args: string[],
  options: { token?: string } = {},
): BackgroundCli {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARTOGRAFO_DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-t543-cli-')), 'cartografo.db'),
  };
  delete env.CARTOGRAFO_TOKEN;
  if (options.token !== undefined) env.CARTOGRAFO_TOKEN = options.token;

  const child = spawn(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    waitForJsonLine: async <T>(predicate: (parsed: T) => boolean, timeoutMs = 30_000): Promise<T> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        for (const line of stdout.split('\n')) {
          if (line === '') continue;
          try {
            const parsed = JSON.parse(line) as T;
            if (predicate(parsed)) return parsed;
          } catch {
            continue;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for a matching JSON line\nstdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
          );
        }
        await sleep(50);
      }
    },
    waitForExit: () => exit,
    signal: (value) => child.kill(value),
  };
}

/** Readiness line `up` prints on stdout, in the fields this file reads. */
interface FixedControlPlane {
  url: string;
  token: string;
  kill: () => void;
  exited: Promise<void>;
}

/**
 * A control plane on a PORT AND DATABASE PATH chosen by the caller — AT2's own
 * need, which `cli-support.ts`'s `startControlPlane` cannot serve since it
 * always reserves its own free port.
 */
async function spawnControlPlaneOnFixedPort(port: number, databasePath: string): Promise<FixedControlPlane> {
  const child = spawn(process.execPath, [BIN_PATH, ...CONTROL_PLANE_ONLY], {
    cwd: REPO_ROOT,
    env: { ...process.env, CARTOGRAFO_DB_PATH: databasePath, CARTOGRAFO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<null, Readable, Readable>;

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<void>((resolve) => {
    child.on('close', () => resolve());
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before becoming ready (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const line = stdout
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      const readiness = JSON.parse(line) as { url: string; bootstrapToken: string | null };
      return {
        url: readiness.url,
        // `null` on the SECOND start of the same database — the credential
        // was already minted (`cli-support.ts`'s own comment on the field);
        // callers of this helper keep using the token the FIRST start gave.
        token: readiness.bootstrapToken ?? '',
        kill: () => child.kill('SIGKILL'),
        exited,
      };
    }
    await sleep(50);
  }
  throw new Error(`the control plane did not become ready in 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

/** Waits until a port that was just released can be bound again. */
async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return;
    await sleep(50);
  }
  throw new Error(`port ${port} did not free within ${timeoutMs}ms`);
}

/* ------------------------------------------------------------------- AT1 */

test('AT1 — arrival, ordering and the --job filter', { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t, { databasePath: path.join(temporaryArea(t), 'cartografo.db') });
  const version = await registerMinimalGraph(cp.url);
  const jobA = await createTraveller(cp.url, version, 'traveller A');
  const jobB = await createTraveller(cp.url, version, 'traveller B');

  const watch = spawnCliBackground(t, ['watch', '--job', String(jobA.id), '--json', '--url', cp.url], {
    token: cp.token,
  });
  // No readiness signal of its own: give the SSE connection time to open
  // before the events it needs to see are written. Generous on purpose — this
  // machine sometimes runs several worktrees' suites at once (t491's own
  // learning), and a spawned process can sit unscheduled for a while under
  // that load.
  await sleep(2_000);

  await moveTo(cp.url, jobA.id, 'revisar');
  await moveTo(cp.url, jobB.id, 'revisar');

  await watch.waitForJsonLine<EventEnvelope>(
    (event) => event.type === 'job.transitioned' && event.entity.id === jobA.id,
  );
  // A grace window for a B line that should never arrive, before judging the
  // whole capture below.
  await sleep(1_000);

  watch.signal('SIGINT');
  await watch.waitForExit();

  const lines = watch
    .stdout()
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as EventEnvelope);

  assert.ok(lines.length > 0, 'at least one line printed');
  for (const line of lines) {
    assert.equal(line.entity.type, 'job');
    assert.equal(line.entity.id, jobA.id, `a line for a job other than A leaked through: ${JSON.stringify(line)}`);
  }
  const ids = lines.map((line) => line.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ascending id order');
});

/* ------------------------------------------------------------------- AT2 */

test('AT2 — reconnect after the control plane restarts, no duplicate lines', { timeout: 150_000 }, async (t) => {
  const dbPath = path.join(temporaryArea(t), 'cartografo.db');
  const port = await freePort();

  const first = await spawnControlPlaneOnFixedPort(port, dbPath);
  // Registered immediately, not after the exchange below: a failed assertion
  // or a timed-out wait must not leak this process past the test (it would
  // keep the whole suite's process alive on its still-open stdio pipes).
  t.after(() => first.kill());
  authorizeGlobalFetch(t, { baseUrl: first.url, token: first.token });

  const watch = spawnCliBackground(t, ['watch', '--json', '--url', first.url], { token: first.token });
  await sleep(2_000);

  const jobOne = (await (
    await fetch(`${first.url}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'before the restart', entry_node_id: 'redigir' }),
    })
  ).json()) as CreatedJob;

  await watch.waitForJsonLine<EventEnvelope>(
    (event) => event.type === 'job.created' && event.entity.id === jobOne.id,
  );

  first.kill();
  await first.exited;
  await waitForPortFree(port);

  const second = await spawnControlPlaneOnFixedPort(port, dbPath);
  t.after(() => second.kill());

  const jobTwo = (await (
    await fetch(`${second.url}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'after the restart', entry_node_id: 'redigir' }),
    })
  ).json()) as CreatedJob;

  // Tolerates the fixed 1s backoff: the reconnect is not instantaneous.
  await watch.waitForJsonLine<EventEnvelope>(
    (event) => event.type === 'job.created' && event.entity.id === jobTwo.id,
  );

  watch.signal('SIGINT');
  await watch.waitForExit();

  const printedIds = watch
    .stdout()
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as EventEnvelope).id);

  assert.deepEqual(printedIds, [...new Set(printedIds)], 'no event id repeats across the reconnect');
  assert.equal(
    watch
      .stdout()
      .trim()
      .split('\n')
      .filter((line) => line !== '')
      .filter((line) => {
        const event = JSON.parse(line) as EventEnvelope;
        return event.type === 'job.created' && (event.entity.id === jobOne.id || event.entity.id === jobTwo.id);
      }).length,
    2,
    'both the pre- and post-restart job.created events arrived, exactly once each',
  );
});

/* ------------------------------------------------------------------ AT3a */

test('AT3a — --until-done, execution-scoped, exits 0 once the round finishes', { timeout: 90_000 }, async (t) => {
  const cp = await startControlPlane(t, { databasePath: path.join(temporaryArea(t), 'cartografo.db') });
  const version = await registerMinimalGraph(cp.url);
  const execution = 543001;
  const job = await createTraveller(cp.url, version, 'traveller', execution);

  const watchPromise = runCli(
    ['watch', '--execution', String(execution), '--until-done', '--url', cp.url],
    { token: cp.token, timeoutMs: 60_000 },
  );

  await sleep(2_000);
  await arrive(cp.url, job.id);

  const result = await watchPromise;
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.equal(result.signal, null);
});

/* ------------------------------------------------------------------ AT3b */

test('AT3b — --until-done against an unreachable control plane exits 1, no hang', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const result = await runCli(['watch', '--execution', '1', '--until-done', '--url', url], {
    timeoutMs: 20_000,
  });

  assert.equal(result.code, 1, `stderr:\n${result.stderr}`);
  assert.equal(result.stderr.trim(), serverDownMessage(url));
});

/* -------------------------------------------------------- AT4/AT7 shared */

/**
 * Drives one round to completion, then reads it back both ways: the REST
 * route this ficha's own contract points at, and `watch --from-start --json
 * --until-done` over the live stream.
 */
async function collectExecutionParity(
  t: TestHook,
  executionId: number,
): Promise<{ events: EventEnvelope[]; printed: EventEnvelope[] }> {
  const cp = await startControlPlane(t, { databasePath: path.join(temporaryArea(t), 'cartografo.db') });
  const version = await registerMinimalGraph(cp.url);
  const job = await createTraveller(cp.url, version, 'traveller', executionId);
  await arrive(cp.url, job.id);

  const eventsResponse = await fetch(`${cp.url}/v1/executions/${executionId}/events`);
  assert.equal(eventsResponse.status, 200);
  const { events } = (await eventsResponse.json()) as { events: EventEnvelope[] };
  assert.ok(events.length > 0, 'the round produced no events to compare against');

  const result = await runCli(
    ['watch', '--execution', String(executionId), '--from-start', '--json', '--until-done', '--url', cp.url],
    { token: cp.token, timeoutMs: 45_000 },
  );
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

  const printed = result.stdout
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as EventEnvelope);

  return { events, printed };
}

/* -------------------------------------------------------------------- AT4 */

test('AT4 — --json set parity with GET /v1/executions/:id/events', { timeout: 75_000 }, async (t) => {
  const { events, printed } = await collectExecutionParity(t, 543002);

  assert.deepEqual(
    printed.map((event) => event.id).sort((a, b) => a - b),
    events.map((event) => event.id).sort((a, b) => a - b),
  );
});

/* -------------------------------------------------------------------- AT7 */

test('AT7 — --json envelope shape matches the REST read field for field', { timeout: 75_000 }, async (t) => {
  const { events, printed } = await collectExecutionParity(t, 543003);

  for (const event of events) {
    const match = printed.find((candidate) => candidate.id === event.id);
    assert.ok(match !== undefined, `no printed line for event #${event.id}`);
    assert.deepEqual(match, event);
  }
});

/* -------------------------------------------------------------------- AT5 */

test('AT5 — SIGINT exits 0 once the connection has closed', { timeout: 60_000 }, async (t) => {
  const cp = await startControlPlane(t, { databasePath: path.join(temporaryArea(t), 'cartografo.db') });

  const watch = spawnCliBackground(t, ['watch', '--json', '--url', cp.url], { token: cp.token });
  await sleep(2_000);

  await fetch(`${cp.url}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'sigint probe', entry_node_id: 'redigir' }),
  });

  await watch.waitForJsonLine<EventEnvelope>((event) => event.type === 'job.created');

  watch.signal('SIGINT');
  const exit = await Promise.race([
    watch.waitForExit(),
    sleep(20_000).then(() => {
      throw new Error('watch did not exit within 20s of SIGINT');
    }),
  ]);
  assert.equal(exit.code, 0);
});

/* -------------------------------------------------------------------- AT6 */

test('AT6 — usage errors exit 2, none needing a running server', { timeout: 30_000 }, async () => {
  const url = `http://127.0.0.1:${await freePort()}`;

  const sinceAndFromStart = await runCli(['watch', '--since', '1', '--from-start', '--url', url]);
  assert.equal(sinceAndFromStart.code, 2, `stderr:\n${sinceAndFromStart.stderr}`);

  const untilDoneWithNeither = await runCli(['watch', '--until-done', '--url', url]);
  assert.equal(untilDoneWithNeither.code, 2, `stderr:\n${untilDoneWithNeither.stderr}`);

  const untilDoneWithBoth = await runCli(['watch', '--job', '1', '--execution', '2', '--until-done', '--url', url]);
  assert.equal(untilDoneWithBoth.code, 2, `stderr:\n${untilDoneWithBoth.stderr}`);
});
