/**
 * Access to the `grafo` and `grafo_versao` tables (t101, FR5/FR6).
 *
 * Receives the already-open `Database` and never touches the driver — the owner
 * of the database is `src/db/` (D1), and `scripts/check-single-writer.mjs` is
 * the gate of that rule.
 *
 * Append-only by construction: there is no DELETE and no UPDATE of
 * `grafo_versao` in this module, and the only UPDATE of `grafo` is the pointer's.
 * That is what holds up D15's "nothing is erased" — and what makes reverting a
 * pointer move rather than an undo.
 *
 * The row interfaces mirror the untouched migration columns, so their field
 * names stay in Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import type { GraphDocument } from '../domain/graph.ts';
import { hashSnapshot, canonicalSerialize } from '../domain/hash.ts';

/** Lineage of a graph: the class and the pointer to the version that holds today. */
export interface GraphRow {
  id: string;
  classe: string;
  linhagem_tipo: string;
  base_classe: string | null;
  origem_proposta_id: number | null;
  versao_corrente_id: string | null;
  criado_em: string;
}

/** A version, without the snapshot — the big body only comes out when asked for. */
export interface GraphVersionRow {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  criado_em: string;
}

/** A version with the whole document, already parsed. */
export interface GraphVersionRowWithSnapshot extends GraphVersionRow {
  snapshot: GraphDocument;
}

/** A registered class, in the catalogue view. */
export interface ClassRow {
  classe: string;
  grafo_id: string;
  versao_corrente_id: string | null;
  criado_em: string;
}

const GRAPH_COLUMNS =
  'id, classe, linhagem_tipo, base_classe, origem_proposta_id, versao_corrente_id, criado_em';
const VERSION_COLUMNS = 'id, grafo_id, versao_pai, origem, proposta_id, criado_em';

/** Moment of the write, in ISO 8601 — same format as the migration runner. */
export function now(): string {
  return new Date().toISOString();
}

/**
 * @param db Open database.
 * @param id Lineage id (= class, for a base graph).
 * @returns The lineage, or `undefined` if it does not exist.
 */
export function getGraph(db: Database, id: string): GraphRow | undefined {
  return db.prepare(`SELECT ${GRAPH_COLUMNS} FROM grafo WHERE id = ?`).get(id) as
    | GraphRow
    | undefined;
}

/**
 * @param db Open database.
 * @returns Every lineage, in creation order.
 */
export function listGraphs(db: Database): GraphRow[] {
  return db
    .prepare(`SELECT ${GRAPH_COLUMNS} FROM grafo ORDER BY criado_em, id`)
    .all() as GraphRow[];
}

/**
 * Class catalogue (D8: the class is the identity named by the user).
 *
 * Only base lineages enter: a variant is a project fork (D13), not a new class.
 *
 * @param db Open database.
 * @returns One entry per registered class.
 */
export function listClasses(db: Database): ClassRow[] {
  return db
    .prepare(
      `SELECT classe, id AS grafo_id, versao_corrente_id, criado_em
         FROM grafo
        WHERE linhagem_tipo = 'base'
        ORDER BY classe`,
    )
    .all() as ClassRow[];
}

/**
 * The whole version chain of a graph, including the ones abandoned by a revert.
 *
 * @param db Open database.
 * @param graphId Lineage id.
 * @returns Versions in creation order.
 */
export function listVersions(db: Database, graphId: string): GraphVersionRow[] {
  return db
    .prepare(`SELECT ${VERSION_COLUMNS} FROM grafo_versao WHERE grafo_id = ? ORDER BY criado_em, id`)
    .all(graphId) as GraphVersionRow[];
}

/**
 * @param db Open database.
 * @param id Version hash.
 * @returns The version with the snapshot already parsed, or `undefined`.
 */
export function getVersion(
  db: Database,
  id: string,
): GraphVersionRowWithSnapshot | undefined {
  const row = db
    .prepare(`SELECT ${VERSION_COLUMNS}, snapshot FROM grafo_versao WHERE id = ?`)
    .get(id) as (GraphVersionRow & { snapshot: string }) | undefined;
  if (row === undefined) return undefined;
  return { ...row, snapshot: JSON.parse(row.snapshot) as GraphDocument };
}

/**
 * The same version as `getVersion`, without loading the whole snapshot.
 *
 * @param db Open database.
 * @param id Version hash.
 * @returns The version metadata, or `undefined`.
 */
export function getVersionSummary(db: Database, id: string): GraphVersionRow | undefined {
  return db.prepare(`SELECT ${VERSION_COLUMNS} FROM grafo_versao WHERE id = ?`).get(id) as
    | GraphVersionRow
    | undefined;
}

/**
 * @param db Open database.
 * @param className Class looked for.
 * @returns The base lineage of the class, if it already exists.
 */
export function getClassBase(db: Database, className: string): GraphRow | undefined {
  return db
    .prepare(`SELECT ${GRAPH_COLUMNS} FROM grafo WHERE classe = ? AND linhagem_tipo = 'base'`)
    .get(className) as GraphRow | undefined;
}

/**
 * Writes a new version. INSERT only: a version is never rewritten.
 *
 * @param db Open database (inside a transaction, when the caller opens one).
 * @param data Lineage, parent, already validated snapshot and origin.
 */
export function insertVersion(
  db: Database,
  data: {
    id: string;
    grafo_id: string;
    versao_pai: string | null;
    snapshot: GraphDocument;
    origem: 'manual' | 'sintetizador' | 'proposta';
    proposta_id: number | null;
    criado_em: string;
  },
): void {
  db.prepare(
    `INSERT INTO grafo_versao (id, grafo_id, versao_pai, snapshot, origem, proposta_id, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.grafo_id,
    data.versao_pai,
    canonicalSerialize(data.snapshot),
    data.origem,
    data.proposta_id,
    data.criado_em,
  );
}

/**
 * Moves the lineage's current-version pointer.
 *
 * It is the ONLY path that changes what "holds today" — both applying and
 * reverting go through here, in opposite directions.
 *
 * @param db Open database.
 * @param graphId Lineage.
 * @param versionId Version that starts to hold.
 */
export function movePointer(db: Database, graphId: string, versionId: string): void {
  db.prepare('UPDATE grafo SET versao_corrente_id = ? WHERE id = ?').run(versionId, graphId);
}

/**
 * Bootstrap of a new base lineage, in one transaction.
 *
 * Registering normally does NOT move the pointer
 * (`especificacoes/eventos/taxonomia.md`), but here it does: it is the lineage's
 * first version, there is no previous "current" to preserve, and a lineage
 * without a pointer would be a graph that exists without holding.
 *
 * @param db Open database.
 * @param document Already validated document (structure + soundness).
 * @returns The lineage and the version as they were written.
 */
export function registerBaseGraph(
  db: Database,
  document: GraphDocument,
): { graph: GraphRow; version: GraphVersionRow } {
  const className = document.classe;
  const versionId = hashSnapshot(document);
  const createdAt = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO grafo (id, classe, linhagem_tipo, base_classe, origem_proposta_id, versao_corrente_id, criado_em)
       VALUES (?, ?, 'base', NULL, NULL, NULL, ?)`,
    ).run(className, className, createdAt);

    insertVersion(db, {
      id: versionId,
      grafo_id: className,
      versao_pai: null,
      snapshot: document,
      origem: 'manual',
      proposta_id: null,
      criado_em: createdAt,
    });

    movePointer(db, className, versionId);
  })();

  const graph = getGraph(db, className);
  const version = getVersionSummary(db, versionId);
  if (graph === undefined || version === undefined) {
    throw new Error(`graph "${className}" was not written`);
  }

  return { graph, version };
}
