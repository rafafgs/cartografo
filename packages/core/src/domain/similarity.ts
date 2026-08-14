/**
 * Textual similarity between input requests — the precedent base's heuristic
 * (t113).
 *
 * `notas/2026-08-14-aprendizado.md` puts the precedent base among the mechanisms
 * that make learning last: an answered question becomes something one can look
 * up. Looking it up needs ONE comparable number between two texts, and v1 picks
 * the most transparent one there is — the Jaccard index over the tokens of the
 * normalized text. There is no embedding and no vector store in the decided
 * stack (D17), and inventing one here would be deciding outside the record.
 *
 * The contract that matters is the RANGE, not the formula: the score lives in
 * `[0, 1]`, and that is what lets the heuristic be swapped later (embeddings,
 * BM25, whatever) without touching the contract of the route that consumes it.
 *
 * Pure on purpose, like `domain/operations.ts`: nothing here knows about
 * `Database`. Reading a stored row is the repository's job; here only text goes
 * in and a number comes out.
 */

/**
 * Length floor for a token that scores.
 *
 * Portuguese prepositions and articles ("a", "de", "no", "em") show up in
 * practically every question: counting them would push the score of ANY pair
 * away from zero, and a ranking where everything looks like everything helps
 * nobody decide. Three characters is the cut that keeps the number informative
 * without demanding a stopword list — which would be one more thing to maintain.
 */
const MINIMUM_TOKEN_LENGTH = 3;

/** Anything that is neither a letter nor a digit splits tokens (into one space). */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * Puts the text into the shape in which two texts are comparable.
 *
 * Lowercase, punctuation out, whitespace collapsed, ends trimmed — and nothing
 * beyond that. No stemming and no accent stripping BY DECISION: both hide the
 * heuristic behind magic, and `migração` and `migracao` being different words is
 * behaviour that explains itself in one line, while a badly tuned Portuguese
 * stemmer is not.
 *
 * @param text Raw text, as it came from the stored question.
 * @returns The normalized text; empty string when nothing was left.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(SEPARATORS, ' ').trim();
}

/** The set of scoring tokens — repetition does not count, this is set Jaccard. */
function tokensOf(text: string): Set<string> {
  const parts = normalizeText(text)
    .split(' ')
    .filter((token) => token.length >= MINIMUM_TOKEN_LENGTH);
  return new Set(parts);
}

/**
 * Jaccard index between the tokens of two texts: intersection over union.
 *
 * Identical text after normalizing is worth `1`; no token in common is worth
 * `0`; in between, the fraction of shared vocabulary. Symmetric (`a, b` ==
 * `b, a`) and independent of word order — two properties that make it
 * predictable for whoever reads the ranking.
 *
 * The degenerate case — neither text has a token of 3+ characters, so the union
 * is empty and the division does not exist — falls back to comparing the
 * normalized texts directly. That is what preserves both ends of the contract at
 * once: identical still scores `1` and non-identical still scores `0`, instead
 * of letting `NaN` leak into a sort.
 *
 * @param a One text.
 * @param b The other one.
 * @returns Score in `[0, 1]`.
 */
export function similarity(a: string, b: string): number {
  const tokensA = tokensOf(a);
  const tokensB = tokensOf(b);

  const union = new Set([...tokensA, ...tokensB]);
  if (union.size === 0) return normalizeText(a) === normalizeText(b) ? 1 : 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }

  return intersection / union.size;
}
