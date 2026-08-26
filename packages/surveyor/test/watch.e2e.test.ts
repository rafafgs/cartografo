/**
 * The watcher against the real thing, end to end (t247, AT7).
 *
 * This is the ticket's own criterion and the only test here that removes every
 * fake but one: a real control plane on a throwaway database, the minimal
 * example graph registered through `POST /v1/graphs`, two real jobs of one
 * `execution_id` driven to the graph's final node — which is what fires
 * `execution.finished` (t245) — and the real `cartografo-surveyor watch`
 * spawned as a child process that nothing in here can reach into.
 *
 * The one fake left is the engine, and it is swapped the way
 * `packages/runner/test/surveyor/proposal.e2e.test.ts` swaps it: a `claude` on
 * `PATH` that execs the fake engine. The watcher builds its own
 * `ClaudeCodeAdapter` with no injection point — needing a real process is the
 * whole reason the flow lens costs a session — so `PATH` is the seam, and the
 * environment is what tells the fake what to write.
 *
 * Two claims:
 *
 * 1. one finished execution produces AT MOST one flow proposal and one cost
 *    proposal — the watcher is not a proposal generator, it is a lens trigger;
 * 2. killing the process with `SIGTERM` and starting it again against the same
 *    control plane adds no duplicate. That is child 2's dedupe (t246) doing the
 *    work: this package persists no cursor and holds no state across a restart
 *    (declared Out of Scope), so safety here comes from the control plane's
 *    `(lens, target_version, operations)` key and from nothing this process
 *    remembers.
 *
 * The credential travels on the command line, because a child process cannot
 * inherit a patched global `fetch`: the only token that reaches the API is the
 * one the command presented itself.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { bootCore, resolvePins, type TestHook } from '@cartografo/test-support';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'surveyor.mjs');
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');
const FAKE_ENGINE = path.join(
  REPO_ROOT,
  'packages',
  'runner',
  'test',
  'fixtures',
  'fake-engine.mjs',
);

/** Where the flow lens's session writes its answer (`surveyor/proposal.ts`). */
const OUTPUT_FILE = 'proposta-topografo.json';

/** The round this test watches. */
const EXECUTION_ID = 2470;

/**
 * Slack between two timestamps of the seeded telemetry.
 *
 * `occurred_at` has millisecond resolution: two writes in the same tick would
 * produce a zero interval and a round with no bottleneck at all, which is the
 * case where the flow lens correctly proposes nothing.
 */
const GAP_MS = 25;

/** How long a poll is allowed to wait for the watcher to do its work. */
const WORK_DEADLINE_MS = 60_000;

/** A control plane of this test's own, and the credential it minted. */
interface ControlPlane {
  baseUrl: string;
  token: string;
}

interface GraphVersion {
  id: string;
  graph_id: string;
}

interface Job {
  id: number;
}

interface Session {
  id: number;
}

interface Question {
  id: number;
}

interface Proposal {
  id: number;
  status: string;
  target_version: string;
  evidence: Record<string, unknown>;
}

/** Talks JSON with the control plane, presenting the credential and asserting the status. */
async function api<T>(
  plane: ControlPlane,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${plane.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${plane.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** A scratch directory that cleans itself up. */
function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-t247-${label}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A directory holding a `claude` that is really the fake engine.
 *
 * @param base Directory to put the shim in.
 * @returns The directory to prepend to `PATH`.
 */
function fakeEngineOnPath(base: string): string {
  const shim = path.join(base, 'claude');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ENGINE)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return base;
}

/** A well-formed semantic diff over the minimal graph, in §3's vocabulary. */
const VALID_OPERATIONS = [
  {
    type: 'change_node_field',
    node_id: 'revisar',
    field: 'description',
    from: 'Checks the note against the declared theme and closes the crossing.',
    to: 'Checks the note against the declared theme, with a three-item checklist.',
    inverse: {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'description',
      from: 'Checks the note against the declared theme, with a three-item checklist.',
      to: 'Checks the note against the declared theme and closes the crossing.',
    },
  },
];

/** The watcher process, with both of its streams captured. */
interface Watcher {
  child: ChildProcessWithoutNullStreams;
  out: () => string;
  err: () => string;
  /** Every JSON line the watcher has written to stdout so far, decoded. */
  lines: () => Array<Record<string, unknown>>;
  stop: () => Promise<void>;
}

/**
 * Spawns the real command and captures both streams.
 *
 * The `PATH` is the seam: the flow lens builds its own adapter, so the only way
 * to hand it a deterministic engine is to be the `claude` it finds.
 */
function spawnWatcher(t: TestHook, plane: ControlPlane, binDir: string): Watcher {
  assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/surveyor/bin/surveyor.mjs');

  const child = spawn(
    process.execPath,
    [BIN_PATH, 'watch', '--url', plane.baseUrl, '--token', plane.token],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        // A credential exported by whoever runs the suite must not decide what
        // this command presents.
        CARTOGRAFO_TOKEN: '',
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        FAKE_ENGINE_WRITE_FILES: JSON.stringify({
          [OUTPUT_FILE]: JSON.stringify({ operations: VALID_OPERATIONS }, null, 2),
        }),
      },
    },
  );

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      delay(5_000).then(() => {
        child.kill('SIGKILL');
      }),
    ]);
  };

  t.after(stop);

  return {
    child,
    out: () => out,
    err: () => err,
    lines: () =>
      out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    stop,
  };
}

/**
 * Waits for a condition, polling, and fails with the streams rather than hanging.
 *
 * @param watcher The process whose output is the evidence when this gives up.
 * @param what What is being waited for, for the failure message.
 * @param ready The condition.
 */
async function waitFor(
  watcher: Watcher,
  what: string,
  ready: () => boolean | Promise<boolean>,
  deadlineMs = WORK_DEADLINE_MS,
): Promise<void> {
  const limit = Date.now() + deadlineMs;
  while (Date.now() < limit) {
    if (await ready()) return;
    await delay(50);
  }
  assert.fail(
    `${what} did not happen within ${deadlineMs}ms\nstdout:\n${watcher.out()}\nstderr:\n${watcher.err()}`,
  );
}

/** Waits until the watcher says its stream is open — it starts "from now" (§5). */
async function waitUntilWatching(watcher: Watcher): Promise<void> {
  await waitFor(watcher, 'the watcher connecting to the stream', () =>
    watcher.err().includes('connected to'),
  );
}

/**
 * Seeds one execution of two travellers, only one of which costs any time.
 *
 * Both jobs are created BEFORE either moves: `execution.finished` fires on the
 * transition that leaves every job of the round completed, so creating the
 * second one afterwards would make the first arrival the end of a one-job round
 * and fire the event before the watcher is even up.
 *
 * @returns The two jobs; the caller drives the second one to the final node.
 */
async function seedRound(plane: ControlPlane, versionId: string): Promise<Job[]> {
  const travellers: Job[] = [];
  for (const title of ['nota que custa caro', 'nota que atravessa depois']) {
    travellers.push(
      await api<Job>(
        plane,
        'POST',
        '/v1/jobs',
        {
          title,
          entry_node_id: 'redigir',
          execution_id: EXECUTION_ID,
          graph_version_id: versionId,
        },
        201,
      ),
    );
  }

  // The first traveller arrives and pays for it: queued, busy, then blocked on
  // a question. That is the time signal the flow lens finds a bottleneck in.
  await api(plane, 'POST', `/v1/jobs/${travellers[0].id}/transitions`, { to_node_id: 'revisar' });
  await delay(GAP_MS);

  const session = await api<Session>(
    plane,
    'POST',
    '/v1/sessions',
    {
      job_id: travellers[0].id,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revise a nota',
    },
    201,
  );

  const question = await api<Question>(
    plane,
    'POST',
    '/v1/input-requests',
    {
      job_id: travellers[0].id,
      session_id: session.id,
      kind: 'question',
      question: 'a nota responde ao tema?',
      auto_approvable: true,
    },
    201,
  );
  await delay(GAP_MS);

  await api(plane, 'PATCH', `/v1/input-requests/${question.id}/answer`, {
    answer: 'responde, siga',
    answered_by: 'rafael',
  });
  // The report is not decoration since t262: `revisar` pins a skill, so this
  // traveller is only done once the session on the node it is standing on
  // closed with an `output`. The fixture's pin names a skill the registry can
  // never carry (its id has a slash), so nothing holds this object against a
  // schema — which is t253's "there is nothing to check this against", and is
  // enough for the report to be STORED, which is what the arrival reads.
  await api(plane, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
    output: { outcome: 'passou', evidencia: 'a nota responde ao tema' },
  });

  return travellers;
}

/**
 * Closes the last traveller's own step on the final node.
 *
 * The transition puts it THERE; this is what finishes it — and therefore what
 * ends the round (t262).
 *
 * @param plane Control plane running.
 * @param jobId The traveller standing on `revisar`.
 */
async function runFinalNode(plane: ControlPlane, jobId: number): Promise<void> {
  const session = await api<Session>(
    plane,
    'POST',
    '/v1/sessions',
    {
      job_id: jobId,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revise a nota',
    },
    201,
  );
  await api(plane, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
    output: { outcome: 'passou', evidencia: 'a nota responde ao tema' },
  });
}

/** Every proposal in the book, whichever lens wrote it. */
async function proposalsOf(plane: ControlPlane): Promise<Proposal[]> {
  const { proposals } = await api<{ proposals: Proposal[] }>(plane, 'GET', '/v1/proposals');
  return proposals;
}

const byLens = (proposals: Proposal[], lens: string): Proposal[] =>
  proposals.filter((proposal) => proposal.evidence.lens === lens);

test('t247 AT7 — a finished round makes at most one proposal per lens, and a restart makes none', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);
  const plane: ControlPlane = { baseUrl, token };

  // A resolvable capability per node, or the version is stored `unchecked` and
  // the round below could not be seeded at all (t283).
  const document = await resolvePins(
    plane.baseUrl,
    plane.token,
    JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>,
  );
  const { graph_version: version } = await api<{ graph_version: GraphVersion }>(
    plane,
    'POST',
    '/v1/graphs',
    document,
    201,
  );

  const travellers = await seedRound(plane, version.id);

  const binDir = fakeEngineOnPath(scratch(t, 'engine'));
  const first = spawnWatcher(t, plane, binDir);
  await waitUntilWatching(first);

  // The last traveller arrives AND runs the node it arrived on (t262): every
  // job of the round is completed, and the control plane says so — once (t245).
  await api(plane, 'POST', `/v1/jobs/${travellers[1].id}/transitions`, { to_node_id: 'revisar' });
  await runFinalNode(plane, travellers[1].id);

  await waitFor(
    first,
    'the watcher reporting both lenses',
    () => first.lines().filter((line) => line.execution_id === EXECUTION_ID).length >= 2,
  );

  const reported = first.lines().filter((line) => line.execution_id === EXECUTION_ID);
  const flowLine = reported.find((line) => line.lens === 'flow');
  const costLine = reported.find((line) => line.lens === 'cost');

  assert.ok(flowLine !== undefined, `no flow line was written:\n${first.out()}`);
  assert.equal(
    flowLine.outcome,
    'posted',
    `the seeded bottleneck is a proposal, posted for the first time:\n${first.out()}`,
  );
  assert.ok(costLine !== undefined, `no cost line was written:\n${first.out()}`);
  assert.equal(
    costLine.outcome,
    'nothing',
    // `watch` declares no ceiling, so only the tier policy can fire, and it
    // wants at least three measured nodes: the minimal graph has two.
    `the cost lens has no policy to break in this round:\n${first.out()}`,
  );

  const afterFirst = await proposalsOf(plane);
  assert.equal(
    byLens(afterFirst, 'flow').length,
    1,
    `exactly one flow proposal: ${JSON.stringify(afterFirst)}`,
  );
  assert.ok(
    byLens(afterFirst, 'cost').length <= 1,
    `at most one cost proposal: ${JSON.stringify(afterFirst)}`,
  );
  for (const proposal of afterFirst) {
    assert.equal(proposal.status, 'pending', 'a watcher proposes; applying is the human gate (D21)');
  }

  // --- the restart. Nothing is remembered, and nothing is duplicated.
  await first.stop();
  assert.notEqual(first.child.exitCode ?? first.child.signalCode, null, 'SIGTERM ended the process');

  const second = spawnWatcher(t, plane, binDir);
  await waitUntilWatching(second);

  // A settle window, so "no duplicate" is a fact about a running process and
  // not about one that had no time to do anything.
  await delay(1_000);

  const afterRestart = await proposalsOf(plane);
  assert.deepEqual(
    afterRestart.map((proposal) => proposal.id).sort((a, b) => a - b),
    afterFirst.map((proposal) => proposal.id).sort((a, b) => a - b),
    `the respawned watcher added a proposal:\nstdout:\n${second.out()}\nstderr:\n${second.err()}`,
  );

  await second.stop();
});
