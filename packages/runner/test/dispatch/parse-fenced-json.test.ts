/**
 * Direct tests for the scanner every fenced block goes through (t212).
 *
 * `parse-fenced-json.ts` reported full line coverage before this file existed,
 * and reported it entirely THROUGH its three callers — `parse-node-result`,
 * `parse-input-request` and `parse-permission-denial`. That is coverage of the
 * payloads those three happen to build, not of the scanner's own edges, and the
 * difference matters here more than almost anywhere else in the repository: this
 * is the one procedure every LLM output in the system is read by, and its
 * contract (extent from the JSON, malformed ignored instead of raised, last
 * valid block wins) is inherited from flowpilot's `controller_parser.py` (D17).
 *
 * So the cases below name the edges instead of implying them — a payload that
 * quotes a fence of its own, an escaped quote before a brace, a value that never
 * closes, two valid blocks, a fence with the right name and no JSON behind it.
 * Each one is stated against the exported behaviour: `parseFencedJson` with a
 * `build` that accepts, and `findValueEnd` for the extent alone. Nothing here
 * reaches for how the scan is implemented — the regex, the depth counter and the
 * `lastIndex` bookkeeping are free to change as long as these answers do not.
 *
 * English per D18; the fence names and the payload keys are wire vocabulary and
 * stay in Portuguese, as they are in the three callers.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { findValueEnd, parseFencedJson } from '../../src/dispatch/parse-fenced-json.ts';

/** A fence name, standing in for any of the three the repository reads. */
const FENCE = 'resultado';

/** Wraps a payload in a fenced block, exactly as a session prints one. */
function block(payload: string, fence: string = FENCE): string {
  return ['```' + fence, payload, '```'].join('\n');
}

/**
 * The payload of the last accepted block, with no interpretation on top.
 *
 * `build` is the callers' half of the contract, and an identity `build` is what
 * isolates the scanner from it: what comes back here is what the scan delimited
 * and `JSON.parse` accepted, and nothing else.
 */
function readPayload(output: string, fence: string = FENCE): Record<string, unknown> | null {
  return parseFencedJson(output, fence, (payload) => payload as Record<string, unknown>);
}

test('a well-formed block yields the payload the fence carries', () => {
  const output = [
    'I ran the suite and walked the acceptance criteria.',
    block(JSON.stringify({ resultado: 'aprovado', evidencia: '12 passing' })),
  ].join('\n');

  assert.deepEqual(readPayload(output), { resultado: 'aprovado', evidencia: '12 passing' });
});

test('a payload that quotes a fenced block of its own is read whole', () => {
  // The reason the extent comes from the JSON and never from a search for the
  // next ```: a gate pastes the output of a command into its evidence, and a
  // naive scan cuts the block in half right there.
  const evidence = 'The suite printed:\n```\n1 failing\n```\nand that was all of it.';
  const output = block(JSON.stringify({ resultado: 'retrabalho', evidencia: evidence }));

  assert.deepEqual(readPayload(output), { resultado: 'retrabalho', evidencia: evidence });
});

test('a fence quoted inside a payload is not read as a second block', () => {
  // The nested case with teeth. Quoting a whole block is usually harmless by
  // accident — JSON escapes the inner quotes, so what is quoted no longer parses
  // — but a payload needs no quotes at all to carry a readable object, and this
  // one does: `evidencia` holds a complete block of the SAME fence. It is quoted
  // evidence, not an answer, and reading it would let any session overwrite its
  // own verdict by pasting a transcript.
  const evidence = 'o agente anterior respondeu ```resultado{} e eu discordo';
  const output = block(JSON.stringify({ resultado: 'retrabalho', evidencia: evidence }));

  assert.deepEqual(readPayload(output), { resultado: 'retrabalho', evidencia: evidence });
  assert.deepEqual(
    readPayload(block(JSON.stringify({ resultado: 'retrabalho', evidencia: block('{}') }))),
    { resultado: 'retrabalho', evidencia: block('{}') },
    'and the same holds when the quoted block is fenced on lines of its own',
  );
});

test('an escaped quote inside a string does not close the value early', () => {
  // Without escape handling the string ends at the `\"`, the `}` right after it
  // closes the object, and what gets parsed is a truncated fragment.
  const evidence = 'it said "done}" and stopped';
  const output = block(JSON.stringify({ resultado: 'aprovado', evidencia: evidence }));

  assert.equal(output.includes('\\"'), true, 'the fixture has to carry a real escaped quote');
  assert.deepEqual(readPayload(output), { resultado: 'aprovado', evidencia: evidence });
});

test('an escaped backslash at the end of a string does not swallow the closing quote', () => {
  // `"C:\\"` — the backslash is escaped, so the quote that follows it is real.
  // A scanner that treats every backslash as an escape reads the value as
  // unterminated and answers null.
  const output = block(JSON.stringify({ resultado: 'aprovado', caminho: 'C:\\' }));

  assert.deepEqual(readPayload(output), { resultado: 'aprovado', caminho: 'C:\\' });
});

test('a brace inside a string does not close the value', () => {
  const output = block(JSON.stringify({ resultado: 'aprovado', evidencia: '} } {' }));

  assert.deepEqual(readPayload(output), { resultado: 'aprovado', evidencia: '} } {' });
});

test('an unterminated block yields null instead of throwing', () => {
  // Bad model output must not crash a dispatch. Nothing in this module throws.
  assert.equal(readPayload(block('{"resultado": "aprovado"')), null);
  assert.equal(readPayload(block('{"resultado": "never closed')), null);
  assert.equal(readPayload('```' + FENCE + '\n{'), null);
});

test('a fence with the right name and no JSON behind it yields null', () => {
  assert.equal(readPayload(block('I could not decide')), null);
  assert.equal(readPayload(block('')), null);
  assert.equal(readPayload('```' + FENCE), null, 'a fence with nothing after it at all');
});

test('a payload that is not an object is not a block', () => {
  // Every block's payload is `{...}` by contract; accepting a bare array or a
  // number here would only move the failure one step later.
  assert.equal(readPayload(block(JSON.stringify(['aprovado']))), null);
  assert.equal(readPayload(block('42')), null);
  assert.equal(readPayload(block('"aprovado"')), null);
});

test('with two valid blocks, the last one wins', () => {
  const output = [
    'first reading:',
    block(JSON.stringify({ resultado: 'aprovado' })),
    'then I read the evidence again:',
    block(JSON.stringify({ resultado: 'retrabalho' })),
  ].join('\n');

  assert.deepEqual(readPayload(output), { resultado: 'retrabalho' });
});

test('a malformed block never shadows a valid one, in either order', () => {
  const valid = block(JSON.stringify({ resultado: 'aprovado' }));
  const broken = block('{"resultado": broken');

  assert.deepEqual(readPayload([broken, valid].join('\n')), { resultado: 'aprovado' });
  assert.deepEqual(
    readPayload([valid, broken].join('\n')),
    { resultado: 'aprovado' },
    'garbage written after the answer cannot erase the answer',
  );
});

test('a payload build refuses does not supersede one it accepted', () => {
  // `build` is the other half of the "last VALID block wins" rule: a payload the
  // caller cannot act on is not a block, so it may not overwrite an earlier one.
  const output = [
    block(JSON.stringify({ resultado: 'aprovado' })),
    block(JSON.stringify({ evidencia: 'no result at all' })),
  ].join('\n');

  const found = parseFencedJson(output, FENCE, (payload) => {
    const raw = payload as Record<string, unknown>;
    return typeof raw.resultado === 'string' ? raw.resultado : null;
  });

  assert.equal(found, 'aprovado');
});

test('another fence is never read as this one', () => {
  assert.equal(readPayload('```json\n{"resultado":"aprovado"}\n```'), null);
  assert.equal(
    readPayload(block(JSON.stringify({ question: 'e agora?' }), 'input-request')),
    null,
  );
  assert.equal(
    readPayload(block(JSON.stringify({ resultado: 'aprovado' }), `${FENCE}s`)),
    null,
    'a fence whose name merely starts with the wanted one is a different fence',
  );
});

test('the whitespace between the fence and the value belongs to the model', () => {
  assert.deepEqual(readPayload('```' + FENCE + ' \n\n  {"resultado":"aprovado"}\n```'), {
    resultado: 'aprovado',
  });
  assert.deepEqual(
    readPayload('```' + FENCE + '\r\n{"resultado":"aprovado"}\r\n```'),
    { resultado: 'aprovado' },
    'a session on Windows line endings emits the same block',
  );
  assert.deepEqual(
    readPayload('```' + FENCE + '{"resultado":"aprovado"}```'),
    { resultado: 'aprovado' },
    'and one that forgot the newline emits it too',
  );
});

test('no block at all yields null', () => {
  assert.equal(readPayload(''), null);
  assert.equal(readPayload('I finished the node and chose no edge at all.'), null);
});

test('findValueEnd delimits the value, and answers null when it never closes', () => {
  const text = 'before {"a": {"b": "}"}} after';
  const start = text.indexOf('{');

  const end = findValueEnd(text, start);
  assert.notEqual(end, null);
  assert.equal(text.slice(start, end as number), '{"a": {"b": "}"}}');

  assert.equal(findValueEnd('{"a": 1', 0), null, 'a value that never closes');
  assert.equal(findValueEnd('[1, 2]', 0), null, 'only objects are considered');
  assert.equal(findValueEnd('', 0), null);
});
