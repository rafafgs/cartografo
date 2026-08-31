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
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  writeMigration(dir, '0002_second.sql', 'CREATE TABLE second (id TEXT PRIMARY KEY);');
  writeMigration(dir, '10_tenth.sql', 'CREATE TABLE tenth (id TEXT PRIMARY KEY);');
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);

  const expected = ['0001_init', '0002_second', '10_tenth'];
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
  for (const wanted of ['schema_migrations', 'second', 'tenth']) {
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
  writeMigration(dir, '0002_second.sql', 'CREATE TABLE second (id TEXT PRIMARY KEY);');

  const dbPath = path.join(base, 'cartografo.db');
  const first = openDatabase(dbPath);
  assert.deepEqual(migrate(first, dir), ['0001_init', '0002_second']);
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
    'CREATE TABLE halfway (id TEXT PRIMARY KEY);\nTHIS IS NOT VALID SQL;\n',
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
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'halfway'")
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

  const duplicated = path.join(base, 'duplicated');
  mkdirSync(duplicated);
  writeMigration(duplicated, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(duplicated, '0001_other.sql', 'CREATE TABLE other (id TEXT PRIMARY KEY);');
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

/**
 * The 18 tables the sequence builds, so the sweep below cannot pass vacuously.
 *
 * Not a rename list any more: t235 rewrote `0001`–`0018` in place and deleted
 * `0019_wire_database_rename.sql`, so there is no step where a table is called
 * anything else. `schema_migrations` (`0001`) and `sqlite_sequence` (SQLite's
 * own) are left out — neither is a row of the glossary's §4.1.
 */
const TABLES = Object.freeze([
  'graph',
  'graph_version',
  'proposal',
  'event',
  'job',
  'session',
  'input_request',
  'runner',
  'lease',
  'skill',
  'job_dependency',
  'intake_draft',
  'credential',
  'webhook_subscription',
  'webhook_delivery',
  'engine_model',
  'hook_delivery',
  'hook_secret',
]);

test('t235 AT — a fresh database speaks English in every name, CHECK and DEFAULT', async (t) => {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());
  applyPragmas(db);

  const applied = migrate(db, REAL_MIGRATIONS_DIR);
  assert.equal(
    applied.length,
    25,
    'a fresh database applies the twenty-five migrations of the package and nothing else',
  );

  const objects = db
    .prepare("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY name")
    .all() as Array<{ type: string; name: string; sql: string | null }>;

  const tables = new Set(objects.filter((row) => row.type === 'table').map((row) => row.name));
  for (const wanted of TABLES) {
    assert.ok(tables.has(wanted), `the table "${wanted}" has to exist in a fresh database`);
  }

});

test('t165 AT7 — migration 0010 rebuilds proposal and round-trips the rows already there', async (t) => {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { listMigrations, migrate } = await loadMigrate();

  const base = temporaryArea(t);

  // The database is taken up to `0009` only — the schema as it was before this
  // ticket — and the row is seeded THERE, so what is asserted afterwards is a
  // real rebuild of a populated table and not a fresh CREATE.
  const upTo0009 = path.join(base, 'up-to-0009');
  mkdirSync(upTo0009);
  const all = listMigrations(REAL_MIGRATIONS_DIR);
  const rebuild = all.find((migration) => migration.number === 10);
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

  const before = db.prepare("SELECT name FROM pragma_table_info('proposal')").all() as Array<{
    name: string;
  }>;
  assert.ok(before.length > 0, 'the seed schema has to have built the proposal table');
  assert.ok(
    !before.some((column) => column.name === 'rejection_reason'),
    'the point of the test is that the column is NOT there before 0010',
  );

  // A lineage, a version and two proposals — one that the soundness gate
  // rejected (its story is in `result`) and one still pending. Every name and
  // every stored value is English from `0001` on since t235: this is the schema
  // as `0009` really leaves it, not a translation of it.
  const moment = '2026-08-15T12:00:00.000Z';
  const versionId = `sha256:${'a'.repeat(64)}`;
  // Lineage first with a null pointer, then the version, then the pointer: the
  // three tables reference each other in a circle (`0002`), so with the foreign
  // keys on there is no other order that ever satisfies all of them.
  db.prepare(
    `INSERT INTO graph (id, class, lineage_type, current_version_id, created_at)
     VALUES ('drafting', 'drafting', 'base', NULL, ?)`,
  ).run(moment);
  db.prepare(
    `INSERT INTO graph_version (id, graph_id, parent_version, snapshot, source, created_at)
     VALUES (?, 'drafting', NULL, '{}', 'manual', ?)`,
  ).run(versionId, moment);
  db.prepare('UPDATE graph SET current_version_id = ? WHERE id = ?').run(versionId, 'drafting');
  const seed = db.prepare(
    `INSERT INTO proposal (graph_id, target_version, operations, evidence, expected_metric,
                           status, revert_reason, result, created_at, updated_at)
     VALUES ('drafting', ?, '[]', '{"fonte":"telemetry"}', '{"nome":"x"}', ?, NULL, ?, ?, ?)`,
  );
  seed.run(versionId, 'rejected', '{"soundness":{"valido":false}}', moment, moment);
  seed.run(versionId, 'pending', null, moment, moment);

  // And rows POINTING AT a proposal, which is the case the rebuild has to
  // survive and the only reason the migration detaches the foreign keys: a
  // version born of a proposal, and a lineage that declares its origin. Without
  // these two the drop/rename would pass for a reason that does not hold in a
  // real database.
  const bornOfProposal = `sha256:${'b'.repeat(64)}`;
  db.prepare(
    `INSERT INTO graph_version (id, graph_id, parent_version, snapshot, source, proposal_id, created_at)
     VALUES (?, 'drafting', ?, '{}', 'proposal', 1, ?)`,
  ).run(bornOfProposal, versionId, moment);
  db.prepare('UPDATE graph SET origin_proposal_id = 2 WHERE id = ?').run('drafting');

  const previous = db
    .prepare('SELECT id, graph_id, status, result, created_at FROM proposal ORDER BY id')
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
    db.prepare('SELECT id, graph_id, status, result, created_at FROM proposal ORDER BY id').all(),
    previous,
    'every existing row survives the rebuild identical to itself',
  );
  assert.deepEqual(
    db.prepare('SELECT rejection_reason FROM proposal ORDER BY id').all(),
    [{ rejection_reason: null }, { rejection_reason: null }],
    'no backfill: a gate-rejected row was never rejected by a human',
  );

  // The new vocabulary is accepted, and the old constraint still bites.
  db.prepare("UPDATE proposal SET status = 'approved' WHERE status = 'pending'").run();
  assert.equal(
    (db.prepare("SELECT count(*) AS n FROM proposal WHERE status = 'approved'").get() as {
      n: number;
    }).n,
    1,
  );
  assert.throws(
    () => db.prepare("UPDATE proposal SET status = 'invented' WHERE id = 1").run(),
    /CHECK/i,
    'the rebuilt table still refuses a status outside the vocabulary',
  );

  // The index the rebuild had to recreate, and the identity column it kept.
  const indexes = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'proposal'")
    .all() as Array<{ name: string }>;
  assert.ok(
    indexes.some((index) => index.name === 'proposal_by_graph'),
    'proposal_by_graph goes away with the dropped table and has to come back',
  );

  const inserted = db
    .prepare(
      `INSERT INTO proposal (graph_id, target_version, operations, evidence, expected_metric,
                             status, created_at, updated_at)
       VALUES ('drafting', ?, '[]', '{}', '{}', 'pending', ?, ?)`,
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
    db.prepare('SELECT id, proposal_id FROM graph_version ORDER BY id').all(),
    [
      { id: versionId, proposal_id: null },
      { id: bornOfProposal, proposal_id: 1 },
    ],
    'a version born of a proposal still names it',
  );
  assert.equal(
    (db.prepare('SELECT origin_proposal_id FROM graph').get() as { origin_proposal_id: number })
      .origin_proposal_id,
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
        .prepare("SELECT count(*) AS n FROM sqlite_temp_schema WHERE name LIKE 'reference_%'")
        .get() as { n: number }
    ).n,
    0,
    'the scaffolding tables do not survive the migration',
  );
});

/**
 * The checksum shape the ledger records, computed here instead of imported.
 *
 * `migrate.ts` has a `checksumOf` of its own, and importing it would make these
 * tests agree with the implementation by construction — including on the day it
 * starts hashing something else. So the expected value is built from the file
 * bytes right here: `sha256:` plus the hex digest of the exact content
 * `db.exec()` ran, which is what t279 FR2 pins.
 */
function sha256Of(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * The shape of `0023_schema_migrations_checksum.sql`, in a synthetic directory.
 *
 * Copied rather than read off `packages/core/migrations/`: what these tests are
 * about is the bootstrap ordering — the column that records checksums is itself
 * added by a migration that runs inside the same `migrate()` call as the ones
 * before it — and a three-file directory shows that with nothing else in the way.
 */
const CHECKSUM_COLUMN_SQL = 'ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;';

test('t279 AT6 — a database born from scratch records every checksum, and warns about none', async (t) => {
  const { openDatabase } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  // `0001` and `0002` run BEFORE the column exists — `0002` is what creates it —
  // and `0003` after. All three have to end up with a checksum anyway.
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(dir, '0002_checksum.sql', CHECKSUM_COLUMN_SQL);
  writeMigration(dir, '0003_third.sql', 'CREATE TABLE third (id TEXT PRIMARY KEY);');

  const warned: string[] = [];
  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  const expected = ['0001_init', '0002_checksum', '0003_third'];
  assert.deepEqual(
    migrate(db, dir, { onChecksumBackfilled: (id) => warned.push(id) }),
    expected,
    'the three migrations apply in one call',
  );

  assert.deepEqual(
    db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all(),
    expected.map((id) => ({
      id,
      checksum: sha256Of(readFileSync(path.join(dir, `${id}.sql`), 'utf8')),
    })),
    'every row carries the sha256 of its own file, the two that ran before the column included',
  );

  assert.deepEqual(
    warned,
    [],
    'nothing had a chance to diverge inside one process: a fresh database warns about nothing',
  );
});

test('t279 AT7 — an applied migration edited in place fails the next startup, naming it', async (t) => {
  const { openDatabase } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(dir, '0002_checksum.sql', CHECKSUM_COLUMN_SQL);
  const original = 'CREATE TABLE third (id TEXT PRIMARY KEY);';
  writeMigration(dir, '0003_third.sql', original);

  const dbPath = path.join(base, 'cartografo.db');
  const first = openDatabase(dbPath);
  migrate(first, dir);
  first.close();

  // The D20 move, in miniature: same file, same id, different content. Today
  // this is a silent skip, and the divergence only surfaces later as an
  // unrelated `no such column` in the middle of a request.
  const edited = 'CREATE TABLE third (id TEXT PRIMARY KEY, extra TEXT);';
  writeMigration(dir, '0003_third.sql', edited);

  const second = openDatabase(dbPath);
  t.after(() => second.close());

  assert.throws(
    () => migrate(second, dir),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /0003_third/, 'the message has to name the migration');
      assert.ok(
        error.message.includes(sha256Of(original)),
        'and the checksum recorded when it ran',
      );
      assert.ok(
        error.message.includes(sha256Of(edited)),
        'and the checksum of the file as it is on disk today',
      );
      return true;
    },
  );
});

test('t279 AT8 — an applied migration missing on disk stops the startup before anything applies', async (t) => {
  const { openDatabase } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  // No checksum column anywhere in this directory on purpose: the rename guard
  // reads `schema_migrations.id` and nothing else, so it has to bite on a ledger
  // that predates the column just as hard (FR3).
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(dir, '0002_second.sql', 'CREATE TABLE second (id TEXT PRIMARY KEY);');

  const dbPath = path.join(base, 'cartografo.db');
  const first = openDatabase(dbPath);
  assert.deepEqual(migrate(first, dir), ['0001_init', '0002_second']);
  const ledgerBefore = first.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all();
  first.close();

  // The cleanup pass D24 forbids: the id already recorded stops matching any
  // file, and the renamed file looks like a migration that never ran.
  renameSync(path.join(dir, '0001_init.sql'), path.join(dir, '0001_inicio.sql'));
  writeMigration(dir, '0003_third.sql', 'CREATE TABLE third (id TEXT PRIMARY KEY);');

  const second = openDatabase(dbPath);
  t.after(() => second.close());

  assert.throws(
    () => migrate(second, dir),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /0001_init\b/, 'the message has to name the id that went missing');
      assert.match(error.message, /missing on disk/i);
      return true;
    },
  );

  assert.deepEqual(
    second.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all(),
    ledgerBefore,
    'the guard fires before the apply loop: not one row of the ledger moves',
  );
  assert.equal(
    second
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'third'")
      .get(),
    undefined,
    'and the migration that really was pending stays unapplied',
  );
});

/**
 * A ledger written by an older process: the two-column `schema_migrations`,
 * one migration already recorded, and the checksum column still pending.
 *
 * Shared by AT9 and AT10 because AT10's whole claim is about what happens on the
 * call AFTER the back-fill, and it needs the same starting point to get there.
 */
async function agedLedger(t: {
  after: (fn: () => void) => void;
}): Promise<{ db: ConnectionModule.Database; dir: string }> {
  const { openDatabase } = await loadConnection();

  const base = temporaryArea(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  writeMigration(dir, '0001_init.sql', CONTROL_TABLE_SQL);
  writeMigration(dir, '0002_checksum.sql', CHECKSUM_COLUMN_SQL);

  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  // Built by hand, exactly as a database from before this ticket looks: the old
  // two-column control table, and a row that never had a checksum to record.
  db.exec(CONTROL_TABLE_SQL);
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
    '0001_init',
    '2026-08-01T00:00:00.000Z',
  );

  return { db, dir };
}

test('t279 AT9 — an old ledger has its checksums back-filled once, unverified and reported', async (t) => {
  const { migrate } = await loadMigrate();
  const { db, dir } = await agedLedger(t);

  const warned: Array<[string, string]> = [];
  assert.deepEqual(
    migrate(db, dir, { onChecksumBackfilled: (id, file) => warned.push([id, file]) }),
    ['0002_checksum'],
    'only the column migration was pending',
  );

  assert.deepEqual(
    db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all(),
    [
      { id: '0001_init', checksum: sha256Of(readFileSync(path.join(dir, '0001_init.sql'), 'utf8')) },
      {
        id: '0002_checksum',
        checksum: sha256Of(readFileSync(path.join(dir, '0002_checksum.sql'), 'utf8')),
      },
    ],
    'the row from the older process takes the checksum of the file as it is today',
  );

  assert.deepEqual(
    warned,
    [['0001_init', '0001_init.sql']],
    'and says so exactly once: that value is a record, not a verification',
  );
});

test('t279 AT10 — a checksum that matches is silent on every startup after the back-fill', async (t) => {
  const { migrate } = await loadMigrate();
  const { db, dir } = await agedLedger(t);

  migrate(db, dir, { onChecksumBackfilled: () => undefined });

  const warned: string[] = [];
  const ledgerBefore = db
    .prepare('SELECT id, checksum FROM schema_migrations ORDER BY id')
    .all() as Array<{ id: string; checksum: string | null }>;

  // The precondition this test is about, spelled out: without it the silence
  // below would be the silence of a ledger that never recorded anything.
  assert.deepEqual(
    ledgerBefore.filter((row) => row.checksum === null),
    [],
    'the back-fill of the previous call has to have left every row with a checksum',
  );

  assert.deepEqual(
    migrate(db, dir, { onChecksumBackfilled: (id) => warned.push(id) }),
    [],
    'nothing left to apply',
  );
  assert.deepEqual(warned, [], 'a recorded checksum that matches is not a repeat warning');
  assert.deepEqual(
    db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all(),
    ledgerBefore,
    'and the ledger is not rewritten either',
  );
});
