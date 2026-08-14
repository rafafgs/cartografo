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
  execucao_id: number | null;
  trabalhos: number;
  trabalhos_bloqueados: number;
  perguntas_pendentes: number;
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
    titulo: 'v1 a',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  const v1b = await createJob(ctx, {
    titulo: 'v1 b',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  const v2 = await createJob(ctx, {
    titulo: 'v2',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v2',
  });

  // Execution 8, same version: must not leak into the report of 7.
  await createJob(ctx, {
    titulo: 'de outra execução',
    no_entrada_id: 'entrada',
    execucao_id: 8,
    grafo_versao_id: 'v1',
  });

  // v1: 2 created + 2 transitions + 1 session = 5 events.
  await request(ctx, 'POST', `/v1/jobs/${v1a.id}/transitions`, { para_no_id: 'implementacao' });
  await request(ctx, 'POST', `/v1/jobs/${v1b.id}/transitions`, { para_no_id: 'implementacao' });
  await request(ctx, 'POST', '/v1/sessions', {
    trabalho_id: v1a.id,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe',
  });

  // v2: 1 created + 1 block = 2 events.
  await request(ctx, 'POST', `/v1/jobs/${v2.id}/blocks`, { motivo: 'travou' });

  const response = await request<{ execucao_id: number; metricas: MetricByVersion[] }>(
    ctx,
    'GET',
    '/v1/executions/7/metrics-by-version',
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.execucao_id, 7);
  assert.deepEqual(response.body.metricas, [
    { grafo_versao_id: 'v1', trabalhos: 2, eventos: 5 },
    { grafo_versao_id: 'v2', trabalhos: 1, eventos: 2 },
  ]);
});

test('AT15 — an execution with no job at all returns an empty list, not 404', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<{ execucao_id: number; metricas: MetricByVersion[] }>(
    ctx,
    'GET',
    '/v1/executions/99/metrics-by-version',
  );

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.deepEqual(response.body.metricas, []);
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
  await createJob(ctx, { titulo: 'só da oito', no_entrada_id: 'entrada', execucao_id: 8 });

  const blocked = await createJob(ctx, {
    titulo: 'travado',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const moving = await createJob(ctx, {
    titulo: 'andando',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  // A job with no execution: falls into the `null` group instead of vanishing.
  await createJob(ctx, { titulo: 'sem rodada', no_entrada_id: 'entrada' });

  await request(ctx, 'POST', `/v1/jobs/${blocked.id}/blocks`, { motivo: 'esperando gente' });

  const ask = async (jobId: number): Promise<InputRequest> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      trabalho_id: jobId,
      tipo: 'pergunta',
      pergunta: 'e agora?',
      auto_aprovavel: false,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const pending = await ask(blocked.id);
  const answered = await ask(moving.id);
  await request(ctx, 'PATCH', `/v1/input-requests/${answered.id}/answer`, {
    resposta: 'siga',
    respondido_por: 'rafael',
  });
  assert.ok(pending.id !== answered.id);

  const response = await request<{ execucoes: ExecutionSummary[] }>(ctx, 'GET', '/v1/executions');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.execucoes, [
    { execucao_id: 7, trabalhos: 2, trabalhos_bloqueados: 1, perguntas_pendentes: 1 },
    { execucao_id: 8, trabalhos: 1, trabalhos_bloqueados: 0, perguntas_pendentes: 0 },
    { execucao_id: null, trabalhos: 1, trabalhos_bloqueados: 0, perguntas_pendentes: 0 },
  ]);
});

test('t107 AT1 — with no job at all, GET /v1/executions returns an empty list', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<{ execucoes: ExecutionSummary[] }>(ctx, 'GET', '/v1/executions');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.execucoes, []);
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
  execucao_id: number;
  eventos: Event[];
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
    titulo: `travessia da execução ${executionId}`,
    no_entrada_id: 'redigir',
    execucao_id: executionId,
    grafo_versao_id: 'sha256:t110',
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'revisar' });

  const session = await request<Session>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
    no_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'revise',
  });
  await request(ctx, 'PATCH', `/v1/sessions/${session.body.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
    uso: null,
  });

  // Asking also blocks the work, in the same transaction (t106) — two more
  // events, both carrying the owner's `execucao_id`.
  await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    sessao_id: session.body.id,
    tipo: 'pergunta',
    pergunta: 'sigo com a nota curta?',
    auto_aprovavel: true,
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
  assert.equal(response.body.execucao_id, 11);

  const events = response.body.eventos;
  assert.deepEqual(
    events.map((event) => event.tipo),
    [
      'trabalho.criado',
      'trabalho.transicao',
      'sessao.aberta',
      'sessao.finalizada',
      'pergunta.criada',
      'trabalho.bloqueado',
    ],
    'the stream crosses job, session and input request, in the order the log recorded them',
  );

  const ids = events.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ordered by id, the only total ordering');

  for (const event of events) {
    assert.equal(event.execucao_id, 11, 'no event of another execution may leak in');
    assert.notEqual(
      event.entidade.id,
      other.id,
      'the other execution has its own work; this one never mentions it',
    );
  }

  // The envelope arrives whole: the surveyor computes intervals from
  // `ocorrido_em` and attributes them by `dados`.
  const opened = events.find((event) => event.tipo === 'sessao.aberta');
  assert.ok(opened !== undefined);
  assert.equal(opened.dados.no_id, 'revisar');
  assert.equal(typeof opened.ocorrido_em, 'string');

  const fromTheOther = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/12/events');
  assert.equal(fromTheOther.body.eventos.length, events.length, 'each execution sees only its own');
});

test('t110 — an execution with no events answers 200 with an empty list, never 404', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/99/events');

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.equal(response.body.execucao_id, 99);
  assert.deepEqual(response.body.eventos, []);
});
