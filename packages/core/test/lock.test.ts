/**
 * Unit tests of the single-process guard on the database file (t209, FR2).
 *
 * D1 says only the server writes to the database, and `check-single-writer.mjs`
 * enforces that by reading the source — which stops a second MODULE from
 * touching the file, and does nothing at all about a second PROCESS. The lock
 * below is the runtime half of the same rule, and what has to be pinned here is
 * precisely what an acceptance test running two real commands cannot observe:
 * that the takeover of an abandoned lock is a decision about pid liveness, not
 * "the file was there, delete it".
 *
 * Repo convention (the same as `migrate.test.ts`): the module under test is
 * imported on demand, after an explicit `existsSync`, so that the initial red
 * says which artifact is missing instead of blowing up with a raw
 * ERR_MODULE_NOT_FOUND.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as LockModule from '../src/db/lock.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

let lockCache: typeof LockModule | null = null;

async function loadLock(): Promise<typeof LockModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'db', 'lock.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/db/lock.ts');
  lockCache ??= (await import(
    new URL('../src/db/lock.ts', import.meta.url).href
  )) as typeof LockModule;
  return lockCache;
}

/** An isolated temporary directory, removed at the end of the test. */
function temporaryArea(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t209-lock-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/**
 * A pid that is certainly not running.
 *
 * A short-lived child, awaited and reaped by `spawnSync`: by the time it
 * returns, the number it reports names nothing. Made up numbers do not work
 * here — a high pid is only PROBABLY free, and a test that silently stops
 * testing the takeover the day the machine wraps its pid counter is worse than
 * no test. The liveness check below is part of the fixture for that reason.
 */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(finished.error, undefined, 'could not spawn the short-lived child');
  const pid = finished.pid;
  assert.ok(typeof pid === 'number' && pid > 0, 'the short-lived child had no pid');
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    'fixture broken: the child spawnSync already reaped is still alive',
  );
  return pid;
}

/** The pid the lock file names, read the way `acquireLock` writes it. */
function ownerOf(lockFile: string): number {
  const contents = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: unknown };
  assert.equal(typeof contents.pid, 'number', `the lock file has no pid: ${lockFile}`);
  return contents.pid as number;
}

test('t209 AT — acquireLock creates <db>.lock naming the pid of whoever took it', async (t) => {
  const { acquireLock, lockPath } = await loadLock();

  const databaseFile = path.join(temporaryArea(t), 'cartografo.db');
  const lockFile = lockPath(databaseFile);
  assert.equal(lockFile, `${databaseFile}.lock`, 'the lock is a sidecar of the database file');
  assert.equal(existsSync(lockFile), false, 'nothing exists before the lock is taken');

  const lock = acquireLock(databaseFile);
  t.after(() => lock.release());

  assert.ok(existsSync(lockFile), 'acquireLock has to create the lock file');
  assert.equal(ownerOf(lockFile), process.pid, 'the lock names the pid of its own process');
  assert.match(
    readFileSync(lockFile, 'utf8'),
    new RegExp(String(process.pid)),
    'the pid is readable by a human opening the file',
  );
});

test('t209 AT — a second acquireLock against a held lock throws LockHeldError', async (t) => {
  const { acquireLock, LockHeldError, lockPath } = await loadLock();

  const databaseFile = path.join(temporaryArea(t), 'cartografo.db');
  const lockFile = lockPath(databaseFile);

  const first = acquireLock(databaseFile);
  t.after(() => first.release());

  // The holder is this very process, so the pid the error names is ours — which
  // is exactly what a second `cartografo up` needs printed: the number the
  // operator types into `kill`.
  assert.throws(
    () => acquireLock(databaseFile),
    (error: unknown) => {
      assert.ok(error instanceof LockHeldError, 'refusal has to be a LockHeldError');
      assert.equal(error.pid, process.pid);
      assert.equal(error.path, lockFile);
      assert.ok(
        error.message.includes(String(process.pid)),
        `the message has to name the pid: ${error.message}`,
      );
      assert.ok(
        error.message.includes(lockFile),
        `the message has to name the lock file: ${error.message}`,
      );
      assert.equal(
        error.message.trim().split('\n').length,
        1,
        'one single line: it is the whole thing the CLI prints (FR4)',
      );
      return true;
    },
  );

  assert.equal(ownerOf(lockFile), process.pid, 'the refused attempt does not touch the lock');
});

test('t209 AT — after release the lock can be taken again', async (t) => {
  const { acquireLock, lockPath } = await loadLock();

  const databaseFile = path.join(temporaryArea(t), 'cartografo.db');
  const lockFile = lockPath(databaseFile);

  acquireLock(databaseFile).release();
  assert.equal(existsSync(lockFile), false, 'release leaves no file behind');

  const second = acquireLock(databaseFile);
  t.after(() => second.release());
  assert.equal(ownerOf(lockFile), process.pid);
});

test('t209 AT — a lock naming a pid that is not running is taken over transparently', async (t) => {
  const { acquireLock, lockPath } = await loadLock();

  const databaseFile = path.join(temporaryArea(t), 'cartografo.db');
  const lockFile = lockPath(databaseFile);

  // What a control plane killed with SIGKILL leaves behind: nobody ran a
  // `release`, and the file stays there naming a process that no longer exists.
  // Refusing to start over that would turn one `kill -9` into a manual cleanup
  // step, which is the opposite of a one-command start.
  const abandoned = deadPid();
  writeFileSync(
    lockFile,
    `${JSON.stringify({ pid: abandoned, since: '2026-08-16T12:00:00.000Z' })}\n`,
    'utf8',
  );

  const lock = acquireLock(databaseFile);
  t.after(() => lock.release());

  assert.equal(ownerOf(lockFile), process.pid, 'the stale lock is taken over, not respected');
});

test('t209 AT — a lock file that names no pid at all is taken over too', async (t) => {
  const { acquireLock, lockPath } = await loadLock();

  const databaseFile = path.join(temporaryArea(t), 'cartografo.db');
  const lockFile = lockPath(databaseFile);

  // Half a write, or an empty file: a process killed between `open` and `write`
  // leaves one. There is no pid to check liveness of, and the only reading that
  // does not strand the operator forever is the same one as a dead pid.
  writeFileSync(lockFile, '', 'utf8');

  const lock = acquireLock(databaseFile);
  t.after(() => lock.release());

  assert.equal(ownerOf(lockFile), process.pid);
});

// ---------------------------------------------------------------------------
// t690 — on Windows `process.kill(pid, 0)` is not a liveness test (pid reuse; a
// terminated process whose handle is still held keeps `OpenProcess` working),
// so a lock owner is only alive when `tasklist` confirms the exact pid. Every
// test below injects the platform, `kill` and `spawnSync`: none of them reads
// `process.platform` to choose its path, and none needs a Windows machine.
// ---------------------------------------------------------------------------

const GHOST_PID = 424242;

type SpawnSyncFake = NonNullable<LockModule.LockSeams['spawnSync']>;
type KillFake = NonNullable<LockModule.LockSeams['kill']>;

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

/** A `spawnSync` that records every call and answers with `reply`, like the runner's stop test. */
function recordingSpawnSync(reply: Record<string, unknown>): {
  fake: SpawnSyncFake;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const fake = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return reply;
  }) as unknown as SpawnSyncFake;
  return { fake, calls };
}

/** A `kill` that says the pid can be signalled. */
const killSaysAlive: KillFake = (() => true) as unknown as KillFake;

/** A `kill` that throws an errno-coded error, like `process.kill` does. */
function killThrows(code: string): KillFake {
  return (() => {
    throw Object.assign(new Error(`kill ${code}`), { code });
  }) as unknown as KillFake;
}

/** A database file whose lock already names `pid`. */
function lockedBy(t: { after: (fn: () => void) => void }, lockPath: (p: string) => string, pid: number) {
  const databaseFile = path.join(temporaryArea(t), 'cartografo.db');
  const lockFile = lockPath(databaseFile);
  writeFileSync(
    lockFile,
    `${JSON.stringify({ pid, since: '2026-10-13T12:00:00.000Z' })}\n`,
    'utf8',
  );
  return { databaseFile, lockFile };
}

/** Asserts the refusal of a held lock and returns it. */
function assertHeld(
  LockHeldError: typeof LockModule.LockHeldError,
  lockFile: string,
  liveness: string | undefined,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof LockHeldError, 'refusal has to be a LockHeldError');
    assert.equal(error.pid, GHOST_PID);
    assert.equal(error.path, lockFile);
    assert.equal(error.liveness, liveness);
    assert.ok(error.message.includes(String(GHOST_PID)), `names the pid: ${error.message}`);
    assert.ok(error.message.includes(lockFile), `names the lock file: ${error.message}`);
    assert.equal(error.message.trim().split('\n').length, 1, 'one single line (t209)');
    if (liveness !== undefined) assert.ok(error.message.includes(liveness), error.message);
    return true;
  };
}

const NO_TASKS = 'INFO: No tasks are running which match the specified criteria.\r\n';
const OWNER_ROW = `"node.exe","${GHOST_PID}","Console","1","50,000 K"\r\n`;

for (const [name, stdout] of [
  ['t690 AT1 — win32, kill says alive, tasklist lists no row → lock is taken over', NO_TASKS],
  ['t690 AT2 — win32, tasklist empty stdout with status 0 → taken over', ''],
] as const) {
  test(name, async (t) => {
    const { acquireLock, lockPath } = await loadLock();
    const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
    const { fake } = recordingSpawnSync({ status: 0, stdout });

    const lock = acquireLock(databaseFile, { platform: 'win32', kill: killSaysAlive, spawnSync: fake });
    t.after(() => lock.release());

    assert.equal(ownerOf(lockFile), process.pid);
  });
}

test('t690 AT3 — win32, kill says alive, tasklist shows the pid → LockHeldError confirmed', async (t) => {
  const { acquireLock, lockPath, LockHeldError } = await loadLock();
  const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
  const { fake } = recordingSpawnSync({ status: 0, stdout: OWNER_ROW });

  assert.throws(
    () => acquireLock(databaseFile, { platform: 'win32', kill: killSaysAlive, spawnSync: fake }),
    assertHeld(LockHeldError, lockFile, 'confirmed by tasklist'),
  );
  assert.equal(ownerOf(lockFile), GHOST_PID, 'the refused attempt does not touch the lock');
});

test('t690 AT4 — win32, EPERM from kill, tasklist shows the pid → LockHeldError confirmed', async (t) => {
  const { acquireLock, lockPath, LockHeldError } = await loadLock();
  const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
  const { fake } = recordingSpawnSync({ status: 0, stdout: OWNER_ROW });

  assert.throws(
    () => acquireLock(databaseFile, { platform: 'win32', kill: killThrows('EPERM'), spawnSync: fake }),
    assertHeld(LockHeldError, lockFile, 'confirmed by tasklist'),
  );
  assert.equal(ownerOf(lockFile), GHOST_PID);
});

test('t690 AT5 — win32, tasklist rows that only resemble the pid are not a match', async (t) => {
  const { acquireLock, lockPath, LockHeldError } = await loadLock();

  const lookalikes =
    `"a.exe","${GHOST_PID}1","Console","1","10 K"\r\n` +
    `"b.exe","${String(GHOST_PID).slice(0, 5)}","Console","1","10 K"\r\n` +
    `"c.exe","7","Console","1","${GHOST_PID} K"\r\n` +
    `"${GHOST_PID}.exe","8","Console","1","10 K"\r\n`;
  {
    const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
    const { fake } = recordingSpawnSync({ status: 0, stdout: lookalikes });
    const lock = acquireLock(databaseFile, { platform: 'win32', kill: killSaysAlive, spawnSync: fake });
    t.after(() => lock.release());
    assert.equal(ownerOf(lockFile), process.pid, 'lookalike rows are not the owner');
  }

  // The image name is the FIRST field and may hold a comma: quoted-field parsing.
  {
    const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
    const { fake } = recordingSpawnSync({
      status: 0,
      stdout: `"my, app.exe","${GHOST_PID}","Console","1","10 K"\r\n`,
    });
    assert.throws(
      () => acquireLock(databaseFile, { platform: 'win32', kill: killSaysAlive, spawnSync: fake }),
      assertHeld(LockHeldError, lockFile, 'confirmed by tasklist'),
    );
  }
});

for (const [label, reply] of [
  ['ENOENT', { error: Object.assign(new Error('spawn tasklist.exe ENOENT'), { code: 'ENOENT' }), status: null }],
  ['ETIMEDOUT', { error: Object.assign(new Error('spawnSync tasklist.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null }],
  ['status 1', { status: 1, stdout: '', stderr: 'ERROR: Access denied\r\n' }],
  ['stdout not a string', { status: 0, stdout: null }],
] as const) {
  test(`t690 AT6 — win32, tasklist fails to run (${label}) → LockHeldError assumed alive`, async (t) => {
    const { acquireLock, lockPath, LockHeldError } = await loadLock();
    const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
    const { fake } = recordingSpawnSync(reply);

    assert.throws(
      () => acquireLock(databaseFile, { platform: 'win32', kill: killSaysAlive, spawnSync: fake }),
      assertHeld(LockHeldError, lockFile, 'tasklist unavailable, assumed alive'),
    );
    assert.equal(ownerOf(lockFile), GHOST_PID, 'fails closed: the lock is respected');
  });
}

test('t690 AT7 — win32, kill throws ESRCH → taken over without calling tasklist', async (t) => {
  const { acquireLock, lockPath } = await loadLock();
  const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
  const { fake, calls } = recordingSpawnSync({ status: 0, stdout: OWNER_ROW });

  const lock = acquireLock(databaseFile, { platform: 'win32', kill: killThrows('ESRCH'), spawnSync: fake });
  t.after(() => lock.release());

  assert.equal(ownerOf(lockFile), process.pid);
  assert.equal(calls.length, 0, 'a pid the kernel does not know needs no confirmation');
});

test('t690 AT8 — win32 tasklist invocation is exact', async (t) => {
  const { acquireLock, lockPath } = await loadLock();
  const { databaseFile } = lockedBy(t, lockPath, GHOST_PID);
  const { fake, calls } = recordingSpawnSync({ status: 0, stdout: NO_TASKS });

  const lock = acquireLock(databaseFile, { platform: 'win32', kill: killSaysAlive, spawnSync: fake });
  t.after(() => lock.release());

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, 'tasklist.exe');
  assert.deepEqual(calls[0]?.args, ['/FI', `PID eq ${GHOST_PID}`, '/NH', '/FO', 'CSV']);
  assert.equal(calls[0]?.options.encoding, 'utf8');
  assert.equal(calls[0]?.options.timeout, 5000);
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.ok(!calls[0]?.options.shell, 'no shell is ever involved');
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`t690 AT9 — ${platform}: tasklist is never called`, async (t) => {
    const { acquireLock, lockPath, LockHeldError } = await loadLock();

    {
      const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
      const { fake, calls } = recordingSpawnSync({ status: 0, stdout: NO_TASKS });
      assert.throws(
        () => acquireLock(databaseFile, { platform, kill: killSaysAlive, spawnSync: fake }),
        (error: unknown) => {
          assert.ok(error instanceof LockHeldError);
          assert.equal(
            error.message,
            `cartografo: another control plane already owns ${lockFile} (pid ${GHOST_PID})`,
          );
          assert.equal(error.liveness, undefined);
          return true;
        },
      );
      assert.equal(calls.length, 0);
    }

    {
      const { databaseFile, lockFile } = lockedBy(t, lockPath, GHOST_PID);
      const { fake, calls } = recordingSpawnSync({ status: 0, stdout: OWNER_ROW });
      const lock = acquireLock(databaseFile, { platform, kill: killThrows('ESRCH'), spawnSync: fake });
      t.after(() => lock.release());
      assert.equal(ownerOf(lockFile), process.pid);
      assert.equal(calls.length, 0);
    }
  });
}
