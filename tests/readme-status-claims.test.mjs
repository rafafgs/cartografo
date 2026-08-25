/**
 * Gate: the README's status line is true in both directions (t297, AC2/AC3).
 *
 * The sixth line of this repository said `State: idea on the record,
 * pre-prototype.` from 2026-08-14 until this ticket. Roughly two hundred tickets
 * later there is a control plane, a runner, a screen and two factory graphs, and
 * both of those graphs closed a real traversal with no operator on 2026-08-18.
 * It was the most misleading sentence in the tree and it was above the fold.
 *
 * The honest correction cuts both ways, which is the whole reason this gate has
 * three tests and not one. Deleting `pre-prototype` and stopping there would
 * trade an understatement for an overstatement: the learning loop — the half the
 * meta-layer actually rests on — stands at n=1, with no version B and no A/B
 * measurement of any proposal, because the round that was to produce it was
 * killed twice by the account's own quota. A conceptual repository earns trust
 * by being exact about its own boundary, not by sounding finished. So:
 *
 * - **AT5** forbids the retired claims;
 * - **AT6** requires the proven half, with its citation;
 * - **AT7** requires the unproven half, with its citation.
 *
 * ## What is asserted, and what is left to the author
 *
 * The prose is Rafael's and this ticket corrects facts rather than re-voicing
 * them, so nothing here pins a sentence. AT5 is a substring blocklist, AT6 and
 * AT7 are co-occurrence checks inside one paragraph. A paragraph is the unit
 * because it is the smallest span this repository's eighty-column wrapping keeps
 * intact: a claim and its citation wrap across three lines routinely, and a
 * sentence splitter would have to know about `§`, `US$` and `D14.` to find them.
 *
 * ## The two readings
 *
 * AT5 reads PROSE — fenced blocks and backtick spans blanked, the cut
 * `tests/no-portuguese-document-tree.test.mjs` established — because a retired
 * claim quoted as data is not a claim. If a later ticket writes
 * `` `pre-prototype` `` inside a table of what the README used to say, that is a
 * historical record and this gate has nothing to say about it.
 *
 * AT6 and AT7 read the file RAW, and deliberately: what they look for is a
 * citation, and this repository writes a cited filename as a code span
 * (`` [`notas/x.md`](notas/x.md) ``). Blanking spans first would blank the very
 * token being searched for.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { blank } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The one document this gate reads. */
export const README = 'README.md';

/** The claims the repository outgrew, which no sentence of it may make again. */
export const RETIRED_CLAIMS = Object.freeze(['pre-prototype', 'idea on the record', 'unbuilt']);

/**
 * The two traversals of 2026-08-18, each with the note that recorded it.
 *
 * `citation` is the token searched for in the raw text — the note's basename is
 * enough to be unambiguous and short enough to survive a reflow. `graph` is what
 * the paragraph has to be talking about, so that a citation dropped in the wrong
 * place does not satisfy the claim.
 */
export const TRAVERSALS = Object.freeze([
  Object.freeze({
    what: 'the software graph',
    note: 'notas/2026-08-18-game-feature-2.md',
    citation: '2026-08-18-game-feature-2.md',
    graph: /software graph/i,
  }),
  Object.freeze({
    what: 'the asymmetric-bets graph',
    note: 'notas/2026-08-18-third-bets-run.md',
    citation: '2026-08-18-third-bets-run.md',
    graph: /bets graph/i,
  }),
]);

/** The note that records what the learning loop did NOT reach. */
export const LEARNING_NOTE = 'notas/2026-08-18-n3-round.md';

/** Ways of saying a traversal ran with nobody driving it. The notes' own words. */
const UNATTENDED = /\bno operator\b|\bwith nobody\b|\bon (its|their) own\b|\bunattended\b/i;

/** An `n=1` marker, however it is spaced. */
const SAMPLE_OF_ONE = /\bn\s*=\s*1\b/;

/** `A/B` denied: the negation before it, or the denial after it. */
const NO_AB_MEASUREMENT =
  /\b(no|not|never|without|nothing)\b[^.]{0,120}A\/B|A\/B[^.]{0,120}\b(does not exist|never|no)\b/i;

/** An opening or closing code fence, and the run of backticks that makes it. */
const FENCE = /^\s*(`{3,})/;

/** A backtick span, of any backtick run length, within one line. */
const SPAN = /(`+)(.+?)\1/g;

/** The line with every backtick span blanked out; the backticks stay. */
function withoutSpans(line) {
  let kept = line;

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + blank(match[2]) + kept.slice(end);
  }

  return kept;
}

/**
 * A document reduced to its prose: no fenced block, no backtick span.
 *
 * Blanked rather than dropped, so the index of a line in the result is still its
 * number in the file. Same strategy as the D24 sweeps, kept local for the reason
 * their headers give: the decision about WHICH lines to read belongs to the gate
 * that reads them.
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

    prose.push(withoutSpans(line));
  }

  return prose;
}

/**
 * The document as paragraphs: runs of non-blank lines, each joined into one
 * string so a claim that wrapped over three lines can be read as one sentence.
 *
 * @param {string} markdown Contents of one document.
 * @returns {string[]} One entry per paragraph, in order.
 */
export function paragraphsOf(markdown) {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').join(' ').trim())
    .filter((block) => block !== '');
}

/** The one paragraph carrying a token, or `null` when no paragraph does. */
function paragraphWith(paragraphs, token) {
  return paragraphs.find((paragraph) => paragraph.includes(token)) ?? null;
}

/** Every retired claim in one document's prose, with the line that makes it. */
export function retiredClaimsIn(markdown) {
  const prose = proseOf(markdown);
  const found = [];

  prose.forEach((line, index) => {
    for (const claim of RETIRED_CLAIMS) {
      if (line.toLowerCase().includes(claim)) {
        found.push(`${README}:${String(index + 1)}: "${claim}" — ${line.trim().slice(0, 120)}`);
      }
    }
  });

  return found;
}

/** The README, whole. */
function readme() {
  return readFileSync(path.join(ROOT, README), 'utf8');
}

test('AT5 — no sentence of the README calls the project unbuilt any more', () => {
  const offenders = retiredClaimsIn(readme());

  assert.deepEqual(
    offenders,
    [],
    'the README still describes a repository that does not exist; two factory graphs ' +
      `closed a real traversal on 2026-08-18:\n${offenders.join('\n')}`,
  );
});

test('AT5 — the blocklist reads prose and spares quoted data', () => {
  assert.deepEqual(
    retiredClaimsIn('# x\n\nState: idea on the record, pre-prototype.\n'),
    [
      'README.md:3: "pre-prototype" — State: idea on the record, pre-prototype.',
      'README.md:3: "idea on the record" — State: idea on the record, pre-prototype.',
    ],
    'the retired sentence has to be seen, once per claim it makes: one line making two of ' +
      'them is reported twice, so a half-repair cannot go quiet',
  );

  assert.deepEqual(
    retiredClaimsIn('# x\n\nIt used to say `pre-prototype` here.\n'),
    [],
    'a retired claim quoted as data is a historical record, not a claim',
  );

  assert.deepEqual(
    retiredClaimsIn('# x\n\n```\npre-prototype\n```\n'),
    [],
    'a fenced block is data too; the same cut the D24 sweeps take',
  );
});

test('AT6 — both factory graphs are stated to have closed an unattended traversal', () => {
  const contents = readme();
  const paragraphs = paragraphsOf(contents);

  for (const traversal of TRAVERSALS) {
    assert.ok(
      existsSync(path.join(ROOT, traversal.note)),
      `${traversal.note} is not in the tree; a citation of a note that does not exist is worse ` +
        'than no citation',
    );

    const paragraph = paragraphWith(paragraphs, traversal.citation);

    assert.notEqual(
      paragraph,
      null,
      `the README makes no claim citing ${traversal.note}; ${traversal.what} closed a real ` +
        'traversal and the evidence is what makes that readable as a fact rather than a boast',
    );

    assert.match(
      paragraph,
      traversal.graph,
      `the paragraph citing ${traversal.note} never says which graph it is about`,
    );

    assert.match(
      paragraph,
      UNATTENDED,
      `the paragraph citing ${traversal.note} does not say the traversal ran with no operator, ` +
        'which is the whole of what that round proved',
    );
  }
});

test('AT7 — the README says the learning loop has no A/B measurement behind it', () => {
  const contents = readme();
  const paragraphs = paragraphsOf(contents);

  assert.ok(
    existsSync(path.join(ROOT, LEARNING_NOTE)),
    `${LEARNING_NOTE} is not in the tree; the caveat has nothing to cite`,
  );

  const denial = paragraphs.find((paragraph) => NO_AB_MEASUREMENT.test(paragraph)) ?? null;

  assert.notEqual(
    denial,
    null,
    'the README never says that no A/B measurement of a proposal exists; without it the ' +
      'corrected status line reads as if the loop had been demonstrated',
  );

  assert.match(
    denial,
    SAMPLE_OF_ONE,
    'the denial of the A/B measurement does not say how far the loop actually got (n=1); ' +
      'a bare "not measured" hides that one complete traversal does exist',
  );

  assert.ok(
    contents.includes('2026-08-18-n3-round.md'),
    `the caveat cites nothing; ${LEARNING_NOTE} is where the stopped round is recorded`,
  );
});
