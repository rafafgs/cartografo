/**
 * Access to the `engine_model` table (t166, FR13).
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
 * touches the driver (D1). The COLUMNS are English since D20's fourth child
 * (t229) and the field names since t290 — there used to be an `EngineModelRow`
 * spelled `modelo_id`/`rotulo`/`origem`/`atualizado_em`, a projection that
 * aliased the schema back onto it, and a `toEngineModel` that renamed the same
 * four fields forward again. All three are gone; {@link EngineModel} is what the
 * reads return AND what `/v1` publishes. The two VALUES of `source` were already
 * English — they are the `EngineAdapter`'s own vocabulary.
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** Where a catalog entry came from: the CLI answered, or the adapter knew. */
export type ModelOrigin = 'cli' | 'catalog';

/** The two values `source` accepts, as the migration's CHECK spells them. */
export const MODEL_ORIGINS: readonly ModelOrigin[] = ['cli', 'catalog'];

/** One model an engine offers: the row AND what `/v1` publishes (t290). */
export interface EngineModel {
  model_id: string;
  label: string | null;
  /**
   * Where the entry came from: the CLI answered, or the adapter knew.
   *
   * Neither the key nor the two values translate any more — the column is
   * `source` (`glossary-wire.md` §4.2) and the values already were the
   * `EngineAdapter`'s own vocabulary, on the same terms as `timeout_reason`'s
   * `wall_clock`/`silence`.
   */
  source: ModelOrigin;
  updated_at: string;
}

/** One engine, with everything reported for it, as `/v1` publishes it. */
export interface EngineCatalog {
  engine: string;
  models: EngineModel[];
}

/** One model of an incoming report, already shape-checked by the route. */
export interface ReportedModel {
  model_id: string;
  label?: string | null;
  source: ModelOrigin;
}

const COLUMNS = 'model_id, label, source, updated_at';

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
    db.prepare('DELETE FROM engine_model WHERE engine = ?').run(engine);
    const insert = db.prepare(
      'INSERT INTO engine_model (engine, model_id, label, source, updated_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const model of models) {
      insert.run(engine, model.model_id, model.label ?? null, model.source, timestamp);
    }
  })();

  return { engine, models: listEngineModels(db, engine) };
}

/**
 * @param db Open database.
 * @param engine Name the adapter gives itself.
 * @returns Every model reported for that engine, in identifier order.
 */
export function listEngineModels(db: Database, engine: string): EngineModel[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM engine_model WHERE engine = ? ORDER BY model_id`)
    .all(engine) as EngineModel[];
}

/**
 * Every engine anybody ever reported, with its models.
 *
 * One query and a group in memory, rather than one query per engine: the fleet
 * runs two adapters today, but "small" is not a reason to write an N+1 that
 * grows with it.
 *
 * An engine that reported an EMPTY catalog disappears from this listing, and
 * that is a real limitation of storing only rows — there is no `engine` table to
 * carry the name on its own. The route is what keeps the empty case visible,
 * by answering the report with the engine it just wrote.
 *
 * @param db Open database.
 * @returns One entry per engine, in engine-name order.
 */
export function listEngineCatalogs(db: Database): EngineCatalog[] {
  const rows = db
    .prepare(`SELECT engine, ${COLUMNS} FROM engine_model ORDER BY engine, model_id`)
    .all() as Array<EngineModel & { engine: string }>;

  // `engine` is destructured out rather than left in: it groups the rows, and a
  // model that carried the name of its own engine would be publishing a field
  // `EngineModel` does not declare.
  const byEngine = new Map<string, EngineCatalog>();
  for (const { engine, ...model } of rows) {
    const catalog = byEngine.get(engine) ?? { engine, models: [] };
    catalog.models.push(model);
    byEngine.set(engine, catalog);
  }
  return [...byEngine.values()];
}
