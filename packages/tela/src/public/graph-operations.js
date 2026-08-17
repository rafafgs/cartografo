/**
 * The diff between the snapshot the page loaded and the state it is showing
 * (t170, FR4).
 *
 * A graph never moves because someone saved a document: it moves because a
 * PROPOSAL was applied, and a proposal is a list of typed semantic operations,
 * each carrying its own inverse (D15). So the editor's whole job on save is to
 * say, in that vocabulary, what changed — and that is this function. Whatever
 * comes out of here goes to `POST /v1/proposals` untouched; there is no second
 * path into the graph, and this module existing separately is what makes that
 * checkable (`test/graph-operations.test.ts`).
 *
 * Pure and side-effect free, for the same reason as `actions.js` and `diff.js`:
 * it runs in the browser and is tested in Node.
 *
 * ## The order is not cosmetic
 *
 * `applyOperations` runs the list in order over one document, and refuses an
 * operation the snapshot does not admit (removing a node that is not there is
 * an error, not a no-op). So the sequence is emitted in the one order that
 * always applies:
 *
 * 1. edges removed — before the nodes they touch leave;
 * 2. nodes removed;
 * 3. nodes added — before an edge can point at them;
 * 4. fields changed on the nodes that stayed;
 * 5. edges added.
 *
 * ## What is NOT here
 *
 * There is no operation that changes an edge, so an edge whose `condition` or
 * `description` was edited comes out as a removal followed by an addition —
 * which is exactly what it is for a format that identifies an edge by its two
 * ends and the condition it carries (`endsOf`). And there is no operation that renames a node: `id` and `node_type` are
 * the node's identity (`CHANGEABLE_FIELDS` in
 * `packages/core/src/domain/operations.ts` says so in its own comment), which
 * is why the page offers no control for them and this diff never looks at them.
 *
 * The operation keys (`type`, `node`, `node_id`, `edge`, `field`, `from`, `to`,
 * `inverse`) are the format stored in `proposta.operacoes` and returned on the
 * wire, and they speak `docs/spec/glossario-wire.md` §3 since D20's third child
 * (t228). This module has to move in exact lockstep with
 * `packages/core/src/domain/operations.ts`: whatever comes out of here is POSTed
 * untouched, so one key out of step is a `400` on save.
 */

/**
 * Node fields this editor may swap on a node that already exists.
 *
 * A SUBSET of the core's `CHANGEABLE_FIELDS`, and deliberately so: `engine`,
 * `model`, `escalation_policy` and `escalation_recipient` are execution policy,
 * and editing them is the separate "Per-node execution policies" ticket, which
 * has a schema to design first. What is here is the topology slice — who does
 * the work (`role`), what the step is (`description`), and the two halves of
 * the contract that make it verifiable (`skill_ref`, `contract`).
 *
 * The order is the order the operations come out in, so a diff of the same edit
 * is always the same list.
 */
export const EDITABLE_NODE_FIELDS = Object.freeze([
  'role',
  'description',
  'skill_ref',
  'contract',
]);

/** Fields of a node that are frozen once it exists; only remove and re-add. */
export const FROZEN_NODE_FIELDS = Object.freeze(['id', 'node_type', 'engine']);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `nodes`/`edges` list of a document, never `undefined`. */
function listOf(document, key) {
  const found = isObject(document) ? document[key] : undefined;
  return Array.isArray(found) ? found.filter(isObject) : [];
}

/** A deep copy that never shares a reference with the page's own state. */
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Structural equality, with the key order of an object left out of it.
 *
 * `JSON.stringify` alone would call `{a:1,b:2}` and `{b:2,a:1}` different, and
 * a `contract` retyped in another order is not a change anybody made.
 *
 * @param {unknown} one
 * @param {unknown} other
 * @returns {boolean}
 */
function same(one, other) {
  if (one === other) return true;
  if (Array.isArray(one) || Array.isArray(other)) {
    if (!Array.isArray(one) || !Array.isArray(other) || one.length !== other.length) return false;
    return one.every((item, index) => same(item, other[index]));
  }
  if (isObject(one) && isObject(other)) {
    const keys = Object.keys(one);
    if (keys.length !== Object.keys(other).length) return false;
    return keys.every((key) => Object.hasOwn(other, key) && same(one[key], other[key]));
  }
  return false;
}

/**
 * The value of a field for comparison AND for the operation.
 *
 * `description` is optional in the document, so a node that never had one and a
 * node whose text was cleared have to read the same — otherwise every node
 * without a description would produce a spurious operation the moment the page
 * drew an empty field for it. The empty string is what goes on the wire in
 * both directions: `undefined` would be dropped by `JSON.stringify` and reach
 * the core as a missing `para`, which is a `400`, not a change.
 *
 * @param {Record<string, unknown>} node
 * @param {string} field
 * @returns {unknown}
 */
function fieldOf(node, field) {
  const value = node[field];
  if (field === 'description' || field === 'role') return typeof value === 'string' ? value : '';
  return value;
}

/** `from` → `to` for one field, plus the inverse that undoes it. */
function changeField(nodeId, field, before, after) {
  return {
    type: 'change_node_field',
    node_id: nodeId,
    field,
    from: copy(before),
    to: copy(after),
    inverse: {
      type: 'change_node_field',
      node_id: nodeId,
      field,
      from: copy(after),
      to: copy(before),
    },
  };
}

/**
 * How an edge is identified on removal: the two ends AND the condition.
 *
 * The condition is part of the reference since t205, and it has to be. Nothing
 * in the schema, in the soundness rules or in this page forbids two edges
 * between the same pair of nodes with different conditions — they are two
 * outcomes of the same step, and the page draws a card for each — so a removal
 * naming only the ends cannot say which of the two it means. The core takes the
 * condition as optional and falls back to the first edge between those ends
 * when it is absent, which is what keeps every operation stored before t205
 * applying exactly as it did.
 *
 * Normalized to text for the same reason `fieldOf` normalizes `description`: an
 * edge whose label was never filled and one whose label was cleared have to
 * read the same, and `undefined` would be dropped by `JSON.stringify` on the
 * way to the API.
 */
function endsOf(edge) {
  return {
    from: String(edge.from ?? ''),
    to: String(edge.to ?? ''),
    condition: String(edge.condition ?? ''),
  };
}

/**
 * Key of an edge in a map: the three fields that identify it.
 *
 * Joined by NUL because a node id or a condition may carry any other character:
 * with a printable separator, an id ending in it and the next field would be
 * indistinguishable from one long id. Written as an escape rather than as the
 * literal control byte it used to be — with the byte in the source, git read
 * this file as binary and showed no diff of it at all.
 */
function edgeKey(edge) {
  const ends = endsOf(edge);
  return `${ends.from}\u0000${ends.to}\u0000${ends.condition}`;
}

/**
 * The operations that turn the loaded snapshot into the edited state.
 *
 * Never throws and never reads anything but `nodes` and `edges`: everything
 * else in the document (`problem_class`, `lineage`, `metadata`, `initial_node`,
 * `final_nodes`, `custom_fields`) is carried over by the core when it applies
 * the proposal, and this page has no operation that could change it anyway.
 *
 * @param {unknown} loaded Snapshot as `GET /v1/graph-versions/:id` returned it.
 * @param {unknown} edited The same document with the page's edits in it.
 * @returns {Record<string, unknown>[]} Operations in an order that applies.
 */
export function diffGraphs(loaded, edited) {
  const before = new Map(listOf(loaded, 'nodes').map((node) => [String(node.id), node]));
  const after = new Map(listOf(edited, 'nodes').map((node) => [String(node.id), node]));

  const edgesBefore = new Map(listOf(loaded, 'edges').map((edge) => [edgeKey(edge), edge]));
  const edgesAfter = new Map(listOf(edited, 'edges').map((edge) => [edgeKey(edge), edge]));

  /** @type {Record<string, unknown>[]} */
  const removedEdges = [];
  /** @type {Record<string, unknown>[]} */
  const removedNodes = [];
  /** @type {Record<string, unknown>[]} */
  const addedNodes = [];
  /** @type {Record<string, unknown>[]} */
  const changes = [];
  /** @type {Record<string, unknown>[]} */
  const addedEdges = [];

  // 1. Edges that left, or whose label changed — an edited edge is a removal
  //    plus an addition, because the vocabulary has no operation for it.
  for (const [key, edge] of edgesBefore) {
    const still = edgesAfter.get(key);
    if (still !== undefined && same(edge, still)) continue;
    removedEdges.push({
      type: 'remove_edge',
      edge: endsOf(edge),
      inverse: { type: 'add_edge', edge: copy(edge) },
    });
  }

  // 2. Nodes that left. The inverse carries the WHOLE original node: it is the
  //    only thing that could put it back.
  for (const [id, node] of before) {
    if (after.has(id)) continue;
    removedNodes.push({
      type: 'remove_node',
      node_id: id,
      inverse: { type: 'add_node', node: copy(node) },
    });
  }

  // 3. Nodes that arrived, before any edge can point at them.
  for (const [id, node] of after) {
    if (before.has(id)) continue;
    addedNodes.push({
      type: 'add_node',
      node: copy(node),
      inverse: { type: 'remove_node', node_id: id },
    });
  }

  // 4. Field by field, on the nodes that stayed.
  for (const [id, node] of after) {
    const original = before.get(id);
    if (original === undefined) continue;
    for (const field of EDITABLE_NODE_FIELDS) {
      const was = fieldOf(original, field);
      const is = fieldOf(node, field);
      if (same(was, is)) continue;
      changes.push(changeField(id, field, was, is));
    }
  }

  // 5. Edges that arrived, or came back with another label.
  for (const [key, edge] of edgesAfter) {
    const had = edgesBefore.get(key);
    if (had !== undefined && same(had, edge)) continue;
    addedEdges.push({
      type: 'add_edge',
      edge: copy(edge),
      inverse: { type: 'remove_edge', edge: endsOf(edge) },
    });
  }

  return [...removedEdges, ...removedNodes, ...addedNodes, ...changes, ...addedEdges];
}
