/**
 * Graph document validation inside the control plane (t101, FR2).
 *
 * A typed port of `scripts/validar-grafo.mjs` (t96). The script is the
 * repository's reference validator, but it lives outside the package's
 * publishable tree (`files` in `package.json`): the core cannot import it without
 * dragging along a dependency `npm pack` does not package. That is why the two
 * functions live here — and why `test/domain-graph.test.ts` runs the same
 * fixtures through both validators and demands identical reports (AT1). Any rule
 * change has to happen in both places, or the parity test fails.
 *
 * That parity is why the report's own keys, codes and rule labels stay in
 * Portuguese: this report IS the wire format of the 422, and the reference
 * validator it is compared against byte for byte freezes them too (t127, FR8).
 * The message PROSE moved to English with t180, in both files at once — a
 * sentence that changed here and not there is what `deepEqual` catches.
 *
 * The DOCUMENT's own keys moved with t178 (the 2026-08-15 D18 amendment), which
 * is why the two vocabularies now sit side by side: `doc.nodes` read out of an
 * English document, `erros`/`violacoes` written into a frozen Portuguese report.
 * The field names quoted INSIDE a message moved with the document, because a
 * message naming a key that no longer exists is wrong, not merely untranslated.
 *
 * Two checks, deliberately separate:
 *
 * - `validateStructure` — shape and referential integrity, hooks included since
 *   t169: a hook whose `node_id` names nothing is a dangling reference like an
 *   edge's, and a repeated hook id is a repeated name like a node's;
 * - `validateSoundness` — the four formal workflow-net rules.
 *
 * Neither of them throws on a malformed document: the caller needs the whole
 * report of what is wrong, not the first error. That is what the API returns in
 * the 422.
 */

import type { CustomFieldDefinition } from './custom-fields.ts';

/** Names of the four soundness rules, in the order they run. */
export const RULES = Object.freeze({
  REACHABLE: 'alcançável',
  TERMINATES: 'termina',
  EDGE_WITH_CONDITION: 'aresta_com_condicao',
  NODE_WITH_CONTRACT: 'no_com_contrato',
});

/**
 * A node of the document, already validated.
 *
 * The open drawer (`[key: string]`) is intentional: the graph format has not
 * frozen yet (rule of two consumers), and the snapshot has to cross the database
 * without losing a key this package does not know about yet.
 */
export interface GraphNode {
  id: string;
  role: string;
  node_type: string;
  description?: string;
  /** Which engine runs this node (t141). Absent = the runner's default. */
  engine?: string;
  /**
   * Which model of that engine runs this node (t166). Absent = the engine's
   * own default, and no model flag is assembled at all.
   *
   * Named here even though the open drawer below would already carry it: the
   * field is PROPOSABLE (`CHANGEABLE_FIELDS`), and a field a proposal can swap
   * is a field this package has an opinion about.
   */
  model?: string;
  /**
   * When this node calls a human (t167). Absent = `on_uncertainty`, which is
   * what every node did before the field existed.
   *
   * Named here for the same reason `model` is, and typed `string` rather than
   * the closed union for the same reason too: what refuses a fourth value is
   * `schema/grafo.schema.json`, on the way in, and this package reads snapshots
   * that were already validated by it.
   */
  escalation_policy?: string;
  /** Who should be called when this node escalates (t167). Free text. */
  escalation_recipient?: string;
  skill_ref: unknown;
  contract: unknown;
  [key: string]: unknown;
}

/** An edge of the document, already validated. */
export interface GraphEdge {
  from: string;
  to: string;
  condition: string;
  description?: string;
  [key: string]: unknown;
}

/** Where a hook's delivery goes (t169). Today `webhook` and nothing else. */
export interface GraphHookDestination {
  type: string;
  /** Absolute `http:`/`https:` URL the delivery is POSTed to. */
  url: string;
  /** HMAC key of the delivery, chosen by whoever wrote the graph. */
  secret: string;
  [key: string]: unknown;
}

/**
 * A reaction the graph declares for itself (t169).
 *
 * It is graph DATA, which is the whole point: the reaction is versioned with
 * the document and proposable like every other part of it (D2, D15), instead of
 * living as an out-of-band subscription only an operator with API access can
 * register. It never participates in the traversal — a hook has no way of
 * changing where the traveller goes, and a hook that fails is an incident, never
 * an outcome.
 */
export interface GraphHook {
  id: string;
  /** `node_entered` | `node_blocked`; the closed vocabulary lives in the schema. */
  trigger: string;
  /** The node whose entry or block fires this hook. */
  node_id: string;
  destination: GraphHookDestination;
  description?: string;
  [key: string]: unknown;
}

/** Graph document (the same format as `schema/grafo.schema.json`). */
export interface GraphDocument {
  problem_class: string;
  lineage: { type: string; base_class?: string; source_proposal_id?: string };
  metadata: Record<string, unknown>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  initial_node: string;
  final_nodes: string[];
  /**
   * Fields this class declares on its own tickets (t168).
   *
   * Required and possibly empty. Typed here rather than left to the open drawer
   * because the transition gate READS it out of the snapshot — a key this
   * package acts on is a key it has an opinion about.
   */
  custom_fields: CustomFieldDefinition[];
  /** Declared reactions (t169). Absent = none, and that is most documents. */
  hooks?: GraphHook[];
  [key: string]: unknown;
}

/** A shape or referential-integrity problem. */
export interface StructureError {
  codigo: string;
  mensagem: string;
  alvo: unknown;
}

/** A broken soundness rule, with the target that broke it. */
export interface SoundnessViolation {
  regra: string;
  alvo: unknown;
}

export interface StructureReport {
  valido: boolean;
  erros: StructureError[];
}

export interface SoundnessReport {
  valido: boolean;
  violacoes: SoundnessViolation[];
}

/** Combined report — it is the 422 body of the graph and proposal routes. */
export interface GraphReport {
  valido: boolean;
  estrutura: StructureReport;
  soundness: SoundnessReport;
}

type PlainObject = Record<string, unknown>;

/**
 * The document's own `required`, node's and edge's — exported so
 * `test/domain-manifest-fields.test.ts` can hold them against
 * `schema/grafo.schema.json` and fail the moment one side is renamed alone.
 */
export const REQUIRED_DOCUMENT_FIELDS = [
  'problem_class',
  'lineage',
  'metadata',
  'nodes',
  'edges',
  'initial_node',
  'final_nodes',
  'custom_fields',
];
export const REQUIRED_NODE_FIELDS = ['id', 'role', 'node_type', 'skill_ref', 'contract'];
export const REQUIRED_EDGE_FIELDS = ['from', 'to', 'condition'];
export const REQUIRED_HOOK_FIELDS = ['id', 'trigger', 'node_id', 'destination'];

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Checks the document's shape and referential integrity.
 *
 * @param doc Already parsed graph document (untrusted).
 * @returns A report with every problem found.
 */
export function validateStructure(doc: unknown): StructureReport {
  const errors: StructureError[] = [];
  const note = (codigo: string, mensagem: string, alvo: unknown = null): void => {
    errors.push({ codigo, mensagem, alvo });
  };

  if (!isObject(doc)) {
    note('documento_invalido', 'graph document has to be a JSON object');
    return { valido: false, erros: errors };
  }

  for (const field of REQUIRED_DOCUMENT_FIELDS) {
    if (doc[field] === undefined || doc[field] === null) {
      note(
        'campo_obrigatorio_ausente',
        `required field missing from the document: "${field}"`,
        field,
      );
    }
  }

  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) {
    note('campo_invalido', '"nodes" has to be a list', 'nodes');
  }
  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    note('campo_invalido', '"edges" has to be a list', 'edges');
  }
  if (doc.final_nodes !== undefined && !Array.isArray(doc.final_nodes)) {
    note('campo_invalido', '"final_nodes" has to be a list', 'final_nodes');
  }
  // The list itself and nothing inside it: what each declaration has to look
  // like is the schema's business, and cross-checking `required_at` against the
  // node ids is deliberately not done here (t168, out of scope) — an unreachable
  // `required_at` fails inertly, demanding nothing of nobody.
  if (doc.custom_fields !== undefined && !Array.isArray(doc.custom_fields)) {
    note('campo_invalido', '"custom_fields" has to be a list', 'custom_fields');
  }
  if (doc.hooks !== undefined && !Array.isArray(doc.hooks)) {
    note('campo_invalido', '"hooks" has to be a list', 'hooks');
  }

  const nodes: unknown[] = Array.isArray(doc.nodes) ? doc.nodes : [];
  const knownIds = new Set<string>();
  const alreadyReportedIds = new Set<string>();

  nodes.forEach((node, index) => {
    if (!isObject(node)) {
      note('no_invalido', `the node at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined || node[field] === null) {
        note(
          'campo_obrigatorio_ausente',
          `required field missing from node "${node.id ?? `#${index}`}": "${field}"`,
          node.id ?? index,
        );
      }
    }
    if (!isFilledText(node.id)) {
      // Present but not a filled text: the loop above only catches the ABSENT
      // id, and without this the node would leave the scene in silence —
      // never entering `knownIds`, never being checked by soundness.
      if (node.id !== undefined && node.id !== null) {
        note(
          'id_invalido',
          `the id of the node at position ${index} has to be a filled text: ${JSON.stringify(node.id)}`,
          index,
        );
      }
      return;
    }
    if (knownIds.has(node.id)) {
      if (!alreadyReportedIds.has(node.id)) {
        note('id_no_duplicado', `duplicate node id in the document: "${node.id}"`, node.id);
        alreadyReportedIds.add(node.id);
      }
      return;
    }
    knownIds.add(node.id);
  });

  const edges: unknown[] = Array.isArray(doc.edges) ? doc.edges : [];
  edges.forEach((edge, index) => {
    if (!isObject(edge)) {
      note('aresta_invalida', `the edge at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_EDGE_FIELDS) {
      if (edge[field] === undefined || edge[field] === null) {
        note(
          'campo_obrigatorio_ausente',
          `required field missing from edge #${index}: "${field}"`,
          { de: edge.from ?? null, para: edge.to ?? null },
        );
      }
    }
    for (const end of ['from', 'to']) {
      const target = edge[end];
      if (!isFilledText(target)) {
        if (target !== undefined && target !== null) {
          note(
            'id_invalido',
            `edge #${index} needs a filled text in "${end}": ${JSON.stringify(target)}`,
            { de: edge.from ?? null, para: edge.to ?? null },
          );
        }
        continue;
      }
      if (!knownIds.has(target)) {
        note(
          'aresta_no_inexistente',
          `edge #${index} references in "${end}" a node that does not exist: "${target}"`,
          { de: edge.from ?? null, para: edge.to ?? null },
        );
      }
    }
  });

  // The two are mutually exclusive: an id of the wrong type is not an id
  // pointing at a missing node, and only the second one gets to be a reference
  // problem.
  if (!isFilledText(doc.initial_node)) {
    if (doc.initial_node !== undefined && doc.initial_node !== null) {
      note(
        'id_invalido',
        `initial_node has to be a filled text: ${JSON.stringify(doc.initial_node)}`,
        'initial_node',
      );
    }
  } else if (!knownIds.has(doc.initial_node)) {
    note(
      'no_inicial_inexistente',
      `initial_node references a node that does not exist: "${doc.initial_node}"`,
      doc.initial_node,
    );
  }

  const finals: unknown[] = Array.isArray(doc.final_nodes) ? doc.final_nodes : [];
  if (Array.isArray(doc.final_nodes) && finals.length === 0) {
    note('campo_invalido', '"final_nodes" has to list at least one node', 'final_nodes');
  }
  // No required-fields loop covers an entry of the array, so here the absent
  // value (`null`, `undefined`) is an invalid id like any other.
  finals.forEach((final, index) => {
    if (!isFilledText(final)) {
      note(
        'id_invalido',
        `the id in final_nodes at position ${index} has to be a filled text: ${JSON.stringify(final)}`,
        index,
      );
      return;
    }
    if (!knownIds.has(final)) {
      note('no_final_inexistente', `final_nodes references a node that does not exist: "${final}"`, final);
    }
  });

  // Hooks (t169). Referential integrity, exactly like an edge's endpoints: a
  // reaction that names a node the document does not have would be a reaction
  // that can never fire, and a document that declares one is wrong now rather
  // than mysteriously silent later. Uniqueness of the hook id follows the node
  // id's rule for the same reason — it is the name the delivery row carries,
  // and two hooks answering to one name make the log ambiguous.
  const hooks: unknown[] = Array.isArray(doc.hooks) ? doc.hooks : [];
  const knownHookIds = new Set<string>();
  const alreadyReportedHookIds = new Set<string>();

  hooks.forEach((hook, index) => {
    if (!isObject(hook)) {
      note('gancho_invalido', `the hook at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_HOOK_FIELDS) {
      if (hook[field] === undefined || hook[field] === null) {
        note(
          'campo_obrigatorio_ausente',
          `required field missing from hook "${hook.id ?? `#${index}`}": "${field}"`,
          hook.id ?? index,
        );
      }
    }

    if (!isFilledText(hook.id)) {
      if (hook.id !== undefined && hook.id !== null) {
        note(
          'id_invalido',
          `the id of the hook at position ${index} has to be a filled text: ${JSON.stringify(hook.id)}`,
          index,
        );
      }
    } else if (knownHookIds.has(hook.id)) {
      if (!alreadyReportedHookIds.has(hook.id)) {
        note('id_gancho_duplicado', `duplicate hook id in the document: "${hook.id}"`, hook.id);
        alreadyReportedHookIds.add(hook.id);
      }
    } else {
      knownHookIds.add(hook.id);
    }

    const target = hook.node_id;
    if (!isFilledText(target)) {
      if (target !== undefined && target !== null) {
        note(
          'id_invalido',
          `hook #${index} needs a filled text in "node_id": ${JSON.stringify(target)}`,
          hook.id ?? index,
        );
      }
      return;
    }
    if (!knownIds.has(target)) {
      note(
        'gancho_no_inexistente',
        `hook #${index} references a node that does not exist: "${target}"`,
        hook.id ?? index,
      );
    }
  });

  return { valido: errors.length === 0, erros: errors };
}

/**
 * Runs the four soundness rules, in this order: reachable, terminates,
 * edge-with-condition, node-with-contract.
 *
 * @param doc Already parsed graph document (untrusted).
 * @returns A report with every violation found.
 */
export function validateSoundness(doc: unknown): SoundnessReport {
  const violations: SoundnessViolation[] = [];
  const document = isObject(doc) ? doc : {};
  const nodes = Array.isArray(document.nodes) ? document.nodes.filter(isObject) : [];
  const edges = Array.isArray(document.edges) ? document.edges.filter(isObject) : [];
  const ids = nodes.map((node) => node.id).filter(isFilledText);
  const known = new Set(ids);

  // Only edges between existing nodes enter the topology; a dangling end is a
  // structure problem, and counting it here would invent reachability that does
  // not exist.
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    const from = edge.from;
    const to = edge.to;
    if (!isFilledText(from) || !isFilledText(to)) continue;
    if (!known.has(from) || !known.has(to)) continue;
    outgoing.get(from)?.push(to);
    incoming.get(to)?.push(from);
  }

  // 1. reachable — every node is reachable from initial_node.
  const start = document.initial_node;
  const reached = traverse(
    isFilledText(start) && known.has(start) ? [start] : [],
    (id) => outgoing.get(id) ?? [],
  );
  for (const id of ids) {
    if (!reached.has(id)) violations.push({ regra: RULES.REACHABLE, alvo: id });
  }

  // 2. terminates — from every node there is a path to some final node. Computed
  // backwards: whoever reaches the end is whoever reaches a final walking the
  // reversed edges. A node stuck in a cycle with no exit is simply never reached.
  const declaredFinals: unknown[] = Array.isArray(document.final_nodes)
    ? document.final_nodes
    : [];
  const finals = declaredFinals.filter(
    (id): id is string => isFilledText(id) && known.has(id),
  );
  const reachTheEnd = traverse(finals, (id) => incoming.get(id) ?? []);
  for (const id of ids) {
    if (!reachTheEnd.has(id)) violations.push({ regra: RULES.TERMINATES, alvo: id });
  }

  // 3. edge-with-condition — no transition without a label.
  for (const edge of edges) {
    if (!isFilledText(edge.condition)) {
      violations.push({
        regra: RULES.EDGE_WITH_CONDITION,
        alvo: { de: edge.from ?? null, para: edge.to ?? null },
      });
    }
  }

  // 4. node-with-contract — holds for a gate too, which is a node like any other.
  for (const node of nodes) {
    if (!hasSkillRef(node) || !hasContract(node)) {
      violations.push({ regra: RULES.NODE_WITH_CONTRACT, alvo: node.id ?? null });
    }
  }

  return { valido: violations.length === 0, violacoes: violations };
}

/**
 * Runs both validations and returns the combined report.
 *
 * @param doc Already parsed graph document.
 * @returns Structure and soundness reports, with the joint verdict.
 */
export function validateGraph(doc: unknown): GraphReport {
  const estrutura = validateStructure(doc);
  const soundness = validateSoundness(doc);
  return { valido: estrutura.valido && soundness.valido, estrutura, soundness };
}

/** Breadth-first search from several seeds; returns the visited set. */
function traverse(seeds: string[], neighbours: (id: string) => string[]): Set<string> {
  const visited = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const neighbour of neighbours(current)) {
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      queue.push(neighbour);
    }
  }
  return visited;
}

function hasSkillRef(node: PlainObject): boolean {
  const ref = node.skill_ref;
  return (
    isObject(ref) &&
    isFilledText(ref.id) &&
    isFilledText(ref.version) &&
    isFilledText(ref.hash)
  );
}

function hasContract(node: PlainObject): boolean {
  const contract = node.contract;
  return (
    isObject(contract) &&
    isObject(contract.input_schema) &&
    isObject(contract.output_schema) &&
    Array.isArray(contract.checks) &&
    contract.checks.length > 0
  );
}
