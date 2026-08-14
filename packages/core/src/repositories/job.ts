/**
 * Job repository — the "traveller" that walks the graph.
 *
 * Every write here records the projection AND the corresponding event in the
 * SAME SQLite transaction (FR18). It is not excessive zeal: the projection is
 * derived from the log, and a state that exists without the fact that produced it
 * is a state the replay does not reproduce — exactly what
 * `test/replay-consistency.test.ts` demands.
 *
 * The functions return `null` when the job does not exist; translating that into
 * a 404 is the route's job.
 *
 * The projection's field names, the table and column names and the event-type
 * strings mirror the untouched migration and the event taxonomy, so they stay in
 * Portuguese (t127, FR8). Only the code around them is English.
 */

import type { Database } from '../db/connection.ts';
import { listEvents, recordEvent } from '../db/events.ts';
import { requireValidData, type Actor, type Event } from '../db/event-validation.ts';
import {
  API_ACTOR,
  DEFAULT_PROJECT,
  now,
  asBoolean,
  asInteger,
  integerOrNull,
  integerOrDefault,
  resolveActor,
  textOrNull,
} from './common.ts';

/** Job projection, as the API returns it. */
export interface Job {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  /** Graph version the job runs under. Loose: `grafo_versao` belongs to t101 (D15). */
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
}

/** One row of the version × telemetry grouping (FR17). */
export interface MetricByVersion {
  grafo_versao_id: string | null;
  trabalhos: number;
  eventos: number;
}

/** One row of `GET /v1/executions` — the summary of a round (t107, FR1). */
export interface ExecutionSummary {
  execucao_id: number | null;
  trabalhos: number;
  trabalhos_bloqueados: number;
  perguntas_pendentes: number;
}

interface JobRow {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: number;
  motivo_bloqueio: string | null;
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
}

const COLUMNS = `
  id, projeto_id, execucao_id, titulo, no_entrada_id, no_atual,
  bloqueado, motivo_bloqueio, grafo_versao_id, criado_em, atualizado_em
`;

/**
 * Predicate for "this event talks about this job", in SQL.
 *
 * It is the same rule as the timeline (FR9), here as a subquery so it can count
 * without materializing. Pure read: whoever WRITES to `evento` is still only
 * `src/db/events.ts`.
 */
const JOB_EVENTS = `
  SELECT COUNT(*) FROM evento e
   WHERE (e.entidade_tipo = 'trabalho' AND e.entidade_id = CAST(t.id AS TEXT))
      OR (e.entidade_tipo IN ('sessao','pergunta')
          AND json_extract(e.dados, '$.trabalho_id') = t.id)
`;

function toJob(row: JobRow): Job {
  return { ...row, bloqueado: asBoolean(row.bloqueado) };
}

function readRow(db: Database, id: number): JobRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM trabalho WHERE id = ?`).get(id) as
    | JobRow
    | undefined;
}

/**
 * Gets a job by its projection.
 *
 * @param db Open handle.
 * @param id Job id.
 * @returns The job, or `null` if it does not exist.
 */
export function getJob(db: Database, id: number): Job | null {
  const row = readRow(db, id);
  return row === undefined ? null : toJob(row);
}

/** Body of `POST /v1/jobs`. */
export interface CreateJobInput {
  titulo?: unknown;
  no_entrada_id?: unknown;
  execucao_id?: unknown;
  projeto_id?: unknown;
  grafo_versao_id?: unknown;
  ator?: unknown;
}

/**
 * Creates the job on the entry node and records `trabalho.criado` (FR4).
 *
 * `grafo_versao_id` goes into the PROJECTION and not into the event payload: the
 * `trabalho.criado` schema does not declare it, and a log carrying a field
 * outside its contract is a log no consumer can validate.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The created job.
 * @throws {ValidationError} When a required field is missing.
 */
export function createJob(db: Database, input: CreateJobInput): Job {
  // Validate BEFORE opening the transaction: an invalid request must not even
  // consume an id from the sequence (FR3).
  const data = requireValidData('trabalho.criado', {
    titulo: input.titulo,
    no_entrada_id: input.no_entrada_id,
  });
  const projectId = integerOrDefault('projeto_id', input.projeto_id, DEFAULT_PROJECT);
  const executionId = integerOrNull('execucao_id', input.execucao_id);
  const graphVersionId = textOrNull('grafo_versao_id', input.grafo_versao_id);
  const actor = resolveActor(input.ator, API_ACTOR);
  const entryNode = data.no_entrada_id as string;

  const create = db.transaction((): Job => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO trabalho (
           projeto_id, execucao_id, titulo, no_entrada_id, no_atual,
           bloqueado, motivo_bloqueio, grafo_versao_id, criado_em, atualizado_em
         ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(
        projectId,
        executionId,
        data.titulo as string,
        entryNode,
        entryNode,
        graphVersionId,
        timestamp,
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      tipo: 'trabalho.criado',
      projeto_id: projectId,
      execucao_id: executionId,
      entidade: { tipo: 'trabalho', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toJob(readRow(db, id) as JobRow);
  });

  return create();
}

/**
 * Records an event about a job that already exists and updates the projection.
 *
 * The template of FR5–FR7: load the row (a 404 becomes `null` without writing
 * anything), validate the payload, and only then open the transaction in which
 * projection and event land together.
 */
function mutate(
  db: Database,
  id: number,
  type: string,
  actor: unknown,
  defaultActor: Actor,
  build: (row: JobRow) => {
    data: Record<string, unknown>;
    sql: string;
    values: unknown[];
  },
): Job | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const { data: raw, sql, values } = build(row);
  const data = requireValidData(type, raw);
  const finalActor = resolveActor(actor, defaultActor);

  const apply = db.transaction((): Job => {
    const timestamp = now();
    db.prepare(`UPDATE trabalho SET ${sql}, atualizado_em = ? WHERE id = ?`).run(
      ...values,
      timestamp,
      id,
    );
    recordEvent(db, {
      tipo: type,
      projeto_id: row.projeto_id,
      execucao_id: row.execucao_id,
      entidade: { tipo: 'trabalho', id },
      ator: finalActor,
      ocorrido_em: timestamp,
      dados: data,
    });
    return toJob(readRow(db, id) as JobRow);
  });

  return apply();
}

/** Body of `POST /v1/jobs/:id/transitions`. */
export interface TransitionInput {
  para_no_id?: unknown;
  ator?: unknown;
}

/**
 * Moves the job across nodes and records `trabalho.transicao` (FR5).
 *
 * `de_no_id` is `null` on the FIRST transition — the job leaving the entry node
 * for the first time — and the current node from then on. What answers "first?"
 * is the log, not the projection: a job can come back to the entry node later,
 * and then `no_atual == no_entrada_id` no longer distinguishes anything.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @returns The updated job, or `null` if it does not exist.
 */
export function transitionJob(
  db: Database,
  id: number,
  input: TransitionInput,
): Job | null {
  const alreadyWalked =
    db
      .prepare(
        `SELECT 1 FROM evento
          WHERE tipo = 'trabalho.transicao' AND entidade_tipo = 'trabalho' AND entidade_id = ?
          LIMIT 1`,
      )
      .get(String(id)) !== undefined;

  return mutate(db, id, 'trabalho.transicao', input.ator, API_ACTOR, (row) => ({
    data: { de_no_id: alreadyWalked ? row.no_atual : null, para_no_id: input.para_no_id },
    sql: 'no_atual = ?',
    values: [input.para_no_id],
  }));
}

/** Body of `POST /v1/jobs/:id/blocks`. */
export interface BlockInput {
  motivo?: unknown;
  ator?: unknown;
}

/**
 * Raises the blocked flag and records `trabalho.bloqueado` (FR6).
 *
 * Blocking is a flag fact, not a movement fact: the job does not leave the node.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @returns The updated job, or `null` if it does not exist.
 */
export function blockJob(db: Database, id: number, input: BlockInput): Job | null {
  return mutate(db, id, 'trabalho.bloqueado', input.ator, API_ACTOR, () => ({
    data: { motivo: input.motivo },
    sql: 'bloqueado = ?, motivo_bloqueio = ?',
    values: [asInteger(true), input.motivo],
  }));
}

/** Body of `POST /v1/jobs/:id/unblocks`. */
export interface UnblockInput {
  ator?: unknown;
}

/**
 * Lowers the flag and records `trabalho.desbloqueado` (FR6).
 *
 * The event has no payload: the fact is the fall of the flag itself.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @returns The updated job, or `null` if it does not exist.
 */
export function unblockJob(db: Database, id: number, input: UnblockInput): Job | null {
  return mutate(db, id, 'trabalho.desbloqueado', input.ator, API_ACTOR, () => ({
    data: {},
    sql: 'bloqueado = ?, motivo_bloqueio = NULL',
    values: [asInteger(false)],
  }));
}

/** Body of `PATCH /v1/jobs/:id`. */
export interface AmendInput {
  titulo?: unknown;
  ator?: unknown;
}

/**
 * Amends the job's content and records `trabalho.emendado` (FR7).
 *
 * The event carries the NAMES of the changed fields and never the new content:
 * this is an audit record, not a version history. Whoever wants the new text
 * reads the job.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @returns The updated job, or `null` if it does not exist.
 */
export function amendJob(db: Database, id: number, input: AmendInput): Job | null {
  return mutate(db, id, 'trabalho.emendado', input.ator, API_ACTOR, () => ({
    data: { campos_alterados: ['titulo'] },
    sql: 'titulo = ?',
    values: [input.titulo],
  }));
}

/**
 * The current board: one job per row (FR8).
 *
 * @param db Open handle.
 * @param filter Optional slice by execution.
 * @returns Jobs in id order.
 */
export function listJobs(
  db: Database,
  filter: { execucao_id?: number } = {},
): Job[] {
  const rows = (
    filter.execucao_id === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM trabalho ORDER BY id`).all()
      : db
          .prepare(`SELECT ${COLUMNS} FROM trabalho WHERE execucao_id = ? ORDER BY id`)
          .all(filter.execucao_id)
  ) as JobRow[];
  return rows.map(toJob);
}

/**
 * The job's timeline (FR9).
 *
 * @param db Open handle.
 * @param id Job id.
 * @returns Events in id order, or `null` if the job does not exist.
 */
export function jobTimeline(db: Database, id: number): Event[] | null {
  if (readRow(db, id) === undefined) return null;
  return listEvents(db, { trabalho_id: id });
}

/**
 * Graph version × telemetry, for one execution (FR17).
 *
 * It is the join the topographer will need after the PoC: without counting jobs
 * AND events PER version, "v2 is better than v1" is no more than an opinion
 * (D15). Jobs with no declared version fall into a `null` group instead of
 * disappearing — a report that hides what it cannot classify lies about the
 * total.
 *
 * @param db Open handle.
 * @param executionId Execution to group.
 * @returns One row per version, named versions first and `null` last.
 */
export function metricsByVersion(db: Database, executionId: number): MetricByVersion[] {
  const rows = db
    .prepare(
      `SELECT t.grafo_versao_id           AS grafo_versao_id,
              COUNT(*)                    AS trabalhos,
              COALESCE(SUM((${JOB_EVENTS})), 0) AS eventos
         FROM trabalho t
        WHERE t.execucao_id = ?
        GROUP BY t.grafo_versao_id`,
    )
    .all(executionId) as MetricByVersion[];

  return rows.sort((a, b) => {
    if (a.grafo_versao_id === null) return 1;
    if (b.grafo_versao_id === null) return -1;
    return a.grafo_versao_id.localeCompare(b.grafo_versao_id);
  });
}

/**
 * The executions that exist, one row per round (t107, FR1).
 *
 * There is no "execution" entity in this v1 — `execucao_id` is an opaque
 * grouper, and this list is an AGGREGATION over `trabalho`, not a table. It
 * exists because without it the screen has no way to DISCOVER which rounds
 * exist: until here one could only query an execution already knowing its id,
 * which serves whoever already knows and nobody else. D11 calls that a bug of
 * the API, and this is where it closes.
 *
 * The three counts are the ones that answer "where to look first": size of the
 * round, how much of it is stuck, and how many people are being waited on.
 * `perguntas_pendentes` comes from a correlated subquery with `IS` (equality
 * that sees `NULL`), so that the group without an execution counts its own
 * input requests instead of silently zeroing.
 *
 * @param db Open handle.
 * @returns One row per execution, ascending, with the `null` group last — the
 *   same convention as `metricsByVersion`.
 */
export function listExecutions(db: Database): ExecutionSummary[] {
  const rows = db
    .prepare(
      `SELECT t.execucao_id            AS execucao_id,
              COUNT(*)                 AS trabalhos,
              COALESCE(SUM(t.bloqueado), 0) AS trabalhos_bloqueados,
              (SELECT COUNT(*) FROM pergunta p
                WHERE p.status = 'pendente' AND p.execucao_id IS t.execucao_id)
                                       AS perguntas_pendentes
         FROM trabalho t
        GROUP BY t.execucao_id`,
    )
    .all() as ExecutionSummary[];

  return rows.sort((a, b) => {
    if (a.execucao_id === null) return 1;
    if (b.execucao_id === null) return -1;
    return a.execucao_id - b.execucao_id;
  });
}
