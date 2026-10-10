/**
 * Acceptance tests of the subgraph node kind — registration (t637, AT14-AT21).
 *
 * `registerGraphDocument` is where a call to another class meets the registry:
 * the called class has to be registered in the SAME project, and what the call
 * maps into the child job has to satisfy that class's entry contract. The
 * DB-free validators cannot see any of that, which is why this file runs the
 * real control plane.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyBundle } from '../src/cli/import.ts';
import { getClassEntryContract } from '../src/repositories/graphs.ts';
import { PACKAGE_ROOT, request, startControlPlane, type TestContext } from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');

type Doc = Record<string, unknown>;

/** A graph document with the few keys these tests reach into typed. */
interface Graphish extends Doc {
  problem_class: string;
  custom_fields: unknown;
  nodes: Array<{ id: string; contract: Doc; subgraph: Call }>;
  edges: unknown;
  initial_node: string;
  final_nodes: string[];
}

/** The `subgraph` block, as far as these tests touch it. */
interface Call extends Doc {
  class: string;
  input_map: Doc;
}

function readExample(name: string): Graphish {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as Graphish;
}

interface Refusal {
  error: string;
  structure: { errors: Array<{ code: string; target: unknown; message: string }> };
  contracts?: { status: string; valid?: boolean; problems: Array<{ code: string; key?: string }> };
}

async function register(ctx: TestContext, document: Graphish, projectId?: number) {
  return request<Refusal & { graph: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    projectId === undefined ? document : { ...document, project_id: projectId },
  );
}

async function declareProject(ctx: TestContext, name: string): Promise<number> {
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/projects', { name });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.id;
}

/** The note pipeline, renamed so several can live in one database. */
function caller(name: string, mutate: (call: Call) => void = () => {}): Graphish {
  const document = readExample('graph-valid-subgraph.json');
  document.problem_class = name;
  mutate(document.nodes[0].subgraph);
  return document;
}

/** `nota-curta` under another name, declaring fields. */
function child(name: string, fields: Array<Record<string, unknown>>): Graphish {
  const document = readExample('graph-valid-minimal.json');
  document.problem_class = name;
  document.custom_fields = fields;
  return document;
}

function codesOf(body: Refusal): string[] {
  return body.structure.errors.map((error) => error.code);
}

function graphCount(ctx: TestContext): number {
  return (ctx.db.prepare('SELECT count(*) AS n FROM graph').get() as { n: number }).n;
}

test('AT14 — once the called class is registered, both valid fixtures register', async (t) => {
  const ctx = await startControlPlane(t);
  assert.equal((await register(ctx, readExample('graph-valid-minimal.json'))).status, 201);

  const single = await register(ctx, readExample('graph-valid-subgraph.json'));
  assert.equal(single.status, 201, JSON.stringify(single.body));
  const fanOut = await register(ctx, readExample('graph-valid-subgraph-fan-out.json'));
  assert.equal(fanOut.status, 201, JSON.stringify(fanOut.body));
});

test('AT15 — a call to a class that is not registered is refused and nothing is written', async (t) => {
  const ctx = await startControlPlane(t);

  for (const name of ['graph-invalid-subgraph-unknown-class.json', 'graph-valid-subgraph.json']) {
    const response = await register(ctx, readExample(name));
    assert.equal(response.status, 422, `${name}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, 'invalid_graph');
    assert.deepEqual(codesOf(response.body), ['subgraph_unknown_class']);
    assert.equal(response.body.structure.errors[0].target, 'write-note');
  }

  assert.equal(graphCount(ctx), 0);
  const versions = ctx.db.prepare('SELECT count(*) AS n FROM graph_version').get() as { n: number };
  assert.equal(versions.n, 0);
});

test('AT16 — the called class has to be registered in the same project', async (t) => {
  const ctx = await startControlPlane(t);
  const other = await declareProject(ctx, 'other');
  assert.equal((await register(ctx, readExample('graph-valid-minimal.json'), 1)).status, 201);

  const refused = await register(ctx, readExample('graph-valid-subgraph.json'), other);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(codesOf(refused.body), ['subgraph_unknown_class']);

  const accepted = await register(ctx, readExample('graph-valid-subgraph.json'), 1);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

test('AT17 — mapping a field the child does not declare is refused', async (t) => {
  const ctx = await startControlPlane(t);
  assert.equal((await register(ctx, readExample('graph-valid-minimal.json'))).status, 201);

  const response = await register(ctx, readExample('graph-invalid-subgraph-input-mismatch.json'));
  assert.equal(response.status, 422, JSON.stringify(response.body));
  assert.deepEqual(codesOf(response.body), ['subgraph_input_unknown_field']);
  assert.equal(response.body.structure.errors[0].target, 'write-note');
  assert.ok(response.body.structure.errors[0].message.includes('topic'));
});

test('AT18 — a field the child demands at its first node has to be mapped; later ones need not', async (t) => {
  const ctx = await startControlPlane(t);
  const field = (requiredAt: string | null): Array<Record<string, unknown>> => [
    { name: 'topic', type: 'string', required_at: requiredAt },
  ];
  assert.equal((await register(ctx, child('kid-entry', field('redigir')))).status, 201);
  assert.equal((await register(ctx, child('kid-later', field('revisar')))).status, 201);
  assert.equal((await register(ctx, child('kid-never', field(null)))).status, 201);

  const unmapped = await register(
    ctx,
    caller('caller-unmapped', (call) => (call.class = 'kid-entry')),
  );
  assert.equal(unmapped.status, 422, JSON.stringify(unmapped.body));
  assert.deepEqual(codesOf(unmapped.body), ['subgraph_input_missing_field']);
  assert.equal(unmapped.body.structure.errors[0].target, 'write-note');
  assert.ok(unmapped.body.structure.errors[0].message.includes('topic'));

  const mapped = await register(
    ctx,
    caller('caller-mapped', (call) => {
      call.class = 'kid-entry';
      call.input_map.fields = { topic: '{{input.job.title}}' };
    }),
  );
  assert.equal(mapped.status, 201, JSON.stringify(mapped.body));

  for (const kid of ['kid-later', 'kid-never']) {
    const response = await register(
      ctx,
      caller(`caller-of-${kid}`, (call) => (call.class = kid)),
    );
    assert.equal(response.status, 201, `${kid}: ${JSON.stringify(response.body)}`);
  }
});

test('AT19 — a parent of subgraph nodes only still gets the contract check', async (t) => {
  const ctx = await startControlPlane(t);
  assert.equal((await register(ctx, readExample('graph-valid-minimal.json'))).status, 201);

  const document = caller('caller-two-steps', (call) => {
    call.input_map = { title: '{{input.x.y}}' };
  });
  const second = JSON.parse(JSON.stringify(document.nodes[0])) as Graphish['nodes'][number];
  second.id = 'write-again';
  second.subgraph.input_map = { title: 'again' };
  document.nodes[0].contract.produces = 'first';
  document.nodes[0].id = 'write-first';
  document.nodes.push(second);
  document.edges = [{ from: 'write-first', to: 'write-again', condition: 'sempre' }];
  document.initial_node = 'write-first';
  document.final_nodes = ['write-again'];

  const response = await register(ctx, document);
  assert.equal(response.status, 422, JSON.stringify(response.body));
  assert.equal(response.body.contracts?.status, 'checked');
  assert.deepEqual(
    response.body.contracts?.problems.map((problem) => [problem.code, problem.key]),
    [['unproduced_input', 'x.y']],
  );
});

test('AT20 — validate stays DB-free, and the entry contract read is partitioned', async (t) => {
  const ctx = await startControlPlane(t);

  const validated = await request<{ valid: boolean }>(
    ctx,
    'POST',
    '/v1/graphs/validate',
    readExample('graph-invalid-subgraph-unknown-class.json'),
  );
  assert.equal(validated.status, 200);
  assert.equal(validated.body.valid, true, 'only registration refuses an unregistered class');

  const other = await declareProject(ctx, 'other');
  const registered = await register(
    ctx,
    child('kid-entry', [{ name: 'topic', type: 'string', required_at: 'redigir' }]),
    1,
  );
  assert.equal(registered.status, 201);

  assert.deepEqual(getClassEntryContract(ctx.db, 'kid-entry', 1), {
    initial_node: 'redigir',
    custom_fields: [{ name: 'topic', required_at: 'redigir' }],
  });
  assert.equal(getClassEntryContract(ctx.db, 'kid-entry', other), undefined, 'another project');
  assert.equal(getClassEntryContract(ctx.db, 'no-such-class', 1), undefined);

  // A lineage that is not the base is not "the class": it must not answer, even
  // with a current version of its own.
  const versionId = (
    ctx.db.prepare('SELECT current_version_id AS id FROM graph WHERE id = ?').get('kid-entry') as {
      id: string;
    }
  ).id;
  ctx.db
    .prepare(
      `INSERT INTO graph (project_id, id, class, lineage_type, base_class, origin_proposal_id,
                          current_version_id, created_at)
       VALUES (1, 'orphan', 'orphan', 'variant', 'orphan', NULL, ?, '2026-10-10T00:00:00.000Z')`,
    )
    .run(versionId);
  assert.equal(getClassEntryContract(ctx.db, 'orphan', 1), undefined, 'a variant-only class');
});

test('AT21 — a bundle holding a subgraph node needs no manifest for it', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cartografo-t637-bundle-'));
  try {
    mkdirSync(path.join(directory, 'skills'));
    const document = readExample('graph-valid-subgraph.json');
    writeFileSync(path.join(directory, 'graph.json'), JSON.stringify(document), 'utf8');

    assert.deepEqual(verifyBundle(directory, document), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
