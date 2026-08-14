/**
 * Acceptance tests of runner pairing (t103, FR2/FR4).
 *
 * Registering a runner is the only thing a runner does before disputing a job,
 * and it has to be idempotent by construction: a runner that restarts (a crash,
 * a deploy, a machine that came back) registers again with the SAME id and must
 * receive neither an error nor a duplicated row. It is the same spirit as D5's
 * "idempotent writes in the API".
 *
 * The route demands a credential since t124, but pairing itself is unchanged:
 * the id is still declared by the runner, and a credential of its own is the
 * follow-up ticket.
 *
 * The response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as RunnersModule from '../src/repositories/runners.ts';
import type * as ServerModule from '../src/server.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface RunnerRow {
  id: string;
  nome: string | null;
  registrado_em: string;
}

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;
let runnersCache: typeof RunnersModule | null = null;

async function loadConnection(): Promise<typeof ConnectionModule> {
  connectionCache ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  return connectionCache;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  migrateCache ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  return migrateCache;
}

async function loadServer(): Promise<typeof ServerModule> {
  serverCache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ServerModule;
  return serverCache;
}

async function loadRunners(): Promise<typeof RunnersModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'repositories', 'runners.ts')),
    'artifact does not exist yet: packages/core/src/repositories/runners.ts',
  );
  runnersCache ??= (await import(
    new URL('../src/repositories/runners.ts', import.meta.url).href
  )) as typeof RunnersModule;
  return runnersCache;
}

/** Ephemeral control plane: a database in a temporary directory, port 0. */
async function start(t: TestHook): Promise<{
  address: string;
  db: ConnectionModule.Database;
}> {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp } = await loadServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t103-runners-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  // Every `/v1` route demands a credential since t124; this suite is about
  // the routes, so the harness issues one and presents it on every call.
  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
  const { token } = issueCredential(db, { tipo: 'usuario' });

  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  authorizeGlobalFetch(t, { baseUrl: address, token });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { address, db };
}

test('AT1 — POST /v1/runners creates the record and returns 201', async (t) => {
  const { address } = await start(t);

  const response = await fetch(`${address}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'runner-a', nome: 'laptop do fundador' }),
  });

  assert.equal(response.status, 201);
  const body = (await response.json()) as { runner: RunnerRow };
  assert.equal(body.runner.id, 'runner-a');
  assert.equal(body.runner.nome, 'laptop do fundador');
  assert.equal(typeof body.runner.registrado_em, 'string');
  assert.ok(
    !Number.isNaN(Date.parse(body.runner.registrado_em)),
    'registrado_em has to be an ISO 8601 instant',
  );
});

test('AT2 — POST /v1/runners with the same id is idempotent: 200 and a single row', async (t) => {
  const { address, db } = await start(t);
  const { listRunners } = await loadRunners();

  const first = await fetch(`${address}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'runner-a', nome: 'nome antigo' }),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${address}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'runner-a', nome: 'nome novo' }),
  });
  assert.equal(
    second.status,
    200,
    'registering the same runner again is idempotent, not a conflict (D5)',
  );

  const body = (await second.json()) as { runner: RunnerRow };
  assert.equal(body.runner.id, 'runner-a');
  assert.equal(body.runner.nome, 'nome novo', 're-registering updates the name that was sent');

  const registered = listRunners(db);
  assert.equal(registered.length, 1, 'the second registration cannot duplicate the row');
  assert.equal(registered[0].id, 'runner-a');
});
