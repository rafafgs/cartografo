/**
 * Acceptance tests of t96 — the graph document format.
 *
 * They cover the ticket's three artifacts: the JSON Schema
 * (`schema/graph.schema.json`), the reference validator
 * (`scripts/validate-graph.mjs`) and the six fixtures in `schema/examples/`.
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
const SCHEMA_PATH = path.join(ROOT, 'schema', 'graph.schema.json');
const VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-graph.mjs');
const EXAMPLES_DIR = path.join(ROOT, 'schema', 'examples');

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

/**
 * Top-level keys the document MAY carry, and that `required` never lists.
 *
 * `hooks` entered with t169 and is optional for the same reason `engine` was on
 * the node: every graph written before it stays valid without being touched.
 * `project` entered with t253 under the same rule — it is the static, per-class
 * configuration the node input projection publishes at `input.project`, and a
 * graph that declares none projects an empty object rather than refusing.
 * `max_consecutive_failures` entered with t265 under the same rule again: how
 * many failed sessions in a row stop a job, absent meaning the default of 3,
 * resolved at dispatch time and never at validation.
 */
const OPTIONAL_TOP_LEVEL_KEYS = ['hooks', 'project', 'max_consecutive_failures'];

/** Reads a JSON file from the repo, failing with its relative path if missing. */
function readJson(filePath) {
  assert.ok(existsSync(filePath), `artifact does not exist yet: ${path.relative(ROOT, filePath)}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Reads a fixture from `schema/examples/` by file name. */
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
  validatorModule ??= await import(new URL('../scripts/validate-graph.mjs', import.meta.url));
  return validatorModule;
}

test('AT1 — the schema is valid JSON, declares draft 2020-12, $id and the eight top keys', () => {
  const schema = readJson(SCHEMA_PATH);

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(typeof schema.$id, 'string');
  assert.ok(schema.$id.length > 0, '$id has to be a non-empty string');
  assert.ok(schema.$id.includes('1.0.0'), '$id has to version the schema (1.0.0)');
  // t305 renamed the last Portuguese word out of the URN. The version does NOT
  // move with it: the shape is untouched, so this is an identifier rename and a
  // bump would claim a format change that never happened.
  assert.equal(
    schema.$id,
    'urn:cartografo:schema:graph:1.0.0',
    'the graph document schema is `graph`, not `grafo`, and still 1.0.0',
  );

  assert.equal(typeof schema.properties, 'object');
  for (const key of TOP_LEVEL_KEYS) {
    assert.ok(Object.hasOwn(schema.properties, key), `properties has to declare "${key}"`);
    assert.ok(schema.required.includes(key), `required has to list "${key}"`);
  }
  // Exactly these, in this order (t178): a leftover Portuguese key would still
  // satisfy the loop above, and it is precisely what the rename cannot leave.
  assert.deepEqual([...schema.required].sort(), [...TOP_LEVEL_KEYS].sort());
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    [...TOP_LEVEL_KEYS, ...OPTIONAL_TOP_LEVEL_KEYS].sort(),
  );
  for (const key of OPTIONAL_TOP_LEVEL_KEYS) {
    assert.ok(
      !schema.required.includes(key),
      `"${key}" is optional: a document written before it has to stay valid`,
    );
  }
});

test('AT1 — every fixture in schema/examples validates against the schema', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);
  const names = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith('.json')).sort();

  // Seven from t96, plus the `model` fixture t166 added, the
  // `escalation_policy` one t167 added and the two `hooks` ones t169 added. The
  // count is asserted instead of merely iterated so that a fixture dropped by
  // accident shows up here, and not as a silently smaller loop.
  assert.equal(names.length, 11, `expected the eleven committed fixtures, found ${names.length}`);

  // Two of the counterexamples break SHAPE as well as soundness, and they do it
  // on purpose: an edge whose condition is the empty string trips `minLength`,
  // and a node with no contract trips `required`. Those two pointers are named
  // here rather than skipped, so the fixtures stay refused for the reason they
  // were written for — and every other fixture stays shape-clean.
  const SHAPE_BREAKS = {
    'graph-invalid-edge-without-condition.json': ['/edges/0/condition'],
    'graph-invalid-node-without-contract.json': ['/nodes/1'],
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
  const doc = readExample('graph-valid-minimal.json');

  const structure = validarEstrutura(doc);
  assert.deepEqual(structure.errors, []);
  assert.equal(structure.valid, true);

  const soundness = validarSoundness(doc);
  assert.deepEqual(soundness.violations, []);
  assert.equal(soundness.valid, true);
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
  const doc = readExample('graph-valid-flowpilot.json');

  assert.deepEqual(validarEstrutura(doc).errors, []);
  assert.deepEqual(validarSoundness(doc).violations, []);

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

test('AT4 — an unreachable node produces exactly one "reachable" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('graph-invalid-unreachable-node.json');

  const { valid, violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'reachable');
  assert.ok(
    doc.nodes.some((node) => node.id === violations[0].target),
    'the target has to be the id of a node in the document',
  );
  assert.ok(
    !doc.edges.some((edge) => edge.to === violations[0].target),
    'the target has to be the orphan node (with no incoming edge)',
  );
});

test('AT5 — a node stuck in a cycle with no way out produces a "terminates" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('graph-invalid-without-termination.json');

  const { valid, violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'terminates');

  const stuck = violations[0].target;
  assert.ok(
    doc.nodes.some((node) => node.id === stuck),
    'the target has to be the id of a node in the document',
  );
  assert.ok(
    !doc.final_nodes.includes(stuck),
    'a final node can never be the target of the "terminates" rule',
  );
  assert.ok(
    doc.edges.some((edge) => edge.from === stuck && edge.to === stuck),
    'the stuck node is the one in the cycle with no way out',
  );
});

test('AT6 — an edge with no condition produces an "edge_with_condition" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('graph-invalid-edge-without-condition.json');

  const { valid, violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);

  const withoutCondition = doc.edges.find(
    (edge) => typeof edge.condition !== 'string' || edge.condition.trim() === '',
  );
  assert.deepEqual(violations[0], {
    rule: 'edge_with_condition',
    target: { from: withoutCondition.from, to: withoutCondition.to },
  });
});

test('AT7 — a node with no contract produces a "node_with_contract" violation', async () => {
  const { validarSoundness } = await loadValidator();
  const doc = readExample('graph-invalid-node-without-contract.json');

  const { valid, violations } = validarSoundness(doc);
  assert.equal(valid, false);
  assert.equal(violations.length, 1);

  const withoutContract = doc.nodes.find((node) => node.contract == null || node.skill_ref == null);
  assert.deepEqual(violations[0], {
    rule: 'node_with_contract',
    target: withoutContract.id,
  });
});

test('t167 — escalation_policy is an optional enum on the node, and recipient is free text', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);

  // 1. Absence is the whole backward-compatibility story: a graph written before
  // the field existed declares nothing and stays valid, exactly as `engine` did.
  const before = readExample('graph-valid-minimal.json');
  assert.ok(
    before.nodes.every((node) => !Object.hasOwn(node, 'escalation_policy')),
    'the minimal fixture must keep declaring nothing: it is the "absent" case',
  );
  assert.deepEqual(validateAgainstSchema(before, schema), []);

  // 2. The new fixture declares both fields on one node, and nothing else moved.
  const document = readExample('graph-valid-escalation-never.json');
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
  const base = readExample('graph-valid-minimal.json');

  const withDuplicateId = structuredClone(base);
  withDuplicateId.nodes.push(structuredClone(withDuplicateId.nodes[0]));
  const duplicate = validarEstrutura(withDuplicateId);
  assert.equal(duplicate.valid, false);
  const duplicateError = duplicate.errors.find((e) => e.code === 'duplicate_node_id');
  assert.ok(duplicateError, 'expected identifiable error: duplicate_node_id');
  assert.equal(duplicateError.target, base.nodes[0].id);
  assert.ok(
    duplicateError.message.includes(base.nodes[0].id),
    'the message has to name the duplicated id',
  );

  const withDanglingEdge = structuredClone(base);
  withDanglingEdge.edges[0].to = 'no_que_nao_existe';
  const dangling = validarEstrutura(withDanglingEdge);
  assert.equal(dangling.valid, false);
  const danglingError = dangling.errors.find((e) => e.code === 'edge_unknown_node');
  assert.ok(danglingError, 'expected identifiable error: edge_unknown_node');
  assert.ok(
    danglingError.message.includes('no_que_nao_existe'),
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
  const doc = readExample('graph-valid-model.json');

  assert.deepEqual(
    validateAgainstSchema(doc, readJson(SCHEMA_PATH)).map((error) => error.pointer),
    [],
    'the fixture has to validate against the schema unchanged',
  );
  assert.deepEqual(validarEstrutura(doc).errors, []);
  assert.deepEqual(validarSoundness(doc).violations, []);

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
 * t169 — `hooks` as document data.
 *
 * The claim has three halves, and the fixture only carries the first: a graph
 * that DECLARES hooks is shape-clean. The other two are what
 * `additionalProperties: false` and the single-value enum buy — a hook with no
 * `url` and a hook whose destination is a type nobody implements are both
 * refused before any dispatcher ever reads the document, which is the whole
 * reason the reaction can be versioned with the graph.
 */
test('t169 AT — the hooks fixture is shape-clean, and both validators pass it', async () => {
  const { validarEstrutura, validarSoundness } = await loadValidator();
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const doc = readExample('graph-valid-with-hooks.json');

  assert.deepEqual(
    validateAgainstSchema(doc, readJson(SCHEMA_PATH)).map((error) => error.pointer),
    [],
    'the fixture has to validate against the schema unchanged',
  );
  assert.deepEqual(validarEstrutura(doc).errors, []);
  assert.deepEqual(validarSoundness(doc).violations, []);

  // One of each trigger, which is the whole trigger vocabulary of this ticket.
  assert.deepEqual(
    doc.hooks.map((hook) => hook.trigger).sort(),
    ['node_blocked', 'node_entered'],
  );
  for (const hook of doc.hooks) {
    assert.equal(hook.destination.type, 'webhook');
    assert.ok(
      doc.nodes.some((node) => node.id === hook.node_id),
      `hook "${hook.id}" has to point at a node of the document`,
    );
  }

  // Absence is the backward-compatibility story: the minimal fixture declares
  // no hooks at all and stays valid, exactly as it did before this ticket.
  const before = readExample('graph-valid-minimal.json');
  assert.ok(!Object.hasOwn(before, 'hooks'), 'the minimal fixture is the "absent" case');
  assert.deepEqual(validateAgainstSchema(before, readJson(SCHEMA_PATH)), []);
});

test('t169 AT — a hook with no url, or an unknown destination type, is a shape error', async () => {
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const schema = readJson(SCHEMA_PATH);
  const doc = readExample('graph-valid-with-hooks.json');

  const withoutUrl = structuredClone(doc);
  delete withoutUrl.hooks[0].destination.url;
  assert.deepEqual(
    validateAgainstSchema(withoutUrl, schema).map((error) => error.pointer),
    ['/hooks/0/destination'],
    'url is required: a webhook destination with nowhere to POST is not a destination',
  );

  const unknownType = structuredClone(doc);
  unknownType.hooks[0].destination.type = 'local_command';
  assert.deepEqual(
    validateAgainstSchema(unknownType, schema).map((error) => error.pointer),
    ['/hooks/0/destination/type'],
    'the single-value enum is what keeps a destination nobody implements out of a valid graph',
  );
});

test('t169 AT — $defs.hook declares the trigger vocabulary and closes the object', () => {
  const schema = readJson(SCHEMA_PATH);
  const hook = schema.$defs.hook;

  assert.deepEqual([...hook.required].sort(), ['destination', 'id', 'node_id', 'trigger']);
  assert.equal(hook.additionalProperties, false);
  assert.deepEqual(
    [...hook.properties.trigger.enum].sort(),
    ['node_blocked', 'node_entered'],
    'two triggers and no third: every other one is out of scope for this ticket',
  );

  const destination = schema.$defs.hook_destination;
  // t194 — the destination names the key, it never carries it. A document that
  // still spells `secret` is refused for free: an unrecognised key against
  // `additionalProperties: false`, plus a required `secret_ref` that is missing.
  assert.deepEqual([...destination.required].sort(), ['secret_ref', 'type', 'url']);
  assert.equal(destination.additionalProperties, false);
  assert.equal(destination.properties.secret, undefined, 'no plaintext secret in the document');
  assert.equal(
    destination.properties.secret_ref.pattern,
    schema.$defs.node_id.pattern,
    'the reference is spelled like a node id: it round-trips through a URL path',
  );
  assert.deepEqual(
    destination.properties.type.enum,
    ['webhook'],
    'a single-value enum today, so a second variant is additive tomorrow',
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

  const notAList = readExample('graph-valid-minimal.json');
  notAList.custom_fields = { premise_source: 'string' };
  assert.deepEqual(
    validateAgainstSchema(notAList, schema).map((problem) => problem.pointer),
    ['/custom_fields'],
    'a custom_fields that is not a list has to be refused, and only that',
  );

  const missing = readExample('graph-valid-minimal.json');
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
    const candidate = readExample('graph-valid-minimal.json');
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

/* -------------------------------------------------------------------------- */
/* t253 — the two additive fields the node input projection needs.             */
/* -------------------------------------------------------------------------- */

test('t253 — contract.produces is an optional bucket name, sibling of the two schemas', async () => {
  const schema = readJson(SCHEMA_PATH);
  const contract = schema.$defs.contract;

  assert.deepEqual(
    [...contract.required].sort(),
    ['checks', 'input_schema', 'output_schema'],
    'produces is NOT required: a graph written before it stays valid untouched',
  );
  assert.ok(contract.properties.produces, '$defs.contract does not declare "produces"');
  assert.equal(contract.properties.produces.type, 'string');
  assert.ok(
    typeof contract.properties.produces.description === 'string' &&
      contract.properties.produces.description.length > 0,
    'the field says what it is for, like every other field of this schema',
  );

  // And a document that DECLARES it is accepted, with nothing else changed.
  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );
  const document = readExample('graph-valid-minimal.json');
  document.nodes[0].contract.produces = 'artefato';
  assert.deepEqual(validateAgainstSchema(document, schema), []);
});

test('t253 — project is an optional top-level object, and both bundles still validate', async () => {
  const schema = readJson(SCHEMA_PATH);

  assert.equal(schema.properties.project.type, 'object');
  assert.equal(
    schema.properties.project.additionalProperties,
    true,
    'the keys inside belong to the CLASS, not to this schema',
  );
  assert.ok(!schema.required.includes('project'));

  const { validateAgainstSchema } = await import(
    new URL('../scripts/validate-factory-bundle.mjs', import.meta.url)
  );

  const document = readExample('graph-valid-minimal.json');
  document.project = { repo: 'git@github.com:rafaelgomes/cartografo.git' };
  assert.deepEqual(validateAgainstSchema(document, schema), []);

  // The non-breaking claim, checked against the two real consumers: both
  // bundles declare the field, and both pass the schema.
  //
  // t253 asserted here that NEITHER did, and said in its own message that
  // "ticket 2" would change it. t259 was that ticket for the software bundle —
  // it filled the field so the five manifests could resolve
  // `{{input.project.*}}` and dispatch at all — and t260 did the same for
  // asymmetric-bets, whose entry node reads
  // `{{input.project.criterios_de_triagem}}`. So "optional" no longer has a real
  // bundle standing for it, and it is asserted where it is still a claim about
  // the FORMAT: a document that declares none has to keep validating.
  for (const bundle of ['software-development', 'asymmetric-bets']) {
    const graph = readJson(path.join(ROOT, 'factory-graphs', bundle, 'graph.json'));
    assert.deepEqual(validateAgainstSchema(graph, schema), [], `${bundle}: shape`);
    assert.ok(
      typeof graph.project === 'object' && graph.project !== null,
      `${bundle}: declares the class config its manifests read`,
    );
  }

  const withoutProject = readExample('graph-valid-minimal.json');
  assert.equal(withoutProject.project, undefined, 'the minimal example declares no project');
  assert.deepEqual(
    validateAgainstSchema(withoutProject, schema),
    [],
    'and a document that declares none is still valid, which is the optional half',
  );
});
