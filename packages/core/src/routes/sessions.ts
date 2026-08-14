/**
 * Session routes (t102, FR10–FR12).
 *
 * Who calls these routes is the runner (t103): it dispatches the CLI through the
 * EngineAdapter and reports the opening and the end to the control plane, which
 * is the only writer of the database (D1). The runner never opens SQLite.
 *
 * The request/response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { integerFromQuery } from '../repositories/common.ts';
import { openSession, finishSession, listSessions } from '../repositories/session.ts';
import { withValidation, routeId, notFound } from './common.ts';

/**
 * Registers the session routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerSessions(app: FastifyInstance, db: Database): void {
  app.post('/sessions', async (request, reply) =>
    withValidation(reply, () => {
      const session = openSession(db, (request.body ?? {}) as Record<string, unknown>);
      if (session === null) return notFound(reply, 'job');
      reply.code(201);
      return session;
    }),
  );

  app.patch('/sessions/:id/finish', async (request, reply) =>
    withValidation(reply, () => {
      const session = finishSession(
        db,
        routeId(request.params),
        (request.body ?? {}) as Record<string, unknown>,
      );
      return session ?? notFound(reply, 'session');
    }),
  );

  app.get('/sessions', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = integerFromQuery(
        'execucao_id',
        (request.query as { execucao_id?: string }).execucao_id,
      );
      return { sessoes: listSessions(db, { execucao_id: executionId }) };
    }),
  );
}
