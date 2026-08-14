/**
 * Acceptance tests of the credential repository (t124, FR1/FR2).
 *
 * The whole point of this layer is what it does NOT keep: the raw token is
 * returned exactly once, at issuance, and only its SHA-256 digest reaches the
 * table. Whoever steals the database file steals nothing that authenticates —
 * that is the property the first test demands, by sweeping every column of the
 * row for the raw value instead of trusting the `hash` column's name.
 *
 * The module is loaded on demand, behind an `existsSync`, for the same reason as
 * `test/support.ts`: on the initial red the failure has to NAME the missing
 * artifact instead of blowing up with a module resolution error.
 *
 * The column names below are Portuguese because the table is (`credencial`,
 * `criada_em`, `revogada_em`), like every other domain table; the TypeScript
 * around it is English (D18, and the ticket's Refinement Log).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import { MIGRATIONS_DIR, requireArtifacts } from './support.ts';

/** Artifacts this file exercises. */
const T124_ARTIFACTS = Object.freeze({
  migration: 'migrations/0007_credential.sql',
  repository: 'src/repositories/credentials.ts',
});

/** The slice of `node:test`'s context this file uses. */
interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

/** A migrated, throwaway database — no HTTP: this file is about the repository. */
async function openMigrated(t: TestHook): Promise<Database> {
  requireArtifacts(T124_ARTIFACTS.migration, T124_ARTIFACTS.repository);

  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t124-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return db;
}

async function loadRepository(): Promise<typeof CredentialsModule> {
  return await load<typeof CredentialsModule>(T124_ARTIFACTS.repository);
}

test('t124 AT — the migration creates `credencial` with the declared shape', async (t) => {
  const db = await openMigrated(t);

  const columns = db.prepare('PRAGMA table_info(credencial)').all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;

  assert.deepEqual(
    columns.map((column) => column.name).sort(),
    ['criada_em', 'hash', 'id', 'revogada_em', 'runner_id', 'tipo'].sort(),
    'the table carries exactly the six declared columns (FR1)',
  );

  const required = new Set(
    columns.filter((column) => column.notnull === 1).map((column) => column.name),
  );
  assert.ok(required.has('tipo'), 'tipo is NOT NULL');
  assert.ok(required.has('hash'), 'hash is NOT NULL');
  assert.ok(required.has('criada_em'), 'criada_em is NOT NULL');
  assert.ok(!required.has('runner_id'), 'runner_id is nullable: a user credential has no runner');
  assert.ok(!required.has('revogada_em'), 'revogada_em is nullable: a live credential has no date');

  // The CHECK is what keeps the type vocabulary closed — `runner` is declared
  // now precisely so the pairing ticket needs no second migration on this table.
  assert.throws(
    () =>
      db
        .prepare('INSERT INTO credencial (tipo, hash, criada_em) VALUES (?, ?, ?)')
        .run('inventado', 'x'.repeat(64), new Date().toISOString()),
    /CHECK/i,
    'only `usuario` and `runner` are accepted types',
  );
});

test('t124 AT — issueCredential returns the raw token once and persists only its hash', async (t) => {
  const db = await openMigrated(t);
  const { issueCredential } = await loadRepository();

  const issued = issueCredential(db, { tipo: 'usuario' });

  assert.equal(typeof issued.id, 'number');
  assert.match(issued.token, /^[0-9a-f]{64}$/, '32 random bytes, in hex (Refinement Log)');

  const stored = db.prepare('SELECT * FROM credencial WHERE id = ?').get(issued.id) as Record<
    string,
    unknown
  >;
  assert.equal(stored.tipo, 'usuario');
  assert.equal(stored.runner_id, null);
  assert.equal(stored.revogada_em, null);
  assert.equal(typeof stored.criada_em, 'string');
  assert.equal(
    stored.hash,
    createHash('sha256').update(issued.token).digest('hex'),
    'what is stored is the SHA-256 digest of the raw token',
  );

  // Not "the hash column does not hold the token" — NO column does. The raw
  // value is unrecoverable from the database, whatever the column names say.
  for (const [column, value] of Object.entries(stored)) {
    assert.notEqual(value, issued.token, `the raw token leaked into "${column}"`);
  }

  const second = issueCredential(db, { tipo: 'usuario' });
  assert.notEqual(second.token, issued.token, 'every issuance is a fresh random token');
});

test('t124 AT — verifyToken resolves a live credential and refuses everything else', async (t) => {
  const db = await openMigrated(t);
  const { issueCredential, verifyToken } = await loadRepository();

  const issued = issueCredential(db, { tipo: 'usuario' });

  const found = verifyToken(db, issued.token);
  assert.ok(found !== null, 'a freshly issued token resolves');
  assert.equal(found.id, issued.id);
  assert.equal(found.tipo, 'usuario');

  assert.equal(verifyToken(db, 'f'.repeat(64)), null, 'a token never issued resolves to nothing');
  assert.equal(verifyToken(db, ''), null, 'the empty string is not a credential');
  assert.equal(
    verifyToken(db, createHash('sha256').update(issued.token).digest('hex')),
    null,
    'presenting the stored hash is not presenting the token',
  );

  // There is no revoke path in this ticket (Out of Scope): the column is written
  // by hand here so that `verifyToken`'s half of the contract — a revoked
  // credential stops authenticating — is proven before anything depends on it.
  db.prepare('UPDATE credencial SET revogada_em = ? WHERE id = ?').run(
    new Date().toISOString(),
    issued.id,
  );
  assert.equal(verifyToken(db, issued.token), null, 'a revoked credential no longer resolves');
});
