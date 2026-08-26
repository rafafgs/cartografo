/**
 * Acceptance tests of the question inbox (t107, FR8/FR9).
 *
 * The central point, and what tells this ticket apart from a mockup: the form
 * submit performs a REAL WRITE (`PATCH /v1/input-requests/:id/answer`) against
 * the real control plane. That is why the proof is not the HTML the screen
 * returns — it is an independent read made straight against the control plane,
 * through the public API, after the submit. A screen that "answered" only in
 * its own state would pass any test that settled for its own HTML.
 *
 * What this ticket deliberately does NOT demand: that answering RESUMES the
 * agent's session. The question → block → answer → unblock → resume wiring is
 * t106's acceptance criterion (the boundary is documented in
 * `packages/core/src/repositorios/pergunta.ts` and pinned by t102's AT11).
 * When t106 exists, this screen does not change a line.
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
  requireArtifacts,
  startControlPlane,
  startScreen,
  submitForm,
  type Question,
} from './support.ts';

const FULL_BODY = {
  question: 'Renumber the migration to 0003?',
  context: 't101 runs in parallel and owns the same numbering space.',
  options: ['Renumber to 0003', 'Keep 0002'],
  recommendation: 'Keep 0002 and renumber only if it collides on the merge.',
  default_answer: 'Keep 0002',
};

/** Reads the question straight from the control plane, bypassing the screen. */
async function readFromControlPlane(
  cp: Parameters<typeof api>[0],
  jobId: number,
  questionId: number,
): Promise<Question> {
  const response = await api<{ input_requests: Question[] }>(
    cp,
    'GET',
    `/v1/input-requests?trabalho_id=${jobId}`,
  );
  assert.equal(response.status, 200);
  const found = response.body.input_requests.find((question) => question.id === questionId);
  assert.ok(found !== undefined, `the control plane does not know question ${questionId}`);
  return found;
}

test('t107 AT6 — GET /input-requests shows the whole question, with what it takes to decide', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, {
    title: 'what a question',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  const question = await createQuestion(cp, { job_id: job.id, ...FULL_BODY });

  const answered = await createQuestion(cp, {
    job_id: job.id,
    question: 'this one was already decided',
  });
  await api(cp, 'PATCH', `/v1/input-requests/${answered.id}/answer`, {
    answer: 'yes',
    answered_by: 'rafael',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/input-requests');

  assert.equal(page.status, 200);
  const cards = blocks(page.html, 'pergunta');
  assert.deepEqual(
    cards.map((card) => card.value),
    [String(question.id)],
    'the queue is only what is pending',
  );

  const [card] = cards;
  assert.ok(card.excerpt.includes(FULL_BODY.question), 'shows the question');
  assert.ok(card.excerpt.includes(FULL_BODY.context), 'shows the context');
  assert.ok(card.excerpt.includes(FULL_BODY.recommendation), 'shows the recommendation');
  assert.ok(card.excerpt.includes(FULL_BODY.default_answer), 'shows the default answer');
  for (const option of FULL_BODY.options) {
    assert.ok(card.excerpt.includes(option), `shows the option "${option}"`);
  }
  assert.ok(
    card.excerpt.includes(`action="/input-requests/${question.id}/answer"`),
    'each question carries the form that answers it',
  );
  // t310: every label of the card, and the button, read in English.
  assert.ok(page.html.includes('<h2>pending questions · 1</h2>'), `the heading is not English:\n${page.html}`);
  for (const label of ['created at', 'context', 'recommendation', 'default answer', 'job']) {
    assert.ok(card.excerpt.includes(`<dt>${label}</dt>`), `the "${label}" label is missing:\n${card.excerpt}`);
  }
  assert.ok(card.excerpt.includes('>your answer</label>'), `the answer label is not English:\n${card.excerpt}`);
  assert.ok(card.excerpt.includes('who is answering'), `the author label is not English:\n${card.excerpt}`);
  assert.ok(
    card.excerpt.includes('<button type="submit">answer</button>'),
    `the submit button is not English:\n${card.excerpt}`,
  );

  assert.ok(card.excerpt.includes('method="post"'), 'answering is a write, and a write is a POST');
});

test('t107 AT6 — the submit answers FOR REAL in the control plane and leaves the queue', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, { title: 'with a question', entry_node_id: 'refinar' });
  const question = await createQuestion(cp, { job_id: job.id, ...FULL_BODY });

  const before = await readFromControlPlane(cp, job.id, question.id);
  assert.equal(before.status, 'pending');

  const screen = await startScreen(t, cp);
  const submission = await submitForm(screen, `/input-requests/${question.id}/answer`, {
    resposta: 'Keep 0002',
    respondido_por: 'rafael',
  });

  assert.equal(submission.status, 303, 'a POST that writes answers with a redirect');
  assert.equal(submission.location, '/input-requests', 'and goes back to the queue reloaded from the API');

  // The proof: an independent read, straight against the control plane. What
  // matters is that the STATE changed, not that the screen said it changed.
  const after = await readFromControlPlane(cp, job.id, question.id);
  assert.equal(after.status, 'answered');
  assert.equal(after.answer, 'Keep 0002');
  assert.equal(after.answered_by, 'rafael');
  assert.ok(after.answered_at !== null);

  const queue = await openPage(screen, '/input-requests');
  assert.equal(queue.status, 200);
  assert.deepEqual(
    blocks(queue.html, 'pergunta').map((card) => card.value),
    [],
    'it left the queue because the queue is re-read from the API, not because the form hid it',
  );
});

test('t107 AT6 — a blank answer is refused by the screen, with nothing written', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, { title: 'with a question', entry_node_id: 'refinar' });
  const question = await createQuestion(cp, { job_id: job.id, ...FULL_BODY });

  const screen = await startScreen(t, cp);
  const submission = await submitForm(screen, `/input-requests/${question.id}/answer`, {
    resposta: '   ',
    respondido_por: 'rafael',
  });

  assert.equal(submission.status, 400);
  // The event schema accepts an empty string; the one that has to stop the
  // accidental click is the screen, BEFORE a contentless fact reaches the log.
  const after = await readFromControlPlane(cp, job.id, question.id);
  assert.equal(after.status, 'pending', 'nothing was written');
});

test('t107 AT6 — answering a nonexistent question propagates the control plane 404', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const submission = await submitForm(screen, '/input-requests/424242/answer', {
    resposta: 'whatever it may be',
    respondido_por: 'rafael',
  });

  assert.equal(submission.status, 404, 'the screen does not invent success the API did not give');
});

test('t310 — an empty question queue says so in English', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/input-requests');

  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes('<p class="vazio">Nobody waiting for an answer. 🎉</p>'),
    `the empty state is missing or still Portuguese:\n${page.html}`,
  );
});

test('t310 — a blank answer is refused with an English page', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, { title: 'with a question', entry_node_id: 'refinar' });
  const question = await createQuestion(cp, { job_id: job.id, ...FULL_BODY });

  const screen = await startScreen(t, cp);
  // `submitForm` hands back status and Location only; the assertion here is
  // about the PAGE, so the request is made directly.
  const submission = await fetch(`${screen.url}/input-requests/${question.id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ resposta: '   ', respondido_por: 'rafael' }).toString(),
    redirect: 'manual',
  });

  assert.equal(submission.status, 400);
  const html = await submission.text();
  assert.ok(html.includes('<h2>blank answer</h2>'), `the refusal title is not English:\n${html}`);
  assert.ok(
    html.includes('Write the answer (or click one of the options) before sending.'),
    `the refusal detail is not English:\n${html}`,
  );
  assert.ok(html.includes('back to the board'), `the way out is not English:\n${html}`);
});
