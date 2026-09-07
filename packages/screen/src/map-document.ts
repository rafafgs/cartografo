/**
 * The map document: one rendering of a graph as the vertical procedure
 * document §3.4 of the requirements describes (`~/cartografo-strategy/
 * cartografo-requisitos.html` v2.7, RF-22, RF-23) — one block per step, the
 * three contract fields always shown (needs, produces, verified by, each with
 * its value or "to be defined", never hidden, never collapsed), a gate's
 * exits, and the whole thing reading top to bottom with nothing to open,
 * expand or drag.
 *
 * ## The needs/produces/verified-by projection
 *
 * The graph schema (`schema/graph.schema.json`) carries `contract.input_schema`,
 * `contract.output_schema` and `contract.checks` — not fields literally named
 * needs/produces/verified_by — plus an unrelated `contract.produces`, the name
 * of the BUCKET a node's output merges into for the next node's input
 * (t253). This module never reads that field: needs ← `input_schema`,
 * produces ← `output_schema`, verified by ← `checks`, and the bucket name
 * stays out of the document entirely (Out of Scope).
 *
 * ## "To be defined" versus "empty/unfilled"
 *
 * A graph mid-interview (t360) is expected to carry partial contracts for a
 * while: `input_schema: {}`, `checks: []`, or no `contract` key at all on a
 * node the interview has not reached. Each of the three fields renders "to be
 * defined" independently rather than throwing or fabricating a value — the
 * same posture `./public/graph-soundness.js`'s own doc comment states for its
 * report.
 *
 * ## External I/O (RF-20), only "when declared"
 *
 * RF-20 asks the interview to name which steps reach external systems and
 * through which MCP server, but neither the graph schema nor the interview
 * engine (t360, in flight) gives that fact a home on the graph document
 * itself. The one place it already lives is the pinned skill manifest's
 * `permissions.network` (`specs/formats/skill-manifest.schema.json`). This
 * module therefore takes an optional `manifests` argument rather than
 * reaching for a registry — the graph document alone can never answer this
 * question — and matches each node's `skill_ref` against it by the full pin
 * (`id`+`version`+`hash` all three, D4's own discipline against a silent
 * swap). No match, no `manifests` argument, or `permissions.network.allowed`
 * not `true`: the line is omitted entirely, never "to be defined", since the
 * spec frames it as "when declared" rather than as one of the three
 * always-shown fields.
 *
 * ## Escaping, with no exception
 *
 * Every value that reaches the returned HTML — `role`, `description`, a
 * property name, a check's `command`/`instruction`/`description`, an edge
 * `condition`, a manifest domain — was written by an agent through an API
 * whose credential says nothing about the content it carries, and passes
 * through `escapeHtml` (imported from `./pages.ts`, D4 treating agent content
 * as an injection vector the same way that module's own doc comment does for
 * job titles and question text).
 *
 * Pure and framework-free, in the same spirit as `./public/graph-soundness.js`
 * and `./pages.ts`'s `escapeHtml`: no HTTP route, no dependency on
 * `packages/core` or on the interview engine. Wiring this renderer into a page
 * — the growing map inside the interview, and the read-only view of an
 * already-registered graph — is t433's job.
 */

import { escapeHtml } from './pages.ts';

/** The pin of a skill in the registry (D4): id, version and hash all three. */
export interface MapDocumentSkillRef {
  id?: unknown;
  version?: unknown;
  hash?: unknown;
}

/** One entry of `contract.checks`, as loosely typed as an in-progress draft can be. */
export interface MapDocumentCheck {
  type?: unknown;
  command?: unknown;
  instruction?: unknown;
  description?: unknown;
}

/** `contract.input_schema`/`output_schema`, read only for what this document needs from it. */
export interface MapDocumentSchema {
  properties?: Record<string, { type?: unknown; title?: unknown } | undefined>;
  required?: unknown[];
}

/**
 * A node's contract. Every field is optional: a node the interview has not
 * reached yet may carry no `contract` key at all, and one it has just started
 * may carry empty-but-present schemas and an empty checks list.
 */
export interface MapDocumentContract {
  input_schema?: unknown;
  output_schema?: unknown;
  checks?: unknown;
}

/** One step of the graph document. */
export interface MapDocumentNode {
  id: string;
  role?: unknown;
  description?: unknown;
  node_type?: unknown;
  skill_ref?: MapDocumentSkillRef;
  contract?: MapDocumentContract;
}

/** One edge of the graph document — a gate's exit, in this document's own vocabulary. */
export interface MapDocumentEdge {
  from?: unknown;
  to?: unknown;
  condition?: unknown;
  description?: unknown;
}

/** The graph document this module renders. */
export interface MapDocumentGraph {
  nodes: MapDocumentNode[];
  edges?: MapDocumentEdge[];
  initial_node?: unknown;
  final_nodes?: unknown;
}

/**
 * A pinned skill manifest, read only for the one thing this document asks of
 * it: the pin itself, and `permissions.network`
 * (`specs/formats/skill-manifest.schema.json`).
 */
export interface MapDocumentManifest {
  id?: unknown;
  version?: unknown;
  hash?: unknown;
  permissions?: {
    network?: {
      allowed?: unknown;
      domains?: unknown[];
    };
  };
}

/** Shown for a contract field with nothing declared yet. */
const TO_BE_DEFINED = 'to be defined';

/** Shown for a gate with no outgoing edge in the document. */
const NO_EXIT_DECLARED = 'no exit declared yet';

/** The fixed trailing note on every agentic check (mirrors the checks table, D9). */
const AGENTIC_VERIFICATION_NOTE = "verified with its own evidence, never the worker's own report";

/** The defensive fallback for a check with neither recognized `type`, mirroring graph-soundness.js. */
const UNRECOGNIZED_CHECK = 'check of unrecognized type, with no description';

/** The defensive fallback for an edge whose `to` is missing or malformed. */
const UNKNOWN_DESTINATION = 'unknown destination';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * `role`/`description`, joined for display — `undefined` when neither is
 * declared.
 *
 * Exported so `pages.ts` can reuse this exact §7.1 fallback rule for `/board`'s
 * step line (t463) rather than reimplementing the join a surface over.
 */
export function roleDescriptionLabel(node: MapDocumentNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  const parts = [node.role, node.description].filter(isFilledString).map((part) => escapeHtml(part.trim()));
  return parts.length === 0 ? undefined : parts.join(' — ');
}

/** The block's heading: role/description when present, the bare id otherwise (FR2). */
function nodeHeading(node: MapDocumentNode): string {
  return roleDescriptionLabel(node) ?? escapeHtml(node.id);
}

/**
 * Whether a `contract.input_schema`/`output_schema` has anything to show at
 * all — a plain object with at least one declared property or one `required`
 * entry. Extracted (FR8) so the step-progress count can never disagree with
 * what `renderSchemaField` itself decides is "to be defined".
 */
function schemaIsFilled(schema: unknown): schema is Record<string, unknown> {
  if (!isPlainObject(schema)) return false;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  const required = Array.isArray(schema.required) ? schema.required.filter(isFilledString) : [];
  return propertyNames.length > 0 || required.length > 0;
}

/**
 * `needs`/`produces`, by the identical rule (FR3): a property list, each name
 * marked `required` when it appears in the schema's own `required`, with its
 * declared `type` shown beside it when present. "To be defined" when the
 * schema is absent, not an object, or has neither a property nor a required
 * entry to show.
 *
 * A property whose `title` is a filled string leads with that display name,
 * demoting the key itself to a secondary mono token (FR2); a property with no
 * `title` renders exactly as before — no derived label, ever (FR4).
 */
function renderSchemaField(schema: unknown): string {
  if (!schemaIsFilled(schema)) return TO_BE_DEFINED;

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  const required = Array.isArray(schema.required) ? schema.required.filter(isFilledString) : [];

  const names = [...propertyNames, ...required.filter((name) => !propertyNames.includes(name))];
  const items = names.map((name) => {
    const propertyDef = properties[name];
    const type = isPlainObject(propertyDef) && isFilledString(propertyDef.type) ? propertyDef.type : undefined;
    const typePart = type !== undefined ? ` <code>${escapeHtml(type)}</code>` : '';
    const requiredPart = required.includes(name) ? ' <span class="required">required</span>' : '';
    const title = isPlainObject(propertyDef) && isFilledString(propertyDef.title) ? propertyDef.title : undefined;
    const namePart =
      title !== undefined
        ? `<span class="display-name">${escapeHtml(title)}</span> <code class="secondary-token">${escapeHtml(name)}</code>`
        : escapeHtml(name);
    return `<li>${namePart}${typePart}${requiredPart}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

/** One `contract.checks` entry, rendered per its `type` (FR3's third bullet). */
function renderCheck(check: unknown): string {
  if (!isPlainObject(check)) return `<li>${UNRECOGNIZED_CHECK}</li>`;

  if (check.type === 'deterministic') {
    const command = isFilledString(check.command) ? check.command : '';
    const description = isFilledString(check.description) ? ` ${escapeHtml(check.description)}` : '';
    return `<li><code>${escapeHtml(command)}</code>${description}</li>`;
  }

  if (check.type === 'agentic') {
    const instruction = isFilledString(check.instruction) ? check.instruction : '';
    return `<li>${escapeHtml(instruction)} <span class="agentic-note">${AGENTIC_VERIFICATION_NOTE}</span></li>`;
  }

  const description = isFilledString(check.description) ? escapeHtml(check.description) : UNRECOGNIZED_CHECK;
  return `<li>${description}</li>`;
}

/**
 * Whether `contract.checks` has anything to show at all. Extracted (FR8)
 * for the same reason as `schemaIsFilled`.
 */
function checksAreFilled(checks: unknown): checks is unknown[] {
  return Array.isArray(checks) && checks.length > 0;
}

/** `verified_by` ← `contract.checks`: "to be defined" when empty or absent, one line per check otherwise. */
function renderChecks(checks: unknown): string {
  if (!checksAreFilled(checks)) return TO_BE_DEFINED;
  return `<ul>${checks.map(renderCheck).join('')}</ul>`;
}

/**
 * A gate's exits (FR4): every edge leaving this node, or the fixed
 * placeholder when there is none. An edge whose `description` is a filled
 * string leads with that sentence, demoting `condition` to a secondary mono
 * token (FR5); an edge with no `description` renders exactly as before (FR6).
 */
function renderExits(node: MapDocumentNode, edges: MapDocumentEdge[], nodesById: Map<string, MapDocumentNode>): string {
  const outgoing = edges.filter((edge) => isFilledString(edge.from) && edge.from === node.id);

  if (outgoing.length === 0) {
    return `<div data-field="exits"><p>${NO_EXIT_DECLARED}</p></div>`;
  }

  const items = outgoing.map((edge) => {
    const condition = isFilledString(edge.condition) ? escapeHtml(edge.condition) : TO_BE_DEFINED;
    const destinationId = isFilledString(edge.to) ? edge.to : undefined;
    const destinationIdHtml = destinationId !== undefined ? escapeHtml(destinationId) : UNKNOWN_DESTINATION;
    const destinationLabel = destinationId !== undefined ? roleDescriptionLabel(nodesById.get(destinationId)) : undefined;
    const destination = destinationLabel === undefined ? destinationIdHtml : `${destinationIdHtml} (${destinationLabel})`;
    const description = isFilledString(edge.description) ? edge.description : undefined;
    const exitPart =
      description !== undefined
        ? `<span class="exit-sentence">${escapeHtml(description)}</span> <code class="secondary-token">${condition}</code> → ${destination}`
        : `${condition} → ${destination}`;
    return `<li>${exitPart}</li>`;
  });
  return `<div data-field="exits"><ul>${items.join('')}</ul></div>`;
}

/** Whether a node's `skill_ref` matches a manifest's pin on all three of id, version and hash (D4). */
function matchesPin(skillRef: MapDocumentSkillRef | undefined, manifest: MapDocumentManifest): boolean {
  if (skillRef === undefined) return false;
  return (
    isFilledString(skillRef.id) &&
    isFilledString(skillRef.version) &&
    isFilledString(skillRef.hash) &&
    skillRef.id === manifest.id &&
    skillRef.version === manifest.version &&
    skillRef.hash === manifest.hash
  );
}

/**
 * RF-20's external-I/O line (FR5): only when a manifest matches the node's
 * pinned `skill_ref` on all three fields and its `permissions.network.allowed`
 * is `true`. Every other case renders nothing — this is a "when declared"
 * line, never a "to be defined" one.
 */
function renderNetworkLine(node: MapDocumentNode, manifests: MapDocumentManifest[] | undefined): string {
  if (!Array.isArray(manifests)) return '';
  const manifest = manifests.find((candidate) => isPlainObject(candidate) && matchesPin(node.skill_ref, candidate));
  if (manifest === undefined) return '';

  const network = manifest.permissions?.network;
  if (!isPlainObject(network) || network.allowed !== true) return '';

  const domains = Array.isArray(network.domains) ? network.domains.filter(isFilledString) : [];
  const domainsPart = domains.length > 0 ? `: ${domains.map((domain) => escapeHtml(domain)).join(', ')}` : '';
  return `<div data-field="network"><p>reaches an external system${domainsPart}</p></div>`;
}

/** One `<li data-step>` block, everything FR2–FR5 ask of a single node. */
function renderNode(
  node: MapDocumentNode,
  edges: MapDocumentEdge[],
  nodesById: Map<string, MapDocumentNode>,
  manifests: MapDocumentManifest[] | undefined,
): string {
  const contract = isPlainObject(node.contract) ? node.contract : undefined;
  const needs = renderSchemaField(contract?.input_schema);
  const produces = renderSchemaField(contract?.output_schema);
  const verifiedBy = renderChecks(contract?.checks);
  const exits = node.node_type === 'gate' ? renderExits(node, edges, nodesById) : '';
  const network = renderNetworkLine(node, manifests);

  return (
    `<li data-step="${escapeHtml(node.id)}">` +
    `<h3>${nodeHeading(node)}</h3>` +
    `<div data-field="needs">${needs}</div>` +
    `<div data-field="produces">${produces}</div>` +
    `<div data-field="verified_by">${verifiedBy}</div>` +
    exits +
    network +
    `</li>`
  );
}

/**
 * Turns a graph document into the map document fragment: an `<ol>` whose
 * items are the per-step blocks, in `graph.nodes` array order (FR8) — no
 * `<html>`/`<head>`, ready for a consumer page to drop straight into a column
 * or a card.
 *
 * `manifests` is the one piece this document cannot answer on its own
 * (RF-20's external-I/O line); every other field is read from `graph` alone.
 * Never throws: a missing or malformed piece of the input degrades to
 * "to be defined" (or, for the network line, to nothing).
 */
export function renderMapDocument(graph: MapDocumentGraph, manifests?: MapDocumentManifest[]): string {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const nodesById = new Map(nodes.filter((node) => isFilledString(node?.id)).map((node) => [node.id, node]));

  const items = nodes.map((node) => renderNode(node, edges, nodesById, manifests));
  return `<ol>${items.join('')}</ol>`;
}

/**
 * Whether a node counts as "defined" for the step-progress line (FR8): a
 * plain-object `contract` whose `input_schema` and `output_schema` are both
 * `schemaIsFilled` and whose `checks` is `checksAreFilled` — the identical
 * rule the node's own three fields already use to decide "to be defined", so
 * the count can never disagree with what the block itself shows.
 */
function nodeIsDefined(node: MapDocumentNode): boolean {
  const contract = node.contract;
  if (!isPlainObject(contract)) return false;
  return schemaIsFilled(contract.input_schema) && schemaIsFilled(contract.output_schema) && checksAreFilled(contract.checks);
}

/**
 * "How far it is" (FR10): a single line above the map, derived rather than
 * asked for, so it can never disagree with what the steps themselves show.
 *
 * Three states, in the founder's own exact wording, no percentage anywhere:
 * - not yet enumerated (`initial_node`/`final_nodes` not both settled) — a
 *   bare count of steps seen so far;
 * - enumerated but incomplete — how many of the known total are defined;
 * - enumerated and complete — all of them are.
 *
 * Never throws (FR11): `graph.nodes` not being an array reads as `total = 0`,
 * the same defensive read `renderMapDocument` itself makes.
 */
export function renderStepProgress(graph: MapDocumentGraph): string {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const total = nodes.length;
  const defined = nodes.filter(nodeIsDefined).length;

  const enumerated = isFilledString(graph?.initial_node) && Array.isArray(graph?.final_nodes) && graph.final_nodes.length > 0;

  if (!enumerated) {
    return `<p class="map-progress" data-panel="step-progress">${total} steps so far</p>`;
  }
  if (defined < total) {
    return `<p class="map-progress" data-panel="step-progress">step ${defined} of ${total} · ${total - defined} still to define</p>`;
  }
  return `<p class="map-progress" data-panel="step-progress">${total} of ${total} defined</p>`;
}
