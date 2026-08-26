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

test('t107 AT5 — GET /executions lists the executions with the right counts', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const fromSeven = await createJob(cp, {
    title: 'first of the seven',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  await createJob(cp, {
    title: 'second of the seven',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  await createJob(cp, { title: 'only one of the eight', entry_node_id: 'refinar', execution_id: 8 });

  await api(cp, 'POST', `/v1/jobs/${fromSeven.id}/blocks`, { reason: 'stuck' });
  await createQuestion(cp, { job_id: fromSeven.id, question: 'renumber?' });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/executions');

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

  // t310: heading and table headers are what a person reads, and they read in
  // English now. The `data-campo` marker names above are not copy and did not
  // move (AC2).
  assert.ok(page.html.includes('<h2>executions</h2>'), `the heading is not English:\n${page.html}`);
  assert.ok(
    page.html.includes(
      '<thead><tr><th>execution</th><th>jobs</th><th>blocked</th><th>pending questions</th></tr></thead>',
    ),
    `the table headers are not English:\n${page.html}`,
  );

  assert.ok(seven.excerpt.includes('href="/executions/7"'), 'each execution leads to its page');
});

test('t107 AT5 — GET /executions/:id slices jobs, sessions and questions of that execution', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const fromSeven = await createJob(cp, {
    title: 'the job of the seven',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  const fromEight = await createJob(cp, {
    title: 'the job of the eight',
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
    question: 'take the short path?',
  });
  const questionOfEight = await createQuestion(cp, {
    job_id: fromEight.id,
    question: 'question of the other execution',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/executions/7');

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
    title: 'the one that left output behind',
    entry_node_id: 'refinar',
    execution_id: 7,
  });

  const failed = await openSession(cp, { job_id: job.id, node_id: 'refinar' });
  const running = await openSession(cp, { job_id: job.id, node_id: 'implementar' });
  await api(cp, 'PATCH', `/v1/sessions/${failed.id}/finish`, {
    status: 'failed',
    exit_code: 1,
    transcript: 'error: I died here, and without this nobody knows why',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/executions/7');
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
  const page = await openPage(screen, '/executions/99');
  assert.equal(page.status, 200);
  assert.deepEqual(blocks(page.html, 'trabalho'), []);
});

test('t310 — an executions list with nothing in it says so in English', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/executions');

  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes('<p class="vazio">No executions yet.</p>'),
    `the empty state is missing or still Portuguese:\n${page.html}`,
  );
});

test('t310 — a job with no execution, and a session still open, both read in English', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const loose = await createJob(cp, { title: 'nobody grouped me', entry_node_id: 'refinar' });
  const grouped = await createJob(cp, {
    title: 'the one being worked on',
    entry_node_id: 'refinar',
    execution_id: 11,
  });
  await openSession(cp, { job_id: grouped.id, node_id: 'refinar' });

  const screen = await startScreen(t, cp);

  const list = await openPage(screen, '/executions');
  assert.equal(list.status, 200);
  assert.ok(
    list.html.includes('<span class="vazio">no execution</span>'),
    `the "no execution" row label is not English:\n${list.html}`,
  );

  const page = await openPage(screen, '/executions/11');
  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes(
      '<thead><tr><th>session</th><th>job</th><th>engine</th><th>status</th><th>opened at</th><th>finished at</th><th>usage</th><th>transcript</th></tr></thead>',
    ),
    `the session table headers are not English:\n${page.html}`,
  );
  assert.ok(
    page.html.includes('<span class="vazio">in progress</span>'),
    `a session still open does not say so in English:\n${page.html}`,
  );
  assert.ok(page.html.includes('>see output</a>'), 'the transcript link text is not English');
  assert.ok(page.html.includes('<h2>sessions</h2>'), 'the sessions heading is not English');
  assert.ok(page.html.includes('<h2>pending questions</h2>'), 'the questions heading is not English');
  assert.ok(
    page.html.includes('<p class="vazio">Nobody waiting for an answer in this execution.</p>'),
    `the empty question queue is not English:\n${page.html}`,
  );
  assert.ok(loose.id > 0);
});
