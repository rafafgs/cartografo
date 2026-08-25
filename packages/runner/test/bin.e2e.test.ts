/**
 * Acceptance tests of the packaged command (t162, AT14–AT15).
 *
 * The claim under test is the one the first dogfood wrote down as gap #5
 * (`notes/2026-08-15-first-execution.md:54-56`): the runner used to be a
 * library whose consumer had to know to pass `--import tsx`, because parameter
 * properties in its TypeScript break Node's strip-only mode. So the environment
 * this file spawns the bin with is deliberately plain — `NODE_OPTIONS` is
 * deleted, not merely left alone — and a `.mjs` shell that forgot to register
 * the loader dies on the very first import instead of passing quietly.
 *
 * Nothing is released on this control plane, and nothing needs to be: what is
 * being proven is that the process comes up, pairs, and goes away when asked.
 * Dispatch is `test/cli/run.e2e.test.ts`'s subject.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// The spawn-and-watch plumbing is shared since t201. This file uses the general
// pair and never `bootCore`: the process it watches most closely is the RUNNER,
// which announces `cartografo.runner.ready` and is no control plane at all.
import { CORE_BIN as CONTROL_PLANE_BIN, awaitReadiness, bootCore, spawnWatched } from '@cartografo/test-support';

import { DEFAULT_GRACE_MS } from '../src/engine/claude-code-adapter.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER_BIN = path.join(PACKAGE_ROOT, 'bin', 'cartografo-runner.mjs');
const FAKE_ENGINE = fileURLToPath(new URL('fixtures/fake-engine.mjs', import.meta.url));

/** Deadline for the two startups. Wide slack, on purpose. */
const DEADLINE_MS = 30_000;

/** Deadline for the shutdown — the one number this file is strict about. */
const SHUTDOWN_DEADLINE_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* t193 — what a hard stop needs beyond a runner that pairs and goes away.     */
/* -------------------------------------------------------------------------- */

/** One JSON call with the credential handed in explicitly, asserting the status. */
async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Waits for something to become true, with a deadline and a message of its own. */
async function waitFor(label: string, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`${label} did not happen within ${DEADLINE_MS}ms`);
}

/**
 * A repository with one commit, for a runner that really cuts worktrees.
 *
 * The two cases above never dispatch and get plain directories; this one does,
 * so `git worktree add` has to have something to cut from.
 */
function initRepo(base: string): string {
  const repoRoot = path.join(base, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8' }).trim();

  git('init', '--quiet');
  git('config', 'user.email', 'fixture@cartografo.local');
  git('config', 'user.name', 'Fixture t193');
  writeFileSync(path.join(repoRoot, 'README.md'), '# t193 fixture repository\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'initial');

  return repoRoot;
}

/**
 * Puts the fake engine on the PATH under the name the real adapter spawns.
 *
 * The bin under test is the REAL one, so there is no `engineFactory` seam to
 * reach from out here: `buildCommand` spawns `claude`, full stop. A shim named
 * `claude`, first on the child's PATH, is what lets this file exercise the
 * production wiring end to end without an installed, authenticated CLI — the
 * same division `docs/formats/engine-adapter.md:363-366` records, applied to
 * the one seam a separate process has.
 *
 * @returns The directory to prepend to PATH.
 */
function fakeEngineOnPath(base: string): string {
  const dir = path.join(base, 'bin');
  mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'claude');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ENGINE)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

/** Is this pid still there? A zombie answers yes until it is reaped. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

test('t162 — the runner is an installable command, started by plain node', async (parent) => {
  assert.ok(existsSync(CONTROL_PLANE_BIN), `artifact does not exist yet: ${CONTROL_PLANE_BIN}`);
  assert.ok(existsSync(RUNNER_BIN), `artifact does not exist yet: ${RUNNER_BIN}`);

  const planeDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-bin-plane-'));
  const runnerDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-bin-runner-'));
  // Required since t179, and a sibling of the runner's own `--working-dir`
  // (which defaults to `runnerDir`): the command exits 2 at argument zero
  // without it, long before it could pair. Nothing is released on this control
  // plane, so no worktree is ever actually cut in it.
  const worktreesDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t162-bin-worktrees-'));
  parent.after(() => {
    rmSync(planeDir, { recursive: true, force: true });
    rmSync(runnerDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  });

  const { url: baseUrl, token } = await bootCore(parent, { cwd: planeDir });

  // The plain environment of the claim: no `--import tsx` on the command line
  // and no loader smuggled in through the environment either.
  const plainEnv = { ...process.env };
  delete plainEnv.NODE_OPTIONS;
  // Plain is not the same as beholden to the host (t219). Startup runs an
  // engine preflight, and an adapter that finds no `claude` warns about it on
  // stderr — so AT14's "a clean start writes nothing" was really asserting that
  // whoever ran it had a proprietary CLI installed: green on a laptop, red on
  // every GitHub-hosted runner. The shim AT16 already relies on answers
  // `--version`, which is the whole of what the preflight asks; neither of
  // these two cases ever dispatches, so nothing else about it is exercised.
  plainEnv.PATH = `${fakeEngineOnPath(runnerDir)}${path.delimiter}${plainEnv.PATH ?? ''}`;

  const runner = spawnWatched(
    parent,
    [RUNNER_BIN, '--url', baseUrl, '--token', token, '--project', '1', '--worktrees-root', worktreesDir],
    { cwd: runnerDir, env: plainEnv },
  );

  await parent.test('AT14 — plain `node bin/cartografo-runner.mjs` starts and pairs', async () => {
    const announced = await awaitReadiness(runner, 'cartografo.runner.ready');
    const runnerId = String(announced.runnerId);
    assert.notEqual(runnerId, '', 'the readiness line says which identity paired');

    // The same probe AT8 uses: a lease request for an unpaired runner is a 404,
    // so any other answer is the pairing having happened.
    const response = await fetch(`${baseUrl}/v1/leases`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        runner_id: runnerId,
        project_id: 1,
        job_id: 999_162,
        teto_runner: 1,
        teto_projeto: 1,
        ttl_seconds: 1,
      }),
    });
    const body = await response.text();
    assert.notEqual(response.status, 404, `the command started but never paired: ${body}`);
    assert.doesNotMatch(body, /runner_desconhecido/);
    assert.equal(
      runner.err(),
      '',
      `a clean start writes nothing on stderr:\n${runner.err()}`,
    );
  });

  await parent.test('AT15 — SIGTERM stops it with exit code 0', async () => {
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      runner.child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    const asked = Date.now();
    runner.child.kill('SIGTERM');

    const outcome = await Promise.race([
      exited,
      delay(SHUTDOWN_DEADLINE_MS).then(() => null),
    ]);

    assert.ok(
      outcome !== null,
      `the runner did not stop within ${SHUTDOWN_DEADLINE_MS}ms of SIGTERM\nstderr:\n${runner.err()}`,
    );
    assert.equal(outcome.signal, null, 'a clean stop is an exit, not a death by signal');
    assert.equal(
      outcome.code,
      0,
      `asking a runner to stop is not an error (took ${Date.now() - asked}ms)\nstderr:\n${runner.err()}`,
    );
  });

  await parent.test(
    't193 AT16 — a stop with a live session is bounded, and orphans no engine process',
    async (t) => {
      // The grace is short here for the same reason every other number in this
      // file is wide: what is being measured is that the stop is BOUNDED, and a
      // real 120s default would only make the measurement slower, never
      // different. The engine going down after it is the adapter's own
      // SIGTERM→SIGKILL escalation, which is why the deadline carries
      // `DEFAULT_GRACE_MS` too.
      const shutdownGraceSeconds = 1;

      const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'cartografo-t193-at16-')));
      t.after(() => {
        rmSync(base, { recursive: true, force: true });
      });

      const repoRoot = initRepo(base);
      const worktreesRoot = path.join(base, 'worktrees');
      const record = path.join(base, 'engine-record.json');
      const shimDir = fakeEngineOnPath(base);

      const job = await api<{ id: number }>(
        baseUrl,
        token,
        'POST',
        '/v1/jobs',
        { title: 'work with a live session', entry_node_id: 'fazer', execution_id: 193016 },
        201,
      );
      t.after(async () => {
        await api(baseUrl, token, 'POST', `/v1/jobs/${job.id}/blocks`, {
          reason: 'end of the test case',
        });
      });

      const runner = spawnWatched(
        parent,
        [
          RUNNER_BIN,
          '--url', baseUrl,
          '--token', token,
          '--project', '1',
          '--runner-id', 'runner-t193-at16',
          '--working-dir', repoRoot,
          '--worktrees-root', worktreesRoot,
          '--interval-ms', '200',
          '--lease-ttl-seconds', '30',
          '--shutdown-grace-seconds', String(shutdownGraceSeconds),
        ],
        {
          cwd: repoRoot,
          env: {
            ...(() => {
              const plain = { ...process.env };
              delete plain.NODE_OPTIONS;
              return plain;
            })(),
            PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`,
            // The session the stop has to interrupt: a process that would
            // outlive the runner by an hour, holding a child of its own that
            // ignores SIGTERM — which is what makes the escalation to the whole
            // group the only thing that can end it.
            FAKE_ENGINE_DELAY_MS: '3600000',
            FAKE_ENGINE_SPAWN_CHILD: '1',
            FAKE_ENGINE_IGNORE_SIGTERM: '1',
            FAKE_ENGINE_RECORD: record,
          },
        },
      );

      await awaitReadiness(runner, 'cartografo.runner.ready');

      // The session row is written as soon as the engine is up, which is the
      // earliest moment this test can know a dispatch is in flight — the same
      // wait `cli/run.e2e.test.ts`'s AT13 uses.
      await waitFor('a session being opened', async () => {
        const { sessions } = await api<{ sessions: unknown[] }>(
          baseUrl,
          token,
          'GET',
          '/v1/sessions?execution_id=193016',
        );
        return sessions.length > 0;
      });
      await waitFor('the engine writing its sidecar', () => existsSync(record));

      const engine = JSON.parse(readFileSync(record, 'utf8')) as {
        pid: number;
        grandchildPid: number | null;
      };
      assert.equal(typeof engine.pid, 'number');
      assert.equal(typeof engine.grandchildPid, 'number', 'the session left a child behind');
      const pids = [engine.pid, engine.grandchildPid as number];
      for (const pid of pids) assert.ok(alive(pid), `pid ${pid} should be running before the stop`);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          runner.child.once('exit', (code, signal) => resolve({ code, signal }));
        },
      );

      // The bound: the grace the runner was given, plus the escalation the
      // adapter itself spends going from SIGTERM to SIGKILL, plus slack for the
      // control-plane writes the dispatch still owes on its way out.
      const bound = shutdownGraceSeconds * 1_000 + DEFAULT_GRACE_MS + 5_000;

      const asked = Date.now();
      runner.child.kill('SIGTERM');

      const outcome = await Promise.race([exited, delay(bound).then(() => null)]);
      const took = Date.now() - asked;

      assert.ok(
        outcome !== null,
        `the runner did not stop within ${bound}ms of SIGTERM with a session in flight — ` +
          `a stop that waits out the session waits up to an hour\nstderr:\n${runner.err()}`,
      );
      assert.equal(outcome.signal, null, 'a bounded stop is an exit, not a death by signal');
      assert.equal(
        outcome.code,
        0,
        `asking a runner to stop is not an error (took ${took}ms)\nstderr:\n${runner.err()}`,
      );

      // ...and this is the half a bounded exit alone does not prove: what the
      // runner started is not still running once the runner is gone. The short
      // poll is for the REAPING and nothing else — a process killed while its
      // parent was still up stays a zombie for as long as it takes the kernel
      // to reparent it, and a zombie answers `kill(pid, 0)` like the living.
      for (let attempt = 0; attempt < 20 && pids.some((pid) => alive(pid)); attempt += 1) {
        await delay(100);
      }
      for (const pid of pids) {
        assert.ok(
          !alive(pid),
          `pid ${pid} outlived the runner: a session nobody can report on, writing in a worktree nobody will give back`,
        );
      }
    },
  );
});
