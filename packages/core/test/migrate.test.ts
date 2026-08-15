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

test('t165 AT7 — migration 0010 rebuilds proposta and round-trips the rows already there', async (t) => {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { listMigrations, migrate } = await loadMigrate();

  const base = temporaryArea(t);

  // The database is taken up to `0009` only — the schema as it was before this
  // ficha — and the row is seeded THERE, so what is asserted afterwards is a
  // real rebuild of a populated table and not a fresh CREATE.
  const upTo0009 = path.join(base, 'ate-0009');
  mkdirSync(upTo0009);
  const all = listMigrations(REAL_MIGRATIONS_DIR);
  const rebuild = all.find((migration) => migration.id.startsWith('0010_'));
  assert.ok(rebuild, 'artifact does not exist yet: packages/core/migrations/0010_proposta_aprovada.sql');
  assert.doesNotMatch(
    readFileSync(rebuild.path, 'utf8'),
    /\b(BEGIN|COMMIT|ROLLBACK)\b/i,
    'the migration does not open a transaction of its own: the runner is what transacts',
  );

  const earlier = all.filter((migration) => migration.number < 10);
  for (const migration of earlier) {
    writeMigration(upTo0009, migration.file, readFileSync(migration.path, 'utf8'));
  }

  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());
  applyPragmas(db);
  migrate(db, upTo0009);

  const before = db.prepare("SELECT name FROM pragma_table_info('proposta')").all() as Array<{
    name: string;
  }>;
  assert.ok(
    !before.some((column) => column.name === 'motivo_rejeicao'),
    'the point of the test is that the column is NOT there before 0010',
  );

  // A lineage, a version and two proposals — one that the soundness gate
  // rejected (its story is in `resultado`) and one still pending.
  const moment = '2026-08-15T12:00:00.000Z';
  const versionId = `sha256:${'a'.repeat(64)}`;
  db.prepare(
    `INSERT INTO grafo (id, classe, linhagem_tipo, versao_corrente_id, criado_em)
     VALUES ('redacao', 'redacao', 'base', ?, ?)`,
  ).run(versionId, moment);
  db.prepare(
    `INSERT INTO grafo_versao (id, grafo_id, versao_pai, snapshot, origem, criado_em)
     VALUES (?, 'redacao', NULL, '{}', 'manual', ?)`,
  ).run(versionId, moment);
  const seed = db.prepare(
    `INSERT INTO proposta (grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                           status, motivo_reversao, resultado, criado_em, atualizado_em)
     VALUES ('redacao', ?, '[]', '{"fonte":"telemetria"}', '{"nome":"x"}', ?, NULL, ?, ?, ?)`,
  );
  seed.run(versionId, 'rejeitada', '{"soundness":{"valido":false}}', moment, moment);
  seed.run(versionId, 'pendente', null, moment, moment);

  const previous = db
    .prepare('SELECT id, grafo_id, status, resultado, criado_em FROM proposta ORDER BY id')
    .all();
  assert.equal(previous.length, 2);

  // ...and now the rebuild.
  assert.deepEqual(migrate(db, REAL_MIGRATIONS_DIR), [rebuild.id], 'only 0010 was pending');

  assert.deepEqual(
    db.prepare('SELECT id, grafo_id, status, resultado, criado_em FROM proposta ORDER BY id').all(),
    previous,
    'every existing row survives the rebuild identical to itself',
  );
  assert.deepEqual(
    db.prepare('SELECT motivo_rejeicao FROM proposta ORDER BY id').all(),
    [{ motivo_rejeicao: null }, { motivo_rejeicao: null }],
    'no backfill: a gate-rejected row was never rejected by a human',
  );

  // The new vocabulary is accepted, and the old constraint still bites.
  db.prepare("UPDATE proposta SET status = 'aprovada' WHERE status = 'pendente'").run();
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM proposta WHERE status = 'aprovada'").get() as {
      n: number;
    }).n,
    1,
  );
  assert.throws(
    () => db.prepare("UPDATE proposta SET status = 'inventada' WHERE id = 1").run(),
    /CHECK/i,
    'the rebuilt table still refuses a status outside the vocabulary',
  );

  // The index the rebuild had to recreate, and the identity column it kept.
  const indexes = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'proposta'")
    .all() as Array<{ name: string }>;
  assert.ok(
    indexes.some((index) => index.name === 'proposta_por_grafo'),
    'proposta_por_grafo goes away with the dropped table and has to come back',
  );

  const inserted = db
    .prepare(
      `INSERT INTO proposta (grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                             status, criado_em, atualizado_em)
       VALUES ('redacao', ?, '[]', '{}', '{}', 'pendente', ?, ?)`,
    )
    .run(versionId, moment, moment);
  assert.equal(
    Number(inserted.lastInsertRowid),
    3,
    'AUTOINCREMENT keeps counting from where the seeded rows left it',
  );

  // And the rows that point AT a proposal still point at the same ones: the
  // rebuild drops and renames a table two other tables reference.
  assert.equal(
    db.prepare('PRAGMA foreign_key_check').all().length,
    0,
    'no dangling reference survives the drop/rename',
  );
});
