/**
 * `GET /health` — infrastructure probe of the control plane.
 *
 * It sits OUTSIDE the `/v1` prefix on purpose (FR10): whoever checks health is a
 * process supervisor, an orchestrator or a startup script, and none of them
 * should have to track the version of the business API.
 *
 * The `db` field is the result of a real `SELECT 1` — the route answers 503 when
 * the database does not answer, so that a supervisor can tell "process alive"
 * from "process useful".
 *
 * The response values (`ok`/`erro`) are the wire contract of the probe, pinned
 * byte for byte by the acceptance test, and stay as they are (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import { checkDatabase, type Database } from '../db/connection.ts';

/** Body of the `/health` response. Key order is part of the contract. */
export interface HealthResponse {
  status: 'ok' | 'erro';
  db: 'ok' | 'erro';
}

/**
 * Declared response schema (D9: an explicit contract on every route). Besides
 * documenting, it is what fixes the key order in the serialization — the
 * acceptance test compares the body byte for byte.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    db: { type: 'string' },
  },
  required: ['status', 'db'],
  additionalProperties: false,
} as const;

/**
 * Registers `GET /health` on the given instance.
 *
 * @param app Fastify instance (the root, not the `/v1` scope).
 * @param db Already open database, of which the route only uses the health check.
 */
export function registerHealth(app: FastifyInstance, db: Database): void {
  app.get(
    '/health',
    { schema: { response: { 200: RESPONSE_SCHEMA, 503: RESPONSE_SCHEMA } } },
    async (_request, reply): Promise<HealthResponse> => {
      const database = checkDatabase(db);
      reply.code(database === 'ok' ? 200 : 503);
      return { status: database === 'ok' ? 'ok' : 'erro', db: database };
    },
  );
}
