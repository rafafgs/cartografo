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

async function loadCredentials(): Promise<typeof CredentialsModule> {
  return (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
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
  const { issueCredential } = await loadCredentials();
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

/* -------------------------------------------------------------------------- */
/* t143 — the credential minted at pairing, and the route that kills it.       */
/* -------------------------------------------------------------------------- */

/** What `POST /v1/runners` answers since t143: the runner and, once, its token. */
interface PairingResponse {
  runner: RunnerRow;
  token: string | null;
}

/** Pairs a runner with the harness's operator credential (attached by the patch). */
async function pair(
  address: string,
  id: string,
  nome?: string,
): Promise<{ status: number; body: PairingResponse }> {
  const response = await fetch(`${address}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(nome === undefined ? { id } : { id, nome }),
  });
  return { status: response.status, body: (await response.json()) as PairingResponse };
}

/** How many live `runner` credentials that id has right now. */
function liveCredentials(db: ConnectionModule.Database, runnerId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS total FROM credencial WHERE tipo = 'runner' AND runner_id = ? AND revogada_em IS NULL",
    )
    .get(runnerId) as { total: number };
  return row.total;
}

test('t143 AT — first pairing mints the runner credential and returns it exactly once', async (t) => {
  const { address, db } = await start(t);

  const paired = await pair(address, 'runner-a', 'laptop do fundador');
  assert.equal(paired.status, 201);
  assert.equal(paired.body.runner.id, 'runner-a');
  assert.match(
    paired.body.token ?? '',
    /^[0-9a-f]{64}$/,
    'the raw runner token comes out of the 201, in the same shape as the bootstrap one',
  );

  const stored = db
    .prepare('SELECT tipo, runner_id, revogada_em, hash FROM credencial WHERE runner_id = ?')
    .all('runner-a') as Array<{
    tipo: string;
    runner_id: string;
    revogada_em: string | null;
    hash: string;
  }>;
  assert.equal(stored.length, 1, 'pairing mints one credential, not one per call');
  assert.equal(stored[0].tipo, 'runner');
  assert.equal(stored[0].revogada_em, null);
  assert.notEqual(stored[0].hash, paired.body.token, 'what is stored is the digest, never the token');

  // The point of the token: it opens the runner's own surface, with no operator
  // credential anywhere in the request.
  const jobs = await fetch(`${address}/v1/jobs`, {
    headers: { authorization: `Bearer ${paired.body.token ?? ''}` },
  });
  assert.equal(jobs.status, 200, 'the pairing token authenticates a subsequent allowed request');
});

test('t143 AT — re-pairing an existing id answers token: null and mints nothing', async (t) => {
  const { address, db } = await start(t);

  const first = await pair(address, 'runner-a');
  assert.equal(first.status, 201);
  assert.equal(typeof first.body.token, 'string');

  const again = await pair(address, 'runner-a', 'nome novo');
  assert.equal(again.status, 200, 'pairing stays idempotent (D5)');
  assert.equal(
    again.body.token,
    null,
    'the 200 path mints nothing, and says nothing about whether a live credential exists',
  );

  assert.equal(liveCredentials(db, 'runner-a'), 1, 'no second credential came out of the re-pairing');
});

test('t143 AT — POST /v1/runners/:id/revocations kills the runner credential and is idempotent', async (t) => {
  const { address, db } = await start(t);

  const paired = await pair(address, 'runner-a');
  const token = paired.body.token ?? '';
  const before = await fetch(`${address}/v1/jobs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(before.status, 200, 'the token works before the revocation — otherwise it proves nothing');

  const revoked = await fetch(`${address}/v1/runners/runner-a/revocations`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revogadas: 1 });

  const dead = await fetch(`${address}/v1/jobs`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(dead.status, 401, 'the revoked token fails on its very next request');
  assert.equal(((await dead.json()) as { erro?: string }).erro, 'credencial_invalida');

  const repeated = await fetch(`${address}/v1/runners/runner-a/revocations`, { method: 'POST' });
  assert.equal(repeated.status, 200, 'revoking twice is not an error');
  assert.deepEqual(await repeated.json(), { revogadas: 0 });

  assert.equal(liveCredentials(db, 'runner-a'), 0);
});

test('t143 AT — revoking an id that was never paired is 404 runner_desconhecido', async (t) => {
  const { address } = await start(t);

  const response = await fetch(`${address}/v1/runners/runner-fantasma/revocations`, {
    method: 'POST',
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { erro?: string; runner_id?: string };
  assert.equal(
    body.erro,
    'runner_desconhecido',
    'the same vocabulary the lease route already uses for the same condition',
  );
  assert.equal(body.runner_id, 'runner-fantasma');
});
