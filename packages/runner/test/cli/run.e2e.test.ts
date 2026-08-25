/**
 * Acceptance tests of the packaged composition (t162, AT8–AT13; t179 AT1).
 *
 * `runRunner` is the spike written down: `ControlPlaneClient` + `Controller` +
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
 * `docs/formats/engine-adapter.md:363-366` records and that
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
import { createHash } from 'node:crypto';
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
const GRAPH_FIXTURE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-two-engines.json');
const SKILL_FIXTURE = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'skill-do-crossing.json');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The manifest this file registers, read fresh so a caller may edit its copy. */
function skillFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(SKILL_FIXTURE, 'utf8')) as Record<string, unknown>;
}

/** Sorts keys recursively — the canonicalization the manifest hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/**
 * The pin of a manifest, recomputed here rather than imported (t215).
 *
 * `packages/runner` declares no dependency on `packages/core` — it is an HTTP
 * client of the public API and nothing more (D1, D11) — so the six-field
 * procedure of `specs/formats/skill-manifest.md` is written out. It
 * is the same reason `packages/core/test/skill-routes.test.ts` writes it out:
 * a hash the test asks the implementation for proves nothing about the pin.
 */
function manifestContentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

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
  title: string;
  current_node_id: string;
  blocked: boolean;
  /** What a person reads first when the work left the queue (t252). */
  block_reason: string | null;
}

interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  status: string;
}

interface Session {
  id: number;
  job_id: number | null;
  node_id: string | null;
  engine: string;
  status: string;
}

interface Event {
  id: number;
  type: string;
  data: Record<string, unknown>;
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
    `/v1/leases?job_id=${jobId}`,
  );
  return leases.filter((lease) => lease.job_id === jobId);
}

/**
 * Takes every released job out of the queue.
 *
 * The cleanup this file's header explains: a job that finished a dispatch is
 * still released (advancing a node is t109's, not this ticket's), so without
 * this the next subtest's runner would find it and dispatch it again.
 */
async function blockEveryJob(plane: RunningControlPlane): Promise<void> {
  const { jobs: jobs } = await api<{ jobs: Job[] }>(plane, 'GET', '/v1/jobs');
  for (const job of jobs) {
    if (job.blocked) continue;
    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'fim do caso de teste' });
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
    skillFixture(),
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
    // Same reason the pins are rewired above: with a REAL manifest underneath,
    // the class has to declare the scalar that manifest requires at the top of
    // `input`, or t278's contract gate refuses the document at registration.
    custom_fields: [{ name: 'pedido', type: 'string', required_at: null }],
  };
  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
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
          project_id: projectId,
          job_id: 999_162,
          runner_cap: 1,
          project_cap: 1,
          ttl_seconds: 1,
        }),
      });
      return { status: response.status, body: await response.text() };
    };

    // Without the pairing this probe is a 404, and that is what makes the
    // assertion after the start mean something.
    const before = await probe();
    assert.equal(before.status, 404, `an unpaired runner gets a 404: ${before.body}`);
    assert.match(before.body, /unknown_runner/);

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
      /unknown_runner/,
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
      { title: 'trabalho que o runner empacotado despacha', entry_node_id: DEFAULT_NODE, execution_id: 1629 },
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
      const { sessions: sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=1629',
      );
      return sessions.some((session) => session.status === 'completed');
    });

    await runner.stop();

    assert.ok(existsSync(record), 'the session really ran through the fake engine');

    const leases = await leasesOfJob(plane, job.id);
    assert.ok(leases.length > 0, 'the dispatch happened under a lease');
    assert.deepEqual(
      [...new Set(leases.map((lease) => lease.status))],
      ['released'],
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
        title: 'trabalho num nó que declara codex',
        entry_node_id: CODEX_NODE,
        execution_id: 16210,
        graph_version_id: version.id,
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
      const { sessions: sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=16210',
      );
      return sessions.some((session) => session.status === 'completed');
    });

    await runner.stop();

    const { events: events } = await api<{ events: Event[] }>(
      plane,
      'GET',
      '/v1/executions/16210/events',
    );
    const opened = events.filter((event) => event.type === 'session.opened');
    assert.ok(opened.length > 0, 'a session was opened for this execution');
    assert.deepEqual(
      [...new Set(opened.map((event) => event.data.engine))],
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
    assert.deepEqual([...new Set(leases.map((lease) => lease.status))], ['released']);
  });

  await parent.test('AT11 — a tick that blows up blocks the work with its reason, and the loop keeps turning (t252)', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    // A real repository, for the SECOND job: the poison one never reaches a
    // worktree (`UnknownEngineError` is raised before `acquire`), but the
    // healthy one that proves the loop survived is dispatched for real.
    const { repoRoot, worktreesRoot } = initRepo(t, 't162-at11');
    t.after(async () => {
      await blockEveryJob(plane);
    });

    // This runner routes `claude-code` and nothing else, so a job standing on
    // the node that declares `codex` is an `UnknownEngineError` — raised before
    // any session opens.
    //
    // What this test asserted until t252 was the line `cli/run.ts` logged on the
    // way past: the error travelled up through `tick()`, one line went to
    // stderr, and two seconds later the same job was at the head of the same
    // queue being dispatched into the same throw. t252 closed exactly that loop
    // (`src/dispatch/pre-session-failure.ts`): a failure that will reproduce on
    // every retry is now CLASSIFIED, the work is blocked with the reason a
    // person reads, and the dispatch resolves normally — so there is no line on
    // stderr any more, and asserting one was asserting the bug. The stderr
    // capture that used to stand here went with it.
    const poison = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        title: 'trabalho que pede um engine que este runner não tem',
        entry_node_id: CODEX_NODE,
        execution_id: 16211,
        graph_version_id: version.id,
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

    // The first half of t252's contract: the work LEAVES the queue on the
    // runner's own account, and it leaves carrying why.
    await waitFor('the failing dispatch blocking its own work', async () => {
      const current = await api<Job>(plane, 'GET', `/v1/jobs/${poison.id}`);
      return current.blocked;
    });

    const blocked = await api<Job>(plane, 'GET', `/v1/jobs/${poison.id}`);
    assert.match(
      blocked.block_reason ?? '',
      /codex/,
      `the reason a person reads has to name the engine with no route: ${blocked.block_reason}`,
    );

    // ...and it left BEFORE anything was spent, which is the whole point of
    // classifying pre-session: no session was ever opened for that execution.
    // Structural on purpose — it says what `Nenhuma sessão foi aberta` says in
    // the reason, without pinning the Portuguese sentence that says it.
    const { sessions: poisonSessions } = await api<{ sessions: Session[] }>(
      plane,
      'GET',
      '/v1/sessions?execution_id=16211',
    );
    assert.deepEqual(poisonSessions, [], 'a pre-session block opens no session at all');

    // The lease of the failed dispatch went back all the same: what the failure
    // costs is one candidate, never the capacity.
    const poisonLeases = await leasesOfJob(plane, poison.id);
    assert.ok(poisonLeases.length > 0, 'the failing tick did take a lease');
    assert.deepEqual(
      [...new Set(poisonLeases.map((lease) => lease.status))],
      ['released'],
      'a dispatch that blocked its work still gave its lease back',
    );

    // No `POST /blocks` by hand here any more, and that absence is the assertion
    // above read from the other side: this test used to have to take the poison
    // job out of the queue itself, or the next tick would find it at the head
    // again and dispatch it into the same failure. The runner does it now, which
    // is what makes the second half — a later job being reached at all —
    // something the runner earns rather than something the test arranges.
    const healthy = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      { title: 'trabalho que este runner sabe despachar', entry_node_id: DEFAULT_NODE, execution_id: 16212 },
      201,
    );

    await waitFor('the loop dispatching a later job after the failure', async () => {
      const { sessions: sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=16212',
      );
      return sessions.some((session) => session.status === 'completed');
    });

    await runner.stop();

    const healthyLeases = await leasesOfJob(plane, healthy.id);
    assert.ok(healthyLeases.length > 0, 'the loop was still alive to take this one');
  });

  await parent.test('AT12 — aborting while idle stops the loop within one tick', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    // Plain directories, for AT8's reason: an idle loop cuts no worktree.
    const { repoRoot, worktreesRoot } = workspace(t, 't162-at12');

    // Long on purpose (t292). What this case measures is the GAP between an
    // implementation that notices the abort and one that waits the interval
    // out, and that gap has to be much wider than the noise of the measurement
    // itself. At 2_000ms it was not, and the assertion below went red about
    // once in several full-suite runs; at 20_000ms an implementation that waits
    // the interval out takes ~19.7s, four times the bound this case allows.
    const intervalMs = 20_000;
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
    const { jobs: jobs } = await api<{ jobs: Job[] }>(plane, 'GET', '/v1/jobs');
    assert.deepEqual(
      jobs.filter((job) => !job.blocked),
      [],
      'this case measures a shutdown with nothing in flight',
    );

    // Landed well inside the interval the loop is waiting out, which is where
    // the two possible implementations differ: one wakes up, the other waits
    // the remaining ~19.7s out and only then notices.
    await delay(300);
    const asked = Date.now();
    aborter.abort();
    await finished;
    const took = Date.now() - asked;

    assert.ok(
      took < intervalMs,
      `an idle stop took ${took}ms, longer than the ${intervalMs}ms interval it was waiting out`,
    );
    // The line with the teeth, and the reason the one above is not enough: the
    // abort lands 300ms into the interval, so an implementation that waits the
    // rest of it out returns in ~19.7s — under `intervalMs`, and therefore
    // invisible to that assertion. This is the one that separates "noticed the
    // abort" from "waited the interval out".
    //
    // The number is measured, not guessed (t292). `took` is not pure shutdown
    // latency: the loop awaits whatever tick is in flight, and `runRunner`
    // pairs, preflights and reports its models before it ever parks, so an
    // abort that lands during that startup makes `took` the remainder of it.
    // Across 16 runs of this suite on an 8-core machine — 10 sequential, 6 with
    // two suites at once — that residue measured between 0ms and 753ms. 5_000ms
    // is ~6x the worst of them and ~1/4 of the ~19.7s the defect would cost, so
    // no scheduling hiccup reaches the bound and the defect cannot hide under
    // it. The earlier bound was `intervalMs / 2` — 1_000ms against a 753ms
    // worst case, which is how this became an intermittently red suite.
    const promptlyMs = 5_000;
    assert.ok(
      took < promptlyMs,
      `an idle stop took ${took}ms, past the ${promptlyMs}ms it is given: the shutdown is waiting the ${intervalMs}ms interval out instead of noticing the abort`,
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
      { title: 'trabalho com sessão demorada', entry_node_id: DEFAULT_NODE, execution_id: 16213 },
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
      const { sessions: sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=16213',
      );
      return sessions.length > 0;
    });

    const live = await leasesOfJob(plane, job.id);
    assert.deepEqual(
      [...new Set(live.map((lease) => lease.status))],
      ['active'],
      'the dispatch under way is holding its lease',
    );

    aborter.abort();
    await finished;

    // Read immediately, with no waiting of any kind: whatever this says is what
    // was true the instant the shutdown returned.
    const afterStop = await leasesOfJob(plane, job.id);
    assert.deepEqual(
      [...new Set(afterStop.map((lease) => lease.status))],
      ['released'],
      'the stop returned only after the dispatch in flight settled and gave the lease back',
    );

    const { sessions: sessions } = await api<{ sessions: Session[] }>(
      plane,
      'GET',
      '/v1/sessions?execution_id=16213',
    );
    assert.deepEqual(
      [...new Set(sessions.map((session) => session.status))],
      ['completed'],
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
      { title: 'trabalho que prova o isolamento do worktree', entry_node_id: DEFAULT_NODE, execution_id: 17_901 },
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
      const { sessions: sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=17901',
      );
      return sessions.some((session) => session.status === 'completed');
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

  /*
   * t215 AC1 — a newer version of a skill does not reach a node pinned to the
   * older one.
   *
   * This is the invariant D22 is built around — a node "never resolves 'the
   * latest one'", and improving a skill never breaks a map pinned to it — and
   * this is the only place in the repository where it can be measured end to
   * end: the real control plane serving a lineage with two versions, a real
   * graph frozen with the older pin, and the fake engine's own record of the
   * text it was handed.
   *
   * Two dispatches, and the SECOND one is the assertion. Before t215 the runner
   * asked `GET /v1/skills/:id` with no query — which resolves the latest — so
   * registering 1.1.0 would have made the second dispatch either render the new
   * text or refuse on the hash check. Both are the same bug seen from two sides:
   * a graph in flight changing behaviour because somebody improved a skill.
   */
  await parent.test('t215 AC1 — a node pinned to 1.0.0 still gets 1.0.0 after 1.1.0 is registered', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't215-ac1');
    t.after(async () => {
      await blockEveryJob(plane);
    });

    /** The text the pinned version carries, straight off the registered fixture. */
    const pinnedText = skillFixture().instructions as string;
    const newerText = `${pinnedText}\n\nE, desde a 1.1.0, escreva também o que NÃO fez.`;

    /** Runs one job to completion and gives back what the engine received. */
    const dispatch = async (label: string, executionId: number): Promise<string> => {
      const record = path.join(scratch, `${label}.json`);
      const runner = await startRunner(t, runRunner, {
        url: plane.baseUrl,
        token: plane.token,
        projectId: 1,
        runnerId: `runner-t215-${label}`,
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

      await api<Job>(
        plane,
        'POST',
        '/v1/jobs',
        {
          title: `travessia que prova o pino da skill (${label})`,
          entry_node_id: DEFAULT_NODE,
          execution_id: executionId,
          graph_version_id: version.id,
        },
        201,
      );

      await waitFor(`the ${label} job being dispatched to completion`, async () => {
        const { sessions: sessions } = await api<{ sessions: Session[] }>(
          plane,
          'GET',
          `/v1/sessions?execution_id=${executionId}`,
        );
        return sessions.some((session) => session.status === 'completed');
      });

      await runner.stop();
      await blockEveryJob(plane);

      assert.ok(existsSync(record), `the ${label} session never ran through the fake engine`);
      // argv AND the workdir files: the adapter moves `instructions` from the
      // argv to an ephemeral file past 64 KiB (`command.ts`), and which channel
      // carried it is not what this case is about.
      const received = JSON.parse(readFileSync(record, 'utf8')) as {
        argv: string[];
        files: Record<string, string>;
      };
      return [...received.argv, ...Object.values(received.files)].join('\n');
    };

    const before = await dispatch('antes', 21_501);
    assert.ok(
      before.includes(pinnedText),
      'the first dispatch did not carry the pinned version\'s instructions at all',
    );

    // The registry improves: a new version of the SAME lineage, with a body the
    // pinned one does not have. Nothing about the graph changes.
    const newer: Record<string, unknown> = {
      ...skillFixture(),
      version: '1.1.0',
      instructions: newerText,
    };
    newer.hash = manifestContentHash(newer);
    const registered = await api<{ id: string; version: string; hash: string }>(
      plane,
      'POST',
      '/v1/skills',
      newer,
      201,
    );
    assert.equal(registered.version, '1.1.0');
    assert.notEqual(registered.hash, skill.hash, 'the new version has to carry different content');

    const after = await dispatch('depois', 21_502);
    assert.ok(
      after.includes(pinnedText),
      'a node pinned to 1.0.0 stopped receiving 1.0.0 once 1.1.0 was registered',
    );
    assert.equal(
      after.includes(newerText),
      false,
      'the newer version\'s text reached a session that never pinned it',
    );
  });
});

/* --- t186: FR11's precondition — the probe comes before the catalog --------- */

/** One engine's catalog, as `GET /v1/engines` gives it back. */
interface ReportedCatalog {
  engine: string;
  models: Array<{ model_id: string; label: string | null; source: string }>;
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
    const { engines } = await api<{ engines: ReportedCatalog[] }>(plane, 'GET', '/v1/engines');
    return engines;
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

    const reported = (await catalogs()).find((entry) => entry.engine === 'claude-code');
    assert.ok(reported, 'a probe that answered has to end in a reported catalog');
    assert.ok(reported.models.length > 0, 'the reported catalog is the adapter\'s, not an empty list');
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
      (await catalogs()).some((entry) => entry.engine === 'codex'),
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
      (await catalogs()).some((entry) => entry.engine === 'codex'),
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

    const reported = (await catalogs()).find((entry) => entry.engine === 'codex');
    assert.ok(reported, 'the probe answered, so the catalog had to go out');
    assert.deepEqual(
      reported.models.map((model) => model.model_id).sort(),
      CODEX_MODELS.map((model) => model.id).sort(),
      'what was reported is this adapter\'s own catalog, entry for entry',
    );
  });
});
