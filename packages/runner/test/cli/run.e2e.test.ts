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
 * itself.** A job left released by one subtest is a candidate for the next
 * subtest's runner — which is how a dispatch nobody asked for shows up in the
 * middle of a shutdown measurement. The cleanup is `blockEveryJob`, in each
 * subtest's `after`: blocked work is nobody's candidate, and blocking is the
 * only API verb that takes a job out of the queue without pretending it was
 * finished.
 *
 * Since t410 that candidacy is bounded by the PROJECT: `GET /v1/jobs` reads one
 * project's board, so the t162 block below (which works in the default project
 * throughout) still needs the cleanup between its cases, while the t404 block
 * gives each case a project of its own and could not contaminate a sibling even
 * without it. `blockEveryJob` and `planeState` therefore take the project whose
 * board to read — the same number the case's own runner polls — because a
 * cleanup or a diagnostic that reads a different board than the runner is worse
 * than none: it reports "the control plane holds nothing" while the job sits
 * released one partition over.
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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { awaitReadiness, bootCore, spawnWatched } from '@cartografo/test-support';

import type * as CliModule from '../../src/cli/index.ts';
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
import {
  BASELINE_CAPABILITIES,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
  type McpDiscovery,
  type ModelCatalog,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
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
 * client of the public API and nothing more (D1, D11) — so the field-by-field
 * procedure of `specs/formats/skill-manifest.md` is written out. It
 * is the same reason `packages/core/test/skill-routes.test.ts` writes it out:
 * a hash the test asks the implementation for proves nothing about the pin.
 *
 * `command` (t332) is in the subset even though no manifest this file registers
 * declares one: an absent key serializes to nothing, so it costs these fixtures
 * nothing, and a copy of the recipe that agrees with the control plane only
 * about the fields it happens to use is a copy waiting to disagree.
 */
function manifestContentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

const RUN_MODULE = 'src/cli/run.ts';

/** The router, for the one case that measures an exit code rather than a loop. */
const CLI_MODULE = 'src/cli/index.ts';

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

/**
 * Swallows and records what a command writes on stderr, while it is armed.
 *
 * The same helper `test/cli/index.test.ts` has, for the same reason: the line
 * under test is a failure message, and letting it through would mix a
 * deliberate failure into the suite's own report.
 */
function captureStderr(): { written: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let written = '';

  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;

  return {
    written: () => written,
    restore: () => {
      process.stderr.write = original;
    },
  };
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

  git(space.repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  git(space.repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(space.repoRoot, 'config', 'user.name', 'Fixture t179');
  writeFileSync(path.join(space.repoRoot, 'README.md'), '# Fixture repo of t179\n');
  git(space.repoRoot, 'add', '.');
  git(space.repoRoot, 'commit', '--quiet', '-m', 'initial');

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

/**
 * What the control plane holds right now, as one line per entity.
 *
 * Only ever read on the failure path. A dispatch that does not happen says
 * nothing about WHY on its own — the job may be blocked with a reason, may be
 * held by a lease that never came back, or may have opened a session that never
 * finished, and those are three different bugs. This is what tells them apart
 * on a machine nobody can attach a debugger to.
 *
 * @param plane The control plane to read.
 * @param projectId Board to read, which has to be the one the case's runner
 *   polls (t410): omitted, the server's default project answers, and a case
 *   working in a project of its own would be told the plane holds nothing while
 *   its job sits released one partition over.
 */
async function planeState(plane: RunningControlPlane, projectId?: number): Promise<string> {
  const lines: string[] = [];
  const scope = projectId === undefined ? '' : `?project_id=${String(projectId)}`;
  try {
    const { jobs } = await api<{ jobs: Job[] }>(plane, 'GET', `/v1/jobs${scope}`);
    for (const job of jobs) {
      lines.push(
        `job ${String(job.id)} node=${job.current_node_id ?? '-'} blocked=${String(job.blocked)}` +
          ` reason=${JSON.stringify((job as { block_reason?: string }).block_reason ?? null)}`,
      );
      for (const lease of await leasesOfJob(plane, job.id)) {
        lines.push(`  lease ${String(lease.id)} runner=${lease.runner_id} status=${lease.status}`);
      }
    }
    const { sessions } = await api<{ sessions: Session[] }>(plane, 'GET', '/v1/sessions');
    for (const session of sessions) {
      lines.push(
        `session ${String(session.id)} status=${session.status}` +
          ` execution=${String((session as { execution_id?: number }).execution_id ?? 0)}`,
      );
    }
  } catch (error) {
    lines.push(`could not read the control plane: ${String(error)}`);
  }
  return lines.length === 0 ? '(the control plane holds nothing)' : lines.join('\n');
}

/**
 * Waits for something to become true, with a deadline and a message of its own.
 *
 * The deadline reports the state that outlasted it. Without that a timeout is
 * only the sentence "it did not happen", which is where a CI-only failure goes
 * to sit undiagnosed.
 *
 * @param label What was being waited for, as the message says it.
 * @param check The condition; polled until it answers true or the deadline
 *   passes.
 * @param plane Read for the state report on the failure path only.
 * @param projectId Board that report reads (t410) — see {@link planeState}.
 */
async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  plane?: RunningControlPlane,
  projectId?: number,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  const state = plane === undefined ? '' : `\n${await planeState(plane, projectId)}`;
  throw new Error(`${label} did not happen within ${DEADLINE_MS}ms${state}`);
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
 *
 * @param plane The control plane to clean.
 * @param projectId Board to clean (t410): omitted, the default project's, which
 *   is the one every case of the t162 block works in. A case working in a
 *   project of its own has to name it, or the cleanup would block a stranger's
 *   jobs and leave its own released.
 */
async function blockEveryJob(plane: RunningControlPlane, projectId?: number): Promise<void> {
  const scope = projectId === undefined ? '' : `?project_id=${String(projectId)}`;
  const { jobs: jobs } = await api<{ jobs: Job[] }>(plane, 'GET', `/v1/jobs${scope}`);
  for (const job of jobs) {
    if (job.blocked) continue;
    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'end of the test case' });
  }
}

/**
 * Declares a project and answers the id the control plane allocated for it.
 *
 * Read back rather than assumed (t410): a project is a REGISTERED entity since
 * t354, its id comes from the database, and `GET /v1/jobs` reads one project's
 * board — a number nobody declared answers `404 unknown_project`, so a runner
 * polling one would poll a board that does not exist and dispatch nothing, in
 * silence. Every case that wants a project OTHER than the default has to ask
 * for one here first.
 *
 * `GET /v1/sessions` reads the same way since t411 — it resolves a session's
 * scope through the `session.opened` event and refuses an undeclared project —
 * so the wait below, which polls that route with this id, needs the project to
 * exist for exactly the same reason the poll does.
 *
 * @param plane The control plane to declare in.
 * @param name Name of the project; unique per plane, so each case brings its
 *   own.
 * @returns The allocated project id.
 */
async function declareProject(plane: RunningControlPlane, name: string): Promise<number> {
  const { id } = await api<{ id: number }>(plane, 'POST', '/v1/projects', { name }, 201);
  return id;
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
 * The MCP listing every adapter built here runs, on the fake binary (t434).
 *
 * The same rule as {@link FAKE_PROBE}, applied to the spawn t401 added: since
 * the startup reports a probe, `buildProbeReport` calls `discoverMcpServers()`
 * unconditionally, and an adapter left with the real `claude mcp list` /
 * `codex mcp list --json` puts this file's startup path back on an installed
 * CLI — the one thing the header says the suite must never do. It was also
 * expensive: that spawn measured 2_142ms on an idle developer host and dominated
 * every startup in this file, which is what AT12's shutdown bound was failing
 * against on a loaded one.
 *
 * The fake answers the empty listing (`FAKE_ENGINE_MCP_LIST` unset), which is
 * what an engine with nothing configured really prints. A case that needs a
 * server named builds its own adapter, as `t360 AT4` does.
 */
const FAKE_MCP_LIST = (...args: string[]): (() => EngineCommand) => {
  return () => ({ command: process.execPath, args: [FAKE_ENGINE, 'mcp', 'list', ...args] });
};

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
            mcpListCommandBuilder: FAKE_MCP_LIST('--json'),
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
            mcpListCommandBuilder: FAKE_MCP_LIST(),
          }),
          decodeSessionText: decodeClaudeCodeSessionText,
        };
}

/** What the fake session prints: a quiet run, with nothing to ask. */
const QUIET_LINES = JSON.stringify([
  { stream: 'stdout', text: 'I did what the node asked for; nothing to ask.' },
]);

/**
 * An adapter that holds the startup open at its preflight (t434, FR3).
 *
 * `runRunner` runs four phases before it ever parks — pairing, the paths, the
 * model catalog, the probe — and what this adapter measures is what happens to
 * the ones that had NOT started when the abort landed. So it does two things
 * and nothing else: it writes down every startup call it is asked for, in
 * order, and it parks the FIRST `verifyCli` until the case lets it go, which is
 * what makes "the signal fired while a phase was in flight" a moment the test
 * can name instead of a race it has to guess at.
 *
 * The first call and not every call: `reportModels` and the probe each run
 * their own preflight (`run.ts`, `verifyEngineCli` and `buildProbeReport`), and
 * holding the second one too would park a phase this case asserts never starts.
 *
 * Independent of host load, on purpose. Every other measurement of this
 * shutdown is a stopwatch, and a stopwatch on a busy machine measures the
 * machine; this one measures the ORDER, which a loaded host cannot change.
 */
class GatedStartupAdapter implements EngineAdapter {
  readonly engineName = 'claude-code';

  /** Every startup call this adapter answered, in the order they arrived. */
  readonly calls: string[] = [];

  /** Resolves once the preflight has been entered and is being held. */
  readonly atPreflight: Promise<void>;

  #reachedPreflight: () => void = () => undefined;
  #openPreflight: () => void = () => undefined;
  readonly #heldPreflight: Promise<void>;

  constructor() {
    this.atPreflight = new Promise<void>((resolve) => {
      this.#reachedPreflight = resolve;
    });
    this.#heldPreflight = new Promise<void>((resolve) => {
      this.#openPreflight = resolve;
    });
  }

  /** Lets the held preflight answer, and with it the phase it belongs to. */
  releasePreflight(): void {
    this.#openPreflight();
  }

  async verifyCli(): Promise<CliProbe> {
    this.calls.push('verifyCli');
    if (this.calls.length === 1) {
      this.#reachedPreflight();
      await this.#heldPreflight;
    }
    return { available: true, version: '9.9.9 (Gated Engine)', authenticated: true };
  }

  async listModels(): Promise<ModelCatalog> {
    this.calls.push('listModels');
    return {
      models: [{ id: 'gated-1', label: 'Gated 1', origin: 'catalog' }],
      resolvedAt: new Date().toISOString(),
    };
  }

  async discoverMcpServers(): Promise<McpDiscovery> {
    this.calls.push('discoverMcpServers');
    return { servers: [], origin: 'file', resolvedAt: new Date().toISOString() };
  }

  async startSession(): Promise<string> {
    throw new Error('this adapter never opens a session');
  }

  async getStatus(): Promise<SessionStatus> {
    throw new Error('this adapter never opens a session');
  }

  async cancel(): Promise<void> {
    // Nothing has ever been started, so there is nothing to take down.
  }

  capabilities(): EngineCapabilities {
    return BASELINE_CAPABILITIES;
  }
}

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

/** The skill and the graph version a dispatching case of this file runs on. */
interface Crossing {
  /** The manifest every node of the graph is pinned to. */
  skill: { id: string; version: string; hash: string };
  /** The frozen version the jobs cite. */
  versionId: string;
}

/**
 * Registers the crossing skill and the two-engine graph, on one control plane.
 *
 * Extracted from the t162 block when t404 needed the same graph on a plane of
 * its own: the codex case of that ticket only means anything on a node that
 * DECLARES codex, and a class has one base lineage per project.
 *
 * The PROJECT is a parameter since t410, when `POST /v1/jobs` began refusing a
 * `graph_version_id` that resolves only in another project
 * (`409 cross_project_reference`). A job citing this version therefore has to be
 * created in the project the version was registered in, and t404's cases each
 * work in one of their own — so each of them registers the crossing into its
 * own partition. The version id is the same string every time and that is not a
 * collision: it is the hash of the document, which `POST /v1/graphs` strips the
 * scope out of before hashing, so one content hash legitimately exists once per
 * project (D25).
 *
 * @param plane The control plane to register into.
 * @param projectId Project to register into; omitted, the default one.
 * @returns The registered manifest and the graph version to cite.
 */
async function registerCrossing(
  plane: RunningControlPlane,
  projectId?: number,
): Promise<Crossing> {
  /** The scope, as a body field both routes read and then strip. */
  const scope = projectId === undefined ? {} : { project_id: projectId };
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
    { ...skillFixture(), ...scope },
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
        description: 'Closes the crossing. It exists so that `conferir` is not the final node.',
        skill_ref: { id: skill.id, version: skill.version, hash: skill.hash },
        contract: pinned[0].contract,
      },
    ],
    edges: [
      ...(fixture.edges as unknown[]),
      { from: CODEX_NODE, to: 'arquivar', condition: 'sempre', description: 'A single exit.' },
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
    { ...document, ...scope },
    201,
  );

  return { skill, versionId: version.id };
}

test('t162 — the packaged runner, against a real control plane', async (parent) => {
  const plane = await bootControlPlane(parent);
  const { skill, versionId } = await registerCrossing(plane);

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
    }, plane);

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
    const record = path.join(scratch, 'dispatch.json');
    t.after(async () => {
      await blockEveryJob(plane);
    });

    const job = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      { title: 'work the packaged runner dispatches', entry_node_id: DEFAULT_NODE, execution_id: 1629 },
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
    }, plane);

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
    const record = path.join(scratch, 'dispatch-codex.json');
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
        title: 'work on a node that declares codex',
        entry_node_id: CODEX_NODE,
        execution_id: 16210,
        graph_version_id: versionId,
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
    }, plane);

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
        title: 'work that asks for an engine this runner does not have',
        entry_node_id: CODEX_NODE,
        execution_id: 16211,
        graph_version_id: versionId,
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
    }, plane);

    const blocked = await api<Job>(plane, 'GET', `/v1/jobs/${poison.id}`);
    assert.match(
      blocked.block_reason ?? '',
      /codex/,
      `the reason a person reads has to name the engine with no route: ${blocked.block_reason}`,
    );

    // ...and it left BEFORE anything was spent, which is the whole point of
    // classifying pre-session: no session was ever opened for that execution.
    // Structural on purpose — it says what `no session was opened` says in the
    // reason, without pinning the exact sentence that says it.
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
      { title: 'work this runner knows how to dispatch', entry_node_id: DEFAULT_NODE, execution_id: 16212 },
      201,
    );

    await waitFor('the loop dispatching a later job after the failure', async () => {
      const { sessions: sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=16212',
      );
      return sessions.some((session) => session.status === 'completed');
    }, plane);

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
    // The number is measured, not guessed (t292), and re-measured when it went
    // red (t434). `took` is not pure shutdown latency: the loop awaits whatever
    // tick is in flight, and `runRunner` pairs, preflights and reports its
    // models before it ever parks, so an abort that lands during that startup
    // makes `took` the remainder of it.
    //
    // t292 measured that residue at 0-753ms across 16 runs. t401 then put an
    // MCP discovery on the same startup, and this file's fake engine answered
    // `--version` but not `mcp list` — so every runner here spawned the host's
    // REAL `claude`, which measured 1_840-2_530ms unloaded and 343-3_659ms
    // under contention, and ~5.5s on a machine at load 31 with swap exhausted,
    // which is where this case went red. `FAKE_MCP_LIST` is that gap closed;
    // the residue is a residue again.
    //
    // Re-measured on 2026-09-07, 8-core machine, this file alone: 0, 0, 1, 123,
    // 183, 234 and 442ms, the last two with the load average at 9.3 and 29.7 —
    // the same saturation the red report was taken under. 5_000ms is ~11x the
    // worst of those and ~1/4 of the ~19.7s the defect would cost, so no
    // scheduling hiccup reaches the bound and the defect cannot hide under it.
    // The bound is the same number t292 set: what changed is what it measures.
    // The earlier bound was `intervalMs / 2` — 1_000ms against a 753ms worst
    // case, which is how this became an intermittently red suite.
    const promptlyMs = 5_000;
    assert.ok(
      took < promptlyMs,
      `an idle stop took ${took}ms, past the ${promptlyMs}ms it is given: the shutdown is waiting the ${intervalMs}ms interval out instead of noticing the abort`,
    );
  });

  await parent.test('t434 AT1 — an abort during the startup skips the phases that had not started', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    // Plain directories, for AT12's reason: this runner never reaches a tick.
    const { repoRoot, worktreesRoot } = workspace(t, 't434-at1');

    const adapter = new GatedStartupAdapter();
    const announced: RunModule.ResolvedRunnerPaths[] = [];
    const aborter = new AbortController();

    const finished = runRunner({
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t434-at1',
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      // Never waited out, and never reached: the abort lands in the startup, so
      // a loop that parked at all would hang this case for a minute instead of
      // failing it in a way somebody has to read twice.
      intervalMs: 60_000,
      leaseTtlSeconds: 10,
      engineFactory: () => ({ adapter, decodeSessionText: decodeClaudeCodeSessionText }),
      onReady: (values) => announced.push(values),
      signal: aborter.signal,
    });

    // The abort lands while the model catalog's own preflight is still in
    // flight — the only moment that proves anything. A startup that checks
    // nothing between its phases goes on to the probe from here regardless of
    // the signal, and on a machine where that probe spawns a real CLI that is
    // seconds of work nobody asked for (t434: `claude mcp list` measured
    // 2_142ms on the developer's host).
    await adapter.atPreflight;
    aborter.abort();
    adapter.releasePreflight();

    await finished;

    // The phase in flight finishes — it is already spent, and abandoning it
    // mid-await would leave a report half-posted — and NOTHING after it starts.
    // `discoverMcpServers` is the tell: it belongs to `reportProbe`, the fourth
    // phase, which an abort-blind startup runs anyway.
    assert.deepEqual(
      adapter.calls,
      ['verifyCli', 'listModels'],
      'the startup ran a phase that began after the abort',
    );
    assert.deepEqual(
      announced,
      [],
      'a runner that never parked announced itself ready anyway',
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
      { title: 'work with a slow session', entry_node_id: DEFAULT_NODE, execution_id: 16213 },
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
    }, plane);

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
    const record = path.join(scratch, 'dispatch.json');
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
      { title: 'work that proves the worktree isolation', entry_node_id: DEFAULT_NODE, execution_id: 17_901 },
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
    }, plane);

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
    const newerText = `${pinnedText}\n\nAnd, since 1.1.0, write down what you did NOT do too.`;

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
          title: `crossing that proves the skill pin (${label})`,
          entry_node_id: DEFAULT_NODE,
          execution_id: executionId,
          graph_version_id: versionId,
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
      }, plane);

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

    const before = await dispatch('before', 21_501);
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

    const after = await dispatch('after', 21_502);
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
      // Three since t401, and the third one is not a duplicate to be
      // deduplicated: the probe REPORT is built from a fresh `verifyCli()`
      // because `verifyEngineCli` above throws the `CliProbe` away and keeps one
      // boolean, and a report assembled from that boolean would be inventing a
      // `version` and an `authenticated` it never saw. The call spends no quota.
      ['verifyCli', 'listModels', 'verifyCli'],
      'the startup path probes the CLI, asks it for a catalog, and probes again to report',
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

    // Read BEFORE the stop since t491: a runner that exits cleanly deregisters
    // itself, so `GET /v1/runners` after the stop answers "not present" for the
    // healthy case too — which is not what this assertion is about. Up, with
    // its probe having failed, is exactly the moment the claim is made about.
    assert.equal(
      await isPaired(runnerId),
      true,
      'a failed probe stopped the runner from being a runner at all',
    );

    await runner.stop();

    assert.equal(
      (await catalogs()).some((entry) => entry.engine === 'codex'),
      false,
      'the catalog went out although the CLI the models belong to never answered',
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

/* -------------------------------------------------------------------------- */
/* t332 — every runner process can run a `shell` node, whatever --engine says  */
/* -------------------------------------------------------------------------- */

/**
 * The engines map of a runner, built the way `runRunner` builds it.
 *
 * This is the one wiring claim of t332 and it does not need a control plane:
 * what FR9 decides is that `shell` is in the table unconditionally, beside
 * whichever agent CLI `--engine` selected, and the table is a pure function of
 * that flag. Booting a server to observe it would be measuring the loop instead
 * of the decision.
 *
 * The reason it is unconditional rather than a third `--engine` value: an
 * `UnknownEngineError` is a hard block that needs a human to clear
 * (`pre-session-failure.ts`), so a claude-code-only runner that won the lease of
 * a shell node would STOP the job rather than hand it back to a shell-capable
 * one. There is no credential and no preflight behind this adapter, so there is
 * nothing an opt-out would buy.
 */
test('t332 — the engines map always carries a shell route, on top of --engine', async () => {
  const { buildEngineRoutes, defaultEngineFactory, ENGINE_NAMES } =
    await loadModule<typeof RunModule>(RUN_MODULE);

  assert.deepEqual(
    [...ENGINE_NAMES],
    ['claude-code', 'codex'],
    '`shell` is not a value on the --engine axis: that flag says which agent CLI this ' +
      'process authenticates as, and this adapter authenticates as nobody',
  );

  for (const engine of ENGINE_NAMES) {
    const routes = buildEngineRoutes(engine, defaultEngineFactory);

    assert.deepEqual(
      Object.keys(routes).sort(),
      [engine, 'shell'].sort(),
      `--engine ${engine} has to route its own engine AND shell, and nothing else`,
    );
    assert.equal(
      routes[engine]?.adapter.engineName,
      engine,
      'the selected engine is still the one the factory built',
    );
    assert.equal(
      routes.shell?.adapter.engineName,
      'shell',
      'and the shell route is the shell adapter, never the agent one under another key',
    );
    assert.equal(
      typeof routes.shell?.decodeSessionText,
      'function',
      'a route without a decoder is a route whose output nobody can read',
    );
  }
});

test('t332 — the shell route is built here, never asked of the --engine factory', async () => {
  const { buildEngineRoutes } = await loadModule<typeof RunModule>(RUN_MODULE);

  // The suite's `engineFactory` seam exists to swap an agent CLI for the fake
  // engine, and it is typed for the two names `--engine` accepts. Asking it for
  // `shell` would push a third name through a seam every existing test wired for
  // two — and would make a runner's shell capability depend on whoever supplied
  // the factory.
  const asked: string[] = [];
  const routes = buildEngineRoutes('claude-code', (engine) => {
    asked.push(engine);
    return { adapter: new ClaudeCodeAdapter(), decodeSessionText: decodeClaudeCodeSessionText };
  });

  assert.deepEqual(asked, ['claude-code']);
  assert.equal(routes.shell?.adapter.engineName, 'shell');
});

/* -------------------------------------------------------------------------- */
/* t404 — the runner started with no path flags at all.                        */
/*                                                                            */
/* `runRunner` used to receive `repoRoot`, `worktreesRoot` and `engine` as     */
/* three always-defined values, resolved before the first packet. A runner     */
/* spawned by the one-command startup has none of them: it pairs, asks the     */
/* control plane for its project's settings (t403's `GET /v1/settings`) and    */
/* uses `workspace_root`/`worktrees_root`/`engine` from there.                 */
/*                                                                            */
/* A control plane of its own, and every case works under a project of its     */
/* own: the settings are per project, and the default project is the ONE the   */
/* control plane seeds at startup — with paths under the operator's home       */
/* directory, which is the last place a test may cut a worktree into.          */
/*                                                                            */
/* That project is DECLARED, through `POST /v1/projects`, and the id comes     */
/* back from the database (t410). These cases used to invent one — 74_047 and  */
/* its neighbours — which worked only for as long as nothing read the          */
/* partition: `GET /v1/settings` still answers for an id nobody declared, so    */
/* the settings half of each case never noticed, but the dispatch half polls    */
/* `GET /v1/jobs`, and that route answers `404 unknown_project` now. The        */
/* invented number was a premise, not a value, and it is the premise that is    */
/* replaced here — every assertion below is untouched.                          */
/* -------------------------------------------------------------------------- */

/** A control plane reached through a proxy that counts what went through it. */
interface ProxiedControlPlane extends RunningControlPlane {
  /** How many requests reached a route whose path starts with `prefix`. */
  countOf: (prefix: string) => number;
  /**
   * Makes the control plane unreachable from now on, without closing the
   * server: every request from here answers with a dead socket (t491, AT10).
   *
   * A flag and not a `close()`, because what AT10 needs is a plane that WAS
   * there — the runner has already paired through it — and is gone by the time
   * the shutdown tries to say goodbye.
   */
  sever: () => void;
}

/**
 * Puts a counting proxy in front of the control plane (t404, AT8/AT9).
 *
 * `runRunner` builds its own `ControlPlaneClient` out of the URL it was given
 * and has no `fetchImpl` seam of its own — deliberately: what a runner talks to
 * is an address, and adding a seam for one test would be a production field
 * nobody else uses. An address is a seam already, so this is one: the runner
 * dials the proxy, the proxy forwards everything to the real binary, and the
 * ledger of routes is what answers "was `GET /v1/settings` ever called".
 *
 * @param t Subtest hook, for the teardown.
 * @param plane The real control plane to forward to.
 * @param failOn Route prefix to answer with a dead socket instead of forwarding
 *   — what a network failure looks like from inside `fetch`: a rejection, never
 *   an HTTP status.
 * @returns The proxy's own address, the same credential, and the ledger.
 */
async function proxyControlPlane(
  t: TestHook,
  plane: RunningControlPlane,
  failOn?: string,
): Promise<ProxiedControlPlane> {
  const seen: string[] = [];
  let severed = false;

  const server = createServer((request, response) => {
    const route = request.url ?? '/';
    seen.push(route);

    if (severed || (failOn !== undefined && route.startsWith(failOn))) {
      request.socket.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      void (async () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          // `host` and the framing headers belong to THIS hop; forwarding them
          // would describe the proxy's own connection to the upstream one.
          if (name === 'host' || name === 'connection' || name === 'content-length') continue;
          if (typeof value === 'string') headers[name] = value;
        }

        const upstream = await fetch(`${plane.baseUrl}${route}`, {
          method: request.method,
          headers,
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
        });
        const text = await upstream.text();
        response.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        });
        response.end(text);
      })().catch(() => {
        response.destroy();
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    async () =>
      await new Promise<void>((resolve) => {
        // The client keeps its sockets alive, so `close` alone would wait for a
        // connection nobody is going to end.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );

  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    token: plane.token,
    countOf: (prefix) => seen.filter((route) => route.startsWith(prefix)).length,
    sever: () => {
      severed = true;
      server.closeAllConnections();
    },
  };
}

test('t404 — a runner with no paths of its own falls back to the control plane\'s settings', async (parent) => {
  const plane = await bootControlPlane(parent);

  /** Writes a project's settings, with the operator credential t405 will hand out. */
  const seedSettings = async (
    projectId: number,
    patch: Record<string, string>,
  ): Promise<void> => {
    await api(plane, 'PATCH', '/v1/settings', { project_id: projectId, ...patch });
  };

  await parent.test('AT7 — with nothing given, the paths and the engine come from the settings', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const projectId = await declareProject(plane, 't404-at7');
    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't404-at7');
    const record = path.join(scratch, 'dispatch.json');
    t.after(async () => {
      await blockEveryJob(plane, projectId);
    });

    await seedSettings(projectId, {
      workspace_root: repoRoot,
      worktrees_root: worktreesRoot,
      engine: 'claude-code',
    });

    const job = await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        title: 'work a runner with no flags of its own dispatches',
        project_id: projectId,
        entry_node_id: DEFAULT_NODE,
        execution_id: 74_071,
      },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId,
      runnerId: 'runner-t404-at7',
      // The whole of the case: not one of the three is known at startup.
      engine: undefined,
      repoRoot: undefined,
      worktreesRoot: undefined,
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
      const { sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        `/v1/sessions?execution_id=74071&project_id=${projectId}`,
      );
      return sessions.some((session) => session.status === 'completed');
    }, plane, projectId);

    await runner.stop();

    // The session's own account of where it ran: a worktree cut from the
    // repository the SETTINGS named, under the root the settings named.
    assert.ok(existsSync(record), 'the session never ran through the fake engine');
    const received = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };
    assert.ok(
      received.cwd.startsWith(worktreesRoot + path.sep),
      `the session ran outside the root the settings gave: ${received.cwd}`,
    );
    // ...and the repository it was cut FROM is the one `workspace_root` names:
    // the session's branch is `ticket-<job>`, and it outlives the worktree that
    // was removed on release. The cwd assertion above cannot say this on its
    // own — a worktree lands under `worktrees_root` whichever repository it
    // came from.
    assert.equal(
      git(repoRoot, 'branch', '--list', `ticket-${String(job.id)}`).includes(
        `ticket-${String(job.id)}`,
      ),
      true,
      'the worktree was cut from the repository `workspace_root` names',
    );

    // Scoped, like the `/v1/sessions` read above it: `GET /v1/executions/:id/events`
    // filters the log by project since t414, and this case's job lives in a
    // project it declared for itself. Unscoped, this reads the DEFAULT project's
    // log and finds nothing.
    const { events } = await api<{ events: Event[] }>(
      plane,
      'GET',
      `/v1/executions/74071/events?project_id=${String(projectId)}`,
    );
    const opened = events.filter((event) => event.type === 'session.opened');
    assert.ok(opened.length > 0, 'a session was opened for this execution');
    assert.deepEqual(
      [...new Set(opened.map((event) => event.data.engine))],
      ['claude-code'],
      'the engine the settings named is the engine the log records',
    );
  });

  await parent.test('AT8 — with both paths given, GET /v1/settings is never called at all', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const projectId = await declareProject(plane, 't404-at8');
    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't404-at8');
    const unused = initRepo(t, 't404-at8-unused');
    const record = path.join(scratch, 'dispatch.json');
    t.after(async () => {
      await blockEveryJob(plane, projectId);
    });

    // Seeded, and seeded with a DIFFERENT workspace: if the fetch happened and
    // its answer won, the session would run somewhere else entirely.
    await seedSettings(projectId, {
      workspace_root: unused.repoRoot,
      worktrees_root: unused.worktreesRoot,
      engine: 'codex',
    });

    const proxied = await proxyControlPlane(t, plane);

    await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        title: 'work a runner with explicit paths dispatches',
        project_id: projectId,
        entry_node_id: DEFAULT_NODE,
        execution_id: 74_081,
      },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: proxied.baseUrl,
      token: proxied.token,
      projectId,
      runnerId: 'runner-t404-at8',
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
      const { sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        `/v1/sessions?execution_id=74081&project_id=${projectId}`,
      );
      return sessions.some((session) => session.status === 'completed');
    }, plane, projectId);

    await runner.stop();

    assert.equal(
      proxied.countOf('/v1/settings'),
      0,
      'an operator who said where the worktrees go is not asked to confirm it over HTTP',
    );
    assert.ok(proxied.countOf('/v1/runners') > 0, 'the proxy really is the door this runner used');

    assert.ok(existsSync(record), 'the session never ran through the fake engine');
    const received = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string };
    assert.ok(
      received.cwd.startsWith(worktreesRoot + path.sep),
      `the session ran outside the explicit root: ${received.cwd}`,
    );
    assert.equal(
      received.cwd.startsWith(unused.worktreesRoot + path.sep),
      false,
      'the settings won over a path the operator gave on the command line',
    );
  });

  await parent.test('AT9 — settings that answer nothing are a SettingsFallbackError; a fetch that fails travels up', async (t) => {
    const { runRunner, SettingsFallbackError } = await loadModule<typeof RunModule>(RUN_MODULE);
    const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

    // A project declared and never SEEDED: `POST /v1/projects` writes no
    // settings row, so `GET /v1/settings` answers `{project_id}` alone, which is
    // a 200 carrying nothing this runner can start on. Declared like every
    // other case's (t410) even though this one never reaches the job board —
    // it fails resolving the settings, before the first poll — because "a
    // project that exists and holds no settings" is the case's real subject,
    // and an id nobody declared would confuse it with a different refusal.
    const unseeded = await declareProject(plane, 't404-at9-unseeded');

    await assert.rejects(
      async () =>
        await runRunner({
          url: plane.baseUrl,
          token: plane.token,
          projectId: unseeded,
          runnerId: 'runner-t404-at9-unseeded',
          engine: undefined,
          repoRoot: undefined,
          worktreesRoot: undefined,
          runnerCap: 1,
          projectCap: 4,
          intervalMs: 500,
          leaseTtlSeconds: 10,
          engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }),
        }),
      (error: unknown) => {
        assert.ok(
          error instanceof SettingsFallbackError,
          `a settings answer with nothing in it is its own failure: ${String(error)}`,
        );
        assert.match(error.message, /worktrees_root/, 'the message names the setting that was missing');
        assert.match(
          error.message,
          /no safe default/,
          'and says the same thing the missing-flag usage error says',
        );
        return true;
      },
    );

    // ...and a settings fetch that never answers is NOT that failure: it is the
    // network error it is, travelling up untouched — which `runRunnerCli` turns
    // into the exit 1 of its own table.
    const broken = await proxyControlPlane(t, plane, '/v1/settings');
    const stderr = captureStderr();
    let code: number;
    try {
      code = await runRunnerCli(
        [
          '--url',
          broken.baseUrl,
          '--token',
          broken.token,
          '--project',
          String(unseeded),
          '--runner-id',
          'runner-t404-at9-broken',
        ],
        {},
      );
    } finally {
      stderr.restore();
    }

    assert.equal(code, 1, 'a runner that could not run is a 1, never a 2');
    assert.ok(broken.countOf('/v1/runners') > 0, 'the pairing went through before the settings did not');
    assert.ok(broken.countOf('/v1/settings') > 0, 'and the settings really were asked for');
    assert.match(stderr.written(), new RegExp(broken.baseUrl.replace(/[.]/g, '\\.')));
  });

  await parent.test('AT10 — an explicit engine beats the one the settings hold', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const projectId = await declareProject(plane, 't404-at10');
    // Into THIS project, not the default one: since t410 `POST /v1/jobs`
    // refuses a `graph_version_id` that resolves only somewhere else
    // (`409 cross_project_reference`), and the job below cites this version.
    const { versionId } = await registerCrossing(plane, projectId);
    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't404-at10');
    const record = path.join(scratch, 'dispatch-codex.json');
    t.after(async () => {
      await blockEveryJob(plane, projectId);
    });

    await seedSettings(projectId, {
      workspace_root: repoRoot,
      worktrees_root: worktreesRoot,
      engine: 'claude-code',
    });

    // On the node that declares `codex`: had the settings' `claude-code` won,
    // this runner would have no route for it and would BLOCK the work with an
    // `UnknownEngineError` instead of completing a session.
    await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        title: 'work on a node that declares codex, run by a settings-mode runner',
        project_id: projectId,
        entry_node_id: CODEX_NODE,
        execution_id: 74_101,
        graph_version_id: versionId,
      },
      201,
    );

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId,
      runnerId: 'runner-t404-at10',
      engine: 'codex',
      repoRoot: undefined,
      worktreesRoot: undefined,
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
      const { sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        `/v1/sessions?execution_id=74101&project_id=${projectId}`,
      );
      return sessions.some((session) => session.status === 'completed');
    }, plane, projectId);

    await runner.stop();

    // Scoped for the same reason as AT7's read (t414).
    const { events } = await api<{ events: Event[] }>(
      plane,
      'GET',
      `/v1/executions/74101/events?project_id=${String(projectId)}`,
    );
    const opened = events.filter((event) => event.type === 'session.opened');
    assert.ok(opened.length > 0, 'a session was opened for this execution');
    assert.deepEqual(
      [...new Set(opened.map((event) => event.data.engine))],
      ['codex'],
      'the engine the flag named is the engine the log records',
    );
    assert.ok(existsSync(record), 'the codex route never started a session');
  });

  await parent.test('AT11 — settings with no engine key fall back on the default engine', async (t) => {
    const { runRunner, DEFAULT_ENGINE_NAME } = await loadModule<typeof RunModule>(RUN_MODULE);

    const projectId = await declareProject(plane, 't404-at11');
    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't404-at11');
    const record = path.join(scratch, 'dispatch.json');
    t.after(async () => {
      await blockEveryJob(plane, projectId);
    });

    // Two keys and not three: the safety net of FR5 is what has to answer here,
    // and an `engine` nobody set must not be a runner that refuses to start.
    await seedSettings(projectId, { workspace_root: repoRoot, worktrees_root: worktreesRoot });

    await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        title: 'work dispatched by a runner whose settings named no engine',
        project_id: projectId,
        entry_node_id: DEFAULT_NODE,
        execution_id: 74_111,
      },
      201,
    );

    let resolved: RunModule.ResolvedRunnerPaths | null = null;
    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId,
      runnerId: 'runner-t404-at11',
      engine: undefined,
      repoRoot: undefined,
      worktreesRoot: undefined,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 500,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({
        FAKE_ENGINE_LINES: QUIET_LINES,
        FAKE_ENGINE_RECORD: record,
      }),
      onReady: (values) => {
        resolved = values;
      },
    });

    await waitFor('the job being dispatched to completion', async () => {
      const { sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        `/v1/sessions?execution_id=74111&project_id=${projectId}`,
      );
      return sessions.some((session) => session.status === 'completed');
    }, plane, projectId);

    await runner.stop();

    assert.ok(resolved !== null, 'the runner never announced itself ready');
    assert.equal(
      (resolved as RunModule.ResolvedRunnerPaths).engine,
      DEFAULT_ENGINE_NAME,
      'no flag and no setting is the documented default, never an undefined engine',
    );

    assert.ok(existsSync(record), 'the session never ran through the fake engine');
    const received = JSON.parse(readFileSync(record, 'utf8')) as { argv: string[] };
    assert.equal(
      received.argv.includes('exec'),
      false,
      'the argv is claude-code\'s, not the one codex\'s builder produces',
    );
  });

  await parent.test('AT12 — onReady carries the resolved values, never the undefined ones', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    const projectId = await declareProject(plane, 't404-at12');
    // Plain directories: this case announces readiness and never dispatches.
    const { repoRoot, worktreesRoot } = workspace(t, 't404-at12');

    await seedSettings(projectId, {
      workspace_root: repoRoot,
      worktrees_root: worktreesRoot,
      engine: 'codex',
    });

    let resolved: RunModule.ResolvedRunnerPaths | null = null;
    let announce: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId,
      runnerId: 'runner-t404-at12',
      engine: undefined,
      repoRoot: undefined,
      worktreesRoot: undefined,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: fakeEngineFactory({ FAKE_ENGINE_LINES: QUIET_LINES }),
      onReady: (values) => {
        resolved = values;
        announce();
      },
    });

    await ready;
    await runner.stop();

    assert.deepEqual(
      resolved,
      { repoRoot, worktreesRoot, engine: 'codex' },
      'the ready announcement is what an operator reads to find out where this runner writes',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* t401 — the runner reports its probe, and answers a re-check request         */
/* -------------------------------------------------------------------------- */

/** One request the recording proxy saw, in the order it saw it. */
interface ProxiedCall {
  method: string;
  path: string;
  body: unknown;
}

/** A control plane the runner talks to, with a ledger of what it was told. */
interface RecordingPlane {
  baseUrl: string;
  token: string;
  calls: ProxiedCall[];
  /** Every call matching this method and path prefix, in order. */
  matching: (method: string, prefix: string) => ProxiedCall[];
}

/**
 * The real control plane behind a proxy that writes down every call.
 *
 * The rest of this file asserts against the STATE the control plane ends in,
 * and for most claims that is the stronger measurement. Two of t401's are not
 * about state: "exactly one probe, before the first tick" and "a quiet tick
 * produces no extra probe" are both statements about the sequence of requests,
 * and a stored row cannot tell one write from two. Hence a proxy rather than a
 * fake: the answers are the real binary's, and what is added is the ledger.
 *
 * `fail` is the other half, and it exists for one case only (AT21): a route
 * that answers `500` without the request ever reaching the control plane, which
 * is how a refusal is measured without teaching the real server to refuse.
 *
 * @param t Test context, used to close the proxy.
 * @param plane The real control plane to forward to.
 * @param fail Answers `500` for the calls it returns `true` for.
 */
async function recordingProxy(
  t: TestHook,
  plane: RunningControlPlane,
  fail: (method: string, routePath: string) => boolean = () => false,
): Promise<RecordingPlane> {
  const calls: ProxiedCall[] = [];

  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const method = incoming.method ?? 'GET';
        const routePath = incoming.url ?? '/';
        calls.push({
          method,
          path: routePath,
          body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
        });

        if (fail(method, routePath)) {
          outgoing.writeHead(500, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'proxy_refused', message: 'AT21 refuses this route' }));
          return;
        }

        const headers: Record<string, string> = {};
        const authorization = incoming.headers.authorization;
        if (authorization !== undefined) headers.authorization = authorization;
        if (raw !== '') headers['content-type'] = 'application/json';

        try {
          const answer = await fetch(`${plane.baseUrl}${routePath}`, {
            method,
            headers,
            body: raw === '' ? undefined : raw,
          });
          const text = await answer.text();
          outgoing.writeHead(answer.status, { 'content-type': 'application/json' });
          outgoing.end(text);
        } catch (error) {
          outgoing.writeHead(502, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: 'proxy_failed', message: String(error) }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the proxy did not take a port');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: plane.token,
    calls,
    matching: (method, prefix) =>
      calls.filter((entry) => entry.method === method && entry.path.startsWith(prefix)),
  };
}

/** The report body, as the runner posts it. */
interface PostedProbe {
  cli: { available: boolean; version: string | null; authenticated: boolean };
  mcp: Record<string, unknown>;
  workspace: Record<string, unknown>;
}

/**
 * An adapter with a probe and NOTHING optional on it.
 *
 * Neither `listModels` nor `discoverMcpServers`, and the second absence is what
 * AT19 measures: an adapter that never implemented MCP discovery has to be
 * reported as `{supported: false}` and never as an engine that found zero
 * servers. Written out rather than wrapped around a real adapter, because
 * "the method is not there" is exactly the fact under test and a wrapper that
 * forwards it would put it back.
 */
class ProbeOnlyAdapter implements EngineAdapter {
  readonly engineName = 'claude-code';
  readonly #probe: CliProbe;

  constructor(probe: CliProbe) {
    this.#probe = probe;
  }

  async startSession(): Promise<string> {
    throw new Error('this adapter never opens a session');
  }

  async getStatus(): Promise<SessionStatus> {
    throw new Error('this adapter never opens a session');
  }

  async cancel(): Promise<void> {
    // Nothing has ever been started, so there is nothing to take down.
  }

  capabilities(): EngineCapabilities {
    return BASELINE_CAPABILITIES;
  }

  async verifyCli(): Promise<CliProbe> {
    return this.#probe;
  }
}

/**
 * What an operator sees, and what a machine reports about itself (t401).
 *
 * The ticket's own summary of the gap: `GET /v1/runners` answered pairing and
 * lease health and said nothing about whether the paired machine can actually
 * run a session. What these cases pin is the reporting path — the probe goes out
 * once at startup, whatever it found, and again whenever an operator asks for a
 * re-check — plus the workspace facts the report carries, which are the only
 * part of it computed here rather than by an adapter.
 *
 * Two things are deliberately NOT asserted. That a `false` fact stops anything:
 * this is discovery on the same terms `listModels`/`discoverMcpServers` already
 * are, never enforcement. And that a refused report stops the runner: AT21
 * measures the opposite, on the identical reasoning t186's AT2 already wrote
 * down for the model catalog.
 */
test('t401 — the runner reports its probe, and answers a re-check request', async (parent) => {
  const plane = await bootControlPlane(parent);

  await parent.test('AT17 — exactly one probe goes out, after the catalog and before the first tick', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const recorder = await recordingProxy(t, plane);
    const { repoRoot, worktreesRoot } = initRepo(t, 't401-at17');
    const runnerId = 'runner-t401-at17';

    const runner = await startRunner(t, runRunner, {
      url: recorder.baseUrl,
      token: recorder.token,
      projectId: 1,
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

    // Three ticks' worth of loop, so "exactly one" is a claim about a running
    // runner rather than about one that never got past its startup.
    await waitFor(
      'the runner ticked at least three times',
      async () => Promise.resolve(recorder.matching('GET', '/v1/jobs').length >= 3),
      plane,
    );
    await runner.stop();

    const probes = recorder.matching('POST', `/v1/runners/${runnerId}/probes`);
    assert.equal(probes.length, 1, 'the startup report goes out once, not once per tick');

    const order = recorder.calls.map((call) => `${call.method} ${call.path}`);
    const probeAt = order.indexOf(`POST /v1/runners/${runnerId}/probes`);
    // A PREFIX and not the whole line: the poll carries `?project_id=` since
    // t410, and the first tick is still the first tick.
    const firstTickAt = order.findIndex((entry) => entry.startsWith('GET /v1/jobs'));
    assert.ok(probeAt >= 0 && firstTickAt >= 0, order.join('\n'));
    assert.ok(
      probeAt < firstTickAt,
      `the probe has to be out before the loop starts spending: ${order.join(' | ')}`,
    );
    assert.ok(
      order.indexOf('POST /v1/engines/claude-code/models') < probeAt,
      'and after the model catalog, which is where FR7 puts it',
    );

    const posted = probes[0]?.body as PostedProbe;
    assert.deepEqual(
      posted.workspace,
      {
        working_dir: repoRoot,
        working_dir_resolved: repoRoot,
        is_git_repo: true,
        worktrees_root: worktreesRoot,
        worktrees_root_resolved: worktreesRoot,
        worktrees_root_exists: false,
        worktrees_root_writable: true,
      },
      'the facts are about the REAL directories this runner was pointed at',
    );
  });

  await parent.test('AT18 — a CLI that did not answer is still reported, unlike the catalog', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const recorder = await recordingProxy(t, plane);
    const { repoRoot, worktreesRoot } = workspace(t, 't401-at18');
    const runnerId = 'runner-t401-at18';

    // The skip of t186's AT2 travels to stderr, and letting it through would
    // read as the suite itself breaking.
    const logged: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    t.after(() => {
      process.stderr.write = original;
    });

    const runner = await startRunner(t, runRunner, {
      url: recorder.baseUrl,
      token: recorder.token,
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
    });

    await waitFor(
      'the probe went out',
      async () =>
        Promise.resolve(recorder.matching('POST', `/v1/runners/${runnerId}/probes`).length === 1),
      plane,
    );
    await runner.stop();

    const posted = recorder.matching('POST', `/v1/runners/${runnerId}/probes`)[0]
      ?.body as PostedProbe;
    assert.equal(
      posted.cli.available,
      false,
      'reporting that the CLI is not there IS the fact worth telling an operator',
    );
    assert.equal(
      recorder.matching('POST', '/v1/engines/').length,
      0,
      'while the model catalog is skipped for that same answer — the asymmetry is the point',
    );
    assert.ok(
      logged.some((line) => line.includes('codex')),
      `t186's own skip still has to be legible: ${JSON.stringify(logged)}`,
    );
  });

  await parent.test('AT19 — an adapter with no discoverMcpServers reports `{supported: false}`', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const recorder = await recordingProxy(t, plane);
    const { repoRoot, worktreesRoot } = workspace(t, 't401-at19');
    const runnerId = 'runner-t401-at19';

    const runner = await startRunner(t, runRunner, {
      url: recorder.baseUrl,
      token: recorder.token,
      projectId: 1,
      runnerId,
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: () => ({
        adapter: new ProbeOnlyAdapter({ available: true, version: '9.9.9', authenticated: true }),
        decodeSessionText: decodeClaudeCodeSessionText,
      }),
    });

    await waitFor(
      'the probe went out',
      async () =>
        Promise.resolve(recorder.matching('POST', `/v1/runners/${runnerId}/probes`).length === 1),
      plane,
    );
    await runner.stop();

    const posted = recorder.matching('POST', `/v1/runners/${runnerId}/probes`)[0]
      ?.body as PostedProbe;
    assert.deepEqual(
      posted.mcp,
      { supported: false },
      'an absent capability and an empty list are different facts (`engine/types.ts`)',
    );
  });

  await parent.test('AT20 — a pending re-check produces a second probe; a quiet tick produces none', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const recorder = await recordingProxy(t, plane);
    const { repoRoot, worktreesRoot } = workspace(t, 't401-at20');
    const runnerId = 'runner-t401-at20';

    const runner = await startRunner(t, runRunner, {
      url: recorder.baseUrl,
      token: recorder.token,
      projectId: 1,
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

    const probes = (): number => recorder.matching('POST', `/v1/runners/${runnerId}/probes`).length;

    // Several quiet loops first: the re-check is asked for on every iteration,
    // and every one of those answers `null`.
    await waitFor(
      'the runner asked about a re-check at least three times',
      async () =>
        Promise.resolve(recorder.matching('GET', `/v1/runners/${runnerId}/rechecks`).length >= 3),
      plane,
    );
    assert.equal(probes(), 1, 'nothing pending, nothing else happens');

    await api(plane, 'POST', `/v1/runners/${runnerId}/rechecks`, undefined, 201);

    await waitFor('the re-check produced a second probe', async () => Promise.resolve(probes() >= 2), plane);

    // ...and it is served by that report, so the loops that follow go quiet
    // again instead of re-probing forever.
    const afterServing = probes();
    await delay(700);
    await runner.stop();
    assert.equal(probes(), afterServing, 'one request, one extra probe — never a loop that keeps going');
  });

  await parent.test('AT21 — a 500 from either call is written down and the loop keeps turning', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const runnerId = 'runner-t401-at21';
    const recorder = await recordingProxy(
      t,
      plane,
      (_method, routePath) => routePath.startsWith(`/v1/runners/${runnerId}/`),
    );
    const { repoRoot, worktreesRoot } = workspace(t, 't401-at21');

    const logged: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    t.after(() => {
      process.stderr.write = original;
    });

    const runner = await startRunner(t, runRunner, {
      url: recorder.baseUrl,
      token: recorder.token,
      projectId: 1,
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

    // Both counters, and not just the tick's: the re-check poll sits AFTER the
    // loop's stop check, so a runner that has ticked three times has asked
    // about a re-check either three times or twice. Waiting on the number this
    // case actually asserts is what keeps it off that boundary.
    await waitFor(
      'the loop went on turning through the refusals',
      async () =>
        Promise.resolve(
          recorder.matching('GET', '/v1/jobs').length >= 3 &&
            recorder.matching('GET', `/v1/runners/${runnerId}/rechecks`).length >= 3,
        ),
      plane,
    );

    // The whole claim of the case: this resolves. A soft failure that threw out
    // of `runRunner` would leave this hanging until the file's own deadline.
    await runner.stop();

    assert.ok(
      recorder.matching('POST', `/v1/runners/${runnerId}/probes`).length >= 1,
      'the report was attempted, and refused',
    );
    assert.ok(
      recorder.matching('GET', `/v1/runners/${runnerId}/rechecks`).length >= 3,
      'and the re-check check went on being asked, refusal after refusal',
    );
    assert.ok(
      logged.some((line) => line.includes('500')),
      `a silent refusal leaves an operator with no way to learn why: ${JSON.stringify(logged)}`,
    );
  });

  await parent.test('AT22 — is_git_repo tells a real checkout from a plain directory', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);

    /** Starts one runner and gives back the workspace facts it reported. */
    const factsOf = async (
      label: string,
      space: { repoRoot: string; worktreesRoot: string },
    ): Promise<Record<string, unknown>> => {
      const recorder = await recordingProxy(t, plane);
      const runnerId = `runner-t401-${label}`;
      const runner = await startRunner(t, runRunner, {
        url: recorder.baseUrl,
        token: recorder.token,
        projectId: 1,
        runnerId,
        engine: 'claude-code',
        repoRoot: space.repoRoot,
        worktreesRoot: space.worktreesRoot,
        runnerCap: 1,
        projectCap: 4,
        intervalMs: 200,
        leaseTtlSeconds: 10,
        engineFactory: () => ({
          adapter: new ProbeOnlyAdapter({ available: true, version: '9.9.9', authenticated: true }),
          decodeSessionText: decodeClaudeCodeSessionText,
        }),
      });

      await waitFor(
        `${label} reported its probe`,
        async () =>
          Promise.resolve(recorder.matching('POST', `/v1/runners/${runnerId}/probes`).length === 1),
        plane,
      );
      await runner.stop();

      return (recorder.matching('POST', `/v1/runners/${runnerId}/probes`)[0]?.body as PostedProbe)
        .workspace;
    };

    const inRepo = await factsOf('at22-repo', initRepo(t, 't401-at22-repo'));
    assert.equal(inRepo.is_git_repo, true, 'a real checkout answers `true`');

    const plain = await factsOf('at22-plain', workspace(t, 't401-at22-plain'));
    assert.equal(
      plain.is_git_repo,
      false,
      'a directory with no `.git` is `false` and never a thrown spawn error',
    );
  });

  await parent.test('AT23 — a worktrees root that does not exist yet resolves without throwing', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const recorder = await recordingProxy(t, plane);
    const space = initRepo(t, 't401-at23');
    const runnerId = 'runner-t401-at23';

    // Three levels of nothing: the walk up has to pass two absent directories
    // before it reaches the temp base that really exists and really is writable.
    const worktreesRoot = path.join(space.scratch, 'not', 'here', 'yet', 'worktrees');
    assert.equal(existsSync(worktreesRoot), false, 'the fixture starts with the root absent');

    const runner = await startRunner(t, runRunner, {
      url: recorder.baseUrl,
      token: recorder.token,
      projectId: 1,
      runnerId,
      engine: 'claude-code',
      repoRoot: space.repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory: () => ({
        adapter: new ProbeOnlyAdapter({ available: true, version: '9.9.9', authenticated: true }),
        decodeSessionText: decodeClaudeCodeSessionText,
      }),
    });

    await waitFor(
      'the probe went out',
      async () =>
        Promise.resolve(recorder.matching('POST', `/v1/runners/${runnerId}/probes`).length === 1),
      plane,
    );
    await runner.stop();

    const facts = (recorder.matching('POST', `/v1/runners/${runnerId}/probes`)[0]?.body as PostedProbe)
      .workspace;
    assert.equal(facts.worktrees_root_resolved, worktreesRoot);
    assert.equal(facts.worktrees_root_exists, false, 'lazily created is an ordinary state, not an error');
    assert.equal(
      facts.worktrees_root_writable,
      true,
      'the walk up found the temp base, which this process can write in',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* One discovery per process, threaded into the session's input (t360, FR4)   */
/* -------------------------------------------------------------------------- */

/**
 * The map the interview draws needs to know which steps reach OUTSIDE, and
 * through which MCP server (RF-20). That fact is the machine's, not the graph's
 * — the same class of value as the test bench's path — so it travels through the
 * executor-environment seam, and this case pins the one thing that could
 * silently go wrong there: the runner discovering twice.
 *
 * t401 already made the startup probe call `discoverMcpServers()` once. Building
 * a second resolver that called it again per dispatch would spend one CLI spawn
 * per session for an answer that cannot have changed inside a process, and would
 * let the operator page and the interview disagree about the same machine. So
 * the probe's own discovery is THREADED into the resolver, and what this case
 * measures is exactly that: the `mcp list` command runs once, and its answer is
 * what the dispatched session was told.
 */
test('t360 AT4 — the MCP discovery is made once, and it is what the session reads', async (parent) => {
  const plane = await bootControlPlane(parent);

  await parent.test('AT4 — one `mcp list` per process, and the session gets its answer', async (t) => {
    const { runRunner } = await loadModule<typeof RunModule>(RUN_MODULE);
    const { repoRoot, worktreesRoot, scratch } = initRepo(t, 't360-at4');
    const record = path.join(scratch, 'interview-dispatch.json');
    t.after(async () => {
      await blockEveryJob(plane);
    });

    // A manifest that DECLARES `environment`: `render-input-values.ts` renders
    // the keys the skill's `input` names, so declaring it is what makes the
    // discovery reach the prompt at all. Not `required`, deliberately — a runner
    // with no environment configured must still dispatch this node.
    const manifest: Record<string, unknown> = {
      ...skillFixture(),
      id: 'read-the-environment',
      version: '1.0.0',
      input: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['job'],
        properties: { job: { type: 'object' }, environment: { type: 'object' } },
      },
    };
    manifest.hash = manifestContentHash(manifest);
    const skill = await api<{ id: string; version: string; hash: string }>(
      plane,
      'POST',
      '/v1/skills',
      manifest,
      201,
    );

    const document = JSON.parse(readFileSync(GRAPH_FIXTURE, 'utf8')) as Record<string, unknown>;
    document.problem_class = 'reads-the-environment';
    document.nodes = (document.nodes as Record<string, unknown>[]).map((node) => ({
      ...node,
      // One engine for the whole document: this case is about the environment,
      // and a codex node would need a second route for nothing.
      engine: 'claude-code',
      skill_ref: { id: skill.id, version: skill.version, hash: skill.hash },
    }));
    const { graph_version: version } = await api<{ graph_version: { id: string } }>(
      plane,
      'POST',
      '/v1/graphs',
      document,
      201,
    );

    /** Every `claude mcp list` this process issues, counted. */
    let discoveries = 0;
    const engineFactory = (): EngineRoute => ({
      adapter: new ClaudeCodeAdapter({
        commandBuilder: (spec) => ({
          command: process.execPath,
          args: [FAKE_ENGINE, ...buildCommand(spec).args],
        }),
        environmentBuilder: (spec) => ({
          ...buildEnvironment(spec),
          FAKE_ENGINE_LINES: QUIET_LINES,
          FAKE_ENGINE_RECORD: record,
        }),
        graceMs: 300,
        probeCommandBuilder: () => ({
          command: process.execPath,
          args: [FAKE_ENGINE, '--version'],
        }),
        mcpListCommandBuilder: () => {
          discoveries += 1;
          return { command: process.execPath, args: [FAKE_ENGINE, 'mcp', 'list'] };
        },
        probeEnvironment: {
          ...process.env,
          FAKE_ENGINE_MCP_LIST: 'flowpilot: http://127.0.0.1:9/mcp - connected\n',
        },
      }),
      decodeSessionText: decodeClaudeCodeSessionText,
    });

    const runner = await startRunner(t, runRunner, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      runnerId: 'runner-t360-at4',
      engine: 'claude-code',
      repoRoot,
      worktreesRoot,
      runnerCap: 1,
      projectCap: 4,
      intervalMs: 200,
      leaseTtlSeconds: 10,
      engineFactory,
    });

    await api<Job>(
      plane,
      'POST',
      '/v1/jobs',
      {
        title: 'a job whose node reads what this machine can reach',
        entry_node_id: DEFAULT_NODE,
        execution_id: 3_604,
        graph_version_id: version.id,
      },
      201,
    );

    await waitFor('the job being dispatched to completion', async () => {
      const { sessions } = await api<{ sessions: Session[] }>(
        plane,
        'GET',
        '/v1/sessions?execution_id=3604',
      );
      return sessions.some((session) => session.status === 'completed');
    }, plane);

    await runner.stop();

    assert.equal(
      discoveries,
      1,
      'the discovery the probe report already made is the one the dispatch reuses: a second ' +
        'CLI spawn per session would spend quota on an answer that cannot have changed',
    );

    assert.ok(existsSync(record), 'the session never ran through the fake engine');
    const received = JSON.parse(readFileSync(record, 'utf8')) as {
      argv: string[];
      files: Record<string, string>;
    };
    const prompt = [...received.argv, ...Object.values(received.files)].join('\n');
    assert.ok(
      prompt.includes('mcp_servers'),
      'the executor environment reached the session at `input.environment`',
    );
    assert.ok(
      prompt.includes('flowpilot'),
      `the server the ONE discovery found is what the session was told: ${prompt.slice(0, 400)}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* t491 — one row per installation: the identity outlives the process, and the  */
/* process says goodbye on the way out.                                        */
/* -------------------------------------------------------------------------- */

/**
 * The packaged command, spawned the way an operator starts it.
 *
 * The two cases below are about what a PROCESS does — the identity it derives
 * from its own working directory, and the call it makes while a SIGTERM is
 * being handled — and neither survives the in-process `startRunner` above: the
 * signal handlers live in `runRunnerCli`, and `process.cwd()` in this test
 * process is the runner package, not a checkout of the founder's.
 */
const RUNNER_BIN = path.join(PACKAGE_ROOT, 'bin', 'cartografo-runner.mjs');

/** The readiness line the runner announces on stdout (`cli/index.ts`). */
const RUNNER_READY_EVENT = 'cartografo.runner.ready';

/** A spawned runner, and the two things these cases do with one. */
interface SpawnedRunner {
  /** The identity it announced on its readiness line. */
  runnerId: string;
  /** Its pid, which is what the old default used to derive that identity from. */
  pid: number;
  /** SIGTERMs it and resolves with the exit code, once it is really gone. */
  stop: () => Promise<number | null>;
  /** Everything it has written on stderr so far. */
  err: () => string;
}

/**
 * Starts the packaged runner against a control plane and waits for it to pair.
 *
 * @param t Subtest hook, for the teardown `spawnWatched` registers.
 * @param plane Control plane to dial.
 * @param space The checkout it runs in — its cwd AND its `--working-dir`, so
 *   that the identity it derives is the one this case can predict.
 */
async function spawnRunner(
  t: TestHook,
  plane: RunningControlPlane,
  space: Workspace,
): Promise<SpawnedRunner> {
  const watched = spawnWatched(
    t,
    [
      RUNNER_BIN,
      '--url', plane.baseUrl,
      '--token', plane.token,
      '--working-dir', space.repoRoot,
      '--worktrees-root', space.worktreesRoot,
      '--interval-ms', '250',
    ],
    { cwd: space.repoRoot, env: process.env },
  );

  const ready = await awaitReadiness(watched, RUNNER_READY_EVENT);
  assert.equal(
    typeof ready.runnerId,
    'string',
    `the readiness line carries no runnerId: ${JSON.stringify(ready)}`,
  );

  const stop = async (): Promise<number | null> => {
    if (watched.child.exitCode === null && watched.child.signalCode === null) {
      watched.child.kill('SIGTERM');
    }
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      if (watched.child.exitCode !== null || watched.child.signalCode !== null) {
        return watched.child.exitCode;
      }
      await delay(50);
    }
    throw new Error(`the runner did not exit after SIGTERM\nstderr:\n${watched.err()}`);
  };

  return {
    runnerId: ready.runnerId as string,
    pid: watched.child.pid ?? 0,
    stop,
    err: () => watched.err(),
  };
}

/** The ids `GET /v1/runners` reports as present right now. */
async function presentRunners(plane: RunningControlPlane): Promise<string[]> {
  const { runners } = await api<{ runners: Array<{ id: string }> }>(plane, 'GET', '/v1/runners');
  return runners.map((runner) => runner.id).sort();
}

/**
 * Does a `runner` row with this id exist at all — retired or not?
 *
 * Read through `POST /v1/runners/:id/probes`, which answers `404 unknown_runner`
 * for an id nobody ever paired and refuses the (empty) body of an id that
 * exists. It is an existence oracle and not a listing on purpose: the API has
 * no route that reports retired rows, and this package may not open the
 * database to count them — `scripts/check-single-writer.mjs` forbids the driver
 * to everything outside `packages/core/src/db` (D1), tests included.
 */
async function runnerRowExists(plane: RunningControlPlane, id: string): Promise<boolean> {
  const response = await fetch(`${plane.baseUrl}/v1/runners/${id}/probes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${plane.token}` },
  });
  assert.ok(
    response.status === 404 || response.status === 400,
    `the existence oracle only reads 404/400, got ${response.status}: ${await response.text()}`,
  );
  return response.status !== 404;
}

test('t491 AT8 — three restarts of one checkout are one runner, present only while it runs', async (t) => {
  const plane = await bootControlPlane(t);
  const space = initRepo(t, 't491-at8');

  const identities = new Set<string>();
  const pids: number[] = [];

  for (const cycle of [1, 2, 3]) {
    const runner = await spawnRunner(t, plane, space);
    identities.add(runner.runnerId);
    pids.push(runner.pid);

    assert.deepEqual(
      await presentRunners(plane),
      [runner.runnerId],
      `cycle ${String(cycle)}: exactly one machine is up, and it is this one`,
    );

    assert.equal(await runner.stop(), 0, `cycle ${String(cycle)}: a stop is a clean exit`);
    assert.deepEqual(
      await presentRunners(plane),
      [],
      `cycle ${String(cycle)}: a runner that exited cleanly deregistered itself`,
    );
  }

  assert.equal(
    identities.size,
    1,
    `three restarts of one checkout declared ${String(identities.size)} identities: ${[...identities].join(', ')}`,
  );

  // ...and the row count really is one, proven the only way this package may:
  // the one id that exists is the stable one, and none of the three pids the
  // old default would have derived an identity from was ever paired.
  assert.ok(
    await runnerRowExists(plane, [...identities][0]),
    'the stable identity is a row, retired but never deleted',
  );
  for (const pid of pids) {
    assert.equal(
      await runnerRowExists(plane, `${hostname()}-${String(pid)}`),
      false,
      `a row shaped like the old default (host + pid ${String(pid)}) was written: identity is still per process`,
    );
  }
});

test('t491 AT10 — a control plane that is gone at shutdown costs one stderr line, not the exit code', async (t) => {
  const plane = await bootControlPlane(t);
  const proxy = await proxyControlPlane(t, plane);
  const space = initRepo(t, 't491-at10');

  const runner = await spawnRunner(t, proxy, space);
  assert.deepEqual(await presentRunners(plane), [runner.runnerId], 'it paired through the proxy');

  // The control plane becomes unreachable — a dead socket, which is what a
  // machine that went away looks like from inside `fetch`, never an HTTP status.
  proxy.sever();

  assert.equal(
    await runner.stop(),
    0,
    'a goodbye nobody was there to hear does not turn a clean stop into a failure',
  );

  const complained = runner
    .err()
    .split('\n')
    .filter((line) => line.includes('deregister'));
  assert.equal(
    complained.length,
    1,
    `one actionable line about the deregistration, and only one:\n${runner.err()}`,
  );
  assert.match(
    complained[0],
    new RegExp(`cartografo-runner: .*${runner.runnerId}`),
    'the line names the runner that could not say goodbye',
  );
});
