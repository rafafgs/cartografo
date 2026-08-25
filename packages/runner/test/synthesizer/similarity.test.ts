/**
 * Acceptance test of the runner's local similarity port (t115, AT1).
 *
 * The heuristic is the core's — Jaccard over the tokens of the normalized text
 * (`packages/core/src/domain/similarity.ts`, t113) — and this is a PORT, not an
 * import. Same reason `domain/graph.ts` ports `scripts/validate-graph.mjs`
 * instead of reaching across the package boundary: the runner is an ordinary
 * API client (D1/D11), and a compile-time dependency on the control plane's
 * internals is exactly the coupling the boundary exists to forbid.
 *
 * A port only earns its keep if it cannot drift, so this file runs the SAME
 * cases as `packages/core/test/domain-similarity.test.ts` against the copy: the
 * accent survives, a short token does not score, identical is `1`, disjoint is
 * `0`, and every score lives in `[0, 1]`.
 *
 * English per D18; the fixtures stay in Portuguese because the texts being
 * compared are the project's own domain vocabulary.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as SimilarityModule from '../../src/synthesizer/similarity.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/synthesizer/similarity.ts';

let cache: typeof SimilarityModule | null = null;

/** Loads on demand: on the initial red the failure NAMES the missing artifact. */
async function loadSimilarity(): Promise<typeof SimilarityModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/synthesizer/similarity.ts', import.meta.url).href
  )) as typeof SimilarityModule;
  return cache;
}

test('AT1 — normalizeText behaves exactly like the core it was ported from', async () => {
  const { normalizeText } = await loadSimilarity();

  assert.equal(normalizeText('  Unifico O Trio, de tabelas?!  '), 'unifico o trio de tabelas');

  assert.equal(
    normalizeText('Renumerar   a\n migração  para 0003?'),
    'renumerar a migração para 0003',
    'the accent SURVIVES: normalizing is not interpreting',
  );
  assert.equal(normalizeText(''), '');
});

test('AT1 — similarity is 1 on identical, 0 on disjoint and in between on partial', async () => {
  const { similarity } = await loadSimilarity();

  assert.equal(
    similarity('Unifico o trio de tabelas?', '  UNIFICO O TRIO DE TABELAS  '),
    1,
    'the same text after normalizing is the same text',
  );

  assert.equal(
    similarity('Renumerar a migração para 0003?', 'Qual engine adapter usar no despacho?'),
    0,
    'with no token in common the score is zero — not some small number',
  );

  const partial = similarity('renumerar a migração para 0003', 'renumerar a migração para 0004');
  assert.ok(partial > 0 && partial < 1, `expected 0 < score < 1, got ${partial}`);

  for (const pair of [
    ['', ''],
    ['a de no', 'a de no'],
    ['tudo diferente aqui', ''],
  ] as const) {
    const score = similarity(pair[0], pair[1]);
    assert.ok(score >= 0 && score <= 1, `score outside [0, 1]: ${score}`);
  }
});

test('AT1 — the port is symmetric and blind to word order, like the original', async () => {
  const { similarity } = await loadSimilarity();

  const a = 'desenvolvimento de software com portão de revisão';
  const b = 'portão de revisão com desenvolvimento de software';

  assert.equal(similarity(a, b), similarity(b, a), 'symmetric: (a, b) is (b, a)');
  assert.equal(similarity(a, b), 1, 'the same vocabulary in another order is the same set');

  // And a word that only one side has is genuinely extra vocabulary — the score
  // falls, which is the whole reason a set index was picked over an equality.
  const wider = similarity(a, `${b} incremental`);
  assert.ok(wider > 0 && wider < 1, `expected 0 < score < 1, got ${wider}`);
});
