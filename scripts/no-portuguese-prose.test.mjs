/**
 * Regression guard for the extraction of the four prose signals (t300, FR9).
 *
 * `scripts/no-portuguese-prose.mjs` was not written; it was cut out of two gates
 * that already worked. The only way that refactor breaks anything is silently —
 * a character dropped from the diacritic class, a word lost from the stopword
 * list, a flag added or removed — and the symptom is not a red gate but a quiet
 * one, still passing over Portuguese it stopped being able to see.
 *
 * So this file does not test the module against an idea of what it should
 * match. It tests it against the exact regular expressions the two existing
 * sweeps declared before the extraction, transcribed here as source text and
 * compared by `toString()`. If somebody edits the shared module, this is what
 * says the edit changed the behaviour of every gate at once.
 *
 * The sample is the second half: a fixed run of lines, half Portuguese and half
 * English, with the verdict each signal is supposed to reach on each one. It is
 * the part that would catch a rewrite that keeps the same `toString()` shape by
 * accident — and it is what documents, for the next reader, what these
 * expressions are actually for.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DIACRITIC, GLOSS, STOPWORD, blank } from './no-portuguese-prose.mjs';

/**
 * The three expressions as `tests/no-portuguese-reader-documents.test.mjs` and
 * `tests/no-portuguese-factory-bundles.test.mjs` declared them, byte for byte,
 * before this module took them over. Both files carried these same three.
 */
const BEFORE = Object.freeze({
  DIACRITIC: '/[çãõáéíóúê]/i',
  STOPWORD: '/\\b(não|você|para|com|uma|nesta|deste)\\b/',
  GLOSS: '/\\(literally "[^"]*"\\)/g',
});

/**
 * Lines with the verdict each signal owes them.
 *
 * `diacritic` and `stopword` are what the two detectors must answer; `gloss` is
 * what survives after the one exempt span is cut, which is how a gate decides
 * whether the Portuguese it can see was supposed to be there.
 */
const SAMPLE = Object.freeze([
  Object.freeze({
    line: 'A execução não termina sem uma decisão.',
    diacritic: true,
    stopword: true,
  }),
  Object.freeze({ line: 'O grafo e as arestas do documento.', diacritic: false, stopword: false }),
  Object.freeze({ line: 'uma nota sobre o runner', diacritic: false, stopword: true }),
  // STOPWORD carries no `i` flag, and never did: a capitalised `Uma` opening a
  // sentence goes unseen. Pinned rather than fixed — widening the expression is
  // a change to three gates at once, and belongs to whoever measures the cost.
  Object.freeze({ line: 'Uma nota sobre o runner.', diacritic: false, stopword: false }),
  Object.freeze({ line: 'The graph is frozen during execution.', diacritic: false, stopword: false }),
  Object.freeze({ line: 'A lease with a heartbeat, and nothing else.', diacritic: false, stopword: false }),
  Object.freeze({ line: 'banco_de_testes, perguntas_respondidas', diacritic: false, stopword: false }),
  Object.freeze({ line: 'A note about the topografo, per D14.', diacritic: false, stopword: false }),
]);

test('AT-FR9 — the three expressions are the ones the two sweeps declared', () => {
  assert.equal(DIACRITIC.toString(), BEFORE.DIACRITIC);
  assert.equal(STOPWORD.toString(), BEFORE.STOPWORD);
  assert.equal(GLOSS.toString(), BEFORE.GLOSS);
});

test('AT-FR9 — each signal reaches the same verdict it reached before', () => {
  for (const entry of SAMPLE) {
    assert.equal(
      DIACRITIC.test(entry.line),
      entry.diacritic,
      `DIACRITIC disagrees on: ${entry.line}`,
    );
    assert.equal(STOPWORD.test(entry.line), entry.stopword, `STOPWORD disagrees on: ${entry.line}`);
  }
});

test('AT-FR9 — a stateless detector: the same line answers the same twice', () => {
  const line = 'A execução não termina.';

  assert.equal(DIACRITIC.test(line), DIACRITIC.test(line));
  assert.equal(STOPWORD.test(line), STOPWORD.test(line));
  assert.equal(GLOSS.lastIndex, 0, 'GLOSS carries state between callers');
});

test('AT-FR9 — the gloss span is cut, and only it', () => {
  const glossed = 'Rendered as "absence has a name" (literally "ausência tem nome") in §3.';

  assert.equal(DIACRITIC.test(glossed), true, 'the sample has to carry Portuguese to be a test');
  assert.equal(
    DIACRITIC.test(glossed.replace(GLOSS, '')),
    false,
    'the gloss is where the original survives; nothing else on the line may',
  );

  const kept = 'A frase é "ausência tem nome".';
  assert.equal(
    DIACRITIC.test(kept.replace(GLOSS, '')),
    true,
    'Portuguese outside a gloss must stay visible to the sweep',
  );
});

test('AT-FR9 — blank() keeps the length and the line count', () => {
  assert.equal(blank('condição'), '        ');
  assert.equal(blank('abc'.repeat(4)).length, 12);
  assert.equal(blank('one\ntwo\nthree'), '   \n   \n     ');
  assert.equal(blank(''), '');
});
