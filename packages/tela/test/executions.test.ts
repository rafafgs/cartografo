/**
 * Acceptance tests of the two execution screens (t107, FR6/FR7).
 *
 * The executions list only exists because the API gained `GET /v1/executions`
 * in this same ticket: `execucao_id` is an opaque grouper, and until now it
 * could only be queried by someone who already knew the id. D11 is explicit —
 * "if the screen needs something the API does not give, the bug is the API's" —
 * so the gap was closed in the core and the screen is one more client of it,
 * with no shortcut.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T107_ARTIFACTS,
  api,
  blocks,
  createJob,
  createQuestion,
  openPage,
  openSession,
  requireArtifacts,
  startControlPlane,
  startScreen,
} from './support.ts';

test('t107 AT5 — GET /execucoes lists the executions with the right counts', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const fromSeven = await createJob(cp, {
    title: 'primeiro da sete',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  await createJob(cp, {
    title: 'segundo da sete',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  await createJob(cp, { title: 'único da oito', entry_node_id: 'refinar', execution_id: 8 });

  await api(cp, 'POST', `/v1/jobs/${fromSeven.id}/blocks`, { reason: 'travou' });
  await createQuestion(cp, { job_id: fromSeven.id, question: 'renumerar?' });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/execucoes');

  assert.equal(page.status, 200);
  const rows = blocks(page.html, 'execucao');
  assert.deepEqual(
    rows.map((row) => row.value),
    ['7', '8'],
    'one row per execution, in ascending order',
  );

  const [seven, eight] = rows;
  assert.match(seven.excerpt, /data-campo="trabalhos">\s*2\s*</, 'seven has two jobs');
  assert.match(
    seven.excerpt,
    /data-campo="trabalhos_bloqueados">\s*1\s*</,
    'seven has one blocked job',
  );
  assert.match(
    seven.excerpt,
    /data-campo="perguntas_pendentes">\s*1\s*</,
    'seven has one pending question',
  );
  assert.match(eight.excerpt, /data-campo="trabalhos">\s*1\s*</);
  assert.match(eight.excerpt, /data-campo="trabalhos_bloqueados">\s*0\s*</);
  assert.match(eight.excerpt, /data-campo="perguntas_pendentes">\s*0\s*</);

  assert.ok(seven.excerpt.includes('href="/execucoes/7"'), 'each execution leads to its page');
});

test('t107 AT5 — GET /execucoes/:id slices jobs, sessions and questions of that execution', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const fromSeven = await createJob(cp, {
    title: 'o trabalho da sete',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  const fromEight = await createJob(cp, {
    title: 'o trabalho da oito',
    entry_node_id: 'refinar',
    execution_id: 8,
  });

  const sessionOfSeven = await openSession(cp, { job_id: fromSeven.id, node_id: 'refinar' });
  const sessionOfEight = await openSession(cp, { job_id: fromEight.id, node_id: 'refinar' });
  await api(cp, 'PATCH', `/v1/sessions/${sessionOfSeven.id}/finish`, {
    status: 'completed',
    exit_code: 0,
  });

  const questionOfSeven = await createQuestion(cp, {
    job_id: fromSeven.id,
    question: 'seguir pelo caminho curto?',
  });
  const questionOfEight = await createQuestion(cp, {
    job_id: fromEight.id,
    question: 'pergunta da outra execução',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/execucoes/7');

  assert.equal(page.status, 200);
  assert.ok(page.html.includes(fromSeven.title), "the execution board shows that execution's job");
  assert.ok(!page.html.includes(fromEight.title), 'a job from another execution must not leak');

  const sessions = blocks(page.html, 'sessao');
  assert.deepEqual(
    sessions.map((session) => session.value),
    [String(sessionOfSeven.id)],
    'only the sessions of that execution',
  );
  assert.ok(
    !page.html.includes(`data-sessao="${sessionOfEight.id}"`),
    'a session from another execution must not leak',
  );
  assert.ok(sessions[0].excerpt.includes('claude-code'), 'the session shows the engine');
  assert.ok(sessions[0].excerpt.includes('completed'), 'the session shows the status');
  assert.ok(
    sessions[0].excerpt.includes(sessionOfSeven.opened_at),
    'the session shows when it opened',
  );

  const questions = blocks(page.html, 'pergunta');
  assert.deepEqual(
    questions.map((question) => question.value),
    [String(questionOfSeven.id)],
    'only the pending questions of that execution',
  );
  assert.ok(
    !page.html.includes(questionOfEight.question),
    'a question from another execution does not leak',
  );
});

test('t159 — every session row links its transcript, on the API route the proxy forwards', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, {
    title: 'o que deixou saída para trás',
    entry_node_id: 'refinar',
    execution_id: 7,
  });

  const failed = await openSession(cp, { job_id: job.id, node_id: 'refinar' });
  const running = await openSession(cp, { job_id: job.id, node_id: 'implementar' });
  await api(cp, 'PATCH', `/v1/sessions/${failed.id}/finish`, {
    status: 'failed',
    exit_code: 1,
    transcript: 'erro: morri aqui, e sem isto ninguém sabe por quê',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/execucoes/7');
  assert.equal(page.status, 200);

  const rows = blocks(page.html, 'sessao');
  assert.deepEqual(
    rows.map((row) => row.value),
    [String(failed.id), String(running.id)],
    'both sessions of the execution are on the table',
  );

  // The still-open session gets a link too: the route answers for it as well,
  // and a link that appears only after the fact is a link nobody finds.
  for (const [index, session] of [failed, running].entries()) {
    assert.ok(
      rows[index].excerpt.includes(`data-transcricao="${session.id}"`),
      `session ${session.id} has no data-transcricao marker:\n${rows[index].excerpt}`,
    );
    assert.ok(
      rows[index].excerpt.includes(`href="/v1/sessions/${session.id}/transcript"`),
      `session ${session.id} does not link its transcript:\n${rows[index].excerpt}`,
    );
  }
});

test('t107 AT5 — an execution with nothing in it is 200 with an empty page, not an error', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  // An execution is an opaque grouper: there is no object to be missing (the
  // same reading `GET /v1/executions/:id/metrics-by-version` already makes).
  const page = await openPage(screen, '/execucoes/99');
  assert.equal(page.status, 200);
  assert.deepEqual(blocks(page.html, 'trabalho'), []);
});
