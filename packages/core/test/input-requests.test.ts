/**
 * Input-request acceptance tests (t102, AT11–AT14; t106, the block wiring).
 *
 * Human escalation is a first-class entity, not a special case: question and
 * approval are the same animal, and the ORIGIN of the answer is the event type
 * (`pergunta.respondida` vs `pergunta.auto_resolvida`), not a column. In the
 * projection the origin becomes a field again — whoever reads state wants to
 * compare.
 *
 * t102 deliberately stopped short of wiring input request to block, and AT11
 * locked that boundary by asserting `bloqueado === false`. t106 is the ticket
 * that closes the cycle, so AT11 switches sides: creating the input request
 * blocks the job IN THE SAME transaction, and answering unblocks it with the
 * actor of whoever answered. Whoever wants to know why the cycle lives here, and
 * not in the runner, reads `docs/spec/escalacao-humana.md`.
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

test('AT11 — POST /v1/input-requests creates a pending one AND blocks the owning job (t106)', async (t) => {
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

  // The route's shape does not change: whoever wants the block reads the job.
  // What changes is that it is ALREADY blocked by the time the POST's response
  // arrives — same transaction, not a second step somebody may forget to take.
  const after = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.bloqueado, true, 'creating the input request stops the job');
  assert.equal(
    after.body.motivo_bloqueio,
    `aguardando resposta da pergunta ${inputRequest.id}`,
    'the reason quotes the input request id: whoever reads the job knows what unblocks it',
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

  // The job's timeline: the creation, and right after it the block. The order is
  // the log's (id), and it is what tells the story — input request first, flag
  // second.
  const jobEvents = getEventsByEntity(ctx.db, 'trabalho', job.id);
  assert.deepEqual(
    jobEvents.map((event) => event.tipo),
    ['trabalho.criado', 'trabalho.bloqueado'],
  );
  const block = jobEvents[1];
  assert.deepEqual(block.dados, {
    motivo: `aguardando resposta da pergunta ${inputRequest.id}`,
  });
  assert.equal(
    block.ator.tipo,
    'sistema',
    'the wiring raises the flag, not the human nor the agent that asked',
  );
  assert.equal(block.ator.ref, 'escalacao-humana');
});

test('t106 — PATCH /answer unblocks the job, with the actor of whoever answered', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });
  assert.equal(created.status, 201);

  const blocked = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(blocked.body.bloqueado, true);

  const answered = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.body.id}/answer`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );
  assert.equal(answered.status, 200);

  const after = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(after.body.bloqueado, false, 'answering returns the job to the queue');
  assert.equal(after.body.motivo_bloqueio, null);

  const jobEvents = getEventsByEntity(ctx.db, 'trabalho', job.id);
  assert.deepEqual(
    jobEvents.map((event) => event.tipo),
    ['trabalho.criado', 'trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  const unblock = jobEvents[2];
  assert.deepEqual(unblock.dados, {}, 'the fact is the fall of the flag itself');
  assert.equal(
    unblock.ator.tipo,
    'usuario',
    'a person unblocked it, and the unblock carries the SAME actor as the answer',
  );
  assert.equal(unblock.ator.ref, 'rafael');
});

test('t106 — PATCH /auto-resolution unblocks with an actor that is not a user', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });
  assert.equal(created.status, 201);

  const resolved = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.body.id}/auto-resolution`,
    { resposta: 'Manter 0002', baseada_em: 'resposta_padrao' },
  );
  assert.equal(resolved.status, 200);

  const after = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(after.body.bloqueado, false, 'the automatic gate unblocks too');
  assert.equal(after.body.motivo_bloqueio, null);

  const jobEvents = getEventsByEntity(ctx.db, 'trabalho', job.id);
  assert.deepEqual(
    jobEvents.map((event) => event.tipo),
    ['trabalho.criado', 'trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  assert.notEqual(
    jobEvents[2].ator.tipo,
    'usuario',
    'the audit ALWAYS distinguishes unblocked-by-a-person from unblocked-by-the-system',
  );
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
    const response = await request(
      ctx,
      method,
      routePath,
      method === 'GET' ? undefined : { resposta: 'x' },
    );
    assert.equal(response.status, 404, `${method} ${routePath} should be gone (D18)`);
  }
});
