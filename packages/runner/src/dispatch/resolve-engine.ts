/**
 * Which engine — and which of its models — runs the node a work is sitting on
 * (t141, t166, t223).
 *
 * The sibling of `resolve-node.ts`, one step further down: that module answers
 * "which node, out of which snapshot", and this one reads the two routing fields
 * off the answer. Both are pure, both take the `ResolvedNode | null` the dispatch
 * already holds, and neither one fetches anything — the single read of the graph
 * version happens once, in the orchestrator, and everything downstream reads it.
 *
 * The two functions look alike and are not symmetric, which is the whole content
 * of this module: the engine has a default and the model must not have one. See
 * {@link resolveModel}.
 *
 * It carries {@link UnknownEngineError} for the same reason it carries
 * {@link DEFAULT_ENGINE}: routing is one decision, and the failure of a routing
 * decision belongs next to the decision, not in the orchestrator that happens to
 * throw it.
 *
 * English per D18.
 */

import type { EngineAdapter } from '../engine/types.ts';
import type { ResolvedNode } from './resolve-node.ts';

/**
 * The engine name used when the graph says nothing (t141, FR3).
 *
 * Exported and named, never silently implied: three different situations land
 * here — a work with no `grafo_versao_id`, a node the snapshot does not carry,
 * and a node that simply declares no `engine` — and in all three the telemetry
 * has to be able to say WHICH engine ran without anyone guessing.
 */
export const DEFAULT_ENGINE = 'claude-code';

/**
 * One engine this dispatch can route to: who opens the session, and how to read
 * back what it printed.
 */
export interface EngineRoute {
  /** Production passes a real adapter; tests pass one pointed at the fake engine. */
  adapter: EngineAdapter;
  /**
   * Decodes the lines that reached `onOutput` into the text the model produced.
   *
   * Part of the route and not of the adapter because it is the DISPATCH that
   * needs the text — to find an escalation block — while the adapter's contract
   * stops at delivering lines verbatim (invariant 4). Adding it to
   * `EngineAdapter` would have grown a frozen interface (v1) for the benefit of
   * exactly one consumer.
   */
  decodeSessionText: (lines: readonly string[]) => string;
}

/**
 * A node asked for an engine this dispatch has no route for (t141, FR5).
 *
 * Thrown BEFORE any session opens, and never softened into a fallback: routing
 * the work to whatever engine happens to be registered would run it on an engine
 * nobody chose AND record that engine as if the graph had asked for it. The
 * telemetry would be internally consistent and false, which is worse than a
 * dispatch that stops.
 *
 * It propagates untouched, the same way `SessionStartError` does: the controller's
 * `finally` returns the lease, and the work is simply not advanced.
 */
export class UnknownEngineError extends Error {
  /** The engine the node declared. */
  readonly engine: string;
  /** The node that declared it. */
  readonly nodeId: string;
  /** The engines that DO have a route, for the message a human reads. */
  readonly known: readonly string[];

  constructor(engine: string, nodeId: string, known: readonly string[]) {
    super(
      `node "${nodeId}" asks for engine "${engine}", which has no route in this dispatch ` +
        `(registered: ${known.length === 0 ? 'none' : known.join(', ')})`,
    );
    this.name = 'UnknownEngineError';
    this.engine = engine;
    this.nodeId = nodeId;
    this.known = known;
  }
}

/**
 * Which engine handles the node this work is sitting on RIGHT NOW (t141, FR3).
 *
 * The current node and not the entry one: a work moves, and the engine is a
 * property of the step being executed, not of the traversal that contains it.
 *
 * Three roads lead to {@link DEFAULT_ENGINE}, and all three are ordinary: the
 * work carries no graph version, the snapshot has no node with this id, or the
 * node declares no `engine`. A missing graph version the work explicitly
 * points at is NOT one of them — that is a dangling reference, and it rejects
 * out of `resolveNode` rather than being papered over with a default.
 *
 * Since t161 the fetch is `resolveNode`'s and this function is pure: the first
 * two roads are the same `null` the rest of the dispatch reads, so the engine
 * that ran and the edge that was taken come from ONE read of ONE snapshot.
 *
 * @param resolved The node this dispatch resolved, or `null`.
 * @returns The engine name to route on.
 */
export function resolveEngine(resolved: ResolvedNode | null): string {
  const declared = resolved?.node.engine;
  // Free text at the schema level on purpose (Out of Scope: no closed enum),
  // so "declared" means a non-empty string and nothing else.
  if (typeof declared !== 'string' || declared.trim() === '') return DEFAULT_ENGINE;
  return declared;
}

/**
 * Which model of that engine runs the node this work is sitting on (t166, FR5).
 *
 * The mirror of {@link resolveEngine}, with the one difference that matters:
 * there is no `DEFAULT_MODEL` to fall back to, and there must not be. The
 * runner has no way of knowing which models a given installation can reach,
 * so the honest absence is `undefined` — no flag assembled, the engine picks
 * its own default, and the telemetry records that nobody chose. A constant
 * here would put a decision into every session that no graph ever made.
 *
 * The blank-string guard is the same one {@link resolveEngine} has, and it earns
 * its place for a different reason: a `model: "  "` that survived into a
 * snapshot would otherwise reach the CLI as an empty `--model`, and the
 * session would die on a flag nobody typed.
 *
 * @param resolved The node this dispatch resolved, or `null`.
 * @returns The model identifier to pin, or `undefined` for the engine's own.
 */
export function resolveModel(resolved: ResolvedNode | null): string | undefined {
  const declared = resolved?.node.model;
  if (typeof declared !== 'string' || declared.trim() === '') return undefined;
  return declared;
}
