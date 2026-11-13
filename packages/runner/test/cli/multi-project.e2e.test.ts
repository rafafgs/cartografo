/**
 * End-to-end tests of one runner process serving several projects (t1112,
 * AT24–AT29).
 *
 * A real control plane (the binary, as a child process), real git repositories
 * in a temp directory, and the fake engine reached through the `engineFactory`
 * seam — the same harness `run.e2e.test.ts`'s t404 block uses. Each project's
 * repository and worktrees root are written into ITS settings with
 * `PATCH /v1/settings`, which is the only place a multi-project runner reads
 * them from.
 *
 * Where each session ran is read from the adapter's own `environmentBuilder`,
 * which is handed the session's spec in this process: the worktree directory is
 * `ticket-<job>-<hex>` under the root it was cut into, so the list of specs in
 * the order they were built is also the order the sessions started.
 *
 * A job with no graph version stays released after its session, so a project
 * with work keeps having work; the cases read the first sessions only.
 *
 * English only.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { runRunnerCli } from '../../src/cli/index.ts';
import { runRunner, type RunnerOptions, type ServedProject } from '../../src/cli/run.ts';
import type { EngineRoute } from '../../src/dispatch/dispatch.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand, buildEnvironment, type EngineCommand } from '../../src/engine/command.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Deadline of every wait in this file. Wide slack, on purpose. */
const DEADLINE_MS = 45_000;

/** The node every job of this file is created on. */
const ENTRY_NODE = 'redigir';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Plane {
  baseUrl: string;
  token: string;
}

interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
}

/** One JSON call with the operator credential, asserting the status. */
async function api<T>(plane: Plane, method: string, route: string, body?: unknown, expected = 200): Promise<T> {
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** A project's two directories: a real repository and a sibling worktrees root. */
interface Workspace {
  repoRoot: string;
  worktreesRoot: string;
}

function initRepo(t: TestHook, label: string): Workspace {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), `cartografo-t1112-${label}-`)));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const repoRoot = path.join(base, 'repo');
  mkdirSync(repoRoot);
  git(repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t1112');
  writeFileSync(path.join(repoRoot, 'README.md'), `# Fixture repo of t1112 (${label})\n`);
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'initial');
  return { repoRoot, worktreesRoot: path.join(base, 'worktrees') };
}

/** Everything under a directory, as relative paths, ignoring `.git` internals' churn. */
function snapshot(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      out.push(path.relative(directory, full));
      if (entry.isDirectory() && entry.name !== '.git') walk(full);
    }
  };
  walk(directory);
  return out.sort();
}

async function declareProject(plane: Plane, name: string): Promise<number> {
  const { id } = await api<{ id: number }>(plane, 'POST', '/v1/projects', { name }, 201);
  return id;
}

async function seedSettings(plane: Plane, projectId: number, patch: Record<string, string>): Promise<void> {
  await api(plane, 'PATCH', '/v1/settings', { project_id: projectId, ...patch });
}

async function createJob(plane: Plane, projectId: number, title: string, executionId: number): Promise<number> {
  const job = await api<{ id: number }>(
    plane,
    'POST',
    '/v1/jobs',
    { title, project_id: projectId, entry_node_id: ENTRY_NODE, execution_id: executionId },
    201,
  );
  return job.id;
}

/** Takes every unblocked job of a project out of the queue. */
async function blockEveryJob(plane: Plane, projectId: number): Promise<void> {
  const { jobs } = await api<{ jobs: Array<{ id: number; blocked: boolean }> }>(
    plane,
    'GET',
    `/v1/jobs?project_id=${String(projectId)}`,
  );
  for (const job of jobs) {
    if (!job.blocked) await api(plane, 'POST', `/v1/jobs/${String(job.id)}/blocks`, { reason: 'end of the test case' });
  }
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${label} did not happen within ${String(DEADLINE_MS)}ms`);
}

const FAKE_PROBE = (): EngineCommand => ({ command: process.execPath, args: [FAKE_ENGINE, '--version'] });
const FAKE_MCP_LIST = (): EngineCommand => ({ command: process.execPath, args: [FAKE_ENGINE, 'mcp', 'list'] });
const QUIET_LINES = JSON.stringify([{ stream: 'stdout', text: 'I did what the node asked for; nothing to ask.' }]);

/**
 * The fake engine, recording the working directory of every session it starts,
 * in order.
 */
function recordingFactory(): { factory: () => EngineRoute; sessions: string[] } {
  const sessions: string[] = [];
  return {
    sessions,
    factory: () => ({
      adapter: new ClaudeCodeAdapter({
        commandBuilder: (spec) => ({ command: process.execPath, args: [FAKE_ENGINE, ...buildCommand(spec).args] }),
        environmentBuilder: (spec) => {
          sessions.push(spec.workingDir);
          return { ...buildEnvironment(spec), FAKE_ENGINE_LINES: QUIET_LINES };
        },
        graceMs: 300,
        probeCommandBuilder: FAKE_PROBE,
        mcpListCommandBuilder: FAKE_MCP_LIST,
      }),
      decodeSessionText: decodeClaudeCodeSessionText,
    }),
  };
}

/** Which workspace a session's directory belongs to, by its worktrees root. */
function ownerOf(directory: string, spaces: ReadonlyMap<string, Workspace>): string | null {
  for (const [label, space] of spaces) {
    if (directory.startsWith(space.worktreesRoot + path.sep)) return label;
  }
  return null;
}

/** The job id a session worktree was cut for, from its `ticket-<id>-<hex>` name. */
function jobOf(directory: string): number {
  const match = /^ticket-(\d+)-/.exec(path.basename(directory));
  assert.ok(match !== null, `not a session worktree: ${directory}`);
  return Number(match[1]);
}

/** Starts a runner in this process; the stop is idempotent and also an `after`. */
function startRunner(t: TestHook, options: Omit<RunnerOptions, 'signal'>): { stop: () => Promise<void> } {
  const aborter = new AbortController();
  const finished = runRunner({ ...options, signal: aborter.signal });
  const stop = async (): Promise<void> => {
    aborter.abort();
    await finished;
  };
  t.after(stop);
  return { stop };
}

/** The loop's numbers, made fast. */
const FAST = {
  runnerCap: 1,
  projectCap: 4,
  intervalMs: 200,
  leaseTtlSeconds: 15,
} as const;

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

/** A proxy in front of the control plane that counts the routes that went through it. */
async function countingProxy(t: TestHook, plane: Plane): Promise<Plane & { countOf: (prefix: string) => number }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const route = request.url ?? '/';
    seen.push(route);
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
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
  };
}

test('t1112 — one runner, two projects, against a real control plane', async (parent) => {
  const { url, token } = await bootCore(parent);
  const plane: Plane = { baseUrl: url, token };

  await parent.test('AT24/AT25/AT27 — each job runs in its own project, alternating, under one runner row', async (t) => {
    const projectA = await declareProject(plane, 't1112-a');
    const projectB = await declareProject(plane, 't1112-b');
    const spaceA = initRepo(t, 'a');
    const spaceB = initRepo(t, 'b');
    t.after(async () => {
      await blockEveryJob(plane, projectA);
      await blockEveryJob(plane, projectB);
    });
    await seedSettings(plane, projectA, {
      workspace_root: spaceA.repoRoot,
      worktrees_root: spaceA.worktreesRoot,
      engine: 'claude-code',
    });
    await seedSettings(plane, projectB, {
      workspace_root: spaceB.repoRoot,
      worktrees_root: spaceB.worktreesRoot,
      engine: 'claude-code',
    });

    const jobsA = [
      await createJob(plane, projectA, 'first job of A', 1_112_001),
      await createJob(plane, projectA, 'second job of A', 1_112_002),
    ];
    const jobsB = [
      await createJob(plane, projectB, 'first job of B', 1_112_003),
      await createJob(plane, projectB, 'second job of B', 1_112_004),
    ];
    const projectOfJob = new Map<number, number>([
      ...jobsA.map((id): [number, number] => [id, projectA]),
      ...jobsB.map((id): [number, number] => [id, projectB]),
    ]);

    const beforeA = snapshot(spaceA.repoRoot);
    const beforeB = snapshot(spaceB.repoRoot);
    const { factory, sessions } = recordingFactory();
    const runnerId = 'runner-t1112-at24';
    const ready: ServedProject[][] = [];

    const runner = startRunner(t, {
      url: plane.baseUrl,
      token: plane.token,
      projectId: 1,
      projects: { kind: 'list', ids: [projectA, projectB] },
      runnerId,
      ...FAST,
      engineFactory: factory,
      onReadyProjects: (served) => ready.push([...served]),
    });

    await waitFor('four sessions to start', () => sessions.length >= 4);

    // AT27, read while the runner is present (a deregistered runner leaves the
    // listing): one runner row, whatever number of projects it serves.
    const { runners } = await api<{ runners: Array<{ id: string }> }>(plane, 'GET', '/v1/runners');
    assert.equal(runners.filter((row) => row.id === runnerId).length, 1, 'one runner row');

    await runner.stop();

    const spaces = new Map<string, Workspace>([
      ['A', spaceA],
      ['B', spaceB],
    ]);

    // AT25: the order in which the sessions started.
    assert.deepEqual(
      sessions.slice(0, 4).map((directory) => ownerOf(directory, spaces)),
      ['A', 'B', 'A', 'B'],
      sessions.join('\n'),
    );

    // AT24: every session ran under its own project's worktrees root, for a job
    // of that project.
    for (const directory of sessions) {
      const owner = ownerOf(directory, spaces);
      assert.ok(owner !== null, `a session ran outside both worktrees roots: ${directory}`);
      const job = jobOf(directory);
      assert.equal(projectOfJob.get(job), owner === 'A' ? projectA : projectB, directory);
    }

    // ...each `ticket-<id>` branch exists in its own repository only...
    for (const job of new Set(sessions.map(jobOf))) {
      const own = projectOfJob.get(job) === projectA ? spaceA : spaceB;
      const other = own === spaceA ? spaceB : spaceA;
      assert.ok(git(own.repoRoot, 'branch', '--list', `ticket-${String(job)}`).includes(`ticket-${String(job)}`));
      assert.equal(git(other.repoRoot, 'branch', '--list', `ticket-${String(job)}`), '');
    }

    // ...and nothing in either repository's working tree changed.
    assert.deepEqual(snapshot(spaceA.repoRoot), beforeA);
    assert.deepEqual(snapshot(spaceB.repoRoot), beforeB);

    // AT24/AT27: the lease rows carry each job's own project, under ONE runner.
    const { leases } = await api<{ leases: Lease[] }>(plane, 'GET', `/v1/leases?runner_id=${runnerId}`);
    assert.ok(leases.length >= 4, JSON.stringify(leases));
    for (const lease of leases) {
      assert.equal(lease.runner_id, runnerId);
      assert.equal(lease.project_id, projectOfJob.get(lease.job_id), JSON.stringify(lease));
    }
    assert.deepEqual(new Set(leases.map((lease) => lease.project_id)), new Set([projectA, projectB]));

    assert.deepEqual(
      ready,
      [
        [
          { projectId: projectA, engine: 'claude-code', repoRoot: spaceA.repoRoot, worktreesRoot: spaceA.worktreesRoot },
          { projectId: projectB, engine: 'claude-code', repoRoot: spaceB.repoRoot, worktreesRoot: spaceB.worktreesRoot },
        ],
      ],
    );
  });

  await parent.test('AT28 — a project with no worktrees_root is reported once; the other completes; exit 0', async (t) => {
    const projectA = await declareProject(plane, 't1112-at28-a');
    const projectB = await declareProject(plane, 't1112-at28-b');
    const spaceA = initRepo(t, 'at28-a');
    const spaceB = initRepo(t, 'at28-b');
    t.after(async () => {
      await blockEveryJob(plane, projectA);
      await blockEveryJob(plane, projectB);
    });
    await seedSettings(plane, projectA, { workspace_root: spaceA.repoRoot });
    await seedSettings(plane, projectB, {
      workspace_root: spaceB.repoRoot,
      worktrees_root: spaceB.worktreesRoot,
    });
    await createJob(plane, projectA, 'job of the unconfigured project', 1_112_281);
    const jobB = await createJob(plane, projectB, 'job of the configured project', 1_112_282);

    const { factory, sessions } = recordingFactory();
    const stderr = captureStderr();
    let pending: Promise<number>;
    try {
      pending = runRunnerCli(
        [
          '--url',
          plane.baseUrl,
          '--token',
          plane.token,
          '--projects',
          `${String(projectA)},${String(projectB)}`,
          '--runner-id',
          'runner-t1112-at28',
          '--interval-ms',
          '200',
        ],
        {},
        {
          run: async (options) => {
            await runRunner({ ...options, engineFactory: factory });
          },
        },
      );

      await waitFor('the configured project\'s session to complete', async () => {
        const { sessions: rows } = await api<{ sessions: Array<{ job_id: number; status: string }> }>(
          plane,
          'GET',
          `/v1/sessions?project_id=${String(projectB)}`,
        );
        return rows.some((row) => row.job_id === jobB && row.status === 'completed');
      });
      // A few more passes, so a repeated skip line would have had its chance.
      await delay(1_000);
      process.emit('SIGINT', 'SIGINT');
      const code = await pending;
      assert.equal(code, 0);
    } finally {
      stderr.restore();
    }

    for (const directory of sessions) {
      assert.ok(directory.startsWith(spaceB.worktreesRoot + path.sep), directory);
    }
    const skipped = stderr
      .written()
      .split('\n')
      .filter((line) => line.includes(`project ${String(projectA)} skipped`));
    assert.equal(skipped.length, 1, stderr.written());
    assert.match(skipped[0], /worktrees_root/);
  });

  await parent.test('AT29 — --project with both paths never lists projects and keeps today\'s ready line', async (t) => {
    const projectId = await declareProject(plane, 't1112-at29');
    const space = initRepo(t, 'at29');
    const proxied = await countingProxy(t, plane);

    const original = process.stdout.write.bind(process.stdout);
    let captured = '';
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      const pending = runRunnerCli(
        [
          '--url',
          proxied.baseUrl,
          '--token',
          proxied.token,
          '--project',
          String(projectId),
          '--working-dir',
          space.repoRoot,
          '--worktrees-root',
          space.worktreesRoot,
          '--runner-id',
          'runner-t1112-at29',
          '--interval-ms',
          '200',
        ],
        {},
        {
          run: async (options) => {
            await runRunner({ ...options, engineFactory: recordingFactory().factory });
          },
        },
      );
      await waitFor('the ready line', () => captured.includes('cartografo.runner.ready'));
      await waitFor('a few passes', () => proxied.countOf('/v1/jobs') >= 2);
      process.emit('SIGINT', 'SIGINT');
      code = await pending;
    } finally {
      process.stdout.write = original;
    }

    assert.equal(code, 0);
    const readyKeys = Object.keys(JSON.parse(captured.trim().split('\n')[0]) as object);
    assert.deepEqual(readyKeys, ['event', 'url', 'runnerId', 'projectId', 'engine', 'repoRoot', 'worktreesRoot']);
    assert.equal(proxied.countOf('/v1/projects'), 0, 'GET /v1/projects was never called');
  });
});

test('AT26 — --all-projects serves a project created after the runner started, with no restart', async (t) => {
  const { url, token } = await bootCore(t);
  const plane: Plane = { baseUrl: url, token };

  const projectA = await declareProject(plane, 't1112-at26-a');
  const spaceA = initRepo(t, 'at26-a');
  const spaceB = initRepo(t, 'at26-b');
  await seedSettings(plane, projectA, {
    workspace_root: spaceA.repoRoot,
    worktrees_root: spaceA.worktreesRoot,
  });
  await createJob(plane, projectA, 'job of A', 1_112_261);

  const { factory, sessions } = recordingFactory();
  const ready: ServedProject[][] = [];
  const runner = startRunner(t, {
    url: plane.baseUrl,
    token: plane.token,
    projectId: 1,
    projects: { kind: 'all' },
    runnerId: 'runner-t1112-at26',
    ...FAST,
    engineFactory: factory,
    onReadyProjects: (served) => ready.push([...served]),
  });
  // No job cleanup here: the control plane is this case's own, and its teardown
  // (registered first, so it runs first) takes every job with it.

  await waitFor('the ready line', () => ready.length === 1);
  assert.ok(ready[0].some((project) => project.projectId === projectA));

  const projectB = await declareProject(plane, 't1112-at26-b');
  await seedSettings(plane, projectB, {
    workspace_root: spaceB.repoRoot,
    worktrees_root: spaceB.worktreesRoot,
  });
  const jobB = await createJob(plane, projectB, 'job of B, created after the start', 1_112_262);

  await waitFor('B\'s job to be served', () =>
    sessions.some((directory) => directory.startsWith(spaceB.worktreesRoot + path.sep) && jobOf(directory) === jobB),
  );
  await runner.stop();
  assert.equal(ready.length, 1, 'the runner was never restarted');
});
