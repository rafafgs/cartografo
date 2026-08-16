/**
 * Acceptance tests of t96 — the graph document format.
 *
 * They cover the ticket's three artifacts: the JSON Schema
 * (`schema/grafo.schema.json`), the reference validator
 * (`scripts/validar-grafo.mjs`) and the six fixtures in `schema/exemplos/`.
 * Zero dependencies: only `node:test`, `node:assert`, `node:fs` and `node:path`
 * (FR9).
 *
 * The schema's own keys are English since t178: the 2026-08-15 D18 amendment
 * lifted the carve-out that used to keep the two data formats in Portuguese.
 * What stays Portuguese here is what that amendment did NOT reopen — the
 * fixture file names, the reference validator's pinned exports and its report
 * vocabulary, frozen by `packages/core/test/domain-graph.test.ts`
 * (t133, exception 5) and by their own separate decision.
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'schema', 'grafo.schema.json');
const VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validar-grafo.mjs');
const EXAMPLES_DIR = path.join(ROOT, 'schema', 'exemplos');

const TOP_LEVEL_KEYS = [
  'problem_class',
  'lineage',
  'metadata',
  'nodes',
  'edges',
  'initial_node',
  'final_nodes',
];

/** Reads a JSON file from the repo, failing with its relative path if missing. */
function readJson(filePath) {
  assert.ok(existsSync(filePath), `artifact does not exist yet: ${path.relative(ROOT, filePath)}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Reads a fixture from `schema/exemplos/` by file name. */
function readExample(name) {
  return readJson(path.join(EXAMPLES_DIR, name));
}

let validatorModule = null;

/**
 * Imports the reference validator on demand.
 *
 * The existence check comes before the `import()` on purpose: in the initial
 * red the test fails saying which artifact is missing, rather than with a raw
 * ERR_MODULE_NOT_FOUND.
 */
async function loadValidator() {
  assert.ok(
    existsSync(VALIDATOR_PATH),
    `artifact does not exist yet: ${path.relative(ROOT, VALIDATOR_PATH)}`,
  );
  validatorModule ??= await import(new URL('../scripts/validar-grafo.mjs', import.meta.url));
  return validatorModule;
}

test('AT1 — the schema is valid JSON, declares draft 2020-12, $id and the seven top keys', () => {
  const schema = readJson(SCHEMA_PATH);

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(typeof schema.$id, 'string');
  assert.ok(schema.$id.length > 0, '$id has to be a non-empty string');
  assert.ok(schema.$id.includes('1.0.0'), '$id has to version the schema (1.0.0)');

  assert.equal(typeof schema.properties, 'object');
  for (const key of TOP_LEVEL_KEYS) {
    assert.ok(Object.hasOwn(schema.properties, key), `properties has to declare "${key}"`);
    assert.ok(schema.required.includes(key), `required has to list "${key}"`);
  }
  // Exactly these, in this order (t178): a leftover Portuguese key would still
  // satisfy the loop above, and it is precisely what the rename cannot leave.
  assert.deepEqual([...schema.required].sort(), [...TOP_LEVEL_KEYS].sort());
  assert.deepEqual(Object.keys(schema.properties).sort(), [...TOP_LEVEL_KEYS].sort());
});

test('AT1 — every fixture in schema/exemplos validates against the schema', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);
  const names = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith('.json')).sort();

  assert.equal(names.length, 8, `expected the eight committed fixtures, found ${names.length}`);

  // Two of the counterexamples break SHAPE as well as soundness, and they do it
  // on purpose: an edge whose condition is the empty string trips `minLength`,
  // and a node with no contract trips `required`. Those two pointers are named
  // here rather than skipped, so the fixtures stay refused for the reason they
  // were written for — and every other fixture stays shape-clean.
  const SHAPE_BREAKS = {
    'grafo-invalido-aresta-sem-condicao.json': ['/edges/0/condition'],
    'grafo-invalido-no-sem-contrato.json': ['/nodes/1'],
  };

  for (const name of names) {
    assert.deepEqual(
      validateAgainstSchema(readExample(name), schema).map((error) => error.pointer),
      SHAPE_BREAKS[name] ?? [],
      `${name}: shape`,
    );
  }
});

test('AT2 — the minimal example passes validarEstrutura and validarSoundness', async () => {
  const { validarEstrutura, validarSoundness } = await loadValidator();
  const doc = readExample('grafo-valido-minimo.json');

  const structure = validarEstrutura(doc);
  assert.deepEqual(structure.erros, []);
  assert.equal(structure.valido, true);

  const soundness = validarSoundness(doc);
  assert.deepEqual(soundness.violacoes, []);
  assert.equal(soundness.valido, true);
});

/*
 * Fixed flowpilot table, copied by hand from
 * `~/flowpilot/app/services/flow/state_machine.py` (ACTIVITY_STATES, lines
 * 153-161; ALLOWED_TRANSITIONS, lines 91-104). The test does NOT read
 * flowpilot's file — D17: a behavioural reference, with no code dependency.
 *
 * The transitions below are ALLOWED_TRANSITIONS with the queue states
 * (`to_develop`, `to_integrate`, …) collapsed, since those are the controller's
 * scheduling plumbing and never become a node. Collapsed, FIVE activity →
 * activity pairs remain. The ticket says "6 edges" in its acceptance criteria;
 * the sixth would be `deploying -> done`, but `done` is not an activity state
 * and FR7 pins `final_nodes: ["implantar"]` — so there is no destination node
 * for it.
 */
const FLOWPILOT_NODE_BY_STATE = {
  refining: 'refinar',
  developing: 'desenvolver',
  integrating: 'integrar',
  testing: 'testar',
  deploying: 'implantar',
};

const FLOWPILOT_ROLE_BY_NODE = {
  refinar: 'arquiteto',
  desenvolver: 'desenvolvedor',
  integrar: 'integrador',
  testar: 'tester',
  implantar: 'deployer',
};

const FLOWPILOT_ACTIVITY_TRANSITIONS = [
  ['refining', 'developing'],
  ['developing', 'integrating'],
  ['integrating', 'testing'],
  ['testing', 'deploying'],
  ['testing', 'developing'], // rework cycle (state_machine.py:100)
];

test('AT3 — the flowpilot graph is sound and maps 1:1 onto the activity states', async () => {
  const { validarEstrutura, validarSoundness } = await loadValidator();
  const doc = readExample('grafo-valido-flowpilot.json');

  assert.deepEqual(validarEstrutura(doc).erros, []);
  assert.deepEqual(validarSoundness(doc).violacoes, []);

  const expectedIds = Object.values(FLOWPILOT_NODE_BY_STATE).sort();
  assert.deepEqual(doc.nodes.map((node) => node.id).sort(), expectedIds);

  for (const node of doc.nodes) {
    assert.equal(node.role, FLOWPILOT_ROLE_BY_NODE[node.id], `expected role for node "${node.id}"`);
  }

  const expectedEdges = FLOWPILOT_ACTIVITY_TRANSITIONS.map(
    ([from, to]) => `${FLOWPILOT_NODE_BY_STATE[from]}>${FLOWPILOT_NODE_BY_STATE[to]}`,
  ).sort();
  const docEdges = doc.edges.map((edge) => `${edge.from}>${edge.to}`).sort();
  assert.deepEqual(docEdges, expectedEdges);

  assert.ok(
    docEdges.includes('testar>desenvolver'),
    'the rework cycle testar → desenvolver has to exist',
  );
  assert.equal(doc.initial_node, 'refinar');
  assert.deepEqual(doc.final_nodes, ['implantar']);
});

test('AT4 — an unreachable node produces exactly one "alcançável" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('grafo-invalido-no-inalcancavel.json');

  const { valido: valid, violacoes: violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].regra, 'alcançável');
  assert.ok(
    doc.nodes.some((node) => node.id === violations[0].alvo),
    'the target has to be the id of a node in the document',
  );
  assert.ok(
    !doc.edges.some((edge) => edge.to === violations[0].alvo),
    'the target has to be the orphan node (with no incoming edge)',
  );
});

test('AT5 — a node stuck in a cycle with no way out produces a "termina" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('grafo-invalido-sem-terminacao.json');

  const { valido: valid, violacoes: violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].regra, 'termina');

  const stuck = violations[0].alvo;
  assert.ok(
    doc.nodes.some((node) => node.id === stuck),
    'the target has to be the id of a node in the document',
  );
  assert.ok(
    !doc.final_nodes.includes(stuck),
    'a final node can never be the target of the "termina" rule',
  );
  assert.ok(
    doc.edges.some((edge) => edge.from === stuck && edge.to === stuck),
    'the stuck node is the one in the cycle with no way out',
  );
});

test('AT6 — an edge with no condition produces an "aresta_com_condicao" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('grafo-invalido-aresta-sem-condicao.json');

  const { valido: valid, violacoes: violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);

  const withoutCondition = doc.edges.find(
    (edge) => typeof edge.condition !== 'string' || edge.condition.trim() === '',
  );
  assert.deepEqual(violations[0], {
    regra: 'aresta_com_condicao',
    alvo: { de: withoutCondition.from, para: withoutCondition.to },
  });
});

test('AT7 — a node with no contract produces a "no_com_contrato" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('grafo-invalido-no-sem-contrato.json');

  const { valido: valid, violacoes: violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);

  const withoutContract = doc.nodes.find((node) => node.contract == null || node.skill_ref == null);
  assert.deepEqual(violations[0], {
    regra: 'no_com_contrato',
    alvo: withoutContract.id,
  });
});

test('t167 — escalation_policy is an optional enum on the node, and recipient is free text', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);

  // 1. Absence is the whole backward-compatibility story: a graph written before
  // the field existed declares nothing and stays valid, exactly as `engine` did.
  const before = readExample('grafo-valido-minimo.json');
  assert.ok(
    before.nodes.every((node) => !Object.hasOwn(node, 'escalation_policy')),
    'the minimal fixture must keep declaring nothing: it is the "absent" case',
  );
  assert.deepEqual(validateAgainstSchema(before, schema), []);

  // 2. The new fixture declares both fields on one node, and nothing else moved.
  const document = readExample('grafo-valido-escalacao-nunca.json');
  assert.deepEqual(
    validateAgainstSchema(document, schema).map((error) => error.pointer),
    [],
    'the fixture that declares the new fields has to validate whole',
  );
  const position = document.nodes.findIndex((node) => node.escalation_policy === 'never');
  assert.ok(position !== -1, 'the fixture has to carry a node declaring "never"');
  assert.equal(
    typeof document.nodes[position].escalation_recipient,
    'string',
    'and the recipient beside it, as free text — no format is enforced',
  );

  // 3. A fourth value is a SHAPE error, and it is the only one: the enum is what
  // constrains the policy, and it is checked before any runner reads it.
  const bogus = structuredClone(document);
  bogus.nodes[position].escalation_policy = 'maybe';
  assert.deepEqual(
    validateAgainstSchema(bogus, schema).map((error) => error.pointer),
    [`/nodes/${position}/escalation_policy`],
    'only the three declared values pass',
  );
});

test('AT8 — validarEstrutura rejects a duplicate id and an edge pointing at a missing node', async () => {
  const { validarEstrutura } = await loadValidator();
  const base = readExample('grafo-valido-minimo.json');

  const withDuplicateId = structuredClone(base);
  withDuplicateId.nodes.push(structuredClone(withDuplicateId.nodes[0]));
  const duplicate = validarEstrutura(withDuplicateId);
  assert.equal(duplicate.valido, false);
  const duplicateError = duplicate.erros.find((e) => e.codigo === 'id_no_duplicado');
  assert.ok(duplicateError, 'expected identifiable error: id_no_duplicado');
  assert.equal(duplicateError.alvo, base.nodes[0].id);
  assert.ok(
    duplicateError.mensagem.includes(base.nodes[0].id),
    'the message has to name the duplicated id',
  );

  const withDanglingEdge = structuredClone(base);
  withDanglingEdge.edges[0].to = 'no_que_nao_existe';
  const dangling = validarEstrutura(withDanglingEdge);
  assert.equal(dangling.valido, false);
  const danglingError = dangling.erros.find((e) => e.codigo === 'aresta_no_inexistente');
  assert.ok(danglingError, 'expected identifiable error: aresta_no_inexistente');
  assert.ok(
    danglingError.mensagem.includes('no_que_nao_existe'),
    'the message has to name the missing node',
  );
});
