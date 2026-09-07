/**
 * Acceptance tests for the draft a running session is writing (t465, FR1–FR4).
 *
 * The interview's left column said the one word "thinking" for the whole of a
 * turn that can take four minutes, while the session was writing the map the
 * entire time. What was missing was never the transport — `/interview/:id`
 * has polled every three seconds since t433 — but a place to put the text: the
 * runner buffered every line and the control plane never saw one of them until
 * the closure.
 *
 * `session.partial_text` is that place, and everything about it follows from
 * what it is: the freshest value of something nobody replays.
 *
 * - **it is never an event.** `renewLease` already writes a column dozens of
 *   times a minute with no append-only counterpart, for the same reason — an
 *   append-only log answers "what happened", and a draft overwritten every
 *   three seconds is not one of the things that happened;
 * - **a lost race is not a conflict.** `PATCH /finish` throws when its
 *   `status = 'open'` claim is lost, because a second ending over the first is
 *   a real conflict. A draft landing a moment after the session closed is the
 *   ORDINARY shape of a fire-and-forget write crossing a network, so it is a
 *   silent 200 that changes nothing;
 * - **whoever settles the session clears it.** `finishSession` NULLs the
 *   column on every close, which is what makes "reported only while the session
 *   is open" true by construction instead of by a filter on some read path.
 *
 * The cap is the transcript's own — `capTranscript`, tail-preferring and cut on
 * a character boundary — and it is restated here rather than imported, the same
 * discipline `sessions.test.ts` keeps for `TRANSCRIPT_CAP_BYTES`: a contract
 * that reads itself out of the implementation demands nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T102_ARTIFACTS,
  request,
  requireArtifacts,
  startControlPlane,
  type Session,
  type TestContext,
} from './support.ts';

const ARTIFACTS = [
  'migrations/0036_session_partial_text.sql',
  T102_ARTIFACTS.sessionRepository,
  T102_ARTIFACTS.sessionRoutes,
];

/**
 * The session as this ticket publishes it: the projection, plus the draft.
 *
 * Declared here and not on `support.ts`'s shared mirror for the reason that
 * file's own header gives — the projections there are hand-written contracts,
 * and this one is the contract THIS ticket demands.
 */
interface DraftingSession extends Session {
  partial_text: string | null;
}

/** The ceiling the stored draft shares with the stored transcript (t159, FR2). */
const CAP_BYTES = 1_048_576;

/** What the acknowledgement of a write nobody needs the row back for looks like. */
const ACK = { ok: true };

/** Opens a job-less session, which is all any case here needs. */
async function openSession(ctx: TestContext): Promise<DraftingSession> {
  const response = await request<DraftingSession>(ctx, 'POST', '/v1/sessions', {
    execution_id: 7,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'draw the map and report it',
  });
  assert.equal(response.status, 201);
  return response.body;
}

/** The session as `GET /v1/sessions` reports it — the only read this ticket adds to. */
async function readBack(ctx: TestContext, id: number): Promise<DraftingSession> {
  const listed = await request<{ sessions: DraftingSession[] }>(
    ctx,
    'GET',
    '/v1/sessions?execution_id=7',
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const found = listed.body.sessions.find((session) => session.id === id);
  assert.ok(found !== undefined, `session ${String(id)} is not in the listing`);
  return found;
}

test('t465 AT1 — a draft written against an open session is readable off the listing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const session = await openSession(ctx);
  assert.equal(session.partial_text, null, 'a session is born with nothing written');

  const written = await request<Record<string, unknown>>(
    ctx,
    'PATCH',
    `/v1/sessions/${session.id}/partial-text`,
    { text: 'I am reading the two answers so far and drafting the third step.' },
  );
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body, ACK, 'the write answers the minimal acknowledgement');

  assert.equal(
    (await readBack(ctx, session.id)).partial_text,
    'I am reading the two answers so far and drafting the third step.',
  );

  // The whole point of the column: the freshest value, never a history of them.
  const second = await request(ctx, 'PATCH', `/v1/sessions/${session.id}/partial-text`, {
    text: 'I am reading the two answers so far and drafting the third and fourth steps.',
  });
  assert.equal(second.status, 200);
  assert.equal(
    (await readBack(ctx, session.id)).partial_text,
    'I am reading the two answers so far and drafting the third and fourth steps.',
  );
});

test('t465 AT2 — the same write against a session already finished is a silent no-op', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const session = await openSession(ctx);
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
  });
  assert.equal(finished.status, 200);

  const late = await request<Record<string, unknown>>(
    ctx,
    'PATCH',
    `/v1/sessions/${session.id}/partial-text`,
    { text: 'a tick that left the runner before the session ended and landed after' },
  );
  assert.equal(
    late.status,
    200,
    'a draft racing the closure is the ordinary case, never a 409 — ' +
      JSON.stringify(late.body),
  );
  assert.deepEqual(late.body, ACK);

  const after = await readBack(ctx, session.id);
  assert.equal(after.partial_text, null, 'and it wrote nothing into the closed row');
  assert.equal(after.status, 'completed', 'the closure itself is untouched');
});

test('t465 AT3 — finishing the session clears whatever draft it had', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const session = await openSession(ctx);
  await request(ctx, 'PATCH', `/v1/sessions/${session.id}/partial-text`, {
    text: 'half a map, still being written',
  });
  assert.equal((await readBack(ctx, session.id)).partial_text, 'half a map, still being written');

  const finished = await request<DraftingSession>(
    ctx,
    'PATCH',
    `/v1/sessions/${session.id}/finish`,
    { status: 'completed', exit_code: 0, transcript: 'the whole of what it printed' },
  );
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.partial_text, null, 'whoever settles the session clears the draft');
  assert.equal(finished.body.transcript, 'the whole of what it printed', 'the closure is unharmed');
  assert.equal((await readBack(ctx, session.id)).partial_text, null);
});

test('t465 AT4 — a session id that names no row is a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<Record<string, unknown>>(
    ctx,
    'PATCH',
    '/v1/sessions/4242/partial-text',
    { text: 'nobody is writing this' },
  );
  assert.equal(response.status, 404, JSON.stringify(response.body));
  assert.equal(response.body.error, 'not_found');
});

test('t465 AT5 — a draft over the cap keeps its tail, cut on a character boundary', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const session = await openSession(ctx);

  // Two-byte runes, so the byte the naive cut would land on is a continuation
  // byte: decoding from there would print a `U+FFFD` no engine ever emitted.
  const text = 'á'.repeat(CAP_BYTES);
  assert.ok(Buffer.byteLength(text, 'utf8') > CAP_BYTES, 'the fixture has to overflow the cap');

  const written = await request(ctx, 'PATCH', `/v1/sessions/${session.id}/partial-text`, { text });
  assert.equal(written.status, 200);

  const stored = (await readBack(ctx, session.id)).partial_text ?? '';
  assert.ok(Buffer.byteLength(stored, 'utf8') <= CAP_BYTES, 'what is stored fits under the cap');
  assert.ok(
    Buffer.byteLength(stored, 'utf8') > CAP_BYTES - 4,
    'and it keeps as much as a whole character allows, never a fraction of the budget',
  );
  assert.ok(text.endsWith(stored), 'the TAIL survives: the end of a stream is the newest of it');
  assert.ok(!stored.includes('�'), 'and the cut never lands inside a rune');
});

test('t465 AT6 — an absent or non-string text is refused with a 400', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const session = await openSession(ctx);

  for (const body of [{}, { text: null }, { text: 42 }, { text: { draft: 'a map' } }]) {
    const response = await request<Record<string, unknown>>(
      ctx,
      'PATCH',
      `/v1/sessions/${session.id}/partial-text`,
      body,
    );
    assert.equal(response.status, 400, `${JSON.stringify(body)}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, 'validation_failed');
  }

  assert.equal((await readBack(ctx, session.id)).partial_text, null, 'and nothing was written');
});
