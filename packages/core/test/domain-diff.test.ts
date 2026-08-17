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
 * The emitted vocabulary is English since D20's third child (t228): every
 * operation comes out spelling `docs/spec/glossario-wire.md` §3 — `type`,
 * `node`, `node_id`, `edge`, `field`, `from`, `to`, `inverse` — in the same
 * fixed emission order as before.
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
  const node = doc.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`the fixture changed: node "${id}" is gone`);
  return node;
}

/** A complete new node: role, type, pinned skill and a contract with a check. */
const NEW_NODE: GraphNode = {
  id: 'checar_fatos',
  role: 'revisor',
  node_type: 'trabalho',
  description: 'Confere cada afirmação da nota contra a fonte citada.',
  skill_ref: {
    id: 'cartografo/checar-fatos',
    version: '1.0.0',
    hash: `sha256:${'0'.repeat(64)}`,
  },
  contract: {
    input_schema: {
      type: 'object',
      required: ['texto'],
      properties: { texto: { type: 'string', minLength: 1 } },
    },
    output_schema: {
      type: 'object',
      required: ['aprovado'],
      properties: { aprovado: { type: 'boolean' } },
    },
    checks: [
      {
        type: 'deterministic',
        command: 'test -s checagem.md',
        description: 'O relatório de checagem existe e não está vazio.',
      },
    ],
  },
};

/** A second complete node, used as the one only the `from` side has. */
const ARCHIVE_NODE: GraphNode = {
  id: 'arquivar',
  role: 'arquivista',
  node_type: 'trabalho',
  description: 'Guarda a nota revisada no acervo do projeto.',
  skill_ref: {
    id: 'cartografo/arquivar-nota',
    version: '1.0.0',
    hash: `sha256:${'1'.repeat(64)}`,
  },
  contract: {
    input_schema: {
      type: 'object',
      required: ['texto'],
      properties: { texto: { type: 'string', minLength: 1 } },
    },
    output_schema: {
      type: 'object',
      required: ['caminho'],
      properties: { caminho: { type: 'string', minLength: 1 } },
    },
    checks: [
      {
        type: 'deterministic',
        command: 'test -s acervo/nota.md',
        description: 'A nota chegou ao acervo.',
      },
    ],
  },
};

/** A contract different from `revisar`'s, so the field really changes. */
const OTHER_CONTRACT = {
  input_schema: {
    type: 'object',
    required: ['texto'],
    properties: { texto: { type: 'string' } },
  },
  output_schema: {
    type: 'object',
    required: ['resultado'],
    properties: { resultado: { enum: ['passou', 'falhou'] } },
  },
  checks: [
    {
      type: 'agentic',
      instruction: 'A nota sobrevive a uma leitura adversarial? Cite o trecho mais frágil.',
      required_evidence: true,
      description: 'Leitura de red team, com evidência própria.',
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
  to.nodes.push(structuredClone(NEW_NODE));
  return { label: 'node only in to', from, to };
}

/** AT3 — the node exists only in `from`. */
function nodeOnlyInFrom(): Pair {
  const from = minimalGraph();
  from.nodes.push(structuredClone(ARCHIVE_NODE));
  const to = minimalGraph();
  return { label: 'node only in from', from, to };
}

/** AT4 — same node, only `role` differs. */
function roleChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  requireNode(to, 'revisar').role = 'red-team';
  return { label: 'role changed', from, to };
}

/** AT5 — same node, `role` and `contract` differ. */
function roleAndContractChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  const node = requireNode(to, 'revisar');
  node.role = 'red-team';
  node.contract = structuredClone(OTHER_CONTRACT);
  return { label: 'role and contract changed', from, to };
}

/** AT6 — same id, `node_type` differs: no field swap can express it. */
function typeChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  requireNode(to, 'revisar').node_type = 'trabalho';
  return { label: 'node type changed', from, to };
}

/** AT7 — the edge exists only in `to`; both ends are already on both sides. */
function edgeOnlyInTo(): Pair {
  const from = minimalGraph();
  from.nodes.push(structuredClone(NEW_NODE));
  const to = minimalGraph();
  to.nodes.push(structuredClone(NEW_NODE));
  to.edges.push({ from: 'revisar', to: 'checar_fatos', condition: 'reprovado' });
  return { label: 'edge only in to', from, to };
}

/** AT8 — the edge exists only in `from`. */
function edgeOnlyInFrom(): Pair {
  const from = minimalGraph();
  from.nodes.push(structuredClone(ARCHIVE_NODE));
  from.edges.push({ from: 'revisar', to: 'arquivar', condition: 'aprovado' });
  const to = minimalGraph();
  to.nodes.push(structuredClone(ARCHIVE_NODE));
  return { label: 'edge only in from', from, to };
}

/** AT9 — same ends, `condition` differs: no operation edits an edge in place. */
function edgeConditionChanged(): Pair {
  const from = minimalGraph();
  const to = minimalGraph();
  to.edges[0] = { ...structuredClone(to.edges[0]), condition: 'rascunho pronto' };
  return { label: 'edge condition changed', from, to };
}

/**
 * AT10 — every change type of AT2-AT9 at once.
 *
 * The order of `to.nodes`/`to.edges` is not decoration: `canonicalize` preserves
 * array order, so the round trip only closes if the emission order of the engine
 * reproduces it. Whatever survives untouched keeps its place, and whatever is
 * (re)added lands after it — which is exactly what removals-then-additions
 * produces.
 */
function everythingAtOnce(): Pair {
  const from = minimalGraph();
  from.nodes.push(structuredClone(ARCHIVE_NODE));
  from.edges.push({ from: 'revisar', to: 'arquivar', condition: 'aprovado' });

  const to = minimalGraph();
  const rewritten: GraphNode = { ...structuredClone(requireNode(to, 'redigir')), node_type: 'portao' };
  const reviewed: GraphNode = {
    ...structuredClone(requireNode(to, 'revisar')),
    role: 'red-team',
    contract: structuredClone(OTHER_CONTRACT),
  };
  to.nodes = [reviewed, rewritten, structuredClone(NEW_NODE)];
  to.edges = [
    { from: 'redigir', to: 'revisar', condition: 'rascunho pronto' },
    { from: 'revisar', to: 'checar_fatos', condition: 'reprovado' },
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

test('t140 AT2 — a node only in `to` becomes a single add_node', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = nodeOnlyInTo();

  assert.deepEqual(diffGraphs(from, to), [
    {
      type: 'add_node',
      node: structuredClone(NEW_NODE),
      inverse: { type: 'remove_node', node_id: 'checar_fatos' },
    },
  ]);
});

test('t140 AT3 — a node only in `from` becomes a single remove_node', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = nodeOnlyInFrom();

  assert.deepEqual(diffGraphs(from, to), [
    {
      type: 'remove_node',
      node_id: 'arquivar',
      inverse: { type: 'add_node', node: structuredClone(ARCHIVE_NODE) },
    },
  ]);
});

test('t140 AT4 — a node with only `role` changed becomes a single change_node_field', async () => {
  const { diffGraphs } = await loadDiff();
  const { validateOperation } = await loadOperations();
  const { from, to } = roleChanged();

  const operations = diffGraphs(from, to);

  assert.deepEqual(operations, [
    {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'role',
      from: 'revisor',
      to: 'red-team',
      inverse: {
        type: 'change_node_field',
        node_id: 'revisar',
        field: 'role',
        from: 'red-team',
        to: 'revisor',
      },
    },
  ]);
  assert.deepEqual(validateOperation(operations[0]), { valid: true, errors: [] });
});

test('t140 AT5 — `role` and `contract` changed become two ops, in the fixed field order', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = roleAndContractChanged();

  const operations = diffGraphs(from, to);

  assert.deepEqual(
    operations.map((operation) => [operation.type, (operation as { field?: string }).field]),
    [
      ['change_node_field', 'role'],
      ['change_node_field', 'contract'],
    ],
    'the fixed order is role, description, skill_ref, contract — never the key order of the object',
  );
  assert.deepEqual(operations[1], {
    type: 'change_node_field',
    node_id: 'revisar',
    field: 'contract',
    from: requireNode(from, 'revisar').contract,
    to: structuredClone(OTHER_CONTRACT),
    inverse: {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'contract',
      from: structuredClone(OTHER_CONTRACT),
      to: requireNode(from, 'revisar').contract,
    },
  });
});

test('t140 AT6 — a changed `node_type` becomes remove_node immediately followed by add_node', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = typeChanged();

  const operations = diffGraphs(from, to);

  assert.deepEqual(
    operations.map((operation) => operation.type),
    ['remove_node', 'add_node'],
    'there is no operation that renames a node type: it is a full swap',
  );
  assert.deepEqual(operations[0], {
    type: 'remove_node',
    node_id: 'revisar',
    inverse: { type: 'add_node', node: structuredClone(requireNode(from, 'revisar')) },
  });
  assert.deepEqual(operations[1], {
    type: 'add_node',
    node: structuredClone(requireNode(to, 'revisar')),
    inverse: { type: 'remove_node', node_id: 'revisar' },
  });
});

test('t140 AT7 — an edge only in `to` becomes a single add_edge', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = edgeOnlyInTo();

  const edge: GraphEdge = { from: 'revisar', to: 'checar_fatos', condition: 'reprovado' };
  assert.deepEqual(diffGraphs(from, to), [
    {
      type: 'add_edge',
      edge: edge,
      inverse: { type: 'remove_edge', edge: { from: 'revisar', to: 'checar_fatos' } },
    },
  ]);
});

test('t140 AT8 — an edge only in `from` becomes a single remove_edge', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = edgeOnlyInFrom();

  const edge: GraphEdge = { from: 'revisar', to: 'arquivar', condition: 'aprovado' };
  assert.deepEqual(diffGraphs(from, to), [
    {
      type: 'remove_edge',
      edge: { from: 'revisar', to: 'arquivar' },
      inverse: { type: 'add_edge', edge: edge },
    },
  ]);
});

test('t140 AT9 — a changed `condition` becomes remove_edge immediately followed by add_edge', async () => {
  const { diffGraphs } = await loadDiff();
  const { from, to } = edgeConditionChanged();

  assert.deepEqual(diffGraphs(from, to), [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar' },
      inverse: { type: 'add_edge', edge: structuredClone(from.edges[0]) },
    },
    {
      type: 'add_edge',
      edge: structuredClone(to.edges[0]),
      inverse: { type: 'remove_edge', edge: { from: 'redigir', to: 'revisar' } },
    },
  ]);
});

test('t140 AT10 — the round trip closes over a document combining every change type', async () => {
  const { diffGraphs } = await loadDiff();
  const { applyOperations } = await loadOperations();
  const { from, to } = everythingAtOnce();

  const operations = diffGraphs(from, to);
  const result = applyOperations(from, operations);

  assert.deepEqual(canonicalize(result.nodes), canonicalize(to.nodes));
  assert.deepEqual(canonicalize(result.edges), canonicalize(to.edges));
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
    assert.deepEqual(canonicalize(result.nodes), canonicalize(to.nodes), label);
    assert.deepEqual(canonicalize(result.edges), canonicalize(to.edges), label);
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
      if (report.valid) return;
      problems.push(`${label} #${index}: ${report.errors.map((one) => one.message).join('; ')}`);
    });
  }

  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(total > 10, `the sweep only saw ${total} operations; the fixtures are not being diffed`);
});

test('t228 AT — every key the engine emits is a §3 English key, at any depth', async () => {
  const { diffGraphs } = await loadDiff();

  /** The §3 vocabulary, plus the document fragments an operation carries. */
  const ALLOWED = new Set(['type', 'node', 'node_id', 'edge', 'field', 'from', 'to', 'inverse']);
  const FORBIDDEN = new Set(['tipo', 'no', 'no_id', 'aresta', 'campo', 'de', 'para', 'inversa']);

  const offenders: string[] = [];
  let total = 0;
  for (const fixture of FIXTURES) {
    const { label, from, to } = fixture();
    for (const operation of diffGraphs(from, to)) {
      total += 1;
      // Only the operation's OWN keys and the inverse's: what lives inside `node`
      // and `edge` is the graph document, which t178 already moved.
      for (const key of Object.keys(operation)) {
        if (FORBIDDEN.has(key)) offenders.push(`${label}: operation key "${key}"`);
        if (!ALLOWED.has(key)) offenders.push(`${label}: unexpected operation key "${key}"`);
      }
      const inverse = (operation as { inverse?: unknown }).inverse;
      for (const key of Object.keys(inverse as object)) {
        if (FORBIDDEN.has(key)) offenders.push(`${label}: inverse key "${key}"`);
        if (!ALLOWED.has(key)) offenders.push(`${label}: unexpected inverse key "${key}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
  assert.ok(total > 10, `the sweep only saw ${total} operations; the fixtures are not being diffed`);
});

test('t140 FR1 — the identity fields are never diffed, whatever they say', async () => {
  const { diffGraphs } = await loadDiff();

  const from = minimalGraph();
  const to = minimalGraph();
  to.problem_class = 'outra-classe';
  to.lineage = { type: 'variante', base_class: 'nota-curta' };
  to.metadata = { nome: 'outro nome' };
  to.initial_node = 'revisar';
  to.final_nodes = ['redigir'];

  assert.deepEqual(
    diffGraphs(from, to),
    [],
    'the five-op vocabulary has no operation for them, so a promoted diff keeps the target identity',
  );
});
