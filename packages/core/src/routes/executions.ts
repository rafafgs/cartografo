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
import { listEvents } from '../db/events.ts';
import { questionsByNode } from '../repositories/input-request.ts';
import { listExecutions, metricsByVersion } from '../repositories/job.ts';
import { withValidation, routeId } from './common.ts';

/**
 * Registers the execution routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerExecutions(app: FastifyInstance, db: Database): void {
  // The LIST is an aggregation over `trabalho`, not a table read (t107, FR1):
  // without it nobody discovers which executions exist without already knowing
  // the id.
  app.get('/executions', async (_request, reply) =>
    withValidation(reply, () => ({ execucoes: listExecutions(db) })),
  );

  /**
   * The round's numbers: per version, and per node.
   *
   * `perguntas_por_no` rides here rather than on a route of its own (t167)
   * because it is the same question the metrics answer, sliced on the other
   * axis — "which step keeps stopping to ask?" beside "did the new version
   * behave better?". Whoever is judging a per-node escalation policy reads both,
   * and two calls to compare two columns is a report split in half.
   *
   * The route keeps its name: what it groups by version did not change, and a
   * rename would break every client for an added field.
   */
  app.get('/executions/:id/metrics-by-version', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = routeId(request.params);
      return {
        execucao_id: executionId,
        metricas: metricsByVersion(db, executionId),
        perguntas_por_no: questionsByNode(db, executionId),
      };
    }),
  );

  /**
   * The whole log of the execution, in `id` order (t110, FR1).
   *
   * The per-job timeline (`GET /v1/jobs/:id/events`) and the per-version count
   * (the route above) already existed; what was missing was the ordered stream
   * of the WHOLE round, which is what lets one node be compared with another —
   * time per state, bottleneck, questions per node. A pure read: `evento` still
   * has a single writer (`src/db/events.ts`).
   *
   * No pagination on purpose: one execution of the PoC fits a response with room
   * to spare, and a cursor nobody needs is a contract to keep forever.
   */
  app.get('/executions/:id/events', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = routeId(request.params);
      return { execucao_id: executionId, eventos: listEvents(db, { execucao_id: executionId }) };
    }),
  );
}
