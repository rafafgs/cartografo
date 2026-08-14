/**
 * Input-request routes (t102, FR13–FR16).
 *
 * The two ways of answering are SEPARATE routes on purpose (`/answer` and
 * `/auto-resolution`), and not one route with an `origem` field: the distinction
 * between approved-by-a-person and approved-by-the-system is precisely the one
 * nobody should be able to erase by passing a different parameter.
 *
 * The request/response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { integerFromQuery } from '../repositories/common.ts';
import {
  autoResolveInputRequest,
  createInputRequest,
  getPrecedents,
  listInputRequests,
  answerInputRequest,
} from '../repositories/input-request.ts';
import { withValidation, routeId, notFound } from './common.ts';

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

  app.patch('/input-requests/:id/answer', async (request, reply) =>
    withValidation(reply, () => {
      const inputRequest = answerInputRequest(
        db,
        routeId(request.params),
        (request.body ?? {}) as Record<string, unknown>,
      );
      return inputRequest ?? notFound(reply, 'input request');
    }),
  );

  app.patch('/input-requests/:id/auto-resolution', async (request, reply) =>
    withValidation(reply, () => {
      const inputRequest = autoResolveInputRequest(
        db,
        routeId(request.params),
        (request.body ?? {}) as Record<string, unknown>,
      );
      return inputRequest ?? notFound(reply, 'input request');
    }),
  );

  app.get('/input-requests', async (request, reply) =>
    withValidation(reply, () => {
      const query = request.query as {
        status?: string;
        execucao_id?: string;
        trabalho_id?: string;
      };
      return {
        perguntas: listInputRequests(db, {
          status: query.status,
          execucao_id: integerFromQuery('execucao_id', query.execucao_id),
          trabalho_id: integerFromQuery('trabalho_id', query.trabalho_id),
        }),
      };
    }),
  );

  // The precedent base is a route of its OWN, and not a field of
  // `GET /input-requests`: embedded in the listing it would cost a similarity
  // scan of every row against every answered row on every call, to serve
  // information that only matters when somebody opens ONE of them to answer it.
  app.get('/input-requests/:id/precedents', async (request, reply) =>
    withValidation(reply, () => {
      const query = request.query as { limite?: string };
      const precedents = getPrecedents(db, routeId(request.params), {
        limit: integerFromQuery('limite', query.limite),
      });
      // An empty list is a legitimate response: "nobody asked this before" is a
      // fact about the project, not a failure of the query.
      return precedents === null ? notFound(reply, 'input request') : { precedentes: precedents };
    }),
  );
}
