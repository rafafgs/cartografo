/**
 * Where the work is standing, in the graph that was registered (t161, FR1/FR2).
 *
 * One `GET /v1/graph-versions/:id` per dispatch, and everything the dispatch
 * needs to know about the node comes out of that one read: which node it is,
 * which skill it pins, what contract it declares, and which edges leave it.
 *
 * It exists because that fetch already existed — inside `resolveEngine`, reading
 * exactly one field off the node (t141). A second consumer would have been a
 * second `GET`, and two reads of the same version in one dispatch is how the
 * engine that ran and the edge that was taken end up coming from two different
 * documents. The snapshot is immutable per version, so re-reading it would
 * usually agree; "usually" is not a property worth building routing on.
 *
 * **`null` and a rejection are different answers, and the difference is the
 * point.** A work with no `grafo_versao_id`, or one whose node the snapshot does
 * not carry, resolves to `null`: both are ordinary, and both are the shape every
 * dispatch had before graphs existed. A `grafo_versao_id` that IS set and does
 * not resolve is a dangling reference, and it propagates untouched — papering
 * over it with a default would run the work under a graph nobody registered and
 * record it as if somebody had.
 *
 * This module speaks only HTTP, through a reader the caller hands it: the runner
 * is an ordinary client of the public API, the same boundary the UI has
 * (D1, D11).
 *
 * English per D18 — including the snapshot's own field names, since the
 * 2026-08-15 amendment brought the two data formats along with the code
 * (`DECISOES.md`, D18 amendment).
 */

/** The pin a node carries to a registry skill (D4). */
export interface SkillPin {
  id: string;
  version: string;
  hash: string;
}

/** The data contract of a node: what comes in, what goes out, how it is checked. */
export interface NodeContract {
  input_schema?: unknown;
  output_schema?: unknown;
  checks?: unknown;
}

/** One node of a graph snapshot, in the part the dispatch reads. */
export interface GraphNode {
  id: string;
  /** Who does the work, in the domain's language: `arquiteto`, `tester`. */
  role?: string;
  /** `work` or `gate`. */
  node_type?: string;
  description?: string;
  /**
   * The engine declared for this node (t141, FR1). Optional by design, and
   * `unknown` because the schema leaves it free text: what refuses an
   * unregistered engine is the dispatch, not a closed enum.
   */
  engine?: unknown;
  /**
   * The model declared for this node (t166, FR4). Optional by design, and
   * `unknown` for exactly the reason `engine` is: the schema leaves it free
   * text, and what a snapshot carries is whatever was valid when it was frozen
   * — this layer reads it, it does not vouch for it.
   */
  model?: unknown;
  /**
   * When this node calls a human (t167, FR3). Optional and `unknown` for exactly
   * the same reason `engine` is: what constrains the value is the schema's enum,
   * not this layer, and absence is resolved at dispatch by
   * {@link resolveEscalationPolicy} — never at validation.
   *
   * `escalation_recipient` is deliberately NOT here. Nothing in the runner routes
   * anything to it: there is no notification and no identity system to route to,
   * so threading it through the dispatch would be carrying a field nobody reads.
   * It stays graph data, visible through `GET /v1/graph-versions/:id`.
   */
  escalation_policy?: unknown;
  /** The skill this node runs. Required by the schema; optional here so a
   * malformed snapshot degrades instead of throwing a type error. */
  skill_ref?: SkillPin;
  contract?: NodeContract;
}

/** One transition of a graph snapshot. */
export interface GraphEdge {
  from: string;
  to: string;
  /** A label, never an expression (`docs/spec/grafo.md`). */
  condition?: string;
  description?: string;
}

/** The frozen document, in the part the dispatch reads. */
export interface GraphSnapshot {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  final_nodes?: string[];
}

/** What `GET /v1/graph-versions/:id` gives back. */
export interface GraphVersionBody {
  grafo_versao: {
    id: string;
    snapshot?: GraphSnapshot;
  };
}

/** The position of a work, in the part this module reads. */
export interface JobPosition {
  no_atual: string;
  /**
   * The graph version this work traverses, when it has one (t101).
   *
   * `null` is ordinary and not a defect: a work created by hand names an entry
   * node and no graph at all.
   */
  grafo_versao_id?: string | null;
}

/** Everything one dispatch learns from the snapshot. */
export interface ResolvedNode {
  /** The version the work is traversing, as the control plane confirmed it. */
  versionId: string;
  /** The node the work is standing on RIGHT NOW — never the entry one. */
  node: GraphNode;
  /** The edges leaving that node, in document order. */
  edges: GraphEdge[];
}

/** Reads one route of the control plane, rejecting on a refusal. */
export type ReadGraphVersion = (route: string) => Promise<GraphVersionBody>;

/** The three ways a node can behave about calling a human (t167). */
export type EscalationPolicy = 'always' | 'on_uncertainty' | 'never';

/**
 * The policy a node runs under when it declares none (t167, FR1).
 *
 * Named and exported, never implicitly implied: it is today's behaviour — every
 * node that ever ran asked when it got stuck — and naming it is what makes
 * "every graph written before this field keeps behaving exactly as it did" a
 * statement somebody can check instead of a hope.
 */
export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = 'on_uncertainty';

/** The three declared values, which is what the schema's enum carries. */
const ESCALATION_POLICIES: readonly string[] = Object.freeze([
  'always',
  'on_uncertainty',
  'never',
]);

/**
 * Which escalation policy governs the node a work is standing on (t167, FR4).
 *
 * Three roads lead to {@link DEFAULT_ESCALATION_POLICY}, and all three are
 * ordinary: there is no resolvable node, the node declares nothing, or it
 * declares something that is not one of the three. That last one is not a
 * failure to report — the schema refuses a fourth value on the way in, so a
 * snapshot carrying one changed shape underneath us, and the answer is today's
 * behaviour rather than a guess at which of the three was meant.
 *
 * It lives HERE, beside the field it reads, rather than beside the dispatch that
 * consumes it: `render-skill-instructions.ts` needs the same answer to compose
 * the right paragraph, and the two modules would otherwise have had to import it
 * from each other. `dispatch-claude-code.ts` re-exports it, the same way it
 * already re-exports `ESCALATION_PROTOCOL`.
 *
 * @param resolved The node this dispatch resolved, or `null`.
 * @returns One of the three policies, always.
 */
export function resolveEscalationPolicy(resolved: ResolvedNode | null): EscalationPolicy {
  const declared = resolved?.node.escalation_policy;
  if (typeof declared !== 'string' || !ESCALATION_POLICIES.includes(declared)) {
    return DEFAULT_ESCALATION_POLICY;
  }
  return declared as EscalationPolicy;
}

/**
 * The route of one graph version.
 *
 * A function and not a template at the call site because the id is a snapshot
 * hash — `sha256:…`, with a colon in it — and a colon that is not encoded is a
 * path segment the router reads as something else.
 *
 * @param versionId Id of the version.
 * @returns The route, with the id encoded.
 */
export function graphVersionRoute(versionId: string): string {
  return `/v1/graph-versions/${encodeURIComponent(versionId)}`;
}

/**
 * Resolves the node a work is standing on, against its registered graph.
 *
 * @param job The work being dispatched.
 * @param read Reader of `GET /v1/graph-versions/:id`.
 * @returns The node and the edges leaving it, or `null` when the work has no
 *   graph or the snapshot does not carry the node.
 * @throws Whatever `read` throws — a version that does not resolve is a
 *   dangling reference and never a default.
 */
export async function resolveNode(
  job: JobPosition,
  read: ReadGraphVersion,
): Promise<ResolvedNode | null> {
  const versionId = job.grafo_versao_id;
  if (versionId === undefined || versionId === null || versionId === '') return null;

  const { grafo_versao: version } = await read(graphVersionRoute(versionId));

  const node = version.snapshot?.nodes?.find((candidate) => candidate.id === job.no_atual);
  if (node === undefined) return null;

  const edges = (version.snapshot?.edges ?? []).filter((edge) => edge.from === job.no_atual);

  return { versionId: version.id, node, edges };
}
