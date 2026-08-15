/**
 * Session acceptance tests (t102, AT8–AT10).
 *
 * The session is the run of an agent by an EngineAdapter. In flowpilot it was a
 * mutable row born `pending` and updated until `completed`; here there are two
 * events (`sessao.aberta`, `sessao.finalizada`) and a projection — consequence 2
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
  type Session,
} from './support.ts';

const ARTIFACTS = [
  T102_ARTIFACTS.migration,
  T102_ARTIFACTS.events,
  T102_ARTIFACTS.validation,
  T102_ARTIFACTS.sessionRepository,
  T102_ARTIFACTS.sessionRoutes,
];

const USAGE = {
  input_tokens: 18422,
  output_tokens: 3110,
  cache_creation_input_tokens: 9004,
  cache_read_input_tokens: 120344,
};

test('AT8 — POST /v1/sessions records sessao.aberta and creates the open row', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    titulo: 'com sessão',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/Users/rafael/cartografo-ticket-102',
    prompt: 'Refine o trabalho 102 contra as convenções do projeto.',
    timeout_seconds: 5400,
  });

  assert.equal(response.status, 201);
  const session = response.body;
  assert.ok(Number.isInteger(session.id) && session.id >= 1);
  assert.equal(session.status, 'aberta');
  assert.equal(session.trabalho_id, job.id);
  assert.equal(session.execucao_id, 7, 'the execution comes from the job served');
  assert.equal(session.exit_code, null);
  assert.equal(session.uso, null);
  assert.equal(session.finalizada_em, null);
  assert.ok(!Number.isNaN(Date.parse(session.aberta_em)));

  const events = getEventsByEntity(ctx.db, 'sessao', session.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].tipo, 'sessao.aberta');
  assert.deepEqual(events[0].entidade, { tipo: 'sessao', id: session.id });
  assert.deepEqual(events[0].dados, {
    trabalho_id: job.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/Users/rafael/cartografo-ticket-102',
    prompt: 'Refine o trabalho 102 contra as convenções do projeto.',
    timeout_seconds: 5400,
  });
});

test('AT9 — PATCH /v1/sessions/:id/finish closes the session; absent usage is null, never 0', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const open = async (): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      execucao_id: 7,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'faça algo',
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const withUsage = await open();
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${withUsage.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
    uso: USAGE,
  });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.status, 'concluida');
  assert.equal(finished.body.exit_code, 0, 'zero is a success exit code, not absence');
  assert.deepEqual(finished.body.uso, USAGE);
  assert.ok(!Number.isNaN(Date.parse(finished.body.finalizada_em ?? '')));

  const withoutUsage = await open();
  const paused = await request<Session>(ctx, 'PATCH', `/v1/sessions/${withoutUsage.id}/finish`, {
    status: 'pausada_cota',
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'pausada_cota');
  assert.equal(paused.body.uso, null, 'the engine reported nothing: null');
  assert.notEqual(paused.body.uso, 0, 'never collapse absent usage into zero');
  assert.equal(paused.body.exit_code, null);

  const events = getEventsByEntity(ctx.db, 'sessao', withUsage.id);
  assert.deepEqual(
    events.map((event: Event) => event.tipo),
    ['sessao.aberta', 'sessao.finalizada'],
  );
  assert.deepEqual(events[1].dados, { status: 'concluida', exit_code: 0, uso: USAGE });

  const withoutUsageEvents = getEventsByEntity(ctx.db, 'sessao', withoutUsage.id);
  assert.deepEqual(withoutUsageEvents[1].dados, {
    status: 'pausada_cota',
    exit_code: null,
    uso: null,
  });
});

test('AT10 — GET /v1/sessions?execucao_id=7 returns only that execution\'s sessions', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const open = async (executionId: number, prompt: string): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      execucao_id: executionId,
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

  const response = await request<{ sessoes: Session[] }>(ctx, 'GET', '/v1/sessions?execucao_id=7');
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.sessoes.map((session) => session.id).sort((a, b) => a - b),
    [one.id, other.id].sort((a, b) => a - b),
  );
});

test('t127 — the old Portuguese session paths no longer exist', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const created = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execucao_id: 7,
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
      method === 'GET' ? undefined : { status: 'concluida' },
    );
    assert.equal(response.status, 404, `${method} ${routePath} should be gone (D18)`);
  }
});

test('t107 AT2 — GET /v1/sessions?trabalho_id= slices by job inside the same execution', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);

  // Both jobs live in the SAME execution: that is what makes this test prove
  // the new filter, and not the `execucao_id` that already existed.
  const watched = await createJob(ctx, {
    titulo: 'o que a tela abre',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const neighbour = await createJob(ctx, {
    titulo: 'o outro da mesma rodada',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  const openSessionFor = async (jobId: number, prompt: string): Promise<Session> => {
    const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
      trabalho_id: jobId,
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

  const response = await request<{ sessoes: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?trabalho_id=${watched.id}`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.sessoes.map((item) => item.id),
    [first.id, second.id],
    'only the sessions of the requested job, in id order',
  );
  assert.ok(
    !response.body.sessoes.some((item) => item.id === neighbours.id),
    "the neighbour's session shares the execution, but not the job",
  );

  const combined = await request<{ sessoes: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execucao_id=7&trabalho_id=${watched.id}`,
  );
  assert.equal(combined.status, 200);
  assert.deepEqual(
    combined.body.sessoes.map((item) => item.id),
    [first.id, second.id],
    'the two filters together are AND',
  );

  const mismatched = await request<{ sessoes: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execucao_id=8&trabalho_id=${watched.id}`,
  );
  assert.deepEqual(mismatched.body.sessoes, [], 'AND, not OR');

  const invalid = await request(ctx, 'GET', '/v1/sessions?trabalho_id=abc');
  assert.equal(invalid.status, 400, 'an invalid filter is 400, never a silently ignored filter');
});

test('t125 — POST /v1/sessions/:id/permission-denials records the denial without ending the session', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    titulo: 'com skill de terceiro',
    no_entrada_id: 'entrada',
    execucao_id: 9,
  });

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
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
      recurso: 'rede',
      ferramenta: 'WebFetch',
      motivo: 'Claude requested permissions to use WebFetch, but you have not granted it.',
    },
  );

  assert.equal(denied.status, 200);
  // A denial is an incident, not a terminal state: the row does not move.
  assert.equal(denied.body.status, 'aberta');
  assert.equal(denied.body.finalizada_em, null);
  assert.equal(denied.body.exit_code, null);

  const events = getEventsByEntity(ctx.db, 'sessao', session.id);
  assert.deepEqual(
    events.map((event: Event) => event.tipo),
    ['sessao.aberta', 'sessao.permissao_negada'],
  );
  assert.deepEqual(events[1].entidade, { tipo: 'sessao', id: session.id });
  assert.deepEqual(events[1].ator, { tipo: 'sistema', ref: 'runner' });
  assert.equal(events[1].execucao_id, 9, 'the denial belongs to the round the session serves');
  assert.deepEqual(events[1].dados, {
    recurso: 'rede',
    ferramenta: 'WebFetch',
    motivo: 'Claude requested permissions to use WebFetch, but you have not granted it.',
  });

  // The same session can be denied more than once: the log is append-only and
  // nothing about the first denial closes the door on the second.
  const again = await request<Session>(
    ctx,
    'POST',
    `/v1/sessions/${session.id}/permission-denials`,
    { recurso: 'filesystem', ferramenta: 'Write', motivo: 'write scope is empty for this skill' },
  );
  assert.equal(again.status, 200);
  assert.equal(getEventsByEntity(ctx.db, 'sessao', session.id).length, 3);
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
      projeto_id: OTHER_PROJECT,
      execucao_id: 7,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'uma sessão de descoberta, sem trabalho dono',
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.trabalho_id, null, 'the case under test is the job-less session');
    return response.body;
  };

  const closed = await open();
  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${closed.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
  });
  assert.equal(finished.status, 200);

  const closedEvents = getEventsByEntity(ctx.db, 'sessao', closed.id);
  assert.deepEqual(
    closedEvents.map((event: Event) => event.tipo),
    ['sessao.aberta', 'sessao.finalizada'],
  );
  assert.equal(
    closedEvents[0].projeto_id,
    OTHER_PROJECT,
    'control: the opening already recorded the declared project',
  );
  assert.equal(
    closedEvents[1].projeto_id,
    OTHER_PROJECT,
    'the end belongs to the same project as the opening, not to DEFAULT_PROJECT',
  );

  const denied = await open();
  const denial = await request<Session>(
    ctx,
    'POST',
    `/v1/sessions/${denied.id}/permission-denials`,
    { recurso: 'rede', ferramenta: 'WebFetch', motivo: 'sem rede nesta sessão' },
  );
  assert.equal(denial.status, 200);

  const deniedEvents = getEventsByEntity(ctx.db, 'sessao', denied.id);
  assert.deepEqual(
    deniedEvents.map((event: Event) => event.tipo),
    ['sessao.aberta', 'sessao.permissao_negada'],
  );
  assert.equal(
    deniedEvents[1].projeto_id,
    OTHER_PROJECT,
    'the denial is attributed the same way the end is',
  );
});

test('t157 — a session that serves a job is still attributed to the job\'s project', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.jobRepository, T102_ARTIFACTS.jobRoutes);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    titulo: 'de outro projeto',
    no_entrada_id: 'entrada',
    projeto_id: OTHER_PROJECT,
    execucao_id: 9,
  });

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
    // Deliberately contradicting the job: the owner's project is the one that
    // holds, at the opening and at every event after it.
    projeto_id: 999,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo pelo trabalho',
  });
  assert.equal(opened.status, 201);

  const finished = await request<Session>(
    ctx,
    'PATCH',
    `/v1/sessions/${opened.body.id}/finish`,
    { status: 'concluida', exit_code: 0 },
  );
  assert.equal(finished.status, 200);

  const events = getEventsByEntity(ctx.db, 'sessao', opened.body.id);
  assert.deepEqual(
    events.map((event: Event) => event.projeto_id),
    [OTHER_PROJECT, OTHER_PROJECT],
    'the job owns the project, and the end says the same thing the opening said',
  );
});

test('t149 AT5 — finishing an already finished session is a 409, and the first end stands', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execucao_id: 7,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo',
  });
  assert.equal(opened.status, 201);
  const session = opened.body;

  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
    uso: USAGE,
  });
  assert.equal(finished.status, 200);

  // The retry carries a DIFFERENT ending and no usage at all: if it went
  // through, the only cost record the PoC keeps would be gone.
  const retry = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/sessions/${session.id}/finish`,
    { status: 'falhou', exit_code: 1 },
  );
  assert.equal(retry.status, 409, 'a session ends once');
  assert.equal(retry.body.error, 'conflict');
  assert.ok(
    retry.body.details.some((detail) => detail.includes('concluida')),
    `the 409 has to say what state refused it: ${JSON.stringify(retry.body.details)}`,
  );

  const listed = await request<{ sessoes: Session[] }>(ctx, 'GET', '/v1/sessions?execucao_id=7');
  assert.equal(listed.status, 200);
  const stored = listed.body.sessoes.find((item) => item.id === session.id);
  assert.ok(stored !== undefined, 'the session disappeared from the listing');
  assert.equal(stored.status, 'concluida');
  assert.equal(stored.exit_code, 0);
  assert.deepEqual(stored.uso, USAGE, 'the refused retry never NULLs the usage of the first end');
  assert.equal(stored.finalizada_em, finished.body.finalizada_em);

  const events = getEventsByEntity(ctx.db, 'sessao', session.id);
  assert.deepEqual(
    events.map((event: Event) => event.tipo),
    ['sessao.aberta', 'sessao.finalizada'],
    'the refused retry writes NOTHING: no second end in the log',
  );
});

test('t149 AT6 — finishing a session that does not exist is still a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const unknown = await request<{ error: string }>(ctx, 'PATCH', '/v1/sessions/98765/finish', {
    status: 'concluida',
    exit_code: 0,
  });
  assert.equal(unknown.status, 404, 'reading before writing did not turn a 404 into a 409');
  assert.equal(unknown.body.error, 'not_found');
});

test('t125 — a denial outside the contract is a 400, and an unknown session a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execucao_id: 9,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'faça algo',
  });
  assert.equal(opened.status, 201);

  const outsideEnum = await request<{ error: string; details: string[] }>(
    ctx,
    'POST',
    `/v1/sessions/${opened.body.id}/permission-denials`,
    { recurso: 'memoria', ferramenta: 'WebFetch', motivo: 'inventado' },
  );
  assert.equal(outsideEnum.status, 400);
  assert.equal(outsideEnum.body.error, 'validation_failed');
  assert.ok(
    outsideEnum.body.details.some((detail) => detail.includes('recurso')),
    `the 400 has to name the offending field: ${JSON.stringify(outsideEnum.body.details)}`,
  );

  const missingField = await request(
    ctx,
    'POST',
    `/v1/sessions/${opened.body.id}/permission-denials`,
    { recurso: 'rede' },
  );
  assert.equal(missingField.status, 400, 'ferramenta and motivo are required');

  const unknown = await request(ctx, 'POST', '/v1/sessions/98765/permission-denials', {
    recurso: 'rede',
    ferramenta: 'WebFetch',
    motivo: 'a sessão não existe',
  });
  assert.equal(unknown.status, 404);
});
