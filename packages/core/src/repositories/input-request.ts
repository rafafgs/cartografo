/**
 * Input-request repository — human escalation as a first-class entity.
 *
 * A question and an approval are the same animal; the `tipo` field is the only
 * difference. And the ORIGIN of the answer is the EVENT TYPE
 * (`input_request.answered` vs `input_request.auto_resolved`), not a column of the log:
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
  /**
   * The node the owning job was standing on when it asked (t167).
   *
   * `null` is ordinary and never a defect: a row written before the column
   * existed, or a job with no position at all. It is stamped by the server from
   * the job, never by the caller — a question that declared its own node would
   * be a question able to lie about where the work was.
   */
  no_id: string | null;
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
  id, trabalho_id, sessao_id, execucao_id, no_id, tipo, pergunta, contexto,
  opcoes, recomendacao, resposta_padrao, auto_aprovavel, status, resposta,
  respondido_por, origem, criada_em, respondida_em
`;

function toInputRequest(row: InputRequestRow): InputRequest {
  return {
    ...row,
    opcoes: jsonOrNull<string[]>(row.opcoes),
    auto_aprovavel: asBoolean(row.auto_aprovavel),
  };
}

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/*                                                                             */
/* Both sides cross it since t227: `POST /v1/input-requests` and the two answer */
/* routes take English bodies too, because those reach `validateEvent` and D20's*/
/* second child renamed that vocabulary (`routes/common.ts` tells the story).   */
/* -------------------------------------------------------------------------- */

/**
 * `pergunta.status` and `pergunta.tipo`, row → wire (`glossario-wire.md` §1.6).
 *
 * `tipo` is the one row of §1.6 that is QUALIFIED, and the glossary says why:
 * the bare word `pergunta` is the ENTITY and becomes `input_request`, while
 * `pergunta.tipo = pergunta` is the KIND of escalation and becomes `question`.
 * One word, two concepts, two English names — which is exactly what a glossary
 * exists to keep straight.
 */
const STATUS_FIELD: Record<string, string> = { pendente: 'pending', respondida: 'answered' };
const STATUS_COLUMN: Record<string, string> = { pending: 'pendente', answered: 'respondida' };
const KIND_FIELD: Record<string, string> = { pergunta: 'question', aprovacao: 'approval' };

/**
 * ...and the way back, which t227 is what created the need for.
 *
 * `pergunta.tipo` carries a `CHECK (tipo IN ('pergunta','aprovacao'))` since
 * migration `0003`, so the column cannot simply take the event's new word. The
 * wire says `question`/`approval` and the row keeps saying what its constraint
 * demands, exactly as lease status and draft status already do here and in
 * `repositories/leases.ts`. Renaming the column and its CHECK is D20's fifth
 * child; when it lands this map is what disappears.
 */
const KIND_COLUMN: Record<string, string> = { question: 'pergunta', approval: 'aprovacao' };

/**
 * `pergunta.origem`, row → wire.
 *
 * The column's two values are `usuario` and `auto` (`CHECK` of migration
 * `0003`); `auto` is already English and `usuario` is not, and the glossary maps
 * it to `user` (§1.6). Translating it here is what lets the specification's
 * reducer compare its `perguntas` projection against this one with no map in
 * between — which is the whole point of `test/replay-consistency.test.ts`.
 */
const SOURCE_FIELD: Record<string, string> = { usuario: 'user', auto: 'auto' };

/** The two statuses a `?status=` filter may name, in the wire's spelling. */
export const INPUT_REQUEST_STATUSES: readonly string[] = Object.freeze(Object.keys(STATUS_COLUMN));

/** The English `status` a request declared, as the column spells it. */
export function inputRequestStatusColumn(value: string): string | undefined {
  return STATUS_COLUMN[value];
}

/** An input request, as `/v1` publishes it. */
export interface WireInputRequest {
  id: number;
  job_id: number;
  session_id: number | null;
  execution_id: number | null;
  node_id: string | null;
  kind: string;
  question: string;
  context: string | null;
  options: string[] | null;
  recommendation: string | null;
  default_answer: string | null;
  auto_approvable: boolean;
  status: string;
  answer: string | null;
  answered_by: string | null;
  /**
   * Where the decision came from: `user` or `auto`.
   *
   * Both the key and the value translate since t227 (`glossario-wire.md` §4.2
   * and §1.6). The column still says `usuario`, because its `CHECK` does —
   * see {@link SOURCE_FIELD}.
   */
  source: string | null;
  created_at: string;
  answered_at: string | null;
}

/** Projection to wire: the one place the column names meet the API's. */
export function toWireInputRequest(request: InputRequest): WireInputRequest {
  return {
    id: request.id,
    job_id: request.trabalho_id,
    session_id: request.sessao_id,
    execution_id: request.execucao_id,
    node_id: request.no_id,
    kind: KIND_FIELD[request.tipo] ?? request.tipo,
    question: request.pergunta,
    context: request.contexto,
    options: request.opcoes,
    recommendation: request.recomendacao,
    default_answer: request.resposta_padrao,
    auto_approvable: request.auto_aprovavel,
    status: STATUS_FIELD[request.status] ?? request.status,
    answer: request.resposta,
    answered_by: request.respondido_por,
    source: request.origem === null ? null : (SOURCE_FIELD[request.origem] ?? request.origem),
    created_at: request.criada_em,
    answered_at: request.respondida_em,
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
  job_id?: unknown;
  session_id?: unknown;
  kind?: unknown;
  question?: unknown;
  context?: unknown;
  options?: unknown;
  recommendation?: unknown;
  default_answer?: unknown;
  auto_approvable?: unknown;
  actor?: unknown;
}

/**
 * Records the escalation request, writes `input_request.created` and BLOCKS the owning
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
  const data = requireValidData('input_request.created', {
    job_id: input.job_id,
    session_id: input.session_id,
    kind: input.kind,
    question: input.question,
    context: input.context,
    options: input.options,
    recommendation: input.recommendation,
    default_answer: input.default_answer,
    auto_approvable: input.auto_approvable,
  });

  const jobId = data.job_id as number;
  // `no_atual` rides along with `projeto_id`/`execucao_id` — one lookup, one
  // trust boundary: everything an input request says about its owner comes from
  // the owner's row, and nothing from the body (t167).
  const owner = db
    .prepare('SELECT projeto_id, execucao_id, no_atual FROM trabalho WHERE id = ?')
    .get(jobId) as
    | { projeto_id: number; execucao_id: number | null; no_atual: string | null }
    | undefined;
  if (owner === undefined) return null;

  // A job with no position is recorded as having none. The column is NOT NULL,
  // so this only happens for a row that never got a real node — and the entry
  // node would be exactly the guess this stays away from.
  const nodeId =
    typeof owner.no_atual === 'string' && owner.no_atual !== '' ? owner.no_atual : null;

  const options = data.options as string[] | null;
  const actor = resolveActor(input.actor, API_ACTOR);

  const create = db.transaction((): InputRequest => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO pergunta (
           trabalho_id, sessao_id, execucao_id, no_id, tipo, pergunta, contexto,
           opcoes, recomendacao, resposta_padrao, auto_aprovavel, status, resposta,
           respondido_por, origem, criada_em, respondida_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        jobId,
        data.session_id as number | null,
        owner.execucao_id,
        nodeId,
        KIND_COLUMN[data.kind as string],
        data.question as string,
        data.context as string | null,
        options === null ? null : JSON.stringify(options),
        data.recommendation as string | null,
        data.default_answer as string | null,
        asInteger(data.auto_approvable as boolean),
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      type: 'input_request.created',
      project_id: owner.projeto_id,
      execution_id: owner.execucao_id,
      entity: { type: 'input_request', id },
      actor,
      occurred_at: timestamp,
      // The node goes into the payload here and not into `requireValidData`
      // above, for the ordinary reason: it is not known until the owner has been
      // read, and the owner is read after the body has been judged. `recordEvent`
      // revalidates the whole envelope anyway, this field included.
      data: { ...data, node_id: nodeId },
    });

    // The reason quotes the input request's id (the taxonomy's own example):
    // whoever reads the job discovers from the reason itself what has to happen
    // for it to start moving again.
    blockJob(db, jobId, {
      reason: `aguardando resposta da pergunta ${id}`,
      actor: ESCALATION_ACTOR,
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
 * The unblock reuses the SAME actor as the answer event — `user` when a person
 * answered, the gate when it was automatic. The taxonomy asks for this explicitly
 * on `job.unblocked`, and it is what stops the audit from concluding that
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
  type: 'input_request.answered' | 'input_request.auto_resolved',
  /** The COLUMN's value, whose `CHECK` still spells the first one Portuguese. */
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
      .run(data.answer as string, answeredBy, origin, timestamp, id);

    // The whole transaction falls if the input request stopped being pending
    // between the route's check and this UPDATE: answering twice is a 409, never
    // a second answer over the first (t149). Throwing HERE, before the two
    // writes below, is what keeps the contradictory event and the unblock from
    // happening at all.
    if (effect.changes !== 1) {
      throw new Error(`input request ${id} stopped being pending during the answer`);
    }

    recordEvent(db, {
      type,
      project_id: owner?.projeto_id ?? DEFAULT_PROJECT,
      execution_id: row.execucao_id,
      entity: { type: 'input_request', id },
      actor,
      occurred_at: timestamp,
      data,
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
    unblockJob(db, row.trabalho_id, { actor });

    return toInputRequest(readRow(db, id) as InputRequestRow);
  });

  return close();
}

/** Body of `PATCH /v1/input-requests/:id/answer`. */
export interface AnswerInput {
  answer?: unknown;
  answered_by?: unknown;
  actor?: unknown;
}

/**
 * Records the human's answer (FR14).
 *
 * The default actor is `answered_by` itself: `actor.ref` and the payload field
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
  const answeredBy = typeof input.answered_by === 'string' ? input.answered_by : null;
  const actor = resolveActor(input.actor, {
    type: 'user',
    ref: answeredBy ?? 'desconhecido',
  });

  return answer(
    db,
    id,
    'input_request.answered',
    'usuario',
    { answer: input.answer, answered_by: input.answered_by },
    answeredBy,
    actor,
  );
}

/** Body of `PATCH /v1/input-requests/:id/auto-resolution`. */
export interface AutoResolutionInput {
  answer?: unknown;
  based_on?: unknown;
  actor?: unknown;
}

/**
 * Records the answer given by the auto-approval gate on the human's behalf (FR15).
 *
 * `based_on` is a closed enum (`recommendation`/`default_answer`/`precedent`):
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
    'input_request.auto_resolved',
    'auto',
    { answer: input.answer, based_on: input.based_on },
    AUTO_APPROVAL_ACTOR.ref,
    resolveActor(input.actor, AUTO_APPROVAL_ACTOR),
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
 * payload of `input_request.answered` does not carry `job_id` — so that fact
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

/** One row of the per-node question count of an execution (t167). */
export interface QuestionsByNode {
  /** The node that asked; `null` groups the rows that never recorded one. */
  no_id: string | null;
  perguntas: number;
}

/** The same row, as `/v1` publishes it (t226, FR1). */
export interface WireQuestionsByNode {
  node_id: string | null;
  input_requests: number;
}

/** Per-node count to wire. */
export function toWireQuestionsByNode(row: QuestionsByNode): WireQuestionsByNode {
  return { node_id: row.no_id, input_requests: row.perguntas };
}

/**
 * How many questions each node raised, in one execution (t167).
 *
 * The counterpart of `metricsByVersion` (t102, FR17) on the other axis: that one
 * answers "did v2 behave better than v1?", this one answers "which step keeps
 * stopping to ask?" — which is the number a per-node escalation policy is judged
 * by. Without it, "this node asks too much" is an impression.
 *
 * A node with no question is simply absent: this counts what happened, and a row
 * of zeroes for every node of the graph would require reading the graph, which
 * this query deliberately does not do — it groups the questions that exist.
 *
 * Questions with no recorded node fall into a `null` group instead of vanishing,
 * exactly as `metricsByVersion` does with versionless jobs: a report that hides
 * what it cannot classify lies about the total.
 *
 * @param db Open handle.
 * @param executionId Execution to group.
 * @returns One row per node, in node order, with `null` last.
 */
export function questionsByNode(db: Database, executionId: number): QuestionsByNode[] {
  const rows = db
    .prepare(
      `SELECT no_id AS no_id, COUNT(*) AS perguntas
         FROM pergunta
        WHERE execucao_id = ?
        GROUP BY no_id`,
    )
    .all(executionId) as QuestionsByNode[];

  return rows.sort((a, b) => {
    if (a.no_id === null) return 1;
    if (b.no_id === null) return -1;
    return a.no_id.localeCompare(b.no_id);
  });
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
 * The field names below mirror the untouched migration columns; what leaves the
 * process is `toWirePrecedent`'s output (t226, FR1). `similaridade` is the one
 * computed field and follows its neighbours across that boundary too.
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

/** A precedent, as `/v1` publishes it (t226, FR1). */
export interface WirePrecedent {
  id: number;
  kind: string;
  question: string;
  answer: string | null;
  answered_by: string | null;
  source: string | null;
  created_at: string;
  answered_at: string | null;
  similarity: number;
}

/** Precedent to wire. */
export function toWirePrecedent(row: Precedent): WirePrecedent {
  return {
    id: row.id,
    kind: KIND_FIELD[row.tipo] ?? row.tipo,
    question: row.pergunta,
    answer: row.resposta,
    answered_by: row.respondido_por,
    source: row.origem === null ? null : (SOURCE_FIELD[row.origem] ?? row.origem),
    created_at: row.criada_em,
    answered_at: row.respondida_em,
    similarity: row.similaridade,
  };
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
