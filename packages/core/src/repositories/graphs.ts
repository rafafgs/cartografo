/**
 * Access to the `graph` and `graph_version` tables (t101, FR5/FR6).
 *
 * Receives the already-open `Database` and never touches the driver — the owner
 * of the database is `src/db/` (D1), and `scripts/check-single-writer.mjs` is
 * the gate of that rule.
 *
 * Append-only by construction: there is no DELETE and no UPDATE of
 * `graph_version` in this module, and the only UPDATE of `graph` is the
 * pointer's. That is what holds up D15's "nothing is erased" — and what makes
 * reverting a pointer move rather than an undo.
 *
 * The COLUMNS are English since D20's fourth child (t229); the row interfaces'
 * field names are not, because `routes/graphs.ts` and `routes/proposals.ts` read
 * them, so every `SELECT` aliases the renamed column back onto the field (t229,
 * FR4). Since t226 the rows no longer leave the package that way either:
 * `toGraph`/`toGraphVersion`/`toClass` at the bottom are the translation
 * boundary D20 puts between the database and the wire, and the routes return
 * their output and never a row.
 */

import type { Database } from '../db/connection.ts';
import type { GraphDocument } from '../domain/graph.ts';
import { hashSnapshot, canonicalSerialize } from '../domain/hash.ts';
import { now } from './common.ts';

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

const GRAPH_COLUMNS = `id, class AS classe, lineage_type AS linhagem_tipo,
   base_class AS base_classe, origin_proposal_id AS origem_proposta_id,
   current_version_id AS versao_corrente_id, created_at AS criado_em`;
const VERSION_COLUMNS = `id, graph_id AS grafo_id, parent_version AS versao_pai,
   source AS origem, proposal_id AS proposta_id, created_at AS criado_em`;

/**
 * @param db Open database.
 * @param id Lineage id (= class, for a base graph).
 * @returns The lineage, or `undefined` if it does not exist.
 */
export function getGraph(db: Database, id: string): GraphRow | undefined {
  return db.prepare(`SELECT ${GRAPH_COLUMNS} FROM graph WHERE id = ?`).get(id) as
    | GraphRow
    | undefined;
}

/**
 * @param db Open database.
 * @returns Every lineage, in creation order.
 */
export function listGraphs(db: Database): GraphRow[] {
  return db
    .prepare(`SELECT ${GRAPH_COLUMNS} FROM graph ORDER BY created_at, id`)
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
      `SELECT class AS classe, id AS grafo_id,
              current_version_id AS versao_corrente_id, created_at AS criado_em
         FROM graph
        WHERE lineage_type = 'base'
        ORDER BY class`,
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
    .prepare(
      `SELECT ${VERSION_COLUMNS} FROM graph_version WHERE graph_id = ? ORDER BY created_at, id`,
    )
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
    .prepare(`SELECT ${VERSION_COLUMNS}, snapshot FROM graph_version WHERE id = ?`)
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
  return db.prepare(`SELECT ${VERSION_COLUMNS} FROM graph_version WHERE id = ?`).get(id) as
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
    .prepare(`SELECT ${GRAPH_COLUMNS} FROM graph WHERE class = ? AND lineage_type = 'base'`)
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
    `INSERT INTO graph_version (id, graph_id, parent_version, snapshot, source, proposal_id, created_at)
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
  db.prepare('UPDATE graph SET current_version_id = ? WHERE id = ?').run(versionId, graphId);
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
  const className = document.problem_class;
  const versionId = hashSnapshot(document);
  const createdAt = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO graph (id, class, lineage_type, base_class, origin_proposal_id, current_version_id, created_at)
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

/** Arguments of `forkVariant`, already validated by the route. */
export interface VariantFork {
  /** The base lineage being forked; it carries the class and the current pointer. */
  base: GraphRow;
  /** Id of the lineage being born — the request says it, it is not derived. */
  id: string;
  /** Proposal that originated the fork, or `null` when there is none (D13). */
  originProposalId: number | null;
  /** Document of the variant: the base snapshot with `lineage` swapped. */
  document: GraphDocument;
  /** Hash of that document, already checked for collision by the caller. */
  versionId: string;
}

/**
 * Bootstrap of a variant lineage out of a base one, in one transaction (D13).
 *
 * Branch semantics: the first version of the variant IS the base's current
 * snapshot, with no diff, and `versao_pai` points at the version it was forked
 * from — a parenthood that crosses lineages, which the schema allows because
 * `graph_version.parent_version` only references `graph_version(id)`, with no
 * demand that both sides share a `graph_id`.
 *
 * It moves the pointer for the same reason `registerBaseGraph` does: this is the
 * lineage's first version and there is no previous "current" to preserve.
 *
 * @param db Open database.
 * @param data Base lineage, id of the new one, origin proposal, document and hash.
 * @returns The variant lineage and its first version, as they were written.
 */
export function forkVariant(
  db: Database,
  data: VariantFork,
): { graph: GraphRow; version: GraphVersionRow } {
  const { base, id, originProposalId, document, versionId } = data;
  const createdAt = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO graph (id, class, lineage_type, base_class, origin_proposal_id, current_version_id, created_at)
       VALUES (?, ?, 'variante', ?, ?, NULL, ?)`,
    ).run(id, base.classe, base.classe, originProposalId, createdAt);

    // Same treatment `registerBaseGraph` gives a bootstrap version with no
    // proposal behind it: with an origin proposal the version comes from it, and
    // without one it is a manual write.
    insertVersion(db, {
      id: versionId,
      grafo_id: id,
      versao_pai: base.versao_corrente_id,
      snapshot: document,
      origem: originProposalId === null ? 'manual' : 'proposta',
      proposta_id: originProposalId,
      criado_em: createdAt,
    });

    movePointer(db, id, versionId);
  })();

  const graph = getGraph(db, id);
  const version = getVersionSummary(db, versionId);
  if (graph === undefined || version === undefined) {
    throw new Error(`variant "${id}" was not written`);
  }

  return { graph, version };
}

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/*                                                                             */
/* D20 fixes the order: the wire goes English BEFORE the database does. Between */
/* the two there has to be an explicit translation, or the rename would drag    */
/* the columns along with it — which is the fourth child ticket's job, not this */
/* one's. Everything above this line still says `linhagem_tipo`; everything the */
/* routes hand to Fastify says `lineage_type`, and nothing in between.         */
/*                                                                             */
/* Same shape as `repositories/skill.ts`'s `toSkill`/`ROLE_FIELD` pair, which   */
/* has been the one instance of this pattern in the package since t178.        */
/* -------------------------------------------------------------------------- */

/**
 * `lineage_type`, both ways.
 *
 * `migrations/0002_grafo_versao_proposta.sql` puts the Portuguese values in a
 * `CHECK`, which makes them part of the DB schema rather than of the format —
 * so a request that says `variant` is stored as `variante` and comes back out
 * as `variant`. `base` is spelled the same in both languages and is listed here
 * anyway: a map with a hole in it is a map somebody has to remember to read
 * around.
 */
const LINEAGE_FIELD: Record<string, string> = { base: 'base', variante: 'variant' };
const LINEAGE_COLUMN: Record<string, string> = { base: 'base', variant: 'variante' };

/**
 * `graph_version.source`, both ways.
 *
 * `manual` is already English; the other two are not (`glossario-wire.md` §1.6,
 * which routes the value `proposta` through its §1.3 row on purpose — one word,
 * one translation, whether it names the entity or this column's value).
 */
const SOURCE_FIELD: Record<string, string> = {
  manual: 'manual',
  sintetizador: 'synthesizer',
  proposta: 'proposal',
};

/** The English `lineage_type` a request declared, as the column spells it. */
export function lineageTypeColumn(value: string): string | undefined {
  return LINEAGE_COLUMN[value];
}

/** A lineage, as `/v1` publishes it. */
export interface Graph {
  id: string;
  class: string;
  lineage_type: string;
  base_class: string | null;
  origin_proposal_id: number | null;
  current_version_id: string | null;
  created_at: string;
}

/** A version, as `/v1` publishes it — the snapshot only when it was asked for. */
export interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
}

/** A version with the whole document. */
export interface GraphVersionWithSnapshot extends GraphVersion {
  snapshot: GraphDocument;
}

/** A registered class, in the catalogue view. */
export interface ClassEntry {
  class: string;
  graph_id: string;
  current_version_id: string | null;
  created_at: string;
}

/** Row to wire: the one place the lineage's column names meet the API's. */
export function toGraph(row: GraphRow): Graph {
  return {
    id: row.id,
    class: row.classe,
    lineage_type: LINEAGE_FIELD[row.linhagem_tipo] ?? row.linhagem_tipo,
    base_class: row.base_classe,
    origin_proposal_id: row.origem_proposta_id,
    current_version_id: row.versao_corrente_id,
    created_at: row.criado_em,
  };
}

/** Row to wire, for a version. */
export function toGraphVersion(row: GraphVersionRow): GraphVersion {
  return {
    id: row.id,
    graph_id: row.grafo_id,
    parent_version: row.versao_pai,
    source: SOURCE_FIELD[row.origem] ?? row.origem,
    proposal_id: row.proposta_id,
    created_at: row.criado_em,
  };
}

/**
 * Row to wire, snapshot included.
 *
 * The snapshot passes through byte for byte: it is the graph DOCUMENT
 * (`schema/grafo.schema.json`), a format of its own that no child of D20
 * renames — and rewriting it here would change the hash that IS the version's
 * identity.
 */
export function toGraphVersionWithSnapshot(
  row: GraphVersionRowWithSnapshot,
): GraphVersionWithSnapshot {
  return { ...toGraphVersion(row), snapshot: row.snapshot };
}

/** Row to wire, for the class catalogue. */
export function toClass(row: ClassRow): ClassEntry {
  return {
    class: row.classe,
    graph_id: row.grafo_id,
    current_version_id: row.versao_corrente_id,
    created_at: row.criado_em,
  };
}
