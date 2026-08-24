/**
 * Input-request routes (t102, FR13–FR16).
 *
 * The two ways of answering are SEPARATE routes on purpose (`/answer` and
 * `/auto-resolution`), and not one route with a `source` field: the distinction
 * between approved-by-a-person and approved-by-the-system is precisely the one
 * nobody should be able to erase by passing a different parameter.
 *
 * Same split as the job and session routes, spelled out in `routes/common.ts`:
 * a GET has returned English since t226 and the writes followed with t227,
 * because those bodies reach `validateEvent` and the event vocabulary is D20's
 * second child. Since t286 nothing translates on the way out either —
 * `repositories/input-request.ts` hands back the object `/v1` publishes.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Database } from '../db/connection.ts';
import { integerFromQuery } from '../repositories/common.ts';
import {
  autoResolveInputRequest,
  createInputRequest,
  getInputRequest,
  getPrecedents,
  inputRequestStatusColumn,
  listInputRequests,
  answerInputRequest,
} from '../repositories/input-request.ts';
import {
  withValidation,
  routeId,
  notFound,
  conflict,
  ERROR_RESPONSE_SCHEMA,
  OPEN_OBJECT_SCHEMA,
  type ErrorResponse,
} from './common.ts';

/**
 * Contract of `PATCH /input-requests/:id/answer` in the public document (t171,
 * FR4).
 *
 * The four statuses are the ones the handler already answers: `200` with the
 * projection, `404` from `notFound`, `409` from `refuseUnlessPending` and `400`
 * from `withValidation`.
 *
 * `id` is declared a STRING, and that is not a slip: on the wire a path segment
 * is text, and Fastify's ajv would happily coerce and then refuse one before
 * `routeId` ever ran — turning this route's own `{error, details}` refusal into
 * a differently-shaped `400` from the framework. Documenting the wire type
 * keeps the route's validation the only one there is (FR5).
 */
const ANSWER_SCHEMA = {
  params: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  body: OPEN_OBJECT_SCHEMA,
  response: {
    200: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    404: ERROR_RESPONSE_SCHEMA,
    409: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/**
 * Registers the input-request routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerInputRequests(app: FastifyInstance, db: Database): void {
  app.post('/input-requests', async (request, reply) =>
    withValidation(reply, () => {
      const inputRequest = createInputRequest(
        db,
        (request.body ?? {}) as Record<string, unknown>,
      );
      if (inputRequest === null) return notFound(reply, 'job');
      reply.code(201);
      return inputRequest;
    }),
  );

  /**
   * The door both ways of answering pass through: the input request has to exist
   * and still be PENDING (t149).
   *
   * Answering twice is not a harmless repeat. The second write would overwrite
   * `answer`/`source` — turning a decision taken by a person into one taken by
   * the system, which is exactly the distinction the two routes exist to keep —
   * append a contradictory second answer event, and unblock a job that may by
   * then be waiting on a DIFFERENT pending question, recreating the ask-forever
   * loop the block itself exists to prevent.
   *
   * @param reply Fastify reply, marked with the status when it refuses.
   * @param id Input-request id.
   * @returns The error body to return, or `null` when the route may proceed.
   */
  const refuseUnlessPending = (reply: FastifyReply, id: number): ErrorResponse | null => {
    const current = getInputRequest(db, id);
    if (current === null) return notFound(reply, 'input request');
    if (current.status !== 'pending') {
      return conflict(reply, `input request ${id} is already "${current.status}"`);
    }
    return null;
  };

  app.patch('/input-requests/:id/answer', { schema: ANSWER_SCHEMA }, async (request, reply) =>
    withValidation(reply, () => {
      const id = routeId(request.params);
      const refusal = refuseUnlessPending(reply, id);
      if (refusal !== null) return refusal;

      const inputRequest = answerInputRequest(
        db,
        id,
        (request.body ?? {}) as Record<string, unknown>,
      );
      return inputRequest === null ? notFound(reply, 'input request') : inputRequest;
    }),
  );

  app.patch('/input-requests/:id/auto-resolution', async (request, reply) =>
    withValidation(reply, () => {
      const id = routeId(request.params);
      const refusal = refuseUnlessPending(reply, id);
      if (refusal !== null) return refusal;

      const inputRequest = autoResolveInputRequest(
        db,
        id,
        (request.body ?? {}) as Record<string, unknown>,
      );
      return inputRequest === null ? notFound(reply, 'input request') : inputRequest;
    }),
  );

  app.get('/input-requests', async (request, reply) =>
    withValidation(reply, () => {
      const query = request.query as {
        status?: string;
        execution_id?: string;
        job_id?: string;
      };
      // A status nobody publishes is passed through rather than dropped: the
      // repository turns an unknown value into an empty result, which is the
      // honest answer, and swallowing the filter would widen the query instead.
      const status =
        query.status === undefined
          ? undefined
          : (inputRequestStatusColumn(query.status) ?? query.status);
      const executionId = integerFromQuery('execution_id', query.execution_id);
      const jobId = integerFromQuery('job_id', query.job_id);
      const found = listInputRequests(db, {
        status,
        execution_id: executionId,
        job_id: jobId,
      });
      return { input_requests: found };
    }),
  );

  // The precedent base is a route of its OWN, and not a field of
  // `GET /input-requests`: embedded in the listing it would cost a similarity
  // scan of every row against every answered row on every call, to serve
  // information that only matters when somebody opens ONE of them to answer it.
  app.get('/input-requests/:id/precedents', async (request, reply) =>
    withValidation(reply, () => {
      const query = request.query as { limit?: string };
      const limit = integerFromQuery('limit', query.limit);
      const found = getPrecedents(db, routeId(request.params), { limit });
      // An empty list is a legitimate response: "nobody asked this before" is a
      // fact about the project, not a failure of the query.
      return found === null ? notFound(reply, 'input request') : { precedents: found };
    }),
  );
}
