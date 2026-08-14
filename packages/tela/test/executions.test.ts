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
    titulo: 'primeiro da sete',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  await createJob(cp, {
    titulo: 'segundo da sete',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  await createJob(cp, { titulo: 'único da oito', no_entrada_id: 'refinar', execucao_id: 8 });

  await api(cp, 'POST', `/v1/jobs/${fromSeven.id}/blocks`, { motivo: 'travou' });
  await createQuestion(cp, { trabalho_id: fromSeven.id, pergunta: 'renumerar?' });

  const screen = await startScreen(t, cp.url);
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
    titulo: 'o trabalho da sete',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const fromEight = await createJob(cp, {
    titulo: 'o trabalho da oito',
    no_entrada_id: 'refinar',
    execucao_id: 8,
  });

  const sessionOfSeven = await openSession(cp, { trabalho_id: fromSeven.id, no_id: 'refinar' });
  const sessionOfEight = await openSession(cp, { trabalho_id: fromEight.id, no_id: 'refinar' });
  await api(cp, 'PATCH', `/v1/sessions/${sessionOfSeven.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
  });

  const questionOfSeven = await createQuestion(cp, {
    trabalho_id: fromSeven.id,
    pergunta: 'seguir pelo caminho curto?',
  });
  const questionOfEight = await createQuestion(cp, {
    trabalho_id: fromEight.id,
    pergunta: 'pergunta da outra execução',
  });

  const screen = await startScreen(t, cp.url);
  const page = await openPage(screen, '/execucoes/7');

  assert.equal(page.status, 200);
  assert.ok(page.html.includes(fromSeven.titulo), "the execution board shows that execution's job");
  assert.ok(!page.html.includes(fromEight.titulo), 'a job from another execution must not leak');

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
  assert.ok(sessions[0].excerpt.includes('concluida'), 'the session shows the status');
  assert.ok(
    sessions[0].excerpt.includes(sessionOfSeven.aberta_em),
    'the session shows when it opened',
  );

  const questions = blocks(page.html, 'pergunta');
  assert.deepEqual(
    questions.map((question) => question.value),
    [String(questionOfSeven.id)],
    'only the pending questions of that execution',
  );
  assert.ok(
    !page.html.includes(questionOfEight.pergunta),
    'a question from another execution does not leak',
  );
});

test('t107 AT5 — an execution with nothing in it is 200 with an empty page, not an error', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp.url);

  // An execution is an opaque grouper: there is no object to be missing (the
  // same reading `GET /v1/executions/:id/metrics-by-version` already makes).
  const page = await openPage(screen, '/execucoes/99');
  assert.equal(page.status, 200);
  assert.deepEqual(blocks(page.html, 'trabalho'), []);
});
