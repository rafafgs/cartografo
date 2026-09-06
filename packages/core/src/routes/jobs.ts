/**
 * Job routes (t102, FR4–FR9).
 *
 * The writes are plural sub-resources (`/transitions`, `/blocks`, `/unblocks`)
 * instead of a `PATCH` with a state field: each one corresponds to a distinct
 * FACT of the log, and one route per fact is what stops somebody from
 * "correcting" a job's position in the graph without leaving a trace. `PATCH` is
 * left only for what really is content editing (FR7).
 *
 * This family is where D20's split showed most plainly, and `routes/common.ts`
 * still tells the story: what a GET RETURNS went English with t226 and what the
 * four writes ACCEPT followed with t227, because those bodies go straight into
 * `validateEvent` and `job.created`'s contract belongs to D20's second child.
 * Since t286 nothing translates on the way out either — `repositories/job.ts`
 * hands back the object `/v1` publishes, so these handlers return it as it is.
 *
 * ## The scope, on the READS only (t410, D25)
 *
 * The four GETs resolve `project_id` before they touch the table, with the same
 * `requireProject` of `routes/common.ts` that `routes/graphs.ts` and
 * `routes/skills.ts` already call: absent means project 1, a project nobody
 * declared is a `404 unknown_project`, and a job of another project answers the
 * same `404 not_found` a nonexistent id gets. `job` has carried `project_id`
 * since migration `0003` and nothing read it back until then, which is why the
 * board of every project showed on one screen.
 *
 * The four WRITES below are deliberately left alone. Scoping a mutation is a
 * different risk — a wrong scope there refuses or misdirects a live transition
 * instead of merely widening a read — and it is the write-side slice of the
 * same split. `POST /jobs` is the one write this ticket touched, and not to
 * scope it: it already took `project_id` off its own body, and what changed is
 * that the graph version it names is now resolved in THAT project.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { buildConversation, type Conversation } from '../domain/conversation.ts';
import { buildNodeInput } from '../domain/context.ts';
import { integerFromQuery } from '../repositories/common.ts';
import { getVersion } from '../repositories/graphs.ts';
import { listInputRequests } from '../repositories/input-request.ts';
import {
  CrossProjectVersionReferenceError,
  GraphVersionNotReadyError,
  blockJob,
  getJob,
  createJob,
  jobContextSeed,
  jobTraversal,
  unblockJob,
  amendJob,
  jobTimeline,
  listJobs,
  transitionJob,
  type Job,
} from '../repositories/job.ts';
import { listSessions } from '../repositories/session.ts';
import {
  withValidation,
  refusal,
  requireProject,
  routeId,
  notFound,
  ERROR_RESPONSE_SCHEMA,
  OPEN_OBJECT_SCHEMA,
} from './common.ts';

/**
 * Contract of `POST /jobs` in the public document (t171, FR4; t283).
 *
 * The body schema is deliberately open so ajv refuses nothing `createJob`
 * accepts today, and `withValidation` stays the only judge of a BODY — it is
 * what turns a `ValidationError` into the `400`. The `409` is not a body
 * verdict at all: it is the state of the graph version the body names, which is
 * why it is caught around `withValidation` rather than inside it.
 */
const CREATE_JOB_SCHEMA = {
  body: OPEN_OBJECT_SCHEMA,
  response: {
    201: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    // t283: the body was fine and the version it names exists — what refuses is
    // that version's contract state, which is a conflict and not a bad request.
    409: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/**
 * The five reads behind `GET /jobs/:id/context` (t253, FR6; t270).
 *
 * The MERGE is `domain/context.ts`, pure and unit-tested without a server; what
 * lives here is only which rows feed it, which is a routing decision:
 *
 * - the job itself, for `input.job` and for the class's own field values;
 * - the version's snapshot, for the class's `project` object and for each
 *   node's `contract.produces`. A version that no longer resolves is read as no
 *   graph at all — the same posture `isAtFinalNode` and `requireFieldsOfNode`
 *   already take in `repositories/job.ts`;
 * - the job's COMPLETED sessions of this round. Only `completed`, because an
 *   incomplete session's report is not a fact about the graph, and only this
 *   round, because a previous execution's traversal is a different journey;
 * - the answered escalations of the job — the same set `buildSessionSpec`
 *   already fetches to render the prompt, now exposed structurally too;
 * - the job's own walk through the graph, off `job.transitioned` (t270). Fifth
 *   since this ficha, and a read of its own rather than a widening of the seed:
 *   it is a scan of the log, and the seed is a single row of a projection.
 *
 * A `null` walk means the job vanished between the seed and this read, which
 * cannot happen inside one request — the seed already confirmed it exists. It
 * degrades to "standing where it was born" rather than asserting, because a
 * total function is cheaper to reason about than one more invariant nobody can
 * see fail.
 *
 * ## Which of the five take the scope (t410, FR9)
 *
 * Three of them: the seed, the version and the traversal. `listSessions` and
 * `listInputRequests` do not, and it is not an omission — both are called with
 * a `job_id` the SEED has already confirmed belongs to the resolved project,
 * and neither table carries a `project_id` of its own (they inherit the
 * partition through that foreign key, `docs/spec/entities-versioning.md` §1).
 * A scope parameter there would be a second copy of a judgement already made.
 *
 * @param db Open database.
 * @param id Job id.
 * @param projectId Project the request resolved to.
 * @returns The assembled `input`, or `null` when the job does not exist in that
 *   project.
 */
function nodeInputOf(
  db: Database,
  id: number,
  projectId: number,
): Record<string, unknown> | null {
  const seed = jobContextSeed(db, id, projectId);
  if (seed === null) return null;

  const version =
    seed.graph_version_id === null
      ? undefined
      : getVersion(db, seed.graph_version_id, projectId);

  const sessions = listSessions(db, {
    job_id: id,
    ...(seed.execution_id === null ? {} : { execution_id: seed.execution_id }),
  });

  return buildNodeInput({
    job: seed.job,
    snapshot: version?.snapshot ?? null,
    outputs: sessions
      .filter((session) => session.status === 'completed')
      .map((session) => ({
        node_id: session.node_id,
        output: session.output,
        finished_at: session.finished_at,
        session_id: session.id,
      })),
    // The two keys of the literal are `AnsweredRequest`'s own, and they are the
    // skill manifest's frozen vocabulary (`domain/context.ts`) — a different
    // spelling that merely LOOKS like the two fields t286 renamed on the right.
    answered: listInputRequests(db, { status: 'answered', job_id: id }).map((request) => ({
      id: String(request.id),
      pergunta: request.question,
      resposta: request.answer ?? '',
    })),
    traversal: jobTraversal(db, id, projectId) ?? {
      nodes_visited: [],
      entered_at: seed.created_at,
    },
  });
}

/**
 * The four reads behind `GET /jobs/:id/conversation` (t360, FR5).
 *
 * Same division of labour as {@link nodeInputOf}: the MERGE is
 * `domain/conversation.ts`, pure and testable without a server, and what lives
 * here is only which rows feed it.
 *
 * - the job itself, for the scope check and for the terminal flag. It is the
 *   one read that can answer "this job is not yours", so it goes first and
 *   nothing below runs without it;
 * - the timeline, for the ORDER of the questions. `input_request.answered`
 *   carries no `job_id`, so the answers cannot come from here;
 * - both slices of the input-request queue, for the answers and for the one
 *   question still open;
 * - the job's sessions, for the draft and for whether one is running.
 *
 * ## Which of them take the scope
 *
 * Two: the job and the timeline. `listInputRequests` and `listSessions` do not,
 * for the reason `nodeInputOf` already writes down — both are called with a
 * `job_id` the job read has already confirmed belongs to the resolved project,
 * and a scope parameter there would be a second copy of a judgement already
 * made.
 *
 * @param db Open database.
 * @param id Job id.
 * @param projectId Project the request resolved to.
 * @returns The conversation, or `null` when the job does not exist in that
 *   project.
 */
function conversationOf(db: Database, id: number, projectId: number): Conversation | null {
  const job = getJob(db, id, projectId);
  if (job === null) return null;

  return buildConversation({
    events: jobTimeline(db, id, projectId) ?? [],
    answered: listInputRequests(db, { status: 'answered', job_id: id }),
    pending: listInputRequests(db, { status: 'pending', job_id: id }),
    sessions: listSessions(db, { job_id: id }),
    done: job.completed,
  });
}

/**
 * Registers the job routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerJobs(app: FastifyInstance, db: Database): void {
  app.post('/jobs', { schema: CREATE_JOB_SCHEMA }, async (request, reply) => {
    try {
      return await withValidation(reply, () => {
        const job = createJob(db, (request.body ?? {}) as Record<string, unknown>);
        reply.code(201);
        return job;
      });
    } catch (error) {
      // `withValidation` re-throws anything that is not a `ValidationError`, and
      // correctly so — neither of these is a verdict about the body. Both are
      // the same 409 in the same envelope, with their context as SIBLING
      // fields, so a client that reads one of the three codes reads all of them.
      //
      // The version resolves, but in another project (t410, FR7): the request
      // is reaching across a partition, which is a conflict and never a silent
      // accept. A hash that resolves in NO project is untouched by this branch
      // and stays the ungated free-text case of t283.
      if (error instanceof CrossProjectVersionReferenceError) {
        return refusal(reply, 409, error.code, error.message, {
          graph_version_id: error.graphVersionId,
          project_id: error.projectId,
        });
      }
      // The state refusal of t283: the report rides along because "why is it not
      // checked" is the actionable half — it names the pins to register.
      if (!(error instanceof GraphVersionNotReadyError)) throw error;
      return refusal(reply, 409, error.code, error.message, {
        graph_version_id: error.graphVersionId,
        contracts: error.contracts,
      });
    }
  });

  app.get('/jobs', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const executionId = integerFromQuery(
        'execution_id',
        (request.query as { execution_id?: string }).execution_id,
      );
      const found = listJobs(db, { execution_id: executionId }, scope.project.id);
      return { jobs: found };
    }),
  );

  app.get('/jobs/:id', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      // A job of another project answers the SAME `404` a nonexistent id gets
      // (t410, FR2): a boundary a client can tell apart from an absence is a
      // boundary that reports which ids are taken elsewhere.
      const job = getJob(db, routeId(request.params), scope.project.id);
      return job === null ? notFound(reply, 'job') : job;
    }),
  );

  /**
   * The `input` the job's current node resolves its placeholders against (t253).
   *
   * A GET and not a field of `GET /jobs/:id`: it is assembled out of four reads
   * and it is asked for exactly once per dispatch, by the runner — the same
   * reasoning `GET /sessions/:id/transcript` writes for the one other derived
   * payload of this API. The envelope key is `input` because that is the name
   * the manifest format gives it, and it is what `{{input.<path>}}` resolves
   * against.
   *
   * There is no 409 and no empty-answer case: a job with no graph, with no
   * completed session and with nothing answered projects an object with `job`,
   * an empty `project` and an empty `perguntas_respondidas` — which is the
   * honest answer, not a refusal. Only an id that names nothing is a 404.
   */
  app.get('/jobs/:id/context', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const input = nodeInputOf(db, routeId(request.params), scope.project.id);
      return input === null ? notFound(reply, 'job') : { input };
    }),
  );

  /**
   * The same job's escalations, read as the conversation they are (t360, FR5).
   *
   * A GET beside `/context` and for the same reason: it is assembled out of
   * four reads and it answers one page's whole question. What it is NOT is a
   * second door onto the input-request queue — `GET /v1/input-requests` still
   * owns that, spelling and all. This one is the interview's own shape: the
   * closed turns in log order, the one question still open, the draft the last
   * session reported, and whether anything is running.
   *
   * A job that never asked anything projects empty turns, a `null` pending and
   * a `null` draft — the honest answer for a job of any class at all, which is
   * why nothing here checks that the job is an interview. Only an id that names
   * nothing, or names a job of another project, is a 404.
   */
  app.get('/jobs/:id/conversation', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const conversation = conversationOf(db, routeId(request.params), scope.project.id);
      return conversation === null ? notFound(reply, 'job') : conversation;
    }),
  );

  app.get('/jobs/:id/events', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      // The envelope key is English; each event inside keeps its own shape, which
      // is the taxonomy's and therefore D20's second child.
      const events = jobTimeline(db, routeId(request.params), scope.project.id);
      return events === null ? notFound(reply, 'job') : { events };
    }),
  );

  /**
   * The four writes that only change the projection of an existing job.
   *
   * The amendment (`PATCH`) is the one route in the package that answers `422`
   * to an unusable body instead of `400` (t157, FR2): it edits CONTENT of an
   * entity that already exists, and the distinction between "I could not read
   * this request" and "I read it and the content is not acceptable" is worth
   * making where the content is the whole point. The `post` sub-resources keep
   * the `400` convention of every other route.
   */
  const write = (
    routePath: string,
    method: 'post' | 'patch',
    apply: (id: number, body: Record<string, unknown>) => Job | null,
  ): void => {
    app[method](routePath, async (request, reply) =>
      withValidation(
        reply,
        () => {
          const updated = apply(
            routeId(request.params),
            (request.body ?? {}) as Record<string, unknown>,
          );
          return updated === null ? notFound(reply, 'job') : updated;
        },
        method === 'patch' ? 422 : 400,
      ),
    );
  };

  write('/jobs/:id/transitions', 'post', (id, body) => transitionJob(db, id, body));
  write('/jobs/:id/blocks', 'post', (id, body) => blockJob(db, id, body));
  write('/jobs/:id/unblocks', 'post', (id, body) => unblockJob(db, id, body));
  write('/jobs/:id', 'patch', (id, body) => amendJob(db, id, body));
}
