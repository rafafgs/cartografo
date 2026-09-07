/**
 * Acceptance tests for the escalation-block parser (t106, FR5).
 *
 * The behaviour contract is inherited from flowpilot's
 * `app/services/flow/controller_parser.py` (D17 — flowpilot is the behaviour
 * reference, not a dependency): the block's extent comes from the JSON itself,
 * a malformed block is ignored instead of raised, and the last block wins.
 *
 * Written in English per D18; this whole directory is post-decision code.
 *
 * The module is imported behind an `existsSync` check, same discipline as the
 * rest of the suite: on the initial red the failure must NAME the missing
 * artifact instead of blowing up with a module-resolution error that looks like
 * any other bug.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ParserModule from '../../src/dispatch/parse-input-request.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/parse-input-request.ts';

let cache: typeof ParserModule | null = null;

async function loadParser(): Promise<typeof ParserModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/parse-input-request.ts', import.meta.url).href
  )) as typeof ParserModule;
  return cache;
}

/** Wraps a payload in the fenced block a session emits. */
function block(payload: string): string {
  return ['```input-request', payload, '```'].join('\n');
}

test('a well-formed block yields every field the contract defines', async () => {
  const { parseInputRequest } = await loadParser();

  const output = [
    'I read the ticket and the files it names.',
    'One thing is not settled by the spec, so I am asking.',
    block(
      JSON.stringify({
        question: 'Renumber the migration to 0003?',
        context: 't101 runs in parallel and owns the same numbering space.',
        options: ['Renumber to 0003', 'Keep 0002'],
        recommendation: 'Keep 0002 and renumber only on a merge collision.',
        default: 'Keep 0002',
      }),
    ),
  ].join('\n');

  assert.deepEqual(parseInputRequest(output), {
    question: 'Renumber the migration to 0003?',
    context: 't101 runs in parallel and owns the same numbering space.',
    options: ['Renumber to 0003', 'Keep 0002'],
    recommendation: 'Keep 0002 and renumber only on a merge collision.',
    default: 'Keep 0002',
  });
});

test('only `question` is required; the optional fields stay absent', async () => {
  const { parseInputRequest } = await loadParser();

  assert.deepEqual(parseInputRequest(block(JSON.stringify({ question: 'Which port?' }))), {
    question: 'Which port?',
  });
});

test('no block at all yields null', async () => {
  const { parseInputRequest } = await loadParser();

  assert.equal(parseInputRequest(''), null);
  assert.equal(parseInputRequest('I finished the ticket, nothing to ask.'), null);
  assert.equal(
    parseInputRequest('```json\n{"question":"not an input-request"}\n```'),
    null,
    'a fence of another kind is not an escalation',
  );
});

test('a block with broken JSON yields null instead of throwing', async () => {
  const { parseInputRequest } = await loadParser();

  // A model's bad output must not crash a dispatch: the session is treated as
  // having produced no escalation, which the controller already knows how to
  // handle (the work simply stays unblocked).
  assert.equal(parseInputRequest(block('{"question": "unterminated')), null);
  assert.equal(parseInputRequest(block('not json at all')), null);
  assert.equal(
    parseInputRequest(block(JSON.stringify(['a', 'list', 'is', 'not', 'a', 'block']))),
    null,
  );
  assert.equal(
    parseInputRequest(block(JSON.stringify({ context: 'no question here' }))),
    null,
    'a block without a question is not answerable, so it is not a block',
  );
  assert.equal(parseInputRequest(block(JSON.stringify({ question: '   ' }))), null);
});

test('with more than one block, the last one wins', async () => {
  const { parseInputRequest } = await loadParser();

  const output = [
    'First I thought I would ask this:',
    block(JSON.stringify({ question: 'Scratch question', default: 'scratch' })),
    'then I read further and what I actually need is this:',
    block(JSON.stringify({ question: 'Final question', default: 'final' })),
  ].join('\n');

  assert.deepEqual(parseInputRequest(output), {
    question: 'Final question',
    default: 'final',
  });
});

test('a malformed block does not shadow a valid one that follows it', async () => {
  const { parseInputRequest } = await loadParser();

  const output = [
    block('{"question": "half-writ'),
    'that came out wrong, again:',
    block(JSON.stringify({ question: 'The good one' })),
  ].join('\n');

  assert.deepEqual(parseInputRequest(output), { question: 'The good one' });
});

test('a valid block is not shadowed by a malformed one that follows it', async () => {
  const { parseInputRequest } = await loadParser();

  const output = [
    block(JSON.stringify({ question: 'The good one' })),
    block('{"question": broken'),
  ].join('\n');

  assert.deepEqual(
    parseInputRequest(output),
    { question: 'The good one' },
    'garbage after the answer cannot erase the answer',
  );
});

test('a context carrying its own fence does not truncate the block', async () => {
  const { parseInputRequest } = await loadParser();

  // This is the reason the extent comes from the JSON and never from a search
  // for the closing fence: a refined ticket body routinely quotes its own
  // fenced example, and a naive next-fence scan would cut the block in half.
  const context = 'The ticket body already contains:\n```json\n{"a": 1}\n```\nand that is fine.';
  const output = block(JSON.stringify({ question: 'Keep the nested example?', context }));

  assert.deepEqual(parseInputRequest(output), {
    question: 'Keep the nested example?',
    context,
  });
});

test('options that are not a list of strings are dropped, not fatal', async () => {
  const { parseInputRequest } = await loadParser();

  const parsed = parseInputRequest(
    block(JSON.stringify({ question: 'Which one?', options: 'not a list' })),
  );

  assert.deepEqual(parsed, { question: 'Which one?' });
});

/* -- t480: `options` may carry a whole step's worth of decisions ------------ */

/**
 * The batched shape (t480, FR3).
 *
 * `options` was a list of one-click labels for ONE decision. A step of the
 * interview asks several at once, so an item may instead be a Field — a named,
 * labelled control the human fills in — and the whole step comes back as one
 * JSON document. Both shapes travel on the same key, permanently: a single
 * decision is still a flat list of strings and nothing about it changes.
 *
 * The posture on a malformed item is the one the flat list already had, moved
 * down one level: an unusable FIELD is dropped and the question still stands,
 * because losing a control is cheaper than losing the escalation.
 */
const SCOPE = Object.freeze({
  id: 'scope',
  label: 'Which scope?',
  kind: 'choice',
  options: ['the whole repo', 'one package'],
  recommended: 'one package',
});

const DEPTH = Object.freeze({
  id: 'depth',
  label: 'How deep should it go?',
  kind: 'free_text',
});

test('t480 AT5 — two well-formed fields parse as fields', async () => {
  const { parseInputRequest } = await loadParser();

  const parsed = parseInputRequest(
    block(JSON.stringify({ question: 'Step 4 of 7', options: [SCOPE, DEPTH] })),
  );

  assert.deepEqual(parsed, { question: 'Step 4 of 7', options: [SCOPE, DEPTH] });
});

test('t480 AT6 — a malformed item is dropped, the well-formed field survives', async () => {
  const { parseInputRequest } = await loadParser();

  for (const broken of [
    { id: 'depth', kind: 'choice' },
    { id: 'depth', label: 'How deep?' },
    { id: '', label: 'How deep?', kind: 'choice' },
    { id: 'depth', label: 'How deep?', kind: 'yesno' },
    'a stray string sitting among field objects',
    null,
    ['nested'],
  ]) {
    assert.deepEqual(
      parseInputRequest(
        block(JSON.stringify({ question: 'Step 4 of 7', options: [SCOPE, broken] })),
      ),
      { question: 'Step 4 of 7', options: [SCOPE] },
      `a well-formed field must survive beside ${JSON.stringify(broken)}`,
    );
  }
});

test('t480 AT6 — a bad `options`/`recommended` costs the field only those keys', async () => {
  const { parseInputRequest } = await loadParser();

  const parsed = parseInputRequest(
    block(
      JSON.stringify({
        question: 'Step 4 of 7',
        options: [{ ...SCOPE, options: 'not a list', recommended: 7 }],
      }),
    ),
  );

  assert.deepEqual(parsed, {
    question: 'Step 4 of 7',
    options: [{ id: 'scope', label: 'Which scope?', kind: 'choice' }],
  });
});

test('t480 AT7 — an array with nothing well-formed in it drops `options` entirely', async () => {
  const { parseInputRequest } = await loadParser();

  assert.deepEqual(
    parseInputRequest(
      block(JSON.stringify({ question: 'Which one?', options: [{ id: 'depth' }, 7, null] })),
    ),
    { question: 'Which one?' },
    'parity with the flat list: a wholly malformed `options` is dropped, not fatal',
  );
});

test('t480 AT8 — an all-strings array is still a flat list of labels', async () => {
  const { parseInputRequest } = await loadParser();

  assert.deepEqual(
    parseInputRequest(block(JSON.stringify({ question: 'Which one?', options: ['Keep', 'Drop'] }))),
    { question: 'Which one?', options: ['Keep', 'Drop'] },
  );
  // The empty array is an all-strings array, and it stays one: it has always
  // been kept rather than dropped, and nothing here reads it as "no fields".
  assert.deepEqual(
    parseInputRequest(block(JSON.stringify({ question: 'Which one?', options: [] }))),
    { question: 'Which one?', options: [] },
  );
});
