/**
 * Acceptance tests of the migration runner (t100, FR3/FR5).
 *
 * They cover numeric application order, recording in `schema_migrations`,
 * idempotence of the second startup and atomicity (a migration that breaks
 * halfway leaves no residue).
 *
 * Repo convention (the same as `tests/schema-grafo.test.mjs`): the module under
 * test is imported on demand, after an explicit `existsSync`, so that the
 * initial red says which artifact is missing instead of blowing up with a raw
 * ERR_MODULE_NOT_FOUND.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REAL_MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;

async function loadConnection(): Promise<typeof ConnectionModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'db', 'connection.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/db/connection.ts');
  connectionCache ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  return connectionCache;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'db', 'migrate.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/db/migrate.ts');
  migrateCache ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  return migrateCache;
}

/** An isolated temporary directory, removed at the end of the test. */
function temporaryArea(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function writeMigration(dir: string, file: string, sql: string): void {
  writeFileSync(path.join(dir, file), sql, 'utf8');
}

const CONTROL_TABLE_SQL =
  'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);';

test('AT1 — migrations run in numeric (not alphabetical) order and stay recorded', async (t) => {
  const { openDatabase } = await loadConnection();
  const { listMigrations, migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);

  // Written out of order on disk on purpose. Besides `0002` coming before
  // `0001`, a `10_` goes in that in ALPHABETICAL order falls before `2_` — only
  // ordering by the prefix number returns the right sequence.
  writeMigration(dir, '0002_segunda.sql', 'CREATE TABLE segunda (id TEXT PRIMARY KEY);');
  writeMigration(dir, '10_decima.sql', 'CREATE TABLE decima (id TEXT PRIMARY KEY);');
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);

  const expected = ['0001_init', '0002_segunda', '10_decima'];
  assert.deepEqual(
    listMigrations(dir).map((m) => m.id),
    expected,
    'listMigrations has to sort by the prefix number',
  );

  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  assert.deepEqual(migrate(db, dir), expected, 'migrate returns the applied ids, in order');

  const recorded = db
    .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
    .all() as Array<{ id: string; applied_at: string }>;
  assert.deepEqual(
    recorded.map((row) => row.id),
    expected,
    'every applied migration has to stay recorded in schema_migrations',
  );
  for (const row of recorded) {
    assert.match(
      row.applied_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      `applied_at of "${row.id}" has to be an ISO-8601 instant`,
    );
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map((row) => row.name);
  for (const wanted of ['decima', 'schema_migrations', 'segunda']) {
    assert.ok(names.includes(wanted), `the table "${wanted}" has to have been created`);
  }
});

test('AT2 — a second startup over an already migrated database reapplies nothing', async (t) => {
  const { openDatabase } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(dir, '0002_segunda.sql', 'CREATE TABLE segunda (id TEXT PRIMARY KEY);');

  const dbPath = path.join(base, 'cartografo.db');
  const first = openDatabase(dbPath);
  assert.deepEqual(migrate(first, dir), ['0001_init', '0002_segunda']);
  const afterFirst = first
    .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
    .all();
  first.close();

  // A new connection over an already migrated database: it is FR3's idempotent startup.
  const second = openDatabase(dbPath);
  t.after(() => second.close());

  assert.deepEqual(migrate(second, dir), [], 'no migration can be reapplied');
  assert.deepEqual(
    second.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all(),
    afterFirst,
    'not even the applied_at of the old migrations can change on the second startup',
  );

  // A third call on the same connection is zero noise too.
  assert.deepEqual(migrate(second, dir), []);
});

test('AT3 — a migration that breaks halfway leaves no residue (one transaction per migration)', async (t) => {
  const { openDatabase } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(
    dir,
    '0002_quebrada.sql',
    'CREATE TABLE meio_do_caminho (id TEXT PRIMARY KEY);\nISTO NAO E SQL VALIDO;\n',
  );

  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  assert.throws(() => migrate(db, dir), /0002_quebrada/, 'the error has to name the guilty migration');

  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
    id: string;
  }>;
  assert.deepEqual(
    applied.map((row) => row.id),
    ['0001_init'],
    'the migration that failed cannot stay recorded',
  );

  const residue = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'meio_do_caminho'")
    .get();
  assert.equal(residue, undefined, 'what the broken migration created before failing has to be gone');
});

test('AT4 — a .sql file without a numeric prefix and a duplicated number fail loudly', async (t) => {
  const { listMigrations } = await loadMigrate();

  const base = temporaryArea(t);

  const withoutPrefix = path.join(base, 'sem-prefixo');
  mkdirSync(withoutPrefix);
  writeMigration(withoutPrefix, 'init.sql', CONTROL_TABLE_SQL);
  assert.throws(() => listMigrations(withoutPrefix), /init\.sql/);

  const duplicated = path.join(base, 'duplicado');
  mkdirSync(duplicated);
  writeMigration(duplicated, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(duplicated, '0001_outra.sql', 'CREATE TABLE outra (id TEXT PRIMARY KEY);');
  assert.throws(() => listMigrations(duplicated), /0001/);
});

test('AT5 — the package 0001_init.sql creates schema_migrations with id and applied_at', async (t) => {
  const { openDatabase } = await loadConnection();
  const { migrate } = await loadMigrate();

  const initPath = path.join(REAL_MIGRATIONS_DIR, '0001_init.sql');
  assert.ok(existsSync(initPath), 'artifact does not exist yet: packages/core/migrations/0001_init.sql');

  const sql = readFileSync(initPath, 'utf8');
  assert.doesNotMatch(
    sql,
    /\b(BEGIN|COMMIT|ROLLBACK)\b/i,
    'the migration does not open a transaction of its own: the runner is what transacts',
  );

  const base = temporaryArea(t);
  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  const applied = migrate(db, REAL_MIGRATIONS_DIR);
  assert.ok(applied.includes('0001_init'), 'the first migration of the package has to be 0001_init');

  const columns = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{
    name: string;
    type: string;
    pk: number;
    notnull: number;
  }>;
  const byName = new Map(columns.map((column) => [column.name, column]));

  const id = byName.get('id');
  assert.ok(id, 'schema_migrations has to have the id column');
  assert.equal(id.type.toUpperCase(), 'TEXT');
  assert.equal(id.pk, 1, 'id is the primary key');

  const appliedAt = byName.get('applied_at');
  assert.ok(appliedAt, 'schema_migrations has to have the applied_at column');
  assert.equal(appliedAt.type.toUpperCase(), 'TEXT');
  assert.equal(appliedAt.notnull, 1, 'applied_at is NOT NULL');
});
