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
 * still tells the story: what a GET RETURNS went English with t226
 * (`repositories/job.ts`'s `toWireJob`), and what the four writes ACCEPT
 * followed with t227, because those bodies go straight into `validateEvent`
 * and `job.created`'s contract belongs to D20's second child.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { buildNodeInput } from '../domain/context.ts';
import { integerFromQuery } from '../repositories/common.ts';
import { getVersion } from '../repositories/graphs.ts';
import { listInputRequests } from '../repositories/input-request.ts';
import {
  blockJob,
  getJob,
  createJob,
  jobContextSeed,
  jobTraversal,
  unblockJob,
  amendJob,
  jobTimeline,
  listJobs,
  toWireJob,
  transitionJob,
  type Job,
} from '../repositories/job.ts';
import { listSessions } from '../repositories/session.ts';
import {
  withValidation,
  routeId,
  notFound,
  ERROR_RESPONSE_SCHEMA,
  OPEN_OBJECT_SCHEMA,
} from './common.ts';

/**
 * Contract of `POST /jobs` in the public document (t171, FR4).
 *
 * The two statuses are the ones this handler already answers, and nothing here
 * changes either of them: the body schema is deliberately open so ajv refuses
 * nothing `createJob` accepts today, and `withValidation` stays the only judge
 * of a body — it is what turns a `ValidationError` into the `400` below.
 */
const CREATE_JOB_SCHEMA = {
  body: OPEN_OBJECT_SCHEMA,
  response: {
    201: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
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
 * @param db Open database.
 * @param id Job id.
 * @returns The assembled `input`, or `null` when the job does not exist.
 */
function nodeInputOf(db: Database, id: number): Record<string, unknown> | null {
  const seed = jobContextSeed(db, id);
  if (seed === null) return null;

  const version =
    seed.grafo_versao_id === null ? undefined : getVersion(db, seed.grafo_versao_id);

  const sessions = listSessions(db, {
    trabalho_id: id,
    ...(seed.execucao_id === null ? {} : { execucao_id: seed.execucao_id }),
  });

  return buildNodeInput({
    job: seed.job,
    snapshot: version?.snapshot ?? null,
    outputs: sessions
      .filter((session) => session.status === 'completed')
      .map((session) => ({
        node_id: session.no_id,
        output: session.saida,
        finished_at: session.finalizada_em,
        session_id: session.id,
      })),
    answered: listInputRequests(db, { status: 'answered', trabalho_id: id }).map((request) => ({
      id: String(request.id),
      pergunta: request.pergunta,
      resposta: request.resposta ?? '',
    })),
    traversal: jobTraversal(db, id) ?? { nodes_visited: [], entered_at: seed.criado_em },
  });
}

/**
 * Registers the job routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerJobs(app: FastifyInstance, db: Database): void {
  app.post('/jobs', { schema: CREATE_JOB_SCHEMA }, async (request, reply) =>
    withValidation(reply, () => {
      const job = createJob(db, (request.body ?? {}) as Record<string, unknown>);
      reply.code(201);
      return toWireJob(job);
    }),
  );

  app.get('/jobs', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = integerFromQuery(
        'execution_id',
        (request.query as { execution_id?: string }).execution_id,
      );
      const jobs = listJobs(db, { execucao_id: executionId });
      return { jobs: jobs.map(toWireJob) };
    }),
  );

  app.get('/jobs/:id', async (request, reply) =>
    withValidation(reply, () => {
      const job = getJob(db, routeId(request.params));
      return job === null ? notFound(reply, 'job') : toWireJob(job);
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
      const input = nodeInputOf(db, routeId(request.params));
      return input === null ? notFound(reply, 'job') : { input };
    }),
  );

  app.get('/jobs/:id/events', async (request, reply) =>
    withValidation(reply, () => {
      // The envelope key is English; each event inside keeps its own shape, which
      // is the taxonomy's and therefore D20's second child.
      const events = jobTimeline(db, routeId(request.params));
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
          return updated === null ? notFound(reply, 'job') : toWireJob(updated);
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
