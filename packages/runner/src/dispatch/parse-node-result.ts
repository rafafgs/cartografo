/**
 * The block a session closes its turn with: its REPORT, and — when the node
 * decides — the edge it took (t161 FR9, t259 FR2).
 *
 * A node with two or more outgoing edges is a decision, and the graph is
 * explicit about who takes it: an edge's `condition` is a label that matches the
 * outcome the source node's `output_schema` declares
 * (`docs/spec/grafo.md`). Until t161 nothing carried that outcome from the
 * session back to the runner — the operator read the output and posted the
 * transition by hand. This module is the protocol that replaced the operator:
 * one fenced block.
 *
 * **And one fenced block is ALL of what the session reports** (t259). Until this
 * ficha the parser kept `resultado` and dropped every other key of the payload,
 * because the only consumer was `advance()` and the only question was which edge
 * to take. But that same block is the one thing a session prints in the shape of
 * its node's `output_schema`, and that object is what `PATCH /finish` stores and
 * what the next node's `input` is projected from
 * (`packages/core/src/domain/context.ts`). Dropping everything but the label
 * left `session.output` with no producer at all — a channel the control plane
 * had built and nothing could fill. So the whole payload comes back, and the
 * routing label is one field inside it.
 *
 * Which means a block with NO label is a legal report and no longer "not a
 * block": a `work` node with a single way out has no decision to make, and its
 * `output_schema` declares no `resultado` — `desenvolver` produces
 * `{branch, commits, …}` and nothing else. What did NOT loosen is a `resultado`
 * that is present and is not a label: that is a session which did not understand
 * the protocol, and taking the rest of its payload as a report would store an
 * object nobody can trust beside a routing decision no edge can ever carry.
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
 *
 * One thing the whole payload does NOT survive: since t269 the control plane
 * takes a valid `resultado` out of the object before holding it against the
 * pinned skill's `output` and before storing it
 * (`packages/core/src/repositories/session.ts`, `stripRouteLabel`) — the routing
 * key is the graph's vocabulary and a skill that closes its schema would refuse
 * every report carrying it. So whoever reads `session.output` later finds the
 * skill's fields and no label; the route this parser fed to `advance()` is
 * unaffected, because it never depended on what `/finish` answered.
 */

import { parseFencedJson } from './parse-fenced-json.ts';

/** The fence a session closes its turn with. */
const FENCE = 'resultado';

/**
 * Everything the session reported, as it reported it.
 *
 * Open on purpose: the keys are the node's `output_schema`'s, which is a
 * per-graph document this module neither knows nor vouches for. What it does
 * guarantee is {@link NodeResult.resultado} — present only when the session
 * named an edge, and then a non-empty, trimmed string.
 */
export interface NodeResult extends Record<string, unknown> {
  /** The `condition` of the edge the session says this node took, if it said. */
  resultado?: string;
}

/** Builds the result from a parsed payload, or `null` when it is unusable. */
function build(payload: unknown): NodeResult | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const raw = (payload as Record<string, unknown>).resultado;

  // No label at all: an ordinary report from a node that routes nothing. It
  // comes back whole, which is the entire point of t259 — the object IS the
  // node's output, and the next node's input is built out of it.
  if (raw === undefined) return { ...(payload as Record<string, unknown>) };

  // A label and nothing else: a number or an object here is a session that did
  // not understand the protocol, and treating it as a routing decision would
  // move the work on a value no edge can ever carry.
  if (typeof raw !== 'string') return null;

  const label = raw.trim();
  if (label === '') return null;

  return { ...(payload as Record<string, unknown>), resultado: label };
}

/**
 * Extracts what a session reported, and the edge it says its node took.
 *
 * @param output Everything the session printed, decoded into text.
 * @returns The last valid block, whole, or `null` when there is none. Never
 *   throws — a session that routed nothing is a human being called, not a
 *   dispatch lost.
 */
export function parseNodeResult(output: string): NodeResult | null {
  return parseFencedJson(output, FENCE, build);
}
