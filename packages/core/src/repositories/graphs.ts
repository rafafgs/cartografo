/**
 * Access to the `graph` and `graph_version` tables (t101, FR5/FR6).
 *
 * Receives the already-open `Database` and never touches the driver — the owner
 * of the database is `src/db/` (D1), and `scripts/check-single-writer.mjs` is
 * the gate of that rule.
 *
 * Append-only by construction: there is no DELETE of anything here, the only
 * UPDATE of `graph` is the pointer's, and `graph_version` takes exactly ONE
 * UPDATE — `recheckContracts` below, which moves `contracts_state` off
 * `unchecked` when the manifest a pin was waiting for is registered (t283).
 * That exception is a mutable STATUS on an otherwise frozen row, the same shape
 * `skill.deprecated_at` already has (`repositories/skill.ts`), and it touches
 * neither the snapshot, nor the parent, nor the hash that IS the version's
 * identity. D15's "nothing is erased" is about content, and the content of a
 * version is still written once — which is what makes reverting a pointer move
 * rather than an undo.
 *
 * Since t196 every write here also writes to the LOG, in the same transaction:
 * `recordVersionBirth` below is the pair `graph_version.registered` +
 * `graph_version.applied` that the two bootstrap functions owe, and
 * `repositories/proposals.ts` calls the same helper when applying. Before that
 * the log knew nothing about graph mutation, which is half of what D15 wants the
 * surveyor to be able to join telemetry against.
 *
 * The COLUMNS are English since D20's fourth child (t229); the row interfaces'
 * field names are not, because `routes/graphs.ts` and `routes/proposals.ts` read
 * them, so every `SELECT` aliases the renamed column back onto the field (t229,
 * FR4). Since t226 the rows no longer leave the package that way either:
 * `toGraph`/`toGraphVersion`/`toClass` at the bottom are the boundary D20 puts
 * between the database and the wire, and the routes return their output and
 * never a row. Since t235 that boundary renames KEYS only — the stored values
 * are the wire's own words.
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import {
  classifyContracts,
  validateContracts,
  type ContractProblem,
  type ContractsState,
  type GraphDocument,
  type SkillLookup,
} from '../domain/graph.ts';
import { hashSnapshot, canonicalSerialize } from '../domain/hash.ts';
import { API_ACTOR, DEFAULT_PROJECT, now } from './common.ts';

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
  /**
   * Where this version stands with respect to its contracts (t283).
   *
   * Unaliased, unlike everything above it: the concept is new, so there is no
   * Portuguese name to alias the column back onto (t229, FR4).
   */
  contracts_state: ContractsState;
  /** The problems the check produced; `[]` when it found none, or ran clean. */
  contracts_report: ContractProblem[];
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
   source AS origem, proposal_id AS proposta_id, created_at AS criado_em,
   contracts_state, contracts_report`;

/** A version row as SQLite hands it over: the report is still TEXT. */
type RawVersionRow = Omit<GraphVersionRow, 'contracts_report'> & { contracts_report: string };

/**
 * The one parse between `graph_version` and the rest of the package (t283).
 *
 * Every read of a version goes through here instead of casting the raw row,
 * because `contracts_report` is a JSON column and a bare cast would hand a
 * string to a caller whose type says list — the same trap `getVersion` already
 * avoids for `snapshot`.
 *
 * @param raw Row as the driver returned it.
 * @returns The row with the report parsed.
 */
function mapVersionRow(raw: RawVersionRow): GraphVersionRow {
  return { ...raw, contracts_report: JSON.parse(raw.contracts_report) as ContractProblem[] };
}

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
  return (
    db
      .prepare(
        `SELECT ${VERSION_COLUMNS} FROM graph_version WHERE graph_id = ? ORDER BY created_at, id`,
      )
      .all(graphId) as RawVersionRow[]
  ).map(mapVersionRow);
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
    .get(id) as (RawVersionRow & { snapshot: string }) | undefined;
  if (row === undefined) return undefined;
  return { ...mapVersionRow(row), snapshot: JSON.parse(row.snapshot) as GraphDocument };
}

/**
 * The same version as `getVersion`, without loading the whole snapshot.
 *
 * @param db Open database.
 * @param id Version hash.
 * @returns The version metadata, or `undefined`.
 */
export function getVersionSummary(db: Database, id: string): GraphVersionRow | undefined {
  const row = db.prepare(`SELECT ${VERSION_COLUMNS} FROM graph_version WHERE id = ?`).get(id) as
    | RawVersionRow
    | undefined;
  return row === undefined ? undefined : mapVersionRow(row);
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
 * What a caller says about the contracts of the version it is writing (t283).
 *
 * Every version-birth site has to answer this, and the three answer it
 * differently on purpose: `POST /graphs` runs the check against the registry,
 * the fork COPIES its base's answer (the document is the same snapshot, so the
 * check would reach the same verdict), and applying a proposal runs it again
 * over the document the operations produced. A default here would have been the
 * fourth answer, and the wrong one: two of the three paths would mint versions
 * permanently `unchecked`, because the only re-check trigger is a manifest
 * arriving, and a class whose skills are already registered never fires it.
 */
export interface StoredContracts {
  /** Where the version stands; see {@link ContractsState}. */
  state: ContractsState;
  /** The problems behind that state; `[]` when there are none. */
  problems: ContractProblem[];
}

/**
 * Writes a new version. INSERT only: a version is never rewritten.
 *
 * @param db Open database (inside a transaction, when the caller opens one).
 * @param data Lineage, parent, already validated snapshot, origin and the
 *   contract-check outcome the caller reached (t283).
 */
export function insertVersion(
  db: Database,
  data: {
    id: string;
    grafo_id: string;
    versao_pai: string | null;
    snapshot: GraphDocument;
    origem: 'manual' | 'synthesizer' | 'proposal';
    proposta_id: number | null;
    criado_em: string;
    contracts: StoredContracts;
  },
): void {
  db.prepare(
    `INSERT INTO graph_version (id, graph_id, parent_version, snapshot, source, proposal_id,
                                created_at, contracts_state, contracts_report)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.grafo_id,
    data.versao_pai,
    canonicalSerialize(data.snapshot),
    data.origem,
    data.proposta_id,
    data.criado_em,
    data.contracts.state,
    JSON.stringify(data.contracts.problems),
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
 * The birth of a version that is ALSO the one that starts to hold (t196).
 *
 * Three paths write a version and move the pointer in a single transaction —
 * `registerBaseGraph` and `forkVariant`, which have no previous "current" to
 * preserve, and `applyProposal`, which does. The taxonomy's rule that
 * "registering does not move the pointer"
 * (`especificacoes/eventos/taxonomia.md`) is about the two facts being
 * DIFFERENT, not about them never happening together: whoever does both owes the
 * log both, in this order, which is the order the reference reducer folds them
 * in (`especificacoes/eventos/reducers/reconstruir-estado.mjs`).
 *
 * `project_id` is `DEFAULT_PROJECT` because a lineage is not project-scoped —
 * `migrations/0002_grafo_versao_proposta.sql` gives `graph` no such column — and
 * the actor is `API_ACTOR` because none of the routes that reach here accepts an
 * `actor` in the body: a token proves possession, not identity (`common.ts`), so
 * what gets recorded is the component that acted.
 */
export interface VersionBirth {
  /** Lineage the version belongs to. */
  graphId: string;
  /** Hash of the version just written, which is the subject of both events. */
  versionId: string;
  /** Hash it descends from; `null` on the first version of a lineage. */
  parentVersion: string | null;
  /** Who produced the snapshot, in the schema's own vocabulary. */
  source: 'manual' | 'synthesizer' | 'proposal';
  /** Proposal behind it, when there is one. */
  proposalId: number | null;
  /** Instant of the write — the same one the rows carry. */
  moment: string;
}

/**
 * Records `graph_version.registered` and then `graph_version.applied`.
 *
 * Called from inside the caller's transaction, always: projection and event land
 * together or not at all.
 *
 * @param db Open database, inside a transaction.
 * @param data The version that was written and started to hold.
 */
export function recordVersionBirth(db: Database, data: VersionBirth): void {
  recordEvent(db, {
    type: 'graph_version.registered',
    project_id: DEFAULT_PROJECT,
    execution_id: null,
    entity: { type: 'graph_version', id: data.versionId },
    actor: API_ACTOR,
    occurred_at: data.moment,
    data: {
      graph_id: data.graphId,
      parent_version: data.parentVersion,
      source: data.source,
      proposal_id: data.proposalId,
    },
  });

  recordEvent(db, {
    type: 'graph_version.applied',
    project_id: DEFAULT_PROJECT,
    execution_id: null,
    entity: { type: 'graph_version', id: data.versionId },
    actor: API_ACTOR,
    occurred_at: data.moment,
    data: { graph_id: data.graphId, proposal_id: data.proposalId },
  });
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
 * @param contracts What the contract check answered about it (t283). Required,
 *   with no default: see {@link StoredContracts} for why a default here would be
 *   an answer nobody computed.
 * @returns The lineage and the version as they were written.
 */
export function registerBaseGraph(
  db: Database,
  document: GraphDocument,
  contracts: StoredContracts,
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
      contracts,
    });

    movePointer(db, className, versionId);

    recordVersionBirth(db, {
      graphId: className,
      versionId,
      parentVersion: null,
      source: 'manual',
      proposalId: null,
      moment: createdAt,
    });
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
  /**
   * The base's own stored outcome, copied (t283).
   *
   * COPIED, never recomputed: `validateContracts` reads `nodes`, `edges`,
   * `custom_fields`, `project` and `initial_node`, and a fork touches none of
   * them — it swaps `lineage` and nothing else. Asking the registry again would
   * be a second answer to a question whose input did not change, and it would
   * make the fork fail to be honest exactly when the registry moved under it.
   */
  contracts: StoredContracts;
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
  const { base, id, originProposalId, document, versionId, contracts } = data;
  const createdAt = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO graph (id, class, lineage_type, base_class, origin_proposal_id, current_version_id, created_at)
       VALUES (?, ?, 'variant', ?, ?, NULL, ?)`,
    ).run(id, base.classe, base.classe, originProposalId, createdAt);

    // Same treatment `registerBaseGraph` gives a bootstrap version with no
    // proposal behind it: with an origin proposal the version comes from it, and
    // without one it is a manual write.
    const source = originProposalId === null ? 'manual' : 'proposal';

    insertVersion(db, {
      id: versionId,
      grafo_id: id,
      versao_pai: base.versao_corrente_id,
      snapshot: document,
      origem: source,
      proposta_id: originProposalId,
      criado_em: createdAt,
      contracts,
    });

    movePointer(db, id, versionId);

    // The parenthood recorded here crosses lineages on purpose: the variant's
    // first version descends from the BASE's current one, which is what makes
    // the fork a branch and not a copy.
    recordVersionBirth(db, {
      graphId: id,
      versionId,
      parentVersion: base.versao_corrente_id,
      source,
      proposalId: originProposalId,
      moment: createdAt,
    });
  })();

  const graph = getGraph(db, id);
  const version = getVersionSummary(db, versionId);
  if (graph === undefined || version === undefined) {
    throw new Error(`variant "${id}" was not written`);
  }

  return { graph, version };
}

/**
 * A version still waiting on a manifest, with the snapshot the re-check reads.
 *
 * Only `unchecked` rows are ever loaded: a `checked` version has nothing to
 * gain from a new manifest (its pins already resolved), and a `failed` one was
 * judged with every pin resolved, so a skill arriving does not change the
 * verdict it earned. Both would be re-verdicts of a question already answered.
 *
 * @param db Open database.
 * @returns Every unchecked version, oldest first.
 */
function unresolvedVersions(db: Database): { id: string; snapshot: GraphDocument }[] {
  return (
    db
      .prepare(
        `SELECT id, snapshot FROM graph_version
          WHERE contracts_state = 'unchecked' ORDER BY created_at, id`,
      )
      .all() as { id: string; snapshot: string }[]
  ).map((row) => ({ id: row.id, snapshot: JSON.parse(row.snapshot) as GraphDocument }));
}

/**
 * Does any node of this snapshot pin exactly this `(id, version)`?
 *
 * A scan in JS over the parsed snapshot, not a query: the pin lives inside a
 * JSON column, and folding JSON in JS instead of in SQL/JSON1 is what this
 * package already does elsewhere. The set it scans is small by construction —
 * only the unchecked versions — and the resolution key is `(id, version)`, the
 * same one `POST /graphs` resolves with. NOT the hash: what the registry
 * answers to is the pair, and a hash mismatch is a different refusal, owned by
 * the routes that move a pin.
 *
 * @param snapshot The version's document.
 * @param pin The manifest that was just registered.
 * @returns Whether this version was waiting on it.
 */
function pins(snapshot: GraphDocument, pin: { id: string; version: string }): boolean {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  return nodes.some((node) => {
    const ref = (node as { skill_ref?: { id?: unknown; version?: unknown } }).skill_ref;
    return ref?.id === pin.id && ref.version === pin.version;
  });
}

/**
 * Re-judges every unchecked version that was waiting on a manifest (t283, FR5).
 *
 * This is the one UPDATE of `graph_version` in the repository, and the header of
 * this file names it. Without it, design B would be half a promise: `POST
 * /graphs` stores a document whose pins are unresolved, `createJob` refuses to
 * run anything against it, and nothing would ever move it out of that state —
 * the class would be registered and permanently undispatchable.
 *
 * The re-check re-runs the WHOLE check against the registry as it stands now,
 * not just the pin that arrived: a version can wait on three manifests, and two
 * of them may have landed while this one was being written. Which is also why
 * the answer may be `failed` — resolving the last pin is what finally makes an
 * `unproduced_input` visible, and that finding is now backed by a registry that
 * answered for every node.
 *
 * Called from inside the caller's transaction, always
 * (`repositories/skill.ts`): the row, the re-checked versions and their events
 * land together or not at all.
 *
 * @param db Open database, inside a transaction.
 * @param pin The `(id, version)` that was just registered.
 * @param resolveSkill How a `skill_ref` becomes a contract, over the registry.
 * @param moment Instant of the registration — the events carry it too.
 */
export function recheckContracts(
  db: Database,
  pin: { id: string; version: string },
  resolveSkill: SkillLookup,
  moment: string,
): void {
  for (const version of unresolvedVersions(db)) {
    if (!pins(version.snapshot, pin)) continue;

    const report = validateContracts(version.snapshot, resolveSkill);
    const state = classifyContracts(report);

    db.prepare(
      'UPDATE graph_version SET contracts_state = ?, contracts_report = ? WHERE id = ?',
    ).run(state, JSON.stringify(report.problems), version.id);

    recordEvent(db, {
      type: 'graph_version.contracts_checked',
      project_id: DEFAULT_PROJECT,
      execution_id: null,
      entity: { type: 'graph_version', id: version.id },
      actor: API_ACTOR,
      occurred_at: moment,
      // The count and not the report: the problems are on the row, one GET
      // away, and re-embedding them here would put the same object in two
      // places with no way to keep them agreeing. The same call
      // `job.blocked.consecutive_failures` makes.
      data: { state, problem_count: report.problems.length },
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/*                                                                             */
/* D20 fixed the order: the wire went English BEFORE the database did, so for   */
/* three tickets there was an explicit translation here — `lineage_type` and    */
/* `graph_version.source` are both `CHECK`-constrained, which made their values */
/* schema rather than format. The fourth child (t229) renamed the columns and   */
/* the fifth (t235) rewrote the `CHECK`s to `('base','variant')` and            */
/* `('manual','synthesizer','proposal')`, and the two maps went with them.      */
/* What crosses this line now is the KEY and nothing else: everything above     */
/* still says `linhagem_tipo`, everything the routes hand to Fastify says       */
/* `lineage_type`, and the value is the same word on both sides.               */
/*                                                                             */
/* The document's own `lineage.type` is a different vocabulary and is NOT this  */
/* one: `schema/grafo.schema.json` says `variante`, because a format key and a  */
/* format value are outside D20 (D18's carve-out), and `routes/graphs.ts` keeps */
/* writing that word into the snapshot it forks.                               */
/* -------------------------------------------------------------------------- */

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
  /**
   * Where the version stands with respect to its contracts (t283).
   *
   * Deliberately NOT the `{valid, problems}` of the `422`'s own `contracts`
   * key: `valid` is the verdict of one call, `state` is a position in a
   * lifecycle, and reading one as the other is exactly the confusion this
   * ficha exists to end.
   */
  contracts: { state: ContractsState; problems: ContractProblem[] };
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
    lineage_type: row.linhagem_tipo,
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
    source: row.origem,
    proposal_id: row.proposta_id,
    created_at: row.criado_em,
    contracts: { state: row.contracts_state, problems: row.contracts_report },
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
