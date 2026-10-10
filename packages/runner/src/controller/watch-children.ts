/**
 * The children watcher: a held parent is never silently stuck (t638, FR17/FR18).
 *
 * A job standing on a subgraph node opens its children and is then held by
 * them (`dispatch_hold: 'children'`): it is not leased again until every child
 * arrived. That is the whole wait, and it has one hole. A child that is blocked
 * — it failed, it asked a person, a gate stopped it — or that was cancelled
 * never reaches a final node, so the hold never clears. The hold is deliberate
 * (a cancelled child releases nothing, `job-state.ts`), and nobody leases the
 * parent to notice. Without this module the parent would sit on its node
 * forever, with nothing in anybody's inbox.
 *
 * So once per tick, before the controller looks for work, one pass:
 *
 * 1. reads the project's whole board (`GET /v1/jobs`);
 * 2. takes each job that is neither blocked nor cancelled, is held by its
 *    children, and has a child on the board that is blocked or cancelled;
 * 3. reads that job's graph version — memoised by id, a version is immutable —
 *    and acts only when the node it stands on is a `subgraph` node, so a parent
 *    link somebody made by hand elsewhere is never touched;
 * 4. blocks it, naming the node, the first problem child in position order, its
 *    position, and why.
 *
 * Three cases — a child that failed, one blocked on a person, one cancelled —
 * are one rule here, because all three read as `blocked` or `cancelled_at`. A
 * parent that is already blocked is skipped, so a pass is idempotent.
 *
 * **What it never does.** It never advances, unblocks or cancels anything. A
 * person who unblocks the parent while the child is still stuck sees it blocked
 * again on the next pass, with the same reason; cancelling the parent cascades
 * to the open children through the core's own cascade (t636).
 *
 * Polling, in the runner, and not a propagation inside the core: the core has
 * four places that block a job, and one sweep is one place. The cost is up to
 * one tick of latency.
 */

import type { ControlPlaneClient, GraphVersion, Job } from './control-plane-client.ts';

/** The three calls one pass makes — a structural slice of {@link ControlPlaneClient}. */
export type ChildrenWatcherClient = Pick<ControlPlaneClient, 'listJobs' | 'blockJob'> & {
  getGraphVersion(id: string, projectId?: number): Promise<GraphVersion>;
};

/** Whether a child stopped somewhere a parent cannot wait out on its own. */
function isStuck(child: Job): boolean {
  return child.blocked || (child.cancelled_at !== undefined && child.cancelled_at !== null);
}

/** The sentence a parent is blocked with. */
function reasonFor(nodeId: string, child: Job, position: number, total: number): string {
  const where = `Subgraph node \`${nodeId}\`: child job ${String(child.id)} (${String(position)} of ${String(total)})`;
  const cancelled = child.cancelled_at !== undefined && child.cancelled_at !== null;
  const cause = cancelled
    ? 'was cancelled'
    : `is blocked: ${child.block_reason ?? 'no reason was recorded'}`;
  return (
    `${where} ${cause}. The parent cannot resume until every child reaches a final node. ` +
    'Unblock or rework the child, then unblock this job — or cancel this job, which ' +
    'cancels its open children.'
  );
}

/**
 * Builds one pass of the watcher, for one project.
 *
 * @param client The controller's client.
 * @param projectId The project this runner works.
 * @returns The pass, ready for `ControllerOptions.watchChildren`.
 */
export function createChildrenWatcher(
  client: ChildrenWatcherClient,
  projectId: number,
): () => Promise<void> {
  const nodeTypes = new Map<string, Map<string, string>>();

  /** The `node_type` of every node of a version, read once per version id. */
  const nodeTypesOf = async (versionId: string): Promise<Map<string, string>> => {
    const known = nodeTypes.get(versionId);
    if (known !== undefined) return known;
    const version = await client.getGraphVersion(versionId, projectId);
    const types = new Map<string, string>();
    for (const node of version.snapshot.nodes ?? []) {
      if (typeof node.node_type === 'string') types.set(node.id, node.node_type);
    }
    nodeTypes.set(versionId, types);
    return types;
  };

  return async (): Promise<void> => {
    const jobs = await client.listJobs(projectId);
    const byId = new Map(jobs.map((job) => [job.id, job]));

    for (const parent of jobs) {
      if (parent.blocked) continue;
      if (parent.cancelled_at !== undefined && parent.cancelled_at !== null) continue;
      if (parent.dispatch_hold !== 'children') continue;
      if (parent.graph_version_id === null) continue;

      // This node's children, in position order: `children` is already ordered.
      const ofNode = (parent.children ?? [])
        .map((id) => byId.get(id))
        .filter((child): child is Job => child !== undefined)
        .filter((child) => child.parent_node_id === parent.current_node_id);
      const index = ofNode.findIndex(isStuck);
      if (index === -1) continue;

      const types = await nodeTypesOf(parent.graph_version_id);
      if (types.get(parent.current_node_id) !== 'subgraph') continue;

      await client.blockJob(
        parent.id,
        reasonFor(parent.current_node_id, ofNode[index], index + 1, ofNode.length),
      );
    }
  };
}
