/**
 * Access to the `runner` table (t103, FR2).
 *
 * Pairing is only identity: a runner declares an id and starts existing for the
 * control plane. There is no project scope here — `project_id` is declared on
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
 * touches the driver (D1). The COLUMNS are English since D20's fourth child
 * (t229), the lease VALUES this file reads since its fifth (t235), and the field
 * names since t290 — there used to be a `RunnerRow` spelled `nome`/`registrado_em`
 * beside {@link Runner}, a projection that aliased the schema back onto it, and a
 * `toRunner` that renamed the same two fields forward again on the way to
 * `routes/runners.ts`. One shape survived, and it is the one the column already
 * described.
 *
 * The two aggregates in {@link listRunnersWithHealth} kept their aliases and
 * were only re-spelled. `COUNT(CASE …)` and `MAX(l.heartbeat_at)` have no column
 * to be renaming — the alias is the only name they have — so they are called
 * `active_leases` and `last_heartbeat`, which is what {@link RunnerHealth}
 * publishes them as.
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';
import type { ExpirationReason } from './leases.ts';

/** A paired runner: the row AND what `/v1` publishes, in one shape (t290). */
export interface Runner {
  id: string;
  name: string | null;
  registered_at: string;
}

/** The last lease a runner lost to the deadline (t164) — row and wire alike. */
export interface RunnerExpiration {
  job_id: number;
  expires_at: string;
  expiration_reason: ExpirationReason | null;
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
   * Any status, and not just `active`, on purpose: an idle runner between two
   * jobs would otherwise go blank the instant its last lease closed — which is
   * the opposite of what "last heartbeat" is read for.
   */
  last_heartbeat: string | null;
  /** Its most recently expired lease, or `null` if it never lost one. */
  last_expiration: RunnerExpiration | null;
}

/** The row, in the column's own words. */
const COLUMNS = 'id, name, registered_at';

/**
 * @param db Open database.
 * @param id Id declared by the runner.
 * @returns The runner, or `undefined` if it never registered.
 */
export function getRunner(db: Database, id: string): Runner | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM runner WHERE id = ?`).get(id) as Runner | undefined;
}

/**
 * @param db Open database.
 * @returns Every paired runner, in the order they registered.
 */
export function listRunners(db: Database): Runner[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM runner ORDER BY registered_at, id`)
    .all() as Runner[];
}

/**
 * Every paired runner with the liveness the lease table gives away (t164, FR1).
 *
 * Two queries and a join in memory, rather than one query per runner: a fleet
 * is small, but "small" is not a reason to write an N+1 that grows with it.
 *
 * The second query is a window function and not `MAX(expires_at)` with bare
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
      `SELECT r.id, r.name, r.registered_at,
              COUNT(CASE WHEN l.status = 'active' THEN 1 END) AS active_leases,
              MAX(l.heartbeat_at) AS last_heartbeat
         FROM runner r
         LEFT JOIN lease l ON l.runner_id = r.id
        GROUP BY r.id, r.name, r.registered_at
        ORDER BY r.registered_at, r.id`,
    )
    .all() as Array<Runner & { active_leases: number; last_heartbeat: string | null }>;

  const lost = db
    .prepare(
      `SELECT runner_id, job_id, expires_at, expiration_reason
         FROM (SELECT runner_id, job_id, expires_at, expiration_reason,
                      ROW_NUMBER() OVER (
                        PARTITION BY runner_id ORDER BY expires_at DESC, id DESC
                      ) AS recency
                 FROM lease
                WHERE status = 'expired')
        WHERE recency = 1`,
    )
    .all() as Array<RunnerExpiration & { runner_id: string }>;

  const byRunner = new Map(
    lost.map(({ runner_id: runnerId, ...expiration }) => [runnerId, expiration]),
  );

  // Field by field, and not `...runner`: now that the fleet row IS a `Runner`,
  // a spread would also carry the two aggregate columns the query joins onto it
  // — under the very names `RunnerHealth` declares, so nothing would complain
  // and the object would simply be built twice.
  return fleet.map((runner) => ({
    id: runner.id,
    name: runner.name,
    registered_at: runner.registered_at,
    active_leases: runner.active_leases,
    last_heartbeat: runner.last_heartbeat,
    last_expiration: byRunner.get(runner.id) ?? null,
  }));
}

/**
 * Registers (or re-registers) a runner.
 *
 * A second call with the same id is NOT an error and does not duplicate a row:
 * it updates the name, if one came, and returns the row. `registered_at` stays
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
  data: { id: string; name?: string | null },
): { runner: Runner; created: boolean } {
  const created = db.transaction(() => {
    const existing = getRunner(db, data.id);

    if (existing === undefined) {
      db.prepare('INSERT INTO runner (id, name, registered_at) VALUES (?, ?, ?)').run(
        data.id,
        data.name ?? null,
        now(),
      );
      return true;
    }

    if (data.name !== undefined && data.name !== null) {
      db.prepare('UPDATE runner SET name = ? WHERE id = ?').run(data.name, data.id);
    }
    return false;
  })();

  const runner = getRunner(db, data.id);
  if (runner === undefined) throw new Error(`runner "${data.id}" was not written`);
  return { runner, created };
}
