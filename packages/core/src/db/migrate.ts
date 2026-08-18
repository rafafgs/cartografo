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
 *
 * ## The ledger is self-verifying (t279)
 *
 * The name of a migration file is the PRIMARY KEY it takes in
 * `schema_migrations`, in every database that has ever run — and until t279 that
 * key was all the ledger knew. Two ways of lying to it followed from that, and
 * both are checked at every `migrate()` call, before anything is applied:
 *
 * - **the file changed under an id that already ran.** That is what D20 did to
 *   nineteen migrations (same file, same id, translated content): the runner
 *   skips them, the server boots clean, and it dies later — mid-request — on a
 *   `no such column` of a name that only exists in the new schema. Now every
 *   applied row carries `checksum = sha256:<hex>` of the exact text `db.exec()`
 *   ran, and a file that no longer matches stops the startup by name;
 * - **the file is gone from disk under an id that already ran** — a rename. The
 *   old id has no file, the new name looks like a migration that never ran, and
 *   the next boot replays `CREATE TABLE` over tables that already exist. D24
 *   froze the ids for that reason, and this guard is what makes the rule bite
 *   instead of being a comment.
 *
 * The column is nullable, and that is not laziness: a row applied before it
 * existed has no way to know retroactively what its file looked like when it
 * ran. Those are back-filled ONCE from the file as it is today — recorded, never
 * verified, and reported through {@link MigrateOptions.onChecksumBackfilled}.
 * None of this repairs a database D20 already broke; `README.md` still says to
 * recreate those.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { Database } from './connection.ts';

/** Control table: what already ran, when, and from which file content. */
export const MIGRATIONS_TABLE = 'schema_migrations';

/** The column `0023_schema_migrations_checksum.sql` adds. */
export const CHECKSUM_COLUMN = 'checksum';

/** Algorithm prefix, explicit in the value (as in the skill pin, D4). */
export const CHECKSUM_PREFIX = 'sha256:';

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

/** What `migrate()` accepts beyond the handle and the directory. */
export interface MigrateOptions {
  /**
   * Called once per migration whose checksum had to be invented from the current
   * file, because it was applied by an earlier process than this one and the
   * column did not exist then. It is a warning, not an error: there is nothing to
   * compare that value against, so it is recorded and trusted.
   */
  onChecksumBackfilled?: (migrationId: string, migrationFile: string) => void;
}

const NAME_PATTERN = /^(\d+)_.+$/;

/**
 * Content address of a migration file.
 *
 * Deliberately NOT `domain/hash.ts`: that one canonicalizes JSON before hashing,
 * which is the right tool for a graph document and the wrong one for raw SQL
 * text. What has to be pinned here is the exact byte sequence `db.exec()` ran —
 * a moved comment IS a different migration for this purpose.
 *
 * @param content File content, as read.
 * @returns `sha256:` followed by the hex digest.
 */
export function checksumOf(content: string): string {
  return `${CHECKSUM_PREFIX}${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

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

/** Is the control table there yet? On a new database, before 0001, it is not. */
function controlTableExists(db: Database): boolean {
  const table = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(MIGRATIONS_TABLE);
  return table !== undefined;
}

/**
 * Does `schema_migrations` already carry the checksum column?
 *
 * Asked instead of assumed because of the self-reference at the heart of this
 * feature: the column is added by a migration, so on a brand-new database the
 * ones before it INSERT their rows inside the same `migrate()` call, into a
 * table that has two columns at that instant and three a moment later.
 *
 * @param db Open handle.
 * @returns `true` when the column is visible right now, in this transaction.
 */
function hasChecksumColumn(db: Database): boolean {
  if (!controlTableExists(db)) return false;
  const columns = db.prepare(`PRAGMA table_info(${MIGRATIONS_TABLE})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === CHECKSUM_COLUMN);
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
  if (!controlTableExists(db)) return new Set();

  const rows = db.prepare(`SELECT id FROM ${MIGRATIONS_TABLE}`).all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * Refuses to go on when an applied id has no file left on disk.
 *
 * The rename/delete guard (D24). It reads the ids and nothing else, so it bites
 * the same on a ledger written before the checksum column existed — which is
 * exactly the ledger a cleanup pass renaming the Portuguese file names would
 * meet.
 *
 * @param appliedIds Ids recorded in the ledger.
 * @param onDisk Migrations found in the directory, by id.
 * @param dir Directory that was read, quoted in the message.
 */
function guardAgainstMissingFiles(
  appliedIds: Set<string>,
  onDisk: Map<string, Migration>,
  dir: string,
): void {
  const missing = [...appliedIds].filter((id) => !onDisk.has(id)).sort();
  if (missing.length === 0) return;

  throw new Error(
    `applied migration missing on disk: ${missing.map((id) => `"${id}"`).join(', ')} ` +
      `${missing.length === 1 ? 'is' : 'are'} recorded in ${MIGRATIONS_TABLE}, ` +
      `but no file in ${dir} carries that name. A migration that already ran is never renamed ` +
      `or deleted (D24) — its name is the primary key of the ledger. Restore the file under its ` +
      `original name, or recreate the database.`,
  );
}

/**
 * Compares every recorded checksum against its file, and fills in what is NULL.
 *
 * Called ONCE per `migrate()` call, and where it is called from matters: before
 * the apply loop when the column was already there (so a divergence stops the
 * startup without applying anything else), after it when the column itself was
 * pending (there was no column to read before). See {@link migrate}.
 *
 * @param db Open handle.
 * @param onDisk Migrations found in the directory, by id.
 * @param previouslyApplied Ids that were in the ledger when this call started —
 *   the ones a back-fill is worth a word about (FR5).
 * @param onChecksumBackfilled Callback for that word.
 */
function reconcileChecksums(
  db: Database,
  onDisk: Map<string, Migration>,
  previouslyApplied: Set<string>,
  onChecksumBackfilled: (migrationId: string, migrationFile: string) => void,
): void {
  if (!hasChecksumColumn(db)) return;

  const recorded = db
    .prepare(`SELECT id, ${CHECKSUM_COLUMN} FROM ${MIGRATIONS_TABLE} ORDER BY id`)
    .all() as Array<{ id: string; checksum: string | null }>;
  const record = db.prepare(`UPDATE ${MIGRATIONS_TABLE} SET ${CHECKSUM_COLUMN} = ? WHERE id = ?`);

  for (const row of recorded) {
    const migration = onDisk.get(row.id);
    // Missing on disk is guardAgainstMissingFiles' business, and it already ran.
    if (migration === undefined) continue;

    const current = checksumOf(readFileSync(migration.path, 'utf8'));

    if (row.checksum === null) {
      record.run(current, row.id);
      // Silent for an id applied earlier in THIS same call: nothing had a chance
      // to diverge inside one process lifetime. Loud for one an earlier process
      // wrote, because that is a value nobody ever verified.
      if (previouslyApplied.has(row.id)) onChecksumBackfilled(row.id, migration.file);
      continue;
    }

    if (row.checksum !== current) {
      throw new Error(
        `applied migration changed on disk: "${row.id}" ran with content ${row.checksum}, ` +
          `and ${migration.file} is ${current} today. A migration that already ran is never ` +
          `edited in place (D20, D24) — the change would be skipped in silence here and surface ` +
          `later as an unrelated error mid-request. Restore the original content of the file, ` +
          `or recreate the database.`,
      );
    }
  }
}

/** Default for {@link MigrateOptions.onChecksumBackfilled}: one line on stderr. */
function reportChecksumBackfilled(migrationId: string, migrationFile: string): void {
  process.stderr.write(
    `cartografo: migration "${migrationId}" ran before the ledger recorded checksums; ` +
      `recording ${migrationFile} as it is on disk today, unverified\n`,
  );
}

/**
 * Applies the pending migrations, in order, one transaction per migration.
 *
 * @param db Open handle.
 * @param dir Directory with the `.sql` files.
 * @param options Optional hooks; see {@link MigrateOptions}.
 * @returns Ids applied IN THIS call, in order. Empty when there was nothing
 *   pending — that is the idempotent-startup case (FR3).
 */
export function migrate(db: Database, dir: string, options: MigrateOptions = {}): string[] {
  const onChecksumBackfilled = options.onChecksumBackfilled ?? reportChecksumBackfilled;

  const migrations = listMigrations(dir);
  const onDisk = new Map(migrations.map((migration) => [migration.id, migration]));
  const previouslyApplied = appliedMigrations(db);

  guardAgainstMissingFiles(previouslyApplied, onDisk, dir);

  // Before the loop whenever there is anything to read, so that a file edited in
  // place stops the startup without a pending migration being applied first. On
  // a ledger older than the column there is nothing to read yet, and the pass
  // moves to after the loop — by then 0023 has run and created it.
  const ledgerHadChecksums = hasChecksumColumn(db);
  if (ledgerHadChecksums) {
    reconcileChecksums(db, onDisk, previouslyApplied, onChecksumBackfilled);
  }

  const applied: string[] = [];

  for (const migration of migrations) {
    if (previouslyApplied.has(migration.id)) continue;

    const sql = readFileSync(migration.path, 'utf8');
    const checksum = checksumOf(sql);
    const step = db.transaction(() => {
      db.exec(sql);
      // Asked per row, inside the transaction: this migration may BE the one that
      // adds the column, and the two before it certainly ran without it.
      if (hasChecksumColumn(db)) {
        db.prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at, ${CHECKSUM_COLUMN}) VALUES (?, ?, ?)`,
        ).run(migration.id, new Date().toISOString(), checksum);
      } else {
        db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (id, applied_at) VALUES (?, ?)`).run(
          migration.id,
          new Date().toISOString(),
        );
      }
    });

    try {
      step();
    } catch (error) {
      throw new Error(`failed to apply migration "${migration.file}"`, { cause: error });
    }

    applied.push(migration.id);
  }

  if (!ledgerHadChecksums) {
    reconcileChecksums(db, onDisk, previouslyApplied, onChecksumBackfilled);
  }

  return applied;
}
