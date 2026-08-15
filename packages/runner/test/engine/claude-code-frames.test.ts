/**
 * Acceptance tests of the frame decoder, on its own (t148, AT1).
 *
 * The decoder used to live inside `dispatch/dispatch-claude-code.ts`, private to
 * the one caller that had been bitten by the trap, and covered only through that
 * caller's end-to-end tests. It is a shared module now because a second consumer
 * appeared — the synthesizer — after shipping the exact bug the decoder exists to
 * prevent: `parseGraphProposal` scanning JSON-escaped text for a fence that, in a
 * real session, is only ever inside a frame.
 *
 * Testing it directly is the point. What a caller's e2e test proves is that the
 * caller decoded SOMETHING; what these four claims pin is the frame shapes the
 * real `claude` CLI emits, so the third consumer inherits the guarantee instead
 * of rediscovering the trap.
 *
 * English per D18; the frame field names (`result`, `message.content[].text`)
 * are the engine's wire format and are quoted, not translated.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as FramesModule from '../../src/engine/claude-code-frames.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/engine/claude-code-frames.ts';

let cache: typeof FramesModule | null = null;

async function loadFrames(): Promise<typeof FramesModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/engine/claude-code-frames.ts', import.meta.url).href
  )) as typeof FramesModule;
  return cache;
}

test('AT1 — a `result` frame decodes to the string it carries', async () => {
  const { sessionText } = await loadFrames();

  const answer = 'A resposta inteira, com "aspas" e\numa quebra de linha.';
  const frame = JSON.stringify({ type: 'result', subtype: 'success', result: answer });

  assert.ok(!frame.includes('\n'), 'a frame is ONE line: the newline arrives escaped');
  assert.equal(sessionText([frame]), answer);
});

test('AT1 — an assistant frame decodes to the text of its content blocks', async () => {
  const { sessionText } = await loadFrames();

  const frame = JSON.stringify({
    type: 'assistant',
    session_id: 'cc-t148',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        // A tool call is not text and has no business in the parsed stream.
        { type: 'tool_use', id: 'toolu_t148', name: 'Read', input: { file_path: '/tmp/x' } },
        { type: 'text', text: 'second' },
      ],
    },
  });

  assert.equal(sessionText([frame]), 'first\nsecond');
});

test('AT1 — a line that is not a frame passes through untouched', async () => {
  const { sessionText } = await loadFrames();

  // The fake engine of the suite prints exactly this shape, which is why the
  // trap survived CI for as long as it did.
  assert.equal(sessionText(['plain prose from a session']), 'plain prose from a session');
  assert.equal(sessionText(['{ not json after all']), '{ not json after all');
  assert.equal(sessionText(['{"type":"unknown-to-us"}']), '{"type":"unknown-to-us"}');
});

test('AT1 — several lines come back joined by a newline', async () => {
  const { sessionText } = await loadFrames();

  const decoded = sessionText([
    'prose',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'from the frame' }),
    'more prose',
  ]);

  assert.equal(decoded, 'prose\nfrom the frame\nmore prose');
});

test('AT1 — a fenced block inside a frame comes back fenced, not escaped', async () => {
  const { sessionText } = await loadFrames();

  // The whole reason the module exists: the fence scanner downstream matches
  // real backticks and real newlines, and a frame carries neither until here.
  const answer = 'Composto do catálogo:\n```grafo-proposto\n{\n  "classe": "x"\n}\n```';
  const frame = JSON.stringify({ type: 'result', subtype: 'success', result: answer });

  assert.ok(frame.includes('\\n'), 'inside the frame the newlines really are escaped');
  assert.equal(sessionText([frame]), answer);
});
