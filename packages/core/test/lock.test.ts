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
