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
 * `job_id` is an opaque integer throughout this suite: the `trabalho` table
 * belongs to t102 and this route never reads it (Out of Scope).
 *
 * The response field names and the status/reason values stay in Portuguese: they
 * mirror the untouched migration columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { resolvePinsOver } from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface LeaseRow {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
  status: 'active' | 'released' | 'expired';
  ttl_seconds: number;
  granted_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  expiration_reason: 'heartbeat_lost' | 'ttl_elapsed' | null;
}

interface GrantResponse {
  lease: LeaseRow | null;
  reason?: string;
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
  const { token } = issueCredential(db, { type: 'user' });

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
  project_id?: number;
  job_id: number;
  runner_cap?: number;
  project_cap?: number;
  ttl_seconds?: number;
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
      project_id: 1,
      runner_cap: 8,
      project_cap: 8,
      ttl_seconds: 60,
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

  const response = await requestLease(address, { runner_id: 'runner-fantasma', job_id: 1 });

  assert.equal(
    response.status,
    404,
    'a lease is granted to a paired runner; an unknown id does not exist for the control plane',
  );
  // The body matters: a 404 from a nonexistent route would also be a 404, and
  // would pass this test without the rule existing at all.
  const body = (await response.json()) as { error?: string; runner_id?: string };
  assert.equal(body.error, 'unknown_runner');
  assert.equal(body.runner_id, 'runner-fantasma');
});

test('AT4 — a granted lease is born active with expires_at = granted_at + ttl_seconds', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const response = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 7,
    ttl_seconds: 30,
  });

  assert.equal(response.status, 201);
  const { lease } = (await response.json()) as GrantResponse;
  assert.ok(lease !== null, 'with no competing lease, the grant cannot fail');
  assert.equal(lease.status, 'active');
  assert.equal(lease.runner_id, 'runner-a');
  assert.equal(lease.job_id, 7);
  assert.equal(lease.ttl_seconds, 30);
  assert.equal(lease.heartbeat_at, lease.granted_at, 'a newborn lease has never been renewed');
  assert.equal(
    Date.parse(lease.expires_at) - Date.parse(lease.granted_at),
    30_000,
    'expires_at is granted_at + ttl_seconds',
  );
  assert.equal(lease.released_at, null);
  assert.equal(lease.expiration_reason, null);
});

test('AT5 — the per-runner cap is never exceeded', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const first = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 1,
    runner_cap: 1,
  });
  assert.equal(first.status, 201);

  const second = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 2,
    runner_cap: 1,
  });
  assert.equal(second.status, 200, 'a reached cap is not a client error: it is "not now"');
  const body = (await second.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.reason, 'runner_cap');

  const active = await listLeasesHttp(address, '?status=active');
  assert.equal(active.length, 1, 'the first lease stays active and is the only one');
  assert.equal(active[0].job_id, 1);
});

test('AT6 — the per-project cap is never exceeded, across different runners', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');

  const first = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 1,
    project_id: 42,
    project_cap: 1,
  });
  assert.equal(first.status, 201);

  const second = await requestLease(address, {
    runner_id: 'runner-b',
    job_id: 2,
    project_id: 42,
    project_cap: 1,
  });
  assert.equal(second.status, 200);
  const body = (await second.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(
    body.reason,
    'project_cap',
    'the project cap applies to the whole project, not per runner',
  );

  const active = await listLeasesHttp(address, '?status=active&project_id=42');
  assert.equal(active.length, 1);
});

test('AT7 — a job that already has an active lease does not get a second one', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');

  assert.equal((await requestLease(address, { runner_id: 'runner-a', job_id: 99 })).status, 201);

  const response = await requestLease(address, { runner_id: 'runner-b', job_id: 99 });
  assert.equal(response.status, 200);
  const body = (await response.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.reason, 'job_already_leased');

  const all = await listLeasesHttp(address);
  assert.equal(all.length, 1, 'a lost dispute cannot leave a row behind');
});

test('AT8 — a heartbeat extends the deadline; over a non-active lease it is 409, over a missing id it is 404', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const granted = (await (
    await requestLease(address, { runner_id: 'runner-a', job_id: 1, ttl_seconds: 30 })
  ).json()) as GrantResponse;
  assert.ok(granted.lease !== null);
  const leaseId = granted.lease.id;

  const beat = await fetch(`${address}/v1/leases/${leaseId}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 300 }),
  });
  assert.equal(beat.status, 200);
  const renewed = ((await beat.json()) as { lease: LeaseRow }).lease;
  assert.equal(renewed.status, 'active');
  assert.equal(renewed.ttl_seconds, 300, 'the ttl sent in the heartbeat starts to hold');
  assert.ok(
    Date.parse(renewed.expires_at) > Date.parse(granted.lease.expires_at),
    'a heartbeat pushes expires_at forward',
  );
  assert.ok(
    Date.parse(renewed.heartbeat_at) >= Date.parse(granted.lease.heartbeat_at),
    'heartbeat_at records the last beat',
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
    await requestLease(address, { runner_id: 'runner-a', job_id: 1, runner_cap: 1 })
  ).json()) as GrantResponse;
  assert.ok(first.lease !== null);

  const blocked = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 2,
    runner_cap: 1,
  });
  assert.equal(((await blocked.json()) as GrantResponse).reason, 'runner_cap');

  const release = await fetch(`${address}/v1/leases/${first.lease.id}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(release.status, 200);
  const released = ((await release.json()) as { lease: LeaseRow }).lease;
  assert.equal(released.status, 'released');
  assert.ok(released.released_at !== null, 'releasing stamps when');

  const after = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 2,
    runner_cap: 1,
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
    await requestLease(address, { runner_id: 'runner-a', job_id: 55, ttl_seconds: 5 })
  ).json()) as GrantResponse;
  assert.ok(first.lease !== null);
  const deadLeaseId = first.lease.id;

  // runner-a dies here: no heartbeat goes out from this point on.
  clock.advance(6);

  const response = await requestLease(address, {
    runner_id: 'runner-b',
    job_id: 55,
    ttl_seconds: 5,
  });

  assert.equal(
    response.status,
    201,
    'the same request that asks for a lease claims the expired ones before deciding (FR9)',
  );
  const fresh = ((await response.json()) as GrantResponse).lease;
  assert.ok(fresh !== null);
  assert.equal(fresh.runner_id, 'runner-b');
  assert.equal(fresh.job_id, 55);
  assert.equal(fresh.status, 'active');
  assert.notEqual(fresh.id, deadLeaseId);

  const all = await listLeasesHttp(address);
  const old = all.find((lease) => lease.id === deadLeaseId);
  assert.ok(old !== undefined);
  assert.equal(old.status, 'expired', 'the dead runner\'s lease becomes expired, it does not disappear');

  const active = all.filter((lease) => lease.status === 'active');
  assert.equal(active.length, 1, 'the re-queued job has exactly one new owner');
});

test('AT11 — expiration_reason tells never-renewed apart from heartbeat-lost', async (t) => {
  const clock = controlledClock();
  const { address, db } = await startWithClock(t, clock.now);
  await registerRunners(db, 'runner-a', 'runner-b', 'runner-c');

  const neverRenewed = (await (
    await requestLease(address, { runner_id: 'runner-a', job_id: 1, ttl_seconds: 10 })
  ).json()) as GrantResponse;
  const withHeartbeat = (await (
    await requestLease(address, { runner_id: 'runner-b', job_id: 2, ttl_seconds: 10 })
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
    (await requestLease(address, { runner_id: 'runner-c', job_id: 3, ttl_seconds: 10 })).status,
    201,
  );

  const all = await listLeasesHttp(address);
  const withoutRenewal = all.find((lease) => lease.id === neverRenewed.lease?.id);
  const withRenewal = all.find((lease) => lease.id === withHeartbeat.lease?.id);
  assert.ok(withoutRenewal !== undefined && withRenewal !== undefined);

  assert.equal(withoutRenewal.status, 'expired');
  assert.equal(
    withoutRenewal.expiration_reason,
    'ttl_elapsed',
    'never renewed (heartbeat_at == granted_at): the deadline simply passed',
  );

  assert.equal(withRenewal.status, 'expired');
  assert.equal(
    withRenewal.expiration_reason,
    'heartbeat_lost',
    'renewed at least once and then silent: it is the heartbeat that was lost',
  );
});

/* -------------------------------------------------------------------------- */
/* t256 — reconciling is part of ASKING ANYTHING, not only of asking for work. */
/*                                                                            */
/* AT10/AT11 above prove the expiration through a SUBSEQUENT GRANT, which was  */
/* the only caller `expireOverdue` ever had. The three cases below remove that */
/* second request: a runner dies and nobody else wants its job, which is the   */
/* ordinary state of a small pool. Until this ticket the dead lease stayed     */
/* `active` forever in the listing, and a late heartbeat or release found it   */
/* alive and succeeded — resurrecting a lease whose owner is gone.             */
/* -------------------------------------------------------------------------- */

/** A lease already past its deadline, with no other request in flight. */
async function abandonedLease(t: TestHook): Promise<{
  address: string;
  lease: LeaseRow;
}> {
  const clock = controlledClock();
  const { address, db } = await startWithClock(t, clock.now);
  await registerRunners(db, 'runner-a');

  const granted = (await (
    await requestLease(address, { runner_id: 'runner-a', job_id: 55, ttl_seconds: 5 })
  ).json()) as GrantResponse;
  assert.ok(granted.lease !== null, 'with no competing lease, the grant cannot fail');

  // The runner dies here, and NOBODY asks for a lease afterwards.
  clock.advance(6);

  return { address, lease: granted.lease };
}

test('t256 — GET /v1/leases reconciles on its own, with no grant in flight', async (t) => {
  const { address, lease } = await abandonedLease(t);

  const all = await listLeasesHttp(address);
  const dead = all.find((listed) => listed.id === lease.id);
  assert.ok(dead !== undefined, 'the lease does not disappear, it changes state');
  assert.equal(dead.status, 'expired', 'the listing itself is what discovers the death');
  assert.equal(dead.expiration_reason, 'ttl_elapsed');

  const active = await listLeasesHttp(address, '?status=active');
  assert.deepEqual(
    active.map((listed) => listed.id),
    [],
    'a lease past its deadline is never reported as active',
  );
});

test('t256 — a heartbeat after the deadline is a 409, never a resurrection', async (t) => {
  const { address, lease } = await abandonedLease(t);

  const beat = await fetch(`${address}/v1/leases/${lease.id}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(beat.status, 409, 'the lease was already dead when the beat arrived');
  const body = (await beat.json()) as { error?: string; status?: string };
  assert.equal(body.error, 'lease_not_active');
  assert.equal(body.status, 'expired');

  const [after] = await listLeasesHttp(address, `?status=expired`);
  assert.equal(after.id, lease.id, 'the beat did not push the deadline forward');
});

test('t256 — a release after the deadline is a 409, not a transition over a dead lease', async (t) => {
  const { address, lease } = await abandonedLease(t);

  const release = await fetch(`${address}/v1/leases/${lease.id}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(release.status, 409);
  assert.equal(((await release.json()) as { error?: string }).error, 'lease_not_active');

  const all = await listLeasesHttp(address);
  const dead = all.find((listed) => listed.id === lease.id);
  assert.ok(dead !== undefined);
  assert.equal(dead.status, 'expired', 'a dead lease is not "released" after the fact');
  assert.equal(dead.released_at, null);
});

/* -------------------------------------------------------------------------- */
/* t143 — a runner credential acts as ITSELF, not as any runner (FR3).         */
/* -------------------------------------------------------------------------- */

/** Mints a `runner`-type credential straight against the database under test. */
async function runnerToken(db: ConnectionModule.Database, runnerId: string): Promise<string> {
  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
  return issueCredential(db, { type: 'runner', runnerId }).token;
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
    { runner_id: 'runner-b', job_id: 1 },
    tokenA,
  );
  assert.equal(
    impersonated.status,
    403,
    'a route family is not a scope: within it, a runner credential is still only that runner',
  );
  assert.equal(
    ((await impersonated.json()) as { error?: string }).error,
    'out_of_scope_credential',
  );
  assert.equal((await listLeasesHttp(address)).length, 0, 'a refused request grants nothing');

  const own = await requestLease(address, { runner_id: 'runner-a', job_id: 1 }, tokenA);
  assert.equal(own.status, 201, 'asking for itself is exactly what the credential is for');
});

test('t143 AT — a heartbeat or a release over somebody else\'s lease is refused', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');
  const tokenB = await runnerToken(db, 'runner-b');

  const granted = (await (
    await requestLease(address, { runner_id: 'runner-a', job_id: 1 }, tokenA)
  ).json()) as GrantResponse;
  assert.ok(granted.lease !== null);
  const leaseId = granted.lease.id;

  for (const action of ['heartbeats', 'releases'] as const) {
    const intruder = await leaseAction(address, leaseId, action, tokenB);
    assert.equal(intruder.status, 403, `${action} over a lease of another runner is refused`);
    assert.equal(((await intruder.json()) as { error?: string }).error, 'out_of_scope_credential');
  }

  const beat = await leaseAction(address, leaseId, 'heartbeats', tokenA);
  assert.equal(beat.status, 200, 'the owner renews its own lease');

  const released = await leaseAction(address, leaseId, 'releases', tokenA);
  assert.equal(released.status, 200);
  assert.equal(((await released.json()) as { lease: LeaseRow }).lease.status, 'released');
});

test('t143 AT — GET /v1/leases with a runner credential sees only its own leases', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');

  // Seeded with the operator credential, which stays unrestricted.
  assert.equal((await requestLease(address, { runner_id: 'runner-a', job_id: 1 })).status, 201);
  assert.equal((await requestLease(address, { runner_id: 'runner-b', job_id: 2 })).status, 201);
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
  assert.equal(((await foreign.json()) as { error?: string }).error, 'out_of_scope_credential');

  const explicit = await fetch(`${address}/v1/leases?runner_id=runner-a&status=active`, {
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(explicit.status, 200, 'naming ITSELF is allowed, and composes with the other filters');
  assert.equal(((await explicit.json()) as { leases: LeaseRow[] }).leases.length, 1);
});

/* -------------------------------------------------------------------------- */
/* t157 — the cap is DECIDED on the server, only declared by the runner (D1).  */
/* -------------------------------------------------------------------------- */

test('t157 AT — runner_cap declared above the server ceiling is capped at the ceiling', async (t) => {
  const { address, db } = await startWithCeilings(t, { runner: 2, projeto: 2 });
  await registerRunners(db, 'runner-a');

  // The runner declares 100 on every call: if the number in the body were the
  // one enforced, all three of these would be granted.
  for (const jobId of [1, 2]) {
    const response = await requestLease(address, {
      runner_id: 'runner-a',
      job_id: jobId,
      runner_cap: 100,
      project_cap: 100,
    });
    assert.equal(response.status, 201, `job ${jobId} is inside the server ceiling`);
  }

  const refused = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 3,
    runner_cap: 100,
    project_cap: 100,
  });
  assert.equal(refused.status, 200, 'a ceiling reached is still "not now", not an error');
  const body = (await refused.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.reason, 'runner_cap');

  const active = await listLeasesHttp(address, '?status=active');
  assert.equal(active.length, 2, 'the request declares; the control plane decides (D1)');
});

test('t157 AT — project_cap declared above the server ceiling is capped at the ceiling', async (t) => {
  const { address, db } = await startWithCeilings(t, { runner: 2, projeto: 2 });
  await registerRunners(db, 'runner-a', 'runner-b', 'runner-c');

  for (const [index, runner] of ['runner-a', 'runner-b'].entries()) {
    const response = await requestLease(address, {
      runner_id: runner,
      job_id: index + 1,
      project_id: 42,
      runner_cap: 100,
      project_cap: 100,
    });
    assert.equal(response.status, 201, `${runner} is inside the project ceiling`);
  }

  // A third runner: its own count is zero, so only the project ceiling can
  // refuse this one.
  const refused = await requestLease(address, {
    runner_id: 'runner-c',
    job_id: 3,
    project_id: 42,
    runner_cap: 100,
    project_cap: 100,
  });
  assert.equal(refused.status, 200);
  const body = (await refused.json()) as GrantResponse;
  assert.equal(body.lease, null);
  assert.equal(body.reason, 'project_cap');

  const active = await listLeasesHttp(address, '?status=active&project_id=42');
  assert.equal(active.length, 2, 'the project ceiling holds across runners');
});

test('t157 AT — a declaration BELOW the ceiling still holds: the clamp is a minimum', async (t) => {
  const { address, db } = await startWithCeilings(t, { runner: 50, projeto: 50 });
  await registerRunners(db, 'runner-a');

  assert.equal(
    (await requestLease(address, { runner_id: 'runner-a', job_id: 1, runner_cap: 1 })).status,
    201,
  );

  const refused = await requestLease(address, {
    runner_id: 'runner-a',
    job_id: 2,
    runner_cap: 1,
  });
  assert.equal(refused.status, 200);
  assert.equal(
    ((await refused.json()) as GrantResponse).reason,
    'runner_cap',
    'a runner that asks for less than the ceiling gets what it asked for',
  );
});

test('AT12 — the cap is respected under simultaneous calls', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a');

  const PROJECT_CAP = 3;
  const JOBS = [1, 2, 3, 4, 5, 6, 7, 8];

  const responses = await Promise.all(
    JOBS.map(async (jobId) =>
      requestLease(address, {
        runner_id: 'runner-a',
        job_id: jobId,
        project_id: 7,
        runner_cap: JOBS.length,
        project_cap: PROJECT_CAP,
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
    assert.equal(body.reason, 'project_cap');
  }

  const active = await listLeasesHttp(address, '?status=active&project_id=7');
  assert.equal(active.length, PROJECT_CAP, 'the state in the database never exceeds the configured cap');
  assert.equal(
    new Set(active.map((lease) => lease.job_id)).size,
    PROJECT_CAP,
    'no job received two leases in the race',
  );
});

test('t180 — a lease of another runner is refused in English, quoting both ids', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-a', 'runner-b');
  const tokenA = await runnerToken(db, 'runner-a');
  const tokenB = await runnerToken(db, 'runner-b');

  const granted = await requestLease(address, { runner_id: 'runner-a', job_id: 1 }, tokenA);
  assert.equal(granted.status, 201);
  const { lease } = (await granted.json()) as { lease: { id: number } };

  for (const action of ['heartbeats', 'releases'] as const) {
    const foreign = await leaseAction(address, lease.id, action, tokenB);
    assert.equal(foreign.status, 403);
    const body = (await foreign.json()) as { error: string; message: string };
    assert.equal(body.error, 'out_of_scope_credential', 'the code is frozen (FR2)');
    assert.equal(
      body.message,
      `lease ${lease.id} belongs to runner "runner-a"; the credential presented belongs to runner "runner-b"`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* t264 — the round that only a RELEASE can declare over (FR1)                 */
/*                                                                            */
/* `announceFinishedExecution` has always been right about its own condition   */
/* — every job arrived AND no lease of the round is still active — and wrong   */
/* about WHEN it is asked. Until t264 it was asked only on a job mutation, and */
/* the runner releases the lease strictly AFTER reporting the terminal one     */
/* (`packages/runner/src/controller/controller.ts`, the `finally` around       */
/* `#dispatch`). So at the only instant anything re-checked, the job's own     */
/* lease was still `active`, and nothing looked again when it cleared a moment */
/* later. t198's first real crossing hit exactly that                          */
/* (`notas/2026-08-17-first-bets-run.md`, gap 3).                      */
/*                                                                            */
/* This is the one place the four verbs above look a job up, and the route is  */
/* where it happens: `repositories/leases.ts` stays job-blind, as its own      */
/* header requires, and the route already knew both sides.                     */
/*                                                                            */
/* The graph is the minimal example, whose final node PINS a skill — every     */
/* node of a registrable document does, because `schema/grafo.schema.json`     */
/* makes `skill_ref` mandatory. So the pinned step is run and reported FIRST   */
/* (t262), which leaves the transition as the fact that completes the job,     */
/* with its own lease still held: the exact ordering the defect needs.         */
/* -------------------------------------------------------------------------- */

/** The minimal example graph, the same fixture `executions.test.ts` registers. */
const MINIMAL_GRAPH = path.resolve(
  PACKAGE_ROOT,
  '..',
  '..',
  'schema',
  'examples',
  'graph-valid-minimal.json',
);

/** A job, in the slice these two tests read. */
interface JobRow {
  id: number;
  execution_id: number | null;
  current_node_id: string;
}

/** One envelope of the round's log, in the slice these two tests read. */
interface EventRow {
  id: number;
  type: string;
  occurred_at: string;
}

/** Sends a JSON body and fails loudly instead of leaving a silent 4xx behind. */
async function postJson<T>(
  address: string,
  route: string,
  body: unknown,
  expected: number,
): Promise<T> {
  const response = await fetch(`${address}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const decoded = (await response.json()) as T;
  assert.equal(
    response.status,
    expected,
    `POST ${route} returned ${response.status}: ${JSON.stringify(decoded)}`,
  );
  return decoded;
}

/** Registers the minimal example graph and returns the version a job cites. */
async function registerMinimalGraph(address: string): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  // A resolvable capability per node, or the version is `unchecked` and the
  // travellers below could not be created at all (t283).
  await resolvePinsOver(document, {
    get: async (routePath) => ({ status: (await fetch(`${address}${routePath}`)).status }),
    post: async (routePath, payload) => ({
      status: (
        await fetch(`${address}${routePath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      ).status,
    }),
  });

  const body = await postJson<{ graph_version: { id: string } }>(
    address,
    '/v1/graphs',
    document,
    201,
  );
  return body.graph_version.id;
}

/** A traveller of `execution`, standing on the entry node of `version`. */
async function traveller(
  address: string,
  execution: number,
  version: string,
  title: string,
): Promise<JobRow> {
  return await postJson<JobRow>(
    address,
    '/v1/jobs',
    { title, entry_node_id: 'redigir', execution_id: execution, graph_version_id: version },
    201,
  );
}

/**
 * Runs the pinned final node and reports it, which is what makes arriving there
 * an arrival at all (t262).
 */
async function runFinalNode(address: string, jobId: number): Promise<void> {
  const opened = await postJson<{ id: number }>(
    address,
    '/v1/sessions',
    {
      job_id: jobId,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revisa e encerra',
    },
    201,
  );

  const finished = await fetch(`${address}/v1/sessions/${opened.id}/finish`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: 'completed',
      exit_code: 0,
      output: { outcome: 'passou', evidencia: 'a nota responde ao tema declarado' },
    }),
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);
}

/** Moves a job to a node. */
async function moveTo(address: string, jobId: number, node: string): Promise<void> {
  await postJson(address, `/v1/jobs/${jobId}/transitions`, { to_node_id: node }, 200);
}

/** `finished_at` of one round, off `GET /v1/executions/:id`. */
async function finishedAt(address: string, execution: number): Promise<string | null> {
  const response = await fetch(`${address}/v1/executions/${execution}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { finished_at: string | null }).finished_at;
}

/** Releases a lease as the operator credential the harness already presents. */
async function releaseLeaseHttp(address: string, leaseId: number): Promise<Response> {
  return await fetch(`${address}/v1/leases/${leaseId}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

/** Every `execution.finished` of one round's own log, in log order. */
async function finishedEvents(address: string, execution: number): Promise<EventRow[]> {
  const response = await fetch(`${address}/v1/executions/${execution}/events`);
  assert.equal(response.status, 200);
  const { events } = (await response.json()) as { events: EventRow[] };
  return events.filter((event) => event.type === 'execution.finished');
}

test('t264 AT1 — execution.finished fires on release even though the transition landed first', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-t264');
  const version = await registerMinimalGraph(address);

  const job = await traveller(address, 2640, version, 'nota que devolve o lease por último');

  // The lease the runner holds for the whole of its dispatch.
  const granted = await requestLease(address, { runner_id: 'runner-t264', job_id: job.id });
  assert.equal(granted.status, 201);
  const { lease } = (await granted.json()) as { lease: LeaseRow };

  // The pinned final node runs and reports first: that is what makes the
  // transition below the fact that completes the job.
  await runFinalNode(address, job.id);
  assert.equal(await finishedAt(address, 2640), null, 'the traveller has not arrived yet');

  // The terminal transition, reported while the lease is still held — the
  // ordering `controller.ts` really produces.
  await moveTo(address, job.id, 'revisar');

  assert.deepEqual(
    await finishedEvents(address, 2640),
    [],
    'every job of the round arrived, but one lease of it is still active',
  );
  assert.equal(await finishedAt(address, 2640), null);

  const released = await releaseLeaseHttp(address, lease.id);
  assert.equal(released.status, 200);

  const announced = await finishedEvents(address, 2640);
  assert.equal(announced.length, 1, 'the release is what makes the condition true, so it announces');
  assert.equal(
    await finishedAt(address, 2640),
    announced[0].occurred_at,
    'and the round reads its end off that very event',
  );
});

test('t264 AT2 — releasing a lease of an unfinished round is a no-op', async (t) => {
  const { address, db } = await start(t);
  await registerRunners(db, 'runner-t264');
  const version = await registerMinimalGraph(address);

  const arrived = await traveller(address, 2641, version, 'nota que chega');
  const midGraph = await traveller(address, 2641, version, 'nota que ainda está redigindo');

  const granted = await requestLease(address, { runner_id: 'runner-t264', job_id: arrived.id });
  assert.equal(granted.status, 201);
  const { lease } = (await granted.json()) as { lease: LeaseRow };

  await runFinalNode(address, arrived.id);
  await moveTo(address, arrived.id, 'revisar');

  const released = await releaseLeaseHttp(address, lease.id);
  assert.equal(released.status, 200, 'the release itself is an ordinary release');

  assert.equal(
    await finishedAt(address, 2641),
    null,
    'half a round is not a round: the other traveller is still at redigir',
  );
  assert.deepEqual(await finishedEvents(address, 2641), [], 'and nothing was written about it');
  assert.equal(midGraph.current_node_id, 'redigir');
});
