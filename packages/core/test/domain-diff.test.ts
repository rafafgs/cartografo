/**
 * Acceptance tests of the semantic diff engine (t140, FR1-FR6).
 *
 * `applyOperations` is the forward half — document plus operations gives a new
 * document. `diffGraphs` is the reverse half: two complete documents give the
 * operations that turn one into the other. Everything proven here hangs off two
 * demands D15 makes of that pair: the diff speaks the five-operation vocabulary
 * (never a line diff), and it round-trips — applying the diff to `from` has to
 * reproduce `to`.
 *
 * What is deliberately NOT proven here: soundness of the result. The diff can
 * perfectly well describe the way from one sound document to a broken one; the
 * gate that refuses that is the one in the apply flow, and mixing the two
 * judgements is exactly what `domain-operations.test.ts` already warns about.
 *
 * The operation and graph-document field names stay in Portuguese: they are the
 * frozen data format (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as DiffModule from '../src/domain/diff.ts';
import type { GraphDocument, GraphEdge, GraphNode } from '../src/domain/graph.ts';
import { canonicalize } from '../src/domain/hash.ts';
import type * as OperationsModule from '../src/domain/operations.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

let diffCache: typeof DiffModule | null = null;
let operationsCache: typeof OperationsModule | null = null;

/** Loads the engine on demand, so the initial red NAMES the missing artifact. */
async function loadDiff(): Promise<typeof DiffModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'domain', 'diff.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/domain/diff.ts');
  diffCache ??= (await import(
    new URL('../src/domain/diff.ts', import.meta.url).href
  )) as typeof DiffModule;
  return diffCache;
}

async function loadOperations(): Promise<typeof OperationsModule> {
  operationsCache ??= (await import(
    new URL('../src/domain/operations.ts', import.meta.url).href
  )) as typeof OperationsModule;
  return operationsCache;
}

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

function requireNode(doc: GraphDocument, id: string): GraphNode {
  const node = doc.nos.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`the fixture changed: node "${id}" is gone`);
  return node;
}

/** A complete new node: role, type, pinned skill and a contract with a check. */
const NEW_NODE: GraphNode = {
  id: 'checar_fatos',
  papel: 'revisor',
  tipo_no: 'trabalho',
  descricao: 'Confere cada afirmação da nota contra a fonte citada.',
  skill_ref: {
    id: 'cartografo/checar-fatos',
    versao: '1.0.0',
    hash: `sha256:${'0'.repeat(64)}`,
  },
  contrato: {
    entrada_schema: {
      type: 'object',
      required: ['texto'],
      properties: { texto: { type: 'string', minLength: 1 } },
    },
    saida_schema: {
      type: 'object',
      required: ['aprovado'],
      properties: { aprovado: { type: 'boolean' } },
    },
    verificacoes: [
      {
        tipo: 'deterministico',
        comando: 'test -s checagem.md',
        descricao: 'O relatório de checagem existe e não está vazio.',
      },
    ],
  },
};

/** A second complete node, used as the one only the `from` side has. */
const ARCHIVE_NODE: GraphNode = {
  id: 'arquivar',
  papel: 'arquivista',
  tipo_no: 'trabalho',
  descricao: 'Guarda a nota revisada no acervo do projeto.',
  skill_ref: {
    id: 'cartografo/arquivar-nota',
    versao: '1.0.0',
    hash: `sha256:${'1'.repeat(64)}`,
  },
  contrato: {
    entrada_schema: {
      type: 'object',
      required: ['texto'],
      properties: { texto: { type: 'string', minLength: 1 } },
    },
    saida_schema: {
      type: 'object',
      required: ['caminho'],
      properties: { caminho: { type: 'string', minLength: 1 } },
    },
    verificacoes: [
      {
        tipo: 'deterministico',
        comando: 'test -s acervo/nota.md',
        descricao: 'A nota chegou ao acervo.',
      },
    ],
  },
};

/** A contract different from `revisar`'s, so the field really changes. */
const OTHER_CONTRACT = {
  entrada_schema: {
    type: 'object',
    required: ['texto'],
    properties: { texto: { type: 'string' } },
  },
  saida_schema: {
    type: 'object',
    required: ['resultado'],
    properties: { resultado: { enum: ['passou', 'falhou'] } },
  },
  verificacoes: [
    {
      tipo: 'agentico',
      instrucao: 'A nota sobrevive a uma leitura adversarial? Cite o trecho mais frágil.',
      evidencia_obrigatoria: true,
      descricao: 'Leitura de red team, com evidência própria.',
    },
  ],
};

/** Two documents to diff, and a label used when a sweep reports on them. */
interface Pair {
  label: string;
  from: GraphDocument;
  to: GraphDocument;
}

/** AT2 — the node exists only in `to`. */
function nodeOnlyInTo(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  to.nos.push(structuredClone(NEW_NODE));
  return { label: 'node only in to', from, to };
}

/** AT3 — the node exists only in `from`. */
function nodeOnlyInFrom(): Pair {
  const from = minimalGraph();
  from.nos.push(structuredClone(ARCHIVE_NODE));
  const to = minimalGraph();
  return { label: 'node only in from', from, to };
}

/** AT4 — same node, only `papel` differs. */
function roleChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  requireNode(to, 'revisar').papel = 'red-team';
  return { label: 'role changed', from, to };
}

/** AT5 — same node, `papel` and `contrato` differ. */
function roleAndContractChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  const node = requireNode(to, 'revisar');
  node.papel = 'red-team';
  node.contrato = structuredClone(OTHER_CONTRACT);
  return { label: 'role and contract changed', from, to };
}

/** AT6 — same id, `tipo_no` differs: no field swap can express it. */
function typeChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  requireNode(to, 'revisar').tipo_no = 'trabalho';
  return { label: 'node type changed', from, to };
}

/** AT7 — the edge exists only in `to`; both ends are already on both sides. */
function edgeOnlyInTo(): Pair {
  const from = minimalGraph();
  from.nos.push(structuredClone(NEW_NODE));
  const to = minimalGraph();
  to.nos.push(structuredClone(NEW_NODE));
  to.arestas.push({ de: 'revisar', para: 'checar_fatos', condicao: 'reprovado' });
  return { label: 'edge only in to', from, to };
}

/** AT8 — the edge exists only in `from`. */
function edgeOnlyInFrom(): Pair {
  const from = minimalGraph();
  from.nos.push(structuredClone(ARCHIVE_NODE));
  from.arestas.push({ de: 'revisar', para: 'arquivar', condicao: 'aprovado' });
  const to = minimalGraph();
  to.nos.push(structuredClone(ARCHIVE_NODE));
  return { label: 'edge only in from', from, to };
}

/** AT9 — same ends, `condicao` differs: no operation edits an edge in place. */
function edgeConditionChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  to.arestas[0] = { ...structuredClone(to.arestas[0]), condicao: 'rascunho pronto' };
  return { label: 'edge condition changed', from, to };
}

/**
 * AT10 — every change type of AT2-AT9 at once.
 *
 * The order of `to.nos`/`to.arestas` is not decoration: `canonicalize` preserves
 * array order, so the round trip only closes if the emission order of the engine
 * reproduces it. Whatever survives untouched keeps its place, and whatever is
 * (re)added lands after it — which is exactly what removals-then-additions
 * produces.
 */
function everythingAtOnce(): Pair {
  const from = minimalGraph();
  from.nos.push(structuredClone(ARCHIVE_NODE));
  from.arestas.push({ de: 'revisar', para: 'arquivar', condicao: 'aprovado' });

  const to = minimalGraph();
  const rewritten: GraphNode = { ...structuredClone(requireNode(to, 'redigir')), tipo_no: 'portao' };
  const reviewed: GraphNode = {
    ...structuredClone(requireNode(to, 'revisar')),
    papel: 'red-team',
    contrato: structuredClone(OTHER_CONTRACT),
  };
  to.nos = [reviewed, rewritten, structuredClone(NEW_NODE)];
  to.arestas = [
    { de: 'redigir', para: 'revisar', condicao: 'rascunho pronto' },
    { de: 'revisar', para: 'checar_fatos', condicao: 'reprovado' },
  ];

  return { label: 'everything at once', from, to };
}

/** Every fixture of this file, for the sweeps that run over all of them. */
const FIXTURES: Array<() => Pair> = [
  nodeOnlyInTo,
  nodeOnlyInFrom,
  roleChanged,
  roleAndContractChanged,
  typeChanged,
  edgeOnlyInTo,
  edgeOnlyInFrom,
  edgeConditionChanged,
  everythingAtOnce,
];

test('t140 AT1 — two identical documents produce no operation', async () => {
  const { diffGraphs } = await loadDiff();

  assert.deepEqual(diffGraphs(minimalGraph(), minimalGraph()), []);
});

test('t140 AT2 — a node only in `to` becomes a single adicionar_no', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = nodeOnlyInTo();

  assert.deepEqual(diffGraphs(from, to), [
    {
      tipo: 'adicionar_no',
      no: structuredClone(NEW_NODE),
      inversa: { tipo: 'remover_no', no_id: 'checar_fatos' },
    },
  ]);
});

test('t140 AT3 — a node only in `from` becomes a single remover_no', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = nodeOnlyInFrom();

  assert.deepEqual(diffGraphs(from, to), [
    {
      tipo: 'remover_no',
      no_id: 'arquivar',
      inversa: { tipo: 'adicionar_no', no: structuredClone(ARCHIVE_NODE) },
    },
  ]);
});

test('t140 AT4 — a node with only `papel` changed becomes a single alterar_campo_no', async () => {
  const { diffGraphs } = await loadDiff();
  const { validateOperation } = await loadOperations();
  const { from, to } = roleChanged();

  const operations = diffGraphs(from, to);

  assert.deepEqual(operations, [
    {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'papel',
      de: 'revisor',
      para: 'red-team',
      inversa: {
        tipo: 'alterar_campo_no',
        no_id: 'revisar',
        campo: 'papel',
        de: 'red-team',
        para: 'revisor',
      },
    },
  ]);
  assert.deepEqual(validateOperation(operations[0]), { valido: true, erros: [] });
});

test('t140 AT5 — `papel` and `contrato` changed become two ops, in the fixed field order', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = roleAndContractChanged();

  const operations = diffGraphs(from, to);

  assert.deepEqual(
    operations.map((operation) => [operation.tipo, (operation as { campo?: string }).campo]),
    [
      ['alterar_campo_no', 'papel'],
      ['alterar_campo_no', 'contrato'],
    ],
    'the fixed order is papel, descricao, skill_ref, contrato — never the key order of the object',
  );
  assert.deepEqual(operations[1], {
    tipo: 'alterar_campo_no',
    no_id: 'revisar',
    campo: 'contrato',
    de: requireNode(from, 'revisar').contrato,
    para: structuredClone(OTHER_CONTRACT),
    inversa: {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'contrato',
      de: structuredClone(OTHER_CONTRACT),
      para: requireNode(from, 'revisar').contrato,
    },
  });
});

test('t140 AT6 — a changed `tipo_no` becomes remover_no immediately followed by adicionar_no', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = typeChanged();

  const operations = diffGraphs(from, to);

  assert.deepEqual(
    operations.map((operation) => operation.tipo),
    ['remover_no', 'adicionar_no'],
    'there is no operation that renames a node type: it is a full swap',
  );
  assert.deepEqual(operations[0], {
    tipo: 'remover_no',
    no_id: 'revisar',
    inversa: { tipo: 'adicionar_no', no: structuredClone(requireNode(from, 'revisar')) },
  });
  assert.deepEqual(operations[1], {
    tipo: 'adicionar_no',
    no: structuredClone(requireNode(to, 'revisar')),
    inversa: { tipo: 'remover_no', no_id: 'revisar' },
  });
});

test('t140 AT7 — an edge only in `to` becomes a single adicionar_aresta', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = edgeOnlyInTo();

  const edge: GraphEdge = { de: 'revisar', para: 'checar_fatos', condicao: 'reprovado' };
  assert.deepEqual(diffGraphs(from, to), [
    {
      tipo: 'adicionar_aresta',
      aresta: edge,
      inversa: { tipo: 'remover_aresta', aresta: { de: 'revisar', para: 'checar_fatos' } },
    },
  ]);
});

test('t140 AT8 — an edge only in `from` becomes a single remover_aresta', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = edgeOnlyInFrom();

  const edge: GraphEdge = { de: 'revisar', para: 'arquivar', condicao: 'aprovado' };
  assert.deepEqual(diffGraphs(from, to), [
    {
      tipo: 'remover_aresta',
      aresta: { de: 'revisar', para: 'arquivar' },
      inversa: { tipo: 'adicionar_aresta', aresta: edge },
    },
  ]);
});

test('t140 AT9 — a changed `condicao` becomes remover_aresta immediately followed by adicionar_aresta', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = edgeConditionChanged();

  assert.deepEqual(diffGraphs(from, to), [
    {
      tipo: 'remover_aresta',
      aresta: { de: 'redigir', para: 'revisar' },
      inversa: { tipo: 'adicionar_aresta', aresta: structuredClone(from.arestas[0]) },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: structuredClone(to.arestas[0]),
      inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: 'revisar' } },
    },
  ]);
});

test('t140 AT10 — the round trip closes over a document combining every change type', async () => {
  const { diffGraphs } = await loadDiff();
  const { applyOperations } = await loadOperations();
  const { from, to } = everythingAtOnce();

  const operations = diffGraphs(from, to);
  const result = applyOperations(from, operations);

  assert.deepEqual(canonicalize(result.nos), canonicalize(to.nos));
  assert.deepEqual(canonicalize(result.arestas), canonicalize(to.arestas));
  assert.deepEqual(
    from,
    everythingAtOnce().from,
    'diffGraphs and applyOperations cannot mutate the input document',
  );
});

test('t140 AT10 — the round trip closes over every fixture of this file', async () => {
  const { diffGraphs } = await loadDiff();
  const { applyOperations } = await loadOperations();

  for (const fixture of FIXTURES) {
    const { label, from, to } = fixture();
    const result = applyOperations(from, diffGraphs(from, to));
    assert.deepEqual(canonicalize(result.nos), canonicalize(to.nos), label);
    assert.deepEqual(canonicalize(result.arestas), canonicalize(to.arestas), label);
  }
});

test('t140 AT11 — every operation the engine emits passes validateOperation unmodified', async () => {
  const { diffGraphs } = await loadDiff();
  const { validateOperation } = await loadOperations();

  const problems: string[] = [];
  let total = 0;
  for (const fixture of FIXTURES) {
    const { label, from, to } = fixture();
    diffGraphs(from, to).forEach((operation, index) => {
      total += 1;
      const report = validateOperation(operation);
      if (report.valido) return;
      problems.push(`${label} #${index}: ${report.erros.map((one) => one.mensagem).join('; ')}`);
    });
  }

  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(total > 10, `the sweep only saw ${total} operations; the fixtures are not being diffed`);
});

test('t140 FR1 — the identity fields are never diffed, whatever they say', async () => {
  const { diffGraphs } = await loadDiff();

  const from = minimalGraph();
  const to = minimalGraph();
  to.classe = 'outra-classe';
  to.linhagem = { tipo: 'variante', base_classe: 'nota-curta' };
  to.metadata = { nome: 'outro nome' };
  to.no_inicial = 'revisar';
  to.nos_finais = ['redigir'];

  assert.deepEqual(
    diffGraphs(from, to),
    [],
    'the five-op vocabulary has no operation for them, so a promoted diff keeps the target identity',
  );
});
