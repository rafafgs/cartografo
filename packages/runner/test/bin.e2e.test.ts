/**
 * Acceptance tests of the packaged command (t162, AT14–AT15).
 *
 * The claim under test is the one the first dogfood wrote down as gap #5
 * (`notas/2026-08-15-primeira-execucao.md:53-55`): the runner used to be a
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
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const CONTROL_PLANE_BIN = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');
const RUNNER_BIN = path.join(PACKAGE_ROOT, 'bin', 'cartografo-runner.mjs');

/** Deadline for the two startups. Wide slack, on purpose. */
const DEADLINE_MS = 30_000;

/** Deadline for the shutdown — the one number this file is strict about. */
const SHUTDOWN_DEADLINE_MS = 5_000;

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

/** A child process whose stdout is being watched for one line. */
interface WatchedChild {
  child: CommandChild;
  /** Everything it wrote on stdout so far. */
  out: () => string;
  /** Everything it wrote on stderr so far. */
  err: () => string;
}

/** Spawns a command, collecting both streams and killing it at the end. */
function spawnWatched(
  t: TestHook,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): WatchedChild {
  const child: CommandChild = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
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
  });

  return { child, out: () => out, err: () => err };
}

/** Waits for a JSON readiness line carrying the given event name. */
async function awaitReadiness(watched: WatchedChild, event: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (watched.child.exitCode !== null) {
      throw new Error(
        `the process died before announcing "${event}" (code ${watched.child.exitCode})\n` +
          `stdout:\n${watched.out()}\nstderr:\n${watched.err()}`,
      );
    }
    const line = watched
      .out()
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes(event));
    if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
    await delay(50);
  }

  throw new Error(
    `"${event}" was not announced within ${DEADLINE_MS}ms\nstdout:\n${watched.out()}\nstderr:\n${watched.err()}`,
  );
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

  const plane = spawnWatched(parent, [CONTROL_PLANE_BIN], {
    cwd: planeDir,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(planeDir, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
  });
  const readiness = await awaitReadiness(plane, 'cartografo.ready');
  const baseUrl = String(readiness.url);
  const token = String(readiness.bootstrapToken);

  // The plain environment of the claim: no `--import tsx` on the command line
  // and no loader smuggled in through the environment either.
  const plainEnv = { ...process.env };
  delete plainEnv.NODE_OPTIONS;

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
        projeto_id: 1,
        trabalho_id: 999_162,
        teto_runner: 1,
        teto_projeto: 1,
        ttl_segundos: 1,
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
});
