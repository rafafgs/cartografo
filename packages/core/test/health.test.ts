/**
 * Acceptance tests of the health route (t100, FR4/FR10).
 *
 * `GET /health` is an infrastructure route: it sits OUTSIDE the `/v1` prefix,
 * and the `db` field is the result of a real `SELECT 1` — not a constant. The
 * second test is what proves that: it brings the app up pointed at a file that
 * is not a SQLite database and demands the response stop saying `db: "ok"`.
 *
 * The response values (`ok`/`erro`) are the probe's wire contract and stay as
 * they are (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as ServerModule from '../src/server.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;

async function loadConnection(): Promise<typeof ConnectionModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'db', 'connection.ts')),
    'artifact does not exist yet: packages/core/src/db/connection.ts',
  );
  connectionCache ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  return connectionCache;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'db', 'migrate.ts')),
    'artifact does not exist yet: packages/core/src/db/migrate.ts',
  );
  migrateCache ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  return migrateCache;
}

async function loadServer(): Promise<typeof ServerModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'server.ts')),
    'artifact does not exist yet: packages/core/src/server.ts',
  );
  serverCache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ServerModule;
  return serverCache;
}

function temporaryArea(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test('AT6 — GET /health answers 200, JSON, body exactly {"status":"ok","db":"ok"}', async (t) => {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp } = await loadServer();

  const base = temporaryArea(t);
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const response = await fetch(`${address}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(await response.text(), '{"status":"ok","db":"ok"}');
});

test('AT7 — with a corrupted database, /health does not say db:"ok"', async (t) => {
  const { openDatabase } = await loadConnection();
  const { createApp } = await loadServer();

  const base = temporaryArea(t);
  const filePath = path.join(base, 'corrupted.db');
  // The file exists, has a size and is NOT a database: the open succeeds (SQLite
  // reads the header only on the first query), so what blows up is the check's
  // `SELECT 1` — exactly what this test wants to prove.
  writeFileSync(filePath, 'this is not a sqlite database, just textual garbage\n'.repeat(64), 'utf8');

  const db = openDatabase(filePath);
  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const response = await fetch(`${address}/health`);
  const body = (await response.json()) as { status: string; db: string };
  assert.notEqual(body.db, 'ok', 'the db field has to reflect the real check, not a constant');
  assert.notEqual(body.status, 'ok');
  assert.equal(response.status, 503);
});

test('AT8 — /health stays outside the /v1 prefix, where the business routes are born', async (t) => {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp, API_PREFIX } = await loadServer();

  assert.equal(API_PREFIX, '/v1');

  const base = temporaryArea(t);
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
  });

  assert.equal((await fetch(`${address}/health`)).status, 200);
  assert.equal(
    (await fetch(`${address}${API_PREFIX}/health`)).status,
    404,
    'health is an infrastructure probe: it cannot be versioned along with the business',
  );
});
