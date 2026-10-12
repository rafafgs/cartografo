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
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

// --- t676: the Copilot decoder, duplicated from the runner's ----------------------

/**
 * The runner's REAL capture of a `copilot` 1.0.95 session, read from its own
 * package: core cannot import runner CODE, but a fixture is data, and reading
 * the same bytes is what makes the parity claim checkable at all.
 */
function copilotFixture(): string {
  const file = fileURLToPath(
    new URL('../../runner/test/fixtures/copilot-frames.jsonl', import.meta.url),
  );
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
}

/**
 * What the runner's `decodeCopilotSessionText` returns on that fixture, pinned as
 * a literal: the plain-text policy error that was interleaved, then the one
 * assistant message, whose escapes are undone.
 */
const EXPECTED_COPILOT_TEXT =
  'Error: Access denied by policy settings (Request ID: FA86:214D9C:5866C:60D07:6ACCB33D)\n' +
  'I need a decision before I continue.\n\n```input-request\n' +
  '{"question":"Which migration number should be reserved: 0002 or 0003?",' +
  '"context":"The migrations directory is empty and a parallel ticket may claim the same range.",' +
  '"options":["0002","0003"],"recommendation":"Reserve 0002.","default":"0002"}\n```';

test('t676 — a copilot session decodes to what the model said, plus the raw error line', () => {
  assert.equal(decodeSessionText('copilot', copilotFixture()), EXPECTED_COPILOT_TEXT);
});

test('t676 — the copilot decoder keeps the runner rule: a recognized frame speaks only through its message', () => {
  const lines = [
    JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: 'half' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 'whole' } }),
    JSON.stringify({ type: 'assistant.message', data: { content: 42 } }),
    JSON.stringify({ type: 'result', sessionId: 'x', exitCode: 0 }),
    '{"data":{"content":"no type"}}',
    'plain text',
  ].join('\n');

  assert.equal(
    decodeSessionText('copilot', lines),
    'whole\n{"data":{"content":"no type"}}\nplain text',
  );
});

test('t676 — shell and an unknown engine still pass a copilot-looking frame through', () => {
  const frame = JSON.stringify({ type: 'assistant.message', data: { content: 'hi' } });
  assert.equal(decodeSessionText('shell', frame), frame);
  assert.equal(decodeSessionText('no-such-engine', frame), frame);
  assert.equal(decodeSessionText('shell', copilotFixture()), copilotFixture());
});

// --- t684: a transcript written with CRLF line endings ----------------------------

test('t684 AT12 — CRLF and LF transcripts of the three frame engines decode alike', () => {
  const frames: Record<string, string[]> = {
    'claude-code': [
      'a plain line that is not a frame',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'said' }] } }),
    ],
    codex: [
      'a plain line that is not a frame',
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'said' } }),
    ],
    copilot: [
      'a plain line that is not a frame',
      JSON.stringify({ type: 'assistant.message', data: { content: 'said' } }),
    ],
  };
  for (const [engine, lines] of Object.entries(frames)) {
    const lf = decodeSessionText(engine, lines.join('\n'));
    const crlf = decodeSessionText(engine, lines.join('\r\n'));
    assert.equal(crlf, lf, engine);
    assert.ok(lf.includes('a plain line that is not a frame'), `${engine}: the plain line is kept`);
  }
});

test('t684 AT12 — shell and unknown engines keep a printed \\r byte for byte', () => {
  assert.equal(decodeSessionText('shell', 'a\r\nb'), 'a\r\nb');
  assert.equal(decodeSessionText('some-future-engine', 'a\r\nb'), 'a\r\nb');
});
