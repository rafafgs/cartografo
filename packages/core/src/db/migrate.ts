/**
 * Migration runner: numbered `.sql` files, no ORM and no migration library.
 *
 * Contract of the migrations directory:
 *
 * - every `.sql` file starts with a number, followed by `_` and a name
 *   (`0001_init.sql`). The number decides the order; the name only documents;
 * - the file does NOT open a transaction of its own — this runner is what
 *   transacts, one transaction per migration, so that a migration breaking
 *   halfway leaves no residue;
 * - what already ran is kept in `schema_migrations`, which `0001_init.sql`
 *   creates itself. Before it exists, the applied set is empty.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Database } from './connection.ts';

/** Control table: what already ran, and when. */
export const MIGRATIONS_TABLE = 'schema_migrations';

/** A migration found on disk. */
export interface Migration {
  /** File name without the extension — this is what goes to `schema_migrations.id`. */
  id: string;
  /** Prefix number, already converted; it is the ordering criterion. */
  number: number;
  /** File name, as it is on disk. */
  file: string;
  /** Absolute path of the file. */
  path: string;
}

const NAME_PATTERN = /^(\d+)_.+$/;

/**
 * Reads the migrations directory and returns the migrations in numeric order.
 *
 * Fails loudly (instead of silently ignoring) on a `.sql` file without a numeric
 * prefix and on a repeated number: in both cases the application order would be
 * ambiguous, and a migration applied out of order is damage that is hard to undo.
 *
 * @param dir Directory with the `.sql` files.
 * @returns Migrations sorted by prefix number.
 */
export function listMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  const byNumber = new Map<number, string>();

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.sql')) continue;

    const base = file.slice(0, -'.sql'.length);
    const match = NAME_PATTERN.exec(base);
    if (match === null) {
      throw new Error(
        `migration named outside the "<number>_<name>.sql" pattern: "${file}" (in ${dir})`,
      );
    }

    const number = Number.parseInt(match[1], 10);
    const conflict = byNumber.get(number);
    if (conflict !== undefined) {
      throw new Error(
        `two migrations with number ${match[1]}: "${conflict}" and "${file}" (in ${dir})`,
      );
    }
    byNumber.set(number, file);

    migrations.push({ id: base, number, file, path: path.join(dir, file) });
  }

  // Numeric order, not alphabetical: "10_" comes AFTER "2_".
  return migrations.sort((a, b) => a.number - b.number);
}

/**
 * Ids already recorded in `schema_migrations`.
 *
 * When the table does not exist yet (a new database, before 0001), the set is
 * empty — that is not an error.
 *
 * @param db Open handle.
 * @returns Set of applied ids.
 */
export function appliedMigrations(db: Database): Set<string> {
  const table = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  if (table === undefined) return new Set();

  const rows = db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`).all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * Applies the pending migrations, in order, one transaction per migration.
 *
 * @param db Open handle.
 * @param dir Directory with the `.sql` files.
 * @returns Ids applied IN THIS call, in order. Empty when there was nothing
 *   pending — that is the idempotent-startup case (FR3).
 */
export function migrate(db: Database, dir: string): string[] {
  const alreadyApplied = appliedMigrations(db);
  const applied: string[] = [];

  for (const migration of listMigrations(dir)) {
    if (alreadyApplied.has(migration.id)) continue;

    const sql = readFileSync(migration.path, 'utf8');
    const step = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`).run(
        migration.id,
        new Date().toISOString(),
      );
    });

    try {
      step();
    } catch (error) {
      throw new Error(`failed to apply migration "${migration.file}"`, { cause: error });
    }

    applied.push(migration.id);
  }

  return applied;
}
