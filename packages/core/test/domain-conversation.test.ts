/**
 * Unit tests for the conversation projection's draft and its map (t465, t492).
 *
 * Pure, with no server and no database, exactly like `domain-context.test.ts`:
 * `buildConversation` is a structural question over four reads, and which rows
 * feed it is `routes/jobs.ts`'s business, not this module's.
 *
 * What is pinned here is one field and the precedence around it.
 * `Conversation.partial` is the text of the session that is running RIGHT NOW,
 * and it is reported exactly when `thinking` is — the two are the same fact
 * seen twice, one as a flag and one as the content behind it. Everything else
 * is `null`: a question waiting outranks a session writing (the person has
 * something to do), an arrived traveller has nothing left to write, and a
 * session that has written nothing yet is the static-placeholder case the page
 * has always drawn.
 *
 * t492 adds the second half, below: WHERE `conversation.draft` reads the map
 * from. The interview reported it nested under a `draft` key until t464
 * flattened it, and a job's graph_version is frozen — so both shapes are live
 * data and the accumulator owes an answer to each.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConversation,
  type ConversationSources,
  type ProjectedInputRequest,
  type ProjectedSessionState,
} from '../src/domain/conversation.ts';

/** A session row, in the part the projection reads. */
function session(over: Partial<ProjectedSessionState> = {}): ProjectedSessionState {
  return {
    id: 1,
    status: 'open',
    output: null,
    finished_at: null,
    partial_text: null,
    ...over,
  };
}

/** An input request, in the part the projection reads. */
function question(over: Partial<ProjectedInputRequest> = {}): ProjectedInputRequest {
  return {
    id: 9,
    question: 'What does the first step need before it can start?',
    context: null,
    options: null,
    recommendation: null,
    default_answer: null,
    answer: null,
    answered_by: null,
    answered_at: null,
    ...over,
  };
}

/** Everything the route hands over, with nothing in it. */
function sources(over: Partial<ConversationSources> = {}): ConversationSources {
  return { events: [], answered: [], pending: [], sessions: [], done: false, ...over };
}

const DRAFT = 'I am reading the two answers so far and drafting the third step.';

test('t465 AT7 — an open session that is writing reports its text beside the flag', () => {
  const conversation = buildConversation(
    sources({ sessions: [session({ partial_text: DRAFT })] }),
  );

  assert.equal(conversation.thinking, true);
  assert.equal(conversation.partial, DRAFT);
});

test('t465 AT8 — a question waiting outranks a session writing', () => {
  const conversation = buildConversation(
    sources({
      pending: [question()],
      sessions: [session({ partial_text: DRAFT })],
    }),
  );

  assert.equal(conversation.thinking, false, 'the existing precedence is unchanged');
  assert.equal(
    conversation.partial,
    null,
    'and the content follows the flag: there is something to answer, so nothing is drawn as thinking',
  );
});

test('t465 AT9 — with no session open there is no draft to report', () => {
  const conversation = buildConversation(
    sources({
      sessions: [
        session({
          id: 1,
          status: 'completed',
          finished_at: '2026-09-07T10:00:00.000Z',
          partial_text: 'a draft the closure should have cleared',
        }),
      ],
    }),
  );

  assert.equal(conversation.thinking, false);
  assert.equal(
    conversation.partial,
    null,
    'a closed session is never the one being watched, whatever its column still holds',
  );
});

test('t465 AT10 — an open session that has written nothing is the static-placeholder case', () => {
  const conversation = buildConversation(sources({ sessions: [session()] }));

  assert.equal(conversation.thinking, true, 'somebody is still working on the next question');
  assert.equal(conversation.partial, null, 'and there is nothing yet to show instead of the word');
});

test('t465 AT11 — an arrived interview reports no draft', () => {
  const conversation = buildConversation(
    sources({ done: true, sessions: [session({ partial_text: DRAFT })] }),
  );

  assert.equal(conversation.thinking, false);
  assert.equal(conversation.partial, null);
});

/* -------------------------------------------------------------------------- */
/* t492 — the map is read from wherever the session actually reported it.      */
/*                                                                            */
/* Two contracts, not one. t464 flattened the interview's declared output to   */
/* `{done, graph, skills}` and rewrote this accumulator to match — but a job's */
/* graph_version is frozen (D2, D15), so every interview that ran BEFORE that  */
/* landed is pinned to a skill whose own `output` schema REQUIRED the nested   */
/* `{done, draft: {graph, skills}}`. A flat-only read answers `null` for all   */
/* of them. The precedence below is therefore per key and in this order: the   */
/* top level when it says anything, the retired `draft` wrapper when it does   */
/* not, and otherwise whatever the walk already had.                          */
/* -------------------------------------------------------------------------- */

/** A completed session that reported `output`, closing at `at`. */
function reported(id: number, at: string, output: Record<string, unknown>): ProjectedSessionState {
  return session({ id, status: 'completed', finished_at: at, output });
}

const G1 = { problem_class: 'widget-return', nodes: [{ id: 'inspect' }] };
const G2 = { problem_class: 'widget-return', nodes: [{ id: 'inspect' }, { id: 'decide' }] };
const S2 = [{ id: 'inspect-widget', version: '1.0.0' }];

test('t492 AT1 — the retired nested `draft` accumulates exactly like the flat shape', () => {
  const conversation = buildConversation(
    sources({
      sessions: [
        reported(1, '2026-09-07T10:00:00.000Z', { done: false, draft: { graph: G1 } }),
        reported(2, '2026-09-07T10:05:00.000Z', { done: true, draft: { graph: G2, skills: S2 } }),
      ],
    }),
  );

  assert.deepEqual(
    conversation.draft,
    { graph: G2, skills: S2 },
    'the later turn owns both keys it named, nested or not',
  );
});

test('t492 AT2 — precedence is per key, and holds ACROSS the two shapes', () => {
  const conversation = buildConversation(
    sources({
      sessions: [
        reported(1, '2026-09-07T10:00:00.000Z', { done: false, graph: G1 }),
        reported(2, '2026-09-07T10:05:00.000Z', { done: false, draft: { skills: S2 } }),
      ],
    }),
  );

  assert.deepEqual(
    conversation.draft,
    { graph: G1, skills: S2 },
    'a nested turn that named only `skills` left the flat `graph` standing',
  );
});

test('t492 AT3 — a report carrying a key at both levels accumulates the top-level one', () => {
  const conversation = buildConversation(
    sources({
      sessions: [
        reported(1, '2026-09-07T10:00:00.000Z', { done: false, graph: G2, draft: { graph: G1 } }),
      ],
    }),
  );

  assert.deepEqual(
    conversation.draft,
    { graph: G2 },
    'the current contract wins over the retired one when a report somehow says both',
  );
});

test('t492 AT4 — a `deliver`-shaped report still moves neither key', () => {
  const alone = buildConversation(
    sources({
      sessions: [
        reported(1, '2026-09-07T10:00:00.000Z', {
          bundle: { graph: G1, skills: S2 },
          checked: { structure: true, soundness: true, problems: [] },
          note: 'the map covers inspection and the return itself',
        }),
      ],
    }),
  );
  assert.equal(alone.draft, null, 'a report naming neither key is not a map');

  const after = buildConversation(
    sources({
      sessions: [
        reported(1, '2026-09-07T10:00:00.000Z', { done: true, draft: { graph: G1, skills: S2 } }),
        reported(2, '2026-09-07T10:05:00.000Z', {
          bundle: { graph: G1, skills: S2 },
          checked: { structure: true, soundness: true, problems: [] },
          note: 'the map covers inspection and the return itself',
        }),
      ],
    }),
  );
  assert.deepEqual(
    after.draft,
    { graph: G1, skills: S2 },
    'and it disturbs neither key an earlier turn settled — it has no `draft` object to fall back to',
  );
});

test('t492 AT5 — a `draft` that is not a plain object contributes nothing, and throws nothing', () => {
  for (const notAnObject of [null, 'oops', [G1]]) {
    const alone = buildConversation(
      sources({
        sessions: [reported(1, '2026-09-07T10:00:00.000Z', { done: false, draft: notAnObject })],
      }),
    );
    assert.equal(alone.draft, null, `\`draft: ${JSON.stringify(notAnObject)}\` is not a map`);

    const after = buildConversation(
      sources({
        sessions: [
          reported(1, '2026-09-07T10:00:00.000Z', { done: false, graph: G1, skills: S2 }),
          reported(2, '2026-09-07T10:05:00.000Z', { done: false, draft: notAnObject }),
        ],
      }),
    );
    assert.deepEqual(
      after.draft,
      { graph: G1, skills: S2 },
      `\`draft: ${JSON.stringify(notAnObject)}\` left the settled map alone`,
    );
  }
});
