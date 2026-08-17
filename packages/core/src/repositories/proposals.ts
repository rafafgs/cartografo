/**
 * Access to the `proposal` table (t101, FR7/FR8/FR9).
 *
 * A proposal is a HYPOTHESIS (`notas/2026-08-14-aprendizado.md`): target
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
 * (t229) and the stored VALUES since its fifth (t235); {@link ProposalRow}'s
 * field names are not, because `routes/proposals.ts` and `cli/` read them, so
 * every `SELECT` aliases the renamed column back onto the field (t229, FR4;
 * t235, FR5).
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
  type GraphVersionRow,
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

/** A proposal, with the JSON columns already parsed. */
export interface ProposalRow {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: Operation[];
  evidencia: unknown;
  metrica_esperada: unknown;
  status: ProposalStatus;
  versao_aplicada_id: string | null;
  motivo_reversao: string | null;
  /** Why a PERSON refused the hypothesis; the soundness gate writes `result` instead. */
  motivo_rejeicao: string | null;
  resultado: unknown;
  criado_em: string;
  atualizado_em: string;
}

/** The same row as SQLite returns it: JSON in TEXT. */
interface RawRow {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: string;
  evidencia: string;
  metrica_esperada: string;
  status: ProposalStatus;
  versao_aplicada_id: string | null;
  motivo_reversao: string | null;
  motivo_rejeicao: string | null;
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

/** The row, read back into {@link ProposalRow}'s spelling (t229, FR4). */
const COLUMNS = `id, graph_id AS grafo_id, target_version AS versao_alvo,
                 operations AS operacoes, evidence AS evidencia,
                 expected_metric AS metrica_esperada, status,
                 applied_version_id AS versao_aplicada_id,
                 revert_reason AS motivo_reversao,
                 rejection_reason AS motivo_rejeicao, result AS resultado,
                 created_at AS criado_em, updated_at AS atualizado_em`;

function hydrate(row: RawRow): ProposalRow {
  return {
    ...row,
    operacoes: JSON.parse(row.operacoes) as Operation[],
    evidencia: JSON.parse(row.evidencia),
    metrica_esperada: JSON.parse(row.metrica_esperada),
    resultado: row.resultado === null ? null : JSON.parse(row.resultado),
  };
}

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/* -------------------------------------------------------------------------- */

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
 * A proposal, as `/v1` publishes it.
 *
 * `evidence`, `expected_metric` and `result` are `unknown` and stay that way:
 * the KEYS translate (`glossario-wire.md` §4.2), and what is inside them does
 * not move by one byte. Those blobs are `domain/hypothesis.ts`'s `ExpectedMetric`
 * and `Verdict` shapes — `{nome, direcao, de, para}`, `{veredito, antes, depois,
 * execucao_id, avaliado_em}` — which that file documents as a frozen data format
 * D18 left out of the English rule, which no row of the glossary maps, and which
 * D20 does not unfreeze either. Renaming them is a decision somebody has to take
 * on purpose; t226 deliberately does not take it (FR5).
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
  status: string;
  applied_version_id: string | null;
  revert_reason: string | null;
  rejection_reason: string | null;
  result: unknown;
  created_at: string;
  updated_at: string;
}

/** Row to wire: the one place the proposal's column names meet the API's. */
export function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    graph_id: row.grafo_id,
    target_version: row.versao_alvo,
    operations: row.operacoes,
    evidence: row.evidencia,
    expected_metric: row.metrica_esperada,
    status: row.status,
    applied_version_id: row.versao_aplicada_id,
    revert_reason: row.motivo_reversao,
    rejection_reason: row.motivo_rejeicao,
    result: row.resultado,
    created_at: row.criado_em,
    updated_at: row.atualizado_em,
  };
}

/**
 * @param db Open database.
 * @param id Proposal id.
 * @returns The hydrated proposal, or `undefined`.
 */
export function getProposal(db: Database, id: number): ProposalRow | undefined {
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
 *   to move.
 * @returns The proposal as it was written.
 */
export function createProposal(
  db: Database,
  data: {
    grafo_id: string;
    versao_alvo: string;
    operacoes: Operation[];
    evidencia: unknown;
    metrica_esperada: unknown;
  },
): ProposalRow {
  const createdAt = now();
  const result = db
    .prepare(
      `INSERT INTO proposal (graph_id, target_version, operations, evidence, expected_metric,
                             status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      data.grafo_id,
      data.versao_alvo,
      JSON.stringify(data.operacoes),
      JSON.stringify(data.evidencia),
      JSON.stringify(data.metrica_esperada),
      createdAt,
      createdAt,
    );

  const proposal = getProposal(db, Number(result.lastInsertRowid));
  if (proposal === undefined) throw new Error('the proposal was not written');
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
export function rejectProposal(db: Database, id: number, report: unknown): ProposalRow {
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
export function approveProposal(db: Database, id: number): ProposalRow {
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
export function rejectProposalByHuman(db: Database, id: number, reason: string): ProposalRow {
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
 * @param data Approved proposal, already validated document and its hash.
 * @returns The proposal and the new version, as they were written.
 */
export function applyProposal(
  db: Database,
  data: { proposal: ProposalRow; versionId: string; document: GraphDocument },
): { proposal: ProposalRow; version: GraphVersionRow } {
  const { proposal, versionId, document } = data;
  const moment = now();

  db.transaction(() => {
    insertVersion(db, {
      id: versionId,
      grafo_id: proposal.grafo_id,
      versao_pai: proposal.versao_alvo,
      snapshot: document,
      origem: 'proposal',
      proposta_id: proposal.id,
      criado_em: moment,
    });

    movePointer(db, proposal.grafo_id, versionId);

    // The same pair the two bootstrap paths record, this time with the proposal
    // that produced the snapshot: a version born of a hypothesis is exactly what
    // the surveyor will later cross with the telemetry of the round that ran it.
    recordVersionBirth(db, {
      graphId: proposal.grafo_id,
      versionId,
      parentVersion: proposal.versao_alvo,
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
  data: { proposal: ProposalRow; reason: string },
): ProposalRow {
  const { proposal, reason } = data;
  const moment = now();

  // The subject of `graph_version.reverted` is the ABANDONED version, and an
  // applied proposal always names it — `applyProposal` writes the column in the
  // same transaction that sets the status. Reading it before opening this one
  // means a row that somehow lost it fails without having moved a pointer.
  const abandoned = proposal.versao_aplicada_id;
  if (abandoned === null) {
    throw new Error(`proposal ${proposal.id} is applied without an applied version`);
  }

  db.transaction(() => {
    movePointer(db, proposal.grafo_id, proposal.versao_alvo);

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
        graph_id: proposal.grafo_id,
        target_version: proposal.versao_alvo,
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
  proposal: ProposalRow;
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
export function recordVerdict(db: Database, data: VerdictRecord): ProposalRow {
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
export function listProposals(db: Database, filter: ProposalFilter = {}): ProposalRow[] {
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
