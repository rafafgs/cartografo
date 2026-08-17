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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

test('t182 AT — the shipped migrations directory has no repeated number', async () => {
  const { listMigrations } = await loadMigrate();

  // Counted straight off the disk, NOT through `listMigrations`: this is the
  // guard for the collision that two merged lines produce (0010 twice), and it
  // has to keep biting even if the runner one day stops throwing on its own.
  const byNumber = new Map<number, string[]>();
  for (const file of readdirSync(REAL_MIGRATIONS_DIR)) {
    if (!file.endsWith('.sql')) continue;
    const match = /^(\d+)_/.exec(file);
    assert.ok(match, `migration named outside the "<number>_<name>.sql" pattern: "${file}"`);
    const number = Number.parseInt(match[1], 10);
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }

  const collisions = [...byNumber.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(
    collisions,
    [],
    'two migrations sharing a number make the application order ambiguous, and the control plane refuses to start',
  );

  // And the consequence the ticket is actually about: this directory boots.
  assert.doesNotThrow(() => listMigrations(REAL_MIGRATIONS_DIR));
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

/** The 15 tables §4.1 renames, in the glossary's own order. */
const RENAMED_TABLES = Object.freeze([
  'graph',
  'graph_version',
  'proposal',
  'event',
  'job',
  'session',
  'input_request',
  'job_dependency',
  'intake_draft',
  'credential',
  'webhook_subscription',
  'webhook_delivery',
  'engine_model',
  'hook_delivery',
  'hook_secret',
]);

/** The three §4.1 already spells in English — no `RENAME TO` touches them. */
const UNCHANGED_TABLES = Object.freeze(['runner', 'lease', 'skill']);

/** The Portuguese spellings §4.1 retires; no table and no index may still carry one. */
const RETIRED_TABLE_WORDS = Object.freeze([
  'grafo',
  'grafo_versao',
  'proposta',
  'evento',
  'trabalho',
  'sessao',
  'pergunta',
  'trabalho_dependencia',
  'intake_rascunho',
  'credencial',
  'assinatura_webhook',
  'entrega_webhook',
  'motor_modelo',
  'entrega_gancho',
  'segredo_gancho',
]);

test('t229 AT — after 0019 the schema speaks the English of glossario-wire.md §4.1', async (t) => {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());
  applyPragmas(db);

  migrate(db, REAL_MIGRATIONS_DIR);

  const tables = new Set(
    (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  for (const wanted of [...RENAMED_TABLES, ...UNCHANGED_TABLES]) {
    assert.ok(tables.has(wanted), `the table "${wanted}" has to exist after the rename`);
  }

  // Indexes as well as tables: SQLite renames the COLUMNS an index references on
  // its own, never the index's own name, so every one of them that spelled a
  // retired word has to have been dropped and recreated by hand (FR2).
  const objects = db
    .prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name")
    .all() as Array<{ type: string; name: string }>;

  const survivors = objects
    .filter((row) =>
      RETIRED_TABLE_WORDS.some((word) => new RegExp(`(^|_)${word}(_|$)`).test(row.name)),
    )
    .map((row) => `${row.type} ${row.name}`);

  assert.deepEqual(
    survivors,
    [],
    'no table and no index may still be named after a §4.1 Portuguese word',
  );
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

  // t209, FR1: the operating pragmas include a wait. Without it, a connection
  // that finds the file locked for a millisecond — an operator's read-only
  // inspection, a backup — gets SQLITE_BUSY in the face instead of waiting.
  assert.equal(
    db.pragma('busy_timeout', { simple: true }),
    5000,
    'applyPragmas has to set busy_timeout = 5000 (t209, FR1)',
  );

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
  // Lineage first with a null pointer, then the version, then the pointer: the
  // three tables reference each other in a circle (`0002`), so with the foreign
  // keys on there is no other order that ever satisfies all of them.
  db.prepare(
    `INSERT INTO grafo (id, classe, linhagem_tipo, versao_corrente_id, criado_em)
     VALUES ('redacao', 'redacao', 'base', NULL, ?)`,
  ).run(moment);
  db.prepare(
    `INSERT INTO grafo_versao (id, grafo_id, versao_pai, snapshot, origem, criado_em)
     VALUES (?, 'redacao', NULL, '{}', 'manual', ?)`,
  ).run(versionId, moment);
  db.prepare('UPDATE grafo SET versao_corrente_id = ? WHERE id = ?').run(versionId, 'redacao');
  const seed = db.prepare(
    `INSERT INTO proposta (grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                           status, motivo_reversao, resultado, criado_em, atualizado_em)
     VALUES ('redacao', ?, '[]', '{"fonte":"telemetria"}', '{"nome":"x"}', ?, NULL, ?, ?, ?)`,
  );
  seed.run(versionId, 'rejeitada', '{"soundness":{"valido":false}}', moment, moment);
  seed.run(versionId, 'pendente', null, moment, moment);

  // And rows POINTING AT a proposal, which is the case the rebuild has to
  // survive and the only reason the migration defers the foreign keys: a
  // version born of a proposal, and a lineage that declares its origin. Without
  // these two the drop/rename would pass for a reason that does not hold in a
  // real database.
  const bornOfProposal = `sha256:${'b'.repeat(64)}`;
  db.prepare(
    `INSERT INTO grafo_versao (id, grafo_id, versao_pai, snapshot, origem, proposta_id, criado_em)
     VALUES (?, 'redacao', ?, '{}', 'proposta', 1, ?)`,
  ).run(bornOfProposal, versionId, moment);
  db.prepare('UPDATE grafo SET origem_proposta_id = 2 WHERE id = ?').run('redacao');

  const previous = db
    .prepare('SELECT id, grafo_id, status, resultado, criado_em FROM proposta ORDER BY id')
    .all();
  assert.equal(previous.length, 2);

  // ...and now the rebuild, applied from a directory that stops AT it instead
  // of from the package one. What this test is about is the 0010 step over a
  // populated table; reading the real directory made the assertion below also
  // claim that nothing had ever landed after 0010, and that claim expires the
  // day the next migration arrives — as it did in t182.
  writeMigration(upTo0009, rebuild.file, readFileSync(rebuild.path, 'utf8'));
  assert.deepEqual(migrate(db, upTo0009), [rebuild.id], 'only the rebuild was pending');

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

  // And the rows that point AT a proposal still point at the SAME ones. This is
  // the assertion the rebuild was rewritten for: the first version of the
  // migration deferred the foreign keys instead of detaching these two
  // references, and a database with a single applied proposal did not migrate
  // at all.
  assert.deepEqual(
    db.prepare('SELECT id, proposta_id FROM grafo_versao ORDER BY id').all(),
    [
      { id: versionId, proposta_id: null },
      { id: bornOfProposal, proposta_id: 1 },
    ],
    'a version born of a proposal still names it',
  );
  assert.equal(
    (db.prepare('SELECT origem_proposta_id FROM grafo').get() as { origem_proposta_id: number })
      .origem_proposta_id,
    2,
    'and so does a lineage that declares its origin',
  );
  assert.equal(
    db.prepare('PRAGMA foreign_key_check').all().length,
    0,
    'no dangling reference survives the drop/rename',
  );
  assert.equal(
    (
      db
        .prepare("SELECT count(*) AS n FROM sqlite_temp_schema WHERE name LIKE 'referencia_%'")
        .get() as { n: number }
    ).n,
    0,
    'the scaffolding tables do not survive the migration',
  );
});
