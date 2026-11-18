/**
 * Acceptance tests for the neutral `capability` field of the graph document
 * (t1282, FR1–FR3).
 *
 * A graph, and a node where it needs one, may say `general` or `advanced`. The
 * document names no engine, model or effort: the installation maps those, per
 * engine, at the runner. What is judged here is only the FORMAT — three checks
 * that have to agree with each other:
 *
 * - the JSON Schema (`schema/graph.schema.json`), compiled here with the same
 *   draft 2020-12 ajv the rest of the repository uses. `scripts/validate-graph.mjs`
 *   compiles no schema of its own (it declares "zero dependencies"), so the
 *   schema is checked directly and the script is checked for what it does have:
 *   its structural pass;
 * - the structural pass of that script (`validarEstrutura`);
 * - `validateStructure` of `src/domain/graph.ts`, which `POST /v1/graphs` runs.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { validateStructure } from '../src/domain/graph.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'validate-graph.mjs');

type Doc = Record<string, unknown>;
type Node = Record<string, unknown>;

const VALID = 'graph-valid-capability.json';
const ON_SHELL = 'graph-invalid-capability-on-shell-node.json';
const ON_SUBGRAPH = 'graph-invalid-capability-on-subgraph-node.json';
const UNKNOWN_VALUE = 'graph-invalid-capability-unknown-value.json';

function readExample(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as Doc;
}

const nodesOf = (doc: Doc): Node[] => doc.nodes as Node[];

/** The schema's verdict, `true` when the document is accepted. */
function schemaAccepts(doc: unknown): boolean {
  const schema = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'schema', 'graph.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  return ajv.compile(schema)(doc) === true;
}

interface Reference {
  validarEstrutura: (doc: unknown) => { valid: boolean; errors: Array<{ code: string; message: string }> };
}

async function reference(): Promise<Reference> {
  return (await import(pathToFileURL(SCRIPT).href)) as Reference;
}

/** Codes both structural passes report for a document, in order. */
async function codesOfBoth(doc: unknown): Promise<{ script: string[]; core: string[] }> {
  const { validarEstrutura } = await reference();
  return {
    script: validarEstrutura(doc).errors.map((error) => error.code),
    core: validateStructure(doc).errors.map((error) => error.code),
  };
}

test('t1282 AT1 — graph-valid-capability.json passes the schema, the script and validateStructure', async () => {
  const doc = readExample(VALID);
  assert.equal(doc.capability, 'general', 'the fixture declares the document-level capability');
  const nodes = nodesOf(doc);
  assert.equal(nodes[0].capability, 'advanced', 'one node overrides it');
  assert.equal(Object.hasOwn(nodes[1], 'capability'), false, 'the other declares nothing');

  assert.equal(schemaAccepts(doc), true, 'the schema accepts it');
  assert.deepEqual(validateStructure(doc).errors, [], 'validateStructure accepts it');
  assert.deepEqual((await reference()).validarEstrutura(doc).errors, [], 'the script accepts it');

  const run = spawnSync(process.execPath, [SCRIPT, path.join(EXAMPLES_DIR, VALID)], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
});

test('t1282 AT2 — a capability on a shell node is refused by all three', async () => {
  const doc = readExample(ON_SHELL);
  assert.equal(nodesOf(doc)[0].engine, 'shell');

  assert.equal(schemaAccepts(doc), false, 'the schema refuses it');

  const { script, core } = await codesOfBoth(doc);
  assert.ok(core.includes('capability_on_shell_node'), `validateStructure: ${core.join(', ')}`);
  assert.ok(script.includes('capability_on_shell_node'), `the script: ${script.join(', ')}`);

  const run = spawnSync(process.execPath, [SCRIPT, path.join(EXAMPLES_DIR, ON_SHELL)], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1, 'the script exits 1 for a refused document');
  assert.match(run.stderr, /capability_on_shell_node/);
});

test('t1282 AT3 — a capability on a subgraph node is refused by the schema and by the rule', async () => {
  const doc = readExample(ON_SUBGRAPH);
  assert.equal(nodesOf(doc)[0].node_type, 'subgraph');

  assert.equal(schemaAccepts(doc), false, 'the schema refuses it');

  const { script, core } = await codesOfBoth(doc);
  assert.ok(core.includes('subgraph_node_forbidden_field'), `validateStructure: ${core.join(', ')}`);
  assert.ok(script.includes('subgraph_node_forbidden_field'), `the script: ${script.join(', ')}`);

  const named = validateStructure(doc).errors.find(
    (error) => error.code === 'subgraph_node_forbidden_field',
  );
  assert.match(named?.message ?? '', /"capability"/, 'the message names the field');
});

test('t1282 AT4 — a value outside the two is invalid_field, at the node and at the top', async () => {
  const doc = readExample(UNKNOWN_VALUE);
  assert.equal(nodesOf(doc)[0].capability, 'turbo');
  assert.equal(schemaAccepts(doc), false);
  const fromFixture = await codesOfBoth(doc);
  assert.ok(fromFixture.core.includes('invalid_field'), fromFixture.core.join(', '));
  assert.ok(fromFixture.script.includes('invalid_field'), fromFixture.script.join(', '));

  // The same mistake at the top level, and a non-string at both places.
  const topLevel = readExample(VALID);
  topLevel.capability = 'turbo';
  const nonStringNode = readExample(VALID);
  nodesOf(nonStringNode)[0].capability = 7;
  const nonStringTop = readExample(VALID);
  nonStringTop.capability = ['general'];

  for (const [label, candidate] of [
    ['top level, unknown value', topLevel],
    ['node, non-string', nonStringNode],
    ['top level, non-string', nonStringTop],
  ] as const) {
    assert.equal(schemaAccepts(candidate), false, `${label}: the schema refuses it`);
    const { script, core } = await codesOfBoth(candidate);
    assert.ok(core.includes('invalid_field'), `${label}: validateStructure ${core.join(', ')}`);
    assert.ok(script.includes('invalid_field'), `${label}: the script ${script.join(', ')}`);
  }
});

test('t1282 AT5 — a top-level capability over shell and subgraph nodes that declare none is valid', async () => {
  // The document-level value simply does not apply to the nodes that open no
  // session: it is not an error to have it where one of them lives.
  const shell = readExample('graph-valid-shell-engine.json');
  shell.capability = 'advanced';
  const subgraph = readExample('graph-valid-subgraph.json');
  subgraph.capability = 'general';

  // One document holding both kinds.
  const both = readExample('graph-valid-shell-engine.json');
  both.capability = 'general';
  const subgraphNode = structuredClone(nodesOf(subgraph)[0]);
  nodesOf(both).push(subgraphNode);
  (both.edges as Array<Record<string, unknown>>).push({
    from: 'write-up',
    to: subgraphNode.id,
    condition: 'sempre',
    description: 'On to the call.',
  });
  both.final_nodes = [subgraphNode.id];

  for (const [label, doc] of [
    ['shell nodes', shell],
    ['subgraph node', subgraph],
    ['both together', both],
  ] as const) {
    assert.equal(schemaAccepts(doc), true, `${label}: the schema accepts it`);
    const { script, core } = await codesOfBoth(doc);
    assert.deepEqual(core, [], `${label}: validateStructure`);
    assert.deepEqual(script, [], `${label}: the script`);
  }
});

test('t1282 AT6 — the script and validateStructure agree on all four fixtures, code for code', async () => {
  const { validarEstrutura } = await reference();
  const expectations: Array<[string, string | null]> = [
    [VALID, null],
    [ON_SHELL, 'capability_on_shell_node'],
    [ON_SUBGRAPH, 'subgraph_node_forbidden_field'],
    [UNKNOWN_VALUE, 'invalid_field'],
  ];

  for (const [name, code] of expectations) {
    const doc = readExample(name);
    const script = validarEstrutura(doc);
    const core = validateStructure(doc);
    assert.equal(script.valid, core.valid, `${name}: the verdicts differ`);
    assert.equal(core.valid, code === null, `${name}: expected ${code === null ? 'accept' : 'refuse'}`);
    assert.deepEqual(
      script.errors.map((error) => error.code),
      core.errors.map((error) => error.code),
      `${name}: the two name different codes`,
    );
    if (code !== null) assert.ok(core.errors.some((error) => error.code === code), name);
  }
});
