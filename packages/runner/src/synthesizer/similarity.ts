/**
 * Textual similarity — local port of `packages/core/src/domain/similarity.ts`
 * (t115, FR3).
 *
 * A PORT, deliberately, and not an import across the package boundary. The
 * runner is an ordinary client of the public API (D1/D11): it speaks HTTP and
 * nothing else, and a compile-time reach into the control plane's `domain/`
 * would be the first crack in the wall `test/no-privileged-access.test.ts`
 * exists to keep. It is the same trade the core itself already made when
 * `domain/graph.ts` ported `scripts/validate-graph.mjs` instead of loading it.
 *
 * A copy that can drift is worse than no copy, so the parity is a test, not a
 * promise: `test/synthesizer/similarity.test.ts` runs the cases of
 * `packages/core/test/domain-similarity.test.ts` against this file. Change the
 * heuristic on one side and the other side's suite says so.
 *
 * What the number is used for here is narrower than in the precedent base: it
 * only ranks which already-registered classes look like the declaration the
 * user typed, and the ranking is a non-blocking SUGGESTION (D8 — whoever names
 * the class already named it). So the score deciding nothing on its own is a
 * feature, not a limitation.
 */

/**
 * Length floor for a token that scores.
 *
 * Portuguese prepositions and articles ("a", "de", "no", "em") show up in
 * practically every declaration: counting them would push the score of ANY pair
 * away from zero, and a ranking where everything looks like everything helps
 * nobody decide.
 */
const MINIMUM_TOKEN_LENGTH = 3;

/** Anything that is neither a letter nor a digit splits tokens (into one space). */
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/**
 * Puts the text into the shape in which two texts are comparable.
 *
 * Lowercase, punctuation out, whitespace collapsed, ends trimmed — and nothing
 * beyond that. No stemming and no accent stripping BY DECISION: both hide the
 * heuristic behind magic, and `migrate` and `migration` staying two different
 * words — as does any word spelled with and without its accents — is behaviour
 * that explains itself in one line.
 *
 * @param text Raw text: the declaration, or a class's name and description.
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
 * `0`; in between, the fraction of shared vocabulary. Symmetric and independent
 * of word order — two properties that make it predictable for whoever reads the
 * ranking the command prints.
 *
 * The degenerate case — neither text has a token of 3+ characters, so the union
 * is empty and the division does not exist — falls back to comparing the
 * normalized texts directly, which is what keeps `NaN` out of a sort.
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
