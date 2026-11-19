/**
 * Acceptance tests for the error a closure carries (t1313, FR6–FR7).
 *
 * A session the runner closed on its own account, after a failure past the
 * engine's end, used to stay `open` instead: there was no way to say what went
 * wrong, and the runner never closed it. `PATCH /v1/sessions/:id/finish` now
 * takes an optional `error`, and it lives in the `session.finished` event only:
 * no column, no migration, nothing new on `GET /v1/sessions`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJob,
  loadEvents,
  request,
  startControlPlane,
  type Job,
  type Session,
  type TestContext,
} from './support.ts';

/** Opens a session on `node` of `jobId`. */
async function openSession(ctx: TestContext, jobId: number, node = 'implement'): Promise<Session> {
  const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: node,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'do the step',
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/** The one `session.finished` event of a session's log, or `undefined`. */
async function finishedEvent(
  ctx: TestContext,
  sessionId: number,
): Promise<Record<string, unknown> | undefined> {
  const { getEventsByEntity } = await loadEvents();
  return getEventsByEntity(ctx.db, 'session', sessionId).find(
    (event) => event.type === 'session.finished',
  )?.data;
}

test('t1313 AT9 — `error` rides in session.finished, and its absence reads null', async (t) => {
  const ctx = await startControlPlane(t);
  const job = await createJob(ctx, { title: 'a tick that failed after the engine', entry_node_id: 'implement' });

  const session = await openSession(ctx, job.id);
  const closed = await request<Session>(ctx, 'PATCH', `/v1/sessions/${String(session.id)}/finish`, {
    status: 'failed',
    error: 'boom',
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, 'failed');
  assert.notEqual(closed.body.finished_at, null);
  assert.ok(!('error' in closed.body), 'the session projection grows no field');

  const data = await finishedEvent(ctx, session.id);
  assert.ok(data !== undefined, 'session.finished was recorded');
  assert.equal(data.error, 'boom');

  const plain = await openSession(ctx, job.id);
  const ended = await request(ctx, 'PATCH', `/v1/sessions/${String(plain.id)}/finish`, {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(ended.status, 200);
  const plainData = await finishedEvent(ctx, plain.id);
  assert.ok(plainData !== undefined);
  assert.ok('error' in plainData, 'normalized like every optional field of the payload');
  assert.equal(plainData.error, null);
});

test('t1313 AT10 — an invalid `error` is refused with 400 and the session stays open', async (t) => {
  const ctx = await startControlPlane(t);
  const job = await createJob(ctx, { title: 'a closure with a bad error', entry_node_id: 'implement' });
  const session = await openSession(ctx, job.id);

  for (const error of [42, '', 'e'.repeat(8001), { message: 'boom' }]) {
    const refused = await request(ctx, 'PATCH', `/v1/sessions/${String(session.id)}/finish`, {
      status: 'failed',
      error,
    });
    assert.equal(refused.status, 400, `error=${JSON.stringify(error).slice(0, 40)} is refused`);

    const listed = await request<{ sessions: Session[] }>(
      ctx,
      'GET',
      `/v1/sessions?job_id=${String(job.id)}`,
    );
    assert.equal(listed.body.sessions[0].status, 'open', 'nothing was written');
    assert.equal(listed.body.sessions[0].finished_at, null);
  }
  assert.equal(await finishedEvent(ctx, session.id), undefined, 'no session.finished either');

  const longest = await request(ctx, 'PATCH', `/v1/sessions/${String(session.id)}/finish`, {
    status: 'failed',
    error: 'e'.repeat(8000),
  });
  assert.equal(longest.status, 200, '8000 characters is still inside the bound');
});

test('t1313 AT11 — three failed closures with an error still trip the streak guard', async (t) => {
  const ctx = await startControlPlane(t);
  const job = await createJob(ctx, { title: 'a loop of dead ticks', entry_node_id: 'implement' });

  const readJob = async (): Promise<Job> =>
    (await request<Job>(ctx, 'GET', `/v1/jobs/${String(job.id)}`)).body;

  for (let tick = 1; tick <= 3; tick += 1) {
    const session = await openSession(ctx, job.id);
    const closed = await request(ctx, 'PATCH', `/v1/sessions/${String(session.id)}/finish`, {
      status: 'failed',
      exit_code: 0,
      timeout_reason: null,
      transcript: '',
      error: `UploadError: tick ${String(tick)} could not upload`,
    });
    assert.equal(closed.status, 200);
    assert.equal((await readJob()).blocked, tick === 3, `blocked after tick ${String(tick)}?`);
  }

  const stopped = await readJob();
  assert.ok((stopped.block_reason ?? '').includes('implement'), 'the existing streak reason');
});
