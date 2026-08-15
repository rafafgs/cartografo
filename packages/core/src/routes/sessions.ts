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
import {
  openSession,
  finishSession,
  getSession,
  getSessionTranscript,
  listSessions,
  recordPermissionDenial,
} from '../repositories/session.ts';
import { withValidation, routeId, notFound, conflict } from './common.ts';

/**
 * Body ceiling of the finish route, in bytes (t159).
 *
 * Fastify's default is 1 MiB — the SAME number as `TRANSCRIPT_CAP_BYTES`. Left
 * alone, no transcript could ever reach the cap: the request would be refused
 * with a 413 before the handler ran, and the tail-keeping path would be dead
 * code. The server still caps what it stores at 1 MiB; this only decides how
 * much raw output it is willing to READ in order to cap it.
 *
 * Generous on purpose, and only on this route: a session that dies after
 * printing tens of megabytes of `stream-json` is exactly the session somebody
 * needs to diagnose, and a `/finish` refused for size would leave it open
 * forever — losing the ending as well as the output.
 */
const FINISH_BODY_LIMIT_BYTES = 32 * 1_048_576;

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

  // A session ends ONCE (t149). The retry of a `/finish` that already went
  // through would rewrite the terminal status and erase the `uso` reported the
  // first time — the only cost record the PoC keeps — so a session that is no
  // longer open is a 409, decided here, before the repository is called.
  app.patch('/sessions/:id/finish', { bodyLimit: FINISH_BODY_LIMIT_BYTES }, async (request, reply) =>
    withValidation(reply, () => {
      const id = routeId(request.params);
      const current = getSession(db, id);
      if (current === null) return notFound(reply, 'session');
      if (current.status !== 'aberta') {
        return conflict(reply, `session ${id} is already "${current.status}"`);
      }

      const session = finishSession(db, id, (request.body ?? {}) as Record<string, unknown>);
      return session ?? notFound(reply, 'session');
    }),
  );

  // 200 and not 201: what this appends is an event, and the body that comes
  // back is the session — unchanged, because a denial does not move it (t125).
  app.post('/sessions/:id/permission-denials', async (request, reply) =>
    withValidation(reply, () => {
      const session = recordPermissionDenial(
        db,
        routeId(request.params),
        (request.body ?? {}) as Record<string, unknown>,
      );
      return session ?? notFound(reply, 'session');
    }),
  );

  // The raw output the session printed (t159). A session with nothing recorded
  // — still open, or finished before the transcript existed — answers 200 with
  // an empty payload: "no transcript" is an answer, and only an unknown id is a
  // 404. It is a GET like any other, which is what lets the screen link it
  // straight through the verbatim `/v1/*` proxy without a route of its own (D11).
  app.get('/sessions/:id/transcript', async (request, reply) =>
    withValidation(reply, () => {
      const transcript = getSessionTranscript(db, routeId(request.params));
      return transcript ?? notFound(reply, 'session');
    }),
  );

  app.get('/sessions', async (request, reply) =>
    withValidation(reply, () => {
      const query = request.query as { execucao_id?: string; trabalho_id?: string };
      return {
        sessoes: listSessions(db, {
          execucao_id: integerFromQuery('execucao_id', query.execucao_id),
          trabalho_id: integerFromQuery('trabalho_id', query.trabalho_id),
        }),
      };
    }),
  );
}
