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
