/**
 * The dispatch of a subgraph node: open the children, wait, resume (t638,
 * FR6–FR15).
 *
 * A subgraph node pins no skill and runs no model. When a job stands on one,
 * `dispatch.ts` hands it here before anything about a session is resolved, and
 * this module does exactly one of four things:
 *
 * 1. **open** the children that are missing — one `POST /v1/jobs` each, in
 *    element order, chained by `depends_on` when the fan-out is ordered — and
 *    end the dispatch. The parent is now held by its children (`dispatch_hold:
 *    'children'`), so it is not leased again until every one of them arrived;
 * 2. **nothing**, when every child exists and some have not arrived. The lease
 *    would not normally have been granted at all; this is the backstop;
 * 3. **resume**, when every child arrived: assemble the node's output through
 *    `output_map`, record it as ONE `completed` session on the pseudo-engine
 *    `subgraph`, and take the node's single edge;
 * 4. **block**, with a reason a person can act on, for every refusal that would
 *    reproduce on the next tick.
 *
 * **Reconciling, not remembering.** Nothing is kept between dispatches. Which
 * of the four applies is read off the control plane every time: the children of
 * THIS node, in `sibling_position` order, against the count the node expects.
 * A runner that died halfway through opening three children leaves one or two
 * behind, and the next dispatch opens only the rest; a runner that died between
 * the finish and the transition leaves a stored report, and the next dispatch
 * only repeats the transition. That is what makes the dispatch safe to repeat.
 *
 * **The wait is no session at all.** The open dispatch writes none — its facts
 * are the children's own `job.created`, `job.parent_linked` and
 * `job.dependency_declared` — and the resume writes exactly one, `completed`.
 * So the session ceiling, which counts trailing `failed` sessions per node, has
 * nothing to count here (`docs/spec/graph.md`, the runtime contract).
 *
 * **What blocks and what throws.** A refusal that will reproduce blocks the
 * parent through `POST /v1/jobs/:id/blocks` and resolves `{blocked: true}`: an
 * unregistered class, a placeholder that does not resolve, a `fan_out.over`
 * that is not a list, a 4xx from the control plane (its own message quoted),
 * more children than expected, and a node reached a second time. A 5xx or a
 * network error is thrown untouched, and `dispatch.ts` routes it through the
 * same bounded pre-session decision every other read before a session goes
 * through (`pre-session-retry.ts`): retried, then blocked with its count.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API (D1, D11).
 */

import { ControlPlaneClientError } from '../controller/control-plane-client.ts';
import { RUNNER_ACTOR_REF, blockForOutputSchemaRefusal } from './blocks.ts';
import { withProject, type ControlPlaneCall } from './control-plane-client.ts';
import type { Job } from './options.ts';
import type { DispatchOutcome } from './outcome.ts';
import { graphVersionRoute, type GraphVersionBody, type ResolvedNode } from './resolve-node.ts';
import { selectAndTransition } from './routing.ts';
import {
  SubgraphMappingError,
  assembleOutput,
  childPayload,
  fanOutItems,
  type ChildState,
  type SubgraphCall,
} from './subgraph-map.ts';

/** The engine name the resume's session is recorded under. No adapter answers to it. */
export const SUBGRAPH_ENGINE = 'subgraph';

/** The part of the dispatch's configuration this module reads. */
export interface SubgraphRunOptions {
  /** Project every read and every child names; absent means the server's default. */
  projectId?: number;
}

/** A child of the parent, as `GET /v1/jobs/:id` answers it, in the part read here. */
interface ChildJob {
  id: number;
  completed: boolean;
  parent_node_id?: string | null;
  sibling_position?: number | null;
}

/** One entry of `GET /v1/classes`. */
interface ClassEntry {
  class: string;
  current_version_id: string | null;
}

/** One session of `GET /v1/sessions?job_id=`, in the part read here. */
interface SessionRow {
  id: number;
  node_id: string | null;
  status: string;
  output: Record<string, unknown> | null;
}

/** What `PATCH /v1/sessions/:id/finish` answers about the report. */
interface FinishAnswer {
  output_accepted?: boolean;
  output_schema_error?: string[];
}

/**
 * A refusal this module stops the work on, carrying the sentence it stops with.
 * Thrown internally and caught once, at the top, so each step can say why it
 * stopped where it stopped.
 */
class SubgraphRefusal extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The control plane's own words for a refusal, quoted rather than summarized. */
function refusalText(error: ControlPlaneClientError): string {
  const body = error.body;
  if (isObject(body)) {
    const message = typeof body.message === 'string' ? body.message : null;
    const code = typeof body.error === 'string' ? body.error : null;
    if (message !== null && code !== null) return `${code}: ${message}`;
    if (message !== null || code !== null) return message ?? code ?? '';
  }
  return typeof body === 'string' && body !== '' ? body : error.message;
}

/** Whether an error is a refusal that will reproduce: a 4xx from the control plane. */
function isClientRefusal(error: unknown): error is ControlPlaneClientError {
  return error instanceof ControlPlaneClientError && error.status >= 400 && error.status < 500;
}

/**
 * Runs the subgraph node the job is standing on.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work, as `GET /v1/jobs/:id` answered it.
 * @param resolved Its node — a `subgraph` node — and the edges leaving it.
 * @param options The project the dispatch is scoped to.
 * @returns `{blocked: false}` when children were opened, are still running, or
 *   the node resumed; `{blocked: true, reason}` when the work was stopped.
 * @throws Whatever a 5xx or a network failure threw, for the caller's bounded
 *   retry.
 */
export async function runSubgraphNode(
  call: ControlPlaneCall,
  job: Job,
  resolved: ResolvedNode,
  options: SubgraphRunOptions,
): Promise<DispatchOutcome> {
  const nodeId = resolved.node.id;
  try {
    return await reconcile(call, job, resolved, options);
  } catch (error) {
    let detail: string;
    if (error instanceof SubgraphRefusal) detail = error.message;
    else if (error instanceof SubgraphMappingError) detail = error.problems.join('; ') + '.';
    else if (isClientRefusal(error)) {
      detail =
        `the control plane refused \`${error.message}\` — ${refusalText(error)}. ` +
        'It answers the same on every retry.';
    } else throw error;

    const reason =
      `Subgraph node \`${nodeId}\`: ${detail} No child was opened past this point and no ` +
      'session was recorded for the node. Fix what the reason points at and unblock.';
    await call(`/v1/jobs/${String(job.id)}/blocks`, 'POST', {
      reason,
      actor: { type: 'system', ref: RUNNER_ACTOR_REF },
    });
    return { blocked: true, reason };
  }
}

/** The four-way decision, with every refusal thrown for {@link runSubgraphNode}. */
async function reconcile(
  call: ControlPlaneCall,
  job: Job,
  resolved: ResolvedNode,
  options: SubgraphRunOptions,
): Promise<DispatchOutcome> {
  const { projectId } = options;
  const nodeId = resolved.node.id;
  const subgraph: SubgraphCall = resolved.node.subgraph ?? {};

  // The parent's input, from the control plane's projection: `{{input.…}}`
  // reads it, and so does the revisit guard below. The executor-environment
  // half is for sessions, and this node opens none.
  const { input } = await call<{ input: Record<string, unknown> }>(
    withProject(`/v1/jobs/${String(job.id)}/context`, projectId),
    'GET',
  );

  // Children are scoped to the NODE, not to a visit: a rework loop that brings
  // the job back here would find the first visit's children, all completed, and
  // resume with their output without doing anything. Until children are scoped
  // per visit, a second arrival stops instead (FR15).
  const traversal = isObject(input.traversal) ? input.traversal : {};
  const visited = Array.isArray(traversal.nodes_visited) ? traversal.nodes_visited : [];
  if (visited.includes(nodeId)) {
    throw new SubgraphRefusal(
      'the job is reaching this node a second time, and a revisited subgraph node is not ' +
        'supported yet: its children belong to the node, not to one visit, so the first ' +
        "visit's children would be taken as this one's.",
    );
  }

  const items = fanOutItems(subgraph, input);
  const expected = items === null ? 1 : items.length;

  // The children of THIS node, in position order. A child another node of the
  // same parent opened — or a manual link — is not this call's.
  const children: ChildJob[] = [];
  for (const childId of job.children ?? []) {
    const child = await call<ChildJob>(withProject(`/v1/jobs/${String(childId)}`, projectId), 'GET');
    if (child.parent_node_id === nodeId) children.push(child);
  }
  children.sort((a, b) => (a.sibling_position ?? 0) - (b.sibling_position ?? 0));

  if (children.length > expected) {
    throw new SubgraphRefusal(
      `the node expects ${String(expected)} child job(s) and the control plane holds ` +
        `${String(children.length)} (${children.map((child) => `job ${String(child.id)}`).join(', ')}). ` +
        'Which of them belong to this call is not the runner\'s to guess.',
    );
  }

  if (children.length < expected) {
    await openChildren(call, job, nodeId, subgraph, input, items, children, options);
    return { blocked: false };
  }

  // All of them exist. Until every one has arrived there is nothing to do.
  if (!children.every((child) => child.completed)) return { blocked: false };

  return await resume(call, job, resolved, subgraph, children, options);
}

/**
 * Opens the children that do not exist yet, in element order.
 *
 * Every payload is resolved before the first `POST`, so a mapping that fails
 * for element three opens nothing at all. The class is resolved here, at run
 * time, in the job's own project — registration checked it once, and a class
 * can lose its current version afterwards.
 */
async function openChildren(
  call: ControlPlaneCall,
  job: Job,
  nodeId: string,
  subgraph: SubgraphCall,
  input: Record<string, unknown>,
  items: readonly unknown[] | null,
  existing: readonly ChildJob[],
  options: SubgraphRunOptions,
): Promise<void> {
  const { projectId } = options;
  const className = typeof subgraph.class === 'string' ? subgraph.class : '';
  const { classes } = await call<{ classes: ClassEntry[] }>(
    withProject('/v1/classes', projectId),
    'GET',
  );
  const entry = classes.find((candidate) => candidate.class === className);
  if (entry === undefined) {
    throw new SubgraphRefusal(
      `the called class \`${className}\` is not registered in this project.`,
    );
  }
  if (entry.current_version_id === null) {
    throw new SubgraphRefusal(`the called class \`${className}\` has no current version.`);
  }
  const versionId = entry.current_version_id;
  const { graph_version: version } = await call<GraphVersionBody & {
    graph_version: { snapshot?: { initial_node?: unknown } };
  }>(withProject(graphVersionRoute(versionId), projectId), 'GET');
  const initialNode = version.snapshot?.initial_node;
  if (typeof initialNode !== 'string' || initialNode === '') {
    throw new SubgraphRefusal(
      `the current version of class \`${className}\` declares no initial node.`,
    );
  }

  const missing: number[] = [];
  for (let index = existing.length; index < (items?.length ?? 1); index += 1) missing.push(index);
  const payloads = missing.map((index) =>
    childPayload(subgraph, input, items === null ? undefined : items[index]),
  );

  const ordered = subgraph.fan_out?.ordered === true;
  let previous: number | null = existing.length === 0 ? null : existing[existing.length - 1].id;
  // Sequentially and never in parallel: `sibling_position` is assigned by the
  // core in arrival order, and it has to follow element order.
  for (const payload of payloads) {
    const created = await call<{ id: number }>('/v1/jobs', 'POST', {
      ...payload,
      ...(projectId === undefined ? {} : { project_id: projectId }),
      execution_id: job.execution_id,
      graph_version_id: versionId,
      entry_node_id: initialNode,
      parent_job_id: job.id,
      parent_node_id: nodeId,
      ...(ordered && previous !== null ? { depends_on: [previous] } : {}),
      actor: { type: 'system', ref: RUNNER_ACTOR_REF },
    });
    previous = created.id;
  }
}

/**
 * Records the node's output and moves on: one session, its finish, the edge.
 *
 * A `completed` session with an output already stored for this node is a
 * resume that crashed before its transition, and it is not written twice.
 */
async function resume(
  call: ControlPlaneCall,
  job: Job,
  resolved: ResolvedNode,
  subgraph: SubgraphCall,
  children: readonly ChildJob[],
  options: SubgraphRunOptions,
): Promise<DispatchOutcome> {
  const { projectId } = options;
  const nodeId = resolved.node.id;

  const { sessions } = await call<{ sessions: SessionRow[] }>(
    withProject(`/v1/sessions?job_id=${String(job.id)}`, projectId),
    'GET',
  );
  const recorded = sessions.find(
    (session) => session.node_id === nodeId && session.status === 'completed' && session.output !== null,
  );
  if (recorded !== undefined) {
    await selectAndTransition(call, job, resolved, recorded.id, recorded.output);
    return { blocked: false };
  }

  const states: ChildState[] = [];
  for (const [index, child] of children.entries()) {
    const { input } = await call<{ input: Record<string, unknown> }>(
      withProject(`/v1/jobs/${String(child.id)}/context`, projectId),
      'GET',
    );
    states.push({ jobId: child.id, position: child.sibling_position ?? index + 1, input });
  }
  const output = assembleOutput(subgraph, states);

  const total = String(children.length);
  const listed = children.map((child) => `job ${String(child.id)}`).join(', ');
  const session = await call<{ id: number }>('/v1/sessions', 'POST', {
    job_id: job.id,
    node_id: nodeId,
    engine: SUBGRAPH_ENGINE,
    engine_session_ref: null,
    working_dir: '(none)',
    prompt:
      `Subgraph node \`${nodeId}\` called class \`${String(subgraph.class)}\`; ` +
      `children: ${listed === '' ? 'none' : listed}.`,
  });
  const answer = await call<FinishAnswer>(`/v1/sessions/${String(session.id)}/finish`, 'PATCH', {
    status: 'completed',
    exit_code: 0,
    transcript: children
      .map((child, index) => `${String(index + 1)}/${total} job ${String(child.id)}`)
      .join('\n'),
    output,
  });

  if (answer.output_accepted === false) {
    const reason = await blockForOutputSchemaRefusal(
      call,
      job,
      session.id,
      answer.output_schema_error ?? [],
    );
    return { blocked: true, reason };
  }

  await selectAndTransition(call, job, resolved, session.id, output);
  return { blocked: false };
}
