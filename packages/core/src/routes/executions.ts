/**
 * Execution route (t102, FR17).
 *
 * There is no "execution" entity in this v1: `execucao_id` is an opaque INTEGER
 * grouper, and the taxonomy never listed it as a valid `entidade.tipo`
 * (`especificacoes/eventos/schemas/envelope.schema.json:41`). That is why there
 * is only a read here, and why an execution with no job at all answers 200 with
 * an empty list instead of a 404: there is no object to exist or not exist.
 *
 * The response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { metricsByVersion } from '../repositories/job.ts';
import { withValidation, routeId } from './common.ts';

/**
 * Registers the execution routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerExecutions(app: FastifyInstance, db: Database): void {
  app.get('/executions/:id/metrics-by-version', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = routeId(request.params);
      return { execucao_id: executionId, metricas: metricsByVersion(db, executionId) };
    }),
  );
}
