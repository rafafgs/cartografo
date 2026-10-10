/**
 * Acceptance tests of the subgraph node kind — structure and soundness (t637, AT1-AT7).
 *
 * A subgraph node calls another problem class. This file holds the two DB-free
 * passes: `validateStructure` / `validateSoundness` and their byte-for-byte
 * sibling `scripts/validate-graph.mjs`. The contract check and registration have
 * their own files.
 *
 * Every case runs through BOTH validators and demands the same answer, because
 * that parity is the rule of the two files (`domain-graph.test.ts` AT1).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { validateSoundness, validateStructure } from '../src/domain/graph.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');

interface ReferenceValidator {
  validarEstrutura: (doc: unknown) => {
    valid: boolean;
    errors: Array<{ code: string; message: string; target: unknown }>;
  };
  validarSoundness: (doc: unknown) => {
    valid: boolean;
    violations: Array<{ rule: string; target: unknown }>;
  };
}

const reference = (await import(
  pathToFileURL(path.join(REPO_ROOT, 'scripts', 'validate-graph.mjs')).href
)) as ReferenceValidator;

type Doc = Record<string, unknown>;
type Node = Record<string, unknown>;

function readExample(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as Doc;
}

/** `graph-valid-subgraph.json`, freshly parsed so every case mutates its own copy. */
function subgraphDoc(): Doc {
  return readExample('graph-valid-subgraph.json');
}

function nodesOf(doc: Doc): Node[] {
  return doc.nodes as Node[];
}

function callOf(doc: Doc): Record<string, unknown> {
  return nodesOf(doc)[0].subgraph as Record<string, unknown>;
}

/** Runs the structure pass through both validators and demands the same report. */
function structureOf(doc: unknown): Array<{ code: string; message: string; target: unknown }> {
  const ported = validateStructure(doc);
  assert.deepEqual(ported, reference.validarEstrutura(doc), 'the two structure passes diverged');
  return ported.errors;
}

function soundnessOf(doc: unknown): Array<{ rule: string; target: unknown }> {
  const ported = validateSoundness(doc);
  assert.deepEqual(ported, reference.validarSoundness(doc), 'the two soundness passes diverged');
  return ported.violations;
}

function codesOf(doc: unknown): string[] {
  return structureOf(doc).map((error) => error.code);
}

const FIXTURES = [
  'graph-valid-subgraph.json',
  'graph-valid-subgraph-fan-out.json',
  'graph-invalid-subgraph-unknown-class.json',
  'graph-invalid-subgraph-input-mismatch.json',
];

test('AT1 — the valid fixtures are clean, and both validators agree on all four', () => {
  for (const name of FIXTURES) {
    const doc = readExample(name);
    assert.deepEqual(validateStructure(doc), reference.validarEstrutura(doc), `${name}: structure`);
    assert.deepEqual(validateSoundness(doc), reference.validarSoundness(doc), `${name}: soundness`);
  }

  // The two `invalid` ones are valid AS DOCUMENTS: only registration refuses them.
  for (const name of FIXTURES) {
    const doc = readExample(name);
    assert.deepEqual(structureOf(doc), [], `${name}: structure`);
    assert.deepEqual(soundnessOf(doc), [], `${name}: soundness`);
  }
});

const FORBIDDEN: Array<[string, unknown]> = [
  ['skill_ref', { id: 'x/y', version: '1.0.0', hash: `sha256:${'a'.repeat(64)}` }],
  ['engine', 'shell'],
  ['model', 'some-model'],
  ['escalation_policy', 'never'],
  ['escalation_recipient', 'the-editor'],
  ['external', { inputs: [], outputs: [] }],
];

test('AT2 — a subgraph node refuses the six session-only fields, and allows unsafe_to_retry', () => {
  for (const [field, value] of FORBIDDEN) {
    const doc = subgraphDoc();
    nodesOf(doc)[0][field] = value;

    const errors = structureOf(doc).filter((error) => error.code === 'subgraph_node_forbidden_field');
    assert.equal(errors.length, 1, `${field}: exactly one error`);
    assert.equal(errors[0].target, 'write-note', `${field}: target is the node id`);
    assert.ok(errors[0].message.includes(`"${field}"`), `${field}: the message names the field`);
    assert.deepEqual(codesOf(doc), ['subgraph_node_forbidden_field'], `${field}: nothing else`);
  }

  const retry = subgraphDoc();
  nodesOf(retry)[0].unsafe_to_retry = true;
  assert.deepEqual(structureOf(retry), []);
});

test('AT3 — the per-kind required fields, and the work node keeps its old messages', () => {
  const onWork = readExample('graph-valid-minimal.json');
  nodesOf(onWork)[0].subgraph = { class: 'x', input_map: { title: 't' }, output_map: {} };
  const wrongKind = structureOf(onWork).filter((error) => error.code === 'subgraph_on_non_subgraph_node');
  assert.equal(wrongKind.length, 1);
  assert.equal(wrongKind[0].target, 'redigir');

  const without = subgraphDoc();
  delete nodesOf(without)[0].subgraph;
  assert.deepEqual(structureOf(without), [
    {
      code: 'missing_required_field',
      message: 'required field missing from node "write-note": "subgraph"',
      target: 'write-note',
    },
  ]);

  // Regression: an ordinary node with no pin reports exactly what it always did,
  // between node_type and contract.
  const noPin = readExample('graph-valid-minimal.json');
  delete nodesOf(noPin)[0].skill_ref;
  assert.deepEqual(structureOf(noPin), [
    {
      code: 'missing_required_field',
      message: 'required field missing from node "redigir": "skill_ref"',
      target: 'redigir',
    },
  ]);
  const noPinNoContract = readExample('graph-valid-minimal.json');
  delete nodesOf(noPinNoContract)[0].skill_ref;
  delete nodesOf(noPinNoContract)[0].contract;
  assert.deepEqual(
    structureOf(noPinNoContract).map((error) => error.message),
    [
      'required field missing from node "redigir": "skill_ref"',
      'required field missing from node "redigir": "contract"',
    ],
  );
});

test('AT4 — a wrong type inside the call is invalid_field, and a call with no title has its own code', () => {
  const cases: Array<[string, (call: Record<string, unknown>) => void]> = [
    ['empty class', (call) => (call.class = '')],
    ['input_map an array', (call) => (call.input_map = [])],
    ['unknown key', (call) => (call.surprise = 1)],
    ['fields value an object', (call) => (call.input_map = { title: 't', fields: { a: { b: 1 } } })],
    ['ordered a string', (call) => (call.fan_out = { over: 'plan.items', ordered: 'yes' })],
    ['over malformed', (call) => (call.fan_out = { over: 'a..b' })],
  ];
  for (const [name, mutate] of cases) {
    const doc = subgraphDoc();
    mutate(callOf(doc));
    const codes = codesOf(doc);
    assert.ok(codes.includes('invalid_field'), `${name}: ${codes.join(',')}`);
    assert.ok(!codes.includes('subgraph_missing_title'), `${name}: a wrong type is not a missing title`);
  }

  const noTitle = subgraphDoc();
  callOf(noTitle).input_map = { body: 'b' };
  assert.deepEqual(codesOf(noTitle), ['subgraph_missing_title']);
  assert.equal(structureOf(noTitle)[0].target, 'write-note');

  const noOutputMap = subgraphDoc();
  delete callOf(noOutputMap).output_map;
  assert.ok(codesOf(noOutputMap).includes('invalid_field'), 'output_map is required');

  const emptyOutputMap = subgraphDoc();
  callOf(emptyOutputMap).output_map = {};
  assert.deepEqual(structureOf(emptyOutputMap), [], 'output_map may be empty');
});

test('AT5 — placeholders: what fits its position passes, anything else is refused', () => {
  const refused: Array<[string, (doc: Doc) => void]> = [
    ['item without fan_out', (doc) => (callOf(doc).input_map = { title: '{{item.x}}' })],
    ['child in input_map', (doc) => (callOf(doc).input_map = { title: '{{child.x}}' })],
    ['input in output_map', (doc) => (callOf(doc).output_map = { text: '{{input.x}}' })],
    ['bare input', (doc) => (callOf(doc).input_map = { title: '{{input}}' })],
    ['dash in a segment', (doc) => (callOf(doc).input_map = { title: '{{input.a-b}}' })],
    ['unclosed token', (doc) => (callOf(doc).input_map = { title: '{{input.a' })],
    ['bare child', (doc) => (callOf(doc).output_map = { text: '{{child}}' })],
    ['inside fields', (doc) => (callOf(doc).input_map = { title: 't', fields: { a: '{{input}}' } })],
  ];
  for (const [name, mutate] of refused) {
    const doc = subgraphDoc();
    mutate(doc);
    const errors = structureOf(doc).filter((error) => error.code === 'subgraph_invalid_placeholder');
    assert.equal(errors.length, 1, name);
    assert.equal(errors[0].target, 'write-note', name);
  }

  const accepted: Array<[string, (doc: Doc) => void]> = [
    [
      'bare item with fan_out',
      (doc) => {
        callOf(doc).input_map = { title: '{{item}}' };
        callOf(doc).fan_out = { over: 'job.list' };
      },
    ],
    ['input path', (doc) => (callOf(doc).input_map = { title: '{{input.job.title}}' })],
    ['a literal', (doc) => (callOf(doc).input_map = { title: 'plain text' })],
    [
      'a flat field',
      (doc) => (callOf(doc).input_map = { title: 't', fields: { topic: '{{input.job.title}}', n: 3 } }),
    ],
  ];
  for (const [name, mutate] of accepted) {
    const doc = subgraphDoc();
    mutate(doc);
    assert.deepEqual(structureOf(doc), [], name);
  }
});

test('AT6 — a subgraph node may not call its own class, and has at most one exit', () => {
  const selfCall = subgraphDoc();
  callOf(selfCall).class = selfCall.problem_class;
  assert.deepEqual(codesOf(selfCall), ['subgraph_self_call']);
  assert.equal(structureOf(selfCall)[0].target, 'write-note');

  const twoExits = readExample('graph-valid-subgraph-fan-out.json');
  const [plan, callNode] = nodesOf(twoExits);
  nodesOf(twoExits).push({ ...plan, id: 'other-a' }, { ...plan, id: 'other-b' });
  (twoExits.edges as Array<Record<string, unknown>>).push(
    { from: callNode.id, to: 'other-a', condition: 'a' },
    { from: callNode.id, to: 'other-b', condition: 'b' },
  );
  const exits = structureOf(twoExits).filter((error) => error.code === 'subgraph_multiple_exits');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].target, 'write-notes');

  // One exit (the fixture itself) and none (graph-valid-subgraph.json) are fine.
  assert.deepEqual(structureOf(readExample('graph-valid-subgraph-fan-out.json')), []);
  assert.deepEqual(structureOf(subgraphDoc()), []);
});

test('AT7 — soundness: a subgraph node is judged on its contract alone', () => {
  assert.deepEqual(soundnessOf(subgraphDoc()), [], 'no pin, no violation');

  const noContract = subgraphDoc();
  delete nodesOf(noContract)[0].contract;
  assert.deepEqual(soundnessOf(noContract), [{ rule: 'node_with_contract', target: 'write-note' }]);

  // A node of any other kind with no pin is still a violation.
  const noPin = readExample('graph-valid-minimal.json');
  delete nodesOf(noPin)[0].skill_ref;
  assert.deepEqual(soundnessOf(noPin), [{ rule: 'node_with_contract', target: 'redigir' }]);

  const unreachable = readExample('graph-valid-subgraph-fan-out.json');
  (unreachable.edges as unknown[]).length = 0;
  const rules = soundnessOf(unreachable).map((violation) => `${violation.rule}:${String(violation.target)}`);
  assert.ok(rules.includes('reachable:write-notes'), rules.join(','));
});
