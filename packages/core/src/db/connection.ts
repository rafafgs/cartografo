/**
 * Connection to the embedded SQLite.
 *
 * This is the ONLY module in the repository allowed to import the SQLite driver
 * (D1: only the control plane writes to the database). Whoever needs the
 * database outside of here receives an already-open `Database` and uses the type
 * re-exported below — never the driver package. `scripts/check-single-writer.mjs`
 * turns that rule into a lint gate.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import SqliteDatabase from 'better-sqlite3';
import type { Database as DriverDatabase } from 'better-sqlite3';

/** Database handle seen by the rest of the core, without leaking the driver name. */
export type Database = DriverDatabase;

/** Default path of the database file, relative to the working directory. */
export const DEFAULT_DATABASE_PATH = path.join('.cartografo', 'cartografo.db');

/** Environment variable that overrides the default path. */
export const ENV_DATABASE_PATH = 'CARTOGRAFO_DB_PATH';

/**
 * Resolves the absolute path of the database file.
 *
 * @param env Environment to read `CARTOGRAFO_DB_PATH` from.
 * @returns Absolute path of the file.
 */
export function databasePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ENV_DATABASE_PATH]?.trim();
  return path.resolve(
    configured !== undefined && configured !== '' ? configured : DEFAULT_DATABASE_PATH,
  );
}

/**
 * Opens (creating the file and the directory, if missing) the database at the given path.
 *
 * Deliberately does NOT validate the file contents nor run any pragma: SQLite
 * only reads the header on the first query, and that is what makes the
 * `SELECT 1` of `checkDatabase` a real check in `/health` (FR4), instead of a
 * constant in disguise.
 *
 * @param filePath Path of the database file.
 * @returns Open handle.
 */
export function openDatabase(filePath: string): Database {
  mkdirSync(path.dirname(filePath), { recursive: true });
  return new SqliteDatabase(filePath);
}

/**
 * Turns on the control plane's operating pragmas.
 *
 * Kept out of `openDatabase` on purpose: a pragma is the first thing that
 * touches the file, and merging the two would make a corrupted database blow up
 * right at opening time, before there is a health route to report the problem.
 *
 * @param db Open handle.
 */
export function applyPragmas(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

/**
 * Database health check: a real `SELECT 1`.
 *
 * @param db Open handle.
 * @returns `'ok'` when the query answers, `'erro'` when the driver throws.
 */
export function checkDatabase(db: Database): 'ok' | 'erro' {
  try {
    const row = db.prepare('SELECT 1 AS one').get() as { one: number } | undefined;
    return row?.one === 1 ? 'ok' : 'erro';
  } catch {
    return 'erro';
  }
}
