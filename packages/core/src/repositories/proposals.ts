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
import type { Operation } from '../domain/operations.ts';
import {
  now,
  getVersionSummary,
  insertVersion,
  movePointer,
  type GraphVersionRow,
} from './graphs.ts';

/** Possible states of a proposal. A human `aprovada` belongs to the inbox (t111). */
export type ProposalStatus = 'pendente' | 'aplicada' | 'revertida' | 'rejeitada';

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
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

const COLUMNS = `id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada, status,
                 versao_aplicada_id, motivo_reversao, resultado, criado_em, atualizado_em`;

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
 * The only path to `rejeitada` in this ticket is the soundness gate — explicit
 * human rejection belongs to the inbox (t111).
 *
 * @param db Open database.
 * @param id Proposal.
 * @param report Validation report, written into `resultado`.
 * @returns The updated proposal.
 */
export function rejectProposal(db: Database, id: number, report: unknown): ProposalRow {
  db.prepare(
    `UPDATE proposta SET status = 'rejeitada', resultado = ?, atualizado_em = ?
      WHERE id = ? AND status = 'pendente'`,
  ).run(JSON.stringify(report), now(), id);

  const proposal = getProposal(db, id);
  if (proposal === undefined) throw new Error(`proposal ${id} is gone`);
  return proposal;
}

/**
 * Applies the proposal: new version + pointer + status, in one transaction (D15).
 *
 * @param db Open database.
 * @param data Pending proposal, already validated document and its hash.
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
          WHERE id = ? AND status = 'pendente'`,
      )
      .run(versionId, moment, proposal.id);

    // The whole transaction falls if the proposal stopped being pending between
    // the route's check and this UPDATE: applying twice is a 409, never two
    // versions (FR8/AT19).
    if (effect.changes !== 1) {
      throw new Error(`proposal ${proposal.id} stopped being pending during the application`);
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
