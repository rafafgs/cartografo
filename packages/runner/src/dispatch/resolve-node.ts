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
 * point.** A work with no `graph_version_id`, or one whose node the snapshot does
 * not carry, resolves to `null`: both are ordinary, and both are the shape every
 * dispatch had before graphs existed. A `graph_version_id` that IS set and does
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
 * (`DECISIONS.md`, D18 amendment).
 */

/**
 * One external input a node declares, as t369's format writes it (t370, FR4).
 *
 * The runner is the first and only consumer of this field — t369's own conflict
 * surface never reaches this package — so declaring it here is this ticket's
 * job. It is typed LOOSELY on the free-text halves, the same posture `engine`
 * and `model` already take one screen below: what refuses a malformed
 * declaration is the registration gate, and this layer reads a snapshot that
 * has already been through it.
 *
 * `arguments` carries `{{input.<path>}}` placeholders and is interpolated
 * against the node's own input before the call, by the same `interpolate()`
 * every other placeholder in this package goes through. `as` is the path,
 * relative to the session's working directory, the fetched bytes are written
 * to.
 */
export interface ExternalInputDeclaration {
  /** The key this input appears under, at `input.external.<name>`. */
  name?: string;
  /** The MCP server, by the name discovery gives it. */
  server?: string;
  /** The tool to call on that server. */
  tool?: string;
  /** The arguments of the call, before interpolation. */
  arguments?: Record<string, unknown>;
  /** Where the result lands, relative to the session's working directory. */
  as?: string;
}

/**
 * One external OUTPUT a node declares, as t369's format writes it (t371, FR2).
 *
 * The mirror image of {@link ExternalInputDeclaration}, typed with the same
 * looseness and for the same reason: what refuses a malformed declaration is
 * the registration gate, and this layer reads a snapshot that has already been
 * through it.
 *
 * `from` names a property of the PINNED SKILL's `output` — the value that is
 * sent — and `arguments` carries `{{input.<path>}}` placeholders resolved
 * against the delivery's own context rather than against the node's input:
 * `{{input.job.id}}` and `{{input.output.<property>}}`, which is what
 * `docs/spec/mcp-client.md` §9 spells out. There is no `as`: nothing lands on
 * disk on the way out.
 */
export interface ExternalOutputDeclaration {
  /** What this delivery is called, unique within `outputs`. */
  name?: string;
  /** The MCP server, by the name discovery gives it. */
  server?: string;
  /** The tool to call on that server. */
  tool?: string;
  /** The arguments of the call, before interpolation. */
  arguments?: Record<string, unknown>;
  /** Which property of the accepted report is delivered. */
  from?: string;
}

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
  /**
   * The bucket this node's structured output accumulates into, in the `input`
   * of the nodes downstream of it (t253).
   *
   * Declared here so the runner's read of the snapshot stays in step with the
   * control plane's, and READ-ONLY on this side: what acts on it is
   * `GET /v1/jobs/:id/context`, which is the control plane's own projection
   * (`packages/core/src/domain/context.ts`, D1 — the sole writer is the one
   * place that can assemble it without a second round trip). Since t259 the
   * dispatch READS that route (`resolve-input.ts`), so the field is live end to
   * end; nothing here interprets it all the same.
   *
   * Optional, and absence means "merge at the top level" — the behaviour every
   * graph written before the field already has.
   */
  produces?: string;
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
  /**
   * What this node needs from outside, fetched before the session (t370, FR4).
   *
   * Optional, and absence means the node declares none — which is every graph
   * written before the field existed, and which resolves `input.external` to an
   * empty object rather than to a refusal. Optional on `inputs` too, for the
   * same reason: a drawer somebody opened and left empty is not a defect.
   */
  external?: { inputs?: ExternalInputDeclaration[]; outputs?: ExternalOutputDeclaration[] };
  /**
   * Whether repeating this step is safe (t369; read here by t371).
   *
   * Absent means `false`, which is every graph written before the field and
   * every step whose effects stay inside this system. `true` says the step has
   * an effect outside that cannot be deferred — a delivery already made is not
   * undone by running the node again — and what ACTS on it is the delivery step
   * (`src/mcp/write-external-outputs.ts`): one attempt, no ladder, and a person
   * asked rather than a second call made.
   *
   * `unknown` for the reason `engine` and `model` above are: the schema is what
   * refuses a non-boolean, and this layer reads a snapshot rather than vouching
   * for one. {@link isUnsafeToRetry} is what turns it into an answer.
   */
  unsafe_to_retry?: unknown;
}

/** One transition of a graph snapshot. */
export interface GraphEdge {
  from: string;
  to: string;
  /** A label, never an expression (`docs/spec/graph.md`). */
  condition?: string;
  description?: string;
}

/** The frozen document, in the part the dispatch reads. */
export interface GraphSnapshot {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  final_nodes?: string[];
  /**
   * The class's static configuration, which the projection publishes at
   * `input.project` (t253).
   *
   * Here for the same reason `NodeContract.produces` is, and with the same
   * standing: the runner reads the document and does not act on this key — the
   * object that reaches a session comes from `GET /v1/jobs/:id/context`, whole.
   * Optional, and absence means the class declares none, which projects `{}`.
   */
  project?: Record<string, unknown>;
}

/** What `GET /v1/graph-versions/:id` gives back. */
export interface GraphVersionBody {
  graph_version: {
    id: string;
    snapshot?: GraphSnapshot;
  };
}

/** The position of a work, in the part this module reads. */
export interface JobPosition {
  current_node_id: string;
  /**
   * The graph version this work traverses, when it has one (t101).
   *
   * `null` is ordinary and not a defect: a work created by hand names an entry
   * node and no graph at all.
   */
  graph_version_id?: string | null;
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
 * from each other. `dispatch.ts` re-exports it, the same way it
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
  const versionId = job.graph_version_id;
  if (versionId === undefined || versionId === null || versionId === '') return null;

  const { graph_version: version } = await read(graphVersionRoute(versionId));

  const node = version.snapshot?.nodes?.find((candidate) => candidate.id === job.current_node_id);
  if (node === undefined) return null;

  const edges = (version.snapshot?.edges ?? []).filter((edge) => edge.from === job.current_node_id);

  return { versionId: version.id, node, edges };
}

/**
 * Whether the node a work is standing on may simply be run again (t369, t371).
 *
 * Named and exported for {@link resolveEscalationPolicy}'s reason, one step
 * stronger: the default here is the permissive one, so a reader who assumed it
 * would be reading the safe answer has to be shown that it is not. Absent is
 * `false` — every graph written before the field, and every step whose effects
 * stay inside this system — and anything that is not the literal `true` is
 * `false` too, because the schema refuses a non-boolean on the way in and the
 * answer to a snapshot that changed shape underneath us is today's behaviour.
 *
 * @param resolved The node the work is standing on, or `null`.
 * @returns `true` only when the map says so, in the one spelling it accepts.
 */
export function isUnsafeToRetry(resolved: ResolvedNode | null): boolean {
  return resolved?.node.unsafe_to_retry === true;
}
