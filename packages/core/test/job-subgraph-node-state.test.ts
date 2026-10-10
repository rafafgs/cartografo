/**
 * Acceptance tests of the state of a job standing on a subgraph node (t638,
 * AT5–AT8).
 *
 * Since t262 a final node that pins a skill is done when that skill reported,
 * and a final node that pins nothing is done on arrival. A subgraph node pins
 * nothing, so until t638 a job arriving on a final one read `completed` at
 * once and dropped out of the dispatch queue before its children were ever
 * opened. The per-node fact is now "pins a skill, OR is a subgraph node": the
 * call has to report, through its own session, before the node counts as done.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  request,
  resolvePins,
  startControlPlane,
  type Job,
  type TestContext,
} from './support.ts';

const EXAMPLES = path.resolve(PACKAGE_ROOT, '../../schema/examples');

type Doc = Record<string, unknown> & {
  problem_class: string;
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown>>;
  final_nodes: string[];
};

interface StatedJob extends Job {
  completed: boolean;
  state: string;
}

function example(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8')) as Doc;
}

/** Registers a document, every pin resolvable, and returns its version. */
async function register(ctx: TestContext, document: Doc): Promise<string> {
  await resolvePins(ctx, document);
  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs: ${JSON.stringify(response.body)}`);
  return response.body.graph_version.id;
}

/** The called class first, then the caller whose only node is a final subgraph node. */
async function registerCaller(ctx: TestContext): Promise<{ minimal: string; caller: string }> {
  const minimal = await register(ctx, example('graph-valid-minimal.json'));
  const caller = await register(ctx, example('graph-valid-subgraph.json'));
  return { minimal, caller };
}

/** The caller with its subgraph node NOT final: a pinned work node follows it. */
function callerWithFollower(): Doc {
  const document = example('graph-valid-subgraph.json');
  document.problem_class = 'note-review-then-publish';
  const follower = structuredClone(example('graph-valid-minimal.json').nodes[1]);
  follower.id = 'publish';
  document.nodes.push(follower);
  document.edges.push({
    from: 'write-note',
    to: 'publish',
    condition: 'always',
    description: 'The collected note always goes on to be published.',
  });
  document.final_nodes = ['publish'];
  return document;
}

async function create(ctx: TestContext, body: Record<string, unknown>): Promise<StatedJob> {
  const response = await request<StatedJob>(ctx, 'POST', '/v1/jobs', body);
  assert.equal(response.status, 201, `POST /v1/jobs: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function read(ctx: TestContext, id: number): Promise<StatedJob> {
  const response = await request<StatedJob>(ctx, 'GET', `/v1/jobs/${id}`);
  assert.equal(response.status, 200);
  return response.body;
}

/** Opens a session on a node and closes it with the given status and body. */
async function runSession(
  ctx: TestContext,
  jobId: number,
  nodeId: string,
  finish: Record<string, unknown>,
): Promise<void> {
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'subgraph',
    working_dir: '(none)',
    prompt: `the call of ${nodeId}`,
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, finish);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
}

test('t638 AT5 — a job on a final subgraph node with no session has not completed', async (t) => {
  const ctx = await startControlPlane(t);
  const { caller } = await registerCaller(ctx);
  const job = await create(ctx, {
    title: 'a call nobody ran',
    entry_node_id: 'write-note',
    graph_version_id: caller,
  });

  const projected = await read(ctx, job.id);
  assert.equal(projected.completed, false, 'arriving on a call is not having made it');
  assert.notEqual(projected.state, 'completed');
  assert.equal(projected.state, 'queued');
});

test('t638 AT6 — only a completed session with an output completes the subgraph node', async (t) => {
  const ctx = await startControlPlane(t);
  const { caller } = await registerCaller(ctx);
  const job = await create(ctx, {
    title: 'a call that reports',
    entry_node_id: 'write-note',
    graph_version_id: caller,
  });

  await runSession(ctx, job.id, 'write-note', { status: 'completed', exit_code: 0 });
  assert.equal((await read(ctx, job.id)).completed, false, 'output null does not complete it');

  await runSession(ctx, job.id, 'write-note', {
    status: 'failed',
    exit_code: 1,
    output: { text: 'a note' },
  });
  assert.equal((await read(ctx, job.id)).completed, false, 'a failed session does not either');

  await runSession(ctx, job.id, 'write-note', {
    status: 'completed',
    exit_code: 0,
    output: { text: 'the note the child wrote' },
  });
  const done = await read(ctx, job.id);
  assert.equal(done.completed, true);
  assert.equal(done.state, 'completed');
});

test('t638 AT7 — a no-pin work node, a pinned node and a non-final subgraph node keep their rule', async (t) => {
  const ctx = await startControlPlane(t);
  const { minimal } = await registerCaller(ctx);

  // A final WORK node that pins nothing still completes on arrival. The schema
  // refuses such a node at registration, so the snapshot is edited in place —
  // the defensive branch exists for a malformed or pre-existing snapshot.
  const pinless = await create(ctx, {
    title: 'final work node, no pin',
    entry_node_id: 'redigir',
    graph_version_id: minimal,
  });
  const stored = ctx.db
    .prepare('SELECT snapshot FROM graph_version WHERE id = ?')
    .get(minimal) as { snapshot: string };
  const edited = JSON.parse(stored.snapshot) as Doc;
  const revisar = edited.nodes.find((node) => node.id === 'revisar') as Record<string, unknown>;
  const pinnedVersion = await create(ctx, {
    title: 'final node with a pin',
    entry_node_id: 'revisar',
    graph_version_id: minimal,
  });
  assert.equal((await read(ctx, pinnedVersion.id)).completed, false, 'a pin still demands a report');

  delete revisar.skill_ref;
  revisar.node_type = 'work';
  ctx.db
    .prepare('UPDATE graph_version SET snapshot = ? WHERE id = ?')
    .run(JSON.stringify(edited), minimal);
  const moved = await request(ctx, 'POST', `/v1/jobs/${pinless.id}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const arrived = await read(ctx, pinless.id);
  assert.equal(arrived.completed, true, 'a final node with no pin and no call is done on arrival');
  assert.equal(arrived.state, 'completed');

  // A subgraph node that is NOT final: the job is queued on it, as on any node.
  const follower = await register(ctx, callerWithFollower());
  const midway = await create(ctx, {
    title: 'a call halfway',
    entry_node_id: 'write-note',
    graph_version_id: follower,
  });
  const projected = await read(ctx, midway.id);
  assert.equal(projected.completed, false);
  assert.equal(projected.state, 'queued');
});

test('t638 AT8 — the board costs the same statements with subgraph-node jobs in the set', async (t) => {
  /** Counts every statement prepared while one path is read. */
  const preparesFor = async (ctx: TestContext, routePath: string): Promise<number> => {
    const handle = ctx.db as unknown as { prepare: (sql: string) => unknown };
    const original = handle.prepare.bind(ctx.db);
    let prepared = 0;
    handle.prepare = (sql: string): unknown => {
      prepared += 1;
      return original(sql);
    };
    try {
      const response = await request<{ jobs: StatedJob[] }>(ctx, 'GET', routePath);
      assert.equal(response.status, 200);
    } finally {
      handle.prepare = original;
    }
    return prepared;
  };

  const small = await startControlPlane(t);
  const smallVersions = await registerCaller(small);
  for (const title of ['one', 'two', 'three']) {
    await create(small, { title, entry_node_id: 'redigir', graph_version_id: smallVersions.minimal });
  }

  const large = await startControlPlane(t);
  const largeVersions = await registerCaller(large);
  for (let index = 0; index < 10; index += 1) {
    const parent = await create(large, {
      title: `caller ${index}`,
      entry_node_id: 'write-note',
      graph_version_id: largeVersions.caller,
    });
    await create(large, {
      title: `child ${index}`,
      entry_node_id: 'redigir',
      graph_version_id: largeVersions.minimal,
      parent_job_id: parent.id,
      parent_node_id: 'write-note',
    });
    await create(large, {
      title: `plain ${index}`,
      entry_node_id: 'redigir',
      graph_version_id: largeVersions.minimal,
    });
  }

  const boardSmall = await preparesFor(small, '/v1/jobs');
  const boardLarge = await preparesFor(large, '/v1/jobs');
  assert.equal(
    boardLarge,
    boardSmall,
    `the board prepared ${boardLarge} statements for 30 jobs and ${boardSmall} for 3`,
  );
});
