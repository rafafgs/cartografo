/**
 * Vocabulary of semantic operations over the graph document (t101, FR4).
 *
 * D15: a proposal is a SEMANTIC diff — a list of typed operations, each carrying
 * its own inverse — and not a line diff. That is what makes it possible to judge
 * a proposal ("adds a red-team gate before deploying") instead of reading a
 * patch, and what gives any change a way back.
 *
 * Five operations, the minimum that proves the apply/soundness/revert cycle of
 * the acceptance criteria. This is NOT the topographer's final vocabulary:
 * growing is additive, and the rule of two consumers says to wait for t110 to
 * push with a real case before freezing.
 *
 * Two deliberate boundaries:
 *
 * - **Validating is structural.** `validateOperation` checks keys, types and the
 *   compatibility of the inverse. It does NOT stop an operation from producing a
 *   broken graph: what rejects that is the soundness gate, after applying (FR8).
 *   An edge with `condition: ""` is a well-formed operation and an unsound graph —
 *   the two judgements belong to different layers.
 * - **Executing the inverse is out of this ticket** (promotion/offer between
 *   variant and base, t118). Here the inverse only has to exist and match the
 *   operation; nobody applies it yet.
 *
 * The whole vocabulary is English since D20's third child (t228,
 * `docs/spec/glossario-wire.md` §3): the five type names (`add_node`, …), the
 * operation's OWN keys (`node`, `node_id`, `edge`, `field`, the before/after
 * pair `from`/`to`, `inverse`) and the validation report (`valid`, `errors`,
 * `code`, `message`). What an operation CARRIES had already moved with the
 * document in t178 — so `edge: {from, to, condition}` inside an operation whose
 * own before/after pair is ALSO `from`/`to` is not a collision: `de`/`para`
 * became `from`/`to` precisely because the edge of the document already spelled
 * its ends that way, and two formats that meet now say the same word for the
 * same thing.
 *
 * Nothing migrates what is already stored in `proposta.operacoes`: D20 recreates
 * the development databases, so an operation still written in Portuguese is not
 * an older dialect to fall back on — it is an unknown type, and `validateOperation`
 * says so.
 */

import { isObject } from '../util/is-object.ts';
import type { GraphEdge, GraphDocument, GraphNode } from './graph.ts';

/**
 * Node fields that `change_node_field` is allowed to swap.
 *
 * `engine` and `model` joined the list in t166, and the reason is the same for
 * both: they are execution POLICY carried as graph data, so changing one has to
 * be a versioned mutation with evidence and a way back (D15) — not a flag
 * somebody edits on a runner, where nothing records what ran under which
 * decision. `engine` had been a node field since t141 and was never proposable;
 * that was an omission, not a boundary.
 *
 * `escalation_policy` and `escalation_recipient` are here since t167, and being
 * here is the ENTIRE mechanism by which a node's escalation policy is versioned:
 * changing one produces a new `grafo_versao` and re-validates the whole
 * document, because that is what applying a proposal already does for every
 * other field on this list. A mutation path of their own would have been a
 * second way to change a node, with its own rules about what gets versioned.
 *
 * What stays out is unchanged and deliberate: `id` and `node_type` are the
 * node's identity, and swapping either is an operation of its own — edges,
 * telemetry and past proposals all point at an id.
 */
export const CHANGEABLE_FIELDS = Object.freeze([
  'role',
  'description',
  'engine',
  'model',
  'skill_ref',
  'contract',
  'escalation_policy',
  'escalation_recipient',
]);

/** A field swappable by `change_node_field`. */
export type ChangeableField =
  | 'role'
  | 'description'
  | 'engine'
  | 'model'
  | 'skill_ref'
  | 'contract'
  | 'escalation_policy'
  | 'escalation_recipient';

/**
 * End to end of an edge — what identifies the edge on removal.
 *
 * `condition` is OPTIONAL and joined the reference in t205, because two ends are
 * not an identity: the format has always allowed two edges between the same pair
 * of nodes with different `condition`s (two outcomes of the same gate), and a
 * removal naming only the ends cannot say which of them it means. Declaring it
 * pins the removal to one edge; omitting it keeps the old rule — first edge with
 * those two ends — which is what every operation already stored in
 * `proposta.operacoes` relies on, and what `diff.ts` keeps emitting.
 */
export interface EdgeReference {
  from: string;
  to: string;
  condition?: string;
}

export interface AddNodeInverse {
  type: 'add_node';
  node: GraphNode;
}

export interface RemoveNodeInverse {
  type: 'remove_node';
  node_id: string;
}

export interface AddEdgeInverse {
  type: 'add_edge';
  edge: GraphEdge;
}

export interface RemoveEdgeInverse {
  type: 'remove_edge';
  edge: EdgeReference;
}

export interface ChangeNodeFieldInverse {
  type: 'change_node_field';
  node_id: string;
  field: ChangeableField;
  from: unknown;
  to: unknown;
}

export interface AddNodeOperation {
  type: 'add_node';
  node: GraphNode;
  inverse: RemoveNodeInverse;
}

export interface RemoveNodeOperation {
  type: 'remove_node';
  node_id: string;
  inverse: AddNodeInverse;
}

export interface AddEdgeOperation {
  type: 'add_edge';
  edge: GraphEdge;
  inverse: RemoveEdgeInverse;
}

export interface RemoveEdgeOperation {
  type: 'remove_edge';
  edge: EdgeReference;
  inverse: AddEdgeInverse;
}

export interface ChangeNodeFieldOperation {
  type: 'change_node_field';
  node_id: string;
  field: ChangeableField;
  /** Previous value. Documentary: it is what builds the inverse, not a lock. */
  from: unknown;
  to: unknown;
  inverse: ChangeNodeFieldInverse;
}

/** A semantic operation with its inverse. */
export type Operation =
  | AddNodeOperation
  | RemoveNodeOperation
  | AddEdgeOperation
  | RemoveEdgeOperation
  | ChangeNodeFieldOperation;

/** The five types, in the order the specification presents them. */
export const OPERATION_TYPES = Object.freeze([
  'add_node',
  'remove_node',
  'add_edge',
  'remove_edge',
  'change_node_field',
]);

/** Which type undoes which. `change_node_field` is its own inverse (from/to swapped). */
const EXPECTED_INVERSE: Record<string, string> = {
  add_node: 'remove_node',
  remove_node: 'add_node',
  add_edge: 'remove_edge',
  remove_edge: 'add_edge',
  change_node_field: 'change_node_field',
};

/** A shape problem in the operation. */
export interface OperationError {
  code: string;
  message: string;
}

export interface OperationReport {
  valid: boolean;
  errors: OperationError[];
}

/** Failure APPLYING a well-formed operation to a snapshot that does not admit it. */
export class ApplicationError extends Error {
  readonly code: string;
  readonly target: unknown;

  constructor(code: string, message: string, target: unknown = null) {
    super(message);
    this.name = 'ApplicationError';
    this.code = code;
    this.target = target;
  }
}

type PlainObject = Record<string, unknown>;

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Checks the shape of an operation and of the inverse it carries.
 *
 * @param operation Already parsed operation (untrusted: it comes from the HTTP
 *   body or from the `proposta.operacoes` column).
 * @returns A report with every shape problem found.
 */
export function validateOperation(operation: unknown): OperationReport {
  const errors: OperationError[] = [];
  const note = (code: string, message: string): void => {
    errors.push({ code, message });
  };

  if (!isObject(operation)) {
    note('invalid_operation', 'an operation has to be a JSON object');
    return { valid: false, errors };
  }

  const type = operation.type;
  if (typeof type !== 'string' || !OPERATION_TYPES.includes(type)) {
    note(
      'unknown_type',
      `unknown operation type: ${JSON.stringify(type)} (known: ${OPERATION_TYPES.join(', ')})`,
    );
    return { valid: false, errors };
  }

  checkBody(type, operation, 'operation', note);

  const inverse = operation.inverse;
  if (inverse === undefined || inverse === null) {
    note('missing_inverse', `operation "${type}" has to declare its own inverse (D15)`);
    return { valid: errors.length === 0, errors };
  }
  if (!isObject(inverse)) {
    note('invalid_inverse', 'the inverse has to be a JSON object');
    return { valid: false, errors };
  }
  if (inverse.type !== EXPECTED_INVERSE[type]) {
    note(
      'incompatible_inverse',
      `the inverse of "${type}" has to be of type "${EXPECTED_INVERSE[type]}", got ${JSON.stringify(inverse.type)}`,
    );
    return { valid: false, errors };
  }

  checkBody(EXPECTED_INVERSE[type], inverse, 'inverse', note);
  checkInverseTarget(type, operation, inverse, note);

  return { valid: errors.length === 0, errors };
}

type Note = (code: string, message: string) => void;

/** Keys and types each operation type demands of itself. */
function checkBody(type: string, body: PlainObject, role: string, note: Note): void {
  const requireNodeId = (): void => {
    if (!isFilledText(body.node_id)) {
      note('invalid_field', `${role} "${type}": "node_id" has to be a filled node id`);
    }
  };
  const requireNode = (): void => {
    if (!isObject(body.node) || !isFilledText(body.node.id)) {
      note('invalid_field', `${role} "${type}": "node" has to be an object with an "id"`);
    }
  };
  const requireEnds = (): void => {
    const edge = body.edge;
    if (!isObject(edge) || !isFilledText(edge.from) || !isFilledText(edge.to)) {
      note('invalid_field', `${role} "${type}": "edge" has to have "from" and "to"`);
      return;
    }
    // `condition` is only DEMANDED of an edge that enters the document. Demanding
    // it as a string (even an empty one) and not as filled text is what lets a
    // missing label reach the soundness gate, where it is rejected with the rule
    // name instead of becoming a generic 400.
    //
    // On a removal it is optional (t205): present, it pins the operation to one
    // of two parallel edges; absent, the removal means what it always meant. Its
    // TYPE is checked either way — a `condition` that is not text names no edge.
    const declared = type === 'add_edge' || edge.condition !== undefined;
    if (declared && typeof edge.condition !== 'string') {
      note('invalid_field', `${role} "${type}": "edge.condition" has to be a string`);
    }
  };

  switch (type) {
    case 'add_node':
      requireNode();
      break;
    case 'remove_node':
      requireNodeId();
      break;
    case 'add_edge':
    case 'remove_edge':
      requireEnds();
      break;
    case 'change_node_field':
      requireNodeId();
      if (typeof body.field !== 'string' || !CHANGEABLE_FIELDS.includes(body.field)) {
        note(
          'field_not_changeable',
          `${role} "change_node_field": "field" has to be one of ${CHANGEABLE_FIELDS.join(', ')} — swapping id or node_type is an operation of its own, not a field swap`,
        );
      }
      for (const key of ['from', 'to']) {
        if (!Object.hasOwn(body, key)) {
          note('missing_required_field', `${role} "change_node_field": "${key}" is missing`);
        }
      }
      break;
    default:
      break;
  }
}

/** The inverse has to undo THE SAME target — an inverse of another node is not an inverse. */
function checkInverseTarget(
  type: string,
  operation: PlainObject,
  inverse: PlainObject,
  note: Note,
): void {
  const incompatible = (detail: string): void => {
    note('incompatible_inverse', `the inverse of "${type}" ${detail}`);
  };

  const ends = (value: unknown): string =>
    isObject(value) ? `${String(value.from)}→${String(value.to)}` : 'invalid';

  /** The `condition` a reference DECLARES, or `undefined` when it names none. */
  const conditionOf = (value: unknown): unknown => (isObject(value) ? value.condition : undefined);

  /** The edge as the error message spells it, condition included when declared. */
  const edgeLabel = (value: unknown): string => {
    const condition = conditionOf(value);
    return condition === undefined ? ends(value) : `${ends(value)} [${String(condition)}]`;
  };

  switch (type) {
    case 'add_node': {
      const id = isObject(operation.node) ? operation.node.id : undefined;
      if (inverse.node_id !== id) incompatible(`has to remove node "${String(id)}"`);
      break;
    }
    case 'remove_node': {
      const id = isObject(inverse.node) ? inverse.node.id : undefined;
      if (id !== operation.node_id) incompatible(`has to re-add node "${String(operation.node_id)}"`);
      break;
    }
    case 'add_edge':
    case 'remove_edge': {
      // The pair disagrees about WHICH edge only when both sides name a
      // condition and the two differ: with two parallel edges, undoing the
      // other one is not undoing this one (t205). A side that names none — every
      // pair written before t205, and everything `diff.ts` emits — goes on
      // matching whatever the other side says, which is why widening the
      // reference broke no stored proposal.
      const declared = conditionOf(operation.edge);
      const undone = conditionOf(inverse.edge);
      const clash = declared !== undefined && undone !== undefined && declared !== undone;
      if (clash || ends(operation.edge) !== ends(inverse.edge)) {
        incompatible(`has to point at the same edge (${edgeLabel(operation.edge)})`);
      }
      break;
    }
    case 'change_node_field': {
      if (inverse.node_id !== operation.node_id || inverse.field !== operation.field) {
        incompatible(
          `has to change the same field of the same node ("${String(operation.node_id)}"."${String(operation.field)}")`,
        );
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Applies the list of operations, in order, over a deep copy of the document.
 *
 * Never mutates the input document: the target version's snapshot stays what is
 * in the database, whatever happens to the result.
 *
 * A target that does not exist throws `ApplicationError` instead of becoming a
 * silent no-op — a proposal that removes an already removed node is talking
 * about another version of the graph, and turning that into "applied, nothing
 * changed" would write a new version lying about what happened. A node id is the
 * document's identity (edges, telemetry and proposals point at it), so adding an
 * id that already exists is an application error too; a repeated edge is not —
 * two identical transitions are redundancy, not an identity collision, and what
 * complains about that is the gate.
 *
 * @param document Snapshot of the target version, already validated.
 * @param operations Operations of the proposal, in order.
 * @returns A new document, NOT yet validated — validating is the caller's job (FR8).
 * @throws {ApplicationError} Malformed operation, or one inapplicable to this snapshot.
 */
export function applyOperations(
  document: GraphDocument,
  operations: readonly Operation[],
): GraphDocument {
  const result = structuredClone(document) as GraphDocument;
  result.nodes = Array.isArray(result.nodes) ? result.nodes : [];
  result.edges = Array.isArray(result.edges) ? result.edges : [];

  operations.forEach((operation, index) => {
    const report = validateOperation(operation);
    if (!report.valid) {
      throw new ApplicationError(
        'invalid_operation',
        `operation #${index} is malformed: ${report.errors.map((error) => error.message).join('; ')}`,
        index,
      );
    }

    switch (operation.type) {
      case 'add_node': {
        if (result.nodes.some((node) => node.id === operation.node.id)) {
          throw new ApplicationError(
            'duplicate_node',
            `node "${operation.node.id}" already exists in the snapshot`,
            operation.node.id,
          );
        }
        result.nodes.push(structuredClone(operation.node));
        break;
      }
      case 'remove_node': {
        const position = result.nodes.findIndex((node) => node.id === operation.node_id);
        if (position === -1) {
          throw new ApplicationError(
            'unknown_node',
            `node "${operation.node_id}" does not exist in the snapshot`,
            operation.node_id,
          );
        }
        result.nodes.splice(position, 1);
        break;
      }
      case 'add_edge': {
        result.edges.push(structuredClone(operation.edge));
        break;
      }
      case 'remove_edge': {
        // A target that declares a `condition` names ONE edge, even where two
        // parallel ones share the ends; one that declares none removes the first
        // edge between those ends, which is what it has always meant and what
        // every operation stored before t205 counts on.
        const wanted = operation.edge.condition;
        const position = result.edges.findIndex(
          (edge) =>
            edge.from === operation.edge.from &&
            edge.to === operation.edge.to &&
            (wanted === undefined || edge.condition === wanted),
        );
        if (position === -1) {
          throw new ApplicationError(
            'unknown_edge',
            `edge "${operation.edge.from}"→"${operation.edge.to}"${wanted === undefined ? '' : ` [${wanted}]`} does not exist in the snapshot`,
            {
              from: operation.edge.from,
              to: operation.edge.to,
              ...(wanted === undefined ? {} : { condition: wanted }),
            },
          );
        }
        result.edges.splice(position, 1);
        break;
      }
      case 'change_node_field': {
        const node = result.nodes.find((candidate) => candidate.id === operation.node_id);
        if (node === undefined) {
          throw new ApplicationError(
            'unknown_node',
            `node "${operation.node_id}" does not exist in the snapshot`,
            operation.node_id,
          );
        }
        (node as PlainObject)[operation.field] = structuredClone(operation.to);
        break;
      }
    }
  });

  return result;
}
