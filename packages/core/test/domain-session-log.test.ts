/**
 * Acceptance tests of the ported session decoder (t368).
 *
 * Pure unit tests, no database: `domain/session-log.ts` is a small duplication
 * of `packages/runner/src/dispatch/session-text.ts`'s own decoders (the runner
 * cannot be imported from core — it depends on core, never the reverse), and
 * `decodeSessionText` is the one thing this ticket adds on top of the port: the
 * dispatch by `engine` that `GET /v1/sessions/:id/log` needs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeSessionText } from '../src/domain/session-log.ts';

test('t368 — a claude-code session decodes its stream-json frames to plain text', () => {
  const frame = JSON.stringify({ type: 'result', result: 'I finished the work.' });
  assert.equal(decodeSessionText('claude-code', frame), 'I finished the work.');
});

test('t368 — a claude-code assistant frame with only a tool call decodes to nothing', () => {
  const frame = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { path: 'a.md' } }],
    },
  });
  assert.equal(decodeSessionText('claude-code', frame), '');
});

test('t368 — a codex session decodes its agent_message item to plain text', () => {
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: '01a0' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'the work is done' },
    }),
  ].join('\n');

  // The two status frames are RECOGNIZED and carry no text, so they contribute
  // nothing at all — not even a blank line — and only the agent's own words
  // survive.
  assert.equal(decodeSessionText('codex', lines), 'the work is done');
});

test('t368 — a codex non-text frame is recognized and dropped, not echoed', () => {
  const frame = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'file_change', status: 'completed' },
  });
  assert.equal(decodeSessionText('codex', frame), '');
});

test('t368 — a shell session passes through exactly what it printed', () => {
  const text = 'line one\nline two\n{"not": "a frame this engine defines"}';
  assert.equal(decodeSessionText('shell', text), text);
});

test('t368 — an engine this module does not recognize also passes through unchanged', () => {
  const text = 'whatever an unknown engine printed';
  assert.equal(decodeSessionText('some-future-engine', text), text);
});
