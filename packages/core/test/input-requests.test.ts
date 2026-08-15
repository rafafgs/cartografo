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
 * t113 adds the precedent base (AT3–AT7): an answered question becomes something
 * one can look up, so whoever answers the next one sees what was decided last
 * time (`notas/2026-08-14-aprendizado.md`). It is a READ surface and only that —
 * the auto-answer policy is a separate ticket, because the safety ladder
 * (principle 5) asks that the precedent exist and accumulate history BEFORE any
 * gate answers on its own.
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
  type TestContext,
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

/** t113's own artifact; the precedent tests require it by name. */
const SIMILARITY_ARTIFACT = 'src/domain/similarity.ts';

const FULL_BODY = {
  tipo: 'pergunta',
  pergunta: 'Renumerar a migração para 0003?',
  contexto: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  opcoes: ['Renumerar para 0003', 'Manter 0002'],
  recomendacao: 'Manter 0002 e renumerar só se colidir no merge.',
  resposta_padrao: 'Manter 0002',
  auto_aprovavel: true,
};

/**
 * A precedent, as the API returns it (t113).
 *
 * Hand-written, and not imported from `src/`: this interface IS the contract the
 * test demands, and a contract imported from the implementation demands nothing.
 */
interface Precedent {
  id: number;
  pergunta: string;
  resposta: string | null;
  origem: string | null;
  respondido_por: string | null;
  tipo: string;
  criada_em: string;
  respondida_em: string | null;
  similaridade: number;
}

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

  // The enum is checked against a STILL PENDING input request, and not against
  // the one closed above: since t149 an already answered one is refused with a
  // 409 before the body is ever read, which would hide the 400 this asserts.
  const pending = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    ...FULL_BODY,
  });
  assert.equal(pending.status, 201);

  const invalid = await request(
    ctx,
    'PATCH',
    `/v1/input-requests/${pending.body.id}/auto-resolution`,
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

test('t107 AT3 — GET /v1/input-requests?trabalho_id= slices by job inside the same execution', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  // Same execution on both: the slice this test charges for is the JOB one,
  // which is what the screen's timeline needs to find the waits.
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

  const ask = async (jobId: number): Promise<InputRequest> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      trabalho_id: jobId,
      ...FULL_BODY,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const pending = await ask(watched.id);
  const answered = await ask(watched.id);
  const neighbours = await ask(neighbour.id);

  await request(ctx, 'PATCH', `/v1/input-requests/${answered.id}/answer`, {
    resposta: 'Manter 0002',
    respondido_por: 'rafael',
  });

  const ofTheJob = await request<{ perguntas: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?trabalho_id=${watched.id}`,
  );
  assert.equal(ofTheJob.status, 200);
  assert.deepEqual(
    ofTheJob.body.perguntas.map((item) => item.id),
    [pending.id, answered.id],
    'with no status filter, both of the job — the answered one included (the timeline needs it)',
  );
  assert.ok(
    !ofTheJob.body.perguntas.some((item) => item.id === neighbours.id),
    "the neighbour's input request shares the execution, but not the job",
  );

  const onlyPending = await request<{ perguntas: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?status=pendente&trabalho_id=${watched.id}`,
  );
  assert.deepEqual(
    onlyPending.body.perguntas.map((item) => item.id),
    [pending.id],
    'the filters add up as AND',
  );

  const invalid = await request(ctx, 'GET', '/v1/input-requests?trabalho_id=abc');
  assert.equal(invalid.status, 400, 'an invalid filter is 400, never a silently ignored filter');
});

/** Creates an input request with the given text and returns the pending projection. */
async function askQuestion(
  ctx: TestContext,
  jobId: number,
  text: string,
): Promise<InputRequest> {
  const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: jobId,
    ...FULL_BODY,
    pergunta: text,
  });
  assert.equal(response.status, 201);
  return response.body;
}

/** Creates and already answers — the shape of everything that can become a precedent. */
async function askAndAnswer(
  ctx: TestContext,
  jobId: number,
  text: string,
  answer: string,
): Promise<InputRequest> {
  const created = await askQuestion(ctx, jobId, text);
  const closed = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.id}/answer`,
    { resposta: answer, respondido_por: 'rafael' },
  );
  assert.equal(closed.status, 200);
  return closed.body;
}

/** Queries the precedent base of one input request. */
async function precedentsOf(
  ctx: TestContext,
  id: number,
  query = '',
): Promise<{ status: number; body: { precedentes: Precedent[] } }> {
  return await request<{ precedentes: Precedent[] }>(
    ctx,
    'GET',
    `/v1/input-requests/${id}/precedents${query}`,
  );
}

test('AT3 — GET /v1/input-requests/:id/precedents of a nonexistent id is 404', async (t) => {
  requireArtifacts(...ARTIFACTS, SIMILARITY_ARTIFACT);
  const ctx = await startControlPlane(t);

  const response = await precedentsOf(ctx, 99999);
  assert.equal(response.status, 404);
  assert.equal(
    (response.body as unknown as { error: string }).error,
    'not_found',
    "the 404 is the house's (`notFound`), not the router's generic one",
  );
});

test('AT4 — with no answered input request in the project, precedents is an empty list', async (t) => {
  requireArtifacts(...ARTIFACTS, SIMILARITY_ARTIFACT);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const pending = await askQuestion(ctx, job.id, 'Renumerar a migração para 0004?');

  const response = await precedentsOf(ctx, pending.id);
  assert.equal(response.status, 200, '"found nothing" is 200 with an empty list, never 404 nor 500');
  assert.deepEqual(response.body, { precedentes: [] });
});

test('AT5 — the precedent is the similar answered one, and the query never includes itself', async (t) => {
  requireArtifacts(...ARTIFACTS, SIMILARITY_ARTIFACT);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });

  const similar = await askAndAnswer(
    ctx,
    job.id,
    'Renumerar a migração para 0003?',
    'Manter 0002',
  );
  await askAndAnswer(ctx, job.id, 'Qual engine adapter usar no despacho?', 'Claude Code');

  const queried = await askQuestion(ctx, job.id, 'Renumerar a migração para 0004?');

  const response = await precedentsOf(ctx, queried.id);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.precedentes.map((row) => row.id),
    [similar.id],
    'an answered one with no token in common is a precedent of nothing',
  );

  const [precedent] = response.body.precedentes;
  assert.ok(precedent.similaridade > 0, 'the score is what makes the ranking auditable');
  assert.ok(precedent.similaridade <= 1);
  assert.equal(precedent.pergunta, 'Renumerar a migração para 0003?');
  assert.equal(precedent.resposta, 'Manter 0002', 'a precedent is there to show WHAT was decided');
  assert.equal(precedent.origem, 'usuario');
  assert.equal(precedent.respondido_por, 'rafael');
  assert.equal(precedent.tipo, 'pergunta');
  assert.ok(!Number.isNaN(Date.parse(precedent.criada_em)));
  assert.ok(!Number.isNaN(Date.parse(precedent.respondida_em ?? '')));

  // Once answered it becomes a candidate precedent for the OTHERS — never for
  // itself, which would always be the top of the ranking with score 1.
  const closed = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${queried.id}/answer`,
    { resposta: 'Renumerar para 0004', respondido_por: 'rafael' },
  );
  assert.equal(closed.status, 200);

  const after = await precedentsOf(ctx, queried.id);
  assert.equal(after.status, 200);
  assert.deepEqual(
    after.body.precedentes.map((row) => row.id),
    [similar.id],
  );
});

test('AT6 — an answered one from another project is never a precedent, not even with identical text', async (t) => {
  requireArtifacts(...ARTIFACTS, SIMILARITY_ARTIFACT);
  const ctx = await startControlPlane(t);

  const text = 'Renumerar a migração para 0003?';

  const otherJob = await createJob(ctx, {
    titulo: 'de outro projeto',
    no_entrada_id: 'entrada',
    projeto_id: 42,
  });
  const theirs = await askAndAnswer(ctx, otherJob.id, text, 'Manter 0002');

  const mine = await createJob(ctx, { titulo: 'meu', no_entrada_id: 'entrada' });
  const queried = await askQuestion(ctx, mine.id, text);

  const response = await precedentsOf(ctx, queried.id);
  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.precedentes,
    [],
    "a precedent belongs to the asker's project; identical text does not pierce the isolation",
  );

  // And the mirror: whoever asks from the other side sees their own history.
  const fromThere = await askQuestion(ctx, otherJob.id, text);
  const theirPrecedents = await precedentsOf(ctx, fromThere.id);
  assert.deepEqual(
    theirPrecedents.body.precedentes.map((row) => row.id),
    [theirs.id],
  );
});

test('AT7 — limite cuts from the top of the ranking, and a value above the ceiling is clamped', async (t) => {
  requireArtifacts(...ARTIFACTS, SIMILARITY_ARTIFACT);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });

  const closest = await askAndAnswer(
    ctx,
    job.id,
    'Renumerar a migração para 0003?',
    'Manter 0002',
  );
  const further = await askAndAnswer(ctx, job.id, 'Renumerar tudo?', 'Não renumerar');

  const queried = await askQuestion(ctx, job.id, 'Renumerar a migração para 0004?');

  const both = await precedentsOf(ctx, queried.id);
  assert.equal(both.status, 200);
  assert.deepEqual(
    both.body.precedentes.map((row) => row.id),
    [closest.id, further.id],
    'the order is the score one, descending',
  );
  assert.ok(
    both.body.precedentes[0].similaridade > both.body.precedentes[1].similaridade,
    "the ranking is explainable from the response's own body",
  );

  const capped = await precedentsOf(ctx, queried.id, '?limite=1');
  assert.equal(capped.status, 200);
  assert.deepEqual(
    capped.body.precedentes.map((row) => row.id),
    [closest.id],
    'cutting by the limit cuts the tail, not the head',
  );

  // The limit is a screen-size knob, not a correctness rule: a value out of
  // range is clamped to the ceiling, and does not become a 400.
  const aboveCeiling = await precedentsOf(ctx, queried.id, '?limite=999');
  assert.equal(aboveCeiling.status, 200);
  assert.deepEqual(
    aboveCeiling.body.precedentes.map((row) => row.id),
    [closest.id, further.id],
  );

  const belowFloor = await precedentsOf(ctx, queried.id, '?limite=0');
  assert.equal(belowFloor.status, 200);
  assert.deepEqual(
    belowFloor.body.precedentes.map((row) => row.id),
    [closest.id],
    'zero and negative are clamped to the floor of 1, for the same reason',
  );
});

/** Reads one input request back through the listing (there is no GET by id). */
async function readBack(ctx: TestContext, jobId: number, id: number): Promise<InputRequest> {
  const response = await request<{ perguntas: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?trabalho_id=${jobId}`,
  );
  assert.equal(response.status, 200);
  const found = response.body.perguntas.find((item) => item.id === id);
  assert.ok(found !== undefined, `input request ${id} disappeared from the listing`);
  return found;
}

test('t149 AT1 — answering the same input request twice is a 409, and the first answer stands', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await askQuestion(ctx, job.id, 'Renumerar a migração para 0003?');

  const first = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.id}/answer`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );
  assert.equal(first.status, 200);

  const retry = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.id}/answer`,
    { resposta: 'Renumerar para 0003', respondido_por: 'outra-pessoa' },
  );
  assert.equal(retry.status, 409, 'the second answer is a conflict, never a silent overwrite');
  assert.equal(retry.body.error, 'conflict');
  assert.ok(
    retry.body.details.some((detail) => detail.includes('respondida')),
    `the 409 has to say what state refused it: ${JSON.stringify(retry.body.details)}`,
  );

  // The decision that stands is the FIRST one: an answer already acted upon
  // (the job went back to the queue) cannot be rewritten by whoever retried.
  const stored = await readBack(ctx, job.id, created.id);
  assert.equal(stored.resposta, 'Manter 0002');
  assert.equal(stored.respondido_por, 'rafael');
  assert.equal(stored.origem, 'usuario');
  assert.equal(stored.respondida_em, first.body.respondida_em);

  const events = getEventsByEntity(ctx.db, 'pergunta', created.id);
  assert.deepEqual(
    events.map((event) => event.tipo),
    ['pergunta.criada', 'pergunta.respondida'],
    'the refused retry writes NOTHING: no second answer event',
  );
});

test('t149 AT2 — /auto-resolution over an already answered input request is a 409 too', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const created = await askQuestion(ctx, job.id, 'Renumerar a migração para 0003?');

  const answered = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.id}/answer`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );
  assert.equal(answered.status, 200);

  // The hole is across the two routes, not inside one of them: both close the
  // same input request through the same helper.
  const auto = await request<{ error: string }>(
    ctx,
    'PATCH',
    `/v1/input-requests/${created.id}/auto-resolution`,
    { resposta: 'Manter 0002', baseada_em: 'resposta_padrao' },
  );
  assert.equal(auto.status, 409);
  assert.equal(auto.body.error, 'conflict');

  const stored = await readBack(ctx, job.id, created.id);
  assert.equal(
    stored.origem,
    'usuario',
    'a decision taken by a person never flips to "auto" afterwards — that is the audit',
  );
  assert.equal(stored.respondido_por, 'rafael');

  const events = getEventsByEntity(ctx.db, 'pergunta', created.id);
  assert.deepEqual(
    events.map((event) => event.tipo),
    ['pergunta.criada', 'pergunta.respondida'],
    'no pergunta.auto_resolvida contradicting the pergunta.respondida before it',
  );
});

test('t149 AT3 — a stale answer never unblocks a job that is waiting on another question', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { getEventsByEntity } = await loadEvents();

  const job = await createJob(ctx, { titulo: 'x', no_entrada_id: 'entrada' });

  const first = await askQuestion(ctx, job.id, 'Renumerar a migração para 0003?');
  const answered = await request<InputRequest>(
    ctx,
    'PATCH',
    `/v1/input-requests/${first.id}/answer`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );
  assert.equal(answered.status, 200);

  const unblocked = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(unblocked.body.bloqueado, false, 'the legitimate answer returned it to the queue');

  // The job asks something ELSE and stops again. This is the state the retry
  // must not touch.
  const second = await askQuestion(ctx, job.id, 'Qual engine adapter usar no despacho?');
  const blockedAgain = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(blockedAgain.body.bloqueado, true);
  assert.equal(blockedAgain.body.motivo_bloqueio, `aguardando resposta da pergunta ${second.id}`);

  const retry = await request<{ error: string }>(
    ctx,
    'PATCH',
    `/v1/input-requests/${first.id}/answer`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, 'conflict');

  const after = await request<Job>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(
    after.body.bloqueado,
    true,
    'answering an OLD question does not lower a flag raised by a new one',
  );
  assert.equal(
    after.body.motivo_bloqueio,
    `aguardando resposta da pergunta ${second.id}`,
    'the job is still waiting on the question nobody answered',
  );

  const jobEvents = getEventsByEntity(ctx.db, 'trabalho', job.id);
  assert.deepEqual(
    jobEvents.map((event) => event.tipo),
    [
      'trabalho.criado',
      'trabalho.bloqueado',
      'trabalho.desbloqueado',
      'trabalho.bloqueado',
    ],
    'exactly one unblock, and it is the legitimate one — the retry appends nothing',
  );
});

test('t149 AT4 — answering an input request that does not exist is still a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const answer = await request<{ error: string }>(
    ctx,
    'PATCH',
    '/v1/input-requests/98765/answer',
    { resposta: 'x', respondido_por: 'rafael' },
  );
  assert.equal(answer.status, 404, 'reading before writing did not turn a 404 into a 409');
  assert.equal(answer.body.error, 'not_found');

  const auto = await request<{ error: string }>(
    ctx,
    'PATCH',
    '/v1/input-requests/98765/auto-resolution',
    { resposta: 'x', baseada_em: 'resposta_padrao' },
  );
  assert.equal(auto.status, 404);
  assert.equal(auto.body.error, 'not_found');
});
