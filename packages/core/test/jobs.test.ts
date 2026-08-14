/**
 * Job acceptance tests (t102, AT1–AT7).
 *
 * The job is the "traveller" of the graph: it is born on an entry node, walks
 * through transitions, raises and lowers the blocked flag, and has its content
 * amended. Each of those facts is an event in the log (t98) — and it is the log,
 * not the table row, that these tests treat as the source of truth.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are in
 * English.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T102_ARTIFACTS,
  countEvents,
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type Event,
  type Job,
  type TestContext,
} from './support.ts';

const ARTIFACTS = [
  T102_ARTIFACTS.migration,
  T102_ARTIFACTS.events,
  T102_ARTIFACTS.validation,
  T102_ARTIFACTS.jobRepository,
  T102_ARTIFACTS.jobRoutes,
];

/** Events of a job, in log order. */
async function timeline(ctx: TestContext, jobId: number): Promise<Event[]> {
  const response = await request<{ eventos: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);
  return response.body.eventos;
}

test('AT1 — POST /v1/jobs creates the job and records trabalho.criado', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<Job>(ctx, 'POST', '/v1/jobs', {
    titulo: 'Entidades e API: trabalho, sessão, evento e pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  assert.equal(response.status, 201);
  const job = response.body;
  assert.ok(Number.isInteger(job.id) && job.id >= 1, 'id assigned by the server');
  assert.equal(job.no_atual, 'entrada', 'no_atual is born equal to no_entrada_id');
  assert.equal(job.no_entrada_id, 'entrada');
  assert.equal(job.bloqueado, false);
  assert.equal(job.motivo_bloqueio, null);
  assert.equal(job.execucao_id, 7);

  const events = await timeline(ctx, job.id);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.tipo, 'trabalho.criado');
  assert.ok(Number.isInteger(event.id) && event.id >= 1, 'the event id comes from the server');
  assert.deepEqual(event.entidade, { tipo: 'trabalho', id: job.id });
  assert.equal(event.execucao_id, 7);
  assert.ok(Number.isInteger(event.projeto_id));
  assert.ok(typeof event.ator.ref === 'string' && event.ator.ref.length > 0);
  assert.ok(['usuario', 'agente', 'sistema'].includes(event.ator.tipo));
  assert.ok(!Number.isNaN(Date.parse(event.ocorrido_em)), 'ocorrido_em is ISO 8601');
  assert.deepEqual(event.dados, {
    titulo: 'Entidades e API: trabalho, sessão, evento e pergunta',
    no_entrada_id: 'entrada',
  });
});

test('AT2 — POST /v1/jobs/:id/transitions walks the graph and records trabalho.transicao', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'andar', no_entrada_id: 'entrada' });

  const first = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'implementacao',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.no_atual, 'implementacao');

  const second = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'revisao',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.no_atual, 'revisao');

  const transitions = (await timeline(ctx, job.id)).filter(
    (event) => event.tipo === 'trabalho.transicao',
  );
  assert.equal(transitions.length, 2);
  assert.deepEqual(
    transitions[0].dados,
    { de_no_id: null, para_no_id: 'implementacao' },
    'on the first transition the job leaves the entry node: de_no_id is null',
  );
  assert.deepEqual(transitions[1].dados, { de_no_id: 'implementacao', para_no_id: 'revisao' });
});

test('AT3 — block and unblock move the flag and record both events', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'parar', no_entrada_id: 'entrada' });

  const blocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    motivo: 'esperando resposta do humano',
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.bloqueado, true);
  assert.equal(blocked.body.motivo_bloqueio, 'esperando resposta do humano');
  assert.equal(blocked.body.no_atual, 'entrada', 'blocking does not move the job across nodes');

  const unblocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/unblocks`, {});
  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.body.bloqueado, false);
  assert.equal(unblocked.body.motivo_bloqueio, null);

  const events = await timeline(ctx, job.id);
  const flags = events.filter((event) =>
    ['trabalho.bloqueado', 'trabalho.desbloqueado'].includes(event.tipo),
  );
  assert.deepEqual(
    flags.map((event) => event.tipo),
    ['trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  assert.deepEqual(flags[0].dados, { motivo: 'esperando resposta do humano' });
  assert.deepEqual(flags[1].dados, {}, 'the fact is the fall of the flag itself: no payload');
});

test('AT4 — PATCH /v1/jobs/:id amends the title and records only the field NAME', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'título velho', no_entrada_id: 'entrada' });

  const response = await request<Job>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    titulo: 'título novo, com segredo dentro',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.titulo, 'título novo, com segredo dentro');

  const amendments = (await timeline(ctx, job.id)).filter(
    (event) => event.tipo === 'trabalho.emendado',
  );
  assert.equal(amendments.length, 1);
  assert.deepEqual(amendments[0].dados, { campos_alterados: ['titulo'] });
  assert.ok(
    !JSON.stringify(amendments[0].dados).includes('segredo'),
    'the log says what was touched, never the new content (taxonomy: audit record)',
  );
});

test('AT5 — GET /v1/jobs returns the current board, with a per-execution filter', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const one = await createJob(ctx, {
    titulo: 'na execução 7, versão v1',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/transitions`, { para_no_id: 'implementacao' });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/blocks`, { motivo: 'travou' });

  const two = await createJob(ctx, {
    titulo: 'na execução 8',
    no_entrada_id: 'entrada',
    execucao_id: 8,
  });

  const all = await request<{ trabalhos: Job[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(all.status, 200);
  assert.equal(all.body.trabalhos.length, 2, 'one job per row');

  const board = all.body.trabalhos.find((row) => row.id === one.id);
  assert.ok(board !== undefined);
  assert.equal(board.no_atual, 'implementacao');
  assert.equal(board.bloqueado, true);
  assert.equal(board.execucao_id, 7);
  assert.equal(board.grafo_versao_id, 'v1');

  const filtered = await request<{ trabalhos: Job[] }>(ctx, 'GET', '/v1/jobs?execucao_id=8');
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filtered.body.trabalhos.map((row) => row.id),
    [two.id],
  );
});

test('AT6 — GET /v1/jobs/:id/events is the timeline, in id order', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.sessionRoutes, T102_ARTIFACTS.inputRequestRoutes);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, {
    titulo: 'com sessão e pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const neighbour = await createJob(ctx, {
    titulo: 'o do lado, que não pode vazar',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'refinamento' });

  const session = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine o trabalho',
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    sessao_id: session.body.id,
    tipo: 'pergunta',
    pergunta: 'renumerar a migração?',
    auto_aprovavel: false,
  });
  assert.equal(inputRequest.status, 201);

  // Neighbour noise: same execution, same event type, another job.
  await request(ctx, 'POST', '/v1/sessions', {
    trabalho_id: neighbour.id,
    engine: 'claude-code',
    working_dir: '/tmp/vizinho',
    prompt: 'outra coisa',
  });

  const events = await timeline(ctx, job.id);
  assert.deepEqual(
    events.map((event) => event.tipo),
    ['trabalho.criado', 'trabalho.transicao', 'sessao.aberta', 'pergunta.criada'],
    'the job ones plus the session/input-request ones that cite it via dados.trabalho_id',
  );
  assert.deepEqual(
    [...events].sort((a, b) => a.id - b.id).map((event) => event.id),
    events.map((event) => event.id),
    'the order is the one of the event id',
  );
  assert.equal(
    events[2].entidade.id,
    session.body.id,
    'entidade.id is the session one, not the job one',
  );
  assert.equal(events[3].entidade.id, inputRequest.body.id);
});

test('AT7 — transition/block against a nonexistent job is 404 and records no event', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'o único', no_entrada_id: 'entrada' });
  const before = countEvents(ctx);

  const missing = job.id + 999;
  for (const [routePath, body] of [
    [`/v1/jobs/${missing}/transitions`, { para_no_id: 'implementacao' }],
    [`/v1/jobs/${missing}/blocks`, { motivo: 'travou' }],
    [`/v1/jobs/${missing}/unblocks`, {}],
  ] as const) {
    const response = await request(ctx, 'POST', routePath, body);
    assert.equal(response.status, 404, `${routePath} should have been 404`);
  }

  const patch = await request(ctx, 'PATCH', `/v1/jobs/${missing}`, { titulo: 'x' });
  assert.equal(patch.status, 404);

  assert.equal(countEvents(ctx), before, 'no event recorded for a job that does not exist');
});

test('FR3 — a body without a required field answers 400 and records no event', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const before = countEvents(ctx);

  const withoutEntryNode = await request(ctx, 'POST', '/v1/jobs', { titulo: 'sem nó de entrada' });
  assert.equal(withoutEntryNode.status, 400);

  const withoutTitle = await request(ctx, 'POST', '/v1/jobs', { no_entrada_id: 'entrada' });
  assert.equal(withoutTitle.status, 400);

  const job = await createJob(ctx, { titulo: 'válido', no_entrada_id: 'entrada' });
  const afterValid = countEvents(ctx);

  const withoutTarget = await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {});
  assert.equal(withoutTarget.status, 400);

  const withoutReason = await request(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {});
  assert.equal(withoutReason.status, 400);

  assert.equal(countEvents(ctx), afterValid, 'an invalid request leaves no trace in the log');
  assert.equal(afterValid, before + 1, 'only the valid job recorded an event');
});

test('t127 — the old Portuguese job paths no longer exist', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'renomeado', no_entrada_id: 'entrada' });

  for (const [method, routePath] of [
    ['POST', '/v1/trabalhos'],
    ['GET', '/v1/trabalhos'],
    ['GET', `/v1/trabalhos/${job.id}`],
    ['GET', `/v1/trabalhos/${job.id}/eventos`],
    ['POST', `/v1/trabalhos/${job.id}/transicoes`],
    ['POST', `/v1/trabalhos/${job.id}/bloqueios`],
    ['POST', `/v1/trabalhos/${job.id}/desbloqueios`],
    ['PATCH', `/v1/trabalhos/${job.id}`],
  ] as const) {
    const response = await request(ctx, method, routePath, {});
    assert.equal(response.status, 404, `${method} ${routePath} should be gone (D18)`);
  }
});
