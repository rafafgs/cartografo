/**
 * Input-request repository — human escalation as a first-class entity.
 *
 * A question and an approval are the same animal; the `kind` column is the only
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
 * The TABLE and its columns are English since D20's fourth child (t229), the
 * stored VALUES since its fifth (t235) and the event-type strings since its
 * second (t227). {@link InputRequest} is English too, and is the object `/v1`
 * publishes: t286 deleted the alias-and-translate layer between the two. Unlike
 * the job and the session, this table has no column the glossary left behind —
 * every field here is the column, read under its own name.
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
  job_id: number;
  session_id: number | null;
  execution_id: number | null;
  /**
   * The node the owning job was standing on when it asked (t167).
   *
   * `null` is ordinary and never a defect: a row written before the column
   * existed, or a job with no position at all. It is stamped by the server from
   * the job, never by the caller — a question that declared its own node would
   * be a question able to lie about where the work was.
   */
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
   * Both the key and the value went English with t227 and t235
   * (`glossario-wire.md` §4.2 and §1.6); the column's own `CHECK` now spells the
   * same two words, so this field is the column, passed through.
   */
  source: string | null;
  created_at: string;
  answered_at: string | null;
}

interface InputRequestRow extends Omit<InputRequest, 'options' | 'auto_approvable'> {
  /** JSON in a TEXT column, like `session.usage` and `job.criterios_de_aceite`. */
  options: string | null;
  auto_approvable: number;
}

/** The columns {@link InputRequestRow} is made of, each under its own name (t286). */
const COLUMNS = `
  id, job_id, session_id, execution_id,
  node_id, kind, question, context,
  options, recommendation,
  default_answer, auto_approvable, status,
  answer, answered_by, source,
  created_at, answered_at
`;

function toInputRequest(row: InputRequestRow): InputRequest {
  return {
    ...row,
    options: jsonOrNull<string[]>(row.options),
    auto_approvable: asBoolean(row.auto_approvable),
  };
}

/**
 * The two statuses a `?status=` filter may name (`glossario-wire.md` §1.6).
 *
 * There were three maps here — status, kind and source — and D20's fifth child
 * (t235) retired all three by rewriting migration `0003`: the column's `CHECK`
 * now reads `('question','approval')` and `('user','auto')`, and `status`
 * defaults to `pending`. What is left is this list, which validates a filter
 * rather than converting one.
 *
 * The `kind` values are the reason the glossary QUALIFIES one of its §1.6 rows:
 * the bare word `pergunta` was the ENTITY and became `input_request`, while
 * `pergunta.tipo = pergunta` is the KIND of escalation and became `question`.
 * One word, two concepts, two English names — which is exactly what a glossary
 * exists to keep straight.
 */
export const INPUT_REQUEST_STATUSES: readonly string[] = Object.freeze(['pending', 'answered']);

/**
 * The `status` a request declared, if the column can hold it.
 *
 * @param value What the query string said.
 * @returns The same word, or `undefined` when the column has no such state.
 */
export function inputRequestStatusColumn(value: string): string | undefined {
  return INPUT_REQUEST_STATUSES.find((status) => status === value);
}

function readRow(db: Database, id: number): InputRequestRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM input_request WHERE id = ?`).get(id) as
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
  // `current_node_id` rides along with `project_id`/`execution_id` — one lookup,
  // one trust boundary: everything an input request says about its owner comes
  // from the owner's row, and nothing from the body (t167).
  const owner = db
    .prepare(
      `SELECT project_id, execution_id, current_node_id
         FROM job WHERE id = ?`,
    )
    .get(jobId) as
    | { project_id: number; execution_id: number | null; current_node_id: string | null }
    | undefined;
  if (owner === undefined) return null;

  // A job with no position is recorded as having none. The column is NOT NULL,
  // so this only happens for a row that never got a real node — and the entry
  // node would be exactly the guess this stays away from.
  const nodeId =
    typeof owner.current_node_id === 'string' && owner.current_node_id !== ''
      ? owner.current_node_id
      : null;

  const options = data.options as string[] | null;
  const actor = resolveActor(input.actor, API_ACTOR);

  const create = db.transaction((): InputRequest => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO input_request (
           job_id, session_id, execution_id, node_id, kind, question, context,
           options, recommendation, default_answer, auto_approvable, status, answer,
           answered_by, source, created_at, answered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        jobId,
        data.session_id as number | null,
        owner.execution_id,
        nodeId,
        data.kind as string,
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
      project_id: owner.project_id,
      execution_id: owner.execution_id,
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
 * human and the automatic gate are the event type, the projection's `source` and
 * the actor.
 *
 * The unblock reuses the SAME actor as the answer event — `user` when a person
 * answered, the gate when it was automatic. The taxonomy asks for this explicitly
 * on `job.unblocked`, and it is what stops the audit from concluding that
 * "the system" unblocked everything a human unblocked.
 *
 * Closing is exactly-once: the `UPDATE` is guarded by `status = 'pending'` and a
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
  /** The COLUMN's value; its `CHECK` spells both of them the wire's way (t235). */
  origin: 'user' | 'auto',
  raw: Record<string, unknown>,
  answeredBy: string | null,
  actor: Actor,
): InputRequest | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData(type, raw);

  const owner = db
    .prepare('SELECT project_id FROM job WHERE id = ?')
    .get(row.job_id) as { project_id: number } | undefined;

  const close = db.transaction((): InputRequest => {
    const timestamp = now();
    const effect = db
      .prepare(
        `UPDATE input_request
            SET status = 'answered', answer = ?, answered_by = ?, source = ?,
                answered_at = ?
          WHERE id = ? AND status = 'pending'`,
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
      project_id: owner?.project_id ?? DEFAULT_PROJECT,
      execution_id: row.execution_id,
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
    unblockJob(db, row.job_id, { actor });

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
    'user',
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
  filter: { status?: string; execution_id?: number; job_id?: number } = {},
): InputRequest[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.status !== undefined) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.execution_id !== undefined) {
    conditions.push('execution_id = ?');
    values.push(filter.execution_id);
  }
  if (filter.job_id !== undefined) {
    conditions.push('job_id = ?');
    values.push(filter.job_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM input_request ${where} ORDER BY id`)
    .all(...values) as InputRequestRow[];
  return rows.map(toInputRequest);
}

/** One row of the per-node question count of an execution (t167). */
export interface QuestionsByNode {
  /** The node that asked; `null` groups the rows that never recorded one. */
  node_id: string | null;
  input_requests: number;
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
      `SELECT node_id, COUNT(*) AS input_requests
         FROM input_request
        WHERE execution_id = ?
        GROUP BY node_id`,
    )
    .all(executionId) as QuestionsByNode[];

  return rows.sort((a, b) => {
    if (a.node_id === null) return 1;
    if (b.node_id === null) return -1;
    return a.node_id.localeCompare(b.node_id);
  });
}

/**
 * A precedent: an already-answered input request of the same project, together
 * with how much it looks like the one being queried.
 *
 * It carries the DECISION (`answer`) and where that decision came from
 * (`source`, `answered_by`, `answered_at`), because that is what whoever is
 * answering right now needs to see: knowing that something similar was asked
 * before is not enough — one has to know what was decided, by whom and when.
 *
 * The field names below are {@link InputRequest}'s, which are the columns'
 * (t286); `similarity` is the one computed field, and is named after the
 * function that computes it rather than after any column.
 */
export interface Precedent {
  id: number;
  kind: string;
  question: string;
  answer: string | null;
  answered_by: string | null;
  source: string | null;
  created_at: string;
  answered_at: string | null;
  /** Score in `[0, 1]`, rounded to 2 decimals — see `domain/similarity.ts`. */
  similarity: number;
}

type PrecedentRow = Omit<Precedent, 'similarity'>;

/** How many precedents come back when the caller does not say. */
const DEFAULT_PRECEDENT_LIMIT = 5;

/** Ceiling of `limite`: the route clamps, it does not refuse (size knob, not rule). */
const MAXIMUM_PRECEDENT_LIMIT = 20;

const PRECEDENT_COLUMNS = `
  p.id, p.kind, p.question, p.answer,
  p.answered_by, p.source,
  p.created_at, p.answered_at
`;

/** Two decimals: the score is there to be READ and compared, not computed on. */
function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

/**
 * The already-answered input requests of the same project that most look like
 * the one at `:id` (t113).
 *
 * The slice is the project of whoever is asking — `project_id` arrives through
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
  const owner = db
    .prepare('SELECT project_id FROM job WHERE id = ?')
    .get(target.job_id) as { project_id: number } | undefined;
  if (owner === undefined) return [];

  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_PRECEDENT_LIMIT, 1),
    MAXIMUM_PRECEDENT_LIMIT,
  );

  const candidates = db
    .prepare(
      `SELECT ${PRECEDENT_COLUMNS}
         FROM input_request p
         JOIN job t ON t.id = p.job_id
        WHERE p.status = 'answered'
          AND p.id <> ?
          AND t.project_id = ?`,
    )
    .all(id, owner.project_id) as PrecedentRow[];

  // A tie on score goes to the MOST RECENT decision: when two old decisions look
  // equally like today's, the last one is the one that stands. The timestamps are
  // ISO 8601, so lexicographic order is chronological order.
  const mostRecent = (a: PrecedentRow, b: PrecedentRow): number =>
    (b.answered_at ?? '').localeCompare(a.answered_at ?? '');

  return candidates
    .map((row) => ({ row, score: similarity(target.question, row.question) }))
    .filter((pair) => pair.score > 0)
    .sort((a, b) => b.score - a.score || mostRecent(a.row, b.row))
    .slice(0, limit)
    .map(({ row, score }) => ({ ...row, similarity: roundScore(score) }));
}
