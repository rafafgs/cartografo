/**
 * Acceptance test of the version × telemetry query (t102, AT15).
 *
 * It is the join the topographer will need after the PoC: D15 makes the graph
 * version the row you cross with telemetry to say whether a mutation improved
 * anything. Without this query, "v2 is better than v1" would be an opinion.
 *
 * `grafo_versao_id` is loose `TEXT` on purpose (the `grafo_versao` table belongs
 * to t101): here it is job input data, not an FK.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T102_ARTIFACTS,
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type Event,
  type InputRequest,
  type Job,
  type MetricByVersion,
  type Session,
  type TestContext,
} from './support.ts';

/**
 * One row of `GET /v1/executions` (t107, FR1).
 *
 * Hand-written, like the other shapes in this support: it IS the contract the
 * test charges for, and importing it from `src/` would charge nothing.
 */
interface ExecutionSummary {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
}

test('AT15 — GET /v1/executions/:id/metrics-by-version groups jobs and events by version', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.events,
    T102_ARTIFACTS.jobRepository,
    T102_ARTIFACTS.jobRoutes,
    T102_ARTIFACTS.executionRoutes,
  );
  const ctx = await startControlPlane(t);

  // Execution 7: two jobs on v1, one on v2.
  const v1a = await createJob(ctx, {
    title: 'v1 a',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v1',
  });
  const v1b = await createJob(ctx, {
    title: 'v1 b',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v1',
  });
  const v2 = await createJob(ctx, {
    title: 'v2',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v2',
  });

  // Execution 8, same version: must not leak into the report of 7.
  await createJob(ctx, {
    title: 'de outra execução',
    entry_node_id: 'entrada',
    execution_id: 8,
    graph_version_id: 'v1',
  });

  // v1: 2 created + 2 transitions + 1 session = 5 events.
  await request(ctx, 'POST', `/v1/jobs/${v1a.id}/transitions`, { to_node_id: 'implementacao' });
  await request(ctx, 'POST', `/v1/jobs/${v1b.id}/transitions`, { to_node_id: 'implementacao' });
  await request(ctx, 'POST', '/v1/sessions', {
    job_id: v1a.id,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe',
  });

  // v2: 1 created + 1 block = 2 events.
  await request(ctx, 'POST', `/v1/jobs/${v2.id}/blocks`, { reason: 'travou' });

  const response = await request<{ execution_id: number; metrics: MetricByVersion[] }>(
    ctx,
    'GET',
    '/v1/executions/7/metrics-by-version',
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.execution_id, 7);
  assert.deepEqual(response.body.metrics, [
    { graph_version_id: 'v1', jobs: 2, events: 5 },
    { graph_version_id: 'v2', jobs: 1, events: 2 },
  ]);
});

test('AT15 — an execution with no job at all returns an empty list, not 404', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<{ execution_id: number; metrics: MetricByVersion[] }>(
    ctx,
    'GET',
    '/v1/executions/99/metrics-by-version',
  );

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.deepEqual(response.body.metrics, []);
});

test('t107 AT1 — GET /v1/executions groups by execution, counts blocked and pending, null last', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.jobRepository,
    T102_ARTIFACTS.inputRequestRepository,
    T102_ARTIFACTS.executionRoutes,
    T102_ARTIFACTS.inputRequestRoutes,
  );
  const ctx = await startControlPlane(t);

  // Eight is created BEFORE seven on purpose: the response is ordered by
  // `execucao_id`, not by the order the jobs came in.
  await createJob(ctx, { title: 'só da oito', entry_node_id: 'entrada', execution_id: 8 });

  const blocked = await createJob(ctx, {
    title: 'travado',
    entry_node_id: 'entrada',
    execution_id: 7,
  });
  const moving = await createJob(ctx, {
    title: 'andando',
    entry_node_id: 'entrada',
    execution_id: 7,
  });

  // A job with no execution: falls into the `null` group instead of vanishing.
  await createJob(ctx, { title: 'sem rodada', entry_node_id: 'entrada' });

  await request(ctx, 'POST', `/v1/jobs/${blocked.id}/blocks`, { reason: 'esperando gente' });

  const ask = async (jobId: number): Promise<InputRequest> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      job_id: jobId,
      kind: 'question',
      question: 'e agora?',
      auto_approvable: false,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const pending = await ask(blocked.id);
  const answered = await ask(moving.id);
  await request(ctx, 'PATCH', `/v1/input-requests/${answered.id}/answer`, {
    answer: 'siga',
    answered_by: 'rafael',
  });
  assert.ok(pending.id !== answered.id);

  const response = await request<{ executions: ExecutionSummary[] }>(ctx, 'GET', '/v1/executions');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.executions, [
    { execution_id: 7, jobs: 2, blocked_jobs: 1, pending_input_requests: 1 },
    { execution_id: 8, jobs: 1, blocked_jobs: 0, pending_input_requests: 0 },
    { execution_id: null, jobs: 1, blocked_jobs: 0, pending_input_requests: 0 },
  ]);
});

test('t107 AT1 — with no job at all, GET /v1/executions returns an empty list', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<{ executions: ExecutionSummary[] }>(ctx, 'GET', '/v1/executions');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.executions, []);
});

/** One row of `input_requests_by_node`, beside `metrics` on the same route (t167). */
interface QuestionsByNode {
  node_id: string | null;
  input_requests: number;
}

test('t167 — the execution report counts the questions each node raised', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.inputRequestRepository,
    T102_ARTIFACTS.inputRequestRoutes,
    T102_ARTIFACTS.executionRoutes,
  );
  const ctx = await startControlPlane(t);

  const ask = async (jobId: number, question: string): Promise<void> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      job_id: jobId,
      kind: 'question',
      question: question,
      auto_approvable: false,
    });
    assert.equal(response.status, 201);
  };

  // Two jobs of the same round: one asks twice from `revisar`, the other once
  // from `redigir`. A third node exists in nobody's question at all.
  const twice = await createJob(ctx, {
    title: 'trava duas vezes na revisão',
    entry_node_id: 'revisar',
    execution_id: 1670,
  });
  await ask(twice.id, 'sigo com a nota curta?');
  await request(ctx, 'POST', `/v1/jobs/${twice.id}/unblocks`, {});
  await ask(twice.id, 'e o título, mantenho?');

  const once = await createJob(ctx, {
    title: 'trava uma vez na redação',
    entry_node_id: 'redigir',
    execution_id: 1670,
  });
  await ask(once.id, 'qual fonte vale?');

  // Another round, same nodes: nothing of it may leak into this report.
  const elsewhere = await createJob(ctx, {
    title: 'de outra rodada',
    entry_node_id: 'revisar',
    execution_id: 1671,
  });
  await ask(elsewhere.id, 'pergunta de outra rodada');

  const response = await request<{
    execution_id: number;
    metrics: MetricByVersion[];
    input_requests_by_node: QuestionsByNode[];
  }>(ctx, 'GET', '/v1/executions/1670/metrics-by-version');

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.input_requests_by_node,
    [
      { node_id: 'redigir', input_requests: 1 },
      { node_id: 'revisar', input_requests: 2 },
    ],
    'one row per node that asked something; a node with zero questions is simply absent',
  );
  assert.ok(
    Array.isArray(response.body.metrics),
    'it rides beside the metrics that were already there, not instead of them',
  );

  const empty = await request<{ input_requests_by_node: QuestionsByNode[] }>(
    ctx,
    'GET',
    '/v1/executions/99/metrics-by-version',
  );
  assert.deepEqual(empty.body.input_requests_by_node, [], 'a round nobody asked anything in is empty');
});

test('t127 — the old Portuguese execution path no longer exists', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request(ctx, 'GET', '/v1/execucoes/7/metricas-por-versao');
  assert.equal(response.status, 404, 'GET /v1/execucoes/:id/metricas-por-versao should be gone (D18)');
});

/* -------------------------------------------------------------------------- */
/* t110 — the execution-wide event stream the flow surveyor reads              */
/*                                                                            */
/* The route segments are English (D18); the payload keys stay in Portuguese,  */
/* because they mirror the untouched migration columns (t127, FR8).            */
/* -------------------------------------------------------------------------- */

/** What `GET /v1/executions/:id/events` gives back (FR1). */
interface ExecutionLog {
  execution_id: number;
  events: Event[];
}

/**
 * Seeds one execution with all three event-bearing entities.
 *
 * The surveyor's numbers cross `trabalho`, `sessao` and `pergunta` — time in
 * node, time blocked, questions per node — so a log that only proves one of
 * them proves nothing about the query this ticket needs.
 */
async function seedExecution(ctx: TestContext, executionId: number): Promise<Job> {
  const job = await createJob(ctx, {
    title: `travessia da execução ${executionId}`,
    entry_node_id: 'redigir',
    execution_id: executionId,
    graph_version_id: 'sha256:t110',
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });

  const session = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'revise',
  });
  await request(ctx, 'PATCH', `/v1/sessions/${session.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
  });

  // Asking also blocks the work, in the same transaction (t106) — two more
  // events, both carrying the owner's `execucao_id`.
  await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    session_id: session.body.id,
    kind: 'question',
    question: 'sigo com a nota curta?',
    auto_approvable: true,
  });

  return job;
}

test('t110 — GET /v1/executions/:id/events returns the execution log in ascending id order', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.events,
    T102_ARTIFACTS.executionRoutes,
    T102_ARTIFACTS.sessionRoutes,
    T102_ARTIFACTS.inputRequestRoutes,
  );
  const ctx = await startControlPlane(t);

  await seedExecution(ctx, 11);
  // A second execution, seeded the same way: nothing of it may leak into 11.
  const other = await seedExecution(ctx, 12);

  const response = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/11/events');

  assert.equal(response.status, 200);
  assert.equal(response.body.execution_id, 11);

  const events = response.body.events;
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'job.created',
      'job.transitioned',
      'session.opened',
      'session.finished',
      'input_request.created',
      'job.blocked',
    ],
    'the stream crosses job, session and input request, in the order the log recorded them',
  );

  const ids = events.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ordered by id, the only total ordering');

  for (const event of events) {
    assert.equal(event.execution_id, 11, 'no event of another execution may leak in');
    assert.notEqual(
      event.entity.id,
      other.id,
      'the other execution has its own work; this one never mentions it',
    );
  }

  // The envelope arrives whole: the surveyor computes intervals from
  // `ocorrido_em` and attributes them by `dados`.
  const opened = events.find((event) => event.type === 'session.opened');
  assert.ok(opened !== undefined);
  assert.equal(opened.data.no_id, 'revisar');
  assert.equal(typeof opened.occurred_at, 'string');

  const fromTheOther = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/12/events');
  assert.equal(fromTheOther.body.events.length, events.length, 'each execution sees only its own');
});

test('t110 — an execution with no events answers 200 with an empty list, never 404', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/99/events');

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.equal(response.body.execution_id, 99);
  assert.deepEqual(response.body.events, []);
});
