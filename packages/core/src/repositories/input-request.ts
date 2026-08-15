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
 * The input request → block → answer → unblock wiring lives HERE since t106, and
 * it lives inside the transactions that already existed: asking on behalf of the
 * job and the job carrying on anyway is the state nobody can explain afterwards.
 * Re-dispatching the session is on the other side of the boundary (the runner's
 * `Controller`, t103/t106) — see `docs/spec/escalacao-humana.md`.
 *
 * The projection's field names, the table/column names and the event-type
 * strings mirror the untouched migration and the event taxonomy, so they stay in
 * Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import { requireValidData, type Actor } from '../db/event-validation.ts';
import { similarity } from '../domain/similarity.ts';
import {
  API_ACTOR,
  AUTO_APPROVAL_ACTOR,
  DEFAULT_PROJECT,
  ESCALATION_ACTOR,
  now,
  asBoolean,
  asInteger,
  jsonOrNull,
  resolveActor,
} from './common.ts';
import { blockJob, unblockJob } from './job.ts';

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
 * Records the escalation request, writes `pergunta.criada` and BLOCKS the owning
 * job in the same transaction (FR13; t106).
 *
 * The block is not a second step for the caller: whoever asks is a session that
 * is ending, and a job that stays a dispatch candidate with a pending input
 * request is a brand-new session asking the same question forever. The nested
 * `db.transaction` becomes a savepoint in `better-sqlite3`, so input request,
 * event and flag all land together or not at all.
 *
 * The route's shape does not change: `POST /v1/input-requests` still returns only
 * the input request, and whoever wants the flag reads `GET /v1/jobs/:id`.
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

    // The reason quotes the input request's id (the taxonomy's own example):
    // whoever reads the job discovers from the reason itself what has to happen
    // for it to start moving again.
    blockJob(db, jobId, {
      motivo: `aguardando resposta da pergunta ${id}`,
      ator: ESCALATION_ACTOR,
    });

    return toInputRequest(readRow(db, id) as InputRequestRow);
  });

  return create();
}

/**
 * Closes an input request with an answer, whoever it comes from, and UNBLOCKS the
 * job that was waiting on it (FR14/FR15; t106).
 *
 * The template shared by FR14 and FR15: the only things that change between a
 * human and the automatic gate are the event type, the projection's `origem` and
 * the actor.
 *
 * The unblock reuses the SAME actor as the answer event — `usuario` when a person
 * answered, the gate when it was automatic. The taxonomy asks for this explicitly
 * on `trabalho.desbloqueado`, and it is what stops the audit from concluding that
 * "the system" unblocked everything a human unblocked.
 *
 * Closing is exactly-once: the `UPDATE` is guarded by `status = 'pendente'` and a
 * lost claim throws, the same shape `amendDraft`/`applyProposal`/`renewLease`
 * already use (t149). The route answers 409 for the sequential retry; this guard
 * is the backstop for two callers racing over the same input request.
 *
 * @throws {Error} When the input request stopped being pending mid-flight.
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
    const effect = db
      .prepare(
        `UPDATE pergunta
            SET status = 'respondida', resposta = ?, respondido_por = ?, origem = ?, respondida_em = ?
          WHERE id = ? AND status = 'pendente'`,
      )
      .run(data.resposta as string, answeredBy, origin, timestamp, id);

    // The whole transaction falls if the input request stopped being pending
    // between the route's check and this UPDATE: answering twice is a 409, never
    // a second answer over the first (t149). Throwing HERE, before the two
    // writes below, is what keeps the contradictory event and the unblock from
    // happening at all.
    if (effect.changes !== 1) {
      throw new Error(`input request ${id} stopped being pending during the answer`);
    }

    recordEvent(db, {
      tipo: type,
      projeto_id: owner?.projeto_id ?? DEFAULT_PROJECT,
      execucao_id: row.execucao_id,
      entidade: { tipo: 'pergunta', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    // Lowers the flag `createInputRequest` raised. Deliberately without a
    // condition: the job may have been blocked for another reason at the same
    // time, and "I answered and the job stayed put" is the worst possible outcome
    // for whoever just answered. A non-existent job returns `null` and does
    // nothing — the input request stays answered.
    //
    // What makes that safe is the guard above: only an answer that actually
    // closed a PENDING input request ever gets here, so a retried answer can no
    // longer unblock a job that is meanwhile waiting on a different question.
    unblockJob(db, row.trabalho_id, { ator: actor });

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
 * The input-request queue of one execution, or of one job (FR16; t107 FR3).
 *
 * Returns the WHOLE input request — context, options, recommendation and default
 * answer. The criterion is the one in the statement: whoever answers has to be
 * able to decide without opening the repository.
 *
 * The slice by job is symmetric to the one in `listSessions` and exists for the
 * same reason: the screen's timeline needs the end of the waits, and the
 * payload of `pergunta.respondida` does not carry `trabalho_id` — so that fact
 * never shows up in `GET /v1/jobs/:id/events`. The filters add up as AND.
 *
 * @param db Open handle.
 * @param filter Optional slices by status, execution and job.
 * @returns Input requests in id order.
 */
export function listInputRequests(
  db: Database,
  filter: { status?: string; execucao_id?: number; trabalho_id?: number } = {},
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
  if (filter.trabalho_id !== undefined) {
    conditions.push('trabalho_id = ?');
    values.push(filter.trabalho_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM pergunta ${where} ORDER BY id`)
    .all(...values) as InputRequestRow[];
  return rows.map(toInputRequest);
}

/**
 * A precedent: an already-answered input request of the same project, together
 * with how much it looks like the one being queried.
 *
 * It carries the DECISION (`resposta`) and where that decision came from
 * (`origem`, `respondido_por`, `respondida_em`), because that is what whoever is
 * answering right now needs to see: knowing that something similar was asked
 * before is not enough — one has to know what was decided, by whom and when.
 *
 * The field names mirror the untouched migration columns, so they stay in
 * Portuguese (t127, FR8); `similaridade` is the one computed field and follows
 * the same wire vocabulary as its neighbours.
 */
export interface Precedent {
  id: number;
  tipo: string;
  pergunta: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
  criada_em: string;
  respondida_em: string | null;
  /** Score in `[0, 1]`, rounded to 2 decimals — see `domain/similarity.ts`. */
  similaridade: number;
}

type PrecedentRow = Omit<Precedent, 'similaridade'>;

/** How many precedents come back when the caller does not say. */
const DEFAULT_PRECEDENT_LIMIT = 5;

/** Ceiling of `limite`: the route clamps, it does not refuse (size knob, not rule). */
const MAXIMUM_PRECEDENT_LIMIT = 20;

const PRECEDENT_COLUMNS = `
  p.id, p.tipo, p.pergunta, p.resposta, p.respondido_por, p.origem,
  p.criada_em, p.respondida_em
`;

/** Two decimals: the score is there to be READ and compared, not computed on. */
function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

/**
 * The already-answered input requests of the same project that most look like
 * the one at `:id` (t113).
 *
 * The slice is the project of whoever is asking — `projeto_id` arrives through
 * the owning job, the same path `createInputRequest` already walks. A precedent
 * from another project would be a decision taken in another context entering as
 * if it were this project's own history, and project isolation is exactly what
 * the rest of the code already applies (leases, jobs).
 *
 * The queried input request never enters its own list: once answered it would
 * match itself with score 1 and sit at the top of its own ranking forever.
 *
 * The scan is naive on purpose: it reads every answered row of the project and
 * scores in memory. At the PoC's volume that is irrelevant, and an index or a
 * cache before a large base exists would be optimizing against an imagined
 * problem — the ticket's gotcha note records when to revisit.
 *
 * @param db Open handle.
 * @param id Id of the queried input request (pending or not).
 * @param options `limit` of items; clamped to `[1, 20]`, default 5.
 * @returns Precedents in score order, or `null` if the input request does not exist.
 */
export function getPrecedents(
  db: Database,
  id: number,
  options: { limit?: number } = {},
): Precedent[] | null {
  const target = readRow(db, id);
  if (target === undefined) return null;

  // The project of whoever asks comes from the owning job — same path as
  // `createInputRequest`. A missing job is impossible through the FK, and even
  // then the honest answer is "no precedents", never a failure.
  const owner = db.prepare('SELECT projeto_id FROM trabalho WHERE id = ?').get(target.trabalho_id) as
    | { projeto_id: number }
    | undefined;
  if (owner === undefined) return [];

  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_PRECEDENT_LIMIT, 1),
    MAXIMUM_PRECEDENT_LIMIT,
  );

  const candidates = db
    .prepare(
      `SELECT ${PRECEDENT_COLUMNS}
         FROM pergunta p
         JOIN trabalho t ON t.id = p.trabalho_id
        WHERE p.status = 'respondida'
          AND p.id <> ?
          AND t.projeto_id = ?`,
    )
    .all(id, owner.projeto_id) as PrecedentRow[];

  // A tie on score goes to the MOST RECENT decision: when two old decisions look
  // equally like today's, the last one is the one that stands. The timestamps are
  // ISO 8601, so lexicographic order is chronological order.
  const mostRecent = (a: PrecedentRow, b: PrecedentRow): number =>
    (b.respondida_em ?? '').localeCompare(a.respondida_em ?? '');

  return candidates
    .map((row) => ({ row, score: similarity(target.pergunta, row.pergunta) }))
    .filter((pair) => pair.score > 0)
    .sort((a, b) => b.score - a.score || mostRecent(a.row, b.row))
    .slice(0, limit)
    .map(({ row, score }) => ({ ...row, similaridade: roundScore(score) }));
}
