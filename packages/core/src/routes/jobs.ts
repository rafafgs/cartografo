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
import { integerFromQuery } from '../repositories/common.ts';
import {
  blockJob,
  getJob,
  createJob,
  unblockJob,
  amendJob,
  jobTimeline,
  listJobs,
  toWireJob,
  transitionJob,
  type Job,
} from '../repositories/job.ts';
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
