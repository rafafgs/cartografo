/**
 * Intake repository — the breakdown of work into travellers (t122).
 *
 * D3 splits the meta-process in two acts: synthesizing topology produces NODES
 * (once per class) and breaking work down produces TICKETS (every execution).
 * This module is the second one, in two phases: a DRAFT that proposes the
 * breakdown over the class's already registered graph, and a CONFIRMATION that
 * is the human gate turning that proposal into `trabalho` rows.
 *
 * Three boundaries that are the whole point of the design:
 *
 * - **The draft emits no event.** Creating, amending and discarding a draft are
 *   work in progress, not facts of audit. The log only gains a line when a
 *   traveller really is born — which is why the projection here can be updated
 *   in place without breaking the replay: nothing in `intake_rascunho` is
 *   reconstructed from the log, because nothing about it was ever recorded.
 * - **Confirming never touches the graph.** It READS the class's current
 *   pointer, and no path from here reaches `registerBaseGraph`, `insertVersion`
 *   or `movePointer`. It is D3's "the path stays frozen" applied to the intake.
 * - **One transaction for the whole batch.** Every job, every dependency and
 *   every event land together or none does — the same discipline as `createJob`,
 *   nested here as a savepoint.
 *
 * The projection's field names, the table and column names and the event-type
 * strings mirror the untouched migration and the event taxonomy, so they stay in
 * Portuguese (t127, FR8). Only the code around them is English.
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import type { Actor } from '../db/event-validation.ts';
import type { DraftItem } from '../domain/intake.ts';
import { now, jsonOrNull } from './common.ts';
import { createJob, type Job } from './job.ts';

/** The three states of a draft, as the migration's CHECK spells them. */
export type DraftStatus = 'pendente' | 'confirmado' | 'descartado';

/**
 * Actor of a confirmation that arrives without one.
 *
 * The gate is human by design, and t124 authenticated the route — but a token
 * proves possession, not which person holds it. Rather than inventing a user,
 * the log honestly records the component that acted, and a caller that knows who
 * is on the other side sends `ator` in the body — the same convention as every
 * other write of this API.
 */
export const INTAKE_ACTOR: Actor = Object.freeze({ tipo: 'sistema', ref: 'intake' });

/** Draft projection, as the API returns it. */
export interface Draft {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  /** Class whose registered graph the breakdown runs over. */
  classe: string;
  /** The request in natural language, as it arrived. */
  pedido: string;
  itens: DraftItem[];
  status: DraftStatus;
  /** `ref` → real `trabalho.id`; only after the confirmation. */
  trabalhos_criados: Record<string, number> | null;
  criado_em: string;
  atualizado_em: string;
}

interface DraftRow extends Omit<Draft, 'itens' | 'trabalhos_criados'> {
  itens: string;
  trabalhos_criados: string | null;
}

const COLUMNS = `
  id, projeto_id, execucao_id, classe, pedido, itens, status,
  trabalhos_criados, criado_em, atualizado_em
`;

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/*                                                                             */
/* `Draft` above stays the INTERNAL projection, in the column's Portuguese: the */
/* routes compare `draft.status !== 'pendente'` and `confirmDraft` reads        */
/* `draft.classe`, and FR1 is explicit that internal logic keeps reading the    */
/* row's values. `WireDraft` is what leaves the process.                       */
/* -------------------------------------------------------------------------- */

/**
 * `intake_rascunho.status`, both ways (`glossario-wire.md` §1.6).
 *
 * `migrations/0006_intake.sql` holds the three in a `CHECK`, which makes them
 * schema and not format — the reasoning `skill.ts`'s `ROLE_COLUMN` wrote first.
 */
const STATUS_FIELD: Record<string, string> = {
  pendente: 'pending',
  confirmado: 'confirmed',
  descartado: 'discarded',
};

const STATUS_COLUMN: Record<string, DraftStatus> = {
  pending: 'pendente',
  confirmed: 'confirmado',
  discarded: 'descartado',
};

/** The three statuses a `?status=` filter may name, in the wire's spelling. */
export const DRAFT_STATUSES: readonly string[] = Object.freeze(Object.keys(STATUS_COLUMN));

/** The English `status` a request declared, as the column spells it. */
export function draftStatusColumn(value: string): DraftStatus | undefined {
  return STATUS_COLUMN[value];
}

/** A draft, as `/v1` publishes it. */
export interface WireDraft {
  id: number;
  project_id: number;
  execution_id: number | null;
  class: string;
  request: string;
  /**
   * The proposed breakdown, passed through byte for byte.
   *
   * The item's own keys (`ref`, `titulo`, `depende_de`, …) are `domain/intake.ts`'s
   * format, which no child of D20 renames; the glossary maps none of them.
   */
  items: DraftItem[];
  status: string;
  created_jobs: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

/** Draft to wire: the one place the column names meet the API's. */
export function toWireDraft(draft: Draft): WireDraft {
  return {
    id: draft.id,
    project_id: draft.projeto_id,
    execution_id: draft.execucao_id,
    class: draft.classe,
    request: draft.pedido,
    items: draft.itens,
    status: STATUS_FIELD[draft.status] ?? draft.status,
    created_jobs: draft.trabalhos_criados,
    created_at: draft.criado_em,
    updated_at: draft.atualizado_em,
  };
}

function toDraft(row: DraftRow): Draft {
  return {
    ...row,
    itens: JSON.parse(row.itens) as DraftItem[],
    trabalhos_criados: jsonOrNull<Record<string, number>>(row.trabalhos_criados),
  };
}

function readRow(db: Database, id: number): DraftRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM intake_rascunho WHERE id = ?`).get(id) as
    | DraftRow
    | undefined;
}

/**
 * Gets a draft by its projection.
 *
 * @param db Open handle.
 * @param id Draft id.
 * @returns The draft, or `null` if it does not exist.
 */
export function getDraft(db: Database, id: number): Draft | null {
  const row = readRow(db, id);
  return row === undefined ? null : toDraft(row);
}

/** What `createDraft` needs, already validated by the route. */
export interface CreateDraftData {
  projeto_id: number;
  execucao_id: number | null;
  classe: string;
  pedido: string;
  itens: DraftItem[];
}

/**
 * Opens a pending draft (FR1).
 *
 * No event and no transaction: one insert, and nothing else in the database
 * depends on it. A draft is a proposal — until somebody confirms it, no
 * traveller exists.
 *
 * @param db Open handle.
 * @param data Class, request and the already normalized items.
 * @returns The draft as it was written.
 */
export function createDraft(db: Database, data: CreateDraftData): Draft {
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO intake_rascunho (
         projeto_id, execucao_id, classe, pedido, itens, status,
         trabalhos_criados, criado_em, atualizado_em
       ) VALUES (?, ?, ?, ?, ?, 'pendente', NULL, ?, ?)`,
    )
    .run(
      data.projeto_id,
      data.execucao_id,
      data.classe,
      data.pedido,
      JSON.stringify(data.itens),
      timestamp,
      timestamp,
    );

  const draft = getDraft(db, Number(result.lastInsertRowid));
  if (draft === null) throw new Error('the draft was not written');
  return draft;
}

/** Slice of `GET /v1/intake`. */
export interface DraftFilter {
  status?: string;
  classe?: string;
  projeto_id?: number;
}

/**
 * The drafts that exist, in id order (FR6).
 *
 * @param db Open handle.
 * @param filter Optional slices; they add up as AND.
 * @returns Drafts from oldest to newest.
 */
export function listDrafts(db: Database, filter: DraftFilter = {}): Draft[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.status !== undefined) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.classe !== undefined) {
    conditions.push('classe = ?');
    values.push(filter.classe);
  }
  if (filter.projeto_id !== undefined) {
    conditions.push('projeto_id = ?');
    values.push(filter.projeto_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM intake_rascunho ${where} ORDER BY id`)
    .all(...values) as DraftRow[];
  return rows.map(toDraft);
}

/**
 * Replaces the items of a draft that is still pending (FR5).
 *
 * The list is REPLACED, never merged: an intake that merged would have no way of
 * removing an item somebody gave up on, and "send me the breakdown you want" is
 * a simpler contract than a patch language over a list.
 *
 * @param db Open handle.
 * @param id Draft id.
 * @param itens Already normalized items.
 * @returns The updated draft, or `null` when it stopped being pending.
 */
export function amendDraft(db: Database, id: number, itens: DraftItem[]): Draft | null {
  const effect = db
    .prepare(
      `UPDATE intake_rascunho SET itens = ?, atualizado_em = ?
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(JSON.stringify(itens), now(), id);

  return effect.changes === 1 ? getDraft(db, id) : null;
}

/**
 * Closes the draft without creating anything (FR7).
 *
 * @param db Open handle.
 * @param id Draft id.
 * @returns The discarded draft, or `null` when it stopped being pending.
 */
export function discardDraft(db: Database, id: number): Draft | null {
  const effect = db
    .prepare(
      `UPDATE intake_rascunho SET status = 'descartado', atualizado_em = ?
        WHERE id = ? AND status = 'pendente'`,
    )
    .run(now(), id);

  return effect.changes === 1 ? getDraft(db, id) : null;
}

/** What `confirmDraft` needs: the pending draft and the graph as it stands now. */
export interface ConfirmDraftData {
  draft: Draft;
  /** Entry node of the version in force — read by the route from the pointer. */
  no_inicial: string;
  /** Version in force, frozen into every job of the batch. */
  grafo_versao_id: string;
  /** Who confirmed; the human gate's caller when it identifies itself. */
  ator: Actor;
}

/** What a confirmation produces: the closed draft and every job it created. */
export interface Confirmation {
  rascunho: Draft;
  trabalhos: Job[];
}

/**
 * The human confirmation gate: one job per item, one row and one event per
 * declared dependency, all in a single transaction (FR9–FR12).
 *
 * The order inside the transaction is not decoration: every job is created
 * FIRST, because a dependency can only be recorded once both ends have real ids
 * — a `ref` is local to the batch and dies here.
 *
 * The dependency is registered and nothing else: the dependent job is NOT
 * blocked (FR14). Enforcing the order of execution is another ticket's problem,
 * and a block nobody knows how to lower would be worse than no block at all.
 *
 * @param db Open handle.
 * @param data Pending draft, entry node and version in force, and the actor.
 * @returns The confirmed draft and the jobs, in the order of the items.
 */
export function confirmDraft(db: Database, data: ConfirmDraftData): Confirmation {
  const { draft } = data;

  const confirm = db.transaction((): Confirmation => {
    const timestamp = now();
    const created: Record<string, number> = {};
    const jobs: Job[] = [];

    for (const item of draft.itens) {
      const job = createJob(db, {
        titulo: item.titulo,
        corpo: item.corpo,
        criterios_de_aceite: item.criterios_de_aceite,
        // The class's declared fields, filled in at intake (t168). They ride
        // straight through: `validateItems` already judged their shape, and
        // whether the class demands one is the transition gate's question, not
        // the confirmation's — a ticket may perfectly well be born on the entry
        // node with a field the node it later leaves will demand.
        campos: item.campos,
        // The triage the intake session did for free (t175). It rides through
        // the same way `campos` does: `validateItems` already closed the set of
        // values, and what the tier COSTS is the runner's question, one layer
        // out — nothing here translates it into a model.
        tier: item.tier,
        no_entrada_id: data.no_inicial,
        projeto_id: draft.projeto_id,
        execucao_id: draft.execucao_id,
        grafo_versao_id: data.grafo_versao_id,
        ator: data.ator,
      });
      created[item.ref] = job.id;
      jobs.push(job);
    }

    for (const item of draft.itens) {
      for (const dependency of item.depende_de) {
        const dependent = created[item.ref];
        const dependedOn = created[dependency];
        db.prepare(
          `INSERT INTO trabalho_dependencia (trabalho_id, depende_de_trabalho_id, criado_em)
           VALUES (?, ?, ?)`,
        ).run(dependent, dependedOn, timestamp);

        // The subject of the event is the DEPENDENT job: "this one waits for
        // that one" is a fact about whoever waits, and it is in that job's
        // timeline that somebody will look for the reason it has not moved.
        recordEvent(db, {
          tipo: 'trabalho.dependencia_declarada',
          projeto_id: draft.projeto_id,
          execucao_id: draft.execucao_id,
          entidade: { tipo: 'trabalho', id: dependent },
          ator: data.ator,
          ocorrido_em: timestamp,
          dados: { depende_de_trabalho_id: dependedOn },
        });
      }
    }

    const effect = db
      .prepare(
        `UPDATE intake_rascunho SET status = 'confirmado', trabalhos_criados = ?, atualizado_em = ?
          WHERE id = ? AND status = 'pendente'`,
      )
      .run(JSON.stringify(created), timestamp, draft.id);

    // The whole transaction falls if the draft stopped being pending between the
    // route's check and this UPDATE: confirming twice is a 409, never two
    // batches of jobs (FR12/AT14).
    if (effect.changes !== 1) {
      throw new Error(`draft ${draft.id} stopped being pending during the confirmation`);
    }

    return { rascunho: toDraft(readRow(db, draft.id) as DraftRow), trabalhos: jobs };
  });

  return confirm();
}
