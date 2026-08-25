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
 * The vocabulary is English on both halves since D20's third child (t228): the
 * operation-type names, the operation's own keys and the validation report speak
 * `docs/spec/glossario-wire.md` §3, and the document fragments an operation
 * carries have spoken English since t178. A Portuguese-keyed operation is no
 * longer an older spelling of the same thing — it is an unknown type.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type * as OperationsModule from '../src/domain/operations.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

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

test('AT3 — add_node + add_edge add the target without mutating the input', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  const operations: OperationsModule.Operation[] = [
    {
      type: 'add_node',
      node: structuredClone(NEW_NODE),
      inverse: { type: 'remove_node', node_id: NEW_NODE.id },
    },
    {
      type: 'add_edge',
      edge: { from: 'redigir', to: NEW_NODE.id, condition: 'sempre' },
      inverse: { type: 'remove_edge', edge: { from: 'redigir', to: NEW_NODE.id } },
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

test('AT4 — remove_node and remove_edge remove exactly the target', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  const review = requireNode(input, 'revisar');
  const originalEdge = input.edges[0];

  // The result is deliberately NOT sound (final_nodes points at a node that
  // stopped existing): applying does not validate — the FR8 gate is what does.
  const result = applyOperations(input, [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar' },
      inverse: { type: 'add_edge', edge: structuredClone(originalEdge) },
    },
    {
      type: 'remove_node',
      node_id: 'revisar',
      inverse: { type: 'add_node', node: structuredClone(review) },
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

test('AT4 — change_node_field swaps the declared field and nothing else', async () => {
  const { applyOperations } = await loadOperations();

  const input = minimalGraph();
  assert.equal(requireNode(input, 'revisar').role, 'revisor');

  const result = applyOperations(input, [
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

  assert.equal(requireNode(result, 'revisar').role, 'red-team');
  assert.deepEqual(
    result.nodes.map((node) => node.id),
    input.nodes.map((node) => node.id),
    'changing a field does not touch the topology',
  );
  assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
});

test('t167 — escalation_policy and escalation_recipient are fields change_node_field may swap', async () => {
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
    { field: 'escalation_policy' as const, from: null, to: 'never' },
    { field: 'escalation_recipient' as const, from: null, to: 'editor-de-plantao' },
  ];

  for (const { field, from, to } of cases) {
    const operation = {
      type: 'change_node_field' as const,
      node_id: 'revisar',
      field,
      from,
      to,
      inverse: { type: 'change_node_field' as const, node_id: 'revisar', field, from: to, to: from },
    };

    assert.deepEqual(
      validateOperation(operation),
      { valid: true, errors: [] },
      `"${field}" has to be accepted, with its inverse`,
    );

    const input = minimalGraph();
    const result = applyOperations(input, [operation]);
    assert.equal(
      (requireNode(result, 'revisar') as unknown as Record<string, unknown>)[field],
      to,
      `applying has to write "${field}" on the target node`,
    );
    assert.deepEqual(input, minimalGraph(), 'applyOperations cannot mutate the input document');
  }
});

test('AT5 — an unknown type, a missing inverse and an incompatible inverse fail with an identifiable error', async () => {
  const { validateOperation } = await loadOperations();

  const valid = validateOperation({
    type: 'add_node',
    node: structuredClone(NEW_NODE),
    inverse: { type: 'remove_node', node_id: NEW_NODE.id },
  });
  assert.deepEqual(valid, { valid: true, errors: [] }, 'the well-formed operation has to pass');

  const unknown = validateOperation({
    type: 'rename_node',
    node_id: 'revisar',
    inverse: { type: 'rename_node', node_id: 'revisar' },
  });
  assert.equal(unknown.valid, false);
  assert.ok(
    unknown.errors.some((error) => error.code === 'unknown_type'),
    `expected unknown_type, got ${JSON.stringify(unknown.errors)}`,
  );

  const withoutInverse = validateOperation({ type: 'add_node', node: structuredClone(NEW_NODE) });
  assert.equal(withoutInverse.valid, false);
  assert.ok(
    withoutInverse.errors.some((error) => error.code === 'missing_inverse'),
    `expected missing_inverse, got ${JSON.stringify(withoutInverse.errors)}`,
  );

  const wrongInverse = validateOperation({
    type: 'add_node',
    node: structuredClone(NEW_NODE),
    inverse: { type: 'remove_edge', edge: { from: 'redigir', to: 'revisar' } },
  });
  assert.equal(wrongInverse.valid, false);
  assert.ok(
    wrongInverse.errors.some((error) => error.code === 'incompatible_inverse'),
    `expected incompatible_inverse, got ${JSON.stringify(wrongInverse.errors)}`,
  );

  const inverseOfAnotherTarget = validateOperation({
    type: 'add_node',
    node: structuredClone(NEW_NODE),
    inverse: { type: 'remove_node', node_id: 'outro_no' },
  });
  assert.equal(inverseOfAnotherTarget.valid, false, 'the inverse has to undo THE SAME target');
  assert.ok(inverseOfAnotherTarget.errors.some((error) => error.code === 'incompatible_inverse'));

  const unchangeableField = validateOperation({
    type: 'change_node_field',
    node_id: 'revisar',
    field: 'id',
    from: 'revisar',
    to: 'revisar_tudo',
    inverse: {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'id',
      from: 'revisar_tudo',
      to: 'revisar',
    },
  });
  assert.equal(unchangeableField.valid, false, 'swapping an id is an operation of its own, not a field swap');
  assert.ok(unchangeableField.errors.some((error) => error.code === 'field_not_changeable'));
});

/* -------------------------------------------------------------------------- */
/* t228 — the §3 vocabulary is English, and only English.                      */
/*                                                                            */
/* D20's third child renames the operation on the wire. The half that matters  */
/* is not that the new spelling is accepted — it is that the OLD one stops     */
/* being: dev databases are recreated (D20), so an operation still spelled in  */
/* Portuguese is not an older dialect to fall back on, it is an unknown type.  */
/* A validator that quietly took both would be the second vocabulary this      */
/* whole migration exists to avoid.                                           */
/* -------------------------------------------------------------------------- */

test('t228 AT — the five type names, the keys and the report all speak §3 English', async () => {
  const { OPERATION_TYPES, validateOperation, applyOperations } = await loadOperations();

  assert.deepEqual(
    [...OPERATION_TYPES],
    ['add_node', 'remove_node', 'add_edge', 'remove_edge', 'change_node_field'],
    'the five names, in the order the specification presents them',
  );

  // The report shape itself is part of §3: `{valid, errors: [{code, message}]}`.
  const report = validateOperation({
    type: 'add_node',
    node: structuredClone(NEW_NODE),
    inverse: { type: 'remove_node', node_id: NEW_NODE.id },
  });
  assert.deepEqual(Object.keys(report).sort(), ['errors', 'valid']);
  assert.deepEqual(report, { valid: true, errors: [] });

  const broken = validateOperation({ type: 'remove_node', node_id: '' });
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.length > 0, 'a broken operation has to report at least one error');
  for (const error of broken.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message']);
  }

  // And the whole vocabulary round-trips through application, not only through
  // validation: every key an operation carries has to be the one applyOperations
  // reads, or the rename would pass the gate and lose the payload.
  const result = applyOperations(minimalGraph(), [
    {
      type: 'add_node',
      node: structuredClone(NEW_NODE),
      inverse: { type: 'remove_node', node_id: NEW_NODE.id },
    },
    {
      type: 'add_edge',
      edge: { from: 'revisar', to: NEW_NODE.id, condition: 'reprovado' },
      inverse: { type: 'remove_edge', edge: { from: 'revisar', to: NEW_NODE.id } },
    },
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
  assert.ok(result.nodes.some((node) => node.id === NEW_NODE.id));
  assert.ok(result.edges.some((edge) => edge.from === 'revisar' && edge.to === NEW_NODE.id));
  assert.equal(requireNode(result, 'revisar').role, 'red-team');
});

test('t228 AT — a Portuguese-keyed operation is an unknown type, not an older spelling', async () => {
  const { validateOperation, OPERATION_TYPES } = await loadOperations();

  for (const type of [
    'adicionar_no',
    'remover_no',
    'adicionar_aresta',
    'remover_aresta',
    'alterar_campo_no',
  ]) {
    assert.ok(!OPERATION_TYPES.includes(type), `"${type}" must no longer be a known type`);
  }

  const portuguese = validateOperation({
    tipo: 'adicionar_no',
    no: structuredClone(NEW_NODE),
    inversa: { tipo: 'remover_no', no_id: NEW_NODE.id },
  });
  assert.equal(portuguese.valid, false, 'the old vocabulary is not accepted alongside the new one');
  assert.ok(
    portuguese.errors.some((error) => error.code === 'unknown_type'),
    `expected unknown_type, got ${JSON.stringify(portuguese.errors)}`,
  );
});

test('t228 AT — the unknown-edge target names the ends in English', async () => {
  const { applyOperations, ApplicationError } = await loadOperations();

  // `remove_edge` carries an `EdgeReference`, and the payload that says which
  // edge was missing has to spell it the way the reference does — `de`/`para`
  // here would be the one place in the flow where the two disagree.
  assert.throws(
    () =>
      applyOperations(minimalGraph(), [
        {
          type: 'remove_edge',
          edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
          inverse: {
            type: 'add_edge',
            edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
          },
        },
      ]),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'unknown_edge' &&
      JSON.stringify(error.target) ===
        JSON.stringify({ from: 'revisar', to: 'redigir', condition: 'retrabalho' }),
  );

  // With no `condition` declared, the payload carries only the two ends.
  assert.throws(
    () =>
      applyOperations(minimalGraph(), [
        {
          type: 'remove_edge',
          edge: { from: 'revisar', to: 'redigir' },
          inverse: { type: 'add_edge', edge: { from: 'revisar', to: 'redigir', condition: 'x' } },
        },
      ]),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'unknown_edge' &&
      JSON.stringify(error.target) === JSON.stringify({ from: 'revisar', to: 'redigir' }),
  );
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
          type: 'remove_node',
          node_id: ghost.id,
          inverse: { type: 'add_node', node: ghost },
        },
      ]),
    (error: unknown) => error instanceof ApplicationError && error.code === 'unknown_node',
  );

  assert.throws(
    () =>
      applyOperations(minimalGraph(), [
        {
          type: 'add_node',
          node: structuredClone(requireNode(minimalGraph(), 'redigir')),
          inverse: { type: 'remove_node', node_id: 'redigir' },
        },
      ]),
    (error: unknown) => error instanceof ApplicationError && error.code === 'duplicate_node',
  );
});

/* -------------------------------------------------------------------------- */
/* t166 — engine and model become proposable fields.                           */
/*                                                                            */
/* No new operation type: `change_node_field` already validates the shape and   */
/* the inverse, so what this ficha changes is one allowlist. The regression    */
/* half matters as much as the addition — a `field` outside the list has to    */
/* stay refused, or the allowlist has stopped being one.                       */
/* -------------------------------------------------------------------------- */

/** A swap of one node field, with the inverse `change_node_field` demands. */
function swapField(field: string, from: unknown, to: unknown): unknown {
  return {
    type: 'change_node_field',
    node_id: 'revisar',
    field,
    from,
    to,
    inverse: { type: 'change_node_field', node_id: 'revisar', field, from: to, to: from },
  };
}

test('t166 AT — change_node_field accepts engine and model, with a well-formed inverse', async () => {
  const { validateOperation, CHANGEABLE_FIELDS } = await loadOperations();

  for (const field of ['engine', 'model'] as const) {
    assert.ok(
      CHANGEABLE_FIELDS.includes(field),
      `CHANGEABLE_FIELDS has to carry "${field}" — a field nobody can propose is a field nobody can version`,
    );
  }

  const engine = validateOperation(swapField('engine', 'claude-code', 'codex'));
  assert.deepEqual(engine, { valid: true, errors: [] });

  // `null` for the before-value of a node that declared nothing: `from` has to be
  // PRESENT (the shape check demands the key), and JSON — which is how a
  // proposal actually arrives — has no way to carry `undefined`.
  const model = validateOperation(swapField('model', null, 'claude-haiku-4-5'));
  assert.deepEqual(model, { valid: true, errors: [] });

  // The surveyor's own use case: a smaller model on the gate. `from: undefined`
  // above is the node that declared nothing; here the node had one already.
  const downgrade = validateOperation(swapField('model', 'claude-opus-5', 'claude-haiku-4-5'));
  assert.deepEqual(downgrade, { valid: true, errors: [] });
});

test('t166 AT — a field outside CHANGEABLE_FIELDS is still refused (regression)', async () => {
  const { validateOperation, CHANGEABLE_FIELDS } = await loadOperations();

  for (const field of ['id', 'node_type', 'motor', 'modelo']) {
    assert.ok(!CHANGEABLE_FIELDS.includes(field), `the guard is vacuous: "${field}" is allowed`);
    const report = validateOperation(swapField(field, 'antes', 'depois'));
    assert.equal(report.valid, false, `"${field}" must not be swappable by change_node_field`);
    assert.ok(report.errors.some((error) => error.code === 'field_not_changeable'));
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

/* -------------------------------------------------------------------------- */
/* t205 — two parallel edges are two edges.                                    */
/*                                                                            */
/* The format has always allowed two edges between the same pair of nodes with */
/* different `condition`s, and `remove_edge` had no way of saying WHICH of  */
/* the two it meant: `EdgeReference` was `{from, to}` and application removed  */
/* the first hit. `condition` on the target closes that, and stays OPTIONAL —  */
/* every operation already stored in `proposta.operacoes` omits it, and has to */
/* keep applying exactly as it did (D2: nothing is rewritten in place).        */
/* -------------------------------------------------------------------------- */

/** The minimal graph with two parallel edges, told apart only by `condition`. */
function graphWithParallelEdges(): GraphDocument {
  const document = minimalGraph();
  document.edges = [
    { from: 'redigir', to: 'revisar', condition: 'aprovado' },
    { from: 'redigir', to: 'revisar', condition: 'reprovado' },
  ];
  return document;
}

/** `add_edge` of one edge, with the removal that undoes it. */
function addEdge(condition: string, inverseCondition?: string): unknown {
  const edge = { from: 'redigir', to: 'revisar', condition };
  const target: Record<string, string> =
    inverseCondition === undefined
      ? { from: 'redigir', to: 'revisar' }
      : { from: 'redigir', to: 'revisar', condition: inverseCondition };
  return { type: 'add_edge', edge, inverse: { type: 'remove_edge', edge: target } };
}

test('t205 AT — remove_edge with a condition removes exactly that parallel edge', async () => {
  const { applyOperations } = await loadOperations();

  const input = graphWithParallelEdges();
  const result = applyOperations(input, [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 'reprovado' },
      inverse: {
        type: 'add_edge',
        edge: { from: 'redigir', to: 'revisar', condition: 'reprovado' },
      },
    },
  ]);

  assert.deepEqual(
    result.edges,
    [{ from: 'redigir', to: 'revisar', condition: 'aprovado' }],
    'the sibling edge, which the operation never named, has to stay',
  );
  assert.deepEqual(
    input,
    graphWithParallelEdges(),
    'applyOperations cannot mutate the input document',
  );
});

test('t205 AT — remove_edge without a condition still removes the first edge by its two ends', async () => {
  const { applyOperations } = await loadOperations();

  // The shape every operation stored before this ticket has, and the one
  // `diff.ts` keeps emitting: no `condition`, first hit by `from`/`to`.
  const result = applyOperations(graphWithParallelEdges(), [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar' },
      inverse: {
        type: 'add_edge',
        edge: { from: 'redigir', to: 'revisar', condition: 'aprovado' },
      },
    },
  ]);

  assert.deepEqual(
    result.edges,
    [{ from: 'redigir', to: 'revisar', condition: 'reprovado' }],
    'an old-format target has to keep matching the first edge, exactly as before',
  );
});

test('t205 AT — an inverse pair whose condition agrees is a valid pair', async () => {
  const { validateOperation } = await loadOperations();

  assert.deepEqual(validateOperation(addEdge('aprovado', 'aprovado')), { valid: true, errors: [] });
});

test('t205 AT — an inverse pair whose condition disagrees is incompatible', async () => {
  const { validateOperation } = await loadOperations();

  const report = validateOperation(addEdge('aprovado', 'reprovado'));
  assert.equal(report.valid, false, 'undoing another parallel edge is not undoing this one');
  assert.ok(
    report.errors.some((error) => error.code === 'incompatible_inverse'),
    `expected incompatible_inverse, got ${JSON.stringify(report.errors)}`,
  );
});

test('t205 AT — an inverse pair whose target omits condition stays valid (legacy shape)', async () => {
  const { validateOperation } = await loadOperations();

  assert.deepEqual(validateOperation(addEdge('aprovado')), { valid: true, errors: [] });

  // And the other way round: the removal names the edge, the addition that
  // undoes it is the whole edge anyway. Only two DECLARED conditions can clash.
  assert.deepEqual(
    validateOperation({
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 'aprovado' },
      inverse: { type: 'add_edge', edge: { from: 'redigir', to: 'revisar', condition: 'aprovado' } },
    }),
    { valid: true, errors: [] },
  );
});

test('t205 AT — a condition that is not a string is refused on either edge operation', async () => {
  const { validateOperation } = await loadOperations();

  for (const operation of [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 7 },
      inverse: { type: 'add_edge', edge: { from: 'redigir', to: 'revisar', condition: 'aprovado' } },
    },
    {
      type: 'add_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 7 },
      inverse: { type: 'remove_edge', edge: { from: 'redigir', to: 'revisar' } },
    },
  ]) {
    const report = validateOperation(operation);
    assert.equal(report.valid, false, `a numeric condition has to be refused: ${JSON.stringify(operation)}`);
    assert.ok(report.errors.some((error) => error.code === 'invalid_field'));
  }
});
