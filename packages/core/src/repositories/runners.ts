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
import { now } from './graphs.ts';

/** A paired runner. */
export interface RunnerRow {
  id: string;
  nome: string | null;
  registrado_em: string;
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
