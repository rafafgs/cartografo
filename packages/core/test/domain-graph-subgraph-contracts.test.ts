/**
 * Acceptance tests of the subgraph node kind — contract matching (t637, AT8-AT13).
 *
 * `validateContracts` (`docs/spec/graph.md` §6.1) resolves a node's pinned skill
 * and holds the dataflow against it. A subgraph node pins no skill, so its own
 * `contract` stands in for the skill's contract, and the call's `input_map`,
 * `fan_out` and `output_map` are held against that contract.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  classifyContracts,
  validateContracts,
  type ContractProblem,
  type SkillLookup,
} from '../src/domain/graph.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');

type Doc = Record<string, unknown>;
type Node = Record<string, unknown>;

function readExample(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as Doc;
}

const nodesOf = (doc: Doc): Node[] => doc.nodes as Node[];
const edgesOf = (doc: Doc): Array<Record<string, unknown>> => doc.edges as Array<Record<string, unknown>>;
const callOf = (node: Node): Record<string, unknown> => node.subgraph as Record<string, unknown>;
const contractOf = (node: Node): Doc => node.contract as Doc;

/** Walks `path` down nested objects and returns the object found there. */
function dig(root: unknown, ...path: string[]): Doc {
  let current = root;
  for (const key of path) current = (current as Doc)[key];
  return current as Doc;
}

const HASH = `sha256:${'b'.repeat(64)}`;
const pin = (id: string): Record<string, string> => ({ id, version: '1.0.0', hash: HASH });

/** A lookup that records what it was asked and resolves from a map. */
function recordingLookup(skills: Record<string, { input: Doc; output: Doc }> = {}): {
  lookup: SkillLookup;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    lookup: (ref) => {
      asked.push(ref.id);
      return skills[ref.id];
    },
  };
}

const PLAN_NOTES = {
  'cartografo/plan-notes': {
    input: { type: 'object' },
    output: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array' } },
    },
  },
};

const codes = (problems: ContractProblem[]): string[] => problems.map((problem) => problem.code);

/** A work node that pins `id`, produces into `bucket` and checks something. */
function workNode(id: string, skill: string, bucket?: string): Node {
  return {
    id,
    role: 'worker',
    node_type: 'work',
    skill_ref: pin(skill),
    contract: {
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      ...(bucket === undefined ? {} : { produces: bucket }),
      checks: [{ type: 'deterministic', command: 'true' }],
    },
  };
}

test('AT8 — a subgraph node never reaches the skill lookup and is never unresolved', () => {
  const { lookup, asked } = recordingLookup();
  const report = validateContracts(readExample('graph-valid-subgraph.json'), lookup);

  assert.deepEqual(report.problems, []);
  assert.equal(report.valid, true);
  assert.deepEqual(asked, [], 'the lookup is never called for a node with no pin');
});

/** `graph-valid-subgraph.json` followed by a node that requires `note.text`. */
function withReviewer(): { doc: Doc; skills: Record<string, { input: Doc; output: Doc }> } {
  const doc = readExample('graph-valid-subgraph.json');
  nodesOf(doc).push(workNode('review', 'cartografo/review-note'));
  edgesOf(doc).push({ from: 'write-note', to: 'review', condition: 'sempre' });
  doc.final_nodes = ['review'];
  return {
    doc,
    skills: {
      'cartografo/review-note': {
        input: {
          type: 'object',
          required: ['note'],
          properties: {
            note: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
          },
        },
        output: { type: 'object' },
      },
    },
  };
}

test('AT9 — what a subgraph node produces counts for the nodes after it', () => {
  const clean = withReviewer();
  const ok = validateContracts(clean.doc, recordingLookup(clean.skills).lookup);
  assert.deepEqual(ok.problems, []);

  const optional = withReviewer();
  dig(contractOf(nodesOf(optional.doc)[0]), 'output_schema').required = [];
  const report = validateContracts(optional.doc, recordingLookup(optional.skills).lookup);
  // Nothing required means nothing lands in the bucket, so `note` itself is not
  // guaranteed either; what matters is that `note.text` is reported.
  assert.ok(report.problems.every((problem) => problem.code === 'unproduced_input'));
  assert.ok(
    report.problems.some(
      (problem) => problem.node_id === 'review' && (problem as { key?: string }).key === 'note.text',
    ),
    JSON.stringify(report.problems),
  );
});

/** A diamond: `start` forks to `a` and `b`, both reach the subgraph node `join`. */
function diamond(bProduces: boolean): { doc: Doc; skills: Record<string, { input: Doc; output: Doc }> } {
  const doc = readExample('graph-valid-subgraph.json');
  const join = nodesOf(doc)[0];
  join.id = 'join';
  callOf(join).input_map = { title: '{{input.brief.topic}}' };
  doc.nodes = [
    workNode('start', 'cartografo/start'),
    workNode('a', 'cartografo/a', 'brief'),
    workNode('b', 'cartografo/b', 'brief'),
    join,
  ];
  doc.edges = [
    { from: 'start', to: 'a', condition: 'left' },
    { from: 'start', to: 'b', condition: 'right' },
    { from: 'a', to: 'join', condition: 'sempre' },
    { from: 'b', to: 'join', condition: 'sempre' },
  ];
  doc.initial_node = 'start';
  doc.final_nodes = ['join'];
  const topic = {
    type: 'object',
    required: ['topic'],
    properties: { topic: { type: 'string' } },
  };
  return {
    doc,
    skills: {
      'cartografo/start': { input: { type: 'object' }, output: { type: 'object' } },
      'cartografo/a': { input: { type: 'object' }, output: topic },
      'cartografo/b': { input: { type: 'object' }, output: bProduces ? topic : { type: 'object' } },
    },
  };
}

test('AT10 — a placeholder in input_map is a required input path of the node', () => {
  const nothing = readExample('graph-valid-subgraph.json');
  callOf(nodesOf(nothing)[0]).input_map = { title: '{{input.brief.topic}}' };
  const unproduced = validateContracts(nothing, recordingLookup().lookup);
  assert.equal(unproduced.problems.length, 1, JSON.stringify(unproduced.problems));
  assert.equal(unproduced.problems[0].code, 'unproduced_input');
  assert.equal(unproduced.problems[0].node_id, 'write-note');
  assert.equal((unproduced.problems[0] as { key: string }).key, 'brief.topic');

  const oneRoute = diamond(false);
  const partial = validateContracts(oneRoute.doc, recordingLookup(oneRoute.skills).lookup);
  assert.deepEqual(
    partial.problems.map((problem) => [problem.code, problem.node_id, (problem as { key?: string }).key]),
    [['unproduced_input', 'join', 'brief.topic']],
    'produced on only one of two routes is not produced',
  );

  const bothRoutes = diamond(true);
  assert.deepEqual(
    validateContracts(bothRoutes.doc, recordingLookup(bothRoutes.skills).lookup).problems,
    [],
  );
});

test('AT11 — fan_out.over has to be declared an array in the node\'s own input_schema', () => {
  const lookup = (): SkillLookup => recordingLookup(PLAN_NOTES).lookup;

  const ok = validateContracts(readExample('graph-valid-subgraph-fan-out.json'), lookup());
  assert.deepEqual(ok.problems, []);

  const asString = readExample('graph-valid-subgraph-fan-out.json');
  dig(contractOf(nodesOf(asString)[1]), 'input_schema', 'properties', 'plan', 'properties', 'items').type = 'string';
  const wrongType = validateContracts(asString, lookup());
  assert.deepEqual(
    wrongType.problems.map((problem) => [problem.code, problem.node_id, (problem as { key?: string }).key]),
    [['subgraph_fan_out_not_a_list', 'write-notes', 'plan.items']],
  );

  const undeclared = readExample('graph-valid-subgraph-fan-out.json');
  const plan = dig(contractOf(nodesOf(undeclared)[1]), 'input_schema', 'properties', 'plan');
  plan.properties = {};
  plan.required = [];
  const missing = validateContracts(undeclared, lookup());
  assert.deepEqual(
    missing.problems.map((problem) => [problem.code, problem.node_id, (problem as { key?: string }).key]),
    [['subgraph_fan_out_not_a_list', 'write-notes', 'plan.items']],
  );
});

test('AT12 — output_map is held against the node\'s own output_schema', () => {
  const keyed = (problems: ContractProblem[]): unknown[] =>
    problems.map((problem) => [problem.code, problem.node_id, (problem as { key?: string }).key]);

  const unmapped = readExample('graph-valid-subgraph.json');
  callOf(nodesOf(unmapped)[0]).output_map = {};
  assert.deepEqual(keyed(validateContracts(unmapped, recordingLookup().lookup).problems), [
    ['subgraph_output_unmapped', 'write-note', 'text'],
  ]);

  const unknown = readExample('graph-valid-subgraph.json');
  callOf(nodesOf(unknown)[0]).output_map = { text: '{{child.texto}}', extra: '{{child.extra}}' };
  assert.deepEqual(keyed(validateContracts(unknown, recordingLookup().lookup).problems), [
    ['subgraph_output_unknown_property', 'write-note', 'extra'],
  ]);

  const notAList = readExample('graph-valid-subgraph-fan-out.json');
  dig(contractOf(nodesOf(notAList)[1]), 'output_schema', 'properties', 'texts').type = 'string';
  assert.deepEqual(keyed(validateContracts(notAList, recordingLookup(PLAN_NOTES).lookup).problems), [
    ['subgraph_output_not_a_list', 'write-notes', 'texts'],
  ]);

  // Without a fan-out the same property is not required to be a list.
  const single = readExample('graph-valid-subgraph.json');
  dig(contractOf(nodesOf(single)[0]), 'output_schema', 'properties', 'text').type = 'array';
  assert.deepEqual(validateContracts(single, recordingLookup().lookup).problems, []);

  const clean = validateContracts(
    readExample('graph-valid-subgraph-fan-out.json'),
    recordingLookup(PLAN_NOTES).lookup,
  );
  assert.deepEqual(clean.problems, []);
});

test('AT13 — a document whose only problems are subgraph ones is failed, not unchecked', () => {
  const doc = readExample('graph-valid-subgraph-fan-out.json');
  callOf(nodesOf(doc)[1]).output_map = {};
  dig(contractOf(nodesOf(doc)[1]), 'input_schema', 'properties', 'plan').properties = {};

  const report = validateContracts(doc, recordingLookup(PLAN_NOTES).lookup);
  assert.deepEqual(codes(report.problems).sort(), [
    'subgraph_fan_out_not_a_list',
    'subgraph_output_unmapped',
  ]);
  assert.equal(report.valid, false);
  assert.equal(classifyContracts(report), 'failed');
});
