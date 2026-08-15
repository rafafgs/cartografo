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
import type * as LeasesModule from '../src/repositories/leases.ts';
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

async function loadLeases(): Promise<typeof LeasesModule> {
  return (await import(
    new URL('../src/repositories/leases.ts', import.meta.url).href
  )) as typeof LeasesModule;
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

/* -------------------------------------------------------------------------- */
/* t164 — fleet health, read off the lease table.                              */
/* -------------------------------------------------------------------------- */

/** Project every lease below belongs to; a lease declares its own (t103, §1). */
const PROJECT_ID = 3;

/** Well above anything these fixtures ask for: the caps are not what is under test. */
const NO_CAP = 50;

/** What `GET /v1/runners` answers, and what `listRunnersWithHealth` returns. */
interface RunnerHealth extends RunnerRow {
  leases_ativas: number;
  ultimo_heartbeat: string | null;
  ultima_expiracao: {
    trabalho_id: number;
    expira_em: string;
    motivo_expiracao: string | null;
  } | null;
}

/**
 * An instant of the fixed morning these fixtures reason about.
 *
 * The clock is injected into every lease call, so the history below is written
 * in the order the assertions need it — not in the order a wall clock would
 * have allowed.
 */
function at(minute: number): string {
  return `2026-08-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

test('t164 AT — listRunnersWithHealth counts live leases and reads liveness off the whole history', async (t) => {
  const { db } = await start(t);
  const { registerRunner, listRunnersWithHealth } = await loadRunners();
  const { grantLease, renewLease, releaseLease, claimExpired } = await loadLeases();

  registerRunner(db, { id: 'runner-a', nome: 'o que trabalha' });
  registerRunner(db, { id: 'runner-b', nome: null });
  registerRunner(db, { id: 'runner-c', nome: 'o que nunca pegou trabalho' });

  const ask = (
    runnerId: string,
    jobId: number,
    ttl: number,
    moment: string,
  ): LeasesModule.LeaseRow => {
    const { lease } = grantLease(
      db,
      {
        runner_id: runnerId,
        projeto_id: PROJECT_ID,
        trabalho_id: jobId,
        teto_runner: NO_CAP,
        teto_projeto: NO_CAP,
        ttl_segundos: ttl,
      },
      { now: () => moment },
    );
    assert.ok(lease !== null, `the fixture lease of ${runnerId} for job ${jobId} was refused`);
    return lease;
  };

  // Two deaths, so that "the most recent one" is a choice and not the only row.
  // The first was never renewed (`expirou`), the second beat once and went
  // quiet (`heartbeat_perdido`) — and it is the later deadline of the two.
  ask('runner-a', 12, 60, at(2));
  const abandoned = ask('runner-a', 13, 120, at(4));
  renewLease(db, { id: abandoned.id }, { now: () => at(5) });
  claimExpired(db, { now: () => at(8) });

  // The latest heartbeat of all is on a lease that is no longer active: a
  // runner between jobs is not a runner that went blank.
  const finished = ask('runner-a', 10, 86_400, at(9));
  ask('runner-a', 11, 86_400, at(10));
  renewLease(db, { id: finished.id }, { now: () => at(20) });
  releaseLease(db, finished.id, { now: () => at(21) });

  ask('runner-b', 20, 86_400, at(11));

  const fleet = listRunnersWithHealth(db) as RunnerHealth[];
  assert.deepEqual(
    fleet.map((runner) => runner.id),
    ['runner-a', 'runner-b', 'runner-c'],
    'the same order as listRunners: registrado_em, then id',
  );

  const [first, second, third] = fleet;

  assert.equal(first.nome, 'o que trabalha', 'the health row carries the runner itself');
  assert.equal(first.leases_ativas, 1, 'only the `ativa` rows of THAT runner count');
  assert.equal(
    first.ultimo_heartbeat,
    at(20),
    'the last heartbeat comes from every lease it ever held, whatever the status',
  );
  assert.deepEqual(
    first.ultima_expiracao,
    { trabalho_id: 13, expira_em: at(7), motivo_expiracao: 'heartbeat_perdido' },
    'the stale-sweep signal is the most recently expired lease, not the first one',
  );

  assert.equal(second.leases_ativas, 1, "runner-b's count is its own");
  assert.equal(second.ultimo_heartbeat, at(11));
  assert.equal(second.ultima_expiracao, null, 'runner-b never lost a lease');

  assert.equal(third.leases_ativas, 0);
  assert.equal(
    third.ultimo_heartbeat,
    null,
    'a runner that never held a lease has no liveness to show — and says so',
  );
  assert.equal(third.ultima_expiracao, null);
});

test('t164 AT — GET /v1/runners answers the fleet to an operator and 403 to a runner', async (t) => {
  const { address } = await start(t);

  const first = await pair(address, 'runner-a', 'o primeiro pareado');
  await pair(address, 'runner-b');

  const response = await fetch(`${address}/v1/runners`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { runners: RunnerHealth[] };
  assert.deepEqual(
    body.runners.map((runner) => runner.id),
    ['runner-a', 'runner-b'],
    'one row per paired runner, in pairing order',
  );
  assert.deepEqual(body.runners[0], {
    id: 'runner-a',
    nome: 'o primeiro pareado',
    registrado_em: first.body.runner.registrado_em,
    leases_ativas: 0,
    ultimo_heartbeat: null,
    ultima_expiracao: null,
  });

  // Fleet-wide health is the operator's view, exactly like `GET /v1/executions`
  // and `GET /v1/sessions`: the route simply never joins the runner allowlist.
  const asRunner = await fetch(`${address}/v1/runners`, {
    headers: { authorization: `Bearer ${first.body.token ?? ''}` },
  });
  assert.equal(asRunner.status, 403);
  assert.equal(
    ((await asRunner.json()) as { erro?: string }).erro,
    'credencial_fora_de_escopo',
    'a live runner credential outside its own four routes is out of scope, not invalid',
  );
});
