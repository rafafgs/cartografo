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

test('t167 — escalation_policy and escalation_recipient are fields alterar_campo_no may swap', async () => {
  const { CHANGEABLE_FIELDS, validateOperation, applyOperations } = await loadOperations();

  assert.ok(
    CHANGEABLE_FIELDS.includes('escalation_policy'),
    `escalation_policy has to be changeable, got ${CHANGEABLE_FIELDS.join(', ')}`,
  );
  assert.ok(
    CHANGEABLE_FIELDS.includes('escalation_recipient'),
    `escalation_recipient has to be changeable, got ${CHANGEABLE_FIELDS.join(', ')}`,
  );

  // Whether a node ever asks a human is node data like any other, so it changes
  // through the machinery that already versions and re-validates — no second
  // mutation path, which is the whole point of FR2.
  const cases = [
    { campo: 'escalation_policy' as const, de: null, para: 'never' },
    { campo: 'escalation_recipient' as const, de: null, para: 'editor-de-plantao' },
  ];

  for (const { campo, de, para } of cases) {
    const operation = {
      tipo: 'alterar_campo_no' as const,
      no_id: 'revisar',
      campo,
      de,
      para,
      inversa: { tipo: 'alterar_campo_no' as const, no_id: 'revisar', campo, de: para, para: de },
    };

    assert.deepEqual(
      validateOperation(operation),
      { valido: true, erros: [] },
      `"${campo}" has to be accepted, with its inverse`,
    );

    const input = minimalGraph();
    const result = applyOperations(input, [operation]);
    assert.equal(
      (requireNode(result, 'revisar') as unknown as Record<string, unknown>)[campo],
      para,
      `applying has to write "${campo}" on the target node`,
    );
    assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
  }
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
