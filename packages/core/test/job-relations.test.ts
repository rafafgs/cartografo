/**
 * Acceptance tests of job relations in the core (t636, AT4–AT18).
 *
 * Three primitives, all of them facts and none of them a cached derivation:
 *
 * - a PARENT link, written when `POST /v1/jobs` creates a child, with its own
 *   `job.parent_linked` event on the child's timeline;
 * - the dependencies the intake already recorded, now READ: a dependent whose
 *   dependency has not completed is held;
 * - a CANCELLATION, which closes a job for good and cascades to its open
 *   children, in one transaction.
 *
 * What is published on the projection is `parent_job_id`, `parent_node_id`,
 * `sibling_position`, `children`, the open `depends_on`, `cancelled_at` and the
 * derived `dispatch_hold`. Everything goes through the HTTP surface; the
 * database handle is used to read, and once (AT15) to install the trigger that
 * makes a cascade fail halfway.
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

/** The projection with the seven fields this ticket adds. */
interface RelatedJob extends Job {
  completed: boolean;
  parent_job_id: number | null;
  parent_node_id: string | null;
  sibling_position: number | null;
  children: number[];
  depends_on: number[];
  cancelled_at: string | null;
  dispatch_hold: 'cancelled' | 'dependencies' | 'children' | null;
}

interface ErrorBody {
  error: string;
  message?: string;
  details?: string[];
}

/** Registers the minimal graph and returns its version, every pin resolvable. */
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

/** Creates a job, asserting the 201. */
async function create(ctx: TestContext, body: Record<string, unknown>): Promise<RelatedJob> {
  const response = await request<RelatedJob>(ctx, 'POST', '/v1/jobs', {
    entry_node_id: 'redigir',
    ...body,
  });
  assert.equal(
    response.status,
    201,
    `POST /v1/jobs returned ${response.status}: ${JSON.stringify(response.body)}`,
  );
  return response.body;
}

/** Creates a child of `parent`, opened from `node`. */
async function childOf(
  ctx: TestContext,
  parent: number,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<RelatedJob> {
  return create(ctx, { title, parent_job_id: parent, parent_node_id: 'fan-out', ...extra });
}

/** Reads one job. */
async function read(ctx: TestContext, id: number): Promise<RelatedJob> {
  const response = await request<RelatedJob>(ctx, 'GET', `/v1/jobs/${id}`);
  assert.equal(response.status, 200, `GET /v1/jobs/${id} returned ${response.status}`);
  return response.body;
}

/** The job's own timeline. */
async function eventsOf(ctx: TestContext, id: number): Promise<Event[]> {
  const response = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${id}/events`);
  assert.equal(response.status, 200);
  return response.body.events;
}

/** Only the `job.cancelled` events of a job's own timeline. */
async function cancellationsOf(ctx: TestContext, id: number): Promise<Event[]> {
  return (await eventsOf(ctx, id)).filter(
    (event) => event.type === 'job.cancelled' && event.entity.id === id,
  );
}

/** Cancels a job through the route. */
async function cancel(
  ctx: TestContext,
  id: number,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: RelatedJob & ErrorBody }> {
  return request<RelatedJob & ErrorBody>(ctx, 'POST', `/v1/jobs/${id}/cancellations`, body ?? {});
}

/** Walks a minimal-graph job to `revisar` and runs that pinned final step. */
async function arrive(ctx: TestContext, id: number): Promise<void> {
  const moved = await request(ctx, 'POST', `/v1/jobs/${id}/transitions`, { to_node_id: 'revisar' });
  assert.equal(moved.status, 200, `the transition answered ${moved.status}`);
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'review and close',
  });
  assert.equal(opened.status, 201, `POST /v1/sessions returned ${opened.status}`);
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    output: { outcome: 'pass', evidence: 'the note answers the stated theme' },
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);
  assert.equal((await read(ctx, id)).completed, true, 'the fixture job has to arrive');
}

/** How many rows a table holds. */
function rows(ctx: TestContext, table: string): number {
  return (ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('t636 AT4 — a child is born with its parent link and a 1-based position per parent', async (t) => {
  const ctx = await startControlPlane(t);
  const parent = await create(ctx, { title: 'parent' });
  const other = await create(ctx, { title: 'another parent' });

  const first = await childOf(ctx, parent.id, 'first child');
  assert.equal(first.parent_job_id, parent.id);
  assert.equal(first.parent_node_id, 'fan-out');
  assert.equal(first.sibling_position, 1);

  const second = await childOf(ctx, parent.id, 'second child');
  assert.equal(second.sibling_position, 2);

  const elsewhere = await childOf(ctx, other.id, 'child of the other parent');
  assert.equal(elsewhere.sibling_position, 1, 'positions count per parent');
});

test('t636 AT5 — a half-declared or malformed parent is 400 and consumes no id', async (t) => {
  const ctx = await startControlPlane(t);
  const parent = await create(ctx, { title: 'parent' });

  const onlyId = await request<ErrorBody>(ctx, 'POST', '/v1/jobs', {
    title: 'half',
    entry_node_id: 'redigir',
    parent_job_id: parent.id,
  });
  assert.equal(onlyId.status, 400);
  assert.match(JSON.stringify(onlyId.body), /parent_node_id/, 'the refusal names the missing field');

  const onlyNode = await request<ErrorBody>(ctx, 'POST', '/v1/jobs', {
    title: 'half',
    entry_node_id: 'redigir',
    parent_node_id: 'fan-out',
  });
  assert.equal(onlyNode.status, 400);
  assert.match(JSON.stringify(onlyNode.body), /parent_job_id/, 'the refusal names the missing field');

  for (const body of [
    { parent_job_id: 'one', parent_node_id: 'fan-out' },
    { parent_job_id: 1.5, parent_node_id: 'fan-out' },
    { parent_job_id: parent.id, parent_node_id: '' },
    { parent_job_id: parent.id, parent_node_id: 7 },
  ]) {
    const refused = await request<ErrorBody>(ctx, 'POST', '/v1/jobs', {
      title: 'malformed',
      entry_node_id: 'redigir',
      ...body,
    });
    assert.equal(refused.status, 400, `${JSON.stringify(body)} answered ${refused.status}`);
  }

  const next = await create(ctx, { title: 'the next job' });
  assert.equal(next.id, parent.id + 1, 'no refusal consumed an id from the sequence');
  assert.equal(rows(ctx, 'job_parent'), 0);
});

test('t636 AT6 — an unknown or foreign parent is the same 404; a cancelled one is 409', async (t) => {
  const ctx = await startControlPlane(t);
  const project = await request<{ id: number }>(ctx, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(project.status, 201);
  const foreign = await create(ctx, { title: 'lives elsewhere', project_id: project.body.id });
  const before = await create(ctx, { title: 'a marker' });

  const unknown = await request<ErrorBody>(ctx, 'POST', '/v1/jobs', {
    title: 'orphan',
    entry_node_id: 'redigir',
    parent_job_id: 9999,
    parent_node_id: 'fan-out',
  });
  const crossing = await request<ErrorBody>(ctx, 'POST', '/v1/jobs', {
    title: 'orphan',
    entry_node_id: 'redigir',
    parent_job_id: foreign.id,
    parent_node_id: 'fan-out',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'unknown_parent_job');
  assert.equal(crossing.status, 404);
  assert.deepEqual(
    crossing.body,
    unknown.body,
    'a parent across the boundary reads exactly like a parent that does not exist',
  );

  const cancelledParent = await create(ctx, { title: 'cancelled parent' });
  assert.equal((await cancel(ctx, cancelledParent.id)).status, 200);
  const late = await request<ErrorBody>(ctx, 'POST', '/v1/jobs', {
    title: 'too late',
    entry_node_id: 'redigir',
    parent_job_id: cancelledParent.id,
    parent_node_id: 'fan-out',
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'parent_cancelled');

  const next = await create(ctx, { title: 'the next job' });
  assert.equal(next.id, cancelledParent.id + 1, 'no refusal consumed an id');
  assert.ok(before.id < cancelledParent.id);
  assert.equal(rows(ctx, 'job_parent'), 0, 'no refusal wrote a link');
});

test('t636 AT7 — job.parent_linked follows job.created on the child timeline', async (t) => {
  const ctx = await startControlPlane(t);
  const parent = await create(ctx, { title: 'parent' });
  const child = await childOf(ctx, parent.id, 'child');

  const events = await eventsOf(ctx, child.id);
  const created = events.find((event) => event.type === 'job.created');
  const linked = events.find((event) => event.type === 'job.parent_linked');
  assert.ok(created && linked, `the child timeline carries both: ${events.map((e) => e.type)}`);
  assert.equal(linked.id, created.id + 1, 'the link is recorded right after the creation');
  assert.equal(linked.occurred_at, created.occurred_at);
  assert.deepEqual(linked.entity, { type: 'job', id: child.id });
  assert.deepEqual(linked.data, {
    parent_job_id: parent.id,
    parent_node_id: 'fan-out',
    sibling_position: 1,
  });

  const parentCreated = (await eventsOf(ctx, parent.id)).find((e) => e.type === 'job.created');
  assert.ok(parentCreated);
  assert.deepEqual(
    Object.keys(created.data).sort(),
    Object.keys(parentCreated.data).sort(),
    'job.created carries no new key for a child',
  );
});

test('t636 AT8 — the parent lists its children in order; a lone job reads empty relations', async (t) => {
  const ctx = await startControlPlane(t);
  const parent = await create(ctx, { title: 'parent' });
  const a = await childOf(ctx, parent.id, 'a');
  const b = await childOf(ctx, parent.id, 'b');
  const c = await childOf(ctx, parent.id, 'c');

  assert.deepEqual((await read(ctx, parent.id)).children, [a.id, b.id, c.id]);

  const lone = await create(ctx, { title: 'lone' });
  assert.deepEqual(lone.children, []);
  assert.deepEqual(lone.depends_on, []);
  assert.equal(lone.parent_job_id, null);
  assert.equal(lone.parent_node_id, null);
  assert.equal(lone.sibling_position, null);
  assert.equal(lone.cancelled_at, null);
  assert.equal(lone.dispatch_hold, null);

  const board = await request<{ jobs: RelatedJob[] }>(ctx, 'GET', '/v1/jobs');
  const listed = board.body.jobs.find((job) => job.id === parent.id);
  assert.deepEqual(listed?.children, [a.id, b.id, c.id], 'the board publishes the same relations');
});

test('t636 AT9 — an unfinished child holds its parent until it arrives', async (t) => {
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);
  const parent = await create(ctx, { title: 'parent' });
  const child = await childOf(ctx, parent.id, 'child', { graph_version_id: version });

  assert.equal((await read(ctx, parent.id)).dispatch_hold, 'children');
  await arrive(ctx, child.id);
  assert.equal((await read(ctx, parent.id)).dispatch_hold, null);
});

test('t636 AT10 — an intake dependency holds the dependent until it arrives', async (t) => {
  const ctx = await startControlPlane(t);
  await registerMinimalGraph(ctx);

  const draft = await request<{ draft: { id: number } }>(ctx, 'POST', '/v1/intake', {
    class: 'nota-curta',
    request: 'two notes, one after the other',
    items: [
      { ref: 'first', title: 'first note' },
      { ref: 'second', title: 'second note', depends_on: ['first'] },
    ],
  });
  assert.equal(draft.status, 201, `POST /v1/intake returned ${draft.status}`);
  const confirmed = await request<{ draft: { created_jobs: Record<string, number> } }>(
    ctx,
    'POST',
    `/v1/intake/${draft.body.draft.id}/confirmations`,
    {},
  );
  assert.equal(confirmed.status, 201);
  const first = confirmed.body.draft.created_jobs.first;
  const second = confirmed.body.draft.created_jobs.second;

  const waiting = await read(ctx, second);
  assert.deepEqual(waiting.depends_on, [first]);
  assert.equal(waiting.dispatch_hold, 'dependencies');
  assert.equal((await read(ctx, first)).dispatch_hold, null);

  await arrive(ctx, first);
  const released = await read(ctx, second);
  assert.deepEqual(released.depends_on, []);
  assert.equal(released.dispatch_hold, null);
});

test('t636 AT11 — cancelling an open job records the reason once', async (t) => {
  const ctx = await startControlPlane(t);
  const withReason = await create(ctx, { title: 'with a reason' });
  const without = await create(ctx, { title: 'without one' });

  const answered = await cancel(ctx, withReason.id, { reason: 'the theme was dropped' });
  assert.equal(answered.status, 200);
  assert.equal(typeof answered.body.cancelled_at, 'string');
  assert.equal(answered.body.dispatch_hold, 'cancelled');
  const events = await cancellationsOf(ctx, withReason.id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { reason: 'the theme was dropped', cascaded_from_job_id: null });
  assert.equal(events[0].occurred_at, answered.body.cancelled_at);

  assert.equal((await cancel(ctx, without.id)).status, 200);
  const silent = await cancellationsOf(ctx, without.id);
  assert.deepEqual(silent[0].data, { reason: null, cascaded_from_job_id: null });
});

test('t636 AT12 — idempotent on a cancelled job, 404 on unknown, 409 on an arrived one', async (t) => {
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);
  const job = await create(ctx, { title: 'cancel me twice' });

  const first = await cancel(ctx, job.id, { reason: 'once' });
  const second = await cancel(ctx, job.id, { reason: 'twice' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body, 'the second answer is the unchanged projection');
  assert.equal((await cancellationsOf(ctx, job.id)).length, 1);
  assert.equal(rows(ctx, 'job_cancellation'), 1);

  const unknown = await cancel(ctx, 9999);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');

  const done = await create(ctx, { title: 'done', graph_version_id: version });
  await arrive(ctx, done.id);
  const refused = await cancel(ctx, done.id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'job_completed');
  assert.equal((await cancellationsOf(ctx, done.id)).length, 0);
  assert.equal(rows(ctx, 'job_cancellation'), 1);
});

test('t636 AT13 — the cancel cascades to open descendants and stops at a completed child', async (t) => {
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);
  const parent = await create(ctx, { title: 'parent' });
  const a = await childOf(ctx, parent.id, 'open child a');
  const b = await childOf(ctx, parent.id, 'open child b');
  const done = await childOf(ctx, parent.id, 'completed child', { graph_version_id: version });
  const grandchild = await childOf(ctx, a.id, 'grandchild under a');
  await arrive(ctx, done.id);

  const actor = { type: 'user', ref: 'rafael' };
  const answered = await cancel(ctx, parent.id, { reason: 'abandoned', actor });
  assert.equal(answered.status, 200);

  const expected: Array<[number, number | null]> = [
    [parent.id, null],
    [a.id, parent.id],
    [b.id, parent.id],
    [grandchild.id, a.id],
  ];
  const all: Event[] = [];
  for (const [id, from] of expected) {
    const events = await cancellationsOf(ctx, id);
    assert.equal(events.length, 1, `job ${id} has one job.cancelled`);
    assert.equal(events[0].data.cascaded_from_job_id, from, `job ${id} names who cascaded`);
    assert.equal((await read(ctx, id)).dispatch_hold, 'cancelled');
    all.push(events[0]);
  }
  for (const event of all) {
    assert.deepEqual(event.actor, actor, 'every cancel of the cascade has the same actor');
    assert.equal(event.occurred_at, all[0].occurred_at, 'and the same instant');
  }

  const untouched = await read(ctx, done.id);
  assert.equal(untouched.cancelled_at, null, 'a completed child is left alone');
  assert.equal((await cancellationsOf(ctx, done.id)).length, 0);
});

test('t636 AT14 — cancelling a child never touches its parent, which stays held', async (t) => {
  const ctx = await startControlPlane(t);
  const parent = await create(ctx, { title: 'parent' });
  const child = await childOf(ctx, parent.id, 'child');

  assert.equal((await cancel(ctx, child.id)).status, 200);
  const after = await read(ctx, parent.id);
  assert.equal(after.cancelled_at, null);
  assert.equal(after.dispatch_hold, 'children', 'a cancelled child does not release its parent');
  assert.equal((await cancellationsOf(ctx, parent.id)).length, 0);
});

test('t636 AT15 — a cascade that fails halfway cancels nothing', async (t) => {
  const ctx = await startControlPlane(t);
  const parent = await create(ctx, { title: 'parent' });
  const a = await childOf(ctx, parent.id, 'child');
  const grandchild = await childOf(ctx, a.id, 'grandchild');

  ctx.db.exec(
    `CREATE TRIGGER t636_fail_cancel BEFORE INSERT ON job_cancellation
       WHEN NEW.job_id = ${grandchild.id}
     BEGIN SELECT RAISE(ABORT, 't636 injected failure'); END`,
  );

  const answered = await cancel(ctx, parent.id);
  assert.notEqual(answered.status, 200, 'the injected failure has to surface');
  assert.equal(rows(ctx, 'job_cancellation'), 0, 'nothing of the cascade was kept');
  for (const id of [parent.id, a.id, grandchild.id]) {
    assert.equal((await cancellationsOf(ctx, id)).length, 0, `job ${id} has no job.cancelled`);
    assert.equal((await read(ctx, id)).cancelled_at, null);
  }
});

test('t636 AT16 — the board prepares the same statements for 3 jobs and for 30 with relations', async (t) => {
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
      const response = await request<{ jobs: RelatedJob[] }>(ctx, 'GET', routePath);
      assert.equal(response.status, 200);
    } finally {
      handle.prepare = original;
    }
    return prepared;
  };

  const small = await startControlPlane(t);
  const smallVersion = await registerMinimalGraph(small);
  for (const title of ['one', 'two', 'three']) {
    await create(small, { title, graph_version_id: smallVersion, execution_id: 1 });
  }

  const large = await startControlPlane(t);
  const largeVersion = await registerMinimalGraph(large);
  // Six parents in round 1, each with two children in round 2: the filtered
  // board of round 1 has to resolve relations to jobs it does not list.
  for (let index = 0; index < 6; index += 1) {
    const parent = await create(large, {
      title: `parent ${index}`,
      graph_version_id: largeVersion,
      execution_id: 1,
    });
    for (const side of ['left', 'right']) {
      await childOf(large, parent.id, `${side} ${index}`, {
        graph_version_id: largeVersion,
        execution_id: 2,
      });
    }
  }
  // Twelve more through the intake, chained by dependencies.
  const items = Array.from({ length: 12 }, (_, index) => ({
    ref: `item-${index}`,
    title: `item ${index}`,
    ...(index === 0 ? {} : { depends_on: [`item-${index - 1}`] }),
  }));
  const draft = await request<{ draft: { id: number } }>(large, 'POST', '/v1/intake', {
    class: 'nota-curta',
    request: 'a chain of twelve',
    execution_id: 1,
    items,
  });
  assert.equal(draft.status, 201);
  const confirmed = await request(large, 'POST', `/v1/intake/${draft.body.draft.id}/confirmations`, {});
  assert.equal(confirmed.status, 201);
  assert.equal(rows(large, 'job'), 30);
  const cancelled = await cancel(large, 1);
  assert.equal(cancelled.status, 200);

  const boardSmall = await preparesFor(small, '/v1/jobs');
  const boardLarge = await preparesFor(large, '/v1/jobs');
  assert.equal(
    boardLarge,
    boardSmall,
    `the board prepared ${boardLarge} statements for 30 related jobs and ${boardSmall} for 3`,
  );

  const roundSmall = await preparesFor(small, '/v1/jobs?execution_id=1');
  const roundLarge = await preparesFor(large, '/v1/jobs?execution_id=1');
  assert.equal(
    roundLarge,
    roundSmall,
    'resolving relations to jobs outside the list is one batched read, not one per job',
  );
});

test('t636 AT17 — the two new event types are validated with their fields', async () => {
  const validation = (await import(
    new URL('../src/db/event-validation.ts', import.meta.url).href
  )) as {
    requireValidData: (type: string, data: Record<string, unknown>) => Record<string, unknown>;
    KNOWN_TYPES: readonly string[];
  };

  assert.deepEqual(
    validation.requireValidData('job.parent_linked', {
      parent_job_id: 3,
      parent_node_id: 'fan-out',
      sibling_position: 2,
    }),
    { parent_job_id: 3, parent_node_id: 'fan-out', sibling_position: 2 },
  );
  assert.throws(() =>
    validation.requireValidData('job.parent_linked', { parent_job_id: 3, parent_node_id: 'x' }),
  );
  assert.throws(() =>
    validation.requireValidData('job.parent_linked', {
      parent_job_id: 3,
      parent_node_id: 'x',
      sibling_position: 1,
      extra: true,
    }),
  );

  assert.deepEqual(validation.requireValidData('job.cancelled', {}), {
    reason: null,
    cascaded_from_job_id: null,
  });
  assert.deepEqual(
    validation.requireValidData('job.cancelled', { reason: 'why', cascaded_from_job_id: 4 }),
    { reason: 'why', cascaded_from_job_id: 4 },
  );
  assert.throws(() => validation.requireValidData('job.cancelled', { stray: 1 }));
  assert.throws(() => validation.requireValidData('job.cancelled', { cascaded_from_job_id: 'x' }));

  const types = [...validation.KNOWN_TYPES];
  const at = types.indexOf('job.dependency_declared');
  assert.deepEqual(types.slice(at, at + 4), [
    'job.dependency_declared',
    'job.parent_linked',
    'job.cancelled',
    'job.hook_failed',
  ]);
});

test('t636 AT18 — a runner credential may not cancel', async (t) => {
  const ctx = await startControlPlane(t);
  const job = await create(ctx, { title: 'not the runner\'s to cancel' });
  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', {
    id: 'runner-a',
  });
  assert.equal(paired.status, 201);

  const denied = await fetch(`${ctx.url}/v1/jobs/${job.id}/cancellations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${paired.body.token ?? ''}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as ErrorBody).error, 'out_of_scope_credential');
  assert.equal(rows(ctx, 'job_cancellation'), 0);
});
