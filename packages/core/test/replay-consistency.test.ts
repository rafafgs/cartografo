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
  const response = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);

  const history: string[] = [];
  for (const event of response.body.events) {
    if (event.type === 'job.created') history.push(event.data.entry_node_id as string);
    if (event.type === 'job.transitioned') history.push(event.data.to_node_id as string);
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
    title: 'trabalho que anda',
    entry_node_id: 'entrada',
    execution_id: EXECUTION,
    graph_version_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'refinamento',
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'desenvolvimento',
  });
  await request(ctx, 'PATCH', `/v1/jobs/${job.id}`, { title: 'título emendado' });

  const session = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'desenvolvimento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'implemente a ficha',
    timeout_seconds: 5400,
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    session_id: session.body.id,
    kind: 'question',
    question: 'renumerar a migração?',
    recommendation: 'manter 0002',
    auto_approvable: true,
  });
  assert.equal(inputRequest.status, 201);

  await request(ctx, 'PATCH', `/v1/input-requests/${inputRequest.body.id}/answer`, {
    answer: 'manter 0002',
    answered_by: 'rafael',
  });
  await request(ctx, 'PATCH', `/v1/sessions/${session.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });

  // A second job, blocked and auto-resolved: it covers the ends the main
  // sequence does not touch (blocked flag, automatic origin).
  const stopped = await createJob(ctx, {
    title: 'trabalho que para',
    entry_node_id: 'entrada',
    execution_id: EXECUTION,
    graph_version_id: 'v2',
  });
  const auto = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: stopped.id,
    kind: 'approval',
    question: 'aprova o artefato?',
    default_answer: 'aprovar',
    auto_approvable: true,
  });
  assert.equal(auto.status, 201);
  await request(ctx, 'PATCH', `/v1/input-requests/${auto.body.id}/auto-resolution`, {
    answer: 'aprovar',
    based_on: 'default_answer',
  });
  // The manual block comes AFTER the auto-resolution since t106: asking already
  // blocks and answering already unblocks (in the same transaction), so blocking
  // first would leave the job unblocked at the end and the "flag raised" end with
  // no coverage at all. The sequence as it is now exercises both origins of a
  // block — the automatic one from the escalation and the manual one.
  await request(ctx, 'POST', `/v1/jobs/${stopped.id}/blocks`, { reason: 'esperando humano' });
  const otherSession = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: EXECUTION,
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
  const jobs = await request<{ jobs: Job[] }>(
    ctx,
    'GET',
    `/v1/jobs?execution_id=${EXECUTION}`,
  );
  const sessions = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?execution_id=${EXECUTION}`,
  );
  const inputRequests = await request<{ input_requests: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?execution_id=${EXECUTION}`,
  );

  const projectedJobs: ReconstructedState['trabalhos'] = {};
  for (const row of jobs.body.jobs) {
    projectedJobs[String(row.id)] = {
      no_atual: row.current_node_id,
      bloqueado: row.blocked,
      historico_nos: await historyFromApi(ctx, row.id),
    };
  }

  const projectedSessions: ReconstructedState['sessoes'] = {};
  for (const row of sessions.body.sessions) {
    projectedSessions[String(row.id)] = { status: row.status, exit_code: row.exit_code };
  }

  // No translation layer any more (t227): the reducer's derived `status` and
  // `origem` are the same English words the API projection publishes, so the
  // comparison below is about REPLAY again and not about spelling. The two keys
  // that stay Portuguese — `perguntas` and `origem` — are the reducer's own
  // output shape, which no glossary row governs.
  const projectedInputRequests: ReconstructedState['perguntas'] = {};
  for (const row of inputRequests.body.input_requests) {
    projectedInputRequests[String(row.id)] = {
      status: row.status,
      resposta: row.answer,
      origem: row.source,
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
  assert.equal(state.sessoes[String(otherSession.body.id)].status, 'open');
});
