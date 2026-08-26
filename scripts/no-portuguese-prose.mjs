/**
 * The four signals every D24 prose sweep stands on, written down once (t300, FR9).
 *
 * Three root gates read documents rather than code and ask the same two
 * questions of every line: does it carry a Portuguese diacritic, and does it
 * carry one of a handful of Portuguese function words. Until this module existed
 * the two questions were declared verbatim in each of them, and the third gate
 * this ticket adds would have made a third copy.
 *
 * That is the whole of what is shared. Each gate keeps its own idea of WHICH
 * lines to ask about — the reader-facing sweep blanks fenced blocks and backtick
 * spans, the factory-bundle sweep reads raw lines because JSON has no fence, and
 * the document-tree sweep does one or the other depending on the extension. Those
 * strategies differ on purpose and merging them would be the mistake t287 already
 * documented for the seventeen per-package sweeps: what looks like one list is
 * usually several lists that happen to rhyme.
 *
 * ## Why `scripts/` and not `packages/test-support`
 *
 * The same tradeoff `scripts/frozen-portuguese-identifiers.mjs` recorded in its
 * own header. That package is TypeScript with no build step, and the root test
 * group runs `node --test tests/**\/*.test.mjs` with no tsx loader
 * (`scripts/run-all-tests.mjs`), so a plain `.mjs` module beside the scripts is
 * what a root `.mjs` gate can import without adding a loader to the group. Four
 * constants do not justify that cost.
 *
 * Nothing here runs on its own; it is imported by the gates that do.
 */

/**
 * A Portuguese diacritic. No English word in this repository carries one.
 *
 * Not global, so `exec` never advances a `lastIndex` between callers. Every
 * consumer shares this one object.
 */
export const DIACRITIC = /[çãõáéíóúê]/i;

/** Portuguese function words, common in its prose and absent from English. */
export const STOPWORD = /\b(não|você|para|com|uma|nesta|deste)\b/;

/**
 * The one span where the original is supposed to survive.
 *
 * D24's convention: where an English rendering would flatten a nuance the
 * Portuguese carried, the original stays inline as `(literally "<phrase>")`.
 * Global, and only ever handed to `String.prototype.replace`, which resets
 * `lastIndex` on entry — so sharing the object across gates is safe.
 */
export const GLOSS = /\(literally "[^"]*"\)/g;

/**
 * Replaces a span with same-length blanks, so a column number stays honest.
 *
 * Newlines survive, so a whole-file replacement keeps its line count and the
 * index of a line in the result is still its number in the file.
 *
 * @param {string} text The span to blank out.
 * @returns {string} The same length, spaces except for the newlines.
 */
export function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/** An opening or closing code fence, and the run of backticks that makes it. */
export const FENCE = /^\s*(`{3,})/;

/**
 * A backtick span, of any backtick run length, within one line.
 *
 * Within one line ON PURPOSE, and this is not the bug it looks like. t300
 * widened `.` to `[\s\S]` so that a wrapped span would still be one span, and
 * reverted it: a single unbalanced backtick anywhere above then pairs across
 * the line break and INVERTS every pairing after it, blanking the gaps between
 * spans instead of the spans. Per line, an odd backtick spoils its own line and
 * nothing else.
 *
 * The cost is a real constraint on prose: a quotation that must survive is kept
 * inside one line, or the matcher cannot see that it is marked.
 */
export const SPAN = /(`+)(.+?)\1/g;

/**
 * One line with every backtick span blanked out; the backticks stay.
 *
 * The third of the D24 cuts, extracted here by t314 (FR3) rather than
 * transcribed a fourth time. `tests/no-portuguese-reader-documents.test.mjs`
 * and `tests/no-portuguese-document-tree.test.mjs` still carry their own byte
 * -identical copies, which t314 left alone because neither is in its declared
 * file set; folding them onto this one is the consolidation its closing note
 * recommends.
 *
 * @param {string} line One line of a file.
 * @returns {string} The same length, every quoted span blanked.
 */
export function withoutSpans(line) {
  let kept = line;

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + blank(match[2]) + kept.slice(end);
  }

  return kept;
}

/**
 * A document reduced to its prose: no code span, no fenced block, no gloss.
 *
 * Blanked rather than dropped, so the index of a line in the result is still
 * its number in the file and a failure can name it.
 *
 * @param {string} markdown Contents of one document.
 * @returns {string[]} One entry per line of the input, prose intact, rest blank.
 */
export function proseOf(markdown) {
  const prose = [];
  let fence = null;

  for (const line of markdown.split('\n')) {
    const opener = FENCE.exec(line);
    if (fence !== null) {
      prose.push('');
      if (opener !== null && opener[1].startsWith(fence)) fence = null;
      continue;
    }
    if (opener !== null) {
      fence = opener[1];
      prose.push('');
      continue;
    }

    prose.push(withoutSpans(line.replace(GLOSS, '')));
  }

  return prose;
}
