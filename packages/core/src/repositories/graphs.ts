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
 * The COLUMNS are English since D20's fourth child (t229), the stored values
 * since its fifth (t235), and since t289 so is everything above them. There used
 * to be a boundary at the bottom of this file — `toGraph`, `toGraphVersion`,
 * `toGraphVersionWithSnapshot`, `toClass` — with a Portuguese-spelled row
 * interface on one side of it and `/v1`'s own names on the other, and a `SELECT`
 * that aliased every column back onto the first so the second could rename it
 * forward again. All of it is gone: {@link Graph}, {@link GraphVersion} and
 * {@link ClassEntry} below are what the reads return AND what the routes publish,
 * and no query here carries an alias.
 *
 * Two things the deleted layer did were not renames, and they stayed. The
 * version read still NESTS `contracts_state`/`contracts_report` into
 * `contracts: {state, problems}` — a shape, not a spelling — and the class
 * catalogue still maps `graph.id` onto `graph_id`, because the catalogue's row IS
 * a lineage and its id is the lineage's, which is a real difference between the
 * column and the published field rather than a translation of one.
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

/**
 * Lineage of a graph: the class and the pointer to the version that holds today.
 *
 * The row AND the wire, in one shape (t226 FR1, t289): every field is the
 * column's own name, and `/v1` publishes exactly this object.
 *
 * `lineage_type` carries the schema's own word, `base` or `variant` — the
 * `CHECK` D20's fifth child (t235) rewrote. The DOCUMENT's `lineage.type` is a
 * different vocabulary and is NOT this one: `schema/graph.schema.json` says
 * `variante`, because a format key and a format value are outside D20 (D18's
 * carve-out), and `routes/graphs.ts` keeps writing that word into the snapshot
 * it forks.
 */
export interface Graph {
  id: string;
  class: string;
  lineage_type: string;
  base_class: string | null;
  origin_proposal_id: number | null;
  current_version_id: string | null;
  created_at: string;
}

/** A version, without the snapshot — the big body only comes out when asked for. */
export interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
  /**
   * Where this version stands with respect to its contracts (t283).
   *
   * Deliberately NOT the `{valid, problems}` of the `422`'s own `contracts`
   * key: `valid` is the verdict of one call, `state` is a position in a
   * lifecycle, and reading one as the other is exactly the confusion this
   * ficha exists to end.
   *
   * The one field of this interface that is not a column read straight off the
   * row: `graph_version` stores the two halves flat, as `contracts_state` and
   * `contracts_report`, and {@link mapVersionRow} is what nests them.
   */
  contracts: { state: ContractsState; problems: ContractProblem[] };
}

/** A version with the whole document, already parsed. */
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

const GRAPH_COLUMNS = `id, class, lineage_type, base_class, origin_proposal_id,
   current_version_id, created_at`;
const VERSION_COLUMNS = `id, graph_id, parent_version, source, proposal_id, created_at,
   contracts_state, contracts_report`;

/** A base lineage as the catalogue query hands it over: `id` is not yet `graph_id`. */
interface RawClassRow {
  class: string;
  id: string;
  current_version_id: string | null;
  created_at: string;
}

/** A version row as SQLite hands it over: the report is TEXT and nothing nests. */
interface RawVersionRow {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
  contracts_state: ContractsState;
  contracts_report: string;
}

/**
 * The one parse between `graph_version` and the rest of the package (t283).
 *
 * Every read of a version goes through here instead of casting the raw row,
 * because `contracts_report` is a JSON column and a bare cast would hand a
 * string to a caller whose type says list — the same trap `getVersion` already
 * avoids for `snapshot`.
 *
 * It also NESTS the two contract columns, which is the one piece of the deleted
 * `toGraphVersion` that was doing real work rather than renaming (t289). The two
 * flat keys are destructured OUT before the spread: a spread copies what the
 * driver returned, so leaving them in would publish `contracts_state` beside
 * `contracts` on every version the API serves.
 *
 * @param raw Row as the driver returned it.
 * @returns The version, contracts nested and the report parsed.
 */
function mapVersionRow(raw: RawVersionRow): GraphVersion {
  const { contracts_state, contracts_report, ...rest } = raw;
  return {
    ...rest,
    contracts: {
      state: contracts_state,
      problems: JSON.parse(contracts_report) as ContractProblem[],
    },
  };
}

/**
 * @param db Open database.
 * @param id Lineage id (= class, for a base graph).
 * @returns The lineage, or `undefined` if it does not exist.
 */
export function getGraph(db: Database, id: string): Graph | undefined {
  return db.prepare(`SELECT ${GRAPH_COLUMNS} FROM graph WHERE id = ?`).get(id) as
    | Graph
    | undefined;
}

/**
 * @param db Open database.
 * @returns Every lineage, in creation order.
 */
export function listGraphs(db: Database): Graph[] {
  return db
    .prepare(`SELECT ${GRAPH_COLUMNS} FROM graph ORDER BY created_at, id`)
    .all() as Graph[];
}

/**
 * Class catalogue (D8: the class is the identity named by the user).
 *
 * Only base lineages enter: a variant is a project fork (D13), not a new class.
 *
 * @param db Open database.
 * @returns One entry per registered class.
 */
export function listClasses(db: Database): ClassEntry[] {
  // The one mapping left in this file that is not a parse: the catalogue's
  // `graph_id` IS the lineage's `id`, and those are two different words for one
  // value rather than one word translated. Aliasing the column onto `graph_id`
  // in the query would hide that behind the same mechanism t289 exists to
  // delete.
  const rows = db
    .prepare(
      `SELECT class, id, current_version_id, created_at
         FROM graph
        WHERE lineage_type = 'base'
        ORDER BY class`,
    )
    .all() as RawClassRow[];

  return rows.map((row) => ({
    class: row.class,
    graph_id: row.id,
    current_version_id: row.current_version_id,
    created_at: row.created_at,
  }));
}

/**
 * The whole version chain of a graph, including the ones abandoned by a revert.
 *
 * @param db Open database.
 * @param graphId Lineage id.
 * @returns Versions in creation order.
 */
export function listVersions(db: Database, graphId: string): GraphVersion[] {
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
): GraphVersionWithSnapshot | undefined {
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
export function getVersionSummary(db: Database, id: string): GraphVersion | undefined {
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
export function getClassBase(db: Database, className: string): Graph | undefined {
  return db
    .prepare(`SELECT ${GRAPH_COLUMNS} FROM graph WHERE class = ? AND lineage_type = 'base'`)
    .get(className) as Graph | undefined;
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
    graph_id: string;
    parent_version: string | null;
    snapshot: GraphDocument;
    source: 'manual' | 'synthesizer' | 'proposal';
    proposal_id: number | null;
    created_at: string;
    contracts: StoredContracts;
  },
): void {
  db.prepare(
    `INSERT INTO graph_version (id, graph_id, parent_version, snapshot, source, proposal_id,
                                created_at, contracts_state, contracts_report)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.graph_id,
    data.parent_version,
    canonicalSerialize(data.snapshot),
    data.source,
    data.proposal_id,
    data.created_at,
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
 * (`specs/events/taxonomy.md`) is about the two facts being
 * DIFFERENT, not about them never happening together: whoever does both owes the
 * log both, in this order, which is the order the reference reducer folds them
 * in (`specs/events/reducers/reconstruct-state.mjs`).
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
 * (`specs/events/taxonomy.md`), but here it does: it is the lineage's
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
): { graph: Graph; version: GraphVersion } {
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
      graph_id: className,
      parent_version: null,
      snapshot: document,
      source: 'manual',
      proposal_id: null,
      created_at: createdAt,
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
  base: Graph;
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
 * snapshot, with no diff, and `parent_version` points at the version it was
 * forked from — a parenthood that crosses lineages, which the schema allows because
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
): { graph: Graph; version: GraphVersion } {
  const { base, id, originProposalId, document, versionId, contracts } = data;
  const createdAt = now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO graph (id, class, lineage_type, base_class, origin_proposal_id, current_version_id, created_at)
       VALUES (?, ?, 'variant', ?, ?, NULL, ?)`,
    ).run(id, base.class, base.class, originProposalId, createdAt);

    // Same treatment `registerBaseGraph` gives a bootstrap version with no
    // proposal behind it: with an origin proposal the version comes from it, and
    // without one it is a manual write.
    const source = originProposalId === null ? 'manual' : 'proposal';

    insertVersion(db, {
      id: versionId,
      graph_id: id,
      parent_version: base.current_version_id,
      snapshot: document,
      source,
      proposal_id: originProposalId,
      created_at: createdAt,
      contracts,
    });

    movePointer(db, id, versionId);

    // The parenthood recorded here crosses lineages on purpose: the variant's
    // first version descends from the BASE's current one, which is what makes
    // the fork a branch and not a copy.
    recordVersionBirth(db, {
      graphId: id,
      versionId,
      parentVersion: base.current_version_id,
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
