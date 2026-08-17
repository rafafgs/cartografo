/**
 * The lease half of t196: the D5 lifecycle leaves a trace in the log.
 *
 * `lease.granted` and `lease.expired` have had a schema since t98 and no writer
 * until this ticket — so "who held what, and how it died" existed only in the
 * `lease` projection, which is exactly the entity D15 wants joined against
 * telemetry.
 *
 * Two things here are worth more than the rest:
 *
 * - **One event per lease, never one per batch.** `expireOverdue` expires with a
 *   single bulk `UPDATE ... WHERE status = 'active' AND expires_at < ?`, so the
 *   easy mistake is to record the sweep instead of the deaths. The test below
 *   kills two leases in one pass, for two different reasons, and demands two
 *   events with two reasons.
 * - **A refusal is not a grant.** `{lease: null, reason}` is a `200`, and a log
 *   that recorded it as a lease would be counting dispatches that never happened.
 *
 * The clock is injected on the route module (`registerLeases(app, db, {now})`),
 * the same assembly `leases.test.ts` uses for AT10/AT11: the fact under test is
 * time passing, and a real `sleep` would only make it slow.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from 'fastify';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as LeaseRepositoryModule from '../src/repositories/leases.ts';
import type * as LeaseRoutesModule from '../src/routes/leases.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as RunnersModule from '../src/repositories/runners.ts';
import { MIGRATIONS_DIR, loadEvents, requireArtifacts, type Event } from './support.ts';

/** A lease, as `/v1` publishes it — only the fields these tests read. */
interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
  status: string;
  expires_at: string;
  expiration_reason: string | null;
}

interface GrantResponse {
  lease: Lease | null;
  reason?: string;
}

/** A control plane made of the lease routes alone, on a clock the test owns. */
interface LeasePlane {
  address: string;
  db: Database;
  advance: (seconds: number) => void;
}

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

/**
 * The lease routes on a controlled clock, against a throwaway database.
 *
 * @param t Test context, used to register the shutdown.
 * @param start Instant the clock starts at.
 * @returns Base URL, the open database and the handle that moves time forward.
 */
async function startLeasePlane(
  t: TestHook,
  start = '2026-08-17T12:00:00.000Z',
): Promise<LeasePlane> {
  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');
  const { registerLeases } = await load<typeof LeaseRoutesModule>('src/routes/leases.ts');

  let instant = Date.parse(start);
  const now = (): string => new Date(instant).toISOString();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t196-leases-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const app = Fastify({ logger: false });
  app.register(async (scope) => registerLeases(scope, db, { now }), { prefix: '/v1' });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return {
    address,
    db,
    advance: (seconds: number) => {
      instant += seconds * 1000;
    },
  };
}

/** A lease is the right of a PAIRED runner: the pool has to exist first. */
async function registerRunners(db: Database, ...ids: string[]): Promise<void> {
  const { registerRunner } = await load<typeof RunnersModule>('src/repositories/runners.ts');
  for (const id of ids) registerRunner(db, { id });
}

interface GrantRequest {
  runner_id: string;
  job_id: number;
  project_id?: number;
  runner_cap?: number;
  project_cap?: number;
  ttl_seconds?: number;
}

/** `POST /v1/leases` — the dispute, with this suite's defaults filled in. */
async function askForLease(
  plane: LeasePlane,
  body: GrantRequest,
): Promise<{ status: number; body: GrantResponse }> {
  const response = await fetch(`${plane.address}/v1/leases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project_id: 1,
      runner_cap: 8,
      project_cap: 8,
      ttl_seconds: 60,
      ...body,
    }),
  });
  return { status: response.status, body: (await response.json()) as GrantResponse };
}

/** A granted lease, or a failed assertion — the refusal cases ask explicitly. */
async function grant(plane: LeasePlane, body: GrantRequest): Promise<Lease> {
  const response = await askForLease(plane, body);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(response.body.lease !== null, 'a 201 always carries the lease');
  return response.body.lease;
}

/** Every `lease.*` event in the log, in the log's own order. */
async function leaseEvents(plane: LeasePlane, type?: string): Promise<Event[]> {
  const { listEvents } = await loadEvents();
  return listEvents(plane.db).filter(
    (event) => event.type.startsWith('lease.') && (type === undefined || event.type === type),
  );
}

test('t196 AT6 — a granted lease records exactly one lease.granted', async (t) => {
  const plane = await startLeasePlane(t);
  await registerRunners(plane.db, 'runner-a');

  const lease = await grant(plane, { runner_id: 'runner-a', job_id: 7, ttl_seconds: 30 });

  const events = await leaseEvents(plane);
  assert.equal(events.length, 1, 'one grant, one fact');
  assert.equal(events[0].type, 'lease.granted');
  assert.deepEqual(
    events[0].entity,
    { type: 'lease', id: lease.id },
    'the subject is the lease itself, so the log joins on the projection\'s own id',
  );
  assert.equal(events[0].actor.type, 'system');
  assert.equal(events[0].project_id, 1, 'a lease carries its own project, and the event copies it');
  assert.deepEqual(events[0].data, {
    job_id: 7,
    runner_id: 'runner-a',
    expires_at: lease.expires_at,
  });
});

test('t196 AT7 — a refused grant records nothing', async (t) => {
  const plane = await startLeasePlane(t);
  await registerRunners(plane.db, 'runner-a', 'runner-b', 'runner-c');

  const held = await grant(plane, {
    runner_id: 'runner-a',
    job_id: 1,
    project_id: 42,
    runner_cap: 1,
    project_cap: 1,
  });

  const refusals: Array<[string, GrantRequest]> = [
    ['job_already_leased', { runner_id: 'runner-b', job_id: 1, project_id: 42, project_cap: 8 }],
    ['runner_cap', { runner_id: 'runner-a', job_id: 2, project_id: 42, runner_cap: 1 }],
    ['project_cap', { runner_id: 'runner-c', job_id: 3, project_id: 42, project_cap: 1 }],
  ];

  for (const [reason, body] of refusals) {
    const response = await askForLease(plane, body);
    assert.equal(response.status, 200, `${reason} is "not now", not an error`);
    assert.equal(response.body.lease, null);
    assert.equal(response.body.reason, reason);
  }

  const events = await leaseEvents(plane);
  assert.equal(events.length, 1, 'three refusals recorded nothing: only the held lease is in the log');
  assert.deepEqual(events[0].entity, { type: 'lease', id: held.id });
});

test('t196 AT8 — a bulk expiration records one lease.expired per lease, with its own reason', async (t) => {
  const plane = await startLeasePlane(t);
  await registerRunners(plane.db, 'runner-a', 'runner-b', 'runner-c');

  const neverRenewed = await grant(plane, { runner_id: 'runner-a', job_id: 1, ttl_seconds: 10 });
  const wentSilent = await grant(plane, { runner_id: 'runner-b', job_id: 2, ttl_seconds: 10 });

  plane.advance(3);
  const beat = await fetch(`${plane.address}/v1/leases/${wentSilent.id}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(beat.status, 200);

  // Both runners stop here, and both deadlines pass — so the next grant expires
  // the two of them in ONE `UPDATE`.
  plane.advance(60);
  await grant(plane, { runner_id: 'runner-c', job_id: 3, ttl_seconds: 10 });

  const expired = await leaseEvents(plane, 'lease.expired');
  assert.equal(expired.length, 2, 'one event per lease that died, never one for the batch');

  const byLease = new Map(expired.map((event) => [Number(event.entity.id), event]));
  const first = byLease.get(neverRenewed.id);
  const second = byLease.get(wentSilent.id);
  assert.ok(first !== undefined && second !== undefined, 'both dead leases are named');

  assert.deepEqual(first.entity, { type: 'lease', id: neverRenewed.id });
  assert.deepEqual(first.data, { runner_id: 'runner-a', reason: 'ttl_elapsed' });
  assert.deepEqual(second.entity, { type: 'lease', id: wentSilent.id });
  assert.deepEqual(second.data, { runner_id: 'runner-b', reason: 'heartbeat_lost' });

  // And the log agrees with the projection it was written beside.
  const listed = await fetch(`${plane.address}/v1/leases?status=expired`);
  const { leases } = (await listed.json()) as { leases: Lease[] };
  assert.deepEqual(
    leases.map((lease) => [lease.id, lease.expiration_reason]).sort(),
    [
      [neverRenewed.id, 'ttl_elapsed'],
      [wentSilent.id, 'heartbeat_lost'],
    ].sort(),
  );
});

test('t196 AT8 — claimExpired, the other caller, records the same fact', async (t) => {
  const plane = await startLeasePlane(t);
  await registerRunners(plane.db, 'runner-a');
  const { claimExpired } = await load<typeof LeaseRepositoryModule>('src/repositories/leases.ts');

  const doomed = await grant(plane, { runner_id: 'runner-a', job_id: 1, ttl_seconds: 10 });
  const later = new Date(Date.parse(doomed.expires_at) + 1000).toISOString();

  // The sweep has no route of its own (Out of Scope): it is called from the
  // grant and from here, and both go through the same `expireOverdue`.
  const claimed = claimExpired(plane.db, { now: () => later });
  assert.deepEqual(
    claimed.map((lease) => lease.id),
    [doomed.id],
  );

  const expired = await leaseEvents(plane, 'lease.expired');
  assert.equal(expired.length, 1);
  assert.deepEqual(expired[0].entity, { type: 'lease', id: doomed.id });
  assert.deepEqual(expired[0].data, { runner_id: 'runner-a', reason: 'ttl_elapsed' });
  assert.equal(expired[0].occurred_at, later, 'the fact is stamped with the sweep\'s own instant');
});
