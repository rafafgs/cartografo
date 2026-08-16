/**
 * Reference validator of the graph document (t96).
 *
 * Two checks, deliberately kept apart:
 *
 * - `validarEstrutura(doc)` — shape and referential integrity: required keys
 *   present, node ids unique, every edge and every id in
 *   `initial_node`/`final_nodes` pointing at a node that exists.
 * - `validarSoundness(doc)` — the four formal workflow-net rules (van der
 *   Aalst) the graph validation gate applies: reachable, terminates,
 *   edge with condition, node with contract.
 *
 * The two run independently and neither throws on a malformed document: the
 * synthesizer (D10) builds graphs in memory and needs a report of everything
 * that is wrong, not the first error.
 *
 * Zero dependencies: only Node built-ins. Full SHAPE validation against
 * `schema/grafo.schema.json` (via ajv or equivalent) arrives with the control
 * plane's TypeScript scaffold — here the validator covers what it takes to
 * prove the fixtures.
 *
 * ## Why the exported names and the report stay in Portuguese
 *
 * This file is outside the D18 rename scope (t127, FR8; t133, exception 5), and
 * for a reason that is checked rather than asserted:
 * `packages/core/test/domain-graph.test.ts` imports it BY PATH, destructures it
 * by the names `validarEstrutura` / `validarSoundness`, and `deepEqual`s its
 * report against the TypeScript port in `packages/core/src/domain/graph.ts` on
 * every fixture in `schema/exemplos/`. That parity is the whole point of the
 * port, so the four exported names and the full report shape — `valido`,
 * `erros`, `violacoes`, `codigo`, `mensagem`, `alvo`, `regra`, `estrutura` and
 * the four rule-name values — are frozen here. Everything else in the file is
 * English, like the rest of the repository from D18 onward.
 *
 * The message text under `mensagem` is NOT part of that freeze, and moved to
 * English with t180. It moved in lockstep with the port, because it has to:
 * the parity test compares the two reports whole, so a sentence rewritten on
 * one side and not the other fails here, loudly, on the next run. The same
 * applies to the field names quoted inside those messages, which moved with the
 * document's keys in t178 (the 2026-08-15 D18 amendment): the report vocabulary
 * is frozen, the DOCUMENT vocabulary is not, and a message still naming `nos`
 * would be pointing at a key the format no longer has.
 *
 * CLI use: `node scripts/validar-grafo.mjs schema/exemplos/*.json`
 */

import { readFileSync } from 'node:fs';

/**
 * Names of the four soundness rules, in the order they run.
 *
 * The KEYS match `packages/core/src/domain/graph.ts`'s `RULES` so the two
 * byte-for-byte siblings read the same side by side; the VALUES are frozen,
 * because they are what the reports compare on.
 */
export const RULES = Object.freeze({
  REACHABLE: 'alcançável',
  TERMINATES: 'termina',
  EDGE_WITH_CONDITION: 'aresta_com_condicao',
  NODE_WITH_CONTRACT: 'no_com_contrato',
});

const REQUIRED_DOC_FIELDS = [
  'problem_class',
  'lineage',
  'metadata',
  'nodes',
  'edges',
  'initial_node',
  'final_nodes',
  'custom_fields',
];
const REQUIRED_NODE_FIELDS = ['id', 'role', 'node_type', 'skill_ref', 'contract'];
const REQUIRED_EDGE_FIELDS = ['from', 'to', 'condition'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFilledText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Checks the document's shape and referential integrity.
 *
 * @param {unknown} doc Graph document, already parsed.
 * @returns {{valido: boolean, erros: Array<{codigo: string, mensagem: string, alvo: unknown}>}}
 */
export function validarEstrutura(doc) {
  const erros = [];
  const annotate = (code, message, target = null) =>
    erros.push({ codigo: code, mensagem: message, alvo: target });

  if (!isObject(doc)) {
    annotate('documento_invalido', 'graph document has to be a JSON object');
    return { valido: false, erros };
  }

  for (const field of REQUIRED_DOC_FIELDS) {
    if (doc[field] === undefined || doc[field] === null) {
      annotate('campo_obrigatorio_ausente', `required field missing from the document: "${field}"`, field);
    }
  }

  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) {
    annotate('campo_invalido', '"nodes" has to be a list', 'nodes');
  }
  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    annotate('campo_invalido', '"edges" has to be a list', 'edges');
  }
  if (doc.final_nodes !== undefined && !Array.isArray(doc.final_nodes)) {
    annotate('campo_invalido', '"final_nodes" has to be a list', 'final_nodes');
  }
  // The list itself and nothing inside it: what each declaration has to look
  // like is the schema's business, and cross-checking `required_at` against the
  // node ids is deliberately not done here (t168, out of scope) — an unreachable
  // `required_at` fails inertly, demanding nothing of nobody.
  if (doc.custom_fields !== undefined && !Array.isArray(doc.custom_fields)) {
    annotate('campo_invalido', '"custom_fields" has to be a list', 'custom_fields');
  }

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const knownIds = new Set();
  const reportedIds = new Set();

  nodes.forEach((node, index) => {
    if (!isObject(node)) {
      annotate('no_invalido', `the node at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined || node[field] === null) {
        annotate(
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
        annotate(
          'id_invalido',
          `the id of the node at position ${index} has to be a filled text: ${JSON.stringify(node.id)}`,
          index,
        );
      }
      return;
    }
    if (knownIds.has(node.id)) {
      if (!reportedIds.has(node.id)) {
        annotate('id_no_duplicado', `duplicate node id in the document: "${node.id}"`, node.id);
        reportedIds.add(node.id);
      }
      return;
    }
    knownIds.add(node.id);
  });

  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  edges.forEach((edge, index) => {
    if (!isObject(edge)) {
      annotate('aresta_invalida', `the edge at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_EDGE_FIELDS) {
      if (edge[field] === undefined || edge[field] === null) {
        annotate(
          'campo_obrigatorio_ausente',
          `required field missing from edge #${index}: "${field}"`,
          { de: edge.from ?? null, para: edge.to ?? null },
        );
      }
    }
    for (const side of ['from', 'to']) {
      const target = edge[side];
      if (!isFilledText(target)) {
        if (target !== undefined && target !== null) {
          annotate(
            'id_invalido',
            `edge #${index} needs a filled text in "${side}": ${JSON.stringify(target)}`,
            { de: edge.from ?? null, para: edge.to ?? null },
          );
        }
        continue;
      }
      if (!knownIds.has(target)) {
        annotate(
          'aresta_no_inexistente',
          `edge #${index} references in "${side}" a node that does not exist: "${target}"`,
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
      annotate(
        'id_invalido',
        `initial_node has to be a filled text: ${JSON.stringify(doc.initial_node)}`,
        'initial_node',
      );
    }
  } else if (!knownIds.has(doc.initial_node)) {
    annotate('no_inicial_inexistente', `initial_node references a node that does not exist: "${doc.initial_node}"`, doc.initial_node);
  }

  const finals = Array.isArray(doc.final_nodes) ? doc.final_nodes : [];
  if (Array.isArray(doc.final_nodes) && finals.length === 0) {
    annotate('campo_invalido', '"final_nodes" has to list at least one node', 'final_nodes');
  }
  // No required-fields loop covers an entry of the array, so here the absent
  // value (`null`, `undefined`) is an invalid id like any other.
  finals.forEach((finalId, index) => {
    if (!isFilledText(finalId)) {
      annotate(
        'id_invalido',
        `the id in final_nodes at position ${index} has to be a filled text: ${JSON.stringify(finalId)}`,
        index,
      );
      return;
    }
    if (!knownIds.has(finalId)) {
      annotate('no_final_inexistente', `final_nodes references a node that does not exist: "${finalId}"`, finalId);
    }
  });

  return { valido: erros.length === 0, erros };
}

/**
 * Runs the four soundness rules, in this order: reachable, terminates,
 * edge with condition, node with contract.
 *
 * @param {unknown} doc Graph document, already parsed.
 * @returns {{valido: boolean, violacoes: Array<{regra: string, alvo: unknown}>}}
 */
export function validarSoundness(doc) {
  const violacoes = [];
  const nodes = isObject(doc) && Array.isArray(doc.nodes) ? doc.nodes.filter(isObject) : [];
  const edges = isObject(doc) && Array.isArray(doc.edges) ? doc.edges.filter(isObject) : [];
  const ids = nodes.map((node) => node.id).filter(isFilledText);
  const known = new Set(ids);

  // Only edges between existing nodes enter the topology; a dangling end is a
  // structural problem, and counting it here would invent reachability that
  // does not exist.
  const outgoing = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }

  // 1. reachable — every node is reachable from initial_node.
  const reached = traverse(
    known.has(doc?.initial_node) ? [doc.initial_node] : [],
    (id) => outgoing.get(id) ?? [],
  );
  for (const id of ids) {
    if (!reached.has(id)) violacoes.push({ regra: RULES.REACHABLE, alvo: id });
  }

  // 2. terminates — from every node there is a path to some final node.
  // Computed backwards: whoever reaches the end is whoever reaches a final node
  // walking the reversed edges. A node stuck in a cycle with no way out is
  // simply never reached.
  const finals = (Array.isArray(doc?.final_nodes) ? doc.final_nodes : []).filter((id) => known.has(id));
  const reachEnd = traverse(finals, (id) => incoming.get(id) ?? []);
  for (const id of ids) {
    if (!reachEnd.has(id)) violacoes.push({ regra: RULES.TERMINATES, alvo: id });
  }

  // 3. edge with condition — no transition without a label.
  for (const edge of edges) {
    if (!isFilledText(edge.condition)) {
      violacoes.push({
        regra: RULES.EDGE_WITH_CONDITION,
        alvo: { de: edge.from ?? null, para: edge.to ?? null },
      });
    }
  }

  // 4. node with contract — holds for a gate too, which is a node like any other.
  for (const node of nodes) {
    if (!hasSkillRef(node) || !hasContract(node)) {
      violacoes.push({ regra: RULES.NODE_WITH_CONTRACT, alvo: node.id ?? null });
    }
  }

  return { valido: violacoes.length === 0, violacoes };
}

/** Breadth-first search from several seeds; returns the visited set. */
function traverse(seeds, neighbours) {
  const visited = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    for (const neighbour of neighbours(queue.shift())) {
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      queue.push(neighbour);
    }
  }
  return visited;
}

function hasSkillRef(node) {
  const ref = node.skill_ref;
  return isObject(ref) && isFilledText(ref.id) && isFilledText(ref.version) && isFilledText(ref.hash);
}

function hasContract(node) {
  const contract = node.contract;
  return (
    isObject(contract) &&
    isObject(contract.input_schema) &&
    isObject(contract.output_schema) &&
    Array.isArray(contract.checks) &&
    contract.checks.length > 0
  );
}

/**
 * Reads and parses a graph document from disk.
 *
 * @param {string} filePath Path of the JSON file.
 * @returns {unknown} The parsed document.
 */
export function carregarGrafo(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Runs both validations and returns the combined report. */
export function validarGrafo(doc) {
  const structure = validarEstrutura(doc);
  const soundness = validarSoundness(doc);
  return { valido: structure.valido && soundness.valido, estrutura: structure, soundness };
}

function main(paths) {
  if (paths.length === 0) {
    console.error('usage: node scripts/validar-grafo.mjs <graph.json> [...]');
    return 2;
  }
  let failed = false;
  for (const filePath of paths) {
    let report;
    try {
      report = validarGrafo(carregarGrafo(filePath));
    } catch (error) {
      console.error(`✖ ${filePath}: could not read the document — ${error.message}`);
      failed = true;
      continue;
    }
    if (report.valido) {
      console.log(`✔ ${filePath}`);
      continue;
    }
    failed = true;
    console.error(`✖ ${filePath}`);
    for (const problem of report.estrutura.erros) {
      console.error(`  structure  ${problem.codigo}: ${problem.mensagem}`);
    }
    for (const violation of report.soundness.violacoes) {
      console.error(`  soundness  ${violation.regra}: ${JSON.stringify(violation.alvo)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
