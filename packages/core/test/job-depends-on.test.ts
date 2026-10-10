/**
 * Acceptance tests of `depends_on` on `POST /v1/jobs` (t638, AT1–AT4).
 *
 * Until t638 the only writer of a `job_dependency` row was the intake
 * confirmation, so an ordered chain of jobs could not be built through the
 * public API (D1). The route now takes an optional list of job ids of the new
 * job's own project, and writes one row and one `job.dependency_declared` per
 * id inside the creation transaction. The hold the projection derives from
 * those rows is t636's, unchanged.
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
  type Event,
  type Job,
  type TestContext,
} from './support.ts';

const MINIMAL_GRAPH = path.resolve(PACKAGE_ROOT, '../../schema/examples/graph-valid-minimal.json');

/** The projection, in the fields this file reads. */
interface HeldJob extends Job {
  completed: boolean;
  depends_on: number[];
  dispatch_hold: string | null;
}

interface ErrorBody {
  error: string;
  message?: string;
}

interface LeaseAnswer {
  lease: { id: number; job_id: number } | null;
  reason?: string;
  dispatch_hold?: string;
}

/** Registers the minimal graph, every pin resolvable, and returns its version. */
async function registerMinimalGraph(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  await resolvePins(ctx, document);
  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  return response.body.graph_version.id;
}

/** Posts a job and hands the raw answer back. */
async function post(
  ctx: TestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; body: HeldJob & ErrorBody; text: string }> {
  const response = await request<HeldJob & ErrorBody>(ctx, 'POST', '/v1/jobs', {
    entry_node_id: 'redigir',
    ...body,
  });
  return { ...response, text: JSON.stringify(response.body) };
}

/** Creates a job, asserting the 201. */
async function create(ctx: TestContext, body: Record<string, unknown>): Promise<HeldJob> {
  const response = await post(ctx, body);
  assert.equal(response.status, 201, `POST /v1/jobs returned ${response.status}: ${response.text}`);
  return response.body;
}

async function read(ctx: TestContext, id: number): Promise<HeldJob> {
  const response = await request<HeldJob>(ctx, 'GET', `/v1/jobs/${id}`);
  assert.equal(response.status, 200);
  return response.body;
}

async function eventsOf(ctx: TestContext, id: number): Promise<Event[]> {
  const response = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${id}/events`);
  assert.equal(response.status, 200);
  return response.body.events.filter((event) => event.entity.id === id);
}

/** Walks a minimal-graph job to `revisar` and runs that pinned final step. */
async function arrive(ctx: TestContext, id: number): Promise<void> {
  const moved = await request(ctx, 'POST', `/v1/jobs/${id}/transitions`, { to_node_id: 'revisar' });
  assert.equal(moved.status, 200);
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'review and close',
  });
  assert.equal(opened.status, 201);
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    output: { outcome: 'pass', evidence: 'the note answers the stated theme' },
  });
  assert.equal(finished.status, 200);
}

/** The next id the sequence hands out, observed by creating a throwaway job. */
async function nextIdAfter(ctx: TestContext, previous: number): Promise<void> {
  const probe = await create(ctx, { title: 'probe' });
  assert.equal(probe.id, previous + 1, 'a refused creation consumed no id from the sequence');
}

test('t638 AT1 — depends_on writes the dependency and its event, and the job is held', async (t) => {
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);
  const a = await create(ctx, { title: 'first', graph_version_id: version });

  const b = await create(ctx, { title: 'second', graph_version_id: version, depends_on: [a.id] });
  assert.deepEqual(b.depends_on, [a.id]);
  assert.equal(b.dispatch_hold, 'dependencies');
  assert.deepEqual((await read(ctx, b.id)).depends_on, [a.id]);

  const types = (await eventsOf(ctx, b.id)).map((event) => event.type);
  assert.ok(types.includes('job.dependency_declared'), `timeline: ${types.join(', ')}`);
  assert.ok(types.indexOf('job.created') < types.indexOf('job.dependency_declared'));
  const declared = (await eventsOf(ctx, b.id)).find(
    (event) => event.type === 'job.dependency_declared',
  );
  assert.deepEqual(declared?.data, { depends_on_job_id: a.id });

  const rows = ctx.db
    .prepare('SELECT job_id, depends_on_job_id FROM job_dependency')
    .all() as Array<{ job_id: number; depends_on_job_id: number }>;
  assert.deepEqual(rows, [{ job_id: b.id, depends_on_job_id: a.id }]);

  const none = await create(ctx, { title: 'none', depends_on: [] });
  assert.deepEqual(none.depends_on, []);
  assert.equal(none.dispatch_hold, null);
});

test('t638 AT2 — a malformed depends_on is a 400 naming the field and consumes no id', async (t) => {
  const ctx = await startControlPlane(t);
  const a = await create(ctx, { title: 'first' });
  let last = a.id;

  for (const depends_on of ['1', 7, [1.5], ['1'], [a.id, a.id], [null]]) {
    const refused = await post(ctx, { title: 'bad', depends_on });
    assert.equal(refused.status, 400, `${JSON.stringify(depends_on)}: ${refused.text}`);
    assert.ok(refused.text.includes('depends_on'), `the refusal names the field: ${refused.text}`);
    await nextIdAfter(ctx, last);
    last += 1;
  }
  assert.equal(
    (ctx.db.prepare('SELECT count(*) AS n FROM job_dependency').get() as { n: number }).n,
    0,
  );
});

test('t638 AT3 — an unknown id and an id of another project read the same 404', async (t) => {
  const ctx = await startControlPlane(t);
  const other = await request<{ id: number }>(ctx, 'POST', '/v1/projects', { name: 'other' });
  assert.equal(other.status, 201);
  const elsewhere = await create(ctx, { title: 'elsewhere', project_id: other.body.id });
  const unknown = elsewhere.id + 100;

  const absent = await post(ctx, { title: 'waits on nothing', depends_on: [unknown] });
  const crossing = await post(ctx, { title: 'waits across', depends_on: [elsewhere.id] });
  assert.equal(absent.status, 404, absent.text);
  assert.equal(crossing.status, 404, crossing.text);
  assert.equal(absent.body.error, 'unknown_dependency');
  assert.equal(absent.text, crossing.text, 'the boundary reads exactly like an absence');

  await nextIdAfter(ctx, elsewhere.id);
});

test('t638 AT4 — a job waiting on an unfinished dependency is refused a lease until it arrives', async (t) => {
  const ctx = await startControlPlane(t);
  assert.equal((await request(ctx, 'POST', '/v1/runners', { id: 'runner-a' })).status, 201);
  const version = await registerMinimalGraph(ctx);
  const a = await create(ctx, { title: 'first', graph_version_id: version });
  const b = await create(ctx, { title: 'second', graph_version_id: version, depends_on: [a.id] });

  const ask = async (): Promise<{ status: number; body: LeaseAnswer }> =>
    request<LeaseAnswer>(ctx, 'POST', '/v1/leases', {
      runner_id: 'runner-a',
      project_id: 1,
      job_id: b.id,
      runner_cap: 50,
      project_cap: 50,
      ttl_seconds: 60,
    });

  const held = await ask();
  assert.equal(held.status, 200);
  assert.deepEqual(held.body, { lease: null, reason: 'job_held', dispatch_hold: 'dependencies' });

  await arrive(ctx, a.id);
  assert.equal((await read(ctx, a.id)).completed, true);
  const granted = await ask();
  assert.equal(granted.status, 201);
  assert.equal(granted.body.lease?.job_id, b.id);
});
