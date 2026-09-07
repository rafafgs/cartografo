/**
 * Everything a session needs, resolved before there is anything to give back
 * (t272, extracted from `dispatch.ts`).
 *
 * Four reads and one lookup, in the order the cheapest failure comes first: the
 * graph version the work points at, the engine its node asks for, whatever that
 * node declared it needs from outside (t370), and the skill it pins — rendered
 * against this dispatch's input. All of it happens BEFORE `worktrees.acquire`,
 * which is the whole property the sequence around it depends on: everything
 * that fails in here fails with no directory cut, no session row, no engine
 * process and no token spent.
 *
 * **The external inputs are the one read with a half that cannot stay here.**
 * The CALL belongs in this window — it is the most expensive thing that can
 * fail before a session, so failing it first is worth the most — but its result
 * has to be written into a directory that does not exist until `acquire`
 * answers. So this module fetches and hands back `pendingWrites`, and
 * `dispatch.ts` writes them the instant it has a tree. The reasoning is
 * `src/mcp/resolve-external-inputs.ts`'s, where the fetching lives.
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

import {
  resolveExternalInputs,
  type ExternalCallRecorder,
  type PendingExternalWrite,
} from '../mcp/resolve-external-inputs.ts';

/**
 * The DISK half of the MCP window, re-exported from where it is written.
 *
 * `dispatch.ts` calls it the moment `worktrees.acquire` answers, and it comes
 * through this module rather than straight from `src/mcp/` so that the two
 * halves of one decision arrive at the orchestrator from one place — the same
 * reason `dispatch.ts` re-exports `ESCALATION_PROTOCOL` and
 * `DEFAULT_ESCALATION_POLICY` instead of making its callers hunt for them.
 */
export { writeExternalInputs } from '../mcp/resolve-external-inputs.ts';
import { withProject, type ControlPlaneCall } from './control-plane-client.ts';
import { DEFAULT_MCP_CALL_TIMEOUT_MS, type Job } from './options.ts';
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
  /**
   * The bytes of the node's external inputs, waiting for a directory (t370).
   *
   * `[]` when there is no node, when the node declares none, or when the
   * dispatch was wired without the MCP window at all — three ordinary states
   * and all three the pre-existing shape. The dispatch writes them the moment
   * `worktrees.acquire` answers and before `buildSessionSpec`, which is the
   * first instant there is a `workingDir` to write into and still before the
   * session exists (`resolve-external-inputs.ts` argues the split).
   */
  pendingWrites: readonly PendingExternalWrite[];
}

/**
 * The part of the dispatch's configuration this window reads.
 *
 * The whole options object rather than three positional parameters, and t370 is
 * what tipped it: the window now needs `engines`, `projectId` and
 * `mcpCallTimeoutMs`, and a fourth parameter added per ticket is how a call site
 * ends up passing `undefined` into the middle of a list nobody can read.
 * Structurally typed against `ClaudeCodeDispatchOptions` (`options.ts`) rather
 * than importing it, the same rule `pre-session-failure.ts`'s `PreSessionJob`
 * follows: the orchestrator hands over what it already holds, and this module
 * names only the three fields it actually reads.
 */
export interface SessionPlanOptions {
  /** The engines this dispatch can route to, by the name a node declares. */
  engines: Record<string, EngineRoute>;
  /**
   * Project every scoped read of this window names (t410); absent means the
   * server's default project.
   */
  projectId?: number;
  /** Deadline of each MCP `tools/call`. Default {@link DEFAULT_MCP_CALL_TIMEOUT_MS}. */
  mcpCallTimeoutMs?: number;
}

/**
 * The recorder that writes a call's two phases through the dispatch's own
 * client (t370, FR6).
 *
 * Built HERE rather than inside `src/mcp/`, and that is the D1 boundary rather
 * than a filing preference: the runner speaks only to the public API, through
 * the ONE client `dispatch.ts` builds and hands to everything that writes
 * (`control-plane-client.ts`). A recorder that assembled its own headers would
 * be a second owner of the credential — which is precisely what t202 split this
 * module out to prevent.
 *
 * One route serves both phases, told apart by the body: a body with no
 * `call_id` opens the intent, and one carrying it closes that row.
 *
 * @param call The dispatch's control-plane client.
 * @param jobId The work the call is being made for.
 * @param projectId Project the write is scoped to, when the dispatch names one.
 * @returns The recorder `resolveExternalInputs` brackets each call with.
 */
export function createExternalCallRecorder(
  call: ControlPlaneCall,
  jobId: number,
  projectId?: number,
): ExternalCallRecorder {
  const route = withProject(`/v1/jobs/${String(jobId)}/external-calls`, projectId);

  return {
    intent: async (intent) => {
      const created = await call<{ external_call: { id: number } }>(route, 'POST', {
        node_id: intent.nodeId,
        // `'input'` and never anything else here: writing a node's OUTPUT back
        // to a server is t371's, and the column carries both values already so
        // that ticket needs no migration of its own.
        direction: 'input',
        name: intent.name,
        server: intent.server,
        tool: intent.tool,
        arguments_sha256: intent.argumentsSha256,
        arguments_summary: intent.argumentsSummary,
        started_at: intent.startedAt,
      });
      return created.external_call.id;
    },
    complete: async (callId, completion) => {
      await call(route, 'POST', {
        call_id: callId,
        finished_at: completion.finishedAt,
        outcome: completion.outcome,
        result_summary: completion.resultSummary,
      });
    },
  };
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
 * @param options The engine table, the project every read below is scoped to
 *   (t410) and the MCP call deadline (t370). Graph versions and skills have been
 *   partitioned since t354, and t410 is what makes an unscoped read certain to
 *   fail outside the default project: `POST /v1/jobs` refuses a
 *   `graph_version_id` from another project since that ticket, so a job's
 *   version is now always registered in the job's OWN project.
 * @param resolveInput What this node's `{{input.<caminho>}}` resolve against.
 * @returns The node, the route, the rendered skill and the bytes to write.
 */
export async function resolveSessionPlan(
  call: ControlPlaneCall,
  job: Job,
  options: SessionPlanOptions,
  resolveInput: (job: Job, resolved: ResolvedNode) => Promise<Record<string, unknown>>,
): Promise<SessionPlan> {
  const { engines, projectId } = options;
  // ONE read of the graph version, and it is the first thing the dispatch does:
  // the engine, the skill, the contract and the edges all come out of this
  // (t141, FR1). A version the work points at and that does not resolve stops
  // right here, which is where stopping is cheapest.
  const resolved = await resolveNode(job, (versionRoute) =>
    call<GraphVersionBody>(withProject(versionRoute, projectId), 'GET'),
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
  if (resolved === null) return { resolved, route, rendered: null, pendingWrites: [] };

  // Between the merged input and the render, and in that order because both
  // sides of it are load-bearing (t370, FR4): the input has to be assembled
  // before an argument can be interpolated against it, and `input.external` has
  // to exist before the manifest body naming `{{input.external.<name>.path}}`
  // is rendered. The NETWORK half happens here, in the same pre-worktree window
  // as everything else this module does; the DISK half is `dispatch.ts`'s, the
  // moment there is a directory to write into.
  const fetched = await resolveExternalInputs(
    resolved,
    await resolveInput(job, resolved),
    route.adapter,
    {
      callTimeoutMs: options.mcpCallTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
      // The record of every call, through the dispatch's own client and never a
      // second one (RF-37, FR6).
      record: createExternalCallRecorder(call, job.id, projectId),
    },
  );

  const rendered = await renderSkillInstructions(
    resolved,
    (skillRoute) => call<RegisteredSkill>(withProject(skillRoute, projectId), 'GET'),
    fetched.input,
  );

  return { resolved, route, rendered, pendingWrites: fetched.pendingWrites };
}
