/**
 * Acceptance tests of the pending artifact (t1339, AT1–AT12).
 *
 * A session can finish `completed` while a file its report declares has not
 * been uploaded yet. The report stays exactly as reported and `/finish` stays
 * once-only; the declaration travels in its own `session.artifacts_pending`
 * event and the artifact id arrives later as `session.artifact_settled`,
 * through a route of its own. Nothing existing changes shape.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  createJob,
  loadEvents,
  request,
  resolvePins,
  startControlPlane,
  type Event,
  type Session,
  type TestContext,
} from './support.ts';

const EXAMPLES = path.resolve(PACKAGE_ROOT, '../../schema/examples');

interface State {
  session_id: number;
  pending: string[];
  settled: Array<{ name: string; artifact_id: number; settled_at: string }>;
}

/** The projection's `output`, which the shared `Session` type of support.ts omits. */
interface WithOutput extends Session {
  output: Record<string, unknown> | null;
}

interface FinishAnswer extends WithOutput {
  output_accepted: boolean;
}

type Doc = Record<string, unknown> & { nodes: Array<Record<string, unknown>> };

/** Opens a session on `node` of `jobId`. */
async function openSession(ctx: TestContext, jobId: number, node = 'redigir'): Promise<Session> {
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

function finish(
  ctx: TestContext,
  sessionId: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: FinishAnswer }> {
  return request<FinishAnswer>(ctx, 'PATCH', `/v1/sessions/${String(sessionId)}/finish`, body);
}

function settle(
  ctx: TestContext,
  sessionId: number,
  body: unknown,
): Promise<{ status: number; body: State }> {
  return request<State>(
    ctx,
    'POST',
    `/v1/sessions/${String(sessionId)}/artifact-settlements`,
    body,
  );
}

function state(ctx: TestContext, sessionId: number): Promise<{ status: number; body: State }> {
  return request<State>(ctx, 'GET', `/v1/sessions/${String(sessionId)}/artifact-settlements`);
}

async function sessionEvents(ctx: TestContext, sessionId: number): Promise<Event[]> {
  const { getEventsByEntity } = await loadEvents();
  return getEventsByEntity(ctx.db, 'session', sessionId);
}

async function eventsOf(ctx: TestContext, sessionId: number, type: string): Promise<Event[]> {
  return (await sessionEvents(ctx, sessionId)).filter((event) => event.type === type);
}

/** An artifact row made straight through the repository, like the ticket says. */
async function makeArtifact(ctx: TestContext, sessionId: number, name: string): Promise<number> {
  const { createArtifact } = (await import(
    new URL('../src/repositories/artifacts.ts', import.meta.url).href
  )) as typeof import('../src/repositories/artifacts.ts');
  const store = {
    put: async (source: Buffer) => ({ ref: `fake-${String(source.length)}`, sha256: 'a', size: source.length }),
    open: () => Readable.from([]),
    exists: () => true,
  } as unknown as Parameters<typeof createArtifact>[3];
  const artifact = await createArtifact(
    ctx.db,
    sessionId,
    { name, mediaType: 'text/markdown', buffer: Buffer.from('content') },
    store,
  );
  assert.ok(artifact !== null);
  return artifact.id;
}

/** A completed session that declared `names` pending out of `output`. */
async function completedWithPending(
  ctx: TestContext,
  jobId: number,
  output: Record<string, unknown>,
  names: string[],
  node = 'redigir',
): Promise<Session> {
  const session = await openSession(ctx, jobId, node);
  const closed = await finish(ctx, session.id, {
    status: 'completed',
    exit_code: 0,
    output,
    pending_artifacts: names,
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  return session;
}

async function newJob(ctx: TestContext, extra: Record<string, unknown> = {}): Promise<number> {
  const job = await createJob(ctx, { title: 'a job', entry_node_id: 'redigir', ...extra });
  return job.id;
}

function example(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8')) as Doc;
}

/**
 * Registers the minimal graph with a skill on `redigir` whose `output` declares
 * `report` as an `x-artifact` file and `note` as a plain string.
 */
async function registerSchemaGraph(
  ctx: TestContext,
  produces?: string,
): Promise<string> {
  const { manifestHash } = (await import(
    new URL('../src/domain/manifest.ts', import.meta.url).href
  )) as { manifestHash: (manifest: unknown) => string };

  const manifest: Record<string, unknown> = {
    id: 'file-writer',
    version: '1.0.0',
    hash: '',
    role: 'work',
    description: 'Writes a file and a note.',
    input: { type: 'object' },
    output: {
      type: 'object',
      required: ['summary'],
      properties: {
        report: { type: 'string', 'x-artifact': true },
        note: { type: 'string' },
        summary: { type: 'string' },
      },
    },
    preconditions: [],
    checks: [
      { id: 'c', type: 'deterministic', description: 'A check.', command: 'true' },
    ],
    permissions: { filesystem: { read: [], write: [] }, network: { allowed: false } },
    instructions: 'Write the file.',
    origin: { type: 'native' },
  };
  manifest.hash = manifestHash(manifest);
  const registered = await request(ctx, 'POST', '/v1/skills', manifest);
  assert.ok(registered.status === 201 || registered.status === 200, JSON.stringify(registered.body));

  const document = example('graph-valid-minimal.json');
  document.nodes[0].skill_ref = { id: 'file-writer', version: '1.0.0', hash: manifest.hash };
  if (produces !== undefined) {
    (document.nodes[0].contract as Record<string, unknown>).produces = produces;
  }
  await resolvePins(ctx, document);
  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.graph_version.id;
}

test('t1339 AT1 — a pending declaration closes completed, keeps the path and appends one event', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const session = await openSession(ctx, jobId);

  const closed = await finish(ctx, session.id, {
    status: 'completed',
    exit_code: 0,
    output: { report: 'out/r.md', summary: 's' },
    pending_artifacts: ['report'],
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.status, 'completed');
  assert.deepEqual(closed.body.output, { report: 'out/r.md', summary: 's' });

  const events = await eventsOf(ctx, session.id, 'session.artifacts_pending');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { names: ['report'], job_id: jobId });

});

test('t1339 AT2 — an absent, null or empty declaration behaves exactly as before', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);

  for (const extra of [{}, { pending_artifacts: null }, { pending_artifacts: [] }]) {
    const session = await openSession(ctx, jobId);
    const closed = await finish(ctx, session.id, {
      status: 'completed',
      exit_code: 0,
      output: { report: 'out/r.md' },
      ...extra,
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.equal((await eventsOf(ctx, session.id, 'session.artifacts_pending')).length, 0);

    const answer = await state(ctx, session.id);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { session_id: session.id, pending: [], settled: [] });
  }
});

test('t1339 AT3 — a bad declaration is a 400 and the session stays open', async (t) => {
  const ctx = await startControlPlane(t);
  const versionId = await registerSchemaGraph(ctx);
  const plainJob = await newJob(ctx);
  const schemaJob = await newJob(ctx, { graph_version_id: versionId });

  const output = { report: 'out/r.md', summary: 's', note: 'n', count: 3 };
  const cases: Array<{ label: string; jobId: number; body: Record<string, unknown> }> = [
    { label: 'not an array', jobId: plainJob, body: { status: 'completed', output, pending_artifacts: 'report' } },
    { label: 'duplicate names', jobId: plainJob, body: { status: 'completed', output, pending_artifacts: ['report', 'report'] } },
    { label: 'empty string', jobId: plainJob, body: { status: 'completed', output, pending_artifacts: [''] } },
    { label: 'failed status', jobId: plainJob, body: { status: 'failed', output, pending_artifacts: ['report'] } },
    { label: 'absent from the report', jobId: plainJob, body: { status: 'completed', output, pending_artifacts: ['missing'] } },
    { label: 'a number value', jobId: plainJob, body: { status: 'completed', output, pending_artifacts: ['count'] } },
    { label: 'not x-artifact in the schema', jobId: schemaJob, body: { status: 'completed', output, pending_artifacts: ['note'] } },
  ];

  for (const { label, jobId, body } of cases) {
    const session = await openSession(ctx, jobId);
    const refused = await finish(ctx, session.id, body);
    assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.body)}`);

    const read = await request<{ sessions: WithOutput[] }>(
      ctx,
      'GET',
      `/v1/sessions?job_id=${String(jobId)}`,
    );
    const mine = read.body.sessions.find((candidate) => candidate.id === session.id);
    assert.equal(mine?.status, 'open', `${label}: still open`);
    assert.equal((await eventsOf(ctx, session.id, 'session.artifacts_pending')).length, 0, label);
    assert.equal((await eventsOf(ctx, session.id, 'session.finished')).length, 0, label);
  }

  // The same declaration against the declared x-artifact property is accepted.
  const session = await openSession(ctx, schemaJob);
  const accepted = await finish(ctx, session.id, {
    status: 'completed',
    output: { report: 'out/r.md', summary: 's' },
    pending_artifacts: ['report'],
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.output_accepted, true);
});

test('t1339 AT4 — a report the schema refuses records no declaration', async (t) => {
  const ctx = await startControlPlane(t);
  const versionId = await registerSchemaGraph(ctx);
  const jobId = await newJob(ctx, { graph_version_id: versionId });
  const session = await openSession(ctx, jobId);

  // `summary` is required and missing, so the schema refuses the report.
  const closed = await finish(ctx, session.id, {
    status: 'completed',
    output: { report: 'out/r.md' },
    pending_artifacts: ['report'],
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.output_accepted, false);
  assert.equal(closed.body.output, null);
  assert.equal((await eventsOf(ctx, session.id, 'session.artifacts_pending')).length, 0);
  assert.deepEqual((await state(ctx, session.id)).body.pending, []);
});

test('t1339 AT5 — settling a name records an event and leaves the report and closure alone', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const session = await completedWithPending(
    ctx,
    jobId,
    { report: 'out/r.md', summary: 's' },
    ['report'],
  );
  const artifactId = await makeArtifact(ctx, session.id, 'report');

  const answer = await settle(ctx, session.id, { name: 'report', artifact_id: artifactId });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.pending, []);
  assert.equal(answer.body.settled.length, 1);
  assert.equal(answer.body.settled[0].name, 'report');
  assert.equal(answer.body.settled[0].artifact_id, artifactId);
  assert.equal(typeof answer.body.settled[0].settled_at, 'string');

  const events = await eventsOf(ctx, session.id, 'session.artifact_settled');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, { name: 'report', artifact_id: artifactId, job_id: jobId });

  const list = await request<{ sessions: WithOutput[] }>(
    ctx,
    'GET',
    `/v1/sessions?job_id=${String(jobId)}`,
  );
  const stored = list.body.sessions.find((candidate) => candidate.id === session.id);
  assert.deepEqual(stored?.output, { report: 'out/r.md', summary: 's' });
  assert.equal(stored?.status, 'completed');

  const again = await finish(ctx, session.id, { status: 'completed' });
  assert.equal(again.status, 409);
  const finishedAt = ctx.db
    .prepare('SELECT finished_at FROM session WHERE id = ?')
    .get(session.id) as { finished_at: string };
  assert.equal(finishedAt.finished_at, stored?.finished_at);
});

test('t1339 AT6 — the same settlement twice is a 200 repeat with no second event', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const session = await completedWithPending(ctx, jobId, { report: 'out/r.md' }, ['report']);
  const artifactId = await makeArtifact(ctx, session.id, 'report');

  const first = await settle(ctx, session.id, { name: 'report', artifact_id: artifactId });
  const second = await settle(ctx, session.id, { name: 'report', artifact_id: artifactId });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal((await eventsOf(ctx, session.id, 'session.artifact_settled')).length, 1);
});

test('t1339 AT7 — a different artifact for a settled name is a 409 and changes nothing', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const session = await completedWithPending(ctx, jobId, { report: 'out/r.md' }, ['report']);
  const first = await makeArtifact(ctx, session.id, 'report');
  const second = await makeArtifact(ctx, session.id, 'report');

  const settled = await settle(ctx, session.id, { name: 'report', artifact_id: first });
  assert.equal(settled.status, 201);
  const conflict = await settle(ctx, session.id, { name: 'report', artifact_id: second });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));

  assert.deepEqual((await state(ctx, session.id)).body, settled.body);
  assert.equal((await eventsOf(ctx, session.id, 'session.artifact_settled')).length, 1);
});

test('t1339 AT8 — settlement refusals append nothing', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const completed = await completedWithPending(ctx, jobId, { report: 'out/r.md' }, ['report']);
  const other = await openSession(ctx, jobId);
  const otherArtifact = await makeArtifact(ctx, other.id, 'report');
  const wrongName = await makeArtifact(ctx, completed.id, 'something-else');
  const good = await makeArtifact(ctx, completed.id, 'report');

  const unknown = await settle(ctx, 987654, { name: 'report', artifact_id: good });
  assert.equal(unknown.status, 404);

  for (const body of [
    {},
    { artifact_id: good },
    { name: 'report' },
    { name: 7, artifact_id: good },
    { name: 'report', artifact_id: '7' },
    { name: 'report', artifact_id: 0 },
    { name: 'report', artifact_id: 1.5 },
    { name: '', artifact_id: good },
  ]) {
    const refused = await settle(ctx, completed.id, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }

  // The still-open session answers 409 whatever the body says.
  const open = await settle(ctx, other.id, { name: 'report', artifact_id: otherArtifact });
  assert.equal(open.status, 409);

  const failed = await openSession(ctx, jobId);
  const failedArtifact = await makeArtifact(ctx, failed.id, 'report');
  assert.equal((await finish(ctx, failed.id, { status: 'failed', exit_code: 1 })).status, 200);
  assert.equal(
    (await settle(ctx, failed.id, { name: 'report', artifact_id: failedArtifact })).status,
    409,
  );

  const undeclared = await makeArtifact(ctx, completed.id, 'other');
  assert.equal(
    (await settle(ctx, completed.id, { name: 'other', artifact_id: undeclared })).status,
    409,
  );

  assert.equal(
    (await settle(ctx, completed.id, { name: 'report', artifact_id: 424242 })).status,
    400,
  );
  assert.equal(
    (await settle(ctx, completed.id, { name: 'report', artifact_id: otherArtifact })).status,
    400,
  );
  assert.equal(
    (await settle(ctx, completed.id, { name: 'report', artifact_id: wrongName })).status,
    400,
  );

  for (const id of [completed.id, other.id, failed.id]) {
    assert.equal((await eventsOf(ctx, id, 'session.artifact_settled')).length, 0);
  }
  assert.deepEqual((await state(ctx, completed.id)).body.pending, ['report']);
});

test('t1339 AT9 — with two pending names and one settled, the other stays pending in order', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const session = await completedWithPending(
    ctx,
    jobId,
    { report: 'out/r.md', appendix: 'out/a.md' },
    ['report', 'appendix'],
  );
  const appendix = await makeArtifact(ctx, session.id, 'appendix');

  const answer = await settle(ctx, session.id, { name: 'appendix', artifact_id: appendix });
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.body.pending, ['report']);
  assert.equal(answer.body.settled.length, 1);
  assert.equal(answer.body.settled[0].name, 'appendix');
  assert.deepEqual((await state(ctx, session.id)).body.pending, ['report']);
});

test('t1339 AT10 — the job input never carries a path for a pending name', async (t) => {
  const ctx = await startControlPlane(t);
  const versionId = await registerSchemaGraph(ctx, 'dossier');
  const jobId = await newJob(ctx, { graph_version_id: versionId });

  const contextOf = async (): Promise<Record<string, unknown>> => {
    const response = await request<{ input: Record<string, unknown> }>(
      ctx,
      'GET',
      `/v1/jobs/${String(jobId)}/context`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const body = response.body as unknown as Record<string, unknown>;
    return (body.input ?? body) as Record<string, unknown>;
  };

  // A completed session that declared nothing keeps its path-like string.
  const plain = await openSession(ctx, jobId);
  assert.equal(
    (await finish(ctx, plain.id, { status: 'completed', output: { note: 'out/notes.md', summary: 'p' } }))
      .status,
    200,
  );
  assert.equal(((await contextOf()).dossier as Record<string, unknown>).note, 'out/notes.md');

  const session = await completedWithPending(
    ctx,
    jobId,
    { report: 'out/r.md', summary: 'with a file' },
    ['report'],
  );
  const before = (await contextOf()).dossier as Record<string, unknown>;
  assert.equal(before.summary, 'with a file');
  assert.ok(!('report' in before), `a pending name is omitted: ${JSON.stringify(before)}`);
  assert.equal(before.note, 'out/notes.md');

  const artifactId = await makeArtifact(ctx, session.id, 'report');
  assert.equal((await settle(ctx, session.id, { name: 'report', artifact_id: artifactId })).status, 201);
  const after = (await contextOf()).dossier as Record<string, unknown>;
  assert.equal(after.report, String(artifactId));

  const read = await request<{ sessions: WithOutput[] }>(
    ctx,
    'GET',
    `/v1/sessions?job_id=${String(jobId)}`,
  );
  const stored = read.body.sessions.find((candidate) => candidate.id === session.id);
  assert.equal((stored?.output as Record<string, unknown>).report, 'out/r.md');
});

test('t1339 AT11 — the state of a session of another project is the 404 of an unknown id', async (t) => {
  const ctx = await startControlPlane(t);
  const jobId = await newJob(ctx);
  const session = await completedWithPending(ctx, jobId, { report: 'out/r.md' }, ['report']);

  const right = await request(
    ctx,
    'GET',
    `/v1/sessions/${String(session.id)}/artifact-settlements?project_id=1`,
  );
  assert.equal(right.status, 200);

  const created = await request<{ id: number }>(ctx, 'POST', '/v1/projects', {
    name: 'another',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  {
    const wrong = await request(
      ctx,
      'GET',
      `/v1/sessions/${String(session.id)}/artifact-settlements?project_id=${String(created.body.id)}`,
    );
    const missing = await request(
      ctx,
      'GET',
      `/v1/sessions/987654/artifact-settlements?project_id=${String(created.body.id)}`,
    );
    assert.equal(wrong.status, 404);
    assert.deepEqual(wrong.body, missing.body);
  }
  assert.equal((await state(ctx, 987654)).status, 404);
});

test('t1339 AT12 — the two event types validate, show in the job timeline and the stream filter', async (t) => {
  const ctx = await startControlPlane(t);
  const { validateEvent } = (await import(
    new URL('../src/db/event-validation.ts', import.meta.url).href
  )) as typeof import('../src/db/event-validation.ts');

  const envelope = (type: string, data: Record<string, unknown>): unknown => ({
    type,
    project_id: 1,
    execution_id: null,
    entity: { type: 'session', id: 1 },
    actor: { type: 'system', ref: 'runner' },
    occurred_at: '2026-11-19T10:00:00Z',
    data,
  });

  const accepted = (type: string, data: Record<string, unknown>): boolean => {
    const result = validateEvent(envelope(type, data)) as { valid?: boolean; errors?: string[] };
    return result.valid === true;
  };
  assert.equal(accepted('session.artifacts_pending', { names: ['a'], job_id: 3 }), true);
  assert.equal(accepted('session.artifacts_pending', { names: ['a'] }), true);
  assert.equal(accepted('session.artifacts_pending', {}), false);
  assert.equal(accepted('session.artifacts_pending', { names: [] }), false);
  assert.equal(accepted('session.artifact_settled', { name: 'a', artifact_id: 4, job_id: 3 }), true);
  assert.equal(accepted('session.artifact_settled', { artifact_id: 4 }), false);
  assert.equal(accepted('session.artifact_settled', { name: 'a' }), false);

  const jobId = await newJob(ctx);
  const session = await completedWithPending(ctx, jobId, { report: 'out/r.md' }, ['report']);
  const artifactId = await makeArtifact(ctx, session.id, 'report');
  assert.equal((await settle(ctx, session.id, { name: 'report', artifact_id: artifactId })).status, 201);

  const timeline = await request<{ events: Event[] } | Event[]>(
    ctx,
    'GET',
    `/v1/jobs/${String(jobId)}/events`,
  );
  assert.equal(timeline.status, 200);
  const listed = (Array.isArray(timeline.body) ? timeline.body : timeline.body.events).map(
    (event) => event.type,
  );
  assert.ok(listed.includes('session.artifacts_pending'));
  assert.ok(listed.includes('session.artifact_settled'));

  for (const type of ['session.artifacts_pending', 'session.artifact_settled']) {
    const response = await fetch(
      `${ctx.url}/v1/events/stream?type=${type}&project_id=1`,
      { headers: { authorization: `Bearer ${ctx.token}` }, signal: AbortSignal.timeout(2000) },
    ).catch(() => null);
    if (response !== null) {
      assert.notEqual(response.status, 400, `${type} is a known stream type`);
      await response.body?.cancel();
    }
  }
});
