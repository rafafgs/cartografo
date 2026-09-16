/**
 * The map document, as plain text for a terminal (t546, D26).
 *
 * A port of `packages/screen/src/map-document.ts` — the same one block per
 * step, the same three contract fields always shown (needs, produces,
 * verified_by, each with its value or "to be defined"), a gate's exits, and
 * RF-20's external-system line only when a pinned manifest declares it. What
 * the port changes is the medium and nothing else: HTML tags become lines and
 * `- ` list items, and `escapeHtml` becomes {@link stripControlCharacters}.
 *
 * ## Copied, not imported
 *
 * `packages/core` has never depended on `packages/screen`, and this direction
 * does not reverse it — the same reason `reads.ts` copies `buildTimeline`. The
 * `MapDocument*` types below are local copies of the screen's own, same fields,
 * same optionality.
 *
 * ## Control characters, with no exception
 *
 * Every string that reaches the terminal from here — a role, a description, a
 * property name, a check's command or instruction, an edge condition, a domain
 * — was written by an agent through an API whose credential says nothing about
 * its content (D4). In a terminal the payload is not a tag but an escape
 * sequence that moves the cursor or rewrites a line already printed, so every
 * such string is stripped of ASCII control characters before it is printed.
 *
 * Pure: no HTTP, no database, never throws. A missing or malformed piece of
 * the input degrades to "to be defined" or to nothing, like the original.
 */

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

/** A node's contract; every field optional, as a draft carries it. */
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

/** A pinned skill manifest, read only for its pin and `permissions.network`. */
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

/** The defensive fallback for a check with neither recognized `type`. */
const UNRECOGNIZED_CHECK = 'check of unrecognized type, with no description';

/** The defensive fallback for an edge whose `to` is missing or malformed. */
const UNKNOWN_DESTINATION = 'unknown destination';

/** Indentation of a field under its step, and of an item under its field. */
const FIELD_INDENT = '  ';
const ITEM_INDENT = '    - ';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Removes ASCII control characters (`0x00`–`0x1F`, `0x7F`) except newline and
 * tab — the terminal's counterpart of `escapeHtml`.
 *
 * @param text Content that came from somewhere other than this CLI's own literals.
 * @returns The same text with nothing a terminal would interpret as a command.
 */
export function stripControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

/** `role`/`description`, joined for display — `undefined` when neither is declared. */
function roleDescriptionLabel(node: MapDocumentNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  const parts = [node.role, node.description]
    .filter(isFilledString)
    .map((part) => stripControlCharacters(part.trim()));
  return parts.length === 0 ? undefined : parts.join(' — ');
}

/** Whether a schema has anything to show: at least one property or one `required` entry. */
function schemaIsFilled(schema: unknown): schema is Record<string, unknown> {
  if (!isPlainObject(schema)) return false;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter(isFilledString) : [];
  return Object.keys(properties).length > 0 || required.length > 0;
}

/** Whether `contract.checks` has anything to show at all. */
function checksAreFilled(checks: unknown): checks is unknown[] {
  return Array.isArray(checks) && checks.length > 0;
}

/**
 * `needs:`/`produces:` — "to be defined" on the same line, or one item per
 * property: `<title> (<name>)` or `<name>`, then its type, then `required`.
 */
function renderSchemaField(label: string, schema: unknown): string[] {
  if (!schemaIsFilled(schema)) return [`${FIELD_INDENT}${label}: ${TO_BE_DEFINED}`];

  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const propertyNames = Object.keys(properties);
  const required = Array.isArray(schema.required) ? schema.required.filter(isFilledString) : [];
  const names = [...propertyNames, ...required.filter((name) => !propertyNames.includes(name))];

  const items = names.map((name) => {
    const definition = properties[name];
    const type = isPlainObject(definition) && isFilledString(definition.type) ? definition.type : undefined;
    const title = isPlainObject(definition) && isFilledString(definition.title) ? definition.title : undefined;
    const namePart =
      title !== undefined
        ? `${stripControlCharacters(title)} (${stripControlCharacters(name)})`
        : stripControlCharacters(name);
    const typePart = type !== undefined ? ` ${stripControlCharacters(type)}` : '';
    const requiredPart = required.includes(name) ? ' [required]' : '';
    return `${ITEM_INDENT}${namePart}${typePart}${requiredPart}`;
  });
  return [`${FIELD_INDENT}${label}:`, ...items];
}

/** One `contract.checks` entry, as one item. */
function renderCheck(check: unknown): string {
  if (!isPlainObject(check)) return `${ITEM_INDENT}${UNRECOGNIZED_CHECK}`;

  if (check.type === 'deterministic') {
    const command = isFilledString(check.command) ? stripControlCharacters(check.command) : '';
    const description = isFilledString(check.description) ? ` — ${stripControlCharacters(check.description)}` : '';
    return `${ITEM_INDENT}${command}${description}`;
  }

  if (check.type === 'agentic') {
    const instruction = isFilledString(check.instruction) ? stripControlCharacters(check.instruction) : '';
    return `${ITEM_INDENT}${instruction} (${AGENTIC_VERIFICATION_NOTE})`;
  }

  const description = isFilledString(check.description) ? stripControlCharacters(check.description) : UNRECOGNIZED_CHECK;
  return `${ITEM_INDENT}${description}`;
}

/** `verified_by:` ← `contract.checks`. */
function renderChecks(checks: unknown): string[] {
  if (!checksAreFilled(checks)) return [`${FIELD_INDENT}verified_by: ${TO_BE_DEFINED}`];
  return [`${FIELD_INDENT}verified_by:`, ...checks.map(renderCheck)];
}

/** A gate's `exits:` — every edge leaving it, `[description — ]condition → destination (label)`. */
function renderExits(node: MapDocumentNode, edges: MapDocumentEdge[], nodesById: Map<string, MapDocumentNode>): string[] {
  const outgoing = edges.filter((edge) => isFilledString(edge.from) && edge.from === node.id);
  if (outgoing.length === 0) return [`${FIELD_INDENT}exits: ${NO_EXIT_DECLARED}`];

  const items = outgoing.map((edge) => {
    const condition = isFilledString(edge.condition) ? stripControlCharacters(edge.condition) : TO_BE_DEFINED;
    const destinationId = isFilledString(edge.to) ? edge.to : undefined;
    const destinationText = destinationId !== undefined ? stripControlCharacters(destinationId) : UNKNOWN_DESTINATION;
    const destinationLabel = destinationId !== undefined ? roleDescriptionLabel(nodesById.get(destinationId)) : undefined;
    const destination = destinationLabel === undefined ? destinationText : `${destinationText} (${destinationLabel})`;
    const description = isFilledString(edge.description) ? `${stripControlCharacters(edge.description)} — ` : '';
    return `${ITEM_INDENT}${description}${condition} → ${destination}`;
  });
  return [`${FIELD_INDENT}exits:`, ...items];
}

/** Whether a node's `skill_ref` matches a manifest's pin on all three of id, version and hash (D4). */
function matchesPin(skillRef: MapDocumentSkillRef | undefined, manifest: MapDocumentManifest): boolean {
  if (skillRef === undefined || !isPlainObject(skillRef)) return false;
  return (
    isFilledString(skillRef.id) &&
    isFilledString(skillRef.version) &&
    isFilledString(skillRef.hash) &&
    skillRef.id === manifest.id &&
    skillRef.version === manifest.version &&
    skillRef.hash === manifest.hash
  );
}

/** RF-20's line, only when a pinned manifest allows the network; nothing otherwise. */
function renderNetworkLine(node: MapDocumentNode, manifests: MapDocumentManifest[] | undefined): string[] {
  if (!Array.isArray(manifests)) return [];
  const manifest = manifests.find((candidate) => isPlainObject(candidate) && matchesPin(node.skill_ref, candidate));
  if (manifest === undefined) return [];

  const network = manifest.permissions?.network;
  if (!isPlainObject(network) || network.allowed !== true) return [];

  const domains = Array.isArray(network.domains) ? network.domains.filter(isFilledString) : [];
  const domainsPart = domains.length > 0 ? `: ${domains.map(stripControlCharacters).join(', ')}` : '';
  return [`${FIELD_INDENT}reaches an external system${domainsPart}`];
}

/** One step's block. */
function renderNode(
  node: MapDocumentNode,
  position: number,
  edges: MapDocumentEdge[],
  nodesById: Map<string, MapDocumentNode>,
  manifests: MapDocumentManifest[] | undefined,
): string[] {
  const safeNode = isPlainObject(node) ? node : ({ id: '' } as MapDocumentNode);
  const contract = isPlainObject(safeNode.contract) ? safeNode.contract : undefined;
  const id = isFilledString(safeNode.id) ? stripControlCharacters(safeNode.id) : '';
  const heading = roleDescriptionLabel(safeNode) ?? id;

  return [
    `step ${position}: ${heading}`,
    ...renderSchemaField('needs', contract?.input_schema),
    ...renderSchemaField('produces', contract?.output_schema),
    ...renderChecks(contract?.checks),
    ...(safeNode.node_type === 'gate' ? renderExits(safeNode, edges, nodesById) : []),
    ...renderNetworkLine(safeNode, manifests),
  ];
}

/**
 * Turns a graph document into the map as text: one block per step, in
 * `graph.nodes` array order, a blank line between blocks. No trailing newline.
 *
 * @param graph The draft's graph.
 * @param manifests The draft's manifests, for RF-20's line.
 * @returns The map, never throwing.
 */
export function renderMapText(graph: MapDocumentGraph, manifests?: MapDocumentManifest[]): string {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges.filter(isPlainObject) : [];
  const nodesById = new Map(
    nodes.filter((node) => isPlainObject(node) && isFilledString(node.id)).map((node) => [node.id, node]),
  );

  return nodes
    .map((node, index) => renderNode(node, index + 1, edges, nodesById, manifests).join('\n'))
    .join('\n\n');
}

/** A node counts as defined when all three of its contract fields are filled. */
function nodeIsDefined(node: MapDocumentNode): boolean {
  if (!isPlainObject(node)) return false;
  const contract = node.contract;
  if (!isPlainObject(contract)) return false;
  return schemaIsFilled(contract.input_schema) && schemaIsFilled(contract.output_schema) && checksAreFilled(contract.checks);
}

/**
 * "How far it is", in one line — the same three states as the screen's
 * `renderStepProgress`, derived and never asked for.
 *
 * @param graph The draft's graph.
 * @returns The line, never throwing.
 */
export function renderStepProgressText(graph: MapDocumentGraph): string {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const total = nodes.length;
  const defined = nodes.filter(nodeIsDefined).length;

  const enumerated =
    isFilledString(graph?.initial_node) && Array.isArray(graph?.final_nodes) && graph.final_nodes.length > 0;

  if (!enumerated) return `${total} steps so far`;
  if (defined < total) return `step ${defined} of ${total} · ${total - defined} still to define`;
  return `${total} of ${total} defined`;
}
