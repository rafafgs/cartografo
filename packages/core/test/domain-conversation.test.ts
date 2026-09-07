/**
 * Unit tests for the conversation projection's draft (t465, FR5).
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
