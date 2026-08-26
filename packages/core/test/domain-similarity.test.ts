/**
 * Acceptance tests of the textual similarity (t113, AT1–AT2).
 *
 * The precedent base needs ONE comparable number between two questions, and v1
 * picks the most transparent one there is: Jaccard over the tokens of the
 * normalized text. There are no embeddings in the decided stack (D17), and the
 * score's contract (`[0, 1]`) is precisely what lets the heuristic be swapped
 * later without touching the route.
 *
 * Two deliberate boundaries, proven here:
 *
 * - **Normalizing is not interpreting.** Lowercase, punctuation out, whitespace
 *   collapsed, `trim` — and no stemming and no accent stripping: `naïve` and
 *   `naive` are different words for this v1, and pretending otherwise would
 *   hide the heuristic behind magic.
 * - **A short token does not score.** Portuguese prepositions and articles, which
 *   `src/domain/similarity.ts` names as the reason, would show up in every
 *   question and push the score of any pair away from zero; the cut at 3
 *   characters is what keeps the number informative.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as SimilarityModule from '../src/domain/similarity.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

let similarityCache: typeof SimilarityModule | null = null;

/** Loads the module on demand: on the initial red the failure NAMES the artifact. */
async function loadSimilarity(): Promise<typeof SimilarityModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'domain', 'similarity.ts');
  assert.ok(
    existsSync(modulePath),
    'artifact does not exist yet: packages/core/src/domain/similarity.ts',
  );
  similarityCache ??= (await import(
    new URL('../src/domain/similarity.ts', import.meta.url).href
  )) as typeof SimilarityModule;
  return similarityCache;
}

test('AT1 — normalizeText lowercases, strips punctuation, collapses whitespace and trims', async () => {
  const { normalizeText } = await loadSimilarity();

  assert.equal(normalizeText('  Merge The Trio, of tables?!  '), 'merge the trio of tables');

  assert.equal(
    normalizeText('Renumber   the\n naïve  migration to 0003?'),
    'renumber the naïve migration to 0003',
    'the accent SURVIVES: normalizing is not interpreting',
  );
  assert.equal(normalizeText(''), '');
});

test('AT2 — similarity is 1 on identical, 0 on disjoint and in between on partial', async () => {
  const { similarity } = await loadSimilarity();

  assert.equal(
    similarity('Merge the trio of tables?', '  MERGE THE TRIO OF TABLES  '),
    1,
    'the same text after normalizing is the same text',
  );

  assert.equal(
    similarity('Renumber the migration to 0003?', 'Which engine adapter goes in dispatch?'),
    0,
    'with no token in common the score is zero — not some small number',
  );

  const partial = similarity('renumber the migration to 0003', 'renumber the migration to 0004');
  assert.ok(partial > 0 && partial < 1, `expected 0 < score < 1, got ${partial}`);

  // The score lives in the closed range [0, 1] — that is the contract that lets
  // the heuristic be swapped later without touching the route's contract.
  for (const pair of [
    ['', ''],
    ['a of in', 'a of in'],
    ['all different here', ''],
  ] as const) {
    const score = similarity(pair[0], pair[1]);
    assert.ok(score >= 0 && score <= 1, `score outside [0, 1]: ${score}`);
  }
});
