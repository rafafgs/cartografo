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
  // t168 — the fields a class declares on its own tickets. REQUIRED and
  // possibly empty, so that "the document has no optional top-level key" stays
  // true (the two assertions at the end of AT1 are what freeze it).
  'custom_fields',
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

test('AT1 — the schema is valid JSON, declares draft 2020-12, $id and the eight top keys', () => {
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

  // Seven from t96, plus the `model` fixture t166 added. The count is asserted
  // instead of merely iterated so that a fixture dropped by accident shows up
  // here, and not as a silently smaller loop.
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

/*
 * t166 — `model` as node data.
 *
 * The fixture is the whole point of the assertion: `model` is a free-text
 * OPTIONAL field, so a schema that never learned about it would still validate
 * a document carrying one — `additionalProperties: false` on `$defs.node` is
 * what turns "unknown key" into a refusal, and it is what this test leans on.
 * A node WITHOUT the field rides along in the same fixture, because "absence
 * has a name" is the other half of the claim.
 */
test('t166 AT — the model fixture is shape-clean, sound, and exercises both presence and absence', async () => {
  const { validarEstrutura, validarSoundness } = await loadValidator();
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const doc = readExample('grafo-valido-modelo.json');

  assert.deepEqual(
    validateAgainstSchema(doc, readJson(SCHEMA_PATH)).map((error) => error.pointer),
    [],
    'the fixture has to validate against the schema unchanged',
  );
  assert.deepEqual(validarEstrutura(doc).erros, []);
  assert.deepEqual(validarSoundness(doc).violacoes, []);

  const declaring = doc.nodes.filter((node) => node.model !== undefined);
  assert.ok(declaring.length >= 1, 'at least one node has to declare a model');
  for (const node of declaring) {
    assert.equal(typeof node.model, 'string');
    assert.ok(node.model.trim() !== '', `node "${node.id}" declares an empty model`);
  }
  assert.ok(
    doc.nodes.some((node) => node.model === undefined),
    'a node WITHOUT model has to ride along: absence is the default, and it stays valid',
  );
});

/*
 * t168 — the fields a problem class declares on its own tickets.
 *
 * The key is REQUIRED and may be empty, which is the whole reason it is worth
 * asserting separately: a class that declares no field still writes
 * `"custom_fields": []`, and that is what keeps AT1's "required and properties
 * are the same set" true for the first optional-looking key this format ever
 * gained.
 */
test('t168 AT — custom_fields is a required top-level list, and a non-list is refused', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);

  assert.ok(Object.hasOwn(schema.properties, 'custom_fields'));
  assert.ok(schema.required.includes('custom_fields'));
  assert.equal(schema.properties.custom_fields.type, 'array');

  const notAList = readExample('grafo-valido-minimo.json');
  notAList.custom_fields = { premise_source: 'string' };
  assert.deepEqual(
    validateAgainstSchema(notAList, schema).map((problem) => problem.pointer),
    ['/custom_fields'],
    'a custom_fields that is not a list has to be refused, and only that',
  );

  const missing = readExample('grafo-valido-minimo.json');
  delete missing.custom_fields;
  assert.ok(
    validateAgainstSchema(missing, schema).length > 0,
    'the key is required: a document without it does not validate',
  );
});

test('t168 AT — $defs.custom_field requires name/type/required_at and refuses an extra key', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);
  const definition = schema.$defs.custom_field;

  assert.ok(definition !== undefined, 'the schema has to declare $defs.custom_field');
  assert.deepEqual([...definition.required].sort(), ['name', 'required_at', 'type']);
  assert.equal(definition.additionalProperties, false);

  /** The minimal fixture carrying one declaration, ready to validate. */
  const declaring = (...fields) => {
    const candidate = readExample('grafo-valido-minimo.json');
    candidate.custom_fields = fields;
    return candidate;
  };

  assert.deepEqual(
    validateAgainstSchema(
      declaring(
        { name: 'premise_source', type: 'string', required_at: 'redigir' },
        // `required_at: null` is the informational field: declared on the
        // ticket, demanded by no node. It is a NULL and not an absence because
        // the key stays required — same discipline as the top-level one.
        { name: 'downside', type: 'number', required_at: null, description: 'quanto se perde' },
      ),
      schema,
    ),
    [],
    'a well-formed pair of declarations validates unchanged',
  );

  for (const [broken, reason] of [
    [{ name: 'premise_source', type: 'string' }, 'required_at is required'],
    [{ type: 'string', required_at: 'redigir' }, 'name is required'],
    [{ name: 'premise_source', required_at: 'redigir' }, 'type is required'],
    [
      { name: 'premise_source', type: 'string', required_at: 'redigir', unidade: 'BRL' },
      'no extra property',
    ],
    [{ name: 'Premise Source', type: 'string', required_at: 'redigir' }, 'name is snake_case'],
    [{ name: 'premise_source', type: 'date', required_at: 'redigir' }, 'type is one of three'],
  ]) {
    assert.ok(
      validateAgainstSchema(declaring(broken), schema).length > 0,
      `${JSON.stringify(broken)} should be refused: ${reason}`,
    );
  }
});

test('t166 AT — $defs.node declares model as an optional free-text string, sibling of engine', () => {
  const node = readJson(SCHEMA_PATH).$defs.node;

  assert.ok(Object.hasOwn(node.properties, 'model'), '$defs.node has to declare "model"');
  assert.equal(node.properties.model.type, 'string');
  assert.ok(
    !Object.hasOwn(node.properties.model, 'enum'),
    'model is free text, for the same reason engine is: no closed enum to edit per model release',
  );
  assert.ok(
    !node.required.includes('model'),
    'model is optional: absent means the engine\'s own default',
  );
});
