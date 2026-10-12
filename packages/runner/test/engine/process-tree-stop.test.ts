/**
 * Stopping a process TREE, and what a stop reports (t684, AT1–AT6).
 *
 * `process.kill(-pid)` is a POSIX process group; on Windows it throws and the
 * fallback kills only the direct child. `stopProcessTree` is the one function
 * `ProcessLifecycle` and `ShellAdapter` both call, and these tests drive its
 * Windows branch on any machine by injecting `platform: 'win32'` and a fake
 * `spawnSync`. No test here reads `process.platform` to choose its path.
 */

import assert from 'node:assert/strict';
import { spawn, type spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

import {
  ProcessLifecycle,
  reportedExitCode,
  stopProcessTree,
} from '../../src/engine/process-lifecycle.ts';
import { ShellAdapter } from '../../src/engine/shell-adapter.ts';
import type { SessionListener, SessionStatus } from '../../src/engine/types.ts';

type SpawnSyncFake = typeof spawnSync;
type Call = { command: string; args: readonly string[]; options: Record<string, unknown> };

/** A `spawnSync` that records its calls and answers with `reply`. */
function recordingSpawnSync(
  reply: (call: Call) => Record<string, unknown>,
): { fake: SpawnSyncFake; calls: Call[] } {
  const calls: Call[] = [];
  const fake = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const call = { command, args, options };
    calls.push(call);
    return reply(call);
  }) as unknown as SpawnSyncFake;
  return { fake, calls };
}

/** A child that is a record of what was asked of it. */
function fakeChild(exitCode: number | null = null): {
  child: { pid: number; exitCode: number | null; kill: (signal?: NodeJS.Signals) => boolean };
  kills: Array<NodeJS.Signals | undefined>;
} {
  const kills: Array<NodeJS.Signals | undefined> = [];
  return {
    kills,
    child: {
      pid: 4242,
      exitCode,
      kill: (signal) => {
        kills.push(signal);
        return true;
      },
    },
  };
}

test('t684 AT1 — win32 calls taskkill once, for SIGTERM and SIGKILL alike', () => {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const { fake, calls } = recordingSpawnSync(() => ({ status: 0 }));
    const { child, kills } = fakeChild();
    const warnings: string[] = [];

    stopProcessTree(child, signal, {
      platform: 'win32',
      spawnSync: fake,
      onWarning: (line) => warnings.push(line),
    });

    assert.equal(calls.length, 1, `${signal}: taskkill exactly once`);
    assert.equal(calls[0]?.command, 'taskkill.exe');
    assert.deepEqual(calls[0]?.args, ['/PID', '4242', '/T', '/F']);
    assert.equal(calls[0]?.options.windowsHide, true);
    assert.deepEqual(kills, [], 'a successful taskkill leaves child.kill alone');
    assert.deepEqual(warnings, []);
  }
});

test('t684 AT2 — a failed taskkill warns once and falls back to child.kill', () => {
  const failed = recordingSpawnSync(() => ({ status: 128, stderr: 'ERROR: not found\n' }));
  const first = fakeChild();
  const warnings: string[] = [];
  stopProcessTree(first.child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: failed.fake,
    onWarning: (line) => warnings.push(line),
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.startsWith('could not stop process tree 4242: '), warnings[0]);
  assert.ok(warnings[0]?.includes('ERROR: not found'));
  assert.deepEqual(first.kills, ['SIGTERM']);

  const errored = recordingSpawnSync(() => ({ error: new Error('ENOENT'), status: null }));
  const second = fakeChild();
  const secondWarnings: string[] = [];
  stopProcessTree(second.child, 'SIGKILL', {
    platform: 'win32',
    spawnSync: errored.fake,
    onWarning: (line) => secondWarnings.push(line),
  });
  assert.equal(secondWarnings.length, 1);
  assert.ok(secondWarnings[0]?.startsWith('could not stop process tree 4242: '));
  assert.ok(secondWarnings[0]?.includes('ENOENT'));
  assert.deepEqual(second.kills, ['SIGKILL']);

  const throwing = fakeChild();
  throwing.child.kill = () => {
    throw new Error('already gone');
  };
  assert.doesNotThrow(() =>
    stopProcessTree(throwing.child, 'SIGTERM', { platform: 'win32', spawnSync: failed.fake }),
  );
});

test('t684 AT3 — a non-zero taskkill on a child that already exited is not a failure', () => {
  const { fake } = recordingSpawnSync(() => ({ status: 128 }));
  const { child, kills } = fakeChild(0);
  const warnings: string[] = [];

  stopProcessTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSync: fake,
    onWarning: (line) => warnings.push(line),
  });

  assert.deepEqual(warnings, []);
  assert.deepEqual(kills, []);
});

test('t684 AT4 — POSIX never touches taskkill; the group is signalled as before', async () => {
  const neverCalled = (() => {
    throw new Error('spawnSync must not be called off win32');
  }) as unknown as SpawnSyncFake;

  for (const platform of ['linux', 'darwin'] as const) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)'], {
      detached: true,
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const ended = once(child, 'exit');

    stopProcessTree(child, 'SIGTERM', { platform, spawnSync: neverCalled });

    const [, signal] = await ended;
    assert.equal(signal, 'SIGTERM', `${platform}: ended by the signal`);
  }

  const noPid = { pid: undefined, exitCode: null, kill: () => assert.fail('no pid, no kill') };
  assert.doesNotThrow(() =>
    stopProcessTree(noPid, 'SIGTERM', { platform: 'win32', spawnSync: neverCalled }),
  );
  assert.doesNotThrow(() =>
    stopProcessTree(noPid, 'SIGTERM', { platform: 'linux', spawnSync: neverCalled }),
  );
});

/* --- AT5, AT6: what the owners of a lifecycle report ------------------------------ */

/** Traps SIGTERM, says it is ready, and exits with code 3 when it is told to stop. */
const TRAP_SCRIPT =
  'process.on("SIGTERM",()=>process.exit(3));console.log("ready");setInterval(()=>{},1e3)';

/** A taskkill stand-in that does what taskkill would: ends the pid it was given. */
function killingSpawnSync(): { fake: SpawnSyncFake; calls: Call[] } {
  return recordingSpawnSync((call) => {
    process.kill(Number(call.args[1]), 'SIGTERM');
    return { status: 0 };
  });
}

interface Ended {
  status: SessionStatus;
  exitCode: number | null;
  finishes: number;
  lines: string[];
}

/** A listener that resolves `ended` on the first `onFinished`, and counts them. */
function listening(onFirstLine: () => void): { listener: SessionListener; ended: Promise<Ended> } {
  const lines: string[] = [];
  let finishes = 0;
  let resolve: (value: Ended) => void = () => undefined;
  const ended = new Promise<Ended>((done) => {
    resolve = done;
  });
  return {
    ended,
    listener: {
      onOutput(line) {
        lines.push(line);
        onFirstLine();
      },
      onFinished(status, exitCode) {
        finishes += 1;
        // Let a second, wrongly timed `onFinished` land before anyone counts.
        setTimeout(() => resolve({ status, exitCode, finishes, lines }), 100);
      },
    },
  };
}

async function runLifecycle(
  platform: NodeJS.Platform,
  fake: SpawnSyncFake,
  script: string,
  cancel: boolean,
): Promise<Ended> {
  const lifecycle = new ProcessLifecycle<undefined>({ graceMs: 200, platform, spawnSync: fake });
  let sessionId: string | null = null;
  let cancelled = false;
  // Only once the process said it is ready: a SIGTERM before its handler is
  // installed would end it by the signal, with no exit code at all.
  let ready = false;
  const tryCancel = () => {
    if (!cancel || cancelled || !ready || sessionId === null) return;
    cancelled = true;
    lifecycle.cancel(sessionId);
  };
  const heard = listening(() => {
    ready = true;
    tryCancel();
  });
  sessionId = await lifecycle.start(
    { workingDir: process.cwd(), timeoutSeconds: 30 },
    heard.listener,
    {
      command: { command: process.execPath, args: ['-e', script] },
      environment: () => ({ ...process.env }),
      state: undefined,
    },
  );
  tryCancel();
  return await heard.ended;
}

test('t684 AT5 — an ordered stop reports a null exit code on win32 only', async () => {
  const win32 = killingSpawnSync();
  const onWindows = await runLifecycle('win32', win32.fake, TRAP_SCRIPT, true);
  assert.equal(onWindows.status, 'cancelled');
  assert.equal(onWindows.exitCode, null, 'taskkill leaves no exit code worth reporting');
  assert.equal(onWindows.finishes, 1);
  assert.equal(win32.calls[0]?.command, 'taskkill.exe');

  const neverCalled = (() => {
    throw new Error('not on linux');
  }) as unknown as SpawnSyncFake;
  const onLinux = await runLifecycle('linux', neverCalled, TRAP_SCRIPT, true);
  assert.equal(onLinux.status, 'cancelled');
  assert.equal(onLinux.exitCode, 3, 'the real signal path keeps the real exit code');

  const natural = await runLifecycle('win32', neverCalled, 'process.exit(2)', false);
  assert.equal(natural.status, 'failed');
  assert.equal(natural.exitCode, 2, 'no stop was ordered, so the code is the real one');

  assert.equal(reportedExitCode(5, true, 'win32'), null);
  assert.equal(reportedExitCode(5, false, 'win32'), 5);
  assert.equal(reportedExitCode(5, true, 'linux'), 5);
});

async function runShell(
  fake: SpawnSyncFake,
): Promise<{ ended: Ended; calls?: undefined }> {
  const adapter = new ShellAdapter({
    commandBuilder: () => ({ command: process.execPath, args: ['-e', TRAP_SCRIPT] }),
    environmentBuilder: () => ({ ...process.env }),
    graceMs: 200,
    platform: 'win32',
    spawnSync: fake,
  });
  let sessionId: string | null = null;
  let cancelled = false;
  let ready = false;
  const tryCancel = () => {
    if (cancelled || !ready || sessionId === null) return;
    cancelled = true;
    void adapter.cancel(sessionId);
  };
  const heard = listening(() => {
    ready = true;
    tryCancel();
  });
  sessionId = await adapter.startSession(
    { workingDir: process.cwd(), instructions: '', prompt: '', timeoutSeconds: 30 },
    heard.listener,
  );
  tryCancel();
  return { ended: await heard.ended };
}

test('t684 AT6 — the shell adapter shares the Windows stop and the null exit code', async () => {
  const ok = killingSpawnSync();
  const { ended } = await runShell(ok.fake);
  assert.equal(ended.status, 'cancelled');
  assert.equal(ended.exitCode, null);
  assert.equal(ok.calls.length >= 1, true);
  assert.equal(ok.calls[0]?.command, 'taskkill.exe');
  assert.equal(ok.calls[0]?.args[0], '/PID');
  assert.equal(ended.finishes, 1);

  // taskkill fails and says so: the warning arrives as output, before the end,
  // and the fallback (child.kill, a real SIGTERM) still stops the process.
  const failing = recordingSpawnSync(() => ({ status: 128, stderr: 'boom' }));
  const { ended: afterFailure } = await runShell(failing.fake);
  const warning = afterFailure.lines.find((line) => line.startsWith('could not stop process tree'));
  assert.ok(warning, `no warning line in ${JSON.stringify(afterFailure.lines)}`);
  assert.ok(warning.includes('boom'));
  assert.equal(afterFailure.finishes, 1, 'onFinished exactly once');
});
