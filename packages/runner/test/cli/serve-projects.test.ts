/**
 * Acceptance tests of one runner process serving several projects (t1112,
 * AT14–AT23).
 *
 * No network: the control plane is a fake `ControlPlaneClient` that records
 * every call and answers what the case scripts, the clock is injected, and the
 * engines are fake adapters that count what they are asked. Every lease request
 * is refused with `job_already_leased`, so no dispatch ever opens a session:
 * what is under test is which project is polled, leased, resolved, skipped and
 * reported, never what a session does.
 *
 * Each case stops the runner from the fake's heartbeat (one per loop turn), so
 * the number of passes is decided by the case and not by a stopwatch.
 *
 * English only.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as CliModule from '../../src/cli/index.ts';
import type * as RunModule from '../../src/cli/run.ts';
import type * as ServeModule from '../../src/cli/serve-projects.ts';
import {
  ControlPlaneClientError,
  type ControlPlaneClient,
  type Job,
  type LeaseGrantResponse,
  type LeaseRequest,
  type ProbeReport,
  type Settings,
} from '../../src/controller/control-plane-client.ts';
import type { EngineRoute } from '../../src/dispatch/dispatch.ts';
import { decodeShellSessionText } from '../../src/dispatch/session-text.ts';
import {
  BASELINE_CAPABILITIES,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
  type McpDiscovery,
  type ModelCatalog,
  type SessionStatus,
} from '../../src/engine/types.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVE_MODULE = 'src/cli/serve-projects.ts';
const CLI_MODULE = 'src/cli/index.ts';

const SOME_URL = 'http://127.0.0.1:4317';
const RUNNER_ID = 'runner-t1112';

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** The repository and worktrees root a fake project's settings name. */
function pathsOf(projectId: number): { workspace_root: string; worktrees_root: string } {
  const base = path.join(tmpdir(), `cartografo-t1112-project-${String(projectId)}`);
  return { workspace_root: base, worktrees_root: `${base}-worktrees` };
}

/** Settings of a project that is fully configured. */
function configured(projectId: number, engine = 'claude-code'): Settings {
  return { project_id: projectId, ...pathsOf(projectId), engine };
}

/** A released job of a project, in the shape `GET /v1/jobs` answers. */
function releasedJob(id: number): Job {
  return {
    id,
    title: `job ${String(id)}`,
    current_node_id: 'redigir',
    blocked: false,
    completed: false,
    execution_id: id,
    graph_version_id: null,
  } as unknown as Job;
}

/** One call the fake control plane received. */
interface Call {
  method: string;
  args: unknown[];
}

/**
 * A fake control plane, in the shape `ControlPlaneClient` exposes.
 *
 * `settings` and `listings` are read on every call, so a case may change them
 * between passes. `onHeartbeat` runs after each loop turn's heartbeat, which is
 * where a case advances the clock or stops the runner.
 */
class FakePlane {
  readonly calls: Call[] = [];
  readonly settings = new Map<number, Settings | Error>();
  readonly jobs = new Map<number, Job[]>();
  /** Answer of each `listProjects` call, in order; the last one repeats. */
  listings: Array<number[] | Error> = [];
  onHeartbeat: (turn: number) => void = () => undefined;
  #registrations = 0;
  #listingCalls = 0;

  of(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  async registerRunner(id: string): Promise<unknown> {
    this.calls.push({ method: 'registerRunner', args: [id] });
    this.#registrations += 1;
    if (this.#registrations > 1) this.onHeartbeat(this.#registrations - 1);
    return { id, name: null };
  }

  async deregisterRunner(id: string): Promise<unknown> {
    this.calls.push({ method: 'deregisterRunner', args: [id] });
    return { id };
  }

  async listProjects(): Promise<Array<{ id: number; name: string; created_at: string }>> {
    this.calls.push({ method: 'listProjects', args: [] });
    const index = Math.min(this.#listingCalls, this.listings.length - 1);
    this.#listingCalls += 1;
    const answer = this.listings[index];
    if (answer instanceof Error) throw answer;
    return answer.map((id) => ({ id, name: `project-${String(id)}`, created_at: '2026-11-13T00:00:00Z' }));
  }

  async getSettings(projectId: number): Promise<Settings> {
    this.calls.push({ method: 'getSettings', args: [projectId] });
    const answer = this.settings.get(projectId) ?? { project_id: projectId };
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async listJobs(projectId?: number): Promise<Job[]> {
    this.calls.push({ method: 'listJobs', args: [projectId] });
    return this.jobs.get(projectId ?? 1) ?? [];
  }

  async listReleasedJobs(projectId?: number): Promise<Job[]> {
    this.calls.push({ method: 'listReleasedJobs', args: [projectId] });
    return this.jobs.get(projectId ?? 1) ?? [];
  }

  async requestLease(request: LeaseRequest): Promise<LeaseGrantResponse> {
    this.calls.push({ method: 'requestLease', args: [request] });
    return { lease: null, reason: 'job_already_leased' };
  }

  async reportEngineModels(engine: string, models: unknown): Promise<unknown> {
    this.calls.push({ method: 'reportEngineModels', args: [engine, models] });
    return {};
  }

  async reportProbe(runnerId: string, report: ProbeReport): Promise<unknown> {
    this.calls.push({ method: 'reportProbe', args: [runnerId, report] });
    return report;
  }

  async getPendingRecheck(runnerId: string): Promise<null> {
    this.calls.push({ method: 'getPendingRecheck', args: [runnerId] });
    return null;
  }

  asClient(): ControlPlaneClient {
    return this as unknown as ControlPlaneClient;
  }
}

/** A fake engine that counts every startup question it is asked. */
class CountingAdapter implements EngineAdapter {
  readonly engineName: string;
  verifyCliCalls = 0;
  listModelsCalls = 0;
  discoverCalls = 0;

  constructor(engineName: string) {
    this.engineName = engineName;
  }

  async verifyCli(): Promise<CliProbe> {
    this.verifyCliCalls += 1;
    return { available: true, version: '1.0.0 (fake)', authenticated: true };
  }

  async listModels(): Promise<ModelCatalog> {
    this.listModelsCalls += 1;
    return { models: [{ id: `${this.engineName}-1`, origin: 'catalog' }], resolvedAt: new Date().toISOString() };
  }

  async discoverMcpServers(): Promise<McpDiscovery> {
    this.discoverCalls += 1;
    return { servers: [], origin: 'file', resolvedAt: new Date().toISOString() };
  }

  async startSession(): Promise<string> {
    throw new Error('no session is ever opened in these cases');
  }

  async getStatus(): Promise<SessionStatus> {
    throw new Error('no session is ever opened in these cases');
  }

  async cancel(): Promise<void> {
    // Nothing is ever started, so there is nothing to take down.
  }

  capabilities(): EngineCapabilities {
    return BASELINE_CAPABILITIES;
  }
}

/** An engine factory over {@link CountingAdapter}, counting how often each engine is built. */
function countingFactory(): {
  factory: (engine: RunModule.EngineName) => EngineRoute;
  built: Map<string, CountingAdapter[]>;
} {
  const built = new Map<string, CountingAdapter[]>();
  return {
    built,
    factory: (engine) => {
      const adapter = new CountingAdapter(engine);
      built.set(engine, [...(built.get(engine) ?? []), adapter]);
      return { adapter, decodeSessionText: decodeShellSessionText };
    },
  };
}

/** Swallows and records stderr while armed. */
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

/** The stderr lines that match a pattern. */
function linesMatching(written: string, pattern: RegExp): string[] {
  return written.split('\n').filter((line) => pattern.test(line));
}

/** The options of a multi-project runner, with the loop's numbers made fast. */
function multiOptions(
  projects: RunModule.ProjectSelection,
  extra: Partial<RunModule.RunnerOptions> = {},
): RunModule.RunnerOptions {
  return {
    url: SOME_URL,
    token: 'operator-token',
    projectId: 1,
    runnerId: RUNNER_ID,
    projects,
    runnerCap: 1,
    projectCap: 4,
    intervalMs: 1,
    leaseTtlSeconds: 30,
    ...extra,
  };
}

/** What a case ran, and what it left behind. */
interface Served {
  plane: FakePlane;
  stderr: string;
  ready: RunModule.ServedProject[][];
  built: Map<string, CountingAdapter[]>;
}

/**
 * Runs `serveProjects` for a number of loop turns, then stops it.
 *
 * @param plane The fake control plane, already scripted.
 * @param projects The selection.
 * @param passes How many loop turns before the stop.
 * @param extra Options to add or override.
 * @param seams Extra seams (the clock).
 * @param onTurn Runs after each turn's heartbeat, before the stop is decided.
 */
async function serve(
  plane: FakePlane,
  projects: RunModule.ProjectSelection,
  passes: number,
  extra: Partial<RunModule.RunnerOptions> = {},
  seams: { now?: () => number } = {},
  onTurn: (turn: number) => void = () => undefined,
): Promise<Served> {
  const { serveProjects } = await loadModule<typeof ServeModule>(SERVE_MODULE);
  const aborter = new AbortController();
  const { factory, built } = countingFactory();
  const ready: RunModule.ServedProject[][] = [];

  plane.onHeartbeat = (turn) => {
    onTurn(turn);
    if (turn >= passes) aborter.abort();
  };

  const stderr = captureStderr();
  try {
    await serveProjects(
      multiOptions(projects, {
        signal: aborter.signal,
        engineFactory: factory,
        onReadyProjects: (served) => ready.push([...served]),
        ...extra,
      }),
      { client: plane.asClient(), ...seams },
    );
  } finally {
    stderr.restore();
  }
  return { plane, stderr: stderr.written(), ready, built };
}

/** The project ids `listReleasedJobs` was asked for, in order. */
function polled(plane: FakePlane): number[] {
  return plane.of('listReleasedJobs').map((call) => call.args[0] as number);
}

test('AT14 — a project with no workspace_root is skipped with one line, once; the other is served', async () => {
  const plane = new FakePlane();
  plane.settings.set(1, { project_id: 1, worktrees_root: pathsOf(1).worktrees_root });
  plane.settings.set(2, configured(2));

  // The clock jumps past the re-check window every turn, so the broken project
  // IS re-read on every pass: the line still appears only once.
  let now = 0;
  const { stderr } = await serve(plane, { kind: 'list', ids: [1, 2] }, 3, {}, { now: () => now }, () => {
    now += 60_000;
  });

  const skipped = linesMatching(stderr, /project 1 skipped/);
  assert.equal(skipped.length, 1, `one line for the skipped project:\n${stderr}`);
  assert.match(skipped[0], /^cartografo-runner: project 1 skipped — /);
  assert.match(skipped[0], /workspace_root/);
  assert.ok(plane.of('getSettings').filter((call) => call.args[0] === 1).length > 1, 'it was re-read');
  assert.ok(!polled(plane).includes(1), 'the skipped project is never polled');
  assert.equal(polled(plane).filter((id) => id === 2).length, 3, 'the other is polled every pass');
});

test('AT15 — an engine setting nothing answers to is skipped and named; --engine wins over it', async () => {
  const broken = new FakePlane();
  broken.settings.set(1, configured(1, 'nope'));
  broken.settings.set(2, configured(2));
  const first = await serve(broken, { kind: 'list', ids: [1, 2] }, 1);

  const skipped = linesMatching(first.stderr, /project 1 skipped/);
  assert.equal(skipped.length, 1, first.stderr);
  assert.match(skipped[0], /"nope"/);
  assert.deepEqual(polled(broken), [2]);

  const overridden = new FakePlane();
  overridden.settings.set(1, configured(1, 'nope'));
  overridden.settings.set(2, configured(2));
  const second = await serve(overridden, { kind: 'list', ids: [1, 2] }, 1, { engine: 'codex' });

  assert.deepEqual(linesMatching(second.stderr, /skipped/), []);
  assert.deepEqual(
    second.ready[0].map((project) => [project.projectId, project.engine]),
    [
      [1, 'codex'],
      [2, 'codex'],
    ],
  );
  assert.deepEqual(new Set(polled(overridden)), new Set([1, 2]));
});

test('AT16 — a settings read that fails with a 500 skips that project; the others are served', async () => {
  const plane = new FakePlane();
  plane.settings.set(1, configured(1));
  plane.settings.set(2, new ControlPlaneClientError('GET /v1/settings?project_id=2 answered 500', 500, null));
  plane.settings.set(3, configured(3));

  const { stderr } = await serve(plane, { kind: 'list', ids: [1, 2, 3] }, 2);

  const skipped = linesMatching(stderr, /project 2 skipped/);
  assert.equal(skipped.length, 1, stderr);
  assert.match(skipped[0], /500/);
  assert.deepEqual(new Set(polled(plane)), new Set([1, 3]));
});

test('AT17 — a skipped project is re-read only once the window has passed, and then served', async () => {
  const { SKIPPED_PROJECT_RECHECK_MS } = await loadModule<typeof ServeModule>(SERVE_MODULE);
  assert.equal(SKIPPED_PROJECT_RECHECK_MS, 30_000);

  const plane = new FakePlane();
  plane.settings.set(1, configured(1));
  plane.settings.set(2, { project_id: 2 });

  let now = 1_000;
  const readsOf2 = (): number => plane.of('getSettings').filter((call) => call.args[0] === 2).length;
  const readsBeforeTurn: number[] = [];

  const { stderr } = await serve(plane, { kind: 'list', ids: [1, 2] }, 4, {}, { now: () => now }, (turn) => {
    readsBeforeTurn[turn] = readsOf2();
    if (turn === 1) {
      // Fixed right after the first pass, but the window has not passed yet.
      plane.settings.set(2, configured(2));
      now = 1_000 + SKIPPED_PROJECT_RECHECK_MS - 1;
    }
    if (turn === 3) now = 1_000 + SKIPPED_PROJECT_RECHECK_MS;
  });

  assert.equal(readsBeforeTurn[1], 1, 'read once at startup');
  assert.equal(readsBeforeTurn[2], 1, 'not re-read before the window has passed');
  assert.equal(readsBeforeTurn[3], 1, 'still not re-read');
  assert.equal(readsOf2(), 2, 're-read once the window passed');

  const joined = linesMatching(stderr, /project 2 is now served/);
  assert.equal(joined.length, 1, stderr);
  assert.ok(joined[0].includes(pathsOf(2).workspace_root), 'the line names the repository');
  assert.ok(joined[0].includes(pathsOf(2).worktrees_root), 'and the worktrees root');
  assert.match(joined[0], /claude-code/, 'and the engine');

  // Served from the pass after it was re-read, and its settings are not re-read
  // once it is served.
  assert.deepEqual(polled(plane).filter((id) => id === 2).length, 1);
  assert.equal(plane.of('getSettings').filter((call) => call.args[0] === 1).length, 1);
});

test('AT18 — --all-projects lists before every pass and serves a newcomer with no new pairing', async () => {
  const plane = new FakePlane();
  plane.settings.set(1, configured(1));
  plane.settings.set(4, configured(4));
  plane.listings = [[1], [1, 4]];

  await serve(plane, { kind: 'all' }, 3);

  assert.equal(plane.of('listProjects').length, 3, 'one listing before each of the three passes');
  // Nobody has work, so every pass asks every served project in id order: the
  // newcomer is polled from the second pass on.
  assert.deepEqual(polled(plane), [1, 1, 4, 1, 4]);
  assert.equal(plane.of('getSettings').filter((call) => call.args[0] === 4).length, 1);
  // One pairing, plus one heartbeat per turn: nothing re-paired for the newcomer.
  assert.equal(plane.of('registerRunner').length, 1 + 3);

  const fixed = new FakePlane();
  fixed.settings.set(1, configured(1));
  fixed.settings.set(4, configured(4));
  fixed.listings = [new Error('must never be asked')];
  await serve(fixed, { kind: 'list', ids: [1, 4] }, 2);
  assert.equal(fixed.of('listProjects').length, 0, '--projects never lists');
});

test('AT19 — a listing refused at startup exits 1 naming the operator credential; a later failure is logged once', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);
  const { serveProjects } = await loadModule<typeof ServeModule>(SERVE_MODULE);

  const refused = new FakePlane();
  refused.listings = [new ControlPlaneClientError('GET /v1/projects answered 403', 403, null)];
  const { factory } = countingFactory();

  const stderr = captureStderr();
  let code: number;
  try {
    code = await runRunnerCli(['--all-projects', '--url', SOME_URL, '--runner-id', RUNNER_ID], {}, {
      run: async (options) => {
        await serveProjects({ ...options, engineFactory: factory }, { client: refused.asClient() });
      },
    });
  } finally {
    stderr.restore();
  }

  assert.equal(code, 1);
  const lines = stderr.written().split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, stderr.written());
  assert.match(lines[0], /--all-projects/);
  assert.match(lines[0], /operator credential/);
  assert.doesNotMatch(lines[0], /refused the pairing/);
  assert.equal(refused.of('deregisterRunner').length, 1, 'a runner that paired says goodbye');

  // Later: the listing fails from the third pass on, with the same message.
  const plane = new FakePlane();
  plane.settings.set(1, configured(1));
  const failing = new ControlPlaneClientError('GET /v1/projects answered 500', 500, null);
  plane.listings = [[1], [1], failing, failing, failing];

  const later = await serve(plane, { kind: 'all' }, 5);
  const logged = linesMatching(later.stderr, /answered 500/);
  assert.equal(logged.length, 1, later.stderr);
  assert.match(logged[0], /--all-projects|projects/);
  assert.deepEqual(polled(plane), [1, 1, 1, 1, 1], 'the previous set is still served');
});

test('AT20 — every lease carries its job\'s own project and the same caps; only served projects are polled', async () => {
  const plane = new FakePlane();
  plane.settings.set(1, configured(1));
  plane.settings.set(2, configured(2));
  plane.settings.set(3, { project_id: 3 });
  plane.jobs.set(1, [releasedJob(11)]);
  plane.jobs.set(2, [releasedJob(21), releasedJob(22)]);

  await serve(plane, { kind: 'list', ids: [1, 2, 3] }, 2, { runnerCap: 3, projectCap: 5 });

  const projectOfJob = new Map([
    [11, 1],
    [21, 2],
    [22, 2],
  ]);
  const leases = plane.of('requestLease').map((call) => call.args[0] as LeaseRequest);
  assert.ok(leases.length >= 3, 'every candidate of both projects was asked for');
  for (const request of leases) {
    assert.equal(request.project_id, projectOfJob.get(request.job_id), JSON.stringify(request));
    assert.equal(request.runner_cap, 3);
    assert.equal(request.project_cap, 5);
    assert.equal(request.runner_id, RUNNER_ID);
  }
  assert.deepEqual(new Set(leases.map((request) => request.project_id)), new Set([1, 2]));
  assert.deepEqual(new Set(polled(plane)), new Set([1, 2]));
});

test('AT21 — the multi-project ready line lists the projects and has no top-level projectId', async () => {
  const { runRunnerCli, READY_EVENT } = await loadModule<typeof CliModule>(CLI_MODULE);

  // What serveProjects hands the callback.
  const plane = new FakePlane();
  plane.settings.set(1, configured(1, 'codex'));
  plane.settings.set(2, configured(2));
  const { ready } = await serve(plane, { kind: 'list', ids: [2, 1] }, 1);
  assert.equal(ready.length, 1, 'announced once');
  assert.deepEqual(ready[0], [
    { projectId: 1, engine: 'codex', repoRoot: pathsOf(1).workspace_root, worktreesRoot: pathsOf(1).worktrees_root },
    { projectId: 2, engine: 'claude-code', repoRoot: pathsOf(2).workspace_root, worktreesRoot: pathsOf(2).worktrees_root },
  ]);

  // What the process owner prints from it.
  const captured = { text: '' };
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await runRunnerCli(['--projects', '1,2', '--url', SOME_URL, '--runner-id', RUNNER_ID], {}, {
      run: async (options) => {
        options.onReadyProjects?.(ready[0]);
      },
    });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(code, 0);
  const line = JSON.parse(captured.text.trim()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ['event', 'projects', 'runnerId', 'url']);
  assert.equal(line.event, READY_EVENT);
  assert.equal(line.url, SOME_URL);
  assert.equal(line.runnerId, RUNNER_ID);
  assert.deepEqual(line.projects, ready[0]);

  // ...and the single-project line keeps its seven keys.
  captured.text = '';
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    code = await runRunnerCli(['--project', '2', '--url', SOME_URL, '--runner-id', RUNNER_ID], {}, {
      run: async (options) => {
        options.onReady?.({ repoRoot: '/r', worktreesRoot: '/w', engine: 'claude-code' });
      },
    });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(JSON.parse(captured.text.trim()) as object), [
    'event',
    'url',
    'runnerId',
    'projectId',
    'engine',
    'repoRoot',
    'worktreesRoot',
  ]);
});

test('AT22 — catalog and discovery run once per engine; one probe, for the lowest served id', async () => {
  const plane = new FakePlane();
  plane.settings.set(1, configured(1, 'claude-code'));
  plane.settings.set(2, configured(2, 'codex'));
  plane.settings.set(3, configured(3, 'claude-code'));

  const { built } = await serve(plane, { kind: 'list', ids: [1, 2, 3] }, 2);

  assert.deepEqual([...built.keys()].sort(), ['claude-code', 'codex']);
  for (const [engine, adapters] of built) {
    assert.equal(adapters.length, 1, `one adapter for ${engine}`);
    assert.equal(adapters[0].listModelsCalls, 1, `one catalog for ${engine}`);
    assert.equal(adapters[0].discoverCalls, 1, `one MCP discovery for ${engine}`);
  }
  assert.deepEqual(
    plane.of('reportEngineModels').map((call) => call.args[0]).sort(),
    ['claude-code', 'codex'],
  );

  const probes = plane.of('reportProbe');
  assert.equal(probes.length, 1, 'one probe per runner');
  const report = probes[0].args[1] as ProbeReport;
  assert.equal(report.workspace.working_dir, pathsOf(1).workspace_root);
  assert.equal(report.workspace.worktrees_root, pathsOf(1).worktrees_root);
});

test('AT23 — a stop during resolution resolves nothing after it, and the runner deregisters once', async () => {
  const { serveProjects } = await loadModule<typeof ServeModule>(SERVE_MODULE);
  const aborter = new AbortController();
  const plane = new FakePlane();
  plane.settings.set(1, configured(1));
  plane.settings.set(2, configured(2));
  plane.settings.set(3, configured(3));
  const original = plane.getSettings.bind(plane);
  plane.getSettings = async (projectId: number): Promise<Settings> => {
    const answer = await original(projectId);
    aborter.abort();
    return answer;
  };
  const { factory } = countingFactory();
  const ready: RunModule.ServedProject[][] = [];

  await serveProjects(
    multiOptions({ kind: 'list', ids: [1, 2, 3] }, {
      signal: aborter.signal,
      engineFactory: factory,
      onReadyProjects: (served) => ready.push([...served]),
    }),
    { client: plane.asClient() },
  );

  assert.deepEqual(
    plane.of('getSettings').map((call) => call.args[0]),
    [1],
    'no project resolution started after the stop',
  );
  assert.deepEqual(polled(plane), []);
  assert.deepEqual(ready, []);
  assert.equal(plane.of('registerRunner').length, 1);
  assert.equal(plane.of('deregisterRunner').length, 1);
});
