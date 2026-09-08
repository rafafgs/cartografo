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

/** What a runner's row says about the machine behind it (t491). */
export type RunnerStatus = 'active' | 'retired';

/** A paired runner: the row AND what `/v1` publishes, in one shape (t290). */
export interface Runner {
  id: string;
  name: string | null;
  registered_at: string;
  /**
   * `'retired'` once the process deregistered on its way out (t491).
   *
   * Unconstrained in SQL, on `0035_input_request_origin.sql`'s own reasoning:
   * the two words live here, and a third one costs no table rebuild.
   */
  status: RunnerStatus;
  /** Last time the machine said anything — every `registerRunner` refreshes it. */
  last_seen_at: string;
}

/**
 * How long a silent runner is still called present (t491, FR3).
 *
 * The runner re-registers once per controller-loop iteration, which is every
 * two seconds by default, so this is ~90 missed ticks of slack before a machine
 * is reported absent — a margin comparable to the two missed beats the lease
 * heartbeat already budgets (`controller.ts`).
 *
 * It is a deadline read at QUERY time and never a sweep: nothing writes to a
 * row to make it absent, so a machine that comes back is present again on its
 * very next call, with no reconciliation in between.
 */
export const RUNNER_LIVENESS_SECONDS = 180;

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
const COLUMNS = 'id, name, registered_at, status, last_seen_at';

/**
 * The `WHERE` clause of "which machines are up right now" (t491, FR3).
 *
 * Two conditions, and they answer two different questions: `status` is what a
 * process said on its way out, `last_seen_at` is what it stopped saying. A
 * clean exit is invisible immediately; a `kill -9`, a laptop lid, a severed
 * network are invisible {@link RUNNER_LIVENESS_SECONDS} later.
 *
 * The comparison is a string one, which is exactly what an ISO 8601 instant in
 * UTC is for: `leases.ts` already reads `expires_at` the same way.
 *
 * @param alias Table alias the clause is written against.
 * @returns The predicate, with one `?` for the deadline.
 */
function presentClause(alias: string): string {
  return `${alias}.status = 'active' AND ${alias}.last_seen_at >= ?`;
}

/** The instant a runner has to have been seen at, to count as present now. */
function presenceDeadline(): string {
  return new Date(Date.now() - RUNNER_LIVENESS_SECONDS * 1000).toISOString();
}

/**
 * @param db Open database.
 * @param id Id declared by the runner.
 * @returns The runner, or `undefined` if it never registered.
 */
export function getRunner(db: Database, id: string): Runner | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM runner WHERE id = ?`).get(id) as Runner | undefined;
}

/**
 * Every runner that is up right now, in the order they registered.
 *
 * Present, and not merely paired, since t491: a row this skips is still a row,
 * and {@link getRunner} still answers for it — which is what keeps a machine
 * that went quiet from getting a false `404` on the call that would revive it.
 *
 * @param db Open database.
 * @returns Every present runner, in the order they registered.
 */
export function listRunners(db: Database): Runner[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM runner WHERE ${presentClause('runner')} ORDER BY registered_at, id`,
    )
    .all(presenceDeadline()) as Runner[];
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
      `SELECT r.id, r.name, r.registered_at, r.status, r.last_seen_at,
              COUNT(CASE WHEN l.status = 'active' THEN 1 END) AS active_leases,
              MAX(l.heartbeat_at) AS last_heartbeat
         FROM runner r
         LEFT JOIN lease l ON l.runner_id = r.id
        WHERE ${presentClause('r')}
        GROUP BY r.id, r.name, r.registered_at, r.status, r.last_seen_at
        ORDER BY r.registered_at, r.id`,
    )
    .all(presenceDeadline()) as Array<
    Runner & { active_leases: number; last_heartbeat: string | null }
  >;

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
    status: runner.status,
    last_seen_at: runner.last_seen_at,
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
 * Since t491 every call — the first and every one after it — also writes
 * `status = 'active'` and a fresh `last_seen_at`. That is what makes this the
 * heartbeat of the fleet page and not only its pairing: the runner calls it
 * once per loop iteration, and a machine that deregistered and came back is
 * revived by the same line that would have created it.
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

    const moment = now();

    if (existing === undefined) {
      db.prepare(
        `INSERT INTO runner (id, name, registered_at, status, last_seen_at)
         VALUES (?, ?, ?, 'active', ?)`,
      ).run(data.id, data.name ?? null, moment, moment);
      return true;
    }

    // The name is conditional and the liveness is not: a runner that sent no
    // name is not asking for the one it has to be erased, while a call that did
    // not refresh `last_seen_at` would be a heartbeat that does not beat.
    if (data.name !== undefined && data.name !== null) {
      db.prepare('UPDATE runner SET name = ? WHERE id = ?').run(data.name, data.id);
    }
    db.prepare("UPDATE runner SET status = 'active', last_seen_at = ? WHERE id = ?").run(
      moment,
      data.id,
    );
    return false;
  })();

  const runner = getRunner(db, data.id);
  if (runner === undefined) throw new Error(`runner "${data.id}" was not written`);
  return { runner, created };
}

/**
 * Marks a runner as no longer running (t491, FR2).
 *
 * What a process reports on its own way out, so that a clean stop is invisible
 * to the fleet page IMMEDIATELY instead of {@link RUNNER_LIVENESS_SECONDS}
 * later. The row survives: `credential.runner_id` and `lease.runner_id`
 * reference it, and the history of what that machine did is not the kind of
 * thing a shutdown gets to delete (D15's spirit, and `0037`'s own note).
 *
 * Idempotent, and it has to be: retiring twice is a stop reported twice, which
 * is not an error anywhere else in this API either (D5).
 *
 * @param db Open database.
 * @param id Id of the runner that stopped.
 * @returns The row as it now stands.
 * @throws {Error} If the id does not exist — the route checks that first, and
 *   answers `404 unknown_runner` before ever reaching here.
 */
export function retireRunner(db: Database, id: string): Runner {
  db.prepare("UPDATE runner SET status = 'retired' WHERE id = ?").run(id);

  const runner = getRunner(db, id);
  if (runner === undefined) throw new Error(`runner "${id}" does not exist`);
  return runner;
}
