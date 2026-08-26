/**
 * The flow lens: one execution's event log folded into time per node (t110,
 * FR3/FR4).
 *
 * This module is the half of the surveyor that no agent touches. It reads the
 * append-only log of a whole execution (`GET /v1/executions/:id/events`) and
 * answers four questions per node — how long agents were busy on it, how long
 * work sat blocked on it, how long work waited in the dispatch queue for it,
 * and how many questions it escalated — then names the worst one.
 *
 * Computing this here instead of asking the session for it is the point of the
 * whole ticket: the evidence a proposal carries has to be traceable to numbers
 * in the log BY CONSTRUCTION, not by an agent's recall. The agent gets exactly
 * one job later (choosing the `operacoes`), and it gets these numbers as input.
 *
 * Three rules the fold obeys, each of them load-bearing:
 *
 * - **Order is `id`, never `occurred_at`.** Two events can carry the same
 *   timestamp; only the server-assigned id is a total ordering. Same rule as
 *   `specs/events/reducers/reconstruct-state.mjs`.
 * - **The node a work sat on is reconstructed from the log**, by folding
 *   `job.created` and `job.transitioned` — the projection only knows
 *   where the work is NOW, and "where was it when it blocked?" is a question
 *   about the past.
 * - **What cannot be attributed is not counted.** A question with no session, a
 *   session on a node the graph no longer has, an interval that runs backwards:
 *   all dropped. A number invented to avoid a gap is worse than the gap.
 *
 * Pure: no HTTP, no clock, no filesystem. Its only input is the log and the
 * node ids of the graph version that ran.
 *
 * English per D18, the metric names of {@link NodeMetric} included since t264.
 * They are payload keys of `proposal.evidence` and land in the book that way, so
 * a glossary row is exactly what they needed — `docs/spec/glossary-wire.md`
 * §5.6 now carries one for each. t227 did leave them alone on purpose, and that
 * purpose expired when t255 migrated the sibling lens (§5.5): two lenses writing
 * two languages into the same column is the one outcome D20 exists to prevent.
 * The EVENT vocabulary this fold reads has been English since t227.
 */

/** One envelope of the log, reduced to what the fold reads. */
export interface FlowEvent {
  id: number;
  type: string;
  entity: { type: string; id: number | string };
  occurred_at: string;
  data: Record<string, unknown>;
}

/** What one node cost in one execution. */
export interface NodeMetric {
  node_id: string;
  /** Sum of `session.opened` → `session.finished` for sessions on this node. */
  agent_ms: number;
  /** Sum of `job.blocked` → `job.unblocked`, attributed to the node the work sat on. */
  blocked_ms: number;
  /** Sum of `job.transitioned` → the next `session.opened` for the same work and node. */
  queue_ms: number;
  /** The three above. It is what the ranking sorts by. */
  total_ms: number;
  /** `input_request.created` events whose session ran on this node. */
  input_requests: number;
  /** The ids of the events every number above was computed from, ascending. */
  event_ids: number[];
}

/** The ranking, plus the node at the top of it. */
export interface FlowMetrics {
  /** Every node of the graph, worst total first, ties broken by node id. */
  by_node: NodeMetric[];
  /** The worst node, or `null` when nothing in this run cost any time. */
  gargalo: NodeMetric | null;
}

/** Mutable accumulator of one node, before it becomes a `NodeMetric`. */
interface Accumulator {
  node_id: string;
  agent_ms: number;
  blocked_ms: number;
  queue_ms: number;
  input_requests: number;
  event_ids: Set<number>;
}

/** A session, from `session.opened` until its `session.finished` shows up. */
interface OpenSession {
  node_id: string | null;
  trabalho_id: number | null;
  openedAt: number;
  event: number;
}

/** An interval that started and is waiting for the event that closes it. */
interface PendingInterval {
  node_id: string;
  since: number;
  event: number;
}

const asText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

/** Milliseconds of an ISO instant, or `null` when it cannot be read. */
function instantOf(event: FlowEvent): number | null {
  const stamp = Date.parse(event.occurred_at);
  return Number.isNaN(stamp) ? null : stamp;
}

/** The entity id as an integer; `job`, `session` and `input_request` all use one. */
function entityId(event: FlowEvent): number | null {
  const value = Number(event.entity.id);
  return Number.isInteger(value) ? value : null;
}

/**
 * Folds an execution's log into per-node metrics and picks the bottleneck.
 *
 * @param events The execution's events, in any order — they are sorted by id
 *   here, so a paginated or out-of-order read reaches the same numbers.
 * @param nodeIds Node ids of the graph version the execution ran under. Only
 *   these are reported; telemetry of a node the graph no longer has is dropped
 *   rather than attributed to something else.
 * @returns The ranking and the worst node, or `gargalo: null` when every total
 *   is zero — "nothing to propose" is a valid outcome, not an error.
 */
export function calculateFlowMetrics(
  events: readonly FlowEvent[],
  nodeIds: readonly string[],
): FlowMetrics {
  const accumulators = new Map<string, Accumulator>();
  for (const nodeId of nodeIds) {
    if (accumulators.has(nodeId)) continue;
    accumulators.set(nodeId, {
      node_id: nodeId,
      agent_ms: 0,
      blocked_ms: 0,
      queue_ms: 0,
      input_requests: 0,
      event_ids: new Set<number>(),
    });
  }

  /** Adds an interval to a node, ignoring what the graph does not have. */
  const add = (
    nodeId: string | null,
    field: 'agent_ms' | 'blocked_ms' | 'queue_ms',
    ms: number,
    from: readonly number[],
  ): void => {
    const accumulator = nodeId === null ? undefined : accumulators.get(nodeId);
    if (accumulator === undefined) return;
    // An interval that runs backwards is a clock disagreement, not negative
    // time: `occurred_at` is not a total ordering, and subtracting here would
    // let one bad timestamp erase a real cost.
    accumulator[field] += Math.max(0, ms);
    for (const id of from) accumulator.event_ids.add(id);
  };

  const currentNode = new Map<number, string>();
  const queued = new Map<number, PendingInterval>();
  const blocked = new Map<number, PendingInterval>();
  const sessions = new Map<number, OpenSession>();

  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    const when = instantOf(event);
    const entity = entityId(event);
    if (when === null || entity === null) continue;

    switch (event.type) {
      case 'job.created': {
        const entryNode = asText(event.data.entry_node_id);
        if (entryNode !== null) currentNode.set(entity, entryNode);
        break;
      }

      case 'job.transitioned': {
        const target = asText(event.data.to_node_id);
        if (target === null) break;
        currentNode.set(entity, target);
        // Landing on a node starts the dispatch clock. A previous landing that
        // never got a session is overwritten: the work left without one, and
        // there is no queue time to charge anyone.
        queued.set(entity, { node_id: target, since: when, event: event.id });
        break;
      }

      case 'job.blocked': {
        const where = currentNode.get(entity);
        if (where === undefined) break;
        blocked.set(entity, { node_id: where, since: when, event: event.id });
        break;
      }

      case 'job.unblocked': {
        const wait = blocked.get(entity);
        if (wait === undefined) break;
        blocked.delete(entity);
        add(wait.node_id, 'blocked_ms', when - wait.since, [wait.event, event.id]);
        break;
      }

      case 'session.opened': {
        const node_id = asText(event.data.node_id);
        const trabalho_id = asInteger(event.data.job_id);
        sessions.set(entity, { node_id, trabalho_id, openedAt: when, event: event.id });

        if (trabalho_id === null || node_id === null) break;
        const queue = queued.get(trabalho_id);
        // Only the session that opens ON THE NODE the work landed on closes the
        // queue interval; anything else is a different node's business.
        if (queue === undefined || queue.node_id !== node_id) break;
        queued.delete(trabalho_id);
        add(node_id, 'queue_ms', when - queue.since, [queue.event, event.id]);
        break;
      }

      case 'session.finished': {
        const session = sessions.get(entity);
        if (session === undefined) break;
        add(session.node_id, 'agent_ms', when - session.openedAt, [
          session.event,
          event.id,
        ]);
        break;
      }

      case 'input_request.created': {
        // The node comes from the session that asked. A question with no
        // session (`sessao_id: null` is allowed by the taxonomy) belongs to no
        // node, and guessing one would be inventing a number.
        const sessionId = asInteger(event.data.session_id);
        const session = sessionId === null ? undefined : sessions.get(sessionId);
        const accumulator =
          session?.node_id === undefined || session.node_id === null
            ? undefined
            : accumulators.get(session.node_id);
        if (accumulator === undefined) break;
        accumulator.input_requests += 1;
        accumulator.event_ids.add(event.id);
        break;
      }

      default:
        break;
    }
  }

  const ranking = [...accumulators.values()]
    .map((accumulator) => ({
      node_id: accumulator.node_id,
      agent_ms: accumulator.agent_ms,
      blocked_ms: accumulator.blocked_ms,
      queue_ms: accumulator.queue_ms,
      total_ms:
        accumulator.agent_ms + accumulator.blocked_ms + accumulator.queue_ms,
      input_requests: accumulator.input_requests,
      event_ids: [...accumulator.event_ids].sort((a, b) => a - b),
    }))
    // Ties broken by node id so the ranking is a function of the log alone —
    // two runs with the same numbers must name the same bottleneck.
    .sort((a, b) => b.total_ms - a.total_ms || (a.node_id < b.node_id ? -1 : 1));

  const worst = ranking[0];
  return {
    by_node: ranking,
    gargalo: worst !== undefined && worst.total_ms > 0 ? worst : null,
  };
}
