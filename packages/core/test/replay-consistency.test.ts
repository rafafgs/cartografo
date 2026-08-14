/**
 * Proof of consistency between the log and the projection (t102, AT17 / FR19).
 *
 * The quality non-negotiable is replayability by event sourcing: the final state
 * has to come out of the LOG and of nothing else.
 * `reducers/reconstruir-estado.mjs` (t98) is the executable reference for that —
 * it was written before the control plane existed, precisely so it would be the
 * contract this ticket's projection tables would have to respect.
 *
 * This test closes the circle: it runs an execution through the API, folds the
 * log with the specification's reducer and demands that the result match, field
 * by field, what the tables answer. If one day the projection knows something
 * the log does not tell, this is where it shows up.
 *
 * The reducer's own state keys stay in Portuguese: it lives in `especificacoes/`,
 * outside this ticket's rename scope (t127, FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T102_ARTIFACTS,
  loadEvents,
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type TestContext,
  type Event,
  type InputRequest,
  type Session,
  type Job,
} from './support.ts';

/** The reducer lives in the specification, outside the package — it is the reference, not core code. */
const REDUCER = '../../../especificacoes/eventos/reducers/reconstruir-estado.mjs';

interface ReconstructedState {
  trabalhos: Record<string, { no_atual: string; bloqueado: boolean; historico_nos: string[] }>;
  sessoes: Record<string, { status: string; exit_code: number | null }>;
  perguntas: Record<
    string,
    { status: string; resposta: string | null; origem: string | null }
  >;
}

const EXECUTION = 7;

/** Node history of a job, derived only from the API (created + transitions). */
async function historyFromApi(ctx: TestContext, jobId: number): Promise<string[]> {
  const response = await request<{ eventos: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);

  const history: string[] = [];
  for (const event of response.body.eventos) {
    if (event.tipo === 'trabalho.criado') history.push(event.dados.no_entrada_id as string);
    if (event.tipo === 'trabalho.transicao') history.push(event.dados.para_no_id as string);
  }
  return history;
}

test('AT17 — the specification reducer reproduces the projection tables exactly', async (t) => {
  requireArtifacts(...Object.values(T102_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const { listEvents } = await loadEvents();
  const { reconstruirEstado } = (await import(new URL(REDUCER, import.meta.url).href)) as {
    reconstruirEstado: (events: Event[]) => ReconstructedState;
  };

  // --- the execution, end to end, through the API only ----------------------
  const job = await createJob(ctx, {
    titulo: 'trabalho que anda',
    no_entrada_id: 'entrada',
    execucao_id: EXECUTION,
    grafo_versao_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'refinamento',
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'desenvolvimento',
  });
  await request(ctx, 'PATCH', `/v1/jobs/${job.id}`, { titulo: 'título emendado' });

  const session = await request<Session>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
    no_id: 'desenvolvimento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'implemente a ficha',
    timeout_seconds: 5400,
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    sessao_id: session.body.id,
    tipo: 'pergunta',
    pergunta: 'renumerar a migração?',
    recomendacao: 'manter 0002',
    auto_aprovavel: true,
  });
  assert.equal(inputRequest.status, 201);

  await request(ctx, 'PATCH', `/v1/input-requests/${inputRequest.body.id}/answer`, {
    resposta: 'manter 0002',
    respondido_por: 'rafael',
  });
  await request(ctx, 'PATCH', `/v1/sessions/${session.body.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
    uso: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });

  // A second job, blocked and auto-resolved: it covers the ends the main
  // sequence does not touch (blocked flag, automatic origin).
  const stopped = await createJob(ctx, {
    titulo: 'trabalho que para',
    no_entrada_id: 'entrada',
    execucao_id: EXECUTION,
    grafo_versao_id: 'v2',
  });
  await request(ctx, 'POST', `/v1/jobs/${stopped.id}/blocks`, { motivo: 'esperando humano' });
  const auto = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: stopped.id,
    tipo: 'aprovacao',
    pergunta: 'aprova o artefato?',
    resposta_padrao: 'aprovar',
    auto_aprovavel: true,
  });
  assert.equal(auto.status, 201);
  await request(ctx, 'PATCH', `/v1/input-requests/${auto.body.id}/auto-resolution`, {
    resposta: 'aprovar',
    baseada_em: 'resposta_padrao',
  });
  const otherSession = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execucao_id: EXECUTION,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'sessão que fica aberta',
  });
  assert.equal(otherSession.status, 201);

  // --- the state, rebuilt from the log alone --------------------------------
  const events = listEvents(ctx.db);
  assert.ok(events.length > 0, 'the log cannot be empty');
  const state = reconstruirEstado(events);

  // --- the state, as the projection tables answer it ------------------------
  const jobs = await request<{ trabalhos: Job[] }>(
    ctx,
    'GET',
    `/v1/jobs?execucao_id=${EXECUTION}`,
  );
  const sessions = await request<{ sessoes: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execucao_id=${EXECUTION}`,
  );
  const inputRequests = await request<{ perguntas: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?execucao_id=${EXECUTION}`,
  );

  const projectedJobs: ReconstructedState['trabalhos'] = {};
  for (const row of jobs.body.trabalhos) {
    projectedJobs[String(row.id)] = {
      no_atual: row.no_atual,
      bloqueado: row.bloqueado,
      historico_nos: await historyFromApi(ctx, row.id),
    };
  }

  const projectedSessions: ReconstructedState['sessoes'] = {};
  for (const row of sessions.body.sessoes) {
    projectedSessions[String(row.id)] = { status: row.status, exit_code: row.exit_code };
  }

  const projectedInputRequests: ReconstructedState['perguntas'] = {};
  for (const row of inputRequests.body.perguntas) {
    projectedInputRequests[String(row.id)] = {
      status: row.status,
      resposta: row.resposta,
      origem: row.origem,
    };
  }

  // --- and the two have to be the same thing --------------------------------
  assert.deepEqual(state.trabalhos, projectedJobs);
  assert.deepEqual(state.sessoes, projectedSessions);
  assert.deepEqual(state.perguntas, projectedInputRequests);

  // Guards against an empty pass of the three deepEqual above.
  assert.equal(Object.keys(state.trabalhos).length, 2);
  assert.equal(Object.keys(state.sessoes).length, 2);
  assert.equal(Object.keys(state.perguntas).length, 2);
  assert.deepEqual(state.trabalhos[String(job.id)].historico_nos, [
    'entrada',
    'refinamento',
    'desenvolvimento',
  ]);
  assert.equal(state.trabalhos[String(stopped.id)].bloqueado, true);
  assert.equal(state.perguntas[String(auto.body.id)].origem, 'auto');
  assert.equal(state.sessoes[String(otherSession.body.id)].status, 'aberta');
});
