/**
 * The reap runs even when the case fails — and the case still fails (t468, AT3–AT4).
 *
 * Two halves, and the ticket is only closed if BOTH hold. Making C4 clean up
 * after itself is easy to get wrong in the direction that hides the bug: a reap
 * placed where it also stops the case from failing would leave every future
 * adapter's broken process-group kill unreported, which is worse than the orphan
 * it was meant to fix. So this file drives C4 at an adapter whose `cancel()`
 * deliberately never touches the group and asserts the two facts together — the
 * case FAILED, and nothing it started is still running.
 *
 * The drive happens in a child process because C4 is genuinely red there.
 * Running it in this file's own process would make this file permanently red
 * under `npm test`, indistinguishable from a real regression; as a child, its
 * failure is a number this test reads.
 *
 * The child is also the observation: without the reap the harness cannot even
 * exit. Its live engine is a `ChildProcess` this process holds a handle to and a
 * 60s wall clock still armed, so a run that abandons the process group hangs
 * instead of ending — which is why the bound below is well under that clock, and
 * why blowing through it is a legitimate failure of AT3 rather than a slow pass.
 *
 * English per the project's language convention.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { reapIfAlive } from '../../src/engine/conformance-kit.ts';

const HARNESS = fileURLToPath(
  new URL('../fixtures/conformance-kit-non-killing-adapter.ts', import.meta.url),
);

/**
 * The env var the harness copies the engine's pids into.
 *
 * A literal on both sides, never a shared import: importing the harness module
 * would register the conformance kit in THIS process and run the case that is
 * supposed to fail. The counterpart is
 * `test/fixtures/conformance-kit-non-killing-adapter.ts`.
 */
const SIDE_CHANNEL_ENV = 'CARTOGRAFO_T468_SIDE_CHANNEL';

/**
 * How long the harness gets to end.
 *
 * With the reap in place it ends in a few seconds: C4's wait for `onFinished`
 * runs out after the harness's own 3s kit deadline, the reap fires from
 * `t.after`, the engine's `close` lands and the adapter disarms its clock. The
 * ceiling is deliberately well under the 60s wall clock C4's own spec arms,
 * because that watchdog eventually kills the group through the adapter's
 * internal path — past 60s a hung harness would start to look reaped, and this
 * test would go green on the bug.
 */
const HARNESS_BOUND_MS = 20_000;

/** `true` while the pid exists; `EPERM` counts as alive (it exists, but is not ours). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The environment the harness runs in — the parent's, minus the test runner's
 * own footprint.
 *
 * `NODE_TEST_CONTEXT` is the load-bearing deletion. Inherited, it puts the
 * child's `node:test` into the serialized-reporter mode a test-runner subprocess
 * uses, which both turns the output this test quotes on failure into binary and
 * changes how the child decides to exit. The harness has to be a plain
 * standalone `node:test` run whatever launched this file. `NODE_OPTIONS` goes
 * for the reason `bin.e2e.test.ts` states: the contract is plain `node`.
 */
function harnessEnvironment(sideChannel: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [SIDE_CHANNEL_ENV]: sideChannel };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return env;
}

interface Drive {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly pids: readonly number[];
}

test('t468 — a failing C4 reaps its own process group', async (parent) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t468-'));
  const sideChannel = path.join(base, 'engine-pids.json');
  parent.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const child = spawn(process.execPath, [HARNESS], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: harnessEnvironment(sideChannel),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // The ceiling is disarmed AFTER the race, never from inside it: a timer left
  // pending holds this process's event loop for the whole remainder of the bound
  // — a file that does its work in 3s and then sits there for 17 more — but an
  // abort chained onto `exited` would settle in the same microtask batch as the
  // race itself and could hand back a timeout the harness never had.
  const ceiling = new AbortController();
  const outcome = await Promise.race([
    exited,
    delay(HARNESS_BOUND_MS, null, { signal: ceiling.signal }).then(
      () => null,
      () => null,
    ),
  ]);
  ceiling.abort();

  // Read the side channel BEFORE anything is cleaned up: it is the only record
  // of the two pids that survives the harness, and both assertions need it.
  const pids: number[] = [];
  if (existsSync(sideChannel)) {
    const captured = JSON.parse(readFileSync(sideChannel, 'utf8')) as {
      pid: number;
      grandchildPid: number | null;
    };
    pids.push(captured.pid);
    if (captured.grandchildPid !== null) pids.push(captured.grandchildPid);
  }

  // The net under a red run: if the harness leaked — which is exactly what this
  // file exists to catch — the leak dies with this test rather than with the
  // next person who runs `ps`.
  parent.after(() => {
    if (outcome === null) child.kill('SIGKILL');
    for (const pid of pids) reapIfAlive(pid);
  });

  const drive: Drive = {
    code: outcome?.code ?? null,
    signal: outcome?.signal ?? null,
    output,
    pids,
  };

  await parent.test('AT3 — C4 still fails against an adapter that never kills the group', () => {
    assert.ok(
      outcome !== null,
      `the harness did not end within ${HARNESS_BOUND_MS}ms — with a live engine still held by ` +
        `a ChildProcess handle and a 60s clock armed, that IS the unreaped process group\n` +
        `output:\n${drive.output}`,
    );
    assert.notEqual(
      drive.code,
      0,
      `the reap must not neuter the check: C4 has to stay red against a non-conformant ` +
        `adapter\noutput:\n${drive.output}`,
    );
    assert.match(
      drive.output,
      /C4/,
      `the non-zero exit has to come from C4 itself, not from the harness failing to ` +
        `load\noutput:\n${drive.output}`,
    );
  });

  await parent.test('AT4 — and neither the engine nor its grandchild outlived it', async () => {
    assert.equal(
      drive.pids.length,
      2,
      `the harness captured ${drive.pids.length} pid(s); C4's fixture must leave both an engine ` +
        `and a grandchild for there to be anything to reap\noutput:\n${drive.output}`,
    );

    // A short poll for the same reason `bin.e2e.test.ts`'s AT16 has one: a
    // process killed while its parent was still up stays a zombie until the
    // kernel reparents it, and a zombie answers `kill(pid, 0)` like the living.
    for (let attempt = 0; attempt < 20 && drive.pids.some((pid) => alive(pid)); attempt += 1) {
      await delay(100);
    }

    for (const pid of drive.pids) {
      assert.ok(
        !alive(pid),
        `pid ${pid} outlived the case that reported it as an orphan — the run that finds the ` +
          `leak is the run that has to end it\noutput:\n${drive.output}`,
      );
    }
  });
});
