/**
 * Acceptance tests of the examples routes (t408, FR1/FR2/FR5).
 *
 * `GET /v1/examples` and `POST /v1/examples/:class/run` are what turn "a bundle
 * on disk" into "a job running", with nothing between them but one click on the
 * screen. Everything they do, the CLI could already do in three commands
 * (`cartografo import` plus a `POST /v1/jobs`); what did not exist was anything
 * that DISCOVERS which bundles are demo-ready, and anything that allocates an
 * execution id for a caller that has nobody to ask for one.
 *
 * Two roots are exercised on purpose. A fixture root built in a temp directory
 * is what pins the behaviour — a bundle registered by the route, the skips, the
 * second job in its own execution. The repository's own `factory-graphs/` is
 * what pins the DISCOVERY: `asymmetric-bets` and `b3-flow-radar` ship a
 * `demo/job.json` and `software-development` does not, and nothing in the route
 * names any of the three.
 *
 * The examples root is read from `CARTOGRAFO_EXAMPLES_ROOT` on every request, so
 * each test sets it and gives it back; the control plane here runs in-process
 * (`test/support.ts`), which is what makes that possible.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { manifestHash } from '../src/domain/manifest.ts';
import {
  PACKAGE_ROOT,
  request,
  requireArtifacts,
  startControlPlane,
  type Job,
  type TestHook,
} from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The repository's own bundle directory — the real discovery surface. */
const FACTORY_GRAPHS = path.join(REPO_ROOT, 'factory-graphs');

/** Artifacts this ticket creates; the initial red names them. */
const ARTIFACTS = ['src/routes/examples.ts'];

/** The environment variable the route resolves its root from. */
const ROOT_ENV = 'CARTOGRAFO_EXAMPLES_ROOT';

/** The fixture bundle's class — deliberately not one of the repository's. */
const FIXTURE_CLASS = 'demo-note';

/** One entry of `GET /v1/examples`. */
interface Example {
  class: string;
  bundle: string;
  demo_title: string;
  registered: boolean;
}

/** The body of a successful `POST /v1/examples/:class/run`. */
interface RunResult {
  job: Job & { fields: Record<string, unknown> | null };
  execution_id: number;
  registered: boolean;
}

/** A manifest the registry accepts, with its pin already computed. */
function manifest(id: string): Record<string, unknown> {
  const document: Record<string, unknown> = {
    id,
    version: '1.0.0',
    hash: '',
    role: 'work',
    description: `Fixture capability "${id}" of the examples-route suite.`,
    input: { type: 'object' },
    output: { type: 'object' },
    preconditions: [],
    checks: [
      {
        id: 'fixture-check',
        type: 'deterministic',
        description: 'The fixture declares a check, because every manifest owes one.',
        command: 'true',
      },
    ],
    permissions: { filesystem: { read: [], write: [] }, network: { allowed: false } },
    instructions: `Fixture capability "${id}".`,
    origin: { type: 'native' },
  };
  document.hash = manifestHash(document);
  return document;
}

/** One node of the fixture graph, pinned to the manifest of the same name. */
function node(id: string, nodeType: string, pinned: Record<string, unknown>): unknown {
  return {
    id,
    role: id,
    node_type: nodeType,
    description: `The fixture's "${id}" node.`,
    skill_ref: { id: pinned.id, version: pinned.version, hash: pinned.hash },
    contract: {
      input_schema: { type: 'object' },
      output_schema:
        nodeType === 'gate'
          ? {
              type: 'object',
              required: ['outcome'],
              properties: { outcome: { enum: ['pass', 'fail', 'escalate_human'] } },
            }
          : { type: 'object' },
      checks: [
        {
          type: 'deterministic',
          command: 'true',
          description: 'The fixture node declares a check too.',
        },
      ],
    },
  };
}

/** The demo job the fixture bundle ships. */
const FIXTURE_DEMO = Object.freeze({
  title: 'Write the fixture note',
  body: 'A worked example that exists only so a route can be tested against it.',
  entry_node_id: 'write',
  fields: { topic: 'the examples route' },
});

/**
 * Writes a complete, contract-proven bundle: graph, skills and demo job.
 *
 * Contract-proven matters and is not decoration: since t283 a version whose
 * pins do not resolve is stored `unchecked`, and `createJob` refuses to put
 * work on one. A fixture whose manifests did not match its pins would make the
 * route answer `409` for a reason that has nothing to do with this ticket.
 *
 * @param root Examples root the bundle goes under.
 * @param bundle Directory name of the bundle.
 * @returns The bundle's directory.
 */
function writeFixtureBundle(root: string, bundle: string): string {
  const directory = path.join(root, bundle);
  mkdirSync(path.join(directory, 'skills'), { recursive: true });
  mkdirSync(path.join(directory, 'demo'), { recursive: true });

  const write = manifest('write-note');
  const review = manifest('review-note');
  writeFileSync(path.join(directory, 'skills', 'write-note.json'), JSON.stringify(write, null, 2));
  writeFileSync(path.join(directory, 'skills', 'review-note.json'), JSON.stringify(review, null, 2));

  const graph = {
    problem_class: FIXTURE_CLASS,
    lineage: { type: 'base' },
    metadata: {
      name: 'Demo note — the fixture bundle',
      description: 'Two nodes and one edge, the smallest bundle that is still a bundle.',
      schema_version: '1.0.0',
      created_at: '2026-09-06',
      source: 'written by packages/core/test/examples-routes.test.ts',
    },
    nodes: [node('write', 'work', write), node('review', 'gate', review)],
    edges: [
      {
        from: 'write',
        to: 'review',
        condition: 'always',
        description: 'A single exit: the note always goes on to review.',
      },
    ],
    initial_node: 'write',
    final_nodes: ['review'],
    custom_fields: [
      {
        name: 'topic',
        type: 'string',
        required_at: 'write',
        description: 'What the note is about.',
      },
    ],
  };
  writeFileSync(path.join(directory, 'graph.json'), JSON.stringify(graph, null, 2));
  writeFileSync(path.join(directory, 'demo', 'job.json'), JSON.stringify(FIXTURE_DEMO, null, 2));

  return directory;
}

/**
 * Points the routes at a root for the length of one test.
 *
 * @param t Test context, so the variable is given back.
 * @param root Directory the routes scan.
 */
function useExamplesRoot(t: TestHook, root: string): void {
  const previous = process.env[ROOT_ENV];
  process.env[ROOT_ENV] = root;
  t.after(() => {
    if (previous === undefined) delete process.env[ROOT_ENV];
    else process.env[ROOT_ENV] = previous;
  });
}

/** A temporary examples root, removed at the end of the test. */
function temporaryRoot(t: TestHook): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t408-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('t408 AT1 — a fixture bundle is listed, and running it flips `registered`', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const root = temporaryRoot(t);
  writeFixtureBundle(root, 'demo-note');
  useExamplesRoot(t, root);

  const ctx = await startControlPlane(t);

  const before = await request<{ examples: Example[] }>(ctx, 'GET', '/v1/examples');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.examples, [
    {
      class: FIXTURE_CLASS,
      bundle: 'demo-note',
      demo_title: FIXTURE_DEMO.title,
      registered: false,
    },
  ]);

  const ran = await request<RunResult>(ctx, 'POST', `/v1/examples/${FIXTURE_CLASS}/run`);
  assert.equal(ran.status, 201, JSON.stringify(ran.body));

  const after = await request<{ examples: Example[] }>(ctx, 'GET', '/v1/examples');
  assert.equal(after.status, 200);
  assert.equal(after.body.examples.length, 1);
  assert.equal(after.body.examples[0].registered, true, 'the class the route registered is known now');
});

test('t408 AT2 — the repository’s own factory-graphs is what the default scan finds', async (t) => {
  requireArtifacts(...ARTIFACTS);
  useExamplesRoot(t, FACTORY_GRAPHS);

  const ctx = await startControlPlane(t);
  const listed = await request<{ examples: Example[] }>(ctx, 'GET', '/v1/examples');
  assert.equal(listed.status, 200);

  const classes = listed.body.examples.map((example) => example.class);
  assert.ok(classes.includes('asymmetric-bets'), `asymmetric-bets is missing: ${classes.join(', ')}`);
  assert.ok(classes.includes('b3-flow-radar'), `b3-flow-radar is missing: ${classes.join(', ')}`);
  assert.ok(
    !classes.includes('software-development'),
    'software-development ships no demo/job.json and must not be listed',
  );

  assert.deepEqual([...classes].sort(), classes, 'the listing is sorted by bundle, ascending');
  for (const example of listed.body.examples) {
    assert.ok(example.demo_title.length > 0, `${example.class} has no demo title`);
    assert.equal(example.registered, false, 'nothing is registered on a brand-new database');
  }
});

test('t408 AT3 — a bundle with no graph, or an unreadable one, is skipped and not a 500', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const root = temporaryRoot(t);
  writeFixtureBundle(root, 'demo-note');

  mkdirSync(path.join(root, 'no-graph', 'demo'), { recursive: true });
  writeFileSync(
    path.join(root, 'no-graph', 'demo', 'job.json'),
    JSON.stringify({ title: 'orphan', entry_node_id: 'somewhere' }),
  );

  mkdirSync(path.join(root, 'broken-graph', 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'broken-graph', 'graph.json'), '{ this is not json');
  writeFileSync(
    path.join(root, 'broken-graph', 'demo', 'job.json'),
    JSON.stringify({ title: 'broken', entry_node_id: 'somewhere' }),
  );

  // A bundle with a graph and no demo at all is the third skip, and the one the
  // repository itself exercises with `software-development`.
  mkdirSync(path.join(root, 'no-demo'), { recursive: true });
  writeFileSync(path.join(root, 'no-demo', 'graph.json'), JSON.stringify({ problem_class: 'x' }));

  useExamplesRoot(t, root);

  const ctx = await startControlPlane(t);
  const listed = await request<{ examples: Example[] }>(ctx, 'GET', '/v1/examples');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(
    listed.body.examples.map((example) => example.bundle),
    ['demo-note'],
    'only the bundle that can be read whole is offered',
  );
});

test('t408 AT4 — a class nobody ships answers 404 unknown_example', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const root = temporaryRoot(t);
  writeFixtureBundle(root, 'demo-note');
  useExamplesRoot(t, root);

  const ctx = await startControlPlane(t);
  const refused = await request<{ error: string }>(ctx, 'POST', '/v1/examples/no-such-class/run');
  assert.equal(refused.status, 404);
  assert.equal(refused.body.error, 'unknown_example');
});

test('t408 AT5 — the run registers once, and every click gets its own execution', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const root = temporaryRoot(t);
  writeFixtureBundle(root, 'demo-note');
  useExamplesRoot(t, root);

  const ctx = await startControlPlane(t);

  const first = await request<RunResult>(ctx, 'POST', `/v1/examples/${FIXTURE_CLASS}/run`);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.registered, true, 'the first click is what registered the class');
  assert.equal(first.body.job.title, FIXTURE_DEMO.title);
  assert.equal(first.body.job.entry_node_id, FIXTURE_DEMO.entry_node_id);
  assert.equal(first.body.job.current_node_id, FIXTURE_DEMO.entry_node_id);
  assert.deepEqual(first.body.job.fields, FIXTURE_DEMO.fields);
  assert.equal(typeof first.body.execution_id, 'number');
  assert.equal(first.body.job.execution_id, first.body.execution_id);
  assert.ok(
    typeof first.body.job.graph_version_id === 'string',
    'the job runs against the version the route just registered',
  );

  const second = await request<RunResult>(ctx, 'POST', `/v1/examples/${FIXTURE_CLASS}/run`);
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.registered, false, 'the second click found the class already there');
  assert.notEqual(second.body.job.id, first.body.job.id, 'a second job, not the first one again');
  assert.notEqual(
    second.body.execution_id,
    first.body.execution_id,
    'two clicks are two rounds, and never the same one',
  );
  assert.equal(
    second.body.job.graph_version_id,
    first.body.job.graph_version_id,
    'the same registered version carries both',
  );

  // And the class was registered exactly once: a second lineage would be a
  // `409` from `POST /v1/graphs`, which is the refusal this route inherits.
  const classes = await request<{ classes: { class: string }[] }>(ctx, 'GET', '/v1/classes');
  assert.equal(classes.status, 200);
  assert.deepEqual(
    classes.body.classes.filter((entry) => entry.class === FIXTURE_CLASS).length,
    1,
  );
});
