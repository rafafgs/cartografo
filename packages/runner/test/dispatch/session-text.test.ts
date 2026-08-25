/**
 * Acceptance tests for the two session decoders (t141, AT1 and AT2).
 *
 * A decoder turns what an engine PRINTED back into what the model SAID. It is
 * the step without which the escalation parser reads JSON-escaped text and no
 * fenced block ever parses — the trap `dispatch.ts` recorded when it
 * had only one engine to decode, and the reason this module exists at all now
 * that it has two.
 *
 * Both decoders are pinned against REAL measurements, not against a guess:
 *
 * - `decodeClaudeCodeSessionText` is a relocation (FR6), so its cases are the
 *   ones the inline `sessionText` already covered, moved here whole.
 * - `decodeCodexSessionText` is new, and the frame that carries Codex's
 *   assistant text was unmeasured anywhere in this repo before this ticket. The
 *   two fixtures below are transcripts of real `codex exec --json` runs, one
 *   without a credential (status frames only) and one with (the escalation),
 *   captured for FR9. Neither carries a credential value: the engine never
 *   prints one.
 *
 * English, content included (D24). The one exception is the two `codex-*.jsonl`
 * transcripts: they are RECORDINGS of real runs prompted in Portuguese, and
 * rewriting a recording falsifies the evidence it was captured to be. Every
 * fixture invented here reads in English (t318).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseInputRequest } from '../../src/dispatch/parse-input-request.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
} from '../../src/dispatch/session-text.ts';

/** Reads a transcript fixture as the lines that reached `onOutput`. */
function transcript(name: string): string[] {
  const file = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  assert.ok(existsSync(file), `artifact does not exist yet: ${file}`);
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

// --- AT1: the Claude Code decoder, case for case with the inline original ----

test('AT1 — the result frame carries the whole last answer', () => {
  const frame = JSON.stringify({ type: 'result', result: 'I finished the work.' });
  assert.equal(decodeClaudeCodeSessionText([frame]), 'I finished the work.');
});

test('AT1 — the text blocks of an assistant message are decoded back to text', () => {
  const frame = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' },
      ],
    },
  });
  assert.equal(decodeClaudeCodeSessionText([frame]), 'First part.\nSecond part.');
});

test('AT1 — a frame whose content has no text block is dropped, not fed as prose', () => {
  const frame = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { path: 'a.md' } }],
    },
  });
  // Recognized frame, no text: the raw JSON must NOT reach the parser as if the
  // model had typed it.
  assert.equal(decodeClaudeCodeSessionText([frame]), '');
});

test('AT1 — a line that is not a frame passes through raw', () => {
  const lines = ['this is not JSON', '{broken', ''];
  assert.equal(decodeClaudeCodeSessionText(lines), 'this is not JSON\n{broken\n');
});

test('AT1 — the escaped block of a real frame comes back parseable', () => {
  // The trap this decoder exists for: the block's own quotes arrive as `\"` and
  // its newlines as `\n`, so without decoding nothing downstream ever parses.
  const block = [
    '```input-request',
    JSON.stringify({ question: 'Renumber to 0003?', default: 'Keep 0002' }),
    '```',
  ].join('\n');
  const frame = JSON.stringify({ type: 'result', result: block });

  const request = parseInputRequest(decodeClaudeCodeSessionText([frame]));
  assert.ok(request !== null, 'the fenced block has to survive the decoding');
  assert.equal(request.question, 'Renumber to 0003?');
});

// --- t148: the cases the synthesizer's own copy of this decoder had pinned ---
//
// t148 extracted the same Claude Code decoder a second time, into
// `engine/claude-code-frames.ts`, because the synthesizer had shipped the exact
// bug the decoder prevents. t141 landed first and went further — one decoder per
// engine, routed by the dispatcher — so the merge keeps t141's module as the one
// definition and moves here the four claims only t148's copy was pinning.

test('t148 — a JSON object that is not a frame of THIS engine passes through raw', () => {
  // The Claude Code decoder recognizes `result` and `message.content[]` and
  // nothing else. Unlike Codex's, a bare `type` is not enough to claim the line,
  // so an unknown object stays visible instead of being silently dropped.
  assert.equal(decodeClaudeCodeSessionText(['{"type":"unknown-to-us"}']), '{"type":"unknown-to-us"}');
  assert.equal(decodeClaudeCodeSessionText(['{ not json after all']), '{ not json after all');
});

test('t148 — a tool call between two text blocks does not break the text apart', () => {
  const frame = JSON.stringify({
    type: 'assistant',
    session_id: 'cc-t148',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'tool_use', id: 'toolu_t148', name: 'Read', input: { file_path: '/tmp/x' } },
        { type: 'text', text: 'second' },
      ],
    },
  });

  assert.equal(decodeClaudeCodeSessionText([frame]), 'first\nsecond');
});

test('t148 — frames and plain lines interleave, joined by a newline', () => {
  const decoded = decodeClaudeCodeSessionText([
    'prose',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'from the frame' }),
    'more prose',
  ]);

  assert.equal(decoded, 'prose\nfrom the frame\nmore prose');
});

test('t148 — a fenced `grafo-proposto` block inside a frame comes back fenced', () => {
  // The synthesizer's own consumer, at the decoder level: `parseGraphProposal`
  // matches real backticks and real newlines, and a frame carries neither until
  // this step runs.
  const answer = 'Composed out of the catalogue:\n```grafo-proposto\n{\n  "classe": "x"\n}\n```';
  const frame = JSON.stringify({ type: 'result', subtype: 'success', result: answer });

  assert.ok(!frame.includes('\n'), 'a frame is ONE line: the newlines arrive escaped');
  assert.equal(decodeClaudeCodeSessionText([frame]), answer);
});

// --- AT2: the Codex decoder, pinned on real transcripts ----------------------

test('AT2 — status frames alone carry no block, and no raw JSON leaks as prose', () => {
  const text = decodeCodexSessionText(transcript('codex-status-only.jsonl'));

  assert.equal(
    parseInputRequest(text),
    null,
    'a session that only reported status and died on a 401 asked nothing',
  );
  assert.ok(
    !text.includes('thread.started') && !text.includes('turn.completed'),
    `recognized status frames must be dropped, not passed through as text:\n${text}`,
  );
  // The plain-text runtime error IS passed through: it is not a frame, and the
  // measurement that put it here is `engine-adapter.md`'s viability table.
  assert.ok(text.includes('401 Unauthorized'), 'a non-frame line still passes through raw');
});

test('AT2 — the input-request block of a real credentialed session is recovered', () => {
  const text = decodeCodexSessionText(transcript('codex-input-request.jsonl'));

  const request = parseInputRequest(text);
  assert.ok(
    request !== null,
    `the fenced block of the real transcript has to survive the decoding:\n${text}`,
  );
  assert.match(request.question, /0002|0003/, 'the question is the one the real session asked');
  assert.ok(
    request.context !== undefined && request.context !== '',
    'the real block carries its context',
  );
  assert.ok(Array.isArray(request.options) && request.options.length > 0);
  assert.ok(request.default !== undefined);
});

test('AT2 — an agent_message is the frame that carries text; other items are dropped', () => {
  // Both measured in the same real run: the file_change item reports work, and
  // it is not something the model said.
  const said = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'File created.' },
  });
  const did = JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'file_change',
      changes: [{ path: '/tmp/x/PROVA.md', kind: 'add' }],
      status: 'completed',
    },
  });

  assert.equal(decodeCodexSessionText([said, did]), 'File created.');
});
