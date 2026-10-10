/**
 * Acceptance tests of the report of a subgraph node (t638, AT9–AT11).
 *
 * A session's report is checked against the `output` of the skill its node
 * pins (t268). A subgraph node pins no skill, so until t638 nothing checked
 * what the call handed back, although the node spec says the output is
 * assembled "through its own output contract". The node's own
 * `contract.output_schema` is now the fallback for a subgraph node — and for a
 * subgraph node only.
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
  type TestContext,
} from './support.ts';

const EXAMPLES = path.resolve(PACKAGE_ROOT, '../../schema/examples');

type Doc = Record<string, unknown> & { nodes: Array<Record<string, unknown>> };

interface FinishAnswer {
  output: Record<string, unknown> | null;
  output_accepted: boolean;
  output_schema_error?: string[];
}

function example(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8')) as Doc;
}

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

/** A job on the caller's subgraph node, the called class registered first. */
async function jobOnCall(ctx: TestContext): Promise<number> {
  await register(ctx, example('graph-valid-minimal.json'));
  const caller = await register(ctx, example('graph-valid-subgraph.json'));
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/jobs', {
    title: 'a call',
    entry_node_id: 'write-note',
    graph_version_id: caller,
  });
  assert.equal(response.status, 201);
  return response.body.id;
}

/** Opens a session on a node and finishes it `completed` with `output`. */
async function report(
  ctx: TestContext,
  jobId: number,
  nodeId: string,
  output: Record<string, unknown>,
): Promise<{ id: number; answer: FinishAnswer }> {
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'subgraph',
    working_dir: '(none)',
    prompt: `the call of ${nodeId}`,
  });
  assert.equal(opened.status, 201);
  const finished = await request<FinishAnswer>(
    ctx,
    'PATCH',
    `/v1/sessions/${opened.body.id}/finish`,
    { status: 'completed', exit_code: 0, transcript: '1/1 job 2', output },
  );
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  return { id: opened.body.id, answer: finished.body };
}

/** What the table holds for a session's report. */
function storedOutput(ctx: TestContext, sessionId: number): unknown {
  const row = ctx.db.prepare('SELECT output FROM session WHERE id = ?').get(sessionId) as {
    output: string | null;
  };
  return row.output === null ? null : JSON.parse(row.output);
}

test('t638 AT9 — a report satisfying the node contract is accepted and stored', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await jobOnCall(ctx);

  const { id, answer } = await report(ctx, jobId, 'write-note', { text: 'the child wrote this' });
  assert.equal(answer.output_accepted, true);
  assert.deepEqual(answer.output, { text: 'the child wrote this' });
  assert.deepEqual(storedOutput(ctx, id), { text: 'the child wrote this' });
});

test('t638 AT10 — a report missing a required property is refused against the node contract', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await jobOnCall(ctx);

  const { id, answer } = await report(ctx, jobId, 'write-note', { texts: ['wrong key'] });
  assert.equal(answer.output_accepted, false);
  assert.equal(answer.output, null);
  assert.equal(storedOutput(ctx, id), null);
  assert.ok(
    (answer.output_schema_error ?? []).some((problem) => problem.includes('text')),
    `the refusal names the property: ${JSON.stringify(answer.output_schema_error)}`,
  );

  const timeline = ctx.db
    .prepare(
      `SELECT data FROM event WHERE type = 'session.finished' AND entity_type = 'session'
          AND entity_id = ?`,
    )
    .get(String(id)) as { data: string };
  assert.equal((JSON.parse(timeline.data) as { output_accepted: boolean }).output_accepted, false);
});

test('t638 AT11 — a non-subgraph node with no pin still resolves no schema', async (t) => {
  const ctx = await startControlPlane(t);
  const minimal = await register(ctx, example('graph-valid-minimal.json'));
  const job = await request<{ id: number }>(ctx, 'POST', '/v1/jobs', {
    title: 'a pinless work node',
    entry_node_id: 'redigir',
    graph_version_id: minimal,
  });
  assert.equal(job.status, 201);

  // Strip the pin from the stored snapshot: the schema refuses such a node at
  // registration, and the fallback must not reach for its contract either.
  const stored = ctx.db
    .prepare('SELECT snapshot FROM graph_version WHERE id = ?')
    .get(minimal) as { snapshot: string };
  const edited = JSON.parse(stored.snapshot) as Doc;
  delete edited.nodes[0].skill_ref;
  ctx.db
    .prepare('UPDATE graph_version SET snapshot = ? WHERE id = ?')
    .run(JSON.stringify(edited), minimal);

  // `redigir`'s contract requires `texto`; with no pin and no call, nothing checks it.
  const { id, answer } = await report(ctx, job.body.id, 'redigir', { anything: 1 });
  assert.equal(answer.output_accepted, true);
  assert.deepEqual(storedOutput(ctx, id), { anything: 1 });
});
