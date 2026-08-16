/**
 * Acceptance tests of the packaged composition (t162, AT8–AT13; t179 AT1).
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
 * **A real repository per subtest that dispatches (t179).** `runRunner` now
 * builds a `GitWorktreeManager` out of `repoRoot` and `worktreesRoot`, so a
 * dispatch runs `git worktree add` for real; the fixture below hands each
 * subtest a repository with one commit and a SIBLING root for its worktrees,
 * never a directory inside it. The two cases that never dispatch (AT8, AT12)
 * get plain directories, because a repository they never cut from would only be
 * fixture nobody reads.
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
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import type * as RunModule from '../../src/cli/run.ts';
import type { EngineRoute } from '../../src/dispatch/dispatch.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
} from '../../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { CODEX_MODELS, CodexAdapter } from '../../src/engine/codex-adapter.ts';
import {
  buildCommand as buildCodexCommand,
  buildEnvironment as buildCodexEnvironment,
} from '../../src/engine/codex-command.ts';
import { buildCommand, buildEnvironment, type EngineCommand } from '../../src/engine/command.ts';
import type {
  CliProbe,
  EngineAdapter,
  EngineCapabilities,
  ModelCatalog,
  SessionListener,
  SessionSpec,
  SessionStatus,
} from '../../src/engine/types.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
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

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Runs git in a directory and gives back its stdout, trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** The three directories one subtest of this file works in (t179). */
interface Workspace {
  /** What `--working-dir` names: the repository worktrees are cut from. */
  repoRoot: string;
  /**
   * What `--worktrees-root` names: where those worktrees land.
   *
   * A sibling of {@link repoRoot} and deliberately NOT created — creating it is
   * `GitWorktreeManager`'s job on the first dispatch.
   */
  worktreesRoot: string;
  /**
   * Where the TEST writes what it needs to read back.
   *
   * Never inside {@link repoRoot}: a sidecar dropped in the repository would be
   * a new entry in it, which is exactly what t179 AT1 measures.
   */
  scratch: string;
}

/**
 * A base temp directory holding the three paths above, cleaned up as a unit.
 *
 * `realpathSync` on the base, and this is not decoration: on macOS `mkdtemp`
 * hands out `/var/folders/...` while a process started inside it reports
 * `/private/var/folders/...` as its cwd. t179 AT1 compares the session's
 * recorded cwd against `worktreesRoot`, and the two have to be the same string
 * for that comparison to mean anything.
 */
function workspace(t: TestHook, label: string): Workspace {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), `cartografo-${label}-`)));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const repoRoot = path.join(base, 'repo');
  mkdirSync(repoRoot);
  return { repoRoot, worktreesRoot: path.join(base, 'worktrees'), scratch: base };
}

/**
 * The same, with `repoRoot` made into a real repository with one commit.
 *
 * Real git, mirroring `test/dispatch/session-worktree.test.ts:101-117`, because
 * what a dispatch does now is `git worktree add`: a fixture that only looked
 * like a repository would prove this file's opinion of git instead of the
 * wiring under test.
 */
function initRepo(t: TestHook, label: string): Workspace {
  const space = workspace(t, label);

  git(space.repoRoot, 'init', '--quiet');
  git(space.repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(space.repoRoot, 'config', 'user.name', 'Fixture t179');
  writeFileSync(path.join(space.repoRoot, 'README.md'), '# Repo de fixture da t179\n');
  git(space.repoRoot, 'add', '.');
  git(space.repoRoot, 'commit', '--quiet', '-m', 'inicial');

  return space;
}

/** The real control plane, as this file reaches it. */
interface RunningControlPlane {
  baseUrl: string;
  token: string;
}

/**
 * Boots the real binary and returns the address and credential it announced.
 *
 * The spawn, the readiness wait and the teardown are
 * `@cartografo/test-support`'s since t201; what stays here is the shape the
 * assertions below already speak.
 */
async function bootControlPlane(t: TestHook): Promise<RunningControlPlane> {
  const { url, token } = await bootCore(t);
  return { baseUrl: url, token };
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
 * The preflight command every adapter built here runs, on the fake binary.
 *
 * It is the same seam as `commandBuilder`, applied to the other spawn an
 * adapter does. Since t186 the runner PROBES before it reports its catalog, so
 * an adapter left with the real `claude --version`/`codex --version` would make
 * this file's startup path depend on an installed CLI — exactly what the header
 * says the suite must never do.
 */
const FAKE_PROBE = (): EngineCommand => ({
  command: process.execPath,
  args: [FAKE_ENGINE, '--version'],
});

/**
 * The `engineFactory` seam, pointed at the fake engine.
 *
 * Only the BINARY changes: the argv each adapter's own command builder produces
 * goes through whole, which is what keeps this a test of the wiring instead of
 * a test of a command nobody issues. The fake engine is configured through the
 * environment — its only channel — so the overrides ride the adapter's
 * `environmentBuilder`, the seam that exists for exactly this.
 *
 * @param overrides Environment the fake engine is configured through.
 * @param probeCommandBuilder What the preflight probe runs. Default: the fake
 *   engine answering `--version`, i.e. a CLI that is there.
 */
function fakeEngineFactory(
  overrides: Record<string, string>,
  probeCommandBuilder: () => EngineCommand = FAKE_PROBE,
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
            probeCommandBuilder,
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
            probeCommandBuilder,
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
  //
  // The fixture's own `skill_ref`s are placeholders and always were —
  // `cartografo/redigir-nota` could never enter the registry, whose ids are
  // kebab-case with no slash. That did not matter until t161, when a dispatch
  // started resolving the node's skill and refusing to open a session for one
  // nobody registered. So the pins are rewired here, in the test, to a manifest
  // this package really registers: what these cases are about is which ENGINE
  // ran, and the skill underneath only has to be real.
  const skill = await api<{ id: string; version: string; hash: string }>(
    plane,
    'POST',
    '/v1/skills',
    JSON.parse(
      readFileSync(
        path.join(PACKAGE_ROOT, 'test', 'fixtures', 'skill-travessia-fazer.json'),
        'utf8',
      ),
    ) as Record<string, unknown>,
    201,
  );
  const fixture = JSON.parse(readFileSync(GRAPH_FIXTURE, 'utf8')) as Record<string, unknown>;
  const pinned: Array<Record<string, unknown>> = (
    fixture.nodes as Array<Record<string, unknown>>
  ).map((node) => ({
    ...node,
    skill_ref: { id: skill.id, version: skill.version, hash: skill.hash },
  }));

  // A third node, and it is not decoration either. In the committed fixture the
  // codex node IS the only final node, and since t161 a job standing on a final
  // node is `concluido` and stops being a dispatch candidate — so the two cases
  // below, which both need a job dispatched ON the codex node, would never get
  // a tick at all. The terminal step moves one node further along, and `conferir`
  // becomes an ordinary step of the traversal.
  const document = {
    ...fixture,
    nodes: [
      ...pinned,
      {
        id: 'arquivar',
        role: 'arquivista',
        node_type: 'work',
        engine: 'codex',
        description: 'Encerra a travessia. Existe para que `conferir` não seja o nó final.',
        skill_ref: { id: skill.id, version: skill.version, hash: skill.hash },
        contract: pinned[0].contract,
      },
    ],
    edges: [
      ...(fixture.edges as unknown[]),
      { from: CODEX_NODE, to: 'arquivar', condition: 'sempre', description: 'Saída única.' },
    ],
    final_nodes: ['arquivar'],
  };
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

    // Plain directories: this case pairs and never dispatches, so no worktree
    // is ever cut and a real repository would be fixture nobody reads.
    const { repoRoot, worktreesRoot } = workspace(t, 't162-at8');

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId,
      runnerId,
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
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

    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't162-at9');
    const record = path.join(scratch, 'despacho.json');
    t.after(async () => {
      await blockEveryJob(plane);
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
      repoRoot,
      worktreesRoot,
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

    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't162-at10');
    const record = path.join(scratch, 'despacho-codex.json');
    t.after(async () => {
      await blockEveryJob(plane);
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
      repoRoot,
      worktreesRoot,
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

    // A real repository, for the SECOND job: the poison one never reaches a
    // worktree (`UnknownEngineError` is thrown before `acquire`), but the
    // healthy one that proves the loop survived is dispatched for real.
    const { repoRoot, worktreesRoot } = initRepo(t, 't162-at11');
    t.after(async () => {
      await blockEveryJob(plane);
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
      repoRoot,
      worktreesRoot,
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

    // Plain directories, for AT8's reason: an idle loop cuts no worktree.
    const { repoRoot, worktreesRoot } = workspace(t, 't162-at12');

    const intervalMs = 2_000;
    const aborter = new AbortController();
    const finished = runRunner({
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t162-at12',
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
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

    const { repoRoot, worktreesRoot } = initRepo(t, 't162-at13');
    t.after(async () => {
      await blockEveryJob(plane);
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
      repoRoot,
      worktreesRoot,
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

  await parent.test('t179 AT1 — the session runs in a worktree, never in the operator\'s checkout', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't179-at1');
    const record = path.join(scratch, 'despacho.json');
    t.after(async () => {
      await blockEveryJob(plane);
    });

    // What the operator's own checkout looks like before any session runs. Gap
    // #6 of the first dogfood — "the session works in the shared checkout; the
    // OPERATOR itself became a concurrent writer" — is the failure this
    // comparison exists to catch coming back.
    const before = readdirSync(repoRoot).sort();

    await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      { titulo: 'trabalho que prova o isolamento do worktree', no_entrada_id: DEFAULT_NODE, execucao_id: 17_901 },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t179-at1',
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
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
        '/v1/sessions?execucao_id=17901',
      );
      return sessions.some((session) => session.status === 'concluida');
    });

    await runner.stop();

    // The session's own account of where it ran — the only witness that cannot
    // be satisfied by a stub that merely stops the `TypeError`.
    assert.ok(existsSync(record), 'the session never ran through the fake engine');
    const received = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };

    assert.ok(
      received.cwd.startsWith(worktreesRoot + path.sep),
      `the session ran outside the root it was given: ${received.cwd}`,
    );
    assert.ok(
      received.cwd !== repoRoot && !received.cwd.startsWith(repoRoot + path.sep),
      `the session wrote in the repository the worktree was cut from: ${received.cwd}`,
    );

    assert.deepEqual(
      readdirSync(repoRoot).sort(),
      before,
      'the run left new entries in the repository it was cut from',
    );
    assert.equal(
      git(repoRoot, 'status', '--porcelain'),
      '',
      'the operator\'s checkout has to be exactly as clean as it was before the dispatch',
    );
  });
});

/* --- t186: FR11's precondition — the probe comes before the catalog --------- */

/** One engine's catalog, as `GET /v1/engines` gives it back. */
interface ReportedCatalog {
  motor: string;
  modelos: Array<{ modelo_id: string; rotulo: string | null; origem: string }>;
}

/** A preflight command that cannot answer, because the binary is not there. */
const MISSING_PROBE = (): EngineCommand => ({
  command: path.join(tmpdir(), 'cartografo-binary-that-does-not-exist-186'),
  args: ['--version'],
});

/**
 * Wraps an adapter and records the two calls FR11 puts in an order.
 *
 * It delegates everything and decides nothing: what it adds is the ledger the
 * ordering assertion reads, plus one sample of the control plane taken FROM
 * INSIDE the probe — the only moment at which "after the pairing" is a question
 * with an answer.
 */
class RecordingAdapter implements EngineAdapter {
  readonly engineName: string;
  /** The calls the runner made, in order. */
  readonly calls: string[] = [];
  /** Was this runner already paired when the probe ran? `null` = never probed. */
  pairedAtProbe: boolean | null = null;
  readonly #inner: EngineAdapter;
  readonly #paired: () => Promise<boolean>;

  constructor(inner: EngineAdapter, paired: () => Promise<boolean>) {
    this.#inner = inner;
    this.#paired = paired;
    this.engineName = inner.engineName;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    return await this.#inner.startSession(spec, listener);
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return await this.#inner.getStatus(sessionId);
  }

  async cancel(sessionId: string, status?: SessionStatus): Promise<void> {
    await this.#inner.cancel(sessionId, status);
  }

  capabilities(): EngineCapabilities {
    return this.#inner.capabilities();
  }

  async verifyCli(): Promise<CliProbe> {
    this.pairedAtProbe = await this.#paired();
    this.calls.push('verifyCli');
    return await this.#inner.verifyCli();
  }

  async listModels(): Promise<ModelCatalog> {
    this.calls.push('listModels');
    const inner = this.#inner.listModels?.bind(this.#inner);
    assert.ok(inner, `${this.engineName} lost its listModels() on the way through the wrapper`);
    return await inner();
  }
}

/**
 * The precondition FR11 states and t162 never implemented (t186).
 *
 * "The runner reports its model catalog after pairing and `verifyCli()`
 * succeed" was written as one sentence with two halves, and only the first
 * half was ever wired: `runRunner` paired and then reported, with no probe
 * anywhere in the chain. What these cases pin is the missing half — that the
 * probe RUNS, that it runs in the right place in the sequence, and that its
 * answer is what decides whether a catalog goes out at all.
 *
 * A control plane of its own, and the two engines carry the two answers: the
 * reported catalog is global (`GET /v1/engines` is not scoped by runner or by
 * project), so a case asserting an engine has NO catalog can only be trusted on
 * a plane where nothing else reported one for it.
 *
 * What is deliberately NOT asserted here: that a failed probe stops the runner.
 * It must not — the catalog is discovery, never a gate (`engine/types.ts`,
 * `listModels`), and a machine that refuses to work because a preflight could
 * not find a binary is a machine that does no work at all while its sessions
 * would have failed one by one with an exact message. AT2 measures the
 * opposite: the probe fails and the runner comes up anyway.
 */
test('t186 — the catalog is reported only after the CLI probe answers', async (parent) => {
  const plane = await bootControlPlane(parent);

  /** Every engine catalog the control plane is holding right now. */
  const catalogs = async (): Promise<ReportedCatalog[]> => {
    const { motores } = await api<{ motores: ReportedCatalog[] }>(plane, 'GET', '/v1/engines');
    return motores;
  };

  /** Is this runner already known to the control plane? */
  const isPaired = async (runnerId: string): Promise<boolean> => {
    const { runners } = await api<{ runners: Array<{ id: string }> }>(plane, 'GET', '/v1/runners');
    return runners.some((runner) => runner.id === runnerId);
  };

  await parent.test('AT1 — the probe runs after the pairing and before the catalog', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    // Plain directories, for AT8's reason: this case never dispatches.
    const { repoRoot, worktreesRoot } = workspace(t, 't186-at1');
    const runnerId = 'runner-t186-at1';

    const adapter = new RecordingAdapter(
      new ClaudeCodeAdapter({ probeCommandBuilder: FAKE_PROBE, graceMs: 300 }),
      () => isPaired(runnerId),
    );

    let announce: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId,
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: () => ({ adapter, decodeSessionText: decodeClaudeCodeSessionText }),
      onReady: () => announce(),
    });

    await ready;
    await runner.stop();

    assert.deepEqual(
      adapter.calls,
      ['verifyCli', 'listModels'],
      'the startup path probes the CLI, and only then asks it for a catalog',
    );
    assert.equal(
      adapter.pairedAtProbe,
      true,
      'the probe ran before the pairing, so the report it gates would land in the dark',
    );

    const reported = (await catalogs()).find((entry) => entry.motor === 'claude-code');
    assert.ok(reported, 'a probe that answered has to end in a reported catalog');
    assert.ok(reported.modelos.length > 0, 'the reported catalog is the adapter\'s, not an empty list');
  });

  await parent.test('AT2 — a probe that finds no CLI reports no catalog, and the runner still comes up', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const { repoRoot, worktreesRoot } = workspace(t, 't186-at2');
    const runnerId = 'runner-t186-at2';

    // Recorded and swallowed, on AT11's terms: the line below is the skip under
    // test, and letting it through would read as the suite itself breaking.
    const logged: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    t.after(() => {
      process.stderr.write = original;
    });

    assert.equal(
      (await catalogs()).some((entry) => entry.motor === 'codex'),
      false,
      'nothing has reported a codex catalog to this control plane yet',
    );

    let announce: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId,
      engine: 'codex',
      repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }, MISSING_PROBE),
      onReady: () => announce(),
    });

    await ready;

    // Two full intervals with the loop turning: a runner that only reached
    // readiness and then died would prove nothing about "still comes up".
    await delay(500);
    await runner.stop();

    assert.equal(
      (await catalogs()).some((entry) => entry.motor === 'codex'),
      false,
      'the catalog went out although the CLI the models belong to never answered',
    );
    assert.equal(
      await isPaired(runnerId),
      true,
      'a failed probe stopped the runner from being a runner at all',
    );
    assert.ok(
      logged.some((line) => line.includes('codex')),
      `the skip is silent; an operator has no way to learn why the menu is empty: ${JSON.stringify(logged)}`,
    );
  });

  await parent.test('AT3 — a probe that answers reports the catalog the adapter offers', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const { repoRoot, worktreesRoot } = workspace(t, 't186-at3');

    let announce: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t186-at3',
      engine: 'codex',
      repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }),
      onReady: () => announce(),
    });

    await ready;
    await runner.stop();

    const reported = (await catalogs()).find((entry) => entry.motor === 'codex');
    assert.ok(reported, 'the probe answered, so the catalog had to go out');
    assert.deepEqual(
      reported.modelos.map((model) => model.modelo_id).sort(),
      CODEX_MODELS.map((model) => model.id).sort(),
      'what was reported is this adapter\'s own catalog, entry for entry',
    );
  });
});
