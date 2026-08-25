/**
 * Access to the `proposal` table (t101, FR7/FR8/FR9).
 *
 * A proposal is a HYPOTHESIS (`notes/2026-08-14-learning.md`): target
 * artifact and version, semantic diff, the evidence that motivated it and the
 * metric it expects to move. The JSON columns (`operations`, `evidence`,
 * `expected_metric`, `result`) go in and come out parsed by this module —
 * the caller never sees a string.
 *
 * The two state transitions that touch the whole database live here, each in ONE
 * transaction: applying (write the new version + move the pointer + mark the
 * proposal) and reverting (move the pointer back + mark the proposal). A half
 * application — a version written with the pointer standing still, or the other
 * way round — would leave the history lying, which is exactly what D15 buys with
 * append-only.
 *
 * Since t196 the LOG is part of each of those transactions: applying records
 * `graph_version.registered` + `graph_version.applied` through
 * `graphs.ts`'s `recordVersionBirth`, and reverting records one
 * `graph_version.reverted`. Same rule as the rows — projection and event land
 * together or not at all.
 *
 * Like `repositories/graphs.ts`, it receives the already-open database and never
 * touches the driver (D1). The COLUMNS are English since D20's fourth child
 * (t229), the stored VALUES since its fifth (t235), and since t289 so is
 * {@link Proposal}: the reads return the object `/v1` publishes, where there used
 * to be a Portuguese-spelled `ProposalRow`, eleven aliases putting the columns
 * back onto it, and a `toProposal` renaming them forward again.
 *
 * What crosses this file untranslated, and stays that way, is the hypothesis
 * vocabulary — {@link HypothesisOutcome}, {@link ProposalFilter.veredito} and the
 * `veredito`/`antes`/`depois`/`execucao_id` keys inside `result`. That is
 * `domain/hypothesis.ts`'s frozen data format, which D18 carved out of the
 * English rule and D20 does not unfreeze; it looks exactly like the fields
 * renamed around it and it is not one of them.
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import type { GraphDocument } from '../domain/graph.ts';
import type { Verdict } from '../domain/hypothesis.ts';
import type { Operation } from '../domain/operations.ts';
import { API_ACTOR, DEFAULT_PROJECT, now } from './common.ts';
import {
  getVersionSummary,
  insertVersion,
  movePointer,
  recordVersionBirth,
  type GraphVersion,
  type StoredContracts,
} from './graphs.ts';

/**
 * Possible states of a proposal.
 *
 * `approved` is the human gate of princípio 5, between the hypothesis and the
 * change (t165): the topographer writes `pending`, a person approves, and only
 * then can it be applied. Rejecting is the other way out of `pending`, and it
 * is terminal.
 */
export type ProposalStatus = 'pending' | 'approved' | 'applied' | 'reverted' | 'rejected';

/**
 * A proposal, as `/v1` publishes it — and as the reads below return it.
 *
 * Every field is the column's own name (t289): there is no second spelling
 * between this and `proposal`, and {@link hydrate} is the whole of the distance
 * between the row and this object — four `JSON.parse`s and one column dropped.
 *
 * `evidence`, `expected_metric` and `result` are `unknown` and stay that way:
 * what is inside them does not move by one byte. Those blobs are
 * `domain/hypothesis.ts`'s `ExpectedMetric` and `Verdict` shapes — `{nome,
 * direcao, de, para}`, `{veredito, antes, depois, execucao_id, avaliado_em}` —
 * which that file documents as a frozen data format D18 left out of the English
 * rule, which no row of the glossary maps, and which D20 does not unfreeze
 * either. Renaming them is a decision somebody has to take on purpose; t226
 * deliberately did not take it, and neither does t289.
 *
 * `operations` is the same story for a different reason: the operation
 * vocabulary is D20's THIRD child, and it travels through here untouched.
 */
export interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  operations: Operation[];
  evidence: unknown;
  expected_metric: unknown;
  status: ProposalStatus;
  applied_version_id: string | null;
  revert_reason: string | null;
  /** Why a PERSON refused the hypothesis; the soundness gate writes `result` instead. */
  rejection_reason: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
}

/** The row as SQLite returns it: the column names, with the JSON still in TEXT. */
interface RawRow {
  id: number;
  graph_id: string;
  target_version: string;
  operations: string;
  evidence: string;
  expected_metric: string;
  status: ProposalStatus;
  applied_version_id: string | null;
  revert_reason: string | null;
  rejection_reason: string | null;
  result: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Every column of a proposal that anybody reads, each under its own name (t289).
 *
 * `dedupe_key` is deliberately NOT here. It is internal bookkeeping, born
 * English with `migrations/0021_proposta_dedupe_key.sql`, and no caller has ever
 * read its value — `findPendingProposalByDedupeKey` matches on it in a `WHERE`
 * and nothing else. Selecting it would put it on {@link RawRow}, and one spread
 * later the server's own key would be riding out to `/v1` on every proposal
 * (`test/proposal-routes.test.ts` pins that it does not).
 */
const COLUMNS = `id, graph_id, target_version, operations, evidence, expected_metric,
                 status, applied_version_id, revert_reason, rejection_reason, result,
                 created_at, updated_at`;

/**
 * The four JSON columns, parsed; every other field passes through by name.
 *
 * @param row Row as the driver returned it.
 * @returns The proposal, as the API publishes it.
 */
function hydrate(row: RawRow): Proposal {
  return {
    ...row,
    operations: JSON.parse(row.operations) as Operation[],
    evidence: JSON.parse(row.evidence),
    expected_metric: JSON.parse(row.expected_metric),
    result: row.result === null ? null : JSON.parse(row.result),
  };
}

/**
 * The five statuses a `?status=` filter may name (`glossario-wire.md` §1.6).
 *
 * `migrations/0010_proposta_aprovada.sql` holds them in a `CHECK`, and since
 * D20's fifth child (t235) that `CHECK` spells them in English — so there is
 * nothing to translate here and never was anything else: the wire and the column
 * are the same five words. The list survives the map because a `?status=` a
 * caller invented still has to be refused.
 */
export const PROPOSAL_STATUSES: readonly ProposalStatus[] = Object.freeze([
  'pending',
  'approved',
  'applied',
  'reverted',
  'rejected',
]);

/**
 * The `status` a request declared, if the column can hold it.
 *
 * @param value What the query string said.
 * @returns The same word, or `undefined` when the column has no such state.
 */
export function proposalStatusColumn(value: string): ProposalStatus | undefined {
  return PROPOSAL_STATUSES.find((status) => status === value);
}

/**
 * @param db Open database.
 * @param id Proposal id.
 * @returns The hydrated proposal, or `undefined`.
 */
export function getProposal(db: Database, id: number): Proposal | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM proposal WHERE id = ?`).get(id) as
    | RawRow
    | undefined;
  return row === undefined ? undefined : hydrate(row);
}

/**
 * Creates a pending proposal.
 *
 * @param db Open database.
 * @param data Target (graph and version), operations already validated in shape,
 *   and the hypothesis: the evidence that motivated it and the metric it expects
 *   to move. `dedupeKey` is optional: `POST /proposals` computes and passes one
 *   (t246), and the lineage diff of `routes/graphs.ts` does not — a proposal
 *   nobody keyed reads `null`, which is what the partial unique index of
 *   `migrations/0021_proposta_dedupe_key.sql` treats as always distinct.
 * @returns The proposal as it was written.
 */
export function createProposal(
  db: Database,
  data: {
    graph_id: string;
    target_version: string;
    operations: Operation[];
    evidence: unknown;
    expected_metric: unknown;
    dedupeKey?: string | null;
  },
): Proposal {
  const createdAt = now();
  const result = db
    .prepare(
      `INSERT INTO proposal (graph_id, target_version, operations, evidence, expected_metric,
                             status, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      data.graph_id,
      data.target_version,
      JSON.stringify(data.operations),
      JSON.stringify(data.evidence),
      JSON.stringify(data.expected_metric),
      data.dedupeKey ?? null,
      createdAt,
      createdAt,
    );

  const proposal = getProposal(db, Number(result.lastInsertRowid));
  if (proposal === undefined) throw new Error('the proposal was not written');
  return proposal;
}

/* -------------------------------------------------------------------------- */
/* t246 — D21: repeated signal strengthens the pending proposal.               */
/* -------------------------------------------------------------------------- */

/**
 * The PENDING proposal carrying this deduplication key, if there is one.
 *
 * `pending` is in the `WHERE` and not merely likely to be true: uniqueness is
 * scoped to that state on purpose (`migrations/0021_proposta_dedupe_key.sql`), so
 * a key shared with a proposal somebody already rejected, applied or reverted has
 * to read as "no match" here — reposting the same signal after a decision opens a
 * new hypothesis instead of reopening a closed one.
 *
 * `dedupe_key IS NULL` can never reach this: `routes/proposals.ts` always has a
 * key to look up, and the `null` bucket is a real key over a `null` lens, not an
 * absent column. Matching NULL here would be matching every unkeyed row at once.
 *
 * @param db Open database.
 * @param dedupeKey The key `proposalDedupeKey` computed for the incoming signal.
 * @returns The hydrated proposal, or `undefined` when nothing pending matches.
 */
export function findPendingProposalByDedupeKey(
  db: Database,
  dedupeKey: string,
): Proposal | undefined {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM proposal WHERE dedupe_key = ? AND status = 'pending'`)
    .get(dedupeKey) as RawRow | undefined;
  return row === undefined ? undefined : hydrate(row);
}

/**
 * Adds one more occurrence to a pending proposal's evidence (t246, FR4).
 *
 * The accumulation is a LIST, and it starts being one only from the second
 * occurrence on: the first repeat wraps whatever was there into a one-element list
 * and appends to it. That asymmetry is the whole reason every reader of
 * `proposal.evidence.<field>` across `core`, `runner` and `cost-surveyor` keeps
 * working unchanged — a proposal nobody repeated is byte-for-byte the object that
 * was posted.
 *
 * Nothing else about the proposal moves. `expected_metric` stays the original
 * hypothesis, not recomputed and not merged: the second signal is more evidence
 * for the same claim, not a new claim (D21, and the ticket's own out of scope).
 *
 * The read and the write are one transaction because they are one fact: two
 * repeats arriving together must not each read the same list and each write it
 * back with one element added.
 *
 * @param db Open database.
 * @param id The pending proposal the route already found by key.
 * @param evidence The new occurrence, exactly as it came off the wire.
 * @returns The updated proposal.
 * @throws {Error} When the row stopped being pending mid-flight — the same guard
 *   {@link approveProposal} uses, for the same reason: strengthening a proposal
 *   somebody just decided on would be writing over their decision.
 */
export function appendProposalEvidence(db: Database, id: number, evidence: unknown): Proposal {
  db.transaction(() => {
    const current = db
      .prepare(`SELECT evidence FROM proposal WHERE id = ? AND status = 'pending'`)
      .get(id) as { evidence: string } | undefined;
    if (current === undefined) {
      throw new Error(`proposal ${id} stopped being pending during the reinforcement`);
    }

    const stored: unknown = JSON.parse(current.evidence);
    const accumulated = Array.isArray(stored) ? [...stored, evidence] : [stored, evidence];

    const effect = db
      .prepare(
        `UPDATE proposal SET evidence = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(accumulated), now(), id);

    if (effect.changes !== 1) {
      throw new Error(`proposal ${id} stopped being pending during the reinforcement`);
    }
  })();

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * Marks the proposal as rejected and keeps the report that failed it.
 *
 * This is the SOUNDNESS GATE's rejection, the one that happens inside `apply`,
 * and its story goes in `result`. The human refusal is
 * {@link rejectProposalByHuman}, whose story goes in `rejection_reason` — two
 * columns because the two facts are different, and telling them apart later is
 * the whole point (t165).
 *
 * The guard is `approved` because that is the only status `apply` runs from
 * since t165: a proposal reaches this gate already past the human one.
 *
 * @param db Open database.
 * @param id Proposal.
 * @param report Validation report, written into `result`.
 * @returns The updated proposal.
 */
export function rejectProposal(db: Database, id: number, report: unknown): Proposal {
  db.prepare(
    `UPDATE proposal SET status = 'rejected', result = ?, updated_at = ?
      WHERE id = ? AND status = 'approved'`,
  ).run(JSON.stringify(report), now(), id);

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * The human gate says yes: `pending` → `approved` (t165, FR2).
 *
 * Approving writes nothing but the status. It is a decision recorded, not the
 * change itself — applying is a second, deliberate act, and princípio 5's
 * ladder is exactly that separation.
 *
 * @param db Open database.
 * @param id Proposal, already checked to be pending by the route.
 * @returns The updated proposal.
 * @throws {Error} When the row stopped being pending mid-flight — two people
 *   deciding at once is a 409, never a silent overwrite.
 */
export function approveProposal(db: Database, id: number): Proposal {
  const effect = db
    .prepare(
      `UPDATE proposal SET status = 'approved', updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(now(), id);

  if (effect.changes !== 1) throw new Error(`proposal ${id} stopped being pending during approval`);

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * The human gate says no: `pending` → `rejected`, with the reason (t165, FR3).
 *
 * `result` is deliberately untouched. That column carries either the report
 * of the soundness gate that failed a proposal or the verdict of a hypothesis
 * that was applied; a human "not worth it" is a third fact, and giving it its
 * own column is what keeps the three readable apart afterwards.
 *
 * @param db Open database.
 * @param id Proposal, already checked to be pending by the route.
 * @param reason Why, required and non-blank — a rejection with no reason loses
 *   the half of the fact the topographer would learn from.
 * @returns The updated proposal.
 * @throws {Error} When the row stopped being pending mid-flight.
 */
export function rejectProposalByHuman(db: Database, id: number, reason: string): Proposal {
  const effect = db
    .prepare(
      `UPDATE proposal SET status = 'rejected', rejection_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(reason, now(), id);

  if (effect.changes !== 1) throw new Error(`proposal ${id} stopped being pending during rejection`);

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * Applies the proposal: new version + pointer + status, in one transaction (D15).
 *
 * @param db Open database.
 * @param data Approved proposal, already validated document, its hash and what
 *   the contract check answered about the document the operations produced
 *   (t283) — recomputed by the route, because a proposal is a change and the
 *   target's stored answer is about a different document.
 * @returns The proposal and the new version, as they were written.
 */
export function applyProposal(
  db: Database,
  data: {
    proposal: Proposal;
    versionId: string;
    document: GraphDocument;
    contracts: StoredContracts;
  },
): { proposal: Proposal; version: GraphVersion } {
  const { proposal, versionId, document, contracts } = data;
  const moment = now();

  db.transaction(() => {
    insertVersion(db, {
      id: versionId,
      graph_id: proposal.graph_id,
      parent_version: proposal.target_version,
      snapshot: document,
      source: 'proposal',
      proposal_id: proposal.id,
      created_at: moment,
      contracts,
    });

    movePointer(db, proposal.graph_id, versionId);

    // The same pair the two bootstrap paths record, this time with the proposal
    // that produced the snapshot: a version born of a hypothesis is exactly what
    // the surveyor will later cross with the telemetry of the round that ran it.
    recordVersionBirth(db, {
      graphId: proposal.graph_id,
      versionId,
      parentVersion: proposal.target_version,
      source: 'proposal',
      proposalId: proposal.id,
      moment,
    });

    const effect = db
      .prepare(
        `UPDATE proposal SET status = 'applied', applied_version_id = ?, updated_at = ?
          WHERE id = ? AND status = 'approved'`,
      )
      .run(versionId, moment, proposal.id);

    // The whole transaction falls if the proposal stopped being approved between
    // the route's check and this UPDATE: applying twice is a 409, never two
    // versions (FR8/AT19).
    if (effect.changes !== 1) {
      throw new Error(`proposal ${proposal.id} stopped being approved during the application`);
    }
  })();

  const updated = getProposal(db, proposal.id);
  if (updated === undefined) throw new Error(`proposal ${proposal.id} is gone`);

  const version = getVersionSummary(db, versionId);
  if (version === undefined) throw new Error(`version ${versionId} was not written`);

  return { proposal: updated, version };
}

/**
 * Reverts the proposal: the pointer goes back to the target version and nothing is erased.
 *
 * The abandoned version stays in `graph_version`, including in the history
 * listing — it is where the topographer will pull telemetry from later, crossing
 * it with the reason recorded here.
 *
 * @param db Open database.
 * @param data Applied proposal and the reason (required, D15 / event
 *   `graph_version.reverted`).
 * @returns The updated proposal.
 */
export function revertProposal(
  db: Database,
  data: { proposal: Proposal; reason: string },
): Proposal {
  const { proposal, reason } = data;
  const moment = now();

  // The subject of `graph_version.reverted` is the ABANDONED version, and an
  // applied proposal always names it — `applyProposal` writes the column in the
  // same transaction that sets the status. Reading it before opening this one
  // means a row that somehow lost it fails without having moved a pointer.
  const abandoned = proposal.applied_version_id;
  if (abandoned === null) {
    throw new Error(`proposal ${proposal.id} is applied without an applied version`);
  }

  db.transaction(() => {
    movePointer(db, proposal.graph_id, proposal.target_version);

    const effect = db
      .prepare(
        `UPDATE proposal SET status = 'reverted', revert_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'applied'`,
      )
      .run(reason, moment, proposal.id);

    if (effect.changes !== 1) {
      throw new Error(`proposal ${proposal.id} stopped being applied during the reversion`);
    }

    // ONE event, and no `registered`/`applied`: reverting writes no version, it
    // moves a pointer back over history that stays intact (D15).
    recordEvent(db, {
      type: 'graph_version.reverted',
      project_id: DEFAULT_PROJECT,
      execution_id: null,
      entity: { type: 'graph_version', id: abandoned },
      actor: API_ACTOR,
      occurred_at: moment,
      data: {
        graph_id: proposal.graph_id,
        target_version: proposal.target_version,
        reason,
      },
    });
  })();

  const updated = getProposal(db, proposal.id);
  if (updated === undefined) throw new Error(`proposal ${proposal.id} is gone`);
  return updated;
}

/* -------------------------------------------------------------------------- */
/* t112 — hypothesis outcome. Identifiers in English (D18); the column and the  */
/* payload keys stay in Portuguese, mirroring what is already published (FR8).  */
/* -------------------------------------------------------------------------- */

/** What gets written into `proposal.result` when the experiment closes. */
export interface HypothesisOutcome {
  veredito: Verdict;
  /** The `de` the proposal declared — the baseline the verdict compared against. */
  antes: number;
  depois: number;
  execucao_id: number;
  avaliado_em: string;
}

/** Arguments of `recordVerdict`, already judged and checked against telemetry. */
export interface VerdictRecord {
  proposal: Proposal;
  executionId: number;
  after: number;
  verdict: Verdict;
  before: number;
}

/**
 * Writes the outcome of the hypothesis, once (t112, FR5/FR6).
 *
 * The status does NOT change: a proposal that made things worse stays
 * `applied`, and reverting remains a human decision (README, princípio 5).
 * "Piorou" is data, not an action.
 *
 * The `UPDATE` is guarded by `result IS NULL AND status = 'applied'`, the
 * same concurrency pattern `applyProposal`/`revertProposal` use: two callers
 * closing the same experiment at once is a `409`, never a verdict silently
 * overwritten by whoever arrived last.
 *
 * @param db Open handle.
 * @param data Proposal, execution that produced the evidence, measured value and
 *   the verdict already computed by `computeVerdict`.
 * @returns The proposal as it was written.
 * @throws {Error} When the row stopped matching the guard mid-flight.
 */
export function recordVerdict(db: Database, data: VerdictRecord): Proposal {
  const { proposal } = data;
  const outcome: HypothesisOutcome = {
    veredito: data.verdict,
    antes: data.before,
    depois: data.after,
    execucao_id: data.executionId,
    avaliado_em: now(),
  };

  const effect = db
    .prepare(
      `UPDATE proposal SET result = ?, updated_at = ?
        WHERE id = ? AND result IS NULL AND status = 'applied'`,
    )
    .run(JSON.stringify(outcome), outcome.avaliado_em, proposal.id);

  if (effect.changes !== 1) {
    throw new Error(`proposal ${proposal.id} stopped being evaluable during the write`);
  }

  const updated = getProposal(db, proposal.id);
  if (updated === undefined) throw new Error(`proposal ${proposal.id} is gone`);
  return updated;
}

/** Optional cuts of the proposal listing (t112, FR8). */
export interface ProposalFilter {
  status?: string;
  /** Read out of `result.veredito`; a proposal with no outcome never matches. */
  veredito?: string;
}

/**
 * Lists proposals in id order, optionally filtered (t112, FR8).
 *
 * `status=applied&veredito=piorou` is the reversal-suggestion queue: the
 * hypotheses that made things worse and are still in force. It is a filtered
 * read and nothing else — no notification surface is implied by it.
 *
 * @param db Open handle.
 * @param filter Optional cuts; absent keys mean "no filter".
 * @returns Proposals with the JSON columns already parsed, in id order.
 */
export function listProposals(db: Database, filter: ProposalFilter = {}): Proposal[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.status !== undefined) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.veredito !== undefined) {
    conditions.push("json_extract(result, '$.veredito') = ?");
    values.push(filter.veredito);
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM proposal${where} ORDER BY id`)
    .all(...values) as RawRow[];
  return rows.map(hydrate);
}
