/**
 * Access to the `runner` table (t103, FR2).
 *
 * Pairing is only identity: a runner declares an id and starts existing for the
 * control plane. There is no project scope here — `projeto_id` is declared on
 * every lease request, because one physical runner can serve different projects
 * over time.
 *
 * Registering is idempotent by construction, and that is the point: D5 demands
 * "idempotent writes in the API", and the common case for a runner is precisely
 * restarting — a crash, a deploy, a machine that came back — and introducing
 * itself again with the SAME id. Failing the second time would turn a routine
 * event into an incident.
 *
 * Like the other repositories, it receives the already-open database and never
 * touches the driver (D1). The row's field names mirror the untouched migration
 * columns, so they stay in Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';
import { toExpirationReason, type ExpirationReason } from './leases.ts';

/** A paired runner, as the row spells it. */
export interface RunnerRow {
  id: string;
  nome: string | null;
  registrado_em: string;
}

/** A paired runner, as `/v1` publishes it (t226, FR1). */
export interface Runner {
  id: string;
  name: string | null;
  registered_at: string;
}

/** Row to wire: the one place the runner's column names meet the API's. */
export function toRunner(row: RunnerRow): Runner {
  return { id: row.id, name: row.nome, registered_at: row.registrado_em };
}

/** The last lease a runner lost to the deadline, as the row spells it (t164). */
interface RunnerExpirationRow {
  trabalho_id: number;
  expira_em: string;
  motivo_expiracao: ExpirationReason | null;
}

/** The same fact, as `/v1` publishes it (t226, FR1). */
export interface RunnerExpiration {
  job_id: number;
  expires_at: string;
  expiration_reason: string | null;
}

/**
 * A paired runner, plus what the lease table already knows about it (t164, FR1).
 *
 * Everything here is DERIVED, and there is no second mechanism keeping it warm:
 * a runner is alive to this control plane exactly as far as its leases say so.
 * The price is written down in the ticket and worth repeating — a runner that
 * never held a lease is indistinguishable from one that is down.
 */
export interface RunnerHealth extends Runner {
  /** Leases this runner is holding right now. */
  active_leases: number;
  /**
   * When it was last heard from, across EVERY lease it ever held.
   *
   * Any status, and not just `ativa`, on purpose: an idle runner between two
   * jobs would otherwise go blank the instant its last lease closed — which is
   * the opposite of what "last heartbeat" is read for.
   */
  last_heartbeat: string | null;
  /** Its most recently expired lease, or `null` if it never lost one. */
  last_expiration: RunnerExpiration | null;
}

const COLUMNS = 'id, nome, registrado_em';

/**
 * @param db Open database.
 * @param id Id declared by the runner.
 * @returns The runner, or `undefined` if it never registered.
 */
export function getRunner(db: Database, id: string): RunnerRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM runner WHERE id = ?`).get(id) as
    | RunnerRow
    | undefined;
}

/**
 * @param db Open database.
 * @returns Every paired runner, in the order they registered.
 */
export function listRunners(db: Database): RunnerRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM runner ORDER BY registrado_em, id`)
    .all() as RunnerRow[];
}

/**
 * Every paired runner with the liveness the lease table gives away (t164, FR1).
 *
 * Two queries and a join in memory, rather than one query per runner: a fleet
 * is small, but "small" is not a reason to write an N+1 that grows with it.
 *
 * The second query is a window function and not `MAX(expira_em)` with bare
 * columns: SQLite would answer that too, but the tie-break between two leases
 * that fell due in the same millisecond would be its choice and not this
 * file's, and the fleet page would flip between two rows for no reason.
 *
 * @param db Open database.
 * @returns One row per runner, in the same order as {@link listRunners}.
 */
export function listRunnersWithHealth(db: Database): RunnerHealth[] {
  const fleet = db
    .prepare(
      `SELECT r.id, r.nome, r.registrado_em,
              COUNT(CASE WHEN l.status = 'ativa' THEN 1 END) AS leases_ativas,
              MAX(l.heartbeat_em) AS ultimo_heartbeat
         FROM runner r
         LEFT JOIN lease l ON l.runner_id = r.id
        GROUP BY r.id, r.nome, r.registrado_em
        ORDER BY r.registrado_em, r.id`,
    )
    .all() as Array<RunnerRow & { leases_ativas: number; ultimo_heartbeat: string | null }>;

  const lost = db
    .prepare(
      `SELECT runner_id, trabalho_id, expira_em, motivo_expiracao
         FROM (SELECT runner_id, trabalho_id, expira_em, motivo_expiracao,
                      ROW_NUMBER() OVER (
                        PARTITION BY runner_id ORDER BY expira_em DESC, id DESC
                      ) AS recency
                 FROM lease
                WHERE status = 'expirada')
        WHERE recency = 1`,
    )
    .all() as Array<RunnerExpirationRow & { runner_id: string }>;

  const byRunner = new Map(
    lost.map(({ runner_id: runnerId, ...expiration }) => [
      runnerId,
      {
        job_id: expiration.trabalho_id,
        expires_at: expiration.expira_em,
        expiration_reason: toExpirationReason(expiration.motivo_expiracao),
      },
    ]),
  );

  return fleet.map((runner) => ({
    ...toRunner(runner),
    active_leases: runner.leases_ativas,
    last_heartbeat: runner.ultimo_heartbeat,
    last_expiration: byRunner.get(runner.id) ?? null,
  }));
}

/**
 * Registers (or re-registers) a runner.
 *
 * A second call with the same id is NOT an error and does not duplicate a row:
 * it updates the name, if one came, and returns the row. `registrado_em` stays
 * the first pairing — it is the date that id appeared in the system, and
 * rewriting it on every restart would erase the only trace of the runner's age.
 *
 * @param db Open database.
 * @param data Declared id and, optionally, a readable name.
 * @returns The written row and whether THIS call is the one that created the
 *   record — that is what separates `201` from `200` in the route (FR4).
 */
export function registerRunner(
  db: Database,
  data: { id: string; nome?: string | null },
): { runner: RunnerRow; created: boolean } {
  const created = db.transaction(() => {
    const existing = getRunner(db, data.id);

    if (existing === undefined) {
      db.prepare('INSERT INTO runner (id, nome, registrado_em) VALUES (?, ?, ?)').run(
        data.id,
        data.nome ?? null,
        now(),
      );
      return true;
    }

    if (data.nome !== undefined && data.nome !== null) {
      db.prepare('UPDATE runner SET nome = ? WHERE id = ?').run(data.nome, data.id);
    }
    return false;
  })();

  const runner = getRunner(db, data.id);
  if (runner === undefined) throw new Error(`runner "${data.id}" was not written`);
  return { runner, created };
}
