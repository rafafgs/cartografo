/**
 * Acceptance tests for the semantic-diff renderer (AT6–AT7).
 *
 * D15 says a proposal carries a semantic diff, not a line diff — the whole
 * point is that a human can judge it ("adds a red team gate before deploy").
 * Dumping the raw operation JSON on the page would throw that away, so the
 * renderer owes one readable line per operation, one per type, in the
 * vocabulary of `docs/spec/entities-versioning.md` §3.
 *
 * The wording is pinned here, byte for byte, because it IS the spec: this is
 * the text a person reads before deciding to approve, and a silent change of
 * wording is a change of what they were shown.
 *
 * Since t228 the INPUT is English (`type`, `node`, `node_id`, `edge`, `field`,
 * `from`, `to`) and the OUTPUT is the same Portuguese prose as before. That
 * asymmetry is the claim: the vocabulary that moved is the one on the wire, and
 * a person reading the inbox sees exactly what they saw yesterday.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as DiffModule from '../src/public/diff.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const DIFF_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'diff.js');

let cache: typeof DiffModule | null = null;

async function loadDiff(): Promise<typeof DiffModule> {
  assert.ok(existsSync(DIFF_PATH), 'artifact does not exist yet: packages/tela/src/public/diff.js');
  cache ??= (await import(
    new URL('../src/public/diff.js', import.meta.url).href
  )) as typeof DiffModule;
  return cache;
}

test('AT6 — one readable line per operation, one per type of the §3 vocabulary', async () => {
  const { renderOperations } = await loadDiff();

  const operations = [
    {
      type: 'add_node',
      node: { id: 'red_team', node_type: 'gate', role: 'conferir', skill_ref: 'red-team@1' },
    },
    { type: 'remove_node', node_id: 'revisar_manual' },
    { type: 'add_edge', edge: { from: 'testar', to: 'red_team', condition: 'aprovado' } },
    { type: 'remove_edge', edge: { from: 'testar', to: 'implantar' } },
    {
      type: 'change_node_field',
      node_id: 'implementar',
      field: 'role',
      from: 'fazer',
      to: 'conferir',
    },
  ];

  assert.deepEqual(renderOperations(operations), [
    '+ nó "red_team" (tipo gate)',
    '- nó "revisar_manual"',
    '+ aresta testar → red_team (condição: aprovado)',
    '- aresta testar → implantar',
    '~ nó "implementar": campo "role" de "fazer" para "conferir"',
  ]);
});

test('AT6 — an operation the screen does not know still renders as prose, never as raw JSON', async () => {
  const { renderOperations } = await loadDiff();

  const lines = renderOperations([
    { type: 'mover_no', node_id: 'implementar' },
    'isto não é uma operação',
    null,
    { type: 'add_edge', edge: { from: 'a', to: 'b' } },
  ]);

  assert.deepEqual(lines, [
    '? operação de tipo desconhecido ("mover_no")',
    '? operação malformada',
    '? operação malformada',
    '+ aresta a → b',
  ]);
  for (const line of lines) {
    assert.doesNotMatch(line, /[{[]\s*"?type/, 'no line may be the raw operation JSON');
  }
});

test('AT7 — an empty or absent diff says so, never prints "[]" and never throws', async () => {
  const { renderOperations, EMPTY_DIFF_LINE } = await loadDiff();

  assert.equal(EMPTY_DIFF_LINE, 'nenhuma alteração');
  assert.deepEqual(renderOperations([]), [EMPTY_DIFF_LINE]);

  for (const absent of [undefined, null, 'nada disso', 7, {}]) {
    assert.deepEqual(
      renderOperations(absent as never),
      [EMPTY_DIFF_LINE],
      `operacoes ${JSON.stringify(absent)} should become explicit text, not an exception`,
    );
  }

  assert.ok(!renderOperations([]).join('\n').includes('[]'));
});
