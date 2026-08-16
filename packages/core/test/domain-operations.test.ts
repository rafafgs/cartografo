/**
 * Acceptance tests of the semantic operation vocabulary (t101, FR4).
 *
 * D15 asks for "typed semantic operations + inverses": a proposal's diff is a
 * list of operations over the document, not a line diff. What is proven here is
 * the shape (structural validation, mandatory inverse) and the application
 * (order, deep copy, exact target).
 *
 * What is NOT proven here: that the result is sound. That is the exclusive job
 * of the FR8 gate, and it is deliberate — a structurally correct operation can
 * produce a broken graph, and it is precisely that case the proposal tests
 * (AT14–AT17) exercise.
 *
 * The operation and graph-document field names stay in Portuguese: they are the
 * frozen data format (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type * as OperationsModule from '../src/domain/operations.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

let operationsCache: typeof OperationsModule | null = null;

async function loadOperations(): Promise<typeof OperationsModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'domain', 'operations.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/domain/operations.ts');
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

test('AT3 — adicionar_no + adicionar_aresta add the target without mutating the input', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  const operations: OperationsModule.Operation[] = [
    {
      tipo: 'adicionar_no',
      no: structuredClone(NEW_NODE),
      inversa: { tipo: 'remover_no', no_id: NEW_NODE.id },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { from: 'redigir', to: NEW_NODE.id, condition: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { from: 'redigir', to: NEW_NODE.id } },
    },
  ];

  const result = applyOperations(input, operations);

  assert.ok(
    result.nodes.some((node) => node.id === NEW_NODE.id),
    'the new node has to be in the resulting document',
  );
  assert.ok(
    result.edges.some((edge) => edge.from === 'redigir' && edge.to === NEW_NODE.id),
    'the new edge has to be in the resulting document',
  );

  assert.notEqual(result, input, 'the result has to be a new document');
  assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
});

test('AT4 — remover_no and remover_aresta remove exactly the target', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  const review = requireNode(input, 'revisar');
  const originalEdge = input.edges[0];

  // The result is deliberately NOT sound (final_nodes points at a node that
  // stopped existing): applying does not validate — the FR8 gate is what does.
  const result = applyOperations(input, [
    {
      tipo: 'remover_aresta',
      aresta: { from: 'redigir', to: 'revisar' },
      inversa: { tipo: 'adicionar_aresta', aresta: structuredClone(originalEdge) },
    },
    {
      tipo: 'remover_no',
      no_id: 'revisar',
      inversa: { tipo: 'adicionar_no', no: structuredClone(review) },
    },
  ]);

  assert.deepEqual(
    result.nodes.map((node) => node.id),
    ['redigir'],
    'only the target node can go',
  );
  assert.deepEqual(result.edges, [], 'only the target edge can go');
  assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
});

test('AT4 — alterar_campo_no swaps the declared field and nothing else', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  assert.equal(requireNode(input, 'revisar').role, 'revisor');

  const result = applyOperations(input, [
    {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'role',
      de: 'revisor',
      para: 'red-team',
      inversa: {
        tipo: 'alterar_campo_no',
        no_id: 'revisar',
        campo: 'role',
        de: 'red-team',
        para: 'revisor',
      },
    },
  ]);

  assert.equal(requireNode(result, 'revisar').role, 'red-team');
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    input.nodes.map((node) => node.id),
    'changing a field does not touch the topology',
  );
  assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
});

test('AT5 — an unknown type, a missing inverse and an incompatible inverse fail with an identifiable error', async () => {
  const { validateOperation } = await loadOperations();

  const valid = validateOperation({
    tipo: 'adicionar_no',
    no: structuredClone(NEW_NODE),
    inversa: { tipo: 'remover_no', no_id: NEW_NODE.id },
  });
  assert.deepEqual(valid, { valido: true, erros: [] }, 'the well-formed operation has to pass');

  const unknown = validateOperation({
    tipo: 'renomear_no',
    no_id: 'revisar',
    inversa: { tipo: 'renomear_no', no_id: 'revisar' },
  });
  assert.equal(unknown.valido, false);
  assert.ok(
    unknown.erros.some((error) => error.codigo === 'tipo_desconhecido'),
    `expected tipo_desconhecido, got ${JSON.stringify(unknown.erros)}`,
  );

  const withoutInverse = validateOperation({ tipo: 'adicionar_no', no: structuredClone(NEW_NODE) });
  assert.equal(withoutInverse.valido, false);
  assert.ok(
    withoutInverse.erros.some((error) => error.codigo === 'inversa_ausente'),
    `expected inversa_ausente, got ${JSON.stringify(withoutInverse.erros)}`,
  );

  const wrongInverse = validateOperation({
    tipo: 'adicionar_no',
    no: structuredClone(NEW_NODE),
    inversa: { tipo: 'remover_aresta', aresta: { from: 'redigir', to: 'revisar' } },
  });
  assert.equal(wrongInverse.valido, false);
  assert.ok(
    wrongInverse.erros.some((error) => error.codigo === 'inversa_incompativel'),
    `expected inversa_incompativel, got ${JSON.stringify(wrongInverse.erros)}`,
  );

  const inverseOfAnotherTarget = validateOperation({
    tipo: 'adicionar_no',
    no: structuredClone(NEW_NODE),
    inversa: { tipo: 'remover_no', no_id: 'outro_no' },
  });
  assert.equal(inverseOfAnotherTarget.valido, false, 'the inverse has to undo THE SAME target');
  assert.ok(inverseOfAnotherTarget.erros.some((error) => error.codigo === 'inversa_incompativel'));

  const unchangeableField = validateOperation({
    tipo: 'alterar_campo_no',
    no_id: 'revisar',
    campo: 'id',
    de: 'revisar',
    para: 'revisar_tudo',
    inversa: {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'id',
      de: 'revisar_tudo',
      para: 'revisar',
    },
  });
  assert.equal(unchangeableField.valido, false, 'swapping an id is an operation of its own, not a field swap');
  assert.ok(unchangeableField.erros.some((error) => error.codigo === 'campo_nao_alteravel'));
});

test('AT5 — applying an operation over a missing target throws instead of a silent no-op', async () => {
  const { applyOperations, ApplicationError } = await loadOperations();

  // The inverse has to re-add the SAME node — otherwise the operation never gets
  // applied at all, and what would throw is the shape validation, not the
  // application.
  const ghost: GraphNode = { ...structuredClone(NEW_NODE), id: 'nao_existe' };

  assert.throws(
    () =>
      applyOperations(minimalGraph(), [
        {
          tipo: 'remover_no',
          no_id: ghost.id,
          inversa: { tipo: 'adicionar_no', no: ghost },
        },
      ]),
    (error: unknown) => error instanceof ApplicationError && error.code === 'no_inexistente',
  );

  assert.throws(
    () =>
      applyOperations(minimalGraph(), [
        {
          tipo: 'adicionar_no',
          no: structuredClone(requireNode(minimalGraph(), 'redigir')),
          inversa: { tipo: 'remover_no', no_id: 'redigir' },
        },
      ]),
    (error: unknown) => error instanceof ApplicationError && error.code === 'no_duplicado',
  );
});

/* -------------------------------------------------------------------------- */
/* t166 — engine and model become proposable fields.                           */
/*                                                                            */
/* No new operation type: `alterar_campo_no` already validates the shape and   */
/* the inverse, so what this ficha changes is one allowlist. The regression    */
/* half matters as much as the addition — a `campo` outside the list has to    */
/* stay refused, or the allowlist has stopped being one.                       */
/* -------------------------------------------------------------------------- */

/** A swap of one node field, with the inverse `alterar_campo_no` demands. */
function swapField(field: string, from: unknown, to: unknown): unknown {
  return {
    tipo: 'alterar_campo_no',
    no_id: 'revisar',
    campo: field,
    de: from,
    para: to,
    inversa: { tipo: 'alterar_campo_no', no_id: 'revisar', campo: field, de: to, para: from },
  };
}

test('t166 AT — alterar_campo_no accepts engine and model, with a well-formed inverse', async () => {
  const { validateOperation, CHANGEABLE_FIELDS } = await loadOperations();

  for (const field of ['engine', 'model'] as const) {
    assert.ok(
      CHANGEABLE_FIELDS.includes(field),
      `CHANGEABLE_FIELDS has to carry "${field}" — a field nobody can propose is a field nobody can version`,
    );
  }

  const engine = validateOperation(swapField('engine', 'claude-code', 'codex'));
  assert.deepEqual(engine, { valido: true, erros: [] });

  // `null` for the before-value of a node that declared nothing: `de` has to be
  // PRESENT (the shape check demands the key), and JSON — which is how a
  // proposal actually arrives — has no way to carry `undefined`.
  const model = validateOperation(swapField('model', null, 'claude-haiku-4-5'));
  assert.deepEqual(model, { valido: true, erros: [] });

  // The surveyor's own use case: a smaller model on the gate. `de: undefined`
  // above is the node that declared nothing; here the node had one already.
  const downgrade = validateOperation(swapField('model', 'claude-opus-5', 'claude-haiku-4-5'));
  assert.deepEqual(downgrade, { valido: true, erros: [] });
});

test('t166 AT — a campo outside CHANGEABLE_FIELDS is still refused (regression)', async () => {
  const { validateOperation, CHANGEABLE_FIELDS } = await loadOperations();

  for (const field of ['id', 'node_type', 'motor', 'modelo']) {
    assert.ok(!CHANGEABLE_FIELDS.includes(field), `the guard is vacuous: "${field}" is allowed`);
    const report = validateOperation(swapField(field, 'antes', 'depois'));
    assert.equal(report.valido, false, `"${field}" must not be swappable by alterar_campo_no`);
    assert.ok(report.erros.some((error) => error.codigo === 'campo_nao_alteravel'));
  }
});

test('t166 AT — applying an engine/model swap changes that field and nothing else', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  assert.equal(requireNode(input, 'revisar').model, undefined, 'the fixture declares no model');

  const result = applyOperations(input, [
    swapField('engine', null, 'codex'),
    swapField('model', null, 'gpt-5.6-luna'),
  ] as OperationsModule.Operation[]);

  assert.equal(requireNode(result, 'revisar').engine, 'codex');
  assert.equal(requireNode(result, 'revisar').model, 'gpt-5.6-luna');
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    input.nodes.map((node) => node.id),
    'changing a field does not touch the topology',
  );
  assert.equal(requireNode(result, 'redigir').model, undefined, 'only the target node moves');
  assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
});
