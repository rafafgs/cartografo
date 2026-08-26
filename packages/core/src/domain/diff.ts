/**
 * Semantic diff between two complete graph documents (t140, FR1-FR6).
 *
 * `applyOperations` (`domain/operations.ts`) is the forward half: document plus
 * operations gives a new document. This is the inverse pair — two full documents
 * give the operations that turn the first into the second. D15 demands that the
 * result be a SEMANTIC diff, so what comes out is the same five-operation
 * vocabulary a proposal already carries, each op with its inverse, and never a
 * line diff.
 *
 * Three boundaries, all deliberate:
 *
 * - **Only `nodes` and `edges` are diffed.** `problem_class`, `lineage`,
 *   `metadata`, `initial_node` and `final_nodes` have no operation that can
 *   express a change to
 *   them, and `applyOperations` never mutates them either. That happens to be
 *   exactly the D13 behaviour promotion and offer need: whatever the direction,
 *   the TARGET keeps its own identity — a base stays a base and a variant stays a
 *   variant, with no special case anywhere.
 * - **Comparison is canonical, never `===` or a raw `JSON.stringify`.** Key order
 *   carries no meaning in a graph document (`domain/hash.ts`), so two nodes
 *   differing only in it are the same node, and emitting an operation for that
 *   would be inventing a diff.
 * - **No fork point, no three-way merge.** The engine sees the two snapshots it
 *   is given and nothing else. An offer therefore overwrites the variant's own
 *   divergent nodes instead of layering only the base's increment on top; a
 *   merge that preserves both sides is real future work, not a silent behaviour
 *   of this function.
 *
 * The emission order is fixed and is part of the contract: every node removal in
 * `from` order, then every node addition in `to` order, then every field swap in
 * `to` order, then the edge removals in `from` order and the edge additions in
 * `to` order. Removals before additions is what lets a swap (remove + re-add of
 * the same id) apply without tripping `duplicate_node`, and reading the arrays in
 * their own order is what makes the round trip reproduce `to` — `canonicalize`
 * sorts keys, not array positions.
 *
 * The whole emitted vocabulary is English since D20's third child (t228): the
 * type names and the operation's own keys speak `docs/spec/glossary-wire.md`
 * §3, and the document fragments the operations carry had already moved with
 * t178. See the note at the top of `domain/operations.ts`.
 */

import type { GraphDocument, GraphEdge, GraphNode } from './graph.ts';
import { canonicalSerialize } from './hash.ts';
import {
  CHANGEABLE_FIELDS,
  type ChangeableField,
  type Operation,
} from './operations.ts';

/** Fields a swap may express, in the order the operations come out. */
const ORDERED_FIELDS = CHANGEABLE_FIELDS as readonly ChangeableField[];

/** Two values are the same when their canonical serializations match. */
function same(left: unknown, right: unknown): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

/** Identity of an edge: the pair of ends, joined by a separator no id can hold. */
function endsOf(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.to}`;
}

/** Groups a list under a key, keeping the original order inside each group. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const found = key(item);
    const group = groups.get(found);
    if (group === undefined) groups.set(found, [item]);
    else group.push(item);
  }
  return groups;
}

/** The first node of each id — `validateStructure` already forbids repeats. */
function byId(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  const found = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (!found.has(node.id)) found.set(node.id, node);
  }
  return found;
}

function addNode(node: GraphNode): Operation {
  return {
    type: 'add_node',
    node: structuredClone(node),
    inverse: { type: 'remove_node', node_id: node.id },
  };
}

function removeNode(node: GraphNode): Operation {
  return {
    type: 'remove_node',
    node_id: node.id,
    inverse: { type: 'add_node', node: structuredClone(node) },
  };
}

function addEdge(edge: GraphEdge): Operation {
  return {
    type: 'add_edge',
    edge: structuredClone(edge),
    inverse: { type: 'remove_edge', edge: { from: edge.from, to: edge.to } },
  };
}

function removeEdge(edge: GraphEdge): Operation {
  return {
    type: 'remove_edge',
    edge: { from: edge.from, to: edge.to },
    inverse: { type: 'add_edge', edge: structuredClone(edge) },
  };
}

function changeField(node: GraphNode, field: ChangeableField, to: GraphNode): Operation {
  const before = structuredClone(node[field]);
  const after = structuredClone(to[field]);
  return {
    type: 'change_node_field',
    node_id: node.id,
    field,
    from: before,
    to: after,
    inverse: {
      type: 'change_node_field',
      node_id: node.id,
      field,
      from: structuredClone(after),
      to: structuredClone(before),
    },
  };
}

/**
 * Which fields of a node changed, when a field swap can express the whole
 * difference.
 *
 * `undefined` means it cannot: either `node_type` moved, or a key outside the four
 * swappable ones differs, or one of those four is present on one side and absent
 * on the other. The last case is the subtle one — `change_node_field` writes the
 * key, it never unsets it, and an operation carrying `to: undefined` loses that
 * key the moment it is serialized into `proposta.operacoes`, coming back out as a
 * malformed operation. Whenever a swap cannot round-trip, the pair falls to the
 * full remove + add, which always can.
 *
 * @param from Node as it is in the source document.
 * @param to The node of the same id in the target document.
 * @returns The changed fields, in the fixed order, or `undefined` for a swap.
 */
function swappableFields(
  from: GraphNode,
  to: GraphNode,
): ChangeableField[] | undefined {
  if (!same(from.node_type, to.node_type)) return undefined;

  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changed: ChangeableField[] = [];

  for (const key of keys) {
    if (key === 'id' || key === 'node_type') continue;

    const swappable = ORDERED_FIELDS.includes(key as ChangeableField);
    if (!swappable) {
      if (!same(from[key], to[key])) return undefined;
      continue;
    }

    if (Object.hasOwn(from, key) !== Object.hasOwn(to, key)) return undefined;
    if (!same(from[key], to[key])) changed.push(key as ChangeableField);
  }

  return ORDERED_FIELDS.filter((field) => changed.includes(field));
}

/**
 * Computes the semantic diff that turns `from` into `to`.
 *
 * @param from Source document, already parsed (typically the target of the
 *   proposal that will carry the result).
 * @param to Target document, already parsed.
 * @returns Operations in the fixed emission order; an empty list when the two
 *   documents already agree on `nodes` and `edges`.
 */
export function diffGraphs(from: GraphDocument, to: GraphDocument): Operation[] {
  const fromNodes = Array.isArray(from.nodes) ? from.nodes : [];
  const toNodes = Array.isArray(to.nodes) ? to.nodes : [];
  const fromEdges = Array.isArray(from.edges) ? from.edges : [];
  const toEdges = Array.isArray(to.edges) ? to.edges : [];

  const before = byId(fromNodes);
  const after = byId(toNodes);

  // A node id is classified once, and the classification decides which of the
  // three node passes below picks it up.
  const swapped = new Set<string>();
  const fields = new Map<string, ChangeableField[]>();
  for (const [id, node] of before) {
    const counterpart = after.get(id);
    if (counterpart === undefined) continue;
    const changed = swappableFields(node, counterpart);
    if (changed === undefined) swapped.add(id);
    else if (changed.length > 0) fields.set(id, changed);
  }

  const operations: Operation[] = [];

  // (a) every node removal, in `from` order — the pure ones and the old half of
  // each swap.
  const removed = new Set<string>();
  for (const node of fromNodes) {
    if (removed.has(node.id)) continue;
    if (after.has(node.id) && !swapped.has(node.id)) continue;
    removed.add(node.id);
    operations.push(removeNode(node));
  }

  // (b) every node addition, in `to` order — the pure ones and the new half.
  const added = new Set<string>();
  for (const node of toNodes) {
    if (added.has(node.id)) continue;
    if (before.has(node.id) && !swapped.has(node.id)) continue;
    added.add(node.id);
    operations.push(addNode(node));
  }

  // (c) every field swap, in `to` order, fields in the fixed order.
  for (const node of toNodes) {
    const changed = fields.get(node.id);
    if (changed === undefined) continue;
    fields.delete(node.id);
    const counterpart = before.get(node.id);
    if (counterpart === undefined) continue;
    for (const field of changed) operations.push(changeField(counterpart, field, node));
  }

  // Edges are keyed by their ends and compared as a whole group: no operation
  // edits an edge in place, so a pair whose group differs is removed entirely on
  // one side and re-added on the other. Grouping (instead of a plain map) is what
  // keeps a document with two identical transitions round-tripping — `applyOperations`
  // allows the repeat, and this engine cannot be the one that quietly drops it.
  const beforeEdges = groupBy(fromEdges, endsOf);
  const afterEdges = groupBy(toEdges, endsOf);
  const differs = (ends: string): boolean =>
    !same(beforeEdges.get(ends) ?? [], afterEdges.get(ends) ?? []);

  // (d) edge removals, in `from` order.
  for (const edge of fromEdges) {
    if (differs(endsOf(edge))) operations.push(removeEdge(edge));
  }

  // (e) edge additions, in `to` order.
  for (const edge of toEdges) {
    if (differs(endsOf(edge))) operations.push(addEdge(edge));
  }

  return operations;
}
