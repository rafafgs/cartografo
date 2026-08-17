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
 * This file does NOT emit `lease.concedida`/`lease.expirada`: both depend on the
 * `event` table and on `src/db/events.ts`, deliverables of t102 (the same cut
 * t101 made for `graph_version.*`). The columns below already carry everything
 * the two events ask for.
 *
 * The COLUMNS are English since D20's fourth child (t229); {@link LeaseRow}'s
 * field names are not, because `routes/leases.ts` and `runners.ts` read them, so
 * every `SELECT` aliases the renamed column back onto the field (t229, FR4). The
 * status and reason VALUES stay Portuguese — that child renamed identifiers
 * only.
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** Possible states of a lease. */
export type LeaseStatus = 'ativa' | 'liberada' | 'expirada';

/**
 * Why a lease died, in the vocabulary of
 * `especificacoes/eventos/schemas/lease.expirada.schema.json`.
 */
export type ExpirationReason = 'heartbeat_perdido' | 'expirou';

/** Why a lease request did not become a lease. None of these is an error. */
export type RefusalReason = 'trabalho_ja_leased' | 'teto_runner' | 'teto_projeto';

/** A lease, as it is in the database. */
export interface LeaseRow {
  id: number;
  runner_id: string;
  trabalho_id: number;
  projeto_id: number;
  status: LeaseStatus;
  ttl_segundos: number;
  concedida_em: string;
  heartbeat_em: string;
  expira_em: string;
  liberada_em: string | null;
  motivo_expiracao: ExpirationReason | null;
}

/** What the runner declares when disputing a job. */
export interface LeaseRequest {
  runner_id: string;
  projeto_id: number;
  trabalho_id: number;
  /** Cap of simultaneous active leases for that runner. */
  teto_runner: number;
  /** Cap of simultaneous active leases for that project, across runners. */
  teto_projeto: number;
  ttl_segundos: number;
}

/**
 * Result of a request: either a lease came out, or the reason it did not.
 *
 * A refusal is not an error — it is "not now", and the runner tries the next
 * candidate.
 */
export type GrantResult =
  | { lease: LeaseRow; motivo?: undefined }
  | { lease: null; motivo: RefusalReason };

/** Injectable clock; without it, the real clock. */
export interface ClockOptions {
  now?: () => string;
}

/** Listing filters (FR8). */
export interface LeaseFilters {
  projeto_id?: number;
  runner_id?: string;
  status?: LeaseStatus;
}

/** The row, read back into {@link LeaseRow}'s spelling (t229, FR4). */
const COLUMNS = `id, runner_id, job_id AS trabalho_id, project_id AS projeto_id,
                 status, ttl_seconds AS ttl_segundos, granted_at AS concedida_em,
                 heartbeat_at AS heartbeat_em, expires_at AS expira_em,
                 released_at AS liberada_em,
                 expiration_reason AS motivo_expiracao`;

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/*                                                                             */
/* Three enums cross here, and all three are `CHECK`-constrained in            */
/* `migrations/0004_runner_lease.sql`, which is what makes them schema rather  */
/* than format — the same reasoning `skill.ts`'s `ROLE_COLUMN` pair wrote down */
/* first. The wire says `active` and the column keeps saying `ativa`: D20's    */
/* fourth child (t229) renamed the column, never the values it holds (founder  */
/* decision, 2026-08-17), so all three maps stay.                             */
/* -------------------------------------------------------------------------- */

const STATUS_FIELD: Record<string, string> = {
  ativa: 'active',
  liberada: 'released',
  expirada: 'expired',
};

const STATUS_COLUMN: Record<string, LeaseStatus> = {
  active: 'ativa',
  released: 'liberada',
  expired: 'expirada',
};

const EXPIRATION_FIELD: Record<string, string> = {
  heartbeat_perdido: 'heartbeat_lost',
  expirou: 'ttl_elapsed',
};

/**
 * The English `expiration_reason` of a row's `expiration_reason` column.
 *
 * Exported because `repositories/runners.ts` republishes the very same value
 * inside `RunnerHealth.last_expiration`, and two copies of one map is how two
 * spellings of one word start.
 *
 * @param value The column's value, or `null` when the lease is not expired.
 * @returns The wire's value, or `null`.
 */
export function toExpirationReason(value: string | null): string | null {
  if (value === null) return null;
  return EXPIRATION_FIELD[value] ?? value;
}

/**
 * Why a request did not become a lease, on the wire.
 *
 * `teto_runner`/`teto_projeto` are one term each in the glossary (§1.5): the
 * same word is the BODY FIELD a runner declares and the VALUE that comes back
 * refusing it, so one name serves both — `runner_cap` in and `runner_cap` out.
 */
const REFUSAL_FIELD: Record<RefusalReason, string> = {
  trabalho_ja_leased: 'job_already_leased',
  teto_runner: 'runner_cap',
  teto_projeto: 'project_cap',
};

/** The three statuses a `?status=` filter may name, in the wire's spelling. */
export const LEASE_STATUSES: readonly string[] = Object.freeze(Object.keys(STATUS_COLUMN));

/** The English `status` a request declared, as the column spells it. */
export function leaseStatusColumn(value: string): LeaseStatus | undefined {
  return STATUS_COLUMN[value];
}

/** A lease, as `/v1` publishes it. */
export interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
  status: string;
  ttl_seconds: number;
  granted_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  expiration_reason: string | null;
}

/** Row to wire: the one place the lease's column names meet the API's. */
export function toLease(row: LeaseRow): Lease {
  return {
    id: row.id,
    runner_id: row.runner_id,
    job_id: row.trabalho_id,
    project_id: row.projeto_id,
    status: STATUS_FIELD[row.status] ?? row.status,
    ttl_seconds: row.ttl_segundos,
    granted_at: row.concedida_em,
    heartbeat_at: row.heartbeat_em,
    expires_at: row.expira_em,
    released_at: row.liberada_em,
    expiration_reason: toExpirationReason(row.motivo_expiracao),
  };
}

/**
 * The grant's answer, on the wire.
 *
 * The refusal keeps its `200`: from a runner's point of view a full cap is "not
 * now, try the next one" and is the common case of a healthy pool, not an
 * error — so `{lease: null, reason}` is a successful answer that happens to
 * carry no lease, and t226 renames the key without touching the status (FR4).
 */
export type WireGrantResult =
  | { lease: Lease; reason?: undefined }
  | { lease: null; reason: string };

/** Grant result to wire, refusal reason included. */
export function toGrantResult(result: GrantResult): WireGrantResult {
  if (result.lease === null) return { lease: null, reason: REFUSAL_FIELD[result.motivo] };
  return { lease: toLease(result.lease) };
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
export function getLease(db: Database, id: number): LeaseRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM lease WHERE id = ?`).get(id) as
    | LeaseRow
    | undefined;
}

/**
 * @param db Open database.
 * @param filters Optional slice by project, runner and status.
 * @returns The matching leases, from the most recent to the oldest.
 */
export function listLeases(db: Database, filters: LeaseFilters = {}): LeaseRow[] {
  const conditions: string[] = [];
  const values: Array<string | number> = [];

  if (filters.projeto_id !== undefined) {
    conditions.push('project_id = ?');
    values.push(filters.projeto_id);
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
    .all(...values) as LeaseRow[];
}

/**
 * Marks as expired every active lease whose deadline has already passed.
 *
 * No transaction of its own: it is called inside the transaction of whoever
 * reconciles (the grant) or inside the transaction of `claimExpired`.
 *
 * The reason distinguishes the two possible deaths, with the vocabulary of the
 * `lease.expirada` event: a lease that was NEVER renewed (`heartbeat_at` still
 * equal to `granted_at`) simply ran out — the runner may not even have
 * started; one that was renewed at least once and then stopped lost its
 * heartbeat, which is the sign of a runner dead mid-job.
 *
 * @param db Open database, inside a transaction.
 * @param moment Reference instant.
 * @returns The leases that died in this pass.
 */
function expireOverdue(db: Database, moment: string): LeaseRow[] {
  const overdue = db
    .prepare("SELECT id FROM lease WHERE status = 'ativa' AND expires_at < ?")
    .all(moment) as Array<{ id: number }>;
  if (overdue.length === 0) return [];

  db.prepare(
    `UPDATE lease
        SET status = 'expirada',
            expiration_reason = CASE
              WHEN heartbeat_at = granted_at THEN 'expirou'
              ELSE 'heartbeat_perdido'
            END
      WHERE status = 'ativa' AND expires_at < ?`,
  ).run(moment);

  return overdue.map(({ id }) => {
    const lease = getLease(db, id);
    if (lease === undefined) throw new Error(`lease ${id} vanished during the claim`);
    return lease;
  });
}

/**
 * Claims, in one transaction, every job whose owner let the deadline pass.
 *
 * It is the first step of `grantLease` (FR5/FR9) and is exported on its own
 * because it is a fact of the system with value of its own: "these leases died
 * and why" is exactly what the `lease.expirada` event will carry when t102 turns
 * telemetry on.
 *
 * @param db Open database.
 * @param options Injectable clock.
 * @returns The leases expired in this call.
 */
export function claimExpired(db: Database, options: ClockOptions = {}): LeaseRow[] {
  const clock = options.now ?? now;
  return db.transaction(() => expireOverdue(db, clock()))();
}

/**
 * Grants a lease, if there is room and the job is free.
 *
 * The whole transaction runs without an `await`: reconciling expired ones,
 * checking the owner, counting both caps and writing are a single step. It is
 * what makes AT12 (N simultaneous requests against M jobs) end with at most
 * `teto_projeto` active leases — the count that decides is the same one the
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
      .prepare("SELECT id FROM lease WHERE job_id = ? AND status = 'ativa'")
      .get(request.trabalho_id);
    if (owner !== undefined) return { lease: null, motivo: 'trabalho_ja_leased' };

    const ofRunner = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE runner_id = ? AND status = 'ativa'")
      .get(request.runner_id) as { total: number };
    if (ofRunner.total >= request.teto_runner) return { lease: null, motivo: 'teto_runner' };

    const ofProject = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE project_id = ? AND status = 'ativa'")
      .get(request.projeto_id) as { total: number };
    if (ofProject.total >= request.teto_projeto) return { lease: null, motivo: 'teto_projeto' };

    const effect = db
      .prepare(
        `INSERT INTO lease (runner_id, job_id, project_id, status, ttl_seconds,
                            granted_at, heartbeat_at, expires_at)
         VALUES (?, ?, ?, 'ativa', ?, ?, ?, ?)`,
      )
      .run(
        request.runner_id,
        request.trabalho_id,
        request.projeto_id,
        request.ttl_segundos,
        moment,
        // Born equal to `granted_at`: that is how a never-renewed lease is told
        // apart from one that lost its heartbeat, when the deadline passes.
        moment,
        addSeconds(moment, request.ttl_segundos),
      );

    const lease = getLease(db, Number(effect.lastInsertRowid));
    if (lease === undefined) throw new Error('the lease was not written');
    return { lease };
  })();
}

/**
 * Renews the deadline of an active lease (heartbeat).
 *
 * The UPDATE is guarded by `status = 'ativa'`: if the lease died between the
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
  data: { id: number; ttl_segundos?: number },
  options: ClockOptions = {},
): LeaseRow {
  const clock = options.now ?? now;

  db.transaction(() => {
    const current = getLease(db, data.id);
    if (current === undefined) throw new Error(`lease ${data.id} vanished during the heartbeat`);

    const moment = clock();
    const ttl = data.ttl_segundos ?? current.ttl_segundos;
    const effect = db
      .prepare(
        `UPDATE lease SET ttl_seconds = ?, heartbeat_at = ?, expires_at = ?
          WHERE id = ? AND status = 'ativa'`,
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
export function releaseLease(
  db: Database,
  id: number,
  options: ClockOptions = {},
): LeaseRow {
  const clock = options.now ?? now;

  db.transaction(() => {
    const effect = db
      .prepare(
        "UPDATE lease SET status = 'liberada', released_at = ? WHERE id = ? AND status = 'ativa'",
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
