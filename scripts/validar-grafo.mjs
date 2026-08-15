/**
 * Reference validator of the graph document (t96).
 *
 * Two checks, deliberately kept apart:
 *
 * - `validarEstrutura(doc)` — shape and referential integrity: required keys
 *   present, node ids unique, every edge and every id in
 *   `no_inicial`/`nos_finais` pointing at a node that exists.
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
 * one side and not the other fails here, loudly, on the next run.
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

  if (doc.nos !== undefined && !Array.isArray(doc.nos)) {
    annotate('campo_invalido', '"nos" has to be a list', 'nos');
  }
  if (doc.arestas !== undefined && !Array.isArray(doc.arestas)) {
    annotate('campo_invalido', '"arestas" has to be a list', 'arestas');
  }
  if (doc.nos_finais !== undefined && !Array.isArray(doc.nos_finais)) {
    annotate('campo_invalido', '"nos_finais" has to be a list', 'nos_finais');
  }

  const nodes = Array.isArray(doc.nos) ? doc.nos : [];
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

  const edges = Array.isArray(doc.arestas) ? doc.arestas : [];
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
          { de: edge.de ?? null, para: edge.para ?? null },
        );
      }
    }
    for (const side of ['de', 'para']) {
      const target = edge[side];
      if (!isFilledText(target)) {
        if (target !== undefined && target !== null) {
          annotate(
            'id_invalido',
            `edge #${index} needs a filled text in "${side}": ${JSON.stringify(target)}`,
            { de: edge.de ?? null, para: edge.para ?? null },
          );
        }
        continue;
      }
      if (!knownIds.has(target)) {
        annotate(
          'aresta_no_inexistente',
          `edge #${index} references in "${side}" a node that does not exist: "${target}"`,
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
      annotate(
        'id_invalido',
        `no_inicial has to be a filled text: ${JSON.stringify(doc.no_inicial)}`,
        'no_inicial',
      );
    }
  } else if (!knownIds.has(doc.no_inicial)) {
    annotate('no_inicial_inexistente', `no_inicial references a node that does not exist: "${doc.no_inicial}"`, doc.no_inicial);
  }

  const finals = Array.isArray(doc.nos_finais) ? doc.nos_finais : [];
  if (Array.isArray(doc.nos_finais) && finals.length === 0) {
    annotate('campo_invalido', '"nos_finais" has to list at least one node', 'nos_finais');
  }
  // No required-fields loop covers an entry of the array, so here the absent
  // value (`null`, `undefined`) is an invalid id like any other.
  finals.forEach((finalId, index) => {
    if (!isFilledText(finalId)) {
      annotate(
        'id_invalido',
        `the id in nos_finais at position ${index} has to be a filled text: ${JSON.stringify(finalId)}`,
        index,
      );
      return;
    }
    if (!knownIds.has(finalId)) {
      annotate('no_final_inexistente', `nos_finais references a node that does not exist: "${finalId}"`, finalId);
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
  const nodes = isObject(doc) && Array.isArray(doc.nos) ? doc.nos.filter(isObject) : [];
  const edges = isObject(doc) && Array.isArray(doc.arestas) ? doc.arestas.filter(isObject) : [];
  const ids = nodes.map((node) => node.id).filter(isFilledText);
  const known = new Set(ids);

  // Only edges between existing nodes enter the topology; a dangling end is a
  // structural problem, and counting it here would invent reachability that
  // does not exist.
  const outgoing = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.de) || !known.has(edge.para)) continue;
    outgoing.get(edge.de).push(edge.para);
    incoming.get(edge.para).push(edge.de);
  }

  // 1. reachable — every node is reachable from no_inicial.
  const reached = traverse(
    known.has(doc?.no_inicial) ? [doc.no_inicial] : [],
    (id) => outgoing.get(id) ?? [],
  );
  for (const id of ids) {
    if (!reached.has(id)) violacoes.push({ regra: RULES.REACHABLE, alvo: id });
  }

  // 2. terminates — from every node there is a path to some final node.
  // Computed backwards: whoever reaches the end is whoever reaches a final node
  // walking the reversed edges. A node stuck in a cycle with no way out is
  // simply never reached.
  const finals = (Array.isArray(doc?.nos_finais) ? doc.nos_finais : []).filter((id) => known.has(id));
  const reachEnd = traverse(finals, (id) => incoming.get(id) ?? []);
  for (const id of ids) {
    if (!reachEnd.has(id)) violacoes.push({ regra: RULES.TERMINATES, alvo: id });
  }

  // 3. edge with condition — no transition without a label.
  for (const edge of edges) {
    if (!isFilledText(edge.condicao)) {
      violacoes.push({
        regra: RULES.EDGE_WITH_CONDITION,
        alvo: { de: edge.de ?? null, para: edge.para ?? null },
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
  return isObject(ref) && isFilledText(ref.id) && isFilledText(ref.versao) && isFilledText(ref.hash);
}

function hasContract(node) {
  const contract = node.contrato;
  return (
    isObject(contract) &&
    isObject(contract.entrada_schema) &&
    isObject(contract.saida_schema) &&
    Array.isArray(contract.verificacoes) &&
    contract.verificacoes.length > 0
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
