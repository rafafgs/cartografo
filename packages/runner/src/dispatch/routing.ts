/**
 * Which way the work goes when its node is done (t161, FR9/FR10; split out in
 * t371).
 *
 * Three functions that were `report.ts`'s until this ficha, moved together and
 * unchanged: the transition, the escalation raised when a node with more than
 * one way out named none of them, and the choice between the two. No export was
 * renamed and no behaviour changed — `report.ts` re-exports the first two, so no
 * caller edits an import, which is the rule every earlier split of this
 * directory ran under (t202, t223, t265, t268, t272).
 *
 * **Why the cut is here and why it is now.** `report.ts` was at 590 of the
 * 600-line budget `test/dispatch/file-size-budget.test.ts` enforces, and t371
 * adds to it. But the size is the occasion, not the reason. The reason is that
 * the delivery step (`src/mcp/write-external-outputs.ts`) needs to publish a
 * transition of its own: when a person answers "skip this output" or "mark as
 * done" about a step that already ran, the work has to move with **no session**
 * — re-opening the step's session is exactly the repeat `unsafe_to_retry` exists
 * to prevent (`docs/spec/human-escalation.md` §7). That gives the edge selection
 * a second caller, and a second caller is precisely when a decision stops being
 * a detail of its first one. Left in `report.ts` it would have been a cycle:
 * `report.ts` reaches into the delivery step, and the delivery step reaches back
 * for the edges.
 *
 * So {@link selectAndTransition} takes the accepted report as an OBJECT rather
 * than as session text. The two callers hold it in different shapes — one has
 * just decoded a live session, the other read `session.output` back off the
 * control plane weeks later, in principle — and the parse belongs to whoever has
 * the text.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API, same boundary the UI has (D1, D11).
 *
 * English per D24.
 */

import { blockWithNobodyToAsk, RUNNER_ACTOR_REF, type JobRef } from './blocks.ts';
import type { ControlPlaneCall } from './control-plane-client.ts';
import {
  resolveEscalationPolicy,
  type EscalationPolicy,
  type GraphEdge,
  type ResolvedNode,
} from './resolve-node.ts';

/**
 * Moves the work along the edge the traversal chose (t161, FR10).
 *
 * The one write of this family that PROPAGATES on failure, and the asymmetry
 * with the denial and the closure is deliberate: those are telemetry the runner
 * owes after the fact, and a work that keeps moving with a gap in its log is
 * recoverable. A transition that was not recorded is a work that stopped,
 * standing on a node it already finished, with nobody able to tell that from a
 * work that is merely slow. That is the single failure mode t161 exists to
 * close, so it may not be swallowed into a report at the end.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param edge The edge to take.
 */
export async function transition(
  call: ControlPlaneCall,
  job: JobRef,
  edge: GraphEdge,
): Promise<void> {
  await call(`/v1/jobs/${job.id}/transitions`, 'POST', {
    to_node_id: edge.to,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}

/**
 * Asks a human which way the work goes (t161, FR9).
 *
 * Reached when a node with more than one way out finished without naming one
 * of them: no block, a malformed block, or a result that matches no edge —
 * the last of which is a real case and not a defect. The reference graph's own
 * gate declares `escala` in its `saida_schema` and has no edge for it, on
 * purpose: some outcomes are not the machine's to route.
 *
 * `ator.tipo` is `sistema` and not `agente`, which is the only thing that
 * tells this question apart from one the SESSION wrote: that one is a model
 * asking for a decision, this one is the wiring reporting that it has no rule
 * to apply. Two spellings for two different facts, in a log somebody has to be
 * able to group.
 *
 * At a `never` node it stops the work instead of asking (t167, FR6). The
 * missing routing decision is just as real, and the work stops just as hard —
 * what changes is that nobody is called for it, which is what the node
 * declared.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param sessionId The session that just finished, for the question's trail.
 * @param edges The edges leaving the node, in document order.
 * @param observed What the session named as its result, or `null`.
 * @param policy The escalation policy the node runs under.
 */
export async function escalateRouting(
  call: ControlPlaneCall,
  job: JobRef,
  sessionId: number,
  edges: readonly GraphEdge[],
  observed: string | null,
  policy: EscalationPolicy,
): Promise<void> {
  const labels = edges.map((edge) => edge.condition ?? '').filter((label) => label !== '');
  const seen = observed === null ? 'none' : `"${observed}"`;
  // Built with concatenation and not with a nested template literal: the D18
  // sweep's masking scanner reads one backtick at a time, and a template
  // inside a `${…}` silently desyncs it for the whole rest of the file
  // — one backtick in a comment can swallow the quoted strings that follow it.
  const routes = edges
    .map((edge) => '`' + (edge.condition ?? '') + '` → `' + edge.to + '`')
    .join(', ');

  const question =
    `Node \`${job.current_node_id}\` has more than one way out and the session ` +
    `chose none of them: the result observed was ${seen}, and it matches no edge ` +
    'of this node. Which edge does the work follow?';

  if (policy === 'never') {
    await blockWithNobodyToAsk(call, job, `${question} This node has nobody to ask.`);
    return;
  }

  await call('/v1/input-requests', 'POST', {
    job_id: job.id,
    session_id: sessionId,
    kind: 'question',
    question,
    context:
      `Edges leaving \`${job.current_node_id}\`: ${routes}. ` +
      'The session ended without failing; what is missing is the routing decision.',
    options: labels,
    recommendation: null,
    default_answer: null,
    // Written as `true` since t102, and nothing reads it to answer on its own:
    // a routing escalation is resolved by a person, same as every other
    // pending question today.
    auto_approvable: true,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}

/**
 * Takes the edge the report names, or asks who should (t161, FR9/FR10).
 *
 * The tail of what `advance()` has always done, as a function of its own since
 * t371 gave it a second caller. It assumes everything ahead of it has already
 * happened — the bench advanced, the declared outputs delivered — and it is the
 * caller's business to have made that true; the ORDER is `report.ts`'s to
 * guarantee, which is why that function still exists.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being moved.
 * @param resolved Its node and the edges leaving it.
 * @param sessionId The session whose report this is, for the question's trail.
 * @param report What that session reported, decoded — `null` when it reported
 *   nothing usable, which is an ordinary state and routes to the escalation.
 */
export async function selectAndTransition(
  call: ControlPlaneCall,
  job: JobRef,
  resolved: ResolvedNode,
  sessionId: number,
  report: Record<string, unknown> | null,
): Promise<void> {
  const { edges } = resolved;

  // Nothing to do: a node with no way out is a final node by the graph's own
  // `termina` rule, and there is nowhere to move the work to. What marks it
  // finished is `concluido`, derived by the control plane (t152) — and since
  // t262 that is not arrival: a final node with a skill needs its own report.
  if (edges.length === 0) return;

  // Deterministic by construction: one way out is taken whatever the label
  // says. Every non-gate node of the reference graph labels it `sempre`, and
  // that string is not special-cased — a node with a single edge has no
  // decision to report, so asking it for one would invent a decision and then
  // escalate for the lack of an answer to it.
  if (edges.length === 1) {
    await transition(call, job, edges[0]);
    return;
  }

  const label = report?.resultado;
  const observed = typeof label === 'string' ? label : null;
  const chosen = edges.find((edge) => edge.condition === observed);
  if (chosen === undefined) {
    await escalateRouting(call, job, sessionId, edges, observed, resolveEscalationPolicy(resolved));
    return;
  }

  await transition(call, job, chosen);
}
