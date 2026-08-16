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
 *   An edge with `condicao: ""` is a well-formed operation and an unsound graph —
 *   the two judgements belong to different layers.
 * - **Executing the inverse is out of this ticket** (promotion/offer between
 *   variant and base, t118). Here the inverse only has to exist and match the
 *   operation; nobody applies it yet.
 *
 * The operation-type names (`adicionar_no`, …), the operation's OWN keys (`no`,
 * `no_id`, `aresta`, `campo`, the before/after pair `de`/`para`, `inversa`) and
 * the report's keys stay in Portuguese: they are the format stored in
 * `proposta.operacoes` and returned on the wire, which the D18 rename does not
 * touch (t127, FR8).
 *
 * What an operation CARRIES is a different matter. `no` is a graph node and
 * `aresta` is a graph edge — fragments of the document, spliced straight into a
 * snapshot by `applyOperations` — so their keys moved with the document in t178
 * (the 2026-08-15 D18 amendment). Hence `aresta: {from, to, condition}` inside
 * an operation whose own before/after pair is still spelled `de`/`para`: two
 * formats meeting, each keeping its own vocabulary.
 */

import type { GraphEdge, GraphDocument, GraphNode } from './graph.ts';

/**
 * Node fields that `alterar_campo_no` is allowed to swap.
 *
 * `escalation_policy` and `escalation_recipient` are here since t167, and being
 * here is the ENTIRE mechanism by which a node's escalation policy is versioned:
 * changing one produces a new `grafo_versao` and re-validates the whole
 * document, because that is what applying a proposal already does for every
 * other field on this list. A mutation path of their own would have been a
 * second way to change a node, with its own rules about what gets versioned.
 */
export const CHANGEABLE_FIELDS = Object.freeze([
  'role',
  'description',
  'skill_ref',
  'contract',
  'escalation_policy',
  'escalation_recipient',
]);

/** A field swappable by `alterar_campo_no`. */
export type ChangeableField =
  | 'role'
  | 'description'
  | 'skill_ref'
  | 'contract'
  | 'escalation_policy'
  | 'escalation_recipient';

/** End to end of an edge — what identifies the edge on removal. */
export interface EdgeReference {
  from: string;
  to: string;
}

export interface AddNodeInverse {
  tipo: 'adicionar_no';
  no: GraphNode;
}

export interface RemoveNodeInverse {
  tipo: 'remover_no';
  no_id: string;
}

export interface AddEdgeInverse {
  tipo: 'adicionar_aresta';
  aresta: GraphEdge;
}

export interface RemoveEdgeInverse {
  tipo: 'remover_aresta';
  aresta: EdgeReference;
}

export interface ChangeNodeFieldInverse {
  tipo: 'alterar_campo_no';
  no_id: string;
  campo: ChangeableField;
  de: unknown;
  para: unknown;
}

export interface AddNodeOperation {
  tipo: 'adicionar_no';
  no: GraphNode;
  inversa: RemoveNodeInverse;
}

export interface RemoveNodeOperation {
  tipo: 'remover_no';
  no_id: string;
  inversa: AddNodeInverse;
}

export interface AddEdgeOperation {
  tipo: 'adicionar_aresta';
  aresta: GraphEdge;
  inversa: RemoveEdgeInverse;
}

export interface RemoveEdgeOperation {
  tipo: 'remover_aresta';
  aresta: EdgeReference;
  inversa: AddEdgeInverse;
}

export interface ChangeNodeFieldOperation {
  tipo: 'alterar_campo_no';
  no_id: string;
  campo: ChangeableField;
  /** Previous value. Documentary: it is what builds the inverse, not a lock. */
  de: unknown;
  para: unknown;
  inversa: ChangeNodeFieldInverse;
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
  'adicionar_no',
  'remover_no',
  'adicionar_aresta',
  'remover_aresta',
  'alterar_campo_no',
]);

/** Which type undoes which. `alterar_campo_no` is its own inverse (de/para swapped). */
const EXPECTED_INVERSE: Record<string, string> = {
  adicionar_no: 'remover_no',
  remover_no: 'adicionar_no',
  adicionar_aresta: 'remover_aresta',
  remover_aresta: 'adicionar_aresta',
  alterar_campo_no: 'alterar_campo_no',
};

/** A shape problem in the operation. */
export interface OperationError {
  codigo: string;
  mensagem: string;
}

export interface OperationReport {
  valido: boolean;
  erros: OperationError[];
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

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const note = (codigo: string, mensagem: string): void => {
    errors.push({ codigo, mensagem });
  };

  if (!isObject(operation)) {
    note('operacao_invalida', 'an operation has to be a JSON object');
    return { valido: false, erros: errors };
  }

  const type = operation.tipo;
  if (typeof type !== 'string' || !OPERATION_TYPES.includes(type)) {
    note(
      'tipo_desconhecido',
      `unknown operation type: ${JSON.stringify(type)} (known: ${OPERATION_TYPES.join(', ')})`,
    );
    return { valido: false, erros: errors };
  }

  checkBody(type, operation, 'operation', note);

  const inverse = operation.inversa;
  if (inverse === undefined || inverse === null) {
    note('inversa_ausente', `operation "${type}" has to declare its own inverse (D15)`);
    return { valido: errors.length === 0, erros: errors };
  }
  if (!isObject(inverse)) {
    note('inversa_invalida', 'the inverse has to be a JSON object');
    return { valido: false, erros: errors };
  }
  if (inverse.tipo !== EXPECTED_INVERSE[type]) {
    note(
      'inversa_incompativel',
      `the inverse of "${type}" has to be of type "${EXPECTED_INVERSE[type]}", got ${JSON.stringify(inverse.tipo)}`,
    );
    return { valido: false, erros: errors };
  }

  checkBody(EXPECTED_INVERSE[type], inverse, 'inverse', note);
  checkInverseTarget(type, operation, inverse, note);

  return { valido: errors.length === 0, erros: errors };
}

type Note = (codigo: string, mensagem: string) => void;

/** Keys and types each operation type demands of itself. */
function checkBody(type: string, body: PlainObject, role: string, note: Note): void {
  const requireNodeId = (): void => {
    if (!isFilledText(body.no_id)) {
      note('campo_invalido', `${role} "${type}": "no_id" has to be a filled node id`);
    }
  };
  const requireNode = (): void => {
    if (!isObject(body.no) || !isFilledText(body.no.id)) {
      note('campo_invalido', `${role} "${type}": "no" has to be an object with an "id"`);
    }
  };
  const requireEnds = (): void => {
    const edge = body.aresta;
    if (!isObject(edge) || !isFilledText(edge.from) || !isFilledText(edge.to)) {
      note('campo_invalido', `${role} "${type}": "aresta" has to have "from" and "to"`);
      return;
    }
    // `condition` is only demanded of an edge that ENTERS the document. Demanding
    // it as a string (even an empty one) and not as filled text is what lets a
    // missing label reach the soundness gate, where it is rejected with the rule
    // name instead of becoming a generic 400.
    if (type === 'adicionar_aresta' && typeof edge.condition !== 'string') {
      note('campo_invalido', `${role} "${type}": "aresta.condition" has to be a string`);
    }
  };

  switch (type) {
    case 'adicionar_no':
      requireNode();
      break;
    case 'remover_no':
      requireNodeId();
      break;
    case 'adicionar_aresta':
    case 'remover_aresta':
      requireEnds();
      break;
    case 'alterar_campo_no':
      requireNodeId();
      if (typeof body.campo !== 'string' || !CHANGEABLE_FIELDS.includes(body.campo)) {
        note(
          'campo_nao_alteravel',
          `${role} "alterar_campo_no": "campo" has to be one of ${CHANGEABLE_FIELDS.join(', ')} — swapping id or node_type is an operation of its own, not a field swap`,
        );
      }
      for (const key of ['de', 'para']) {
        if (!Object.hasOwn(body, key)) {
          note('campo_obrigatorio_ausente', `${role} "alterar_campo_no": "${key}" is missing`);
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
    note('inversa_incompativel', `the inverse of "${type}" ${detail}`);
  };

  const ends = (value: unknown): string =>
    isObject(value) ? `${String(value.from)}→${String(value.to)}` : 'invalid';

  switch (type) {
    case 'adicionar_no': {
      const id = isObject(operation.no) ? operation.no.id : undefined;
      if (inverse.no_id !== id) incompatible(`has to remove node "${String(id)}"`);
      break;
    }
    case 'remover_no': {
      const id = isObject(inverse.no) ? inverse.no.id : undefined;
      if (id !== operation.no_id) incompatible(`has to re-add node "${String(operation.no_id)}"`);
      break;
    }
    case 'adicionar_aresta':
    case 'remover_aresta': {
      if (ends(operation.aresta) !== ends(inverse.aresta)) {
        incompatible(`has to point at the same edge (${ends(operation.aresta)})`);
      }
      break;
    }
    case 'alterar_campo_no': {
      if (inverse.no_id !== operation.no_id || inverse.campo !== operation.campo) {
        incompatible(
          `has to change the same field of the same node ("${String(operation.no_id)}"."${String(operation.campo)}")`,
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
    if (!report.valido) {
      throw new ApplicationError(
        'operacao_invalida',
        `operation #${index} is malformed: ${report.erros.map((error) => error.mensagem).join('; ')}`,
        index,
      );
    }

    switch (operation.tipo) {
      case 'adicionar_no': {
        if (result.nodes.some((node) => node.id === operation.no.id)) {
          throw new ApplicationError(
            'no_duplicado',
            `node "${operation.no.id}" already exists in the snapshot`,
            operation.no.id,
          );
        }
        result.nodes.push(structuredClone(operation.no));
        break;
      }
      case 'remover_no': {
        const position = result.nodes.findIndex((node) => node.id === operation.no_id);
        if (position === -1) {
          throw new ApplicationError(
            'no_inexistente',
            `node "${operation.no_id}" does not exist in the snapshot`,
            operation.no_id,
          );
        }
        result.nodes.splice(position, 1);
        break;
      }
      case 'adicionar_aresta': {
        result.edges.push(structuredClone(operation.aresta));
        break;
      }
      case 'remover_aresta': {
        const position = result.edges.findIndex(
          (edge) => edge.from === operation.aresta.from && edge.to === operation.aresta.to,
        );
        if (position === -1) {
          throw new ApplicationError(
            'aresta_inexistente',
            `edge "${operation.aresta.from}"→"${operation.aresta.to}" does not exist in the snapshot`,
            { de: operation.aresta.from, para: operation.aresta.to },
          );
        }
        result.edges.splice(position, 1);
        break;
      }
      case 'alterar_campo_no': {
        const node = result.nodes.find((candidate) => candidate.id === operation.no_id);
        if (node === undefined) {
          throw new ApplicationError(
            'no_inexistente',
            `node "${operation.no_id}" does not exist in the snapshot`,
            operation.no_id,
          );
        }
        (node as PlainObject)[operation.campo] = structuredClone(operation.para);
        break;
      }
    }
  });

  return result;
}
