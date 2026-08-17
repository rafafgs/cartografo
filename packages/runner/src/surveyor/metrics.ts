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
 *   `especificacoes/eventos/reducers/reconstruir-estado.mjs`.
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
 * English per D18; the metric names of {@link NodeMetric} stay in Portuguese
 * because they are payload keys of `proposta.evidencia` and land in the book
 * that way — no glossary row governs them, and t227 left them alone on purpose.
 * The EVENT vocabulary this fold reads is English since that ticket.
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
  no_id: string;
  /** Sum of `session.opened` → `session.finished` for sessions on this node. */
  tempo_agente_ms: number;
  /** Sum of `job.blocked` → `job.unblocked`, attributed to the node the work sat on. */
  tempo_espera_ms: number;
  /** Sum of `job.transitioned` → the next `session.opened` for the same work and node. */
  tempo_fila_ms: number;
  /** The three above. It is what the ranking sorts by. */
  total_ms: number;
  /** `input_request.created` events whose session ran on this node. */
  perguntas: number;
  /** The ids of the events every number above was computed from, ascending. */
  eventos: number[];
}

/** The ranking, plus the node at the top of it. */
export interface FlowMetrics {
  /** Every node of the graph, worst total first, ties broken by node id. */
  por_no: NodeMetric[];
  /** The worst node, or `null` when nothing in this run cost any time. */
  gargalo: NodeMetric | null;
}

/** Mutable accumulator of one node, before it becomes a `NodeMetric`. */
interface Accumulator {
  no_id: string;
  tempo_agente_ms: number;
  tempo_espera_ms: number;
  tempo_fila_ms: number;
  perguntas: number;
  eventos: Set<number>;
}

/** A session, from `session.opened` until its `session.finished` shows up. */
interface OpenSession {
  no_id: string | null;
  trabalho_id: number | null;
  openedAt: number;
  event: number;
}

/** An interval that started and is waiting for the event that closes it. */
interface PendingInterval {
  no_id: string;
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
      no_id: nodeId,
      tempo_agente_ms: 0,
      tempo_espera_ms: 0,
      tempo_fila_ms: 0,
      perguntas: 0,
      eventos: new Set<number>(),
    });
  }

  /** Adds an interval to a node, ignoring what the graph does not have. */
  const add = (
    nodeId: string | null,
    field: 'tempo_agente_ms' | 'tempo_espera_ms' | 'tempo_fila_ms',
    ms: number,
    from: readonly number[],
  ): void => {
    const accumulator = nodeId === null ? undefined : accumulators.get(nodeId);
    if (accumulator === undefined) return;
    // An interval that runs backwards is a clock disagreement, not negative
    // time: `occurred_at` is not a total ordering, and subtracting here would
    // let one bad timestamp erase a real cost.
    accumulator[field] += Math.max(0, ms);
    for (const id of from) accumulator.eventos.add(id);
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
        queued.set(entity, { no_id: target, since: when, event: event.id });
        break;
      }

      case 'job.blocked': {
        const where = currentNode.get(entity);
        if (where === undefined) break;
        blocked.set(entity, { no_id: where, since: when, event: event.id });
        break;
      }

      case 'job.unblocked': {
        const wait = blocked.get(entity);
        if (wait === undefined) break;
        blocked.delete(entity);
        add(wait.no_id, 'tempo_espera_ms', when - wait.since, [wait.event, event.id]);
        break;
      }

      case 'session.opened': {
        const no_id = asText(event.data.node_id);
        const trabalho_id = asInteger(event.data.job_id);
        sessions.set(entity, { no_id, trabalho_id, openedAt: when, event: event.id });

        if (trabalho_id === null || no_id === null) break;
        const queue = queued.get(trabalho_id);
        // Only the session that opens ON THE NODE the work landed on closes the
        // queue interval; anything else is a different node's business.
        if (queue === undefined || queue.no_id !== no_id) break;
        queued.delete(trabalho_id);
        add(no_id, 'tempo_fila_ms', when - queue.since, [queue.event, event.id]);
        break;
      }

      case 'session.finished': {
        const session = sessions.get(entity);
        if (session === undefined) break;
        add(session.no_id, 'tempo_agente_ms', when - session.openedAt, [
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
          session?.no_id === undefined || session.no_id === null
            ? undefined
            : accumulators.get(session.no_id);
        if (accumulator === undefined) break;
        accumulator.perguntas += 1;
        accumulator.eventos.add(event.id);
        break;
      }

      default:
        break;
    }
  }

  const ranking = [...accumulators.values()]
    .map((accumulator) => ({
      no_id: accumulator.no_id,
      tempo_agente_ms: accumulator.tempo_agente_ms,
      tempo_espera_ms: accumulator.tempo_espera_ms,
      tempo_fila_ms: accumulator.tempo_fila_ms,
      total_ms:
        accumulator.tempo_agente_ms + accumulator.tempo_espera_ms + accumulator.tempo_fila_ms,
      perguntas: accumulator.perguntas,
      eventos: [...accumulator.eventos].sort((a, b) => a - b),
    }))
    // Ties broken by node id so the ranking is a function of the log alone —
    // two runs with the same numbers must name the same bottleneck.
    .sort((a, b) => b.total_ms - a.total_ms || (a.no_id < b.no_id ? -1 : 1));

  const worst = ranking[0];
  return {
    por_no: ranking,
    gargalo: worst !== undefined && worst.total_ms > 0 ? worst : null,
  };
}
