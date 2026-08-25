/**
 * Everything a session needs, resolved before there is anything to give back
 * (t272, extracted from `dispatch.ts`).
 *
 * Three reads and one lookup, in the order the cheapest failure comes first: the
 * graph version the work points at, the engine its node asks for, and the skill
 * that node pins — rendered against this dispatch's input. All of it happens
 * BEFORE `worktrees.acquire`, which is the whole property the sequence around it
 * depends on: everything that fails in here fails with no directory cut, no
 * session row, no engine process and no token spent.
 *
 * **Why it is a module and not four lines of the orchestrator.** It was exactly
 * that until t272, and that ficha needed room: `dispatch.ts` was at 598 of the
 * 600-line budget `test/dispatch/file-size-budget.test.ts` enforces, and what
 * t272 adds to it is sequence — three catch sites and the precedence between
 * them. This block is the opposite of sequence. It is a straight line of reads
 * with no ordering interplay with the worktree, the session lifecycle or the
 * telemetry, and each read already argues for itself. Moving it moves its prose
 * with it, which is the rule every earlier split of this directory ran under
 * (t202, t223, t268): no name renamed, no behaviour changed, and the caller's
 * `try`/`catch` stays exactly where it was — WHICH failures block is
 * `pre-session-failure.ts`'s and `pre-session-retry.ts`'s to say, and the
 * decision is `dispatch.ts`'s to take.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API (D1, D11).
 *
 * English per D18.
 */

import type { ControlPlaneCall } from './control-plane-client.ts';
import type { Job } from './options.ts';
import {
  renderSkillInstructions,
  type RegisteredSkill,
  type RenderedSkill,
} from './render-skill-instructions.ts';
import { UnknownEngineError, resolveEngine, type EngineRoute } from './resolve-engine.ts';
import { resolveNode, type GraphVersionBody, type ResolvedNode } from './resolve-node.ts';

/** What one dispatch resolved for itself before it acquired anything. */
export interface SessionPlan {
  /**
   * The node the work is standing on, out of the snapshot — `null` for a work
   * with no graph, which is ordinary and not a defect.
   */
  resolved: ResolvedNode | null;
  /** The adapter and decoder the node's engine name routes to. */
  route: EngineRoute;
  /**
   * The pinned skill, rendered against this dispatch's input. `null` exactly
   * when there is no node to have pinned one.
   */
  rendered: RenderedSkill | null;
}

/**
 * Reads and resolves the whole pre-session window, or throws.
 *
 * Every throw is deliberate and every one of them is somebody else's to
 * classify: a dangling `graph_version_id` comes back as the read's own
 * `ControlPlaneClientError`, an engine with no route as {@link UnknownEngineError},
 * and the three skill refusals as `render-skill-instructions.ts`'s own classes.
 * This function adds no error type of its own — inventing one here would put a
 * layer between the cause and the module that names it.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param engines The engines this dispatch can route to, by declared name.
 * @param resolveInput What this node's `{{input.<caminho>}}` resolve against.
 * @returns The node, the route and the rendered skill.
 */
export async function resolveSessionPlan(
  call: ControlPlaneCall,
  job: Job,
  engines: Record<string, EngineRoute>,
  resolveInput: (job: Job, resolved: ResolvedNode) => Promise<Record<string, unknown>>,
): Promise<SessionPlan> {
  // ONE read of the graph version, and it is the first thing the dispatch does:
  // the engine, the skill, the contract and the edges all come out of this
  // (t141, FR1). A version the work points at and that does not resolve stops
  // right here, which is where stopping is cheapest.
  const resolved = await resolveNode(job, (versionRoute) =>
    call<GraphVersionBody>(versionRoute, 'GET'),
  );

  // Resolved before anything is read for the prompt and long before a session
  // opens: an engine nobody registered has to stop the dispatch while stopping
  // it is still free (t141, FR5).
  const engineName = resolveEngine(resolved);
  const route = engines[engineName];
  if (route === undefined) {
    throw new UnknownEngineError(engineName, job.current_node_id, Object.keys(engines));
  }

  // Then the skill, in the same window and for the same reason: an unregistered
  // skill, a pin that stopped matching, or — since t204 — a body whose
  // placeholders this dispatch cannot resolve stops it before a worktree is cut,
  // before a session exists and before a single token is spent (t161, FR3). A
  // refusal after the engine is running is a refusal that already let the
  // instructions out.
  const rendered =
    resolved === null
      ? null
      : await renderSkillInstructions(
          resolved,
          (skillRoute) => call<RegisteredSkill>(skillRoute, 'GET'),
          await resolveInput(job, resolved),
        );

  return { resolved, route, rendered };
}
