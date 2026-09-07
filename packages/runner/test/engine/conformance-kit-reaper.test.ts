/**
 * `reapIfAlive`, the conformance kit's unconditional reaper (t468, AT1–AT2).
 *
 * The bug this covers is not a wrong answer, it is an abandoned process. Case
 * C4 of the kit deliberately starts an engine that ignores SIGTERM and leaves a
 * grandchild of its own behind, reads both pids, and then only ever hands them
 * to an ASSERTION. So the run that discovers an adapter did not kill its process
 * group is the same run that walks away from the survivors — which on
 * 2026-09-07 was five byte-identical stubs, the oldest 20h28m old, on a host
 * with 58 MB free.
 *
 * These two cases are the reaper itself, measured directly rather than through
 * the kit: it ends a process that SIGTERM cannot, and it says nothing at all
 * about one that is already gone. The second half matters as much as the first —
 * a reaper that logs is a reaper that turns every clean, conformant adapter's C4
 * into noise, and noise is what gets suppressed.
 *
 * English per the project's language convention.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { reapIfAlive } from '../../src/engine/conformance-kit.ts';

/**
 * The orphan's own command, byte for byte.
 *
 * Copied from `test/fixtures/fake-engine.mjs`'s grandchild rather than
 * paraphrased, because it is also what the census greps for: a `ps` sweep
 * looking for leftovers of this suite matches on this exact string.
 */
const SIGTERM_IMMUNE = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';

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
 * Polls until the pid is gone, and fails with the elapsed budget if it never is.
 *
 * The poll is for the REAPING and not for the kill: a process SIGKILLed while
 * this process is still its parent stays a zombie until the loop turns and node
 * harvests it, and a zombie answers `kill(pid, 0)` exactly like the living.
 */
async function awaitDeath(pid: number, deadlineMs = 5_000): Promise<void> {
  const limit = Date.now() + deadlineMs;
  while (Date.now() < limit) {
    if (!alive(pid)) return;
    await delay(25);
  }
  assert.fail(`process ${pid} was still alive ${deadlineMs}ms after reapIfAlive`);
}

test('AT1 — reapIfAlive ends a live, detached process that SIGTERM cannot', async (t) => {
  // `detached` is what makes the pid a group leader, which is what makes
  // `kill(-pid)` mean anything. It is also how the fake engine comes up, so the
  // shape under test is the shape in production.
  const stub = spawn(process.execPath, ['-e', SIGTERM_IMMUNE], {
    detached: true,
    stdio: 'ignore',
  });
  stub.unref();

  const pid = stub.pid;
  assert.equal(typeof pid, 'number', 'the stub did not come up, so there is nothing to reap');
  // The safety net for this very test: whatever the assertions below decide,
  // this case does not become the sixth orphan.
  t.after(() => {
    reapIfAlive(pid as number);
  });

  assert.ok(alive(pid as number), 'the stub has to be running before it can be reaped');

  // Deliberately NOT probing with a SIGTERM first: the handler is installed by
  // the stub's own first tick, so a SIGTERM sent from here races that tick and
  // would occasionally kill the process and turn this case red for a reason
  // that has nothing to do with the reaper. The immunity is by construction —
  // it is in the one-liner above.
  reapIfAlive(pid as number);

  await awaitDeath(pid as number);
});

test('AT2 — reapIfAlive is silent and non-throwing over an already-dead pid', async () => {
  // A process that ends on its own, awaited to its `exit`: by the time that
  // event fires node has harvested it, so the pid is genuinely gone rather than
  // a zombie still answering signal 0.
  const brief = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = brief.pid;
  assert.equal(typeof pid, 'number');
  await once(brief, 'exit');
  assert.ok(!alive(pid as number), 'the fixture process should already be gone');

  const written: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };

  // No `await` inside the window on purpose: `reapIfAlive` is synchronous, so
  // nothing else — the test reporter included — can write between the patch and
  // the restore.
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    reapIfAlive(pid as number);
    reapIfAlive(pid as number);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }

  assert.deepEqual(
    written,
    [],
    'reaping a pid that is already gone must be completely silent: a line here is a line on ' +
      'every conformant adapter\'s C4, which is how a warning stops being read',
  );
});
