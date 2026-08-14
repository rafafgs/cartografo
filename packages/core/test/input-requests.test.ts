/**
 * Input-request acceptance tests (t102, AT11–AT14).
 *
 * Human escalation is a first-class entity, not a special case: question and
 * approval are the same animal, and the ORIGIN of the answer is the event type
 * (`pergunta.respondida` vs `pergunta.auto_resolvida`), not a column. In the
 * projection the origin becomes a field again — whoever reads state wants to
 * compare.
 *
 * What this suite does NOT do: block the job when the input request is created.
 * That wiring is the acceptance criterion of t106, and AT11 exists to lock the
 * boundary.
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
  type InputRequest,
  type Job,
} from './support.ts';

const ARTIFACTS = [
  T102_ARTIFACTS.migration,
  T102_ARTIFACTS.events,
  T102_ARTIFACTS.validation,
  T102_ARTIFACTS.inputRequestRepository,
  T102_ARTIFACTS.jobRepository,
  T102_ARTIFACTS.inputRequestRoutes,
  T102_ARTIFACTS.jobRoutes,
];

const FULL_BODY = {
  tipo: 'pergunta',
  pergunta: 'Renumerar a migração para 0003?',
  contexto: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  opcoes: ['Renumerar para 0003', 'Manter 0002'],
  recomendacao: 'Manter 0002 e renumerar só se colidir no merge.',
  resposta_padrao: 'Manter 0002',
  auto_aprovavel: true,
};

test('AT11 — POST /v1/input-requests creates a pending one and does NOT block the job', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, {
    titulo: 'que pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });

  assert.equal(response.status, 201);
  const inputRequest = response.body;
  assert.ok(Number.isInteger(inputRequest.id) && inputRequest.id >= 1);
  assert.equal(inputRequest.status, 'pendente');
  assert.equal(inputRequest.origem, null);
  assert.equal(inputRequest.resposta, null);
  assert.equal(inputRequest.respondida_em, null);
  assert.equal(inputRequest.auto_aprovavel, true);
  assert.deepEqual(inputRequest.opcoes, FULL_BODY.opcoes);
  assert.equal(inputRequest.execucao_id, 7, 'the execution comes from the job that waits');

  const after = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(after.status, 200);
  assert.equal(
    after.body.bloqueado,
    false,
    'the input-request→block wiring belongs to t106; this suite only records the request',
  );

  const events = getEventsByEntity(ctx.db, 'pergunta', inputRequest.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].tipo, 'pergunta.criada');
  assert.deepEqual(events[0].entidade, { tipo: 'pergunta', id: inputRequest.id });
  assert.deepEqual(events[0].dados, {
    trabalho_id: job.id,
    sessao_id: null,
    tipo: 'pergunta',
    pergunta: FULL_BODY.pergunta,
    contexto: FULL_BODY.contexto,
    opcoes: FULL_BODY.opcoes,
    recomendacao: FULL_BODY.recomendacao,
    resposta_padrao: FULL_BODY.resposta_padrao,
    auto_aprovavel: true,
  });
});

test('AT12 — PATCH /v1/input-requests/:id/answer records the human answer', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });
  assert.equal(created.status, 201);

  const response = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.body.id}/answer`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'respondida');
  assert.equal(response.body.origem, 'usuario');
  assert.equal(response.body.resposta, 'Manter 0002');
  assert.equal(response.body.respondido_por, 'rafael');
  assert.ok(!Number.isNaN(Date.parse(response.body.respondida_em ?? '')));

  const events = getEventsByEntity(ctx.db, 'pergunta', created.body.id);
  assert.deepEqual(
    events.map((event) => event.tipo),
    ['pergunta.criada', 'pergunta.respondida'],
  );
  assert.deepEqual(events[1].dados, { resposta: 'Manter 0002', respondido_por: 'rafael' });
  assert.equal(events[1].ator.tipo, 'usuario', 'the answer came from a person');
});

test('AT13 — PATCH /v1/input-requests/:id/auto-resolution records the automatic origin', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });
  assert.equal(created.status, 201);

  const response = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.body.id}/auto-resolution`,
    { resposta: 'Manter 0002', baseada_em: 'resposta_padrao' },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'respondida');
  assert.equal(response.body.origem, 'auto');
  assert.equal(response.body.resposta, 'Manter 0002');

  const events = getEventsByEntity(ctx.db, 'pergunta', created.body.id);
  assert.deepEqual(
    events.map((event) => event.tipo),
    ['pergunta.criada', 'pergunta.auto_resolvida'],
  );
  assert.deepEqual(events[1].dados, {
    resposta: 'Manter 0002',
    baseada_em: 'resposta_padrao',
  });
  assert.notEqual(
    events[1].ator.tipo,
    'usuario',
    'the audit ALWAYS separates approved-by-user from approved-by-system',
  );

  const invalid = await request(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.body.id}/auto-resolution`,
    { resposta: 'seja lá o que for', baseada_em: 'palpite' },
  );
  assert.equal(invalid.status, 400, 'baseada_em is a closed enum');
});

test('AT14 — GET /v1/input-requests?status=pendente&execucao_id=7 gives enough to answer', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const ofSeven = await createJob(ctx, {
    titulo: 'da sete',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const ofEight = await createJob(ctx, {
    titulo: 'da oito',
    no_entrada_id: 'entrada',
    execucao_id: 8,
  });

  const create = async (jobId: number): Promise<InputRequest> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      trabalho_id: jobId,
      ...FULL_BODY,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const pending = await create(ofSeven.id);
  const answered = await create(ofSeven.id);
  await create(ofEight.id);

  await request(ctx, 'PATCH', `/v1/input-requests/${answered.id}/answer`, {
    resposta: 'ok',
    respondido_por: 'rafael',
  });

  const response = await request<{ perguntas: InputRequest[] }>(
    ctx,
    'GET',
    '/v1/input-requests?status=pendente&execucao_id=7',
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.perguntas.map((row) => row.id),
    [pending.id],
  );

  const [queued] = response.body.perguntas;
  assert.equal(queued.pergunta, FULL_BODY.pergunta);
  assert.equal(queued.contexto, FULL_BODY.contexto);
  assert.deepEqual(queued.opcoes, FULL_BODY.opcoes);
  assert.equal(queued.recomendacao, FULL_BODY.recomendacao);
  assert.equal(queued.resposta_padrao, FULL_BODY.resposta_padrao);
  assert.equal(queued.trabalho_id, ofSeven.id);
});

test('t127 — the old Portuguese input-request paths no longer exist', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });
  assert.equal(created.status, 201);

  for (const [method, routePath] of [
    ['POST', '/v1/perguntas'],
    ['GET', '/v1/perguntas'],
    ['PATCH', `/v1/perguntas/${created.body.id}/resposta`],
    ['PATCH', `/v1/perguntas/${created.body.id}/auto_resolucao`],
  ] as const) {
    const response = await request(ctx, method, routePath, { resposta: 'x' });
    assert.equal(response.status, 404, `${method} ${routePath} should be gone (D18)`);
  }
});
