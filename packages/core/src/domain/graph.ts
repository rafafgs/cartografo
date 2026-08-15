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
 * Two checks, deliberately separate:
 *
 * - `validateStructure` — shape and referential integrity;
 * - `validateSoundness` — the four formal workflow-net rules.
 *
 * Neither of them throws on a malformed document: the caller needs the whole
 * report of what is wrong, not the first error. That is what the API returns in
 * the 422.
 */

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
  papel: string;
  tipo_no: string;
  descricao?: string;
  skill_ref: unknown;
  contrato: unknown;
  [key: string]: unknown;
}

/** An edge of the document, already validated. */
export interface GraphEdge {
  de: string;
  para: string;
  condicao: string;
  descricao?: string;
  [key: string]: unknown;
}

/** Graph document (the same format as `schema/grafo.schema.json`). */
export interface GraphDocument {
  classe: string;
  linhagem: { tipo: string; base_classe?: string; origem_proposta_id?: string };
  metadata: Record<string, unknown>;
  nos: GraphNode[];
  arestas: GraphEdge[];
  no_inicial: string;
  nos_finais: string[];
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

const REQUIRED_DOCUMENT_FIELDS = [
  'classe',
  'linhagem',
  'metadata',
  'nos',
  'arestas',
  'no_inicial',
  'nos_finais',
];
const REQUIRED_NODE_FIELDS = ['id', 'papel', 'tipo_no', 'skill_ref', 'contrato'];
const REQUIRED_EDGE_FIELDS = ['de', 'para', 'condicao'];

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

  if (doc.nos !== undefined && !Array.isArray(doc.nos)) {
    note('campo_invalido', '"nos" has to be a list', 'nos');
  }
  if (doc.arestas !== undefined && !Array.isArray(doc.arestas)) {
    note('campo_invalido', '"arestas" has to be a list', 'arestas');
  }
  if (doc.nos_finais !== undefined && !Array.isArray(doc.nos_finais)) {
    note('campo_invalido', '"nos_finais" has to be a list', 'nos_finais');
  }

  const nodes: unknown[] = Array.isArray(doc.nos) ? doc.nos : [];
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

  const edges: unknown[] = Array.isArray(doc.arestas) ? doc.arestas : [];
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
          { de: edge.de ?? null, para: edge.para ?? null },
        );
      }
    }
    for (const end of ['de', 'para']) {
      const target = edge[end];
      if (!isFilledText(target)) {
        if (target !== undefined && target !== null) {
          note(
            'id_invalido',
            `edge #${index} needs a filled text in "${end}": ${JSON.stringify(target)}`,
            { de: edge.de ?? null, para: edge.para ?? null },
          );
        }
        continue;
      }
      if (!knownIds.has(target)) {
        note(
          'aresta_no_inexistente',
          `edge #${index} references in "${end}" a node that does not exist: "${target}"`,
          { de: edge.de ?? null, para: edge.para ?? null },
        );
      }
    }
  });

  // The two are mutually exclusive: an id of the wrong type is not an id
  // pointing at a missing node, and only the second one gets to be a reference
  // problem.
  if (!isFilledText(doc.no_inicial)) {
    if (doc.no_inicial !== undefined && doc.no_inicial !== null) {
      note(
        'id_invalido',
        `no_inicial has to be a filled text: ${JSON.stringify(doc.no_inicial)}`,
        'no_inicial',
      );
    }
  } else if (!knownIds.has(doc.no_inicial)) {
    note(
      'no_inicial_inexistente',
      `no_inicial references a node that does not exist: "${doc.no_inicial}"`,
      doc.no_inicial,
    );
  }

  const finals: unknown[] = Array.isArray(doc.nos_finais) ? doc.nos_finais : [];
  if (Array.isArray(doc.nos_finais) && finals.length === 0) {
    note('campo_invalido', '"nos_finais" has to list at least one node', 'nos_finais');
  }
  // No required-fields loop covers an entry of the array, so here the absent
  // value (`null`, `undefined`) is an invalid id like any other.
  finals.forEach((final, index) => {
    if (!isFilledText(final)) {
      note(
        'id_invalido',
        `the id in nos_finais at position ${index} has to be a filled text: ${JSON.stringify(final)}`,
        index,
      );
      return;
    }
    if (!knownIds.has(final)) {
      note('no_final_inexistente', `nos_finais references a node that does not exist: "${final}"`, final);
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
  const nodes = Array.isArray(document.nos) ? document.nos.filter(isObject) : [];
  const edges = Array.isArray(document.arestas) ? document.arestas.filter(isObject) : [];
  const ids = nodes.map((node) => node.id).filter(isFilledText);
  const known = new Set(ids);

  // Only edges between existing nodes enter the topology; a dangling end is a
  // structure problem, and counting it here would invent reachability that does
  // not exist.
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    const from = edge.de;
    const to = edge.para;
    if (!isFilledText(from) || !isFilledText(to)) continue;
    if (!known.has(from) || !known.has(to)) continue;
    outgoing.get(from)?.push(to);
    incoming.get(to)?.push(from);
  }

  // 1. reachable — every node is reachable from no_inicial.
  const start = document.no_inicial;
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
  const declaredFinals: unknown[] = Array.isArray(document.nos_finais)
    ? document.nos_finais
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
    if (!isFilledText(edge.condicao)) {
      violations.push({
        regra: RULES.EDGE_WITH_CONDITION,
        alvo: { de: edge.de ?? null, para: edge.para ?? null },
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
    isFilledText(ref.versao) &&
    isFilledText(ref.hash)
  );
}

function hasContract(node: PlainObject): boolean {
  const contract = node.contrato;
  return (
    isObject(contract) &&
    isObject(contract.entrada_schema) &&
    isObject(contract.saida_schema) &&
    Array.isArray(contract.verificacoes) &&
    contract.verificacoes.length > 0
  );
}
