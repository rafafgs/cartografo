/**
 * Acceptance tests of the packaged composition (t162, AT8–AT13).
 *
 * `runRunner` is the spike written down: `ClienteControle` + `Controller` +
 * `createClaudeCodeDispatch` + one `EngineAdapter`, plus the loop and the clean
 * shutdown that turn those four objects into a process. Every piece is already
 * tested on its own; what is under test here is the WIRING — that the runner
 * pairs before it asks for work, that the engine it was told to use is the one
 * that runs, that a tick which blows up does not take the loop with it, and
 * that a stop never returns holding a live lease.
 *
 * The control plane is the real binary as a child process, same harness shape
 * as `test/controller/dispatch-and-lease.e2e.test.ts`. The engine is the fake
 * one, reached through the `engineFactory` seam — the same division
 * `docs/formatos/engine-adapter.md:363-366` records and that
 * `scripts/spike-two-engine-traversal.mjs` draws for the real CLIs: the suite
 * must not depend on an installed, authenticated binary.
 *
 * **One control plane for the whole file, and every subtest cleans up after
 * itself.** `GET /v1/jobs` is not scoped by project, so a job left released by
 * one subtest is a candidate for the next subtest's runner — which is how a
 * dispatch nobody asked for shows up in the middle of a shutdown measurement.
 * The cleanup is `blockEveryJob`, in each subtest's `after`: blocked work is
 * nobody's candidate, and blocking is the only API verb that takes a job out of
 * the queue without pretending it was finished.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type * as RunModule from '../../src/cli/run.ts';
import type { EngineRoute } from '../../src/dispatch/dispatch-claude-code.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
} from '../../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import {
  buildCommand as buildCodexCommand,
  buildEnvironment as buildCodexEnvironment,
} from '../../src/engine/codex-command.ts';
import { buildCommand, buildEnvironment } from '../../src/engine/command.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');
const GRAPH_FIXTURE = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-dois-engines.json');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const RUN_MODULE = 'src/cli/run.ts';

/** Deadline of every wait in this file. Wide slack, on purpose. */
const DEADLINE_MS = 30_000;

/** The node of the fixture graph that declares no engine. */
const DEFAULT_NODE = 'redigir';

/** ...and the one that declares `codex`. */
const CODEX_NODE = 'conferir';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Job {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
}

interface Lease {
  id: number;
  runner_id: string;
  trabalho_id: number;
  status: string;
}

interface Session {
  id: number;
  trabalho_id: number | null;
  no_id: string | null;
  engine: string;
  status: string;
}

interface Event {
  id: number;
  tipo: string;
  dados: Record<string, unknown>;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** The real control plane, as this file reaches it. */
interface RunningControlPlane {
  baseUrl: string;
  token: string;
}

/** Boots the real binary and returns the address and credential it announced. */
async function bootControlPlane(t: TestHook): Promise<RunningControlPlane> {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-e2e-'));
  const child: CommandChild = spawn(process.execPath, [BIN_PATH], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(100);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before it was ready (code ${child.exitCode})\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    const line = out
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      const readiness = JSON.parse(line) as { url: string; bootstrapToken: string | null };
      assert.equal(
        typeof readiness.bootstrapToken,
        'string',
        'a brand-new database announces the operator credential this file uses',
      );
      return { baseUrl: readiness.url, token: readiness.bootstrapToken ?? '' };
    }
    await delay(50);
  }

  throw new Error(`the control plane was not ready within ${DEADLINE_MS}ms\nstdout:\n${out}`);
}

/** One JSON call with the credential handed in explicitly, asserting the status. */
async function api<T>(
  plane: RunningControlPlane,
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

/** Waits for something to become true, with a deadline and a message of its own. */
async function waitFor(label: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${label} did not happen within ${DEADLINE_MS}ms`);
}

/** Every lease of one job — the route ignores filters it does not know. */
async function leasesOfJob(plane: RunningControlPlane, jobId: number): Promise<Lease[]> {
  const { leases } = await api<{ leases: Lease[] }>(
    plane,
    'GET',
    `/v1/leases?trabalho_id=${jobId}`,
  );
  return leases.filter((lease) => lease.trabalho_id === jobId);
}

/**
 * Takes every released job out of the queue.
 *
 * The cleanup this file's header explains: a job that finished a dispatch is
 * still released (advancing a node is t109's, not this ticket's), so without
 * this the next subtest's runner would find it and dispatch it again.
 */
async function blockEveryJob(plane: RunningControlPlane): Promise<void> {
  const { trabalhos: jobs } = await api<{ trabalhos: Job[] }>(plane, 'GET', '/v1/jobs');
  for (const job of jobs) {
    if (job.bloqueado) continue;
    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { motivo: 'fim do caso de teste' });
  }
}

/**
 * The `engineFactory` seam, pointed at the fake engine.
 *
 * Only the BINARY changes: the argv each adapter's own command builder produces
 * goes through whole, which is what keeps this a test of the wiring instead of
 * a test of a command nobody issues. The fake engine is configured through the
 * environment — its only channel — so the overrides ride the adapter's
 * `environmentBuilder`, the seam that exists for exactly this.
 */
function fakeEngineFactory(
  overrides: Record<string, string>,
): (engine: RunModule.EngineName) => EngineRoute {
  return (engine) =>
    engine === 'codex'
      ? {
          adapter: new CodexAdapter({
            commandBuilder: (spec) => ({
              command: process.execPath,
              args: [FAKE_ENGINE, ...buildCodexCommand(spec).args],
            }),
            environmentBuilder: (spec) => ({ ...buildCodexEnvironment(spec), ...overrides }),
            graceMs: 300,
          }),
          decodeSessionText: decodeCodexSessionText,
        }
      : {
          adapter: new ClaudeCodeAdapter({
            commandBuilder: (spec) => ({
              command: process.execPath,
              args: [FAKE_ENGINE, ...buildCommand(spec).args],
            }),
            environmentBuilder: (spec) => ({ ...buildEnvironment(spec), ...overrides }),
            graceMs: 300,
          }),
          decodeSessionText: decodeClaudeCodeSessionText,
        };
}

/** What the fake session prints: a quiet run, with nothing to ask. */
const QUIET_LINES = JSON.stringify([
  { stream: 'stdout', text: 'Fiz o que o nó pedia; nada a perguntar.' },
]);

/** A runner running in this process, and the handle that stops it. */
interface RunningRunner {
  stop: () => Promise<void>;
}

/**
 * Starts `runRunner` and hands back the only two things a test does with it:
 * a stop, and — through the caller's own assertions — the state it left behind.
 *
 * The stop is idempotent and also registered as an `after` hook: a subtest that
 * fails halfway through must not leave a tick loop dispatching sessions into
 * the next one.
 */
async function startRunner(
  t: TestHook,
  runRunner: typeof RunModule.runRunner,
  options: Omit<RunModule.RunnerOptions, 'signal'>,
): Promise<RunningRunner> {
  const aborter = new AbortController();
  const finished = runRunner({ ...options, signal: aborter.signal });

  let settled: Promise<void> | null = null;
  const stop = async (): Promise<void> => {
    aborter.abort();
    settled ??= finished;
    await settled;
  };

  t.after(stop);
  return { stop };
}

test('t162 — the packaged runner, against a real control plane', async (parent) => {
  const plane = await bootControlPlane(parent);

  // Registered once and shared: the two subtests that need a node declaring an
  // engine need the SAME class, and a class only has one base lineage.
  const document = JSON.parse(readFileSync(GRAPH_FIXTURE, 'utf8')) as Record<string, unknown>;
  const { grafo_versao: version } = await api<{ grafo_versao: { id: string } }>(
    plane,
    'POST',
    '/v1/graphs',
    document,
    201,
  );

  await parent.test('AT8 — the runner pairs before it asks for anything', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const runnerId = 'runner-t162-at8';
    const projectId = 8162;

    /** Asks for a lease as this runner; the status is the whole answer. */
    const probe = async (): Promise<{ status: number; body: string }> => {
      const response = await fetch(`${plane.baseUrl}/v1/leases`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${plane.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          runner_id: runnerId,
          projeto_id: projectId,
          trabalho_id: 999_162,
          teto_runner: 1,
          teto_projeto: 1,
          ttl_segundos: 1,
        }),
      });
      return { status: response.status, body: await response.text() };
    };

    // Without the pairing this probe is a 404, and that is what makes the
    // assertion after the start mean something.
    const before = await probe();
    assert.equal(before.status, 404, `an unpaired runner gets a 404: ${before.body}`);
    assert.match(before.body, /runner_desconhecido/);

    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-at8-'));
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId,
      runnerId,
      engine: 'claude-code',
      workingDir: workDir,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }),
    });

    let after = before;
    await waitFor('the runner pairing with the control plane', async () => {
      after = await probe();
      return after.status !== 404;
    });

    assert.doesNotMatch(
      after.body,
      /runner_desconhecido/,
      'the runner registers before the first tick, not on the way to one',
    );
    assert.equal(after.status, 201, `the paired runner is granted its lease: ${after.body}`);

    // The probe's own lease goes back, so it counts against nobody's cap.
    const granted = (JSON.parse(after.body) as { lease: Lease }).lease;
    await api(plane, 'POST', `/v1/leases/${granted.id}/releases`, {});

    await runner.stop();
  });

  await parent.test('AT9 — a released job is dispatched and the lease goes back', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-at9-'));
    const record = path.join(workDir, 'despacho.json');
    t.after(async () => {
      await blockEveryJob(plane);
      rmSync(workDir, { recursive: true, force: true });
    });

    const job = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      { titulo: 'trabalho que o runner empacotado despacha', no_entrada_id: DEFAULT_NODE, execucao_id: 1629 },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t162-at9',
      engine: 'claude-code',
      workingDir: workDir,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 500,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({
        FAKE_ENGINE_LINES: QUIET_LINES,
        FAKE_ENGINE_RECORD: record,
      }),
    });

    await waitFor('the job being dispatched to completion', async () => {
      const { sessoes: sessions } = await api<{ sessoes: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execucao_id=1629',
      );
      return sessions.some((session) => session.status === 'concluida');
    });

    await runner.stop();

    assert.ok(existsSync(record), 'the session really ran through the fake engine');

    const leases = await leasesOfJob(plane, job.id);
    assert.ok(leases.length > 0, 'the dispatch happened under a lease');
    assert.deepEqual(
      [...new Set(leases.map((lease) => lease.status))],
      ['liberada'],
      'every lease this job was dispatched under went back',
    );
  });

  await parent.test('AT10 — --engine codex wires the codex adapter', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-at10-'));
    const record = path.join(workDir, 'despacho-codex.json');
    t.after(async () => {
      await blockEveryJob(plane);
      rmSync(workDir, { recursive: true, force: true });
    });

    // Created ON the node that declares `codex`: the engine is a property of
    // the step, and this runner has a route for that one and no other.
    const job = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        titulo: 'trabalho num nó que declara codex',
        no_entrada_id: CODEX_NODE,
        execucao_id: 16210,
        grafo_versao_id: version.id,
      },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t162-at10',
      engine: 'codex',
      workingDir: workDir,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 500,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({
        FAKE_ENGINE_LINES: QUIET_LINES,
        FAKE_ENGINE_RECORD: record,
      }),
    });

    await waitFor('the codex route dispatching the job', async () => {
      const { sessoes: sessions } = await api<{ sessoes: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execucao_id=16210',
      );
      return sessions.some((session) => session.status === 'concluida');
    });

    await runner.stop();

    const { eventos: events } = await api<{ eventos: Event[] }>(
      plane,
      'GET',
      '/v1/executions/16210/events',
    );
    const opened = events.filter((event) => event.tipo === 'sessao.aberta');
    assert.ok(opened.length > 0, 'a session was opened for this execution');
    assert.deepEqual(
      [...new Set(opened.map((event) => event.dados.engine))],
      ['codex'],
      'the engine the runner was told to use is the engine the log records',
    );

    // ...and the argv is the one codex's own command builder produces, which is
    // the only channel that tells the two adapters apart from the outside.
    assert.ok(existsSync(record), 'the codex route never started a session');
    const received = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[] };
    assert.ok(
      received.argv.includes('exec') && received.argv.includes('--skip-git-repo-check'),
      `the fake engine got codex's argv:\n${received.argv.join(' ')}`,
    );

    const leases = await leasesOfJob(plane, job.id);
    assert.deepEqual([...new Set(leases.map((lease) => lease.status))], ['liberada']);
  });

  await parent.test('AT11 — a tick that blows up is logged and the loop keeps turning', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-at11-'));
    t.after(async () => {
      await blockEveryJob(plane);
      rmSync(workDir, { recursive: true, force: true });
    });

    // Recorded and swallowed: the lines below are the failure under test, and
    // letting them through would read as the suite itself breaking.
    const logged: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    t.after(() => {
      process.stderr.write = original;
    });

    // This runner routes `claude-code` and nothing else, so a job standing on
    // the node that declares `codex` is an `UnknownEngineError` — thrown before
    // any session opens, and travelling up through `tick()`.
    const poison = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        titulo: 'trabalho que pede um engine que este runner não tem',
        no_entrada_id: CODEX_NODE,
        execucao_id: 16211,
        grafo_versao_id: version.id,
      },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t162-at11',
      engine: 'claude-code',
      workingDir: workDir,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }),
    });

    await waitFor('the failing tick being logged', async () => {
      await delay(0);
      return logged.some((line) => line.includes('codex'));
    });

    // The lease of the failed dispatch went back all the same: the loop is the
    // only thing that survived the error, not the capacity.
    const poisonLeases = await leasesOfJob(plane, poison.id);
    assert.ok(poisonLeases.length > 0, 'the failing tick did take a lease');
    assert.deepEqual(
      [...new Set(poisonLeases.map((lease) => lease.status))],
      ['liberada'],
      'a dispatch that blew up still gave its lease back',
    );

    // Out of the queue, or the next tick would keep finding it first — the
    // controller stops at the first candidate that yields a lease.
    await api(plane, 'POST', `/v1/jobs/${poison.id}/blocks`, { motivo: 'engine sem rota neste runner' });

    const healthy = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      { titulo: 'trabalho que este runner sabe despachar', no_entrada_id: DEFAULT_NODE, execucao_id: 16212 },
      201,
    );

    await waitFor('the loop dispatching a later job after the failure', async () => {
      const { sessoes: sessions } = await api<{ sessoes: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execucao_id=16212',
      );
      return sessions.some((session) => session.status === 'concluida');
    });

    await runner.stop();

    const healthyLeases = await leasesOfJob(plane, healthy.id);
    assert.ok(healthyLeases.length > 0, 'the loop was still alive to take this one');
  });

  await parent.test('AT12 — aborting while idle stops the loop within one tick', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-at12-'));
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    const intervalMs = 2_000;
    const aborter = new AbortController();
    const finished = runRunner({
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t162-at12',
      engine: 'claude-code',
      workingDir: workDir,
      runnerCap: 1,
      projectCap: 4,
      intervalMs,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }),
      signal: aborter.signal,
    });

    // Idle means idle: the queue was emptied by the subtests above, so the
    // only thing this loop is doing is waiting out its interval.
    const { trabalhos: jobs } = await api<{ trabalhos: Job[] }>(plane, 'GET', '/v1/jobs');
    assert.deepEqual(
      jobs.filter((job) => !job.bloqueado),
      [],
      'this case measures a shutdown with nothing in flight',
    );

    // Landed well inside the interval the loop is waiting out, which is where
    // the two possible implementations differ: one wakes up, the other waits
    // the remaining ~1.7s out and only then notices.
    await delay(300);
    const asked = Date.now();
    aborter.abort();
    await finished;
    const took = Date.now() - asked;

    assert.ok(
      took < intervalMs,
      `an idle stop took ${took}ms, longer than the ${intervalMs}ms interval it was waiting out`,
    );
    assert.ok(
      took < intervalMs / 2,
      `an idle stop took ${took}ms: the shutdown is bounded by the interval, but it should not be waiting it out`,
    );
  });

  await parent.test('AT13 — aborting mid-dispatch waits for the lease to go back', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-at13-'));
    t.after(async () => {
      await blockEveryJob(plane);
      rmSync(workDir, { recursive: true, force: true });
    });

    const job = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      { titulo: 'trabalho com sessão demorada', no_entrada_id: DEFAULT_NODE, execucao_id: 16213 },
      201,
    );

    const aborter = new AbortController();
    const finished = runRunner({
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t162-at13',
      engine: 'claude-code',
      workingDir: workDir,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 30,
      // Held open long enough that the abort below really lands in the middle
      // of a live session.
      engineFactory: fakeEngineFactory({
        FAKE_ENGINE_LINES: QUIET_LINES,
        FAKE_ENGINE_DELAY_MS: '3000',
      }),
      signal: aborter.signal,
    });
    t.after(async () => {
      aborter.abort();
      await finished;
    });

    // The session row is written as soon as the engine is up, which is the
    // earliest moment this test can know a dispatch is in flight.
    await waitFor('a session being opened', async () => {
      const { sessoes: sessions } = await api<{ sessoes: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execucao_id=16213',
      );
      return sessions.length > 0;
    });

    const live = await leasesOfJob(plane, job.id);
    assert.deepEqual(
      [...new Set(live.map((lease) => lease.status))],
      ['ativa'],
      'the dispatch under way is holding its lease',
    );

    aborter.abort();
    await finished;

    // Read immediately, with no waiting of any kind: whatever this says is what
    // was true the instant the shutdown returned.
    const afterStop = await leasesOfJob(plane, job.id);
    assert.deepEqual(
      [...new Set(afterStop.map((lease) => lease.status))],
      ['liberada'],
      'the stop returned only after the dispatch in flight settled and gave the lease back',
    );

    const { sessoes: sessions } = await api<{ sessoes: Session[] }>(
      plane,
      'GET',
      '/v1/sessions?execucao_id=16213',
    );
    assert.deepEqual(
      [...new Set(sessions.map((session) => session.status))],
      ['concluida'],
      'no session was killed halfway: the one in flight finished on its own',
    );
  });
});
