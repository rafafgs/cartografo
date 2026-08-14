/**
 * Input-request repository — human escalation as a first-class entity.
 *
 * A question and an approval are the same animal; the `tipo` field is the only
 * difference. And the ORIGIN of the answer is the EVENT TYPE
 * (`pergunta.respondida` vs `pergunta.auto_resolvida`), not a column of the log:
 * the audit of "was this approved by a person or by the system?" has to survive
 * somebody altering a projection row. In the projection the origin becomes a
 * field again, because whoever reads state wants to compare, not to classify.
 *
 * What this file does NOT do, on purpose: block the job when the input request
 * is created. That wiring (input request → block → answer → unblock → session
 * resumed) is the central acceptance criterion of t106; anticipating it here
 * would create two owners for the same cycle.
 *
 * The projection's field names, the table/column names and the event-type
 * strings mirror the untouched migration and the event taxonomy, so they stay in
 * Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import { requireValidData, type Actor } from '../db/event-validation.ts';
import {
  API_ACTOR,
  AUTO_APPROVAL_ACTOR,
  DEFAULT_PROJECT,
  now,
  asBoolean,
  asInteger,
  jsonOrNull,
  resolveActor,
} from './common.ts';

/** Input-request projection, as the API returns it. */
export interface InputRequest {
  id: number;
  trabalho_id: number;
  sessao_id: number | null;
  execucao_id: number | null;
  tipo: string;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  auto_aprovavel: boolean;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
  criada_em: string;
  respondida_em: string | null;
}

interface InputRequestRow extends Omit<InputRequest, 'opcoes' | 'auto_aprovavel'> {
  opcoes: string | null;
  auto_aprovavel: number;
}

const COLUMNS = `
  id, trabalho_id, sessao_id, execucao_id, tipo, pergunta, contexto, opcoes,
  recomendacao, resposta_padrao, auto_aprovavel, status, resposta,
  respondido_por, origem, criada_em, respondida_em
`;

function toInputRequest(row: InputRequestRow): InputRequest {
  return {
    ...row,
    opcoes: jsonOrNull<string[]>(row.opcoes),
    auto_aprovavel: asBoolean(row.auto_aprovavel),
  };
}

function readRow(db: Database, id: number): InputRequestRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM pergunta WHERE id = ?`).get(id) as
    | InputRequestRow
    | undefined;
}

/**
 * Gets an input request by its projection.
 *
 * @param db Open handle.
 * @param id Input-request id.
 * @returns The input request, or `null` if it does not exist.
 */
export function getInputRequest(db: Database, id: number): InputRequest | null {
  const row = readRow(db, id);
  return row === undefined ? null : toInputRequest(row);
}

/** Body of `POST /v1/input-requests`. */
export interface CreateInputRequestInput {
  trabalho_id?: unknown;
  sessao_id?: unknown;
  tipo?: unknown;
  pergunta?: unknown;
  contexto?: unknown;
  opcoes?: unknown;
  recomendacao?: unknown;
  resposta_padrao?: unknown;
  auto_aprovavel?: unknown;
  ator?: unknown;
}

/**
 * Records the escalation request and writes `pergunta.criada` (FR13).
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The pending input request, or `null` if the job does not exist.
 * @throws {ValidationError} When a required field is missing.
 */
export function createInputRequest(
  db: Database,
  input: CreateInputRequestInput,
): InputRequest | null {
  const data = requireValidData('pergunta.criada', {
    trabalho_id: input.trabalho_id,
    sessao_id: input.sessao_id,
    tipo: input.tipo,
    pergunta: input.pergunta,
    contexto: input.contexto,
    opcoes: input.opcoes,
    recomendacao: input.recomendacao,
    resposta_padrao: input.resposta_padrao,
    auto_aprovavel: input.auto_aprovavel,
  });

  const jobId = data.trabalho_id as number;
  const owner = db
    .prepare('SELECT projeto_id, execucao_id FROM trabalho WHERE id = ?')
    .get(jobId) as { projeto_id: number; execucao_id: number | null } | undefined;
  if (owner === undefined) return null;

  const options = data.opcoes as string[] | null;
  const actor = resolveActor(input.ator, API_ACTOR);

  const create = db.transaction((): InputRequest => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO pergunta (
           trabalho_id, sessao_id, execucao_id, tipo, pergunta, contexto, opcoes,
           recomendacao, resposta_padrao, auto_aprovavel, status, resposta,
           respondido_por, origem, criada_em, respondida_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        jobId,
        data.sessao_id as number | null,
        owner.execucao_id,
        data.tipo as string,
        data.pergunta as string,
        data.contexto as string | null,
        options === null ? null : JSON.stringify(options),
        data.recomendacao as string | null,
        data.resposta_padrao as string | null,
        asInteger(data.auto_aprovavel as boolean),
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      tipo: 'pergunta.criada',
      projeto_id: owner.projeto_id,
      execucao_id: owner.execucao_id,
      entidade: { tipo: 'pergunta', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toInputRequest(readRow(db, id) as InputRequestRow);
  });

  return create();
}

/**
 * Closes an input request with an answer, whoever it comes from.
 *
 * The template shared by FR14 and FR15: the only things that change between a
 * human and the automatic gate are the event type, the projection's `origem` and
 * the actor.
 */
function answer(
  db: Database,
  id: number,
  type: 'pergunta.respondida' | 'pergunta.auto_resolvida',
  origin: 'usuario' | 'auto',
  raw: Record<string, unknown>,
  answeredBy: string | null,
  actor: Actor,
): InputRequest | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData(type, raw);

  const owner = db.prepare('SELECT projeto_id FROM trabalho WHERE id = ?').get(row.trabalho_id) as
    | { projeto_id: number }
    | undefined;

  const close = db.transaction((): InputRequest => {
    const timestamp = now();
    db.prepare(
      `UPDATE pergunta
          SET status = 'respondida', resposta = ?, respondido_por = ?, origem = ?, respondida_em = ?
        WHERE id = ?`,
    ).run(data.resposta as string, answeredBy, origin, timestamp, id);

    recordEvent(db, {
      tipo: type,
      projeto_id: owner?.projeto_id ?? DEFAULT_PROJECT,
      execucao_id: row.execucao_id,
      entidade: { tipo: 'pergunta', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toInputRequest(readRow(db, id) as InputRequestRow);
  });

  return close();
}

/** Body of `PATCH /v1/input-requests/:id/answer`. */
export interface AnswerInput {
  resposta?: unknown;
  respondido_por?: unknown;
  ator?: unknown;
}

/**
 * Records the human's answer (FR14).
 *
 * The default actor is `respondido_por` itself: `ator.ref` and the payload field
 * are redundant BY DESIGN — the audit of "what was asked, answered, when and by
 * whom" has to survive reading the payload alone.
 *
 * @param db Open handle.
 * @param id Input-request id.
 * @param input Request body.
 * @returns The answered input request, or `null` if it does not exist.
 */
export function answerInputRequest(
  db: Database,
  id: number,
  input: AnswerInput,
): InputRequest | null {
  const answeredBy = typeof input.respondido_por === 'string' ? input.respondido_por : null;
  const actor = resolveActor(input.ator, {
    tipo: 'usuario',
    ref: answeredBy ?? 'desconhecido',
  });

  return answer(
    db,
    id,
    'pergunta.respondida',
    'usuario',
    { resposta: input.resposta, respondido_por: input.respondido_por },
    answeredBy,
    actor,
  );
}

/** Body of `PATCH /v1/input-requests/:id/auto-resolution`. */
export interface AutoResolutionInput {
  resposta?: unknown;
  baseada_em?: unknown;
  ator?: unknown;
}

/**
 * Records the answer given by the auto-approval gate on the human's behalf (FR15).
 *
 * `baseada_em` is a closed enum (`recomendacao`/`resposta_padrao`/`precedente`):
 * an auto-approval that cannot say where it got the answer from is a decision
 * with no trace, and the safety ladder of evolution depends on exactly that
 * trace.
 *
 * @param db Open handle.
 * @param id Input-request id.
 * @param input Request body.
 * @returns The answered input request, or `null` if it does not exist.
 */
export function autoResolveInputRequest(
  db: Database,
  id: number,
  input: AutoResolutionInput,
): InputRequest | null {
  return answer(
    db,
    id,
    'pergunta.auto_resolvida',
    'auto',
    { resposta: input.resposta, baseada_em: input.baseada_em },
    AUTO_APPROVAL_ACTOR.ref,
    resolveActor(input.ator, AUTO_APPROVAL_ACTOR),
  );
}

/**
 * The input-request queue of one execution (FR16).
 *
 * Returns the WHOLE input request — context, options, recommendation and default
 * answer. The criterion is the one in the statement: whoever answers has to be
 * able to decide without opening the repository.
 *
 * @param db Open handle.
 * @param filter Optional slices by status and execution.
 * @returns Input requests in id order.
 */
export function listInputRequests(
  db: Database,
  filter: { status?: string; execucao_id?: number } = {},
): InputRequest[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.status !== undefined) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.execucao_id !== undefined) {
    conditions.push('execucao_id = ?');
    values.push(filter.execucao_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM pergunta ${where} ORDER BY id`)
    .all(...values) as InputRequestRow[];
  return rows.map(toInputRequest);
}
