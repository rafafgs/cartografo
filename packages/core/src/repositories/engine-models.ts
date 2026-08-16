/**
 * Access to the `motor_modelo` table (t166, FR13).
 *
 * The control plane still does not know what an engine is. What it keeps here
 * is a RELAY: a runner started, asked its adapter which models exist on that
 * machine, and reported the answer. Nothing in this module resolves, validates
 * or ranks a model — the catalog is discovery, and the only thing that refuses
 * an unknown identifier is the engine's own CLI, when the session opens.
 *
 * **A report replaces, never merges.** {@link reportEngineModels} deletes the
 * engine's rows before writing the new ones, inside one transaction. Merging
 * would keep a model an engine stopped offering alive forever, and an operator
 * reading the catalog would be reading a menu that no longer exists. The price
 * is stated and small: two runners of the same engine with different catalogs
 * overwrite each other, last report wins — which is the honest answer while a
 * catalog is a property of the ENGINE and not of the machine.
 *
 * Like every other repository it receives the already-open database and never
 * touches the driver (D1). The row's field names mirror the migration's columns,
 * so they stay in Portuguese (t127, FR8); the two values of `origem` stay
 * English because they are the `EngineAdapter`'s own vocabulary.
 */

import type { Database } from '../db/connection.ts';
import { now } from './graphs.ts';

/** Where a catalog entry came from: the CLI answered, or the adapter knew. */
export type ModelOrigin = 'cli' | 'catalog';

/** The two values `origem` accepts, as the migration's CHECK spells them. */
export const MODEL_ORIGINS: readonly ModelOrigin[] = ['cli', 'catalog'];

/** One model an engine offers, as a runner reported it. */
export interface EngineModelRow {
  modelo_id: string;
  rotulo: string | null;
  origem: ModelOrigin;
  atualizado_em: string;
}

/** One engine, with everything reported for it. */
export interface EngineCatalog {
  motor: string;
  modelos: EngineModelRow[];
}

/** One model of an incoming report, already shape-checked by the route. */
export interface ReportedModel {
  modelo_id: string;
  rotulo?: string | null;
  origem: ModelOrigin;
}

const COLUMNS = 'modelo_id, rotulo, origem, atualizado_em';

/**
 * Replaces the stored catalog of one engine with what was just reported.
 *
 * One transaction, and it has to be: between the delete and the insert the
 * engine has NO models, and a concurrent read of that window would report an
 * engine that offers nothing — which is a different fact, and one this route
 * can also legitimately record (an empty report).
 *
 * @param db Open database.
 * @param engine Name the adapter gives itself.
 * @param models What the runner reported, in the order it reported it.
 * @returns The catalog as it now stands.
 */
export function reportEngineModels(
  db: Database,
  engine: string,
  models: readonly ReportedModel[],
): EngineCatalog {
  const timestamp = now();

  db.transaction(() => {
    db.prepare('DELETE FROM motor_modelo WHERE motor = ?').run(engine);
    const insert = db.prepare(
      'INSERT INTO motor_modelo (motor, modelo_id, rotulo, origem, atualizado_em) VALUES (?, ?, ?, ?, ?)',
    );
    for (const model of models) {
      insert.run(engine, model.modelo_id, model.rotulo ?? null, model.origem, timestamp);
    }
  })();

  return { motor: engine, modelos: listEngineModels(db, engine) };
}

/**
 * @param db Open database.
 * @param engine Name the adapter gives itself.
 * @returns Every model reported for that engine, in identifier order.
 */
export function listEngineModels(db: Database, engine: string): EngineModelRow[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM motor_modelo WHERE motor = ? ORDER BY modelo_id`)
    .all(engine) as EngineModelRow[];
}

/**
 * Every engine anybody ever reported, with its models.
 *
 * One query and a group in memory, rather than one query per engine: the fleet
 * runs two adapters today, but "small" is not a reason to write an N+1 that
 * grows with it.
 *
 * An engine that reported an EMPTY catalog disappears from this listing, and
 * that is a real limitation of storing only rows — there is no `motor` table to
 * carry the name on its own. The route is what keeps the empty case visible,
 * by answering the report with the engine it just wrote.
 *
 * @param db Open database.
 * @returns One entry per engine, in engine-name order.
 */
export function listEngineCatalogs(db: Database): EngineCatalog[] {
  const rows = db
    .prepare(`SELECT motor, ${COLUMNS} FROM motor_modelo ORDER BY motor, modelo_id`)
    .all() as Array<EngineModelRow & { motor: string }>;

  const byEngine = new Map<string, EngineCatalog>();
  for (const { motor, ...model } of rows) {
    const catalog = byEngine.get(motor) ?? { motor, modelos: [] };
    catalog.modelos.push(model);
    byEngine.set(motor, catalog);
  }
  return [...byEngine.values()];
}
