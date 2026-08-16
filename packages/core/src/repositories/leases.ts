/**
 * Access to the `lease` table (t103, FR3/FR9) — the mechanism of D5.
 *
 * A lease is a runner's temporary right over a job: it is born with a deadline
 * (`expira_em`), is pushed forward by heartbeats and ends in three ways —
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
 * `evento` table and on `src/db/events.ts`, deliverables of t102 (the same cut
 * t101 made for `grafo_versao.*`). The columns below already carry everything
 * the two events ask for.
 *
 * The row's field names and the status/reason values mirror the untouched
 * migration and the event taxonomy, so they stay in Portuguese (t127, FR8).
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

const COLUMNS = `id, runner_id, trabalho_id, projeto_id, status, ttl_segundos,
                 concedida_em, heartbeat_em, expira_em, liberada_em, motivo_expiracao`;

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
    conditions.push('projeto_id = ?');
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
 * `lease.expirada` event: a lease that was NEVER renewed (`heartbeat_em` still
 * equal to `concedida_em`) simply ran out — the runner may not even have
 * started; one that was renewed at least once and then stopped lost its
 * heartbeat, which is the sign of a runner dead mid-job.
 *
 * @param db Open database, inside a transaction.
 * @param moment Reference instant.
 * @returns The leases that died in this pass.
 */
function expireOverdue(db: Database, moment: string): LeaseRow[] {
  const overdue = db
    .prepare("SELECT id FROM lease WHERE status = 'ativa' AND expira_em < ?")
    .all(moment) as Array<{ id: number }>;
  if (overdue.length === 0) return [];

  db.prepare(
    `UPDATE lease
        SET status = 'expirada',
            motivo_expiracao = CASE
              WHEN heartbeat_em = concedida_em THEN 'expirou'
              ELSE 'heartbeat_perdido'
            END
      WHERE status = 'ativa' AND expira_em < ?`,
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
 * `trabalho_id` is an opaque integer: this function does not read the `trabalho`
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
      .prepare("SELECT id FROM lease WHERE trabalho_id = ? AND status = 'ativa'")
      .get(request.trabalho_id);
    if (owner !== undefined) return { lease: null, motivo: 'trabalho_ja_leased' };

    const ofRunner = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE runner_id = ? AND status = 'ativa'")
      .get(request.runner_id) as { total: number };
    if (ofRunner.total >= request.teto_runner) return { lease: null, motivo: 'teto_runner' };

    const ofProject = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE projeto_id = ? AND status = 'ativa'")
      .get(request.projeto_id) as { total: number };
    if (ofProject.total >= request.teto_projeto) return { lease: null, motivo: 'teto_projeto' };

    const effect = db
      .prepare(
        `INSERT INTO lease (runner_id, trabalho_id, projeto_id, status, ttl_segundos,
                            concedida_em, heartbeat_em, expira_em)
         VALUES (?, ?, ?, 'ativa', ?, ?, ?, ?)`,
      )
      .run(
        request.runner_id,
        request.trabalho_id,
        request.projeto_id,
        request.ttl_segundos,
        moment,
        // Born equal to `concedida_em`: that is how a never-renewed lease is told
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
        `UPDATE lease SET ttl_segundos = ?, heartbeat_em = ?, expira_em = ?
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
      .prepare("UPDATE lease SET status = 'liberada', liberada_em = ? WHERE id = ? AND status = 'ativa'")
      .run(clock(), id);

    if (effect.changes !== 1) {
      throw new Error(`lease ${id} stopped being active during the release`);
    }
  })();

  const released = getLease(db, id);
  if (released === undefined) throw new Error(`lease ${id} is gone`);
  return released;
}
