/**
 * Job routes (t102, FR4–FR9).
 *
 * The writes are plural sub-resources (`/transitions`, `/blocks`, `/unblocks`)
 * instead of a `PATCH` with a state field: each one corresponds to a distinct
 * FACT of the log, and one route per fact is what stops somebody from
 * "correcting" a job's position in the graph without leaving a trace. `PATCH` is
 * left only for what really is content editing (FR7).
 *
 * The request/response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
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
  transitionJob,
  type Job,
} from '../repositories/job.ts';
import { withValidation, routeId, notFound } from './common.ts';

/**
 * Registers the job routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerJobs(app: FastifyInstance, db: Database): void {
  app.post('/jobs', async (request, reply) =>
    withValidation(reply, () => {
      const job = createJob(db, (request.body ?? {}) as Record<string, unknown>);
      reply.code(201);
      return job;
    }),
  );

  app.get('/jobs', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = integerFromQuery(
        'execucao_id',
        (request.query as { execucao_id?: string }).execucao_id,
      );
      return { trabalhos: listJobs(db, { execucao_id: executionId }) };
    }),
  );

  app.get('/jobs/:id', async (request, reply) =>
    withValidation(reply, () => {
      const job = getJob(db, routeId(request.params));
      return job ?? notFound(reply, 'job');
    }),
  );

  app.get('/jobs/:id/events', async (request, reply) =>
    withValidation(reply, () => {
      const events = jobTimeline(db, routeId(request.params));
      return events === null ? notFound(reply, 'job') : { eventos: events };
    }),
  );

  /** The three writes that only change the projection of an existing job. */
  const write = (
    routePath: string,
    method: 'post' | 'patch',
    apply: (id: number, body: Record<string, unknown>) => Job | null,
  ): void => {
    app[method](routePath, async (request, reply) =>
      withValidation(reply, () => {
        const updated = apply(
          routeId(request.params),
          (request.body ?? {}) as Record<string, unknown>,
        );
        return updated ?? notFound(reply, 'job');
      }),
    );
  };

  write('/jobs/:id/transitions', 'post', (id, body) => transitionJob(db, id, body));
  write('/jobs/:id/blocks', 'post', (id, body) => blockJob(db, id, body));
  write('/jobs/:id/unblocks', 'post', (id, body) => unblockJob(db, id, body));
  write('/jobs/:id', 'patch', (id, body) => amendJob(db, id, body));
}
