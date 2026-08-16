/**
 * Access to the `proposta` table (t101, FR7/FR8/FR9).
 *
 * A proposal is a HYPOTHESIS (`notas/2026-08-14-aprendizado.md`): target
 * artifact and version, semantic diff, the evidence that motivated it and the
 * metric it expects to move. The JSON columns (`operacoes`, `evidencia`,
 * `metrica_esperada`, `resultado`) go in and come out parsed by this module —
 * the caller never sees a string.
 *
 * The two state transitions that touch the whole database live here, each in ONE
 * transaction: applying (write the new version + move the pointer + mark the
 * proposal) and reverting (move the pointer back + mark the proposal). A half
 * application — a version written with the pointer standing still, or the other
 * way round — would leave the history lying, which is exactly what D15 buys with
 * append-only.
 *
 * Like `repositories/graphs.ts`, it receives the already-open database and never
 * touches the driver (D1). The row's field names mirror the untouched migration
 * columns, so they stay in Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import type { GraphDocument } from '../domain/graph.ts';
import type { Verdict } from '../domain/hypothesis.ts';
import type { Operation } from '../domain/operations.ts';
import { now } from './common.ts';
import {
  getVersionSummary,
  insertVersion,
  movePointer,
  type GraphVersionRow,
} from './graphs.ts';

/**
 * Possible states of a proposal.
 *
 * `aprovada` is the human gate of princípio 5, between the hypothesis and the
 * change (t165): the topographer writes `pendente`, a person approves, and only
 * then can it be applied. Rejecting is the other way out of `pendente`, and it
 * is terminal.
 */
export type ProposalStatus = 'pendente' | 'aprovada' | 'aplicada' | 'revertida' | 'rejeitada';

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
  /** Why a PERSON refused the hypothesis; the soundness gate writes `resultado` instead. */
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

const COLUMNS = `id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada, status,
                 versao_aplicada_id, motivo_reversao, motivo_rejeicao, resultado,
                 criado_em, atualizado_em`;

function hydrate(row: RawRow): ProposalRow {
  return {
    ...row,
    operacoes: JSON.parse(row.operacoes) as Operation[],
    evidencia: JSON.parse(row.evidencia),
    metrica_esperada: JSON.parse(row.metrica_esperada),
    resultado: row.resultado === null ? null : JSON.parse(row.resultado),
  };
}

/**
 * @param db Open database.
 * @param id Proposal id.
 * @returns The hydrated proposal, or `undefined`.
 */
export function getProposal(db: Database, id: number): ProposalRow | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM proposta WHERE id = ?`).get(id) as
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
      `INSERT INTO proposta (grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                             status, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)`,
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
 * and its story goes in `resultado`. The human refusal is
 * {@link rejectProposalByHuman}, whose story goes in `motivo_rejeicao` — two
 * columns because the two facts are different, and telling them apart later is
 * the whole point (t165).
 *
 * The guard is `aprovada` because that is the only status `apply` runs from
 * since t165: a proposal reaches this gate already past the human one.
 *
 * @param db Open database.
 * @param id Proposal.
 * @param report Validation report, written into `resultado`.
 * @returns The updated proposal.
 */
export function rejectProposal(db: Database, id: number, report: unknown): ProposalRow {
  db.prepare(
    `UPDATE proposta SET status = 'rejeitada', resultado = ?, atualizado_em = ?
      WHERE id = ? AND status = 'aprovada'`,
  ).run(JSON.stringify(report), now(), id);

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * The human gate says yes: `pendente` → `aprovada` (t165, FR2).
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
      `UPDATE proposta SET status = 'aprovada', atualizado_em = ?
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(now(), id);

  if (effect.changes !== 1) throw new Error(`proposal ${id} stopped being pending during approval`);

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * The human gate says no: `pendente` → `rejeitada`, with the reason (t165, FR3).
 *
 * `resultado` is deliberately untouched. That column carries either the report
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
      `UPDATE proposta SET status = 'rejeitada', motivo_rejeicao = ?, atualizado_em = ?
        WHERE id = ? AND status = 'pendente'`,
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
      origem: 'proposta',
      proposta_id: proposal.id,
      criado_em: moment,
    });

    movePointer(db, proposal.grafo_id, versionId);

    const effect = db
      .prepare(
        `UPDATE proposta SET status = 'aplicada', versao_aplicada_id = ?, atualizado_em = ?
          WHERE id = ? AND status = 'aprovada'`,
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
 * The abandoned version stays in `grafo_versao`, including in the history
 * listing — it is where the topographer will pull telemetry from later, crossing
 * it with the reason recorded here.
 *
 * @param db Open database.
 * @param data Applied proposal and the reason (required, D15 / event
 *   `grafo_versao.revertida`).
 * @returns The updated proposal.
 */
export function revertProposal(
  db: Database,
  data: { proposal: ProposalRow; reason: string },
): ProposalRow {
  const { proposal, reason } = data;
  const moment = now();

  db.transaction(() => {
    movePointer(db, proposal.grafo_id, proposal.versao_alvo);

    const effect = db
      .prepare(
        `UPDATE proposta SET status = 'revertida', motivo_reversao = ?, atualizado_em = ?
          WHERE id = ? AND status = 'aplicada'`,
      )
      .run(reason, moment, proposal.id);

    if (effect.changes !== 1) {
      throw new Error(`proposal ${proposal.id} stopped being applied during the reversion`);
    }
  })();

  const updated = getProposal(db, proposal.id);
  if (updated === undefined) throw new Error(`proposal ${proposal.id} is gone`);
  return updated;
}

/* -------------------------------------------------------------------------- */
/* t112 — hypothesis outcome. Identifiers in English (D18); the column and the  */
/* payload keys stay in Portuguese, mirroring what is already published (FR8).  */
/* -------------------------------------------------------------------------- */

/** What gets written into `proposta.resultado` when the experiment closes. */
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
 * `aplicada`, and reverting remains a human decision (README, princípio 5).
 * "Piorou" is data, not an action.
 *
 * The `UPDATE` is guarded by `resultado IS NULL AND status = 'aplicada'`, the
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
      `UPDATE proposta SET resultado = ?, atualizado_em = ?
        WHERE id = ? AND resultado IS NULL AND status = 'aplicada'`,
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
  /** Read out of `resultado.veredito`; a proposal with no outcome never matches. */
  veredito?: string;
}

/**
 * Lists proposals in id order, optionally filtered (t112, FR8).
 *
 * `status=aplicada&veredito=piorou` is the reversal-suggestion queue: the
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
    conditions.push("json_extract(resultado, '$.veredito') = ?");
    values.push(filter.veredito);
  }

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM proposta${where} ORDER BY id`)
    .all(...values) as RawRow[];
  return rows.map(hydrate);
}
