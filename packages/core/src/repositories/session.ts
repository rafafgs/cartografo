/**
 * Session repository — the run of an agent by an EngineAdapter.
 *
 * In flowpilot this was a mutable row born `pending` and updated until
 * `completed`. Here there are TWO facts (`sessao.aberta`, `sessao.finalizada`)
 * and a projection derived from them — consequence 2 of the taxonomy's
 * append-only rule.
 *
 * The care that runs through the file: an absent `uso` is `null`, never zero.
 * Zero tokens is a measurement; absence is the engine not having reported
 * anything, and collapsing the two destroys the only cost metric the PoC will
 * have.
 *
 * The projection's field names, the table/column names and the event-type
 * strings mirror the untouched migration and the event taxonomy, so they stay in
 * Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import { requireValidData } from '../db/event-validation.ts';
import {
  RUNNER_ACTOR,
  DEFAULT_PROJECT,
  now,
  integerOrNull,
  integerOrDefault,
  jsonOrNull,
  resolveActor,
} from './common.ts';

/** Token totals frozen at the end of the session's life. */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Session projection, as the API returns it. */
export interface Session {
  id: number;
  trabalho_id: number | null;
  execucao_id: number | null;
  no_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  timeout_seconds: number | null;
  status: string;
  exit_code: number | null;
  uso: SessionUsage | null;
  aberta_em: string;
  finalizada_em: string | null;
}

interface SessionRow extends Omit<Session, 'uso'> {
  uso: string | null;
}

const COLUMNS = `
  id, trabalho_id, execucao_id, no_id, engine, engine_session_ref, working_dir,
  prompt, timeout_seconds, status, exit_code, uso, aberta_em, finalizada_em
`;

function toSession(row: SessionRow): Session {
  return { ...row, uso: jsonOrNull<SessionUsage>(row.uso) };
}

function readRow(db: Database, id: number): SessionRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM sessao WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
}

/**
 * Gets a session by its projection.
 *
 * @param db Open handle.
 * @param id Session id.
 * @returns The session, or `null` if it does not exist.
 */
export function getSession(db: Database, id: number): Session | null {
  const row = readRow(db, id);
  return row === undefined ? null : toSession(row);
}

/** Body of `POST /v1/sessions`. */
export interface OpenSessionInput {
  trabalho_id?: unknown;
  no_id?: unknown;
  engine?: unknown;
  engine_session_ref?: unknown;
  working_dir?: unknown;
  prompt?: unknown;
  timeout_seconds?: unknown;
  execucao_id?: unknown;
  projeto_id?: unknown;
  ator?: unknown;
}

/**
 * Opens the session and records `sessao.aberta` (FR10).
 *
 * `execucao_id` and `projeto_id` are inherited from the job served when there is
 * one — the session belongs to the job's round, and asking the caller to repeat
 * that would invite divergence. Without a job (a discovery session, a
 * conversation turn), what came in the body holds.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The open session, or `null` if the given `trabalho_id` does not exist.
 * @throws {ValidationError} When a required field is missing.
 */
export function openSession(db: Database, input: OpenSessionInput): Session | null {
  const data = requireValidData('sessao.aberta', {
    trabalho_id: input.trabalho_id,
    no_id: input.no_id,
    engine: input.engine,
    engine_session_ref: input.engine_session_ref,
    working_dir: input.working_dir,
    prompt: input.prompt,
    timeout_seconds: input.timeout_seconds,
  });

  const jobId = data.trabalho_id as number | null;
  const owner =
    jobId === null
      ? undefined
      : (db.prepare('SELECT projeto_id, execucao_id FROM trabalho WHERE id = ?').get(jobId) as
          | { projeto_id: number; execucao_id: number | null }
          | undefined);
  if (jobId !== null && owner === undefined) return null;

  const projectId = owner?.projeto_id ?? integerOrDefault('projeto_id', input.projeto_id, DEFAULT_PROJECT);
  const executionId = owner?.execucao_id ?? integerOrNull('execucao_id', input.execucao_id);
  const actor = resolveActor(input.ator, RUNNER_ACTOR);

  const open = db.transaction((): Session => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO sessao (
           trabalho_id, execucao_id, no_id, engine, engine_session_ref, working_dir,
           prompt, timeout_seconds, status, exit_code, uso, aberta_em, finalizada_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', NULL, NULL, ?, NULL)`,
      )
      .run(
        jobId,
        executionId,
        data.no_id as string | null,
        data.engine as string,
        data.engine_session_ref as string | null,
        data.working_dir as string,
        data.prompt as string,
        data.timeout_seconds as number | null,
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      tipo: 'sessao.aberta',
      projeto_id: projectId,
      execucao_id: executionId,
      entidade: { tipo: 'sessao', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toSession(readRow(db, id) as SessionRow);
  });

  return open();
}

/** Body of `PATCH /v1/sessions/:id/finish`. */
export interface FinishSessionInput {
  status?: unknown;
  exit_code?: unknown;
  uso?: unknown;
  ator?: unknown;
}

/**
 * Closes the session and records `sessao.finalizada` (FR11).
 *
 * @param db Open handle.
 * @param id Session id.
 * @param input Request body.
 * @returns The closed session, or `null` if it does not exist.
 * @throws {ValidationError} When the status is outside the enum or `uso` does not match.
 */
export function finishSession(
  db: Database,
  id: number,
  input: FinishSessionInput,
): Session | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData('sessao.finalizada', {
    status: input.status,
    exit_code: input.exit_code,
    uso: input.uso,
  });
  const usage = data.uso as SessionUsage | null;
  const actor = resolveActor(input.ator, RUNNER_ACTOR);

  const project = db
    .prepare('SELECT projeto_id FROM trabalho WHERE id = ?')
    .get(row.trabalho_id) as { projeto_id: number } | undefined;

  const close = db.transaction((): Session => {
    const timestamp = now();
    db.prepare(
      `UPDATE sessao SET status = ?, exit_code = ?, uso = ?, finalizada_em = ? WHERE id = ?`,
    ).run(
      data.status as string,
      data.exit_code as number | null,
      // An absent `uso` writes a real NULL, never an object of zeros.
      usage === null ? null : JSON.stringify(usage),
      timestamp,
      id,
    );

    recordEvent(db, {
      tipo: 'sessao.finalizada',
      projeto_id: project?.projeto_id ?? DEFAULT_PROJECT,
      execucao_id: row.execucao_id,
      entidade: { tipo: 'sessao', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toSession(readRow(db, id) as SessionRow);
  });

  return close();
}

/**
 * The sessions of one execution (FR12).
 *
 * @param db Open handle.
 * @param filter Optional slice by execution.
 * @returns Sessions in id order.
 */
export function listSessions(db: Database, filter: { execucao_id?: number } = {}): Session[] {
  const rows = (
    filter.execucao_id === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM sessao ORDER BY id`).all()
      : db
          .prepare(`SELECT ${COLUMNS} FROM sessao WHERE execucao_id = ? ORDER BY id`)
          .all(filter.execucao_id)
  ) as SessionRow[];
  return rows.map(toSession);
}
