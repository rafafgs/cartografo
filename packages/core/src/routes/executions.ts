/**
 * Execution route (t102, FR17).
 *
 * There is no "execution" TABLE in this v1: `execucao_id` is an opaque INTEGER
 * grouper. That is why there is only a read here, and why an execution with no
 * job at all answers 200 with zeros and an empty list instead of a 404 — there
 * is no row to exist or not exist, on any of the four routes below.
 *
 * The other half of what this header used to claim — that the taxonomy never
 * listed execution as a valid `entity.type` — was narrowed by D21 and is no
 * longer true. The round now IS the subject of one event,
 * `execution.finished`, because the control plane declaring a round over is a
 * fact only it can assert (D1) and a fact needs a subject. What did not change
 * is everything else: no table, no row, and the `finished_at` published below
 * derived from that event at read time (`repositories/job.ts`), never stored.
 *
 * The response field names are English since t226
 * (`docs/spec/glossario-wire.md` §1), and since t286 they are also the names the
 * two repositories hand back — nothing here translates on the way out. The
 * EVENTS inside `events` keep their own envelope, which is the taxonomy's and
 * therefore D20's second child.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { listEvents } from '../db/events.ts';
import { questionsByNode } from '../repositories/input-request.ts';
import {
  getExecution,
  listExecutions,
  metricsByVersion,
  nodeMetricsByVersion,
} from '../repositories/job.ts';
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
    withValidation(reply, () => {
      const found = listExecutions(db);
      return { executions: found };
    }),
  );

  /**
   * One round, for whoever already knows which one they are asking about
   * (t245, FR7).
   *
   * The same shape as a row of the list, `finished_at` included — and it exists
   * because the list is a discovery route: reading one round out of it means
   * fetching every round there is and filtering client-side, which is exactly
   * what the observer of D21's third child would be doing on every poll.
   *
   * No 404, like the two sub-routes below it: an id nobody wrote a job under is
   * a round with zero jobs, and zero jobs is never finished.
   */
  app.get('/executions/:id', async (request, reply) =>
    withValidation(reply, () => getExecution(db, routeId(request.params))),
  );

  /**
   * The round's numbers: per version, and per node.
   *
   * `input_requests_by_node` rides here rather than on a route of its own (t167)
   * because it is the same question the metrics answer, sliced on the other
   * axis — "which step keeps stopping to ask?" beside "did the new version
   * behave better?". Whoever is judging a per-node escalation policy reads both,
   * and two calls to compare two columns is a report split in half.
   *
   * Since t264 every `metrics[]` row also carries `nodes`: sessions, tokens and
   * agent time per node, under that version. It rides INSIDE the row rather
   * than beside it like `input_requests_by_node`, because unlike the questions
   * it is not a second slice of the round — it is the same slice one level
   * down, and a node's cost means nothing without the version it was paid
   * under. A version with no session at all gets an empty list, which is a
   * measurement; it never gets a missing key.
   *
   * The route keeps its name: what it groups by version did not change, and a
   * rename would break every client for an added field.
   */
  app.get('/executions/:id/metrics-by-version', async (request, reply) =>
    withValidation(reply, () => {
      const executionId = routeId(request.params);
      const metrics = metricsByVersion(db, executionId);
      const nodes = nodeMetricsByVersion(db, executionId);
      const byNode = questionsByNode(db, executionId);
      return {
        execution_id: executionId,
        metrics: metrics.map((row) => ({
          ...row,
          nodes: nodes.get(row.graph_version_id) ?? [],
        })),
        input_requests_by_node: byNode,
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
      return { execution_id: executionId, events: listEvents(db, { execution_id: executionId }) };
    }),
  );
}
