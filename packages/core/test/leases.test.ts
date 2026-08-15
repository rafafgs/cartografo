/**
 * Acceptance tests of the lease mechanism (t103, FR3, FR5–FR9).
 *
 * D5 fits in two sentences: "a dispatched job carries a lease; a dead runner
 * expires and the job goes back to the queue", and the concurrency cap is never
 * exceeded. Both become tests here — AT5/AT6/AT12 for the cap (including under
 * simultaneous calls) and AT10/AT11 for the death of the runner.
 *
 * Two ways of assembling the app coexist on purpose:
 *
 * - most cases bring the real app up (`createApp`), with the real clock, because
 *   that is the path production uses;
 * - AT10/AT11 assemble the SAME route module with a controlled clock
 *   (`registerLeases(app, db, {now})`, FR3). That is what lets "the runner died
 *   and the deadline passed" be deterministic, without a `sleep`. The end-to-end
 *   path with real time is proven in AT17
 *   (`packages/runner/test/controller/dispatch-e-lease.e2e.test.ts`).
 *
 * `trabalho_id` is an opaque integer throughout this suite: the `trabalho` table
 * belongs to t102 and this route never reads it (Out of Scope).
 *
 * The response field names and the status/reason values stay in Portuguese: they
 * mirror the untouched migration columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from 'fastify';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as LeaseRoutesModule from '../src/routes/leases.ts';
import type * as RunnersModule from '../src/repositories/runners.ts';
import type * as ServerModule from '../src/server.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface LeaseRow {
  id: number;
  runner_id: string;
  trabalho_id: number;
  projeto_id: number;
  status: 'ativa' | 'liberada' | 'expirada';
  ttl_segundos: number;
  concedida_em: string;
  heartbeat_em: string;
  expira_em: string;
  liberada_em: string | null;
  motivo_expiracao: 'heartbeat_perdido' | 'expirou' | null;
}

interface GrantResponse {
  lease: LeaseRow | null;
  motivo?: string;
}

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;
let runnersCache: typeof RunnersModule | null = null;
let leaseRoutesCache: typeof LeaseRoutesModule | null = null;

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

async function loadLeaseRoutes(): Promise<typeof LeaseRoutesModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'routes', 'leases.ts')),
    'artifact does not exist yet: packages/core/src/routes/leases.ts',
  );
  leaseRoutesCache ??= (await import(
    new URL('../src/routes/leases.ts', import.meta.url).href
  )) as typeof LeaseRoutesModule;
  return leaseRoutesCache;
}

/** Ephemeral database, already migrated. */
async function temporaryDatabase(t: TestHook): Promise<ConnectionModule.Database> {
  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t103-leases-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return db;
}

/** A real ephemeral control plane, with the production clock. */
async function start(t: TestHook): Promise<{
  address: string;
  db: ConnectionModule.Database;
}> {
  const { createApp } = await loadServer();
  const db = await temporaryDatabase(t);

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
  });

  return { address, db };
}

/**
 * The same lease route module, assembled with a controlled clock.
 *
 * Only AT10/AT11 use it: they are the two cases in which the fact under test is
 * the passing of time, and a real `sleep` would make them slow and flaky.
 */
async function startWithClock(
  t: TestHook,
  now: () => string,
): Promise<{ address: string; db: ConnectionModule.Database }> {
  const { registerLeases } = await loadLeaseRoutes();
  const db = await temporaryDatabase(t);

  const app = Fastify({ logger: false });
  app.register(async (scope) => registerLeases(scope, db, { now }), { prefix: '/v1' });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
  });

  return { address, db };
}

/**
 * The same lease route module, assembled with the ceilings the SERVER decides
 * (t157, FR1).
 *
 * It is the injectable-options harness `startWithClock` already uses, with the
 * other option: in production the two numbers come from the environment
 * (`leaseCapRunner`/`leaseCapProject`, `src/index.ts`), and what matters here is
 * that whatever they are, the request cannot talk its way past them.
 */
async function startWithCeilings(
  t: TestHook,
  leaseCeilings: { runner: number; projeto: number },
): Promise<{ address: string; db: ConnectionModule.Database }> {
  const { registerLeases } = await loadLeaseRoutes();
  const db = await temporaryDatabase(t);

  const app = Fastify({ logger: false });
  app.register(async (scope) => registerLeases(scope, db, { leaseCeilings }), { prefix: '/v1' });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
  });

  return { address, db };
}

/** Test clock: starts at a fixed instant and only moves when told to. */
function controlledClock(start = '2026-08-14T12:00:00.000Z'): {
  now: () => string;
  advance: (seconds: number) => void;
} {
  let instant = Date.parse(start);
  return {
    now: () => new Date(instant).toISOString(),
    advance: (seconds) => {
      instant += seconds * 1000;
    },
  };
}

interface LeaseRequestBody {
  runner_id: string;
  projeto_id?: number;
  trabalho_id: number;
  teto_runner?: number;
  teto_projeto?: number;
  ttl_segundos?: number;
}

async function requestLease(
  address: string,
  request: LeaseRequestBody,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  return await fetch(`${address}/v1/leases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projeto_id: 1,
      teto_runner: 8,
      teto_projeto: 8,
      ttl_segundos: 60,
      ...request,
    }),
  });
}

async function listLeasesHttp(address: string, query = ''): Promise<LeaseRow[]> {
  const response = await fetch(`${address}/v1/leases${query}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { leases: LeaseRow[] }).leases;
}

async function registerRunners(db: ConnectionModule.Database, ...ids: string[]): Promise<void> {
  const { registerRunner } = await loadRunners();
  for (const id of ids) registerRunner(db, { id });
}

test('AT3 — POST /v1/leases with an unregistered runner_id returns 404', async (t) => {
  const { address } = await start(t);

  const response = await requestLease(address, { runner_id: 'runner-fantasma', trabalho_id: 1 });

  assert.equal(
    response.status,
    404,
    'a lease is granted to a paired runner; an unknown id does not exist for the control plane',
  );
  // The body matters: a 404 from a nonexistent route would also be a 404, and
  // would pass this test without the rule existing at all.
  const body = (await response.json()) as { erro?: string; runner_id?: string };
  assert.equal(body.erro, 'runner_desconhecido');
  assert.equal(body.runner_id, 'runner-fantasma');
});

test('AT4 — lease granted nasce ativa e com expira_em = concedida_em + ttl_segundos', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const response = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 7,
    ttl_segundos: 30,
  });

  assert.equal(response.status, 201);
  const { lease } = (await response.json()) as GrantResponse;
  assert.ok(lease !== null, 'with no competing lease, the grant cannot fail');
  assert.equal(lease.status, 'ativa');
  assert.equal(lease.runner_id, 'runner-a');
  assert.equal(lease.trabalho_id, 7);
  assert.equal(lease.ttl_segundos, 30);
  assert.equal(lease.heartbeat_em, lease.concedida_em, 'a newborn lease has never been renewed');
  assert.equal(
    Date.parse(lease.expira_em) - Date.parse(lease.concedida_em),
    30_000,
    'expira_em is concedida_em + ttl_segundos',
  );
  assert.equal(lease.liberada_em, null);
  assert.equal(lease.motivo_expiracao, null);
});

test('AT5 — the per-runner cap is never exceeded', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const first = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 1,
    teto_runner: 1,
  });
  assert.equal(first.status, 201);

  const second = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(second.status, 200, 'a reached cap is not a client error: it is "not now"');
  const body = (await second.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.motivo, 'teto_runner');

  const active = await listLeasesHttp(address, '?status=ativa');
  assert.equal(active.length, 1, 'the first lease stays active and is the only one');
  assert.equal(active[0].trabalho_id, 1);
});

test('AT6 — the per-project cap is never exceeded, across different runners', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');

  const first = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 1,
    projeto_id: 42,
    teto_projeto: 1,
  });
  assert.equal(first.status, 201);

  const second = await requestLease(address, {
    runner_id: 'runner-b',
    trabalho_id: 2,
    projeto_id: 42,
    teto_projeto: 1,
  });
  assert.equal(second.status, 200);
  const body = (await second.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(
    body.motivo,
    'teto_projeto',
    'the project cap applies to the whole project, not per runner',
  );

  const active = await listLeasesHttp(address, '?status=ativa&projeto_id=42');
  assert.equal(active.length, 1);
});

test('AT7 — a job that already has an active lease does not get a second one', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');

  assert.equal((await requestLease(address, { runner_id: 'runner-a', trabalho_id: 99 })).status, 201);

  const response = await requestLease(address, { runner_id: 'runner-b', trabalho_id: 99 });
  assert.equal(response.status, 200);
  const body = (await response.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.motivo, 'trabalho_ja_leased');

  const all = await listLeasesHttp(address);
  assert.equal(all.length, 1, 'a lost dispute cannot leave a row behind');
});

test('AT8 — a heartbeat extends the deadline; over a non-active lease it is 409, over a missing id it is 404', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const granted = (await (
    await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1, ttl_segundos: 30 })
  ).json()) as GrantResponse;
  assert.ok(granted.lease !== null);
  const leaseId = granted.lease.id;

  const beat = await fetch(`${address}/v1/leases/${leaseId}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_segundos: 300 }),
  });
  assert.equal(beat.status, 200);
  const renewed = ((await beat.json()) as { lease: LeaseRow }).lease;
  assert.equal(renewed.status, 'ativa');
  assert.equal(renewed.ttl_segundos, 300, 'the ttl sent in the heartbeat starts to hold');
  assert.ok(
    Date.parse(renewed.expira_em) > Date.parse(granted.lease.expira_em),
    'a heartbeat pushes expira_em forward',
  );
  assert.ok(
    Date.parse(renewed.heartbeat_em) >= Date.parse(granted.lease.heartbeat_em),
    'heartbeat_em records the last beat',
  );

  const missing = await fetch(`${address}/v1/leases/987654/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 404);

  const release = await fetch(`${address}/v1/leases/${leaseId}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(release.status, 200);

  const late = await fetch(`${address}/v1/leases/${leaseId}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(late.status, 409, 'a heartbeat only makes sense over an active lease');
});

test('AT9 — releasing returns the capacity right away', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const first = (await (
    await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1, teto_runner: 1 })
  ).json()) as GrantResponse;
  assert.ok(first.lease !== null);

  const blocked = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(((await blocked.json()) as GrantResponse).motivo, 'teto_runner');

  const release = await fetch(`${address}/v1/leases/${first.lease.id}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(release.status, 200);
  const released = ((await release.json()) as { lease: LeaseRow }).lease;
  assert.equal(released.status, 'liberada');
  assert.ok(released.liberada_em !== null, 'releasing stamps when');

  const after = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(after.status, 201, 'the released slot counts immediately in the next grant');

  const missing = await fetch(`${address}/v1/leases/987654/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(missing.status, 404);

  const repeated = await fetch(`${address}/v1/leases/${first.lease.id}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(repeated.status, 409, 'releasing the same lease twice is a conflict');
});

test('AT10 — a runner dies, the lease expires, another runner takes the same job', async (t) => {
  const clock = controlledClock();
  const { address, db } = await startWithClock(t, clock.now);
  await registerRunners(db, 'runner-a', 'runner-b');

  const first = (await (
    await requestLease(address, { runner_id: 'runner-a', trabalho_id: 55, ttl_segundos: 5 })
  ).json()) as GrantResponse;
  assert.ok(first.lease !== null);
  const deadLeaseId = first.lease.id;

  // runner-a dies here: no heartbeat goes out from this point on.
  clock.advance(6);

  const response = await requestLease(address, {
    runner_id: 'runner-b',
    trabalho_id: 55,
    ttl_segundos: 5,
  });

  assert.equal(
    response.status,
    201,
    'the same request that asks for a lease claims the expired ones before deciding (FR9)',
  );
  const fresh = ((await response.json()) as GrantResponse).lease;
  assert.ok(fresh !== null);
  assert.equal(fresh.runner_id, 'runner-b');
  assert.equal(fresh.trabalho_id, 55);
  assert.equal(fresh.status, 'ativa');
  assert.notEqual(fresh.id, deadLeaseId);

  const all = await listLeasesHttp(address);
  const old = all.find((lease) => lease.id === deadLeaseId);
  assert.ok(old !== undefined);
  assert.equal(old.status, 'expirada', 'the dead runner\'s lease becomes expired, it does not disappear');

  const active = all.filter((lease) => lease.status === 'ativa');
  assert.equal(active.length, 1, 'the re-queued job has exactly one new owner');
});

test('AT11 — motivo_expiracao tells never-renewed apart from heartbeat-lost', async (t) => {
  const clock = controlledClock();
  const { address, db } = await startWithClock(t, clock.now);
  await registerRunners(db, 'runner-a', 'runner-b', 'runner-c');

  const neverRenewed = (await (
    await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1, ttl_segundos: 10 })
  ).json()) as GrantResponse;
  const withHeartbeat = (await (
    await requestLease(address, { runner_id: 'runner-b', trabalho_id: 2, ttl_segundos: 10 })
  ).json()) as GrantResponse;
  assert.ok(neverRenewed.lease !== null && withHeartbeat.lease !== null);

  clock.advance(3);
  const beat = await fetch(`${address}/v1/leases/${withHeartbeat.lease.id}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(beat.status, 200);

  // Both stop here; both deadlines pass.
  clock.advance(60);

  // Any new request reconciles the expired ones before deciding (FR9).
  assert.equal(
    (await requestLease(address, { runner_id: 'runner-c', trabalho_id: 3, ttl_segundos: 10 })).status,
    201,
  );

  const all = await listLeasesHttp(address);
  const withoutRenewal = all.find((lease) => lease.id === neverRenewed.lease?.id);
  const withRenewal = all.find((lease) => lease.id === withHeartbeat.lease?.id);
  assert.ok(withoutRenewal !== undefined && withRenewal !== undefined);

  assert.equal(withoutRenewal.status, 'expirada');
  assert.equal(
    withoutRenewal.motivo_expiracao,
    'expirou',
    'never renewed (heartbeat_em == concedida_em): the deadline simply passed',
  );

  assert.equal(withRenewal.status, 'expirada');
  assert.equal(
    withRenewal.motivo_expiracao,
    'heartbeat_perdido',
    'renewed at least once and then silent: it is the heartbeat that was lost',
  );
});

/* -------------------------------------------------------------------------- */
/* t143 — a runner credential acts as ITSELF, not as any runner (FR3).         */
/* -------------------------------------------------------------------------- */

/** Mints a `runner`-type credential straight against the database under test. */
async function runnerToken(db: ConnectionModule.Database, runnerId: string): Promise<string> {
  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
  return issueCredential(db, { tipo: 'runner', runnerId }).token;
}

/** A heartbeat or a release, with the credential handed in explicitly. */
async function leaseAction(
  address: string,
  leaseId: number,
  action: 'heartbeats' | 'releases',
  token: string,
): Promise<Response> {
  return await fetch(`${address}/v1/leases/${leaseId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
}

test('t143 AT — POST /v1/leases with a runner credential can only ask on its own behalf', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');

  const impersonated = await requestLease(
    address,
    { runner_id: 'runner-b', trabalho_id: 1 },
    tokenA,
  );
  assert.equal(
    impersonated.status,
    403,
    'a route family is not a scope: within it, a runner credential is still only that runner',
  );
  assert.equal(
    ((await impersonated.json()) as { erro?: string }).erro,
    'credencial_fora_de_escopo',
  );
  assert.equal((await listLeasesHttp(address)).length, 0, 'a refused request grants nothing');

  const own = await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1 }, tokenA);
  assert.equal(own.status, 201, 'asking for itself is exactly what the credential is for');
});

test('t143 AT — a heartbeat or a release over somebody else\'s lease is refused', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');
  const tokenB = await runnerToken(db, 'runner-b');

  const granted = (await (
    await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1 }, tokenA)
  ).json()) as GrantResponse;
  assert.ok(granted.lease !== null);
  const leaseId = granted.lease.id;

  for (const action of ['heartbeats', 'releases'] as const) {
    const intruder = await leaseAction(address, leaseId, action, tokenB);
    assert.equal(intruder.status, 403, `${action} over a lease of another runner is refused`);
    assert.equal(((await intruder.json()) as { erro?: string }).erro, 'credencial_fora_de_escopo');
  }

  const beat = await leaseAction(address, leaseId, 'heartbeats', tokenA);
  assert.equal(beat.status, 200, 'the owner renews its own lease');

  const released = await leaseAction(address, leaseId, 'releases', tokenA);
  assert.equal(released.status, 200);
  assert.equal(((await released.json()) as { lease: LeaseRow }).lease.status, 'liberada');
});

test('t143 AT — GET /v1/leases with a runner credential sees only its own leases', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');

  // Seeded with the operator credential, which stays unrestricted.
  assert.equal((await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1 })).status, 201);
  assert.equal((await requestLease(address, { runner_id: 'runner-b', trabalho_id: 2 })).status, 201);
  assert.equal(
    (await listLeasesHttp(address)).length,
    2,
    'the operator credential keeps seeing the whole pool',
  );

  const mine = await fetch(`${address}/v1/leases`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(mine.status, 200);
  const leases = ((await mine.json()) as { leases: LeaseRow[] }).leases;
  assert.deepEqual(
    leases.map((lease) => lease.runner_id),
    ['runner-a'],
    'an omitted runner_id is filled in with the credential\'s own, silently',
  );

  const foreign = await fetch(`${address}/v1/leases?runner_id=runner-b`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(foreign.status, 403, 'naming somebody else is a refusal, not a silent rewrite');
  assert.equal(((await foreign.json()) as { erro?: string }).erro, 'credencial_fora_de_escopo');

  const explicit = await fetch(`${address}/v1/leases?runner_id=runner-a&status=ativa`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(explicit.status, 200, 'naming ITSELF is allowed, and composes with the other filters');
  assert.equal(((await explicit.json()) as { leases: LeaseRow[] }).leases.length, 1);
});

/* -------------------------------------------------------------------------- */
/* t157 — the cap is DECIDED on the server, only declared by the runner (D1).  */
/* -------------------------------------------------------------------------- */

test('t157 AT — teto_runner declared above the server ceiling is capped at the ceiling', async (t) => {
  const { address, db } = await startWithCeilings(t, { runner: 2, projeto: 2 });
  await registerRunners(db, 'runner-a');

  // The runner declares 100 on every call: if the number in the body were the
  // one enforced, all three of these would be granted.
  for (const trabalho_id of [1, 2]) {
    const response = await requestLease(address, {
      runner_id: 'runner-a',
      trabalho_id,
      teto_runner: 100,
      teto_projeto: 100,
    });
    assert.equal(response.status, 201, `job ${trabalho_id} is inside the server ceiling`);
  }

  const refused = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 3,
    teto_runner: 100,
    teto_projeto: 100,
  });
  assert.equal(refused.status, 200, 'a ceiling reached is still "not now", not an error');
  const body = (await refused.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.motivo, 'teto_runner');

  const active = await listLeasesHttp(address, '?status=ativa');
  assert.equal(active.length, 2, 'the request declares; the control plane decides (D1)');
});

test('t157 AT — teto_projeto declared above the server ceiling is capped at the ceiling', async (t) => {
  const { address, db } = await startWithCeilings(t, { runner: 2, projeto: 2 });
  await registerRunners(db, 'runner-a', 'runner-b', 'runner-c');

  for (const [index, runner] of ['runner-a', 'runner-b'].entries()) {
    const response = await requestLease(address, {
      runner_id: runner,
      trabalho_id: index + 1,
      projeto_id: 42,
      teto_runner: 100,
      teto_projeto: 100,
    });
    assert.equal(response.status, 201, `${runner} is inside the project ceiling`);
  }

  // A third runner: its own count is zero, so only the project ceiling can
  // refuse this one.
  const refused = await requestLease(address, {
    runner_id: 'runner-c',
    trabalho_id: 3,
    projeto_id: 42,
    teto_runner: 100,
    teto_projeto: 100,
  });
  assert.equal(refused.status, 200);
  const body = (await refused.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.motivo, 'teto_projeto');

  const active = await listLeasesHttp(address, '?status=ativa&projeto_id=42');
  assert.equal(active.length, 2, 'the project ceiling holds across runners');
});

test('t157 AT — a declaration BELOW the ceiling still holds: the clamp is a minimum', async (t) => {
  const { address, db } = await startWithCeilings(t, { runner: 50, projeto: 50 });
  await registerRunners(db, 'runner-a');

  assert.equal(
    (await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1, teto_runner: 1 })).status,
    201,
  );

  const refused = await requestLease(address, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(refused.status, 200);
  assert.equal(
    ((await refused.json()) as GrantResponse).motivo,
    'teto_runner',
    'a runner that asks for less than the ceiling gets what it asked for',
  );
});

test('AT12 — the cap is respected under simultaneous calls', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const PROJECT_CAP = 3;
  const JOBS = [1, 2, 3, 4, 5, 6, 7, 8];

  const responses = await Promise.all(
    JOBS.map(async (trabalho_id) =>
      requestLease(address, {
        runner_id: 'runner-a',
        trabalho_id,
        projeto_id: 7,
        teto_runner: JOBS.length,
        teto_projeto: PROJECT_CAP,
      }),
    ),
  );

  const grantedResponses = responses.filter((response) => response.status === 201);
  const refused = responses.filter((response) => response.status === 200);
  assert.equal(
    grantedResponses.length,
    PROJECT_CAP,
    'the count and the write have to be atomic: not one grant more',
  );
  assert.equal(refused.length, JOBS.length - PROJECT_CAP);

  for (const response of refused) {
    const body = (await response.json()) as GrantResponse;
    assert.equal(body.lease, null);
    assert.equal(body.motivo, 'teto_projeto');
  }

  const active = await listLeasesHttp(address, '?status=ativa&projeto_id=7');
  assert.equal(active.length, PROJECT_CAP, 'the state in the database never exceeds the configured cap');
  assert.equal(
    new Set(active.map((lease) => lease.trabalho_id)).size,
    PROJECT_CAP,
    'no job received two leases in the race',
  );
});

test('t180 — a lease of another runner is refused in English, quoting both ids', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');
  const tokenB = await runnerToken(db, 'runner-b');

  const granted = await requestLease(address, { runner_id: 'runner-a', trabalho_id: 1 }, tokenA);
  assert.equal(granted.status, 201);
  const { lease } = (await granted.json()) as { lease: { id: number } };

  for (const action of ['heartbeats', 'releases'] as const) {
    const foreign = await leaseAction(address, lease.id, action, tokenB);
    assert.equal(foreign.status, 403);
    const body = (await foreign.json()) as { erro: string; mensagem: string };
    assert.equal(body.erro, 'credencial_fora_de_escopo', 'the code is frozen (FR2)');
    assert.equal(
      body.mensagem,
      `lease ${lease.id} belongs to runner "runner-a"; the credential presented belongs to runner "runner-b"`,
    );
  }
});
