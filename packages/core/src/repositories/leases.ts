/**
 * Access to the `lease` table (t103, FR3/FR9) — the mechanism of D5.
 *
 * A lease is a runner's temporary right over a job: it is born with a deadline
 * (`expires_at`), is pushed forward by heartbeats and ends in three ways —
 * released by its owner, expired past its deadline, or replaced when the runner
 * dies and another one claims the job.
 *
 * Two guarantees live here, and both depend on the transaction having no `await`
 * in the middle:
 *
 * 1. **The cap is never exceeded.** Counting the active leases and writing the
 *    new one have to be a single step. Between the count and the write, N
 *    concurrent requests would all count the same number and all believe
 *    themselves within the cap. It is the same care (and the same shape:
 *    a synchronous `db.transaction()`) as `applyProposal` in t101.
 * 2. **Claiming expired ones is the first step of granting**, in the SAME
 *    transaction: the request that discovers a dead lease is the request that
 *    replaces it, and there is no window in which the job has no owner and
 *    nobody noticed.
 *
 * `now` is injectable (default: the real clock) so that "the deadline passed" is
 * testable without a `sleep`. It is the only concession to testing in the
 * signature, and it pays off: the end-to-end path with real time stays proven in
 * AT17.
 *
 * Since t196 this file emits `lease.granted` and `lease.expired` into the
 * append-only log, inside the same transactions that write the rows — the
 * columns below already carried everything the two events ask for, and what was
 * missing was only the call. One event per LEASE, never per sweep: `expireOverdue`
 * kills a batch with one `UPDATE`, and a single event for it would say "some
 * leases died" to a consumer that has to know which.
 *
 * What still leaves no trace is an ordinary release: the taxonomy has no
 * `lease.released` type, so `releaseLease` below writes a row and nothing else.
 * Growing the taxonomy is a decision of its own, recorded as a follow-up in
 * t196's Out of Scope and in `docs/spec/runner-and-controller.md` §7.
 *
 * The COLUMNS are English since D20's fourth child (t229), the stored VALUES
 * since its fifth (t235), and the field names since t290 — there used to be a
 * `LeaseRow` spelled `trabalho_id`/`projeto_id`/`ttl_segundos`/…, a projection
 * that aliased the schema back onto it, and a `toLease`/`toGrantResult` pair
 * that renamed the same eight fields forward again for `routes/leases.ts`. One
 * shape survived per concept: {@link Lease} is what a read returns AND what
 * `/v1` publishes, and {@link GrantResult} answers with `reason` on both sides.
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import { API_ACTOR, now } from './common.ts';

/** Possible states of a lease, as the `CHECK` of migration `0004` spells them. */
export type LeaseStatus = 'active' | 'released' | 'expired';

/**
 * Why a lease died, in the vocabulary of
 * `especificacoes/eventos/schemas/lease.expired.schema.json`.
 */
export type ExpirationReason = 'heartbeat_lost' | 'ttl_elapsed';

/**
 * Why a lease request did not become a lease. None of these is an error.
 *
 * Never stored, and English anyway: it is the `reason` a refusal answers with,
 * and `runner_cap`/`project_cap` are one glossary term each (§1.5) — the same
 * word is the BODY FIELD a runner declares and the VALUE that comes back
 * refusing it, so one name serves both.
 */
export type RefusalReason = 'job_already_leased' | 'runner_cap' | 'project_cap';

/** A lease: the row AND what `/v1` publishes, in one shape (t226 FR1, t290). */
export interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
  status: LeaseStatus;
  ttl_seconds: number;
  granted_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  expiration_reason: ExpirationReason | null;
}

/** What the runner declares when disputing a job. */
export interface LeaseRequest {
  runner_id: string;
  project_id: number;
  job_id: number;
  /** Cap of simultaneous active leases for that runner. */
  runner_cap: number;
  /** Cap of simultaneous active leases for that project, across runners. */
  project_cap: number;
  ttl_seconds: number;
}

/**
 * Result of a request: either a lease came out, or the reason it did not.
 *
 * A refusal is not an error — it is "not now", and the runner tries the next
 * candidate, and it keeps its `200`: from a runner's point of view a full cap is
 * the common case of a healthy pool. This shape IS the response body (t226 FR4,
 * t290): the key was `motivo` here and `reason` on the wire until the pair of
 * translators between them was deleted.
 */
export type GrantResult =
  | { lease: Lease; reason?: undefined }
  | { lease: null; reason: RefusalReason };

/** Injectable clock; without it, the real clock. */
export interface ClockOptions {
  now?: () => string;
}

/** Listing filters (FR8). */
export interface LeaseFilters {
  project_id?: number;
  runner_id?: string;
  status?: LeaseStatus;
}

/** The row, in the column's own words. */
const COLUMNS = `id, runner_id, job_id, project_id,
                 status, ttl_seconds, granted_at,
                 heartbeat_at, expires_at,
                 released_at,
                 expiration_reason`;

/* -------------------------------------------------------------------------- */
/* What is left of the row → wire boundary (t226 FR1, t290).                   */
/*                                                                             */
/* Three enums used to cross here, and all three are `CHECK`-constrained in    */
/* `migrations/0004_runner_lease.sql`. There is nothing to translate any more: */
/* D20's fourth child (t229) renamed the columns, its fifth (t235) rewrote the */
/* migrations so the CHECK itself spells `active`, `released`, `expired`,      */
/* `heartbeat_lost` and `ttl_elapsed` — the wire's own words — and t290 took   */
/* the field names with them. What were two maps per enum, then one list per   */
/* enum, is now one list that VALIDATES a `?status=` a caller wrote rather     */
/* than converting one.                                                        */
/* -------------------------------------------------------------------------- */

/** The three statuses a `?status=` filter may name — the column's own three. */
export const LEASE_STATUSES: readonly LeaseStatus[] = Object.freeze([
  'active',
  'released',
  'expired',
]);

/**
 * The `status` a request declared, if the column can hold it.
 *
 * @param value What the query string said.
 * @returns The same word, or `undefined` when the column has no such state.
 */
export function leaseStatusColumn(value: string): LeaseStatus | undefined {
  return LEASE_STATUSES.find((status) => status === value);
}

/** An ISO 8601 instant shifted by seconds — the lease's deadline arithmetic. */
function addSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString();
}

/**
 * @param db Open database.
 * @param id Lease id.
 * @returns The lease, or `undefined`.
 */
export function getLease(db: Database, id: number): Lease | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM lease WHERE id = ?`).get(id) as Lease | undefined;
}

/**
 * @param db Open database.
 * @param filters Optional slice by project, runner and status.
 * @returns The matching leases, from the most recent to the oldest.
 */
export function listLeases(db: Database, filters: LeaseFilters = {}): Lease[] {
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (filters.project_id !== undefined) {
    conditions.push('project_id = ?');
    values.push(filters.project_id);
  }
  if (filters.runner_id !== undefined) {
    conditions.push('runner_id = ?');
    values.push(filters.runner_id);
  }
  if (filters.status !== undefined) {
    conditions.push('status = ?');
    values.push(filters.status);
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  return db
    .prepare(`SELECT ${COLUMNS} FROM lease${where} ORDER BY id`)
    .all(...values) as Lease[];
}

/**
 * Marks as expired every active lease whose deadline has already passed.
 *
 * No transaction of its own: it is called inside the transaction of whoever
 * reconciles (the grant) or inside the transaction of `claimExpired`.
 *
 * The reason distinguishes the two possible deaths, with the vocabulary of the
 * `lease.expired` event: a lease that was NEVER renewed (`heartbeat_at` still
 * equal to `granted_at`) simply ran out — the runner may not even have
 * started; one that was renewed at least once and then stopped lost its
 * heartbeat, which is the sign of a runner dead mid-job.
 *
 * The event is recorded HERE, inside the loop that re-reads each row, and not at
 * the two call sites: this is the only place that knows which leases died and
 * why, and emitting one event per row is what keeps the bulk `UPDATE` above from
 * collapsing several deaths into a single fact (t196, FR7).
 *
 * @param db Open database, inside a transaction.
 * @param moment Reference instant.
 * @returns The leases that died in this pass.
 */
function expireOverdue(db: Database, moment: string): Lease[] {
  const overdue = db
    .prepare("SELECT id FROM lease WHERE status = 'active' AND expires_at < ?")
    .all(moment) as Array<{ id: number }>;
  if (overdue.length === 0) return [];

  db.prepare(
    `UPDATE lease
        SET status = 'expired',
            expiration_reason = CASE
              WHEN heartbeat_at = granted_at THEN 'ttl_elapsed'
              ELSE 'heartbeat_lost'
            END
      WHERE status = 'active' AND expires_at < ?`,
  ).run(moment);

  return overdue.map(({ id }) => {
    const lease = getLease(db, id);
    if (lease === undefined) throw new Error(`lease ${id} vanished during the claim`);

    recordEvent(db, {
      type: 'lease.expired',
      // The lease's own project, never a default: this row carries the column
      // (`migrations/0004_runner_lease.sql`), unlike `graph_version`.
      project_id: lease.project_id,
      execution_id: null,
      entity: { type: 'lease', id: lease.id },
      actor: API_ACTOR,
      occurred_at: moment,
      data: { runner_id: lease.runner_id, reason: lease.expiration_reason },
    });

    return lease;
  });
}

/**
 * Claims, in one transaction, every job whose owner let the deadline pass.
 *
 * It is the first step of `grantLease` (FR5/FR9) and is exported on its own
 * because it is a fact of the system with value of its own: "these leases died
 * and why" is exactly what the `lease.expired` event carries, one per lease,
 * since t196. Both callers get the emission for free — it happens inside
 * `expireOverdue`, in whichever transaction is open.
 *
 * @param db Open database.
 * @param options Injectable clock.
 * @returns The leases expired in this call.
 */
export function claimExpired(db: Database, options: ClockOptions = {}): Lease[] {
  const clock = options.now ?? now;
  return db.transaction(() => expireOverdue(db, clock()))();
}

/**
 * Grants a lease, if there is room and the job is free.
 *
 * The whole transaction runs without an `await`: reconciling expired ones,
 * checking the owner, counting both caps and writing are a single step. It is
 * what makes AT12 (N simultaneous requests against M jobs) end with at most
 * `project_cap` active leases — the count that decides is the same one the
 * write uses.
 *
 * `job_id` is an opaque integer: this function does not read the `job`
 * table (t102). Real eligibility (blocked, current node) is decided by the
 * controller before getting here.
 *
 * @param db Open database.
 * @param request Runner, project, job, both caps and the TTL.
 * @param options Injectable clock.
 * @returns The granted lease, or the reason for the refusal.
 */
export function grantLease(
  db: Database,
  request: LeaseRequest,
  options: ClockOptions = {},
): GrantResult {
  const clock = options.now ?? now;

  return db.transaction((): GrantResult => {
    const moment = clock();

    // Always the first step: a dead runner's job goes back to the queue before
    // any decision about this request (D5).
    expireOverdue(db, moment);

    const owner = db
      .prepare("SELECT id FROM lease WHERE job_id = ? AND status = 'active'")
      .get(request.job_id);
    if (owner !== undefined) return { lease: null, reason: 'job_already_leased' };

    const ofRunner = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE runner_id = ? AND status = 'active'")
      .get(request.runner_id) as { total: number };
    if (ofRunner.total >= request.runner_cap) return { lease: null, reason: 'runner_cap' };

    const ofProject = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE project_id = ? AND status = 'active'")
      .get(request.project_id) as { total: number };
    if (ofProject.total >= request.project_cap) return { lease: null, reason: 'project_cap' };

    const effect = db
      .prepare(
        `INSERT INTO lease (runner_id, job_id, project_id, status, ttl_seconds,
                            granted_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        request.runner_id,
        request.job_id,
        request.project_id,
        request.ttl_seconds,
        moment,
        // Born equal to `granted_at`: that is how a never-renewed lease is told
        // apart from one that lost its heartbeat, when the deadline passes.
        moment,
        addSeconds(moment, request.ttl_seconds),
      );

    const lease = getLease(db, Number(effect.lastInsertRowid));
    if (lease === undefined) throw new Error('the lease was not written');

    // Inside the same transaction as the INSERT, and only on the path that
    // really wrote one: a refusal above returns before reaching this line, and a
    // log that recorded it would be counting dispatches that never happened.
    recordEvent(db, {
      type: 'lease.granted',
      project_id: lease.project_id,
      execution_id: null,
      entity: { type: 'lease', id: lease.id },
      actor: API_ACTOR,
      occurred_at: moment,
      data: {
        job_id: lease.job_id,
        runner_id: lease.runner_id,
        expires_at: lease.expires_at,
      },
    });

    return { lease };
  })();
}

/**
 * Renews the deadline of an active lease (heartbeat).
 *
 * The UPDATE is guarded by `status = 'active'`: if the lease died between the
 * route's check and this write, the transaction falls instead of resurrecting a
 * job that may already have another owner.
 *
 * @param db Open database.
 * @param data Id and, optionally, a new TTL (default: the lease's own).
 * @param options Injectable clock.
 * @returns The renewed lease.
 */
export function renewLease(
  db: Database,
  data: { id: number; ttl_seconds?: number },
  options: ClockOptions = {},
): Lease {
  const clock = options.now ?? now;

  db.transaction(() => {
    const current = getLease(db, data.id);
    if (current === undefined) throw new Error(`lease ${data.id} vanished during the heartbeat`);

    const moment = clock();
    const ttl = data.ttl_seconds ?? current.ttl_seconds;
    const effect = db
      .prepare(
        `UPDATE lease SET ttl_seconds = ?, heartbeat_at = ?, expires_at = ?
          WHERE id = ? AND status = 'active'`,
      )
      .run(ttl, moment, addSeconds(moment, ttl), data.id);

    if (effect.changes !== 1) {
      throw new Error(`lease ${data.id} stopped being active during the heartbeat`);
    }
  })();

  const renewed = getLease(db, data.id);
  if (renewed === undefined) throw new Error(`lease ${data.id} is gone`);
  return renewed;
}

/**
 * Releases an active lease: the job is over (well or badly) and the slot returns.
 *
 * Capacity returns right away, not when the TTL runs out — the next grant to the
 * same runner/project already does not count this lease.
 *
 * @param db Open database.
 * @param id Lease id.
 * @param options Injectable clock.
 * @returns The released lease.
 */
export function releaseLease(db: Database, id: number, options: ClockOptions = {}): Lease {
  const clock = options.now ?? now;

  db.transaction(() => {
    const effect = db
      .prepare(
        "UPDATE lease SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(clock(), id);

    if (effect.changes !== 1) {
      throw new Error(`lease ${id} stopped being active during the release`);
    }
  })();

  const released = getLease(db, id);
  if (released === undefined) throw new Error(`lease ${id} is gone`);
  return released;
}
