/**
 * Acceptance tests of a job's timeline (t107, FR10).
 *
 * The concept is flowpilot's t81 "generic time", cited in the ticket's scope
 * and in `notas/2026-08-14-aprendizado.md`: splitting a job's time into QUEUE,
 * AGENT WORKING and WAITING FOR A HUMAN. Without that split, "it took two days"
 * says nothing — and it is exactly what the surveyor will read when it comes to
 * propose a graph mutation.
 *
 * The reconstruction happens in the SCREEN, out of three HTTP answers, because
 * no API route hands it over ready-made:
 *
 * - `GET /v1/jobs/:id/events` gives the transitions, but deliberately EXCLUDES
 *   `sessao.finalizada` and `pergunta.respondida` (those event schemas carry no
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

test('t107 AT7 — GET /trabalhos/:id builds queue, agent and human in chronological order', async (t) => {
  requireArtifacts(
    T107_ARTIFACTS.client,
    T107_ARTIFACTS.timeline,
    T107_ARTIFACTS.pages,
    T107_ARTIFACTS.router,
  );
  const cp = await startControlPlane(t);

  const job = await createJob(cp, {
    titulo: 'o trabalho observado',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });

  await wait(SLACK_MS);
  await api(cp, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'implementar' });

  await wait(SLACK_MS);
  const session = await openSession(cp, { trabalho_id: job.id, no_id: 'implementar' });

  await wait(SLACK_MS);
  const finished = await api<Session>(cp, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
  });
  assert.equal(finished.status, 200);

  await wait(SLACK_MS);
  const question = await createQuestion(cp, {
    trabalho_id: job.id,
    pergunta: 'seguir assim?',
  });

  await wait(SLACK_MS);
  const answered = await api<Question>(cp, 'PATCH', `/v1/input-requests/${question.id}/answer`, {
    resposta: 'siga',
    respondido_por: 'rafael',
  });
  assert.equal(answered.status, 200);

  const screen = await startScreen(t, cp.url);
  const page = await openPage(screen, `/trabalhos/${job.id}`);

  assert.equal(page.status, 200);
  assert.ok(page.html.includes(job.titulo), 'the page identifies itself by the job');

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
    job.criado_em,
    'the timeline starts when the job came into existence',
  );

  const agentSegments = segments.filter((segment) => segment.category === 'agente_trabalhando');
  assert.deepEqual(
    agentSegments,
    [
      {
        category: 'agente_trabalhando',
        start: session.aberta_em,
        end: finished.body.finalizada_em ?? '',
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
        start: question.criada_em,
        end: answered.body.respondida_em ?? '',
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
        segment.start === finished.body.finalizada_em &&
        segment.end === question.criada_em,
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

test('t107 AT7 — a nonexistent job is a 404 on the screen', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp.url);

  const page = await openPage(screen, '/trabalhos/424242');
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
        tipo: 'trabalho.criado',
        ocorrido_em: instant(0),
        dados: { titulo: 'x', no_entrada_id: 'refinar' },
      },
      {
        id: 2,
        tipo: 'trabalho.transicao',
        ocorrido_em: instant(10),
        dados: { de_no_id: null, para_no_id: 'implementar' },
      },
      { id: 3, tipo: 'sessao.aberta', ocorrido_em: instant(20), dados: { trabalho_id: 1 } },
      { id: 4, tipo: 'pergunta.criada', ocorrido_em: instant(40), dados: { trabalho_id: 1 } },
    ],
    sessions: [
      {
        id: 1,
        engine: 'claude-code',
        status: 'concluida',
        aberta_em: instant(20),
        finalizada_em: instant(30),
      },
    ],
    questions: [
      {
        id: 1,
        status: 'respondida',
        pergunta: 'e aí?',
        criada_em: instant(40),
        respondida_em: instant(50),
      },
    ],
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
        tipo: 'trabalho.criado',
        ocorrido_em: instant(0),
        dados: { titulo: 'x', no_entrada_id: 'refinar' },
      },
      { id: 2, tipo: 'sessao.aberta', ocorrido_em: instant(10), dados: { trabalho_id: 1 } },
      { id: 3, tipo: 'pergunta.criada', ocorrido_em: instant(20), dados: { trabalho_id: 1 } },
    ],
    sessions: [
      {
        id: 1,
        engine: 'claude-code',
        status: 'aberta',
        aberta_em: instant(10),
        finalizada_em: null,
      },
    ],
    questions: [
      {
        id: 1,
        status: 'pendente',
        pergunta: 'e aí?',
        criada_em: instant(20),
        respondida_em: null,
      },
    ],
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
        tipo: 'trabalho.criado',
        ocorrido_em: instant(0),
        dados: { titulo: 'x', no_entrada_id: 'refinar' },
      },
      { id: 2, tipo: 'trabalho.bloqueado', ocorrido_em: instant(5), dados: { motivo: 'travou' } },
    ],
    sessions: [],
    questions: [],
  });

  assert.equal(timeline.blocked, true);
  assert.equal(timeline.done, false, 'blocked is not done, even with nothing open');
  assert.deepEqual(
    timeline.segments.map((segment) => [segment.category, segment.start, segment.end]),
    [['fila', instant(0), null]],
    'with nothing open and no completion, the current queue goes on running',
  );
});
