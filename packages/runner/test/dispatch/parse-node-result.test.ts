/**
 * Acceptance tests for the routing-block parser (t161, FR9).
 *
 * The block a session emits when the node it is standing on has more than one
 * outgoing edge, and the contract is deliberately the SAME one
 * `parse-input-request.ts` already keeps — extent from the JSON, malformed
 * ignored instead of raised, last valid wins. Two parsers with two different
 * answers to "what if the model wrote garbage" is how one of them ends up
 * crashing a dispatch, so both are built on `parse-fenced-json.ts` and this file
 * checks the same three rules against the second fence.
 *
 * English per D18; the fence name and the payload key are wire vocabulary and
 * stay in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ParserModule from '../../src/dispatch/parse-node-result.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/parse-node-result.ts';

let cache: typeof ParserModule | null = null;

async function loadParser(): Promise<typeof ParserModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/parse-node-result.ts', import.meta.url).href
  )) as typeof ParserModule;
  return cache;
}

/** Wraps a payload in the fenced block a session emits to route itself. */
function block(payload: string): string {
  return ['```resultado', payload, '```'].join('\n');
}

test('a well-formed block yields the observed result', async () => {
  const { parseNodeResult } = await loadParser();

  const output = [
    'Rodei a suíte e caminhei os critérios de aceite.',
    'Dois deles falharam, então este trabalho volta para desenvolvimento:',
    block(JSON.stringify({ resultado: 'retrabalho' })),
  ].join('\n');

  assert.deepEqual(parseNodeResult(output), { resultado: 'retrabalho' });
});

test('no block at all yields null', async () => {
  const { parseNodeResult } = await loadParser();

  assert.equal(parseNodeResult(''), null);
  assert.equal(parseNodeResult('Terminei o nó e não escolhi aresta nenhuma.'), null);
  assert.equal(
    parseNodeResult('```json\n{"resultado":"aprovado"}\n```'),
    null,
    'a fence of another kind is not a routing block',
  );
});

test('a malformed block yields null instead of throwing', async () => {
  const { parseNodeResult } = await loadParser();

  // Same rule the escalation parser keeps: bad model output must never crash a
  // dispatch. What it costs here is a routing escalation, which is a human
  // being called — not a session lost.
  assert.equal(parseNodeResult(block('{"resultado": "unterminated')), null);
  assert.equal(parseNodeResult(block('not json at all')), null);
  assert.equal(parseNodeResult(block(JSON.stringify(['aprovado']))), null);
  assert.equal(parseNodeResult(block(JSON.stringify({ resultado: '   ' }))), null);
  assert.equal(
    parseNodeResult(block(JSON.stringify({ resultado: 42 }))),
    null,
    'the result is a label, and a number is not one',
  );
});

test('with more than one block, the last one wins', async () => {
  const { parseNodeResult } = await loadParser();

  const output = [
    'A primeira leitura me deu isto:',
    block(JSON.stringify({ resultado: 'aprovado' })),
    'depois eu reli a evidência e o veredito mudou:',
    block(JSON.stringify({ resultado: 'retrabalho' })),
  ].join('\n');

  assert.deepEqual(parseNodeResult(output), { resultado: 'retrabalho' });
});

test('a malformed block does not shadow a valid one, in either order', async () => {
  const { parseNodeResult } = await loadParser();

  assert.deepEqual(
    parseNodeResult([block('{"resultado": broken'), block(JSON.stringify({ resultado: 'aprovado' }))].join('\n')),
    { resultado: 'aprovado' },
  );
  assert.deepEqual(
    parseNodeResult([block(JSON.stringify({ resultado: 'aprovado' })), block('{"resultado": broken')].join('\n')),
    { resultado: 'aprovado' },
    'garbage after the answer cannot erase the answer',
  );
});

test('a payload carrying its own fence does not truncate the block', async () => {
  const { parseNodeResult } = await loadParser();

  // The reason the extent comes from the JSON and never from a search for the
  // closing fence — inherited whole from the escalation parser, which is the
  // point of sharing one scanner.
  const evidence = 'A suíte imprimiu:\n```\n1 failing\n```\ne foi só isso.';
  const output = block(JSON.stringify({ resultado: 'retrabalho', evidencia: evidence }));

  assert.deepEqual(parseNodeResult(output), { resultado: 'retrabalho', evidencia: evidence });
});

/* -- t259: the block is the node's REPORT, and the label is one field of it -- */

/**
 * The whole payload comes back, and the routing label is one field inside it.
 *
 * Until t259 this parser kept `resultado` and threw the rest away, because the
 * only consumer was `advance()` and the only question was which edge to take.
 * The block is also the only thing a session prints that has the shape of its
 * node's `output_schema` — and that object is what `PATCH /sessions/:id/finish`
 * stores and what the next node's `input` is projected from. Dropping every key
 * but one left that whole channel with no producer.
 */
test('t259 — the whole payload of the block comes back, not just the label', async () => {
  const { parseNodeResult } = await loadParser();

  const payload = {
    resultado: 'aprovado',
    outcome: 'pass',
    vereditos: [{ ref: 'AT1', veredito: 'passou', evidencia: 'rodei e li a saída' }],
  };

  assert.deepEqual(parseNodeResult(block(JSON.stringify(payload))), payload);
});

test('t259 — a block with no label at all is a report, and it comes back whole', async () => {
  const { parseNodeResult } = await loadParser();

  // A `work` node with a single way out has no decision to report and its
  // `output_schema` declares no `resultado` — `desenvolver` produces
  // `{branch, commits, …}` and nothing else. Read as "not a block", as this
  // parser read it until t259, its report reached `/finish` as nothing at all
  // and the node after it had no input to resolve against.
  const payload = { branch: 'ticket-259', commits: ['abc1234'], nota: 'fiz o combinado' };

  assert.deepEqual(parseNodeResult(block(JSON.stringify(payload))), payload);
});

test('t259 — a label that is not a usable string still refuses the whole block', async () => {
  const { parseNodeResult } = await loadParser();

  // The one rule that did NOT loosen: a `resultado` that is present and is not
  // a label is a session that did not understand the protocol, and taking the
  // rest of its payload as a report would store an object nobody can trust
  // beside a routing decision that can never be taken.
  assert.equal(
    parseNodeResult(block(JSON.stringify({ resultado: 42, evidencia: 'li tudo' }))),
    null,
    'the result is a label, and a number is not one',
  );
  assert.equal(parseNodeResult(block(JSON.stringify({ resultado: { a: 1 } }))), null);
  assert.equal(parseNodeResult(block(JSON.stringify({ resultado: null, nota: 'x' }))), null);
});
