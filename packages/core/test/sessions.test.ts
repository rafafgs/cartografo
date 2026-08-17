/**
 * Session acceptance tests (t102, AT8–AT10).
 *
 * The session is the run of an agent by an EngineAdapter. In flowpilot it was a
 * mutable row born `pending` and updated until `completed`; here there are two
 * events (`session.opened`, `session.finished`) and a projection — consequence 2
 * of the taxonomy's append-only rule.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T102_ARTIFACTS,
  createJob,
  loadEvents,
  requireArtifacts,
  request,
  startControlPlane,
  type Event,
  type Job,
  type Session,
  type TestContext,
} from './support.ts';

const ARTIFACTS = [
  T102_ARTIFACTS.migration,
  T102_ARTIFACTS.events,
  T102_ARTIFACTS.validation,
  T102_ARTIFACTS.sessionRepository,
  T102_ARTIFACTS.sessionRoutes,
];

/** The migration that gives the session somewhere to keep its transcript (t159). */
const T159_MIGRATION = 'migrations/0009_sessao_transcricao.sql';

/**
 * The cap, in bytes, the stored transcript may not exceed (t159, FR2).
 *
 * Restated here instead of imported from `src/`, for the same reason the
 * projections in `support.ts` are hand-written: this number IS the contract the
 * test demands, and a contract that reads itself out of the implementation
 * demands nothing.
 */
const TRANSCRIPT_CAP_BYTES = 1_048_576;

/**
 * Body of `GET /v1/sessions/:id/transcript` (t232).
 *
 * The SAME three names `PATCH /finish` already answers on the projection —
 * `transcript`, `transcript_truncated`, `transcript_original_size` — and not a
 * second spelling of the same three facts. The route came out of t226 still
 * saying `{transcricao, truncada, tamanho_original}` because it is the one
 * session payload built outside `toWireSession`, so the row → wire boundary
 * never saw it; a client that reads the transcript off `/finish` and then off
 * this route was parsing two vocabularies for one concept.
 */
interface Transcript {
  transcript: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
}

/** Opens a job-less session — what every t159 case starts from. */
async function openBareSession(ctx: TestContext): Promise<Session> {
  const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: 7,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo e conte o que aconteceu',
  });
  assert.equal(response.status, 201);
  return response.body;
}

const USAGE = {
  input_tokens: 18422,
  output_tokens: 3110,
  cache_creation_input_tokens: 9004,
  cache_read_input_tokens: 120344,
};

test('AT8 — POST /v1/sessions records session.opened and creates the open row', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    title: 'com sessão',
    entry_node_id: 'entrada',
    execution_id: 7,
  });

  const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'refinamento',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/Users/rafael/cartografo-ticket-102',
    prompt: 'Refine o trabalho 102 contra as convenções do projeto.',
    timeout_seconds: 5400,
  });

  assert.equal(response.status, 201);
  const session = response.body;
  assert.ok(Number.isInteger(session.id) && session.id >= 1);
  assert.equal(session.status, 'open');
  assert.equal(session.job_id, job.id);
  assert.equal(session.execution_id, 7, 'the execution comes from the job served');
  assert.equal(session.exit_code, null);
  assert.equal(session.usage, null);
  assert.equal(session.finished_at, null);
  assert.ok(!Number.isNaN(Date.parse(session.opened_at)));

  const events = getEventsByEntity(ctx.db, 'session', session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'session.opened');
  assert.deepEqual(events[0].entity, { type: 'session', id: session.id });
  assert.deepEqual(events[0].data, {
    job_id: job.id,
    node_id: 'refinamento',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/Users/rafael/cartografo-ticket-102',
    prompt: 'Refine o trabalho 102 contra as convenções do projeto.',
    timeout_seconds: 5400,
    // The second budget (t163). Declared by nobody here, so it normalizes to
    // null — "this session states no inactivity policy", which is what every
    // row from before the watchdog existed reads as too.
    silence_seconds: null,
  });
});

test('AT9 — PATCH /v1/sessions/:id/finish closes the session; absent usage is null, never 0', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const open = async (): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      execution_id: 7,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'faça algo',
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const withUsage = await open();
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${withUsage.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.status, 'completed');
  assert.equal(finished.body.exit_code, 0, 'zero is a success exit code, not absence');
  assert.deepEqual(finished.body.usage, USAGE);
  assert.ok(!Number.isNaN(Date.parse(finished.body.finished_at ?? '')));

  const withoutUsage = await open();
  const paused = await request<Session>(ctx, 'PATCH', `/v1/sessions/${withoutUsage.id}/finish`, {
    status: 'quota_paused',
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'quota_paused');
  assert.equal(paused.body.usage, null, 'the engine reported nothing: null');
  assert.notEqual(paused.body.usage, 0, 'never collapse absent usage into zero');
  assert.equal(paused.body.exit_code, null);

  const events = getEventsByEntity(ctx.db, 'session', withUsage.id);
  assert.deepEqual(
    events.map((event: Event) => event.type),
    ['session.opened', 'session.finished'],
  );
  // Every optional field the type declares appears normalized, with an explicit
  // `null` for what the client did not send — `models` included since t172.
  assert.deepEqual(events[1].data, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
    timeout_reason: null,
    models: null,
  });

  const withoutUsageEvents = getEventsByEntity(ctx.db, 'session', withoutUsage.id);
  assert.deepEqual(withoutUsageEvents[1].data, {
    status: 'quota_paused',
    exit_code: null,
    usage: null,
    timeout_reason: null,
    models: null,
  });
});

test('AT10 — GET /v1/sessions?execution_id=7 returns only that execution\'s sessions', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const open = async (executionId: number, prompt: string): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      execution_id: executionId,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const one = await open(7, 'da sete');
  const other = await open(7, 'também da sete');
  await open(8, 'da oito');

  const response = await request<{ sessions: Session[] }>(ctx, 'GET', '/v1/sessions?execution_id=7');
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.sessions.map((session) => session.id).sort((a, b) => a - b),
    [one.id, other.id].sort((a, b) => a - b),
  );
});

test('t127 — the old Portuguese session paths no longer exist', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const created = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: 7,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo',
  });
  assert.equal(created.status, 201);

  for (const [method, routePath] of [
    ['POST', '/v1/sessoes'],
    ['GET', '/v1/sessoes'],
    ['PATCH', `/v1/sessoes/${created.body.id}/finalizar`],
  ] as const) {
    const response = await request(
      ctx,
      method,
      routePath,
      method === 'GET' ? undefined : { status: 'completed' },
    );
    assert.equal(response.status, 404, `${method} ${routePath} should be gone (D18)`);
  }
});

test('t107 AT2 — GET /v1/sessions?job_id= slices by job inside the same execution', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);

  // Both jobs live in the SAME execution: that is what makes this test prove
  // the new filter, and not the `execucao_id` that already existed.
  const watched = await createJob(ctx, {
    title: 'o que a tela abre',
    entry_node_id: 'entrada',
    execution_id: 7,
  });
  const neighbour = await createJob(ctx, {
    title: 'o outro da mesma rodada',
    entry_node_id: 'entrada',
    execution_id: 7,
  });

  const openSessionFor = async (jobId: number, prompt: string): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      job_id: jobId,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const first = await openSessionFor(watched.id, 'primeira passada');
  const second = await openSessionFor(watched.id, 'segunda passada');
  const neighbours = await openSessionFor(neighbour.id, 'do vizinho');

  const response = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?job_id=${watched.id}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.sessions.map((item) => item.id),
    [first.id, second.id],
    'only the sessions of the requested job, in id order',
  );
  assert.ok(
    !response.body.sessions.some((item) => item.id === neighbours.id),
    "the neighbour's session shares the execution, but not the job",
  );

  const combined = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execution_id=7&job_id=${watched.id}`,
  );
  assert.equal(combined.status, 200);
  assert.deepEqual(
    combined.body.sessions.map((item) => item.id),
    [first.id, second.id],
    'the two filters together are AND',
  );

  const mismatched = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execution_id=8&job_id=${watched.id}`,
  );
  assert.deepEqual(mismatched.body.sessions, [], 'AND, not OR');

  const invalid = await request(ctx, 'GET', '/v1/sessions?job_id=abc');
  assert.equal(invalid.status, 400, 'an invalid filter is 400, never a silently ignored filter');
});

test('t125 — POST /v1/sessions/:id/permission-denials records the denial without ending the session', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    title: 'com skill de terceiro',
    entry_node_id: 'entrada',
    execution_id: 9,
  });

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo sem rede',
  });
  assert.equal(opened.status, 201);
  const session = opened.body;

  const denied = await request<Session>(
    ctx,
    'POST',
    `/v1/sessions/${session.id}/permission-denials`,
    {
      resource: 'network',
      tool: 'WebFetch',
      reason: 'Claude requested permissions to use WebFetch, but you have not granted it.',
    },
  );

  assert.equal(denied.status, 200);
  // A denial is an incident, not a terminal state: the row does not move.
  assert.equal(denied.body.status, 'open');
  assert.equal(denied.body.finished_at, null);
  assert.equal(denied.body.exit_code, null);

  const events = getEventsByEntity(ctx.db, 'session', session.id);
  assert.deepEqual(
    events.map((event: Event) => event.type),
    ['session.opened', 'session.permission_denied'],
  );
  assert.deepEqual(events[1].entity, { type: 'session', id: session.id });
  assert.deepEqual(events[1].actor, { type: 'system', ref: 'runner' });
  assert.equal(events[1].execution_id, 9, 'the denial belongs to the round the session serves');
  assert.deepEqual(events[1].data, {
    resource: 'network',
    tool: 'WebFetch',
    reason: 'Claude requested permissions to use WebFetch, but you have not granted it.',
  });

  // The same session can be denied more than once: the log is append-only and
  // nothing about the first denial closes the door on the second.
  const again = await request<Session>(
    ctx,
    'POST',
    `/v1/sessions/${session.id}/permission-denials`,
    { resource: 'filesystem', tool: 'Write', reason: 'write scope is empty for this skill' },
  );
  assert.equal(again.status, 200);
  assert.equal(getEventsByEntity(ctx.db, 'session', session.id).length, 3);
});

/**
 * The project a job-less session declares when it opens (t157, FR3/FR4).
 *
 * Deliberately different from `DEFAULT_PROJECT` (1, `repositories/common.ts`):
 * with the two equal, the bug this test exists for — falling back to the
 * default because the `trabalho` join found nothing — would pass unnoticed.
 */
const OTHER_PROJECT = 42;

test('t157 — a job-less session keeps its own project at finish and at denial', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const open = async (): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      project_id: OTHER_PROJECT,
      execution_id: 7,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'uma sessão de descoberta, sem trabalho dono',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.job_id, null, 'the case under test is the job-less session');
    return response.body;
  };

  const closed = await open();
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${closed.id}/finish`, {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(finished.status, 200);

  const closedEvents = getEventsByEntity(ctx.db, 'session', closed.id);
  assert.deepEqual(
    closedEvents.map((event: Event) => event.type),
    ['session.opened', 'session.finished'],
  );
  assert.equal(
    closedEvents[0].project_id,
    OTHER_PROJECT,
    'control: the opening already recorded the declared project',
  );
  assert.equal(
    closedEvents[1].project_id,
    OTHER_PROJECT,
    'the end belongs to the same project as the opening, not to DEFAULT_PROJECT',
  );

  const denied = await open();
  const denial = await request<Session>(
    ctx,
    'POST',
    `/v1/sessions/${denied.id}/permission-denials`,
    { resource: 'network', tool: 'WebFetch', reason: 'sem rede nesta sessão' },
  );
  assert.equal(denial.status, 200);

  const deniedEvents = getEventsByEntity(ctx.db, 'session', denied.id);
  assert.deepEqual(
    deniedEvents.map((event: Event) => event.type),
    ['session.opened', 'session.permission_denied'],
  );
  assert.equal(
    deniedEvents[1].project_id,
    OTHER_PROJECT,
    'the denial is attributed the same way the end is',
  );
});

test('t157 — a session that serves a job is still attributed to the job\'s project', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    title: 'de outro projeto',
    entry_node_id: 'entrada',
    project_id: OTHER_PROJECT,
    execution_id: 9,
  });

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    // Deliberately contradicting the job: the owner's project is the one that
    // holds, at the opening and at every event after it.
    project_id: 999,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo pelo trabalho',
  });
  assert.equal(opened.status, 201);

  const finished = await request<Session>(
    ctx,
    'PATCH',
    `/v1/sessions/${opened.body.id}/finish`,
    { status: 'completed', exit_code: 0 },
  );
  assert.equal(finished.status, 200);

  const events = getEventsByEntity(ctx.db, 'session', opened.body.id);
  assert.deepEqual(
    events.map((event: Event) => event.project_id),
    [OTHER_PROJECT, OTHER_PROJECT],
    'the job owns the project, and the end says the same thing the opening said',
  );
});

test('t149 AT5 — finishing an already finished session is a 409, and the first end stands', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: 7,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo',
  });
  assert.equal(opened.status, 201);
  const session = opened.body;

  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
  });
  assert.equal(finished.status, 200);

  // The retry carries a DIFFERENT ending and no usage at all: if it went
  // through, the only cost record the PoC keeps would be gone.
  const retry = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/sessions/${session.id}/finish`,
    { status: 'failed', exit_code: 1 },
  );
  assert.equal(retry.status, 409, 'a session ends once');
  assert.equal(retry.body.error, 'conflict');
  assert.ok(
    retry.body.details.some((detail) => detail.includes('completed')),
    `the 409 has to say what state refused it: ${JSON.stringify(retry.body.details)}`,
  );

  const listed = await request<{ sessions: Session[] }>(ctx, 'GET', '/v1/sessions?execution_id=7');
  assert.equal(listed.status, 200);
  const stored = listed.body.sessions.find((item) => item.id === session.id);
  assert.ok(stored !== undefined, 'the session disappeared from the listing');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.exit_code, 0);
  assert.deepEqual(stored.usage, USAGE, 'the refused retry never NULLs the usage of the first end');
  assert.equal(stored.finished_at, finished.body.finished_at);

  const events = getEventsByEntity(ctx.db, 'session', session.id);
  assert.deepEqual(
    events.map((event: Event) => event.type),
    ['session.opened', 'session.finished'],
    'the refused retry writes NOTHING: no second end in the log',
  );
});

test('t149 AT6 — finishing a session that does not exist is still a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const unknown = await request<{ error: string }>(ctx, 'PATCH', '/v1/sessions/98765/finish', {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(unknown.status, 404, 'reading before writing did not turn a 404 into a 409');
  assert.equal(unknown.body.error, 'not_found');
});

test('t125 — a denial outside the contract is a 400, and an unknown session a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: 9,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo',
  });
  assert.equal(opened.status, 201);

  const outsideEnum = await request<{ error: string; details: string[] }>(
    ctx,
    'POST',
    `/v1/sessions/${opened.body.id}/permission-denials`,
    { resource: 'memoria', tool: 'WebFetch', reason: 'inventado' },
  );
  assert.equal(outsideEnum.status, 400);
  assert.equal(outsideEnum.body.error, 'validation_failed');
  assert.ok(
    outsideEnum.body.details.some((detail) => detail.includes('resource')),
    `the 400 has to name the offending field: ${JSON.stringify(outsideEnum.body.details)}`,
  );

  const missingField = await request(
    ctx,
    'POST',
    `/v1/sessions/${opened.body.id}/permission-denials`,
    { resource: 'network' },
  );
  assert.equal(missingField.status, 400, 'tool and reason are required');

  const unknown = await request(ctx, 'POST', '/v1/sessions/98765/permission-denials', {
    resource: 'network',
    tool: 'WebFetch',
    reason: 'a sessão não existe',
  });
  assert.equal(unknown.status, 404);
});

test('t159 AT1 — a small transcript is stored verbatim, and the projection and the route agree', async (t) => {
  requireArtifacts(...ARTIFACTS, T159_MIGRATION);
  const ctx = await startControlPlane(t);

  const session = await openBareSession(ctx);

  // With an accent in it on purpose: what is reported is the size in BYTES, and
  // an all-ASCII sample would let a character count pass as one.
  const output = 'lendo a ficha…\nerro: não achei o arquivo\nsaindo com 1\n';
  const bytes = Buffer.byteLength(output, 'utf8');
  assert.notEqual(bytes, output.length, 'the sample has to be multi-byte to prove anything');

  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'failed',
    exit_code: 1,
    transcript: output,
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.transcript, output, 'stored verbatim, byte for byte');
  assert.equal(finished.body.transcript_truncated, false);
  assert.equal(finished.body.transcript_original_size, bytes);

  const read = await request<Transcript>(ctx, 'GET', `/v1/sessions/${session.id}/transcript`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    transcript: output,
    transcript_truncated: false,
    transcript_original_size: bytes,
  });
});

test('t159 AT2 — a transcript past the cap keeps the TAIL and reports the size it had before', async (t) => {
  requireArtifacts(...ARTIFACTS, T159_MIGRATION);
  const ctx = await startControlPlane(t);

  const session = await openBareSession(ctx);

  // ASCII, so byte length and character length coincide and the arithmetic
  // below is the test's own, not the implementation's.
  const tail = '\nfatal: o engine morreu aqui, e ISTO precisa sobreviver\n';
  const output = 'x'.repeat(TRANSCRIPT_CAP_BYTES) + tail;
  assert.equal(Buffer.byteLength(output, 'utf8'), output.length, 'the sample has to be ASCII');

  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'failed',
    exit_code: 1,
    transcript: output,
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.transcript_truncated, true, 'truncation is never silent');
  assert.equal(
    finished.body.transcript_original_size,
    output.length,
    'the reported size is the one BEFORE the cap',
  );
  assert.notEqual(
    finished.body.transcript_original_size,
    TRANSCRIPT_CAP_BYTES,
    'reporting the capped length would erase how much was lost',
  );

  const stored = finished.body.transcript ?? '';
  assert.equal(Buffer.byteLength(stored, 'utf8'), TRANSCRIPT_CAP_BYTES, 'exactly the cap');
  assert.equal(stored, output.slice(-TRANSCRIPT_CAP_BYTES), 'the TAIL, not the head');
  assert.ok(stored.endsWith(tail), "a crash's evidence is at the end of the stream");

  const read = await request<Transcript>(ctx, 'GET', `/v1/sessions/${session.id}/transcript`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, {
    transcript: stored,
    transcript_truncated: true,
    transcript_original_size: output.length,
  });
});

test('t159 — the cap cuts on a character boundary, never in the middle of a rune', async (t) => {
  requireArtifacts(...ARTIFACTS, T159_MIGRATION);
  const ctx = await startControlPlane(t);

  const session = await openBareSession(ctx);

  // Three bytes per character, and the cap is not a multiple of three: the byte
  // the tail would start at falls INSIDE a character. Cutting there and
  // decoding anyway produces a `U+FFFD` nobody printed.
  const rune = '☂';
  const output = rune.repeat(400_000);
  assert.ok(Buffer.byteLength(output, 'utf8') > TRANSCRIPT_CAP_BYTES);

  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'failed',
    exit_code: 1,
    transcript: output,
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.transcript_truncated, true);
  assert.equal(finished.body.transcript_original_size, Buffer.byteLength(output, 'utf8'));

  const stored = finished.body.transcript ?? '';
  const storedBytes = Buffer.byteLength(stored, 'utf8');
  assert.ok(storedBytes <= TRANSCRIPT_CAP_BYTES, `${storedBytes} bytes is over the cap`);
  assert.ok(
    storedBytes > TRANSCRIPT_CAP_BYTES - rune.length * 3,
    'dropping the broken head may cost at most one character',
  );
  assert.ok(!stored.includes('�'), 'no replacement character the engine never printed');
  assert.equal(new Set(stored).size, 1, 'every character survived whole');
});

test('t159 AT3 — an absent transcript is null, never an empty string; an empty one is kept', async (t) => {
  requireArtifacts(...ARTIFACTS, T159_MIGRATION);
  const ctx = await startControlPlane(t);

  const silent = await openBareSession(ctx);
  const withoutTranscript = await request<Session>(
    ctx,
    'PATCH',
    `/v1/sessions/${silent.id}/finish`,
    { status: 'quota_paused' },
  );
  assert.equal(withoutTranscript.status, 200);
  assert.equal(withoutTranscript.body.transcript, null, 'nothing was reported: null');
  assert.notEqual(withoutTranscript.body.transcript, '', 'absence never collapses into empty');
  assert.equal(withoutTranscript.body.transcript_truncated, false);
  assert.equal(withoutTranscript.body.transcript_original_size, null);

  const absent = await request<Transcript>(ctx, 'GET', `/v1/sessions/${silent.id}/transcript`);
  assert.equal(absent.status, 200, 'a session with no transcript is an answer, not a 404');
  assert.deepEqual(absent.body, {
    transcript: null,
    transcript_truncated: false,
    transcript_original_size: null,
  });

  // A session still open has never recorded one either, and reads back the same.
  const open = await openBareSession(ctx);
  const stillOpen = await request<Transcript>(ctx, 'GET', `/v1/sessions/${open.id}/transcript`);
  assert.equal(stillOpen.status, 200);
  assert.deepEqual(stillOpen.body, {
    transcript: null,
    transcript_truncated: false,
    transcript_original_size: null,
  });

  // An explicit empty string is a MEASUREMENT — "this session printed nothing" —
  // and is a different fact from "nobody reported anything".
  const quiet = await openBareSession(ctx);
  const empty = await request<Session>(ctx, 'PATCH', `/v1/sessions/${quiet.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    transcript: '',
  });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.transcript, '', 'an empty transcript is stored as given');
  assert.equal(empty.body.transcript_truncated, false);
  assert.equal(empty.body.transcript_original_size, 0);

  const readEmpty = await request<Transcript>(ctx, 'GET', `/v1/sessions/${quiet.id}/transcript`);
  assert.deepEqual(readEmpty.body, {
    transcript: '',
    transcript_truncated: false,
    transcript_original_size: 0,
  });

  // Anything that is not a string is a 400, the same shape a malformed `usage` gets.
  const wrongType = await openBareSession(ctx);
  const refused = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/sessions/${wrongType.id}/finish`,
    { status: 'completed', exit_code: 0, transcript: 42 },
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'validation_failed');
  assert.ok(
    refused.body.details.some((detail) => detail.includes('transcript')),
    `the 400 has to name the offending field: ${JSON.stringify(refused.body.details)}`,
  );

  // ...and the refusal wrote nothing: the session is still open, still finishable.
  const stillFinishable = await request<Session>(
    ctx,
    'PATCH',
    `/v1/sessions/${wrongType.id}/finish`,
    { status: 'completed', exit_code: 0 },
  );
  assert.equal(stillFinishable.status, 200);
});

test('t159 AT4 — the transcript of a session that does not exist is a 404', async (t) => {
  requireArtifacts(...ARTIFACTS, T159_MIGRATION);
  const ctx = await startControlPlane(t);

  const unknown = await request<{ error: string }>(ctx, 'GET', '/v1/sessions/98765/transcript');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');
});

test('t159 AT5 — the transcript stays OUT of the session.finished event', async (t) => {
  requireArtifacts(...ARTIFACTS, T159_MIGRATION);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const session = await openBareSession(ctx);
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
    transcript: 'a saída inteira da sessão, que o log NÃO carrega',
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.transcript, 'a saída inteira da sessão, que o log NÃO carrega');

  const events = getEventsByEntity(ctx.db, 'session', session.id);
  assert.deepEqual(
    events.map((event: Event) => event.type),
    ['session.opened', 'session.finished'],
  );
  // Raw diagnostic material hangs off the projection, not off the append-only
  // envelope: `dados` carries the contract's own fields and nothing else —
  // which since t172 includes `models`, normalized to null like every other
  // optional field the caller did not send.
  assert.deepEqual(events[1].data, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
    timeout_reason: null,
    models: null,
  });
  assert.ok(
    !JSON.stringify(events[1]).includes('transcript'),
    'no corner of the event carries the transcript',
  );
});

/** The migration that gives the session its second budget and the cause (t163). */
const T163_MIGRATION = 'migrations/0011_sessao_orcamento_silencio.sql';

test('t163 — POST /v1/sessions persists and returns the silence budget', async (t) => {
  requireArtifacts(...ARTIFACTS, T163_MIGRATION);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: 163,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe e vá falando',
    timeout_seconds: 5400,
    silence_seconds: 900,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.timeout_seconds, 5400);
  assert.equal(
    response.body.silence_seconds,
    900,
    'the two budgets are independent, and both live on the session record',
  );
  assert.equal(
    response.body.timeout_reason,
    null,
    'a session that is still open ran no watchdog out',
  );

  const events = getEventsByEntity(ctx.db, 'session', response.body.id);
  assert.equal(events[0].data.silence_seconds, 900);
});

test('t163 — a session with no declared budget reads back as null, never as zero', async (t) => {
  requireArtifacts(...ARTIFACTS, T163_MIGRATION);
  const ctx = await startControlPlane(t);

  const session = await openBareSession(ctx);
  assert.equal(session.silence_seconds, null);
  assert.notEqual(
    session.silence_seconds,
    0,
    'absence of a policy is not a budget of zero seconds — the same discipline `usage` has',
  );
});

test('t163 — PATCH /finish persists the cause of a watchdog stop', async (t) => {
  requireArtifacts(...ARTIFACTS, T163_MIGRATION);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const session = await openBareSession(ctx);
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'timed_out',
    exit_code: null,
    timeout_reason: 'silence',
  });

  assert.equal(finished.status, 200);
  assert.equal(
    finished.body.status,
    'timed_out',
    'silence does not get a status of its own; it gets a cause',
  );
  assert.equal(finished.body.timeout_reason, 'silence');

  const events = getEventsByEntity(ctx.db, 'session', session.id);
  assert.equal(events[1].data.timeout_reason, 'silence');

  // ...and the other cause reads back just as plainly.
  const other = await openBareSession(ctx);
  const byClock = await request<Session>(ctx, 'PATCH', `/v1/sessions/${other.id}/finish`, {
    status: 'timed_out',
    timeout_reason: 'wall_clock',
  });
  assert.equal(byClock.body.timeout_reason, 'wall_clock');

  const refused = await request(ctx, 'PATCH', `/v1/sessions/${(await openBareSession(ctx)).id}/finish`, {
    status: 'timed_out',
    timeout_reason: 'stuck',
  });
  assert.equal(refused.status, 400, 'a cause outside the two is a 400, never a stored string');
});

test('t163 — GET /v1/sessions surfaces both new fields on the projection', async (t) => {
  requireArtifacts(...ARTIFACTS, T163_MIGRATION);
  const ctx = await startControlPlane(t);

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: 1631,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe e cale-se',
    silence_seconds: 300,
  });
  assert.equal(opened.status, 201);
  await request<Session>(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'timed_out',
    timeout_reason: 'silence',
  });

  const listed = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    '/v1/sessions?execution_id=1631',
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].silence_seconds, 300);
  assert.equal(listed.body.sessions[0].timeout_reason, 'silence');
});

/* -------------------------------------------------------------------------- */
/* t172 — which models ran the session, and what they cost in tokens.         */
/* -------------------------------------------------------------------------- */

/** The migration that gives the session somewhere to record its models (t172). */
const T172_MIGRATION = 'migrations/0013_sessao_modelos.sql';

/** What a real `claude` run reported: two models on one single-turn session. */
const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];

test('t172 — models round-trips through the projection; absent reads null, never []', async (t) => {
  requireArtifacts(...ARTIFACTS, T172_MIGRATION);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const reported = await openBareSession(ctx);
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${reported.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
    models: MODELS,
  });
  assert.equal(finished.status, 200);
  assert.deepEqual(finished.body.models, MODELS, 'the single-session projection carries it');

  const silent = await openBareSession(ctx);
  const withoutModels = await request<Session>(ctx, 'PATCH', `/v1/sessions/${silent.id}/finish`, {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(withoutModels.status, 200);
  assert.equal(
    withoutModels.body.models,
    null,
    'the engine named no model: null, and never an empty list',
  );
  assert.notDeepEqual(
    withoutModels.body.models,
    [],
    '[] would read as "it ran under zero models", which is a claim nobody measured',
  );
  assert.equal(withoutModels.body.usage, null, 'and the same discipline `usage` already had');

  const listed = await request<{ sessions: Session[] }>(ctx, 'GET', '/v1/sessions?execution_id=7');
  assert.equal(listed.status, 200);
  const byId = new Map(listed.body.sessions.map((session) => [session.id, session]));
  assert.deepEqual(byId.get(reported.id)?.models, MODELS, 'and the listing carries it too');
  assert.equal(byId.get(silent.id)?.models, null);

  // The log is where the fact lives; the row is a projection of it (t102).
  const events = getEventsByEntity(ctx.db, 'session', reported.id);
  assert.deepEqual(events[1].data, {
    status: 'completed',
    exit_code: 0,
    usage: USAGE,
    timeout_reason: null,
    models: MODELS,
  });
  assert.deepEqual(
    getEventsByEntity(ctx.db, 'session', silent.id)[1].data.models,
    null,
    'the normalized payload says the absence out loud, as it does for every optional field',
  );
});

test('t172 — a models that is not a list of non-empty strings is refused', async (t) => {
  requireArtifacts(...ARTIFACTS, T172_MIGRATION);
  const ctx = await startControlPlane(t);

  for (const refused of [
    { label: 'a bare string', value: 'claude-sonnet-5' },
    { label: 'a list with a number in it', value: ['claude-sonnet-5', 5] },
    { label: 'a list with an empty string', value: ['claude-sonnet-5', ''] },
    { label: 'an empty list', value: [] },
  ]) {
    const session = await openBareSession(ctx);
    const response = await request<{ error: string }>(
      ctx,
      'PATCH',
      `/v1/sessions/${session.id}/finish`,
      { status: 'completed', exit_code: 0, models: refused.value },
    );
    assert.equal(
      response.status,
      400,
      `${refused.label} has to be a 400, the same shape a malformed \`usage\` gets`,
    );
    assert.equal(response.body.error, 'validation_failed');

    // ...and nothing was written: the session is still open, so a retry with a
    // well-formed body can still close it.
    const still = await request<{ sessions: Session[] }>(ctx, 'GET', '/v1/sessions?execution_id=7');
    const row = still.body.sessions.find((item) => item.id === session.id);
    assert.equal(row?.status, 'open', `${refused.label} left a trace on the row`);
  }
});

test('t172 — GET /v1/sessions + GET /v1/jobs answer cost by ticket, node, version and model', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes, T172_MIGRATION);
  const ctx = await startControlPlane(t);

  const EXECUTION = 1720;
  const V1 = 'sha256:v1';
  const V2 = 'sha256:v2';
  const HAIKU = 'claude-haiku-4-5';
  const SONNET = 'claude-sonnet-5';

  /** A `usage` whose total is the sum of its four counts — the lens's own rule. */
  const usage = (total: number): Record<string, number> => ({
    input_tokens: total,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });

  const jobOne = await createJob(ctx, {
    title: 'ficha na v1',
    entry_node_id: 'implementar',
    execution_id: EXECUTION,
    graph_version_id: V1,
  });
  const jobTwo = await createJob(ctx, {
    title: 'ficha na v2',
    entry_node_id: 'implementar',
    execution_id: EXECUTION,
    graph_version_id: V2,
  });

  /** Opens a session on a job's node and closes it with the given accounting. */
  const spend = async (
    jobId: number,
    nodeId: string,
    tokens: number,
    models: string[],
  ): Promise<void> => {
    const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
      job_id: jobId,
      node_id: nodeId,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: `trabalhe em ${nodeId}`,
    });
    assert.equal(opened.status, 201);
    const closed = await request<Session>(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
      status: 'completed',
      exit_code: 0,
      usage: usage(tokens),
      models: models,
    });
    assert.equal(closed.status, 200);
  };

  await spend(jobOne.id, 'implementar', 100, [SONNET]);
  await spend(jobOne.id, 'revisar', 10, [HAIKU]);
  await spend(jobTwo.id, 'implementar', 1000, [SONNET, HAIKU]);
  // A session the engine told nothing about: it may not move a single total.
  await spend(jobTwo.id, 'revisar', 0, [HAIKU]);
  const silent = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: jobTwo.id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'sessão que morreu sem reportar nada',
  });
  await request<Session>(ctx, 'PATCH', `/v1/sessions/${silent.body.id}/finish`, {
    status: 'failed',
    exit_code: 1,
  });

  // --- the two GETs, and the join done in the client. This IS the claim: no
  // aggregation route was added, and none is needed (FR10, Out of Scope).
  const sessions = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execution_id=${EXECUTION}`,
  );
  assert.equal(sessions.status, 200);
  const jobs = await request<{ jobs: Job[] }>(
    ctx,
    'GET',
    `/v1/jobs?execution_id=${EXECUTION}`,
  );
  assert.equal(jobs.status, 200);

  const versionOf = new Map(jobs.body.jobs.map((job) => [job.id, job.graph_version_id]));
  const total = (usage: Session['usage']): number =>
    usage === null
      ? 0
      : usage.input_tokens +
        usage.output_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens;

  /** Sums tokens per key, ignoring what nobody reported — absence is not zero. */
  const groupBy = (key: (session: Session) => readonly (string | number | null)[]): Map<string, number> => {
    const totals = new Map<string, number>();
    for (const session of sessions.body.sessions) {
      if (session.usage === null) continue;
      for (const bucket of key(session)) {
        const name = String(bucket);
        totals.set(name, (totals.get(name) ?? 0) + total(session.usage));
      }
    }
    return totals;
  };

  assert.deepEqual(
    Object.fromEntries(groupBy((session) => [session.job_id])),
    { [jobOne.id]: 110, [jobTwo.id]: 1000 },
    'by ticket',
  );
  assert.deepEqual(
    Object.fromEntries(groupBy((session) => [session.node_id])),
    { implementar: 1100, revisar: 10 },
    'by node',
  );
  assert.deepEqual(
    Object.fromEntries(
      groupBy((session) => [versionOf.get(session.job_id ?? -1) ?? null]),
    ),
    { [V1]: 110, [V2]: 1000 },
    'by graph version — the join `topografo-custo` already performs',
  );
  // By model, a session with two of them counts in BOTH: the CLI reports which
  // models ran, never how the four counts split between them, and inventing a
  // split would be this test making up a number the engine did not give.
  assert.deepEqual(
    Object.fromEntries(groupBy((session) => session.models ?? [])),
    { [SONNET]: 1100, [HAIKU]: 1010 },
    'by model',
  );

  // The honest denominator: the sessions that reported nothing are countable,
  // and they are not folded into any of the four totals above.
  assert.equal(
    sessions.body.sessions.filter((session) => session.usage === null).length,
    1,
    'exactly one session reported no usage',
  );
  assert.equal(
    sessions.body.sessions.filter((session) => session.models === null).length,
    1,
    'and the same one reported no model',
  );
});
