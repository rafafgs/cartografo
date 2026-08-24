/**
 * Single-process guard over the database file (t209, D1).
 *
 * D1 — only the server writes to the database — has a static half already:
 * `scripts/check-single-writer.mjs` keeps the driver confined to this directory,
 * at lint time. What it cannot see is a SECOND `cartografo up` against the same
 * `CARTOGRAFO_DB_PATH`: two processes, each of them a legitimate single writer,
 * migrating the same file and racing to mint the operator credential — a race
 * whose prize is two different tokens announced as if each were the only one.
 * This module is the runtime half of the same rule.
 *
 * A sidecar file and not `PRAGMA locking_mode = EXCLUSIVE`, deliberately: an
 * OS-level lock dies with the process holding it, leaving nothing to inspect,
 * and a control plane that took a `kill -9` would then be indistinguishable
 * from one that never ran. A file naming a pid can be READ — and a pid that
 * names nothing is exactly what makes a takeover safe instead of a guess. It
 * also keeps SQLite's own semantics untouched: how the database is opened does
 * not change, so whatever reads that file next (a backup, an operator's
 * `sqlite3 -readonly`) goes on working.
 *
 * The assumption, stated: one local filesystem and pids that mean something on
 * it. It is the same assumption the rest of the runner and CLI already make,
 * and the database is a local file by decision (D17).
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

/** What `acquireLock` writes, and the only thing it knows how to read back. */
interface LockContents {
  /** Process that owns the lock. */
  pid: number;
  /** When it took it. For a human reading the file; nothing depends on it. */
  since: string;
}

/**
 * Path of the lock that guards a database file.
 *
 * @param databaseFilePath Path of the database file.
 * @returns Path of the sidecar, next to the database.
 */
export function lockPath(databaseFilePath: string): string {
  return `${databaseFilePath}.lock`;
}

/**
 * Another control plane is already up over this database.
 *
 * It carries the pid and the path because the message is the whole answer the
 * operator gets: the number to look for (or to `kill`) and the file to look at.
 */
export class LockHeldError extends Error {
  /** Process that holds the lock. */
  readonly pid: number;
  /** Lock file it holds. */
  readonly path: string;

  constructor(pid: number, lockFilePath: string) {
    super(`cartografo: another control plane already owns ${lockFilePath} (pid ${pid})`);
    this.name = 'LockHeldError';
    this.pid = pid;
    this.path = lockFilePath;
  }
}

/** A lock taken. Releasing it is the only thing its holder can do. */
export interface Lock {
  /** Gives the lock back. Idempotent, and never touches somebody else's. */
  release: () => void;
}

/**
 * Reads the pid the lock file names.
 *
 * @param lockFile Path of the lock file.
 * @returns The pid, or `null` when the file is gone, unreadable or names no
 *   usable pid — a process killed between the `open` and the `write` leaves an
 *   empty file, and the three cases are one and the same to whoever asks.
 */
function readOwner(lockFile: string): number | null {
  let contents: string;
  try {
    contents = readFileSync(lockFile, 'utf8');
  } catch {
    return null;
  }

  let parsed: Partial<LockContents>;
  try {
    parsed = JSON.parse(contents) as Partial<LockContents>;
  } catch {
    return null;
  }

  const { pid } = parsed;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Is there a process under this pid?
 *
 * Signal `0` runs no handler: it only asks the kernel whether the pid can be
 * signalled. `EPERM` counts as ALIVE — it means the process exists and belongs
 * to somebody else, and reading it as dead would hand the database to two
 * writers on a machine where two users share it.
 *
 * @param pid Process id read from the lock file.
 * @returns `true` when the process exists.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Creates the lock file, or fails with `EEXIST`.
 *
 * `'wx'` is `O_CREAT | O_EXCL`: create-if-absent and the test-and-create are one
 * single syscall. That indivisibility is the whole mechanism — a `existsSync`
 * followed by a `writeFileSync` would be the very check-then-act race this
 * module exists to close.
 *
 * @param lockFile Path of the lock file.
 */
function takeFile(lockFile: string): void {
  const handle = openSync(lockFile, 'wx');
  try {
    const contents: LockContents = { pid: process.pid, since: new Date().toISOString() };
    writeSync(handle, `${JSON.stringify(contents)}\n`);
  } finally {
    closeSync(handle);
  }
}

/** Removes the lock file, saying nothing if it is already gone. */
function removeFile(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // Somebody else got there first: the goal was for it not to be there.
  }
}

/**
 * Takes the lock over a database file, or refuses to start.
 *
 * A lock left behind by a process that no longer exists is taken over with no
 * error and no ceremony: nobody is holding anything, and demanding a manual
 * cleanup after a `kill -9` would trade a real failure mode for a fake one — the
 * cost falls on the one-command start, which is a recorded quality
 * non-negotiable (`notas/2026-08-14-extension-and-quality.md`).
 *
 * @param databaseFilePath Path of the database file to be guarded.
 * @returns The lock, with what gives it back.
 * @throws {LockHeldError} When a LIVE process already owns the file.
 */
export function acquireLock(databaseFilePath: string): Lock {
  const lockFile = lockPath(databaseFilePath);

  // The directory, which until t209 was created by `openDatabase` — and which
  // now nobody would have created yet, because taking the lock first is the
  // whole point. `npx cartografo` against a `CARTOGRAFO_DB_PATH` in a directory
  // that does not exist is the ordinary first run, not an edge case.
  mkdirSync(path.dirname(lockFile), { recursive: true });

  // Two rounds, never more: the second only ever runs after an abandoned file
  // was removed, and needing a third would mean somebody is recreating it as
  // fast as it is deleted — at which point "another control plane owns it" has
  // stopped being a guess.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      takeFile(lockFile);
      return {
        release: () => {
          // Only if it is still OURS. Between the takeover of a stale lock and
          // this call there may be another owner, and releasing the lock of a
          // running control plane would open the door this module closes.
          if (readOwner(lockFile) !== process.pid) return;
          removeFile(lockFile);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const holder = readOwner(lockFile);
      if (holder !== null && isRunning(holder)) throw new LockHeldError(holder, lockFile);
      removeFile(lockFile);
    }
  }

  const holder = readOwner(lockFile);
  if (holder !== null) throw new LockHeldError(holder, lockFile);
  throw new Error(`cartografo: ${lockFile} is being recreated by another process`);
}
