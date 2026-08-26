/**
 * Acceptance tests of a job's timeline (t107, FR10).
 *
 * The concept is flowpilot's t81 "generic time", cited in the ticket's scope
 * and in `notes/2026-08-14-learning.md`: splitting a job's time into QUEUE,
 * AGENT WORKING and WAITING FOR A HUMAN. Without that split, "it took two days"
 * says nothing — and it is exactly what the surveyor will read when it comes to
 * propose a graph mutation.
 *
 * The reconstruction happens in the SCREEN, out of three HTTP answers, because
 * no API route hands it over ready-made:
 *
 * - `GET /v1/jobs/:id/events` gives the transitions, but deliberately EXCLUDES
 *   `session.finished` and `input_request.answered` (those event schemas carry no
 *   `trabalho_id`; see `packages/core/src/db/eventos.ts`);
 * - `GET /v1/sessions?trabalho_id=` gives the end of the sessions;
 * - `GET /v1/input-requests?trabalho_id=` gives the end of the waits.
 *
 * Both `trabalho_id` filters are an API gap closed in this same ticket.
 *
 * This file demands both halves: the real end-to-end scenario, and the
 * three-bucket rule as a pure function with fabricated instants — the only way
 * to pin the cutting policy without depending on the clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import type * as TimelineModule from '../src/timeline.ts';

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
  type Question,
  type Session,
} from './support.ts';

/**
 * Slack between the scenario's steps.
 *
 * The control plane's timestamps have millisecond precision; two back-to-back
 * requests can land on the SAME instant and collapse a segment to zero. The
 * slack is not there to "give time" for anything — it is so the scenario really
 * has the intervals the test claims exist.
 */
const SLACK_MS = 15;

/** A segment as the page publishes it. */
interface RenderedSegment {
  category: string;
  start: string;
  end: string;
}

function segmentsOf(html: string): RenderedSegment[] {
  return blocks(html, 'segmento').map((block) => ({
    category: block.value,
    start: /data-inicio="([^"]*)"/.exec(block.excerpt)?.[1] ?? '',
    end: /data-fim="([^"]*)"/.exec(block.excerpt)?.[1] ?? '',
  }));
}

test('t107 AT7 — GET /jobs/:id builds queue, agent and human in chronological order', async (t) => {
  requireArtifacts(
    T107_ARTIFACTS.client,
    T107_ARTIFACTS.timeline,
    T107_ARTIFACTS.pages,
    T107_ARTIFACTS.router,
  );
  const cp = await startControlPlane(t);

  const job = await createJob(cp, {
    title: 'o trabalho observado',
    entry_node_id: 'refinar',
    execution_id: 7,
  });

  await wait(SLACK_MS);
  await api(cp, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'implementar' });

  await wait(SLACK_MS);
  const session = await openSession(cp, { job_id: job.id, node_id: 'implementar' });

  await wait(SLACK_MS);
  const finished = await api<Session>(cp, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(finished.status, 200);

  await wait(SLACK_MS);
  const question = await createQuestion(cp, {
    job_id: job.id,
    question: 'seguir assim?',
  });

  await wait(SLACK_MS);
  const answered = await api<Question>(cp, 'PATCH', `/v1/input-requests/${question.id}/answer`, {
    answer: 'siga',
    answered_by: 'rafael',
  });
  assert.equal(answered.status, 200);

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, `/jobs/${job.id}`);

  assert.equal(page.status, 200);
  assert.ok(page.html.includes(job.title), 'the page identifies itself by the job');

  const segments = segmentsOf(page.html);
  assert.ok(segments.length >= 3, `expected at least three segments, got ${segments.length}`);

  const categories = segments.map((segment) => segment.category);
  assert.ok(categories.includes('fila'), 'the queue bucket is missing');
  assert.ok(categories.includes('agente_trabalhando'), 'the agent-working bucket is missing');
  assert.ok(categories.includes('esperando_humano'), 'the waiting-for-human bucket is missing');

  assert.equal(categories[0], 'fila', 'every job starts out waiting for someone to pick it up');
  assert.ok(
    categories.indexOf('agente_trabalhando') < categories.indexOf('esperando_humano'),
    'the agent worked BEFORE the question existed: the order is the order of the facts',
  );

  const instants = segments.map((segment) => segment.start);
  assert.deepEqual(instants, [...instants].sort(), 'the segments come out in chronological order');
  assert.equal(
    segments[0].start,
    job.created_at,
    'the timeline starts when the job came into existence',
  );

  const agentSegments = segments.filter((segment) => segment.category === 'agente_trabalhando');
  assert.deepEqual(
    agentSegments,
    [
      {
        category: 'agente_trabalhando',
        start: session.opened_at,
        end: finished.body.finished_at ?? '',
      },
    ],
    "the agent bucket is exactly the session's [aberta_em, finalizada_em]",
  );

  const humanSegments = segments.filter((segment) => segment.category === 'esperando_humano');
  assert.deepEqual(
    humanSegments,
    [
      {
        category: 'esperando_humano',
        start: question.created_at,
        end: answered.body.answered_at ?? '',
      },
    ],
    "the human bucket is exactly the question's [criada_em, respondida_em]",
  );

  // The interval between the agent finishing and the question being born is
  // nobody's work: it is queue. It is the segment that only exists because the
  // three sources were crossed — the events route alone does not know when the
  // session ended.
  assert.ok(
    segments.some(
      (segment) =>
        segment.category === 'fila' &&
        segment.start === finished.body.finished_at &&
        segment.end === question.created_at,
    ),
    'the gap between the end of the session and the creation of the question is queue',
  );

  // No database read: the screen has no way to. The static proof is
  // `no-privileged-access.test.ts` (AT16–AT18), which runs over the whole package.
  assert.ok(
    !page.html.includes('cartografo.db'),
    'the screen does not know — nor mention — the database file',
  );
});

test('t152 — GET /jobs/:id on a freshly created job says "in progress", never "done"', async (t) => {
  requireArtifacts(
    T107_ARTIFACTS.client,
    T107_ARTIFACTS.timeline,
    T107_ARTIFACTS.pages,
    T107_ARTIFACTS.router,
  );
  const cp = await startControlPlane(t);

  // Nothing but `job.created`: no session, no question, no graph version.
  // It is the most common state on a board — and the one the old heuristic
  // reported as finished, because "nothing is open" was read as "it is over".
  const job = await createJob(cp, { title: 'just born', entry_node_id: 'refinar' });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, `/jobs/${job.id}`);

  assert.equal(page.status, 200);
  assert.doesNotMatch(
    page.html,
    /\bdone\b/,
    'a job one event old was never finished, and the screen must not say so',
  );
  assert.ok(page.html.includes('in progress'), 'it is waiting for someone: that is what it shows');

  // t310: the three bucket names are NOT copy. They are `data-segmento` values
  // and the visible label of each row at once — the DOM/structural contract the
  // founder reserved for himself — so they stay Portuguese while the state word
  // beside them moves to English.
  assert.ok(page.html.includes('<h2>timeline</h2>'), `the timeline heading is not English:\n${page.html}`);
  assert.ok(page.html.includes('<h2>totals</h2>'), `the totals heading is not English:\n${page.html}`);
  assert.ok(
    page.html.includes('<thead><tr><th>bucket</th><th>closed time</th></tr></thead>'),
    `the totals headers are not English:\n${page.html}`,
  );
  for (const bucket of ['fila', 'agente trabalhando', 'esperando humano']) {
    assert.ok(
      page.html.includes(`<td>${bucket}</td>`),
      `the bucket label "${bucket}" moved; t310 leaves SegmentCategory exactly as it is`,
    );
  }
});

test('t310 — a done job says "done", and a blocked one says why, both in English', async (t) => {
  requireArtifacts(
    T107_ARTIFACTS.client,
    T107_ARTIFACTS.timeline,
    T107_ARTIFACTS.pages,
    T107_ARTIFACTS.router,
  );
  const cp = await startControlPlane(t);

  const blocked = await createJob(cp, { title: 'parked', entry_node_id: 'refinar' });
  await api(cp, 'POST', `/v1/jobs/${blocked.id}/blocks`, { reason: 'the founder has to decide' });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, `/jobs/${blocked.id}`);

  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes('blocked — the founder has to decide'),
    `the blocked state is not English:\n${page.html}`,
  );
  assert.ok(page.html.includes('current node'), `the node label is not English:\n${page.html}`);
  assert.ok(
    page.html.includes('<span class="vazio">no execution</span>'),
    `a job outside any execution does not say so in English:\n${page.html}`,
  );

  // The 404 page of a job that does not exist is the same claim, one route over.
  const missing = await openPage(screen, '/jobs/424242');
  assert.equal(missing.status, 404);
  assert.ok(missing.html.includes('<h2>job not found</h2>'), `the 404 title is not English:\n${missing.html}`);
  assert.ok(
    missing.html.includes('There is no job #424242.'),
    `the 404 detail is not English:\n${missing.html}`,
  );
});

test('t107 AT7 — a nonexistent job is a 404 on the screen', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/jobs/424242');
  assert.equal(page.status, 404, 'a job is an entity: absence is a 404, not an empty page');
});

test('t107 AT7 — the three-bucket rule, as a pure function', async () => {
  requireArtifacts(T107_ARTIFACTS.timeline);
  const { buildTimeline } = (await import(
    new URL('../src/timeline.ts', import.meta.url).href
  )) as typeof TimelineModule;

  const instant = (minute: number): string =>
    `2026-08-14T10:${String(minute).padStart(2, '0')}:00.000Z`;

  const timeline = buildTimeline({
    events: [
      {
        id: 1,
        type: 'job.created',
        occurred_at: instant(0),
        data: { title: 'x', entry_node_id: 'refinar' },
      },
      {
        id: 2,
        type: 'job.transitioned',
        occurred_at: instant(10),
        data: { from_node_id: null, to_node_id: 'implementar' },
      },
      { id: 3, type: 'session.opened', occurred_at: instant(20), data: { job_id: 1 } },
      { id: 4, type: 'input_request.created', occurred_at: instant(40), data: { job_id: 1 } },
    ],
    sessions: [
      {
        id: 1,
        engine: 'claude-code',
        status: 'completed',
        opened_at: instant(20),
        finished_at: instant(30),
      },
    ],
    questions: [
      {
        id: 1,
        status: 'respondida',
        question: 'well then?',
        created_at: instant(40),
        answered_at: instant(50),
      },
    ],
    // The server's answer, not a re-derivation here (t152): the job walked to a
    // final node of its graph version, and that is the only terminal signal
    // this system has.
    completed: true,
  });

  assert.deepEqual(
    timeline.segments.map((segment) => [segment.category, segment.start, segment.end]),
    [
      ['fila', instant(0), instant(10)],
      ['fila', instant(10), instant(20)],
      ['agente_trabalhando', instant(20), instant(30)],
      ['fila', instant(30), instant(40)],
      ['esperando_humano', instant(40), instant(50)],
    ],
    'queue is the complement: every interval with no open session and no pending question',
  );

  assert.deepEqual(
    timeline.segments.filter((segment) => segment.category === 'fila').map((s) => s.nodeId),
    ['refinar', 'implementar', 'implementar'],
    'each queue knows which node the job was parked on — a transition cuts the segment',
  );

  assert.equal(timeline.done, true, 'no open session, nothing pending and no block');
  assert.deepEqual(timeline.totals, {
    fila: 30 * 60_000,
    agente_trabalhando: 10 * 60_000,
    esperando_humano: 10 * 60_000,
  });
});

test('t107 AT7 — an open session and a pending question stay open, and the job is not done', async () => {
  requireArtifacts(T107_ARTIFACTS.timeline);
  const { buildTimeline } = (await import(
    new URL('../src/timeline.ts', import.meta.url).href
  )) as typeof TimelineModule;

  const instant = (minute: number): string =>
    `2026-08-14T10:${String(minute).padStart(2, '0')}:00.000Z`;

  const timeline = buildTimeline({
    events: [
      {
        id: 1,
        type: 'job.created',
        occurred_at: instant(0),
        data: { title: 'x', entry_node_id: 'refinar' },
      },
      { id: 2, type: 'session.opened', occurred_at: instant(10), data: { job_id: 1 } },
      { id: 3, type: 'input_request.created', occurred_at: instant(20), data: { job_id: 1 } },
    ],
    sessions: [
      {
        id: 1,
        engine: 'claude-code',
        status: 'aberta',
        opened_at: instant(10),
        finished_at: null,
      },
    ],
    questions: [
      {
        id: 1,
        status: 'pendente',
        question: 'well then?',
        created_at: instant(20),
        answered_at: null,
      },
    ],
    completed: false,
  });

  assert.deepEqual(
    timeline.segments.map((segment) => [segment.category, segment.start, segment.end]),
    [
      ['fila', instant(0), instant(10)],
      ['agente_trabalhando', instant(10), null],
      ['esperando_humano', instant(20), null],
    ],
    'what did not finish stays open, and is not closed with the reader\'s clock',
  );
  assert.equal(timeline.done, false);
  assert.deepEqual(
    timeline.totals,
    { fila: 10 * 60_000, agente_trabalhando: 0, esperando_humano: 0 },
    'an open segment does not enter the total: its duration is not a fact yet',
  );
});

test('t107 AT7 — a blocked, parked job keeps accruing queue, left open', async () => {
  requireArtifacts(T107_ARTIFACTS.timeline);
  const { buildTimeline } = (await import(
    new URL('../src/timeline.ts', import.meta.url).href
  )) as typeof TimelineModule;

  const instant = (minute: number): string =>
    `2026-08-14T10:${String(minute).padStart(2, '0')}:00.000Z`;

  const timeline = buildTimeline({
    events: [
      {
        id: 1,
        type: 'job.created',
        occurred_at: instant(0),
        data: { title: 'x', entry_node_id: 'refinar' },
      },
      { id: 2, type: 'job.blocked', occurred_at: instant(5), data: { reason: 'travou' } },
    ],
    sessions: [],
    questions: [],
    completed: false,
  });

  assert.equal(timeline.blocked, true);
  assert.equal(timeline.done, false, 'blocked is not done, even with nothing open');
  assert.deepEqual(
    timeline.segments.map((segment) => [segment.category, segment.start, segment.end]),
    [['fila', instant(0), null]],
    'with nothing open and no completion, the current queue goes on running',
  );
});

test('t152 — a job one event old is not done: nothing open is not the same as finished', async () => {
  requireArtifacts(T107_ARTIFACTS.timeline);
  const { buildTimeline } = (await import(
    new URL('../src/timeline.ts', import.meta.url).href
  )) as typeof TimelineModule;

  const timeline = buildTimeline({
    events: [
      {
        id: 1,
        type: 'job.created',
        occurred_at: '2026-08-15T10:00:00.000Z',
        data: { title: 'x', entry_node_id: 'redigir' },
      },
    ],
    sessions: [],
    questions: [],
    completed: false,
  });

  assert.equal(
    timeline.done,
    false,
    'a job that only exists has nothing open BECAUSE nothing has started — that is waiting, not done',
  );
  assert.deepEqual(
    timeline.segments.map((segment) => [segment.category, segment.start, segment.end]),
    [['fila', '2026-08-15T10:00:00.000Z', null]],
    'and the queue it is sitting in goes on running, in the open',
  );
});

test('t152 — concluído from the server is necessary, never sufficient: an open session keeps the job open', async () => {
  requireArtifacts(T107_ARTIFACTS.timeline);
  const { buildTimeline } = (await import(
    new URL('../src/timeline.ts', import.meta.url).href
  )) as typeof TimelineModule;

  const instant = (minute: number): string =>
    `2026-08-15T10:${String(minute).padStart(2, '0')}:00.000Z`;

  const timeline = buildTimeline({
    events: [
      {
        id: 1,
        type: 'job.created',
        occurred_at: instant(0),
        data: { title: 'x', entry_node_id: 'revisar' },
      },
      { id: 2, type: 'session.opened', occurred_at: instant(10), data: { job_id: 1 } },
    ],
    sessions: [
      {
        id: 1,
        engine: 'claude-code',
        status: 'aberta',
        opened_at: instant(10),
        finished_at: null,
      },
    ],
    questions: [],
    completed: true,
  });

  assert.equal(
    timeline.done,
    false,
    'somebody is still holding the job: what the projection says about the node does not close it',
  );
});
