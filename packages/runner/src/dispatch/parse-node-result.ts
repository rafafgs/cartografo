/**
 * The routing block a session emits when its node has more than one way out
 * (t161, FR9).
 *
 * A node with two or more outgoing edges is a decision, and the graph is
 * explicit about who takes it: an edge's `condition` is a label that matches the
 * outcome the source node's `output_schema` declares
 * (`docs/spec/grafo.md`). Until this ficha nothing carried that outcome from
 * the session back to the runner — the operator read the output and posted the
 * transition by hand. This module is the protocol that replaces the operator:
 * one fenced block, one field.
 *
 * The vocabulary is the NODE's, not the manifest's. A gate skill declares
 * `pass`/`fail`/`escalate_human` in its own `output` (enforced at registry
 * entry, `packages/core/src/repositories/skill.ts`), and the graph's edges are
 * labelled with whatever the graph author chose — `aprovado`, `retrabalho`. What
 * this parser reads is the label, whatever it is; the matching against real
 * edges belongs to the dispatch, and a value matching none of them is a human's
 * decision, never a crash.
 *
 * The three reading rules are `parse-fenced-json.ts`'s and are shared verbatim
 * with the escalation block: extent from the JSON, malformed ignored instead of
 * raised, last valid wins.
 */

import { parseFencedJson } from './parse-fenced-json.ts';

/** The fence a session closes its turn with when it has to route itself. */
const FENCE = 'resultado';

/** The outcome a session reported, as the edge label it names. */
export interface NodeResult {
  /** The `condition` of the edge the session says this node took. */
  resultado: string;
}

/** Builds the result from a parsed payload, or `null` when it routes nothing. */
function build(payload: unknown): NodeResult | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const raw = (payload as Record<string, unknown>).resultado;
  // A label and nothing else: a number or an object here is a session that did
  // not understand the protocol, and treating it as a routing decision would
  // move the work on a value no edge can ever carry.
  if (typeof raw !== 'string') return null;

  const label = raw.trim();
  if (label === '') return null;

  return { resultado: label };
}

/**
 * Extracts the edge a session says its node took, if it said so at all.
 *
 * @param output Everything the session printed, decoded into text.
 * @returns The last valid block, or `null` when there is none. Never throws —
 *   a session that routed nothing is a human being called, not a dispatch lost.
 */
export function parseNodeResult(output: string): NodeResult | null {
  return parseFencedJson(output, FENCE, build);
}
