/**
 * Gate: the README hands a stranger the two things a licence cannot (t121, AT3).
 *
 * A companion gate holds
 * it that way. Honest is not the same as usable, and the rescope of this ticket
 * named the two gaps precisely:
 *
 * - **A way in that goes past the quickstart.** "How to run it" takes a reader
 *   from a clean checkout to a running control plane, a runner and a screen —
 *   and stops. It never shows how a piece of work gets onto the graph, and it
 *   never says where to look when one stalls. `docs/getting-started.md` is that
 *   walkthrough, and a document nobody is pointed at is a document nobody
 *   reads. **AT3a** asserts the pointer, and asserts it inside "How to run it",
 *   which is where a reader who has just failed to get further is standing.
 * - **An invitation.** Apache-2.0 grants the right to copy this code; it says
 *   nothing about whether copying is WELCOME, and a stranger reading a licence
 *   file learns only that they would not be sued. This repository exists to be
 *   copied from — it is a conceptual example whose product is the patterns, not
 *   the binary — and nothing in the tree said so. **AT3b** asserts a sentence
 *   that does.
 *
 * ## Why AT3b asks for a pattern noun and not just a welcoming verb
 *
 * The failure mode this gate is built against is a sentence that restates the
 * licence in friendlier words: "you are free to use this however you like" is
 * an invitation to use the SOFTWARE, which the licence already covers. What was
 * missing is the invitation to take the DESIGN — the graph, the contracts, the
 * versioning, the gates — which is the part a reader cannot get by running
 * `npm install`. So the assertion is a co-occurrence inside one paragraph: an
 * invitation to copy AND a named pattern. Either one alone passes nothing.
 *
 * The paragraph is the unit for the reason a prose gate
 * records: this repository wraps at eighty columns and a sentence with a
 * subordinate clause routinely spans three lines, so a sentence splitter would
 * have to know about `§`, `US$` and `D14.` to find its own boundaries.
 *
 * ## The two readings
 *
 * AT3a reads the file RAW, because what it looks for IS a link — target and
 * all — and this repository writes a cited path as a code span inside the
 * display text. Blanking spans first would blank half of the thing being
 * searched for.
 *
 * AT3b reads PROSE — fenced blocks and backtick spans blanked, the cut
 * a document sweep establishes. An invitation is a
 * claim made TO a reader, and a claim inside a code fence is data: a shell
 * transcript that happens to contain the word `copy` invites nobody.
 *
 * The reading is restated here rather than imported from the sibling gate, for
 * the reason `scripts/markdown-prose.mjs` gives in its own header: what is
 * shared between these sweeps is the signals, never the decision about which
 * lines to point them at. Importing it from a `*.test.mjs` module would also
 * run that module's tests a second time under this file's name.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { blank } from '../scripts/markdown-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The document this gate reads. */
export const README = 'README.md';

/** The walkthrough it has to point at, and which has to be there to be pointed at. */
export const WALKTHROUGH = 'docs/getting-started.md';

/** The heading of the section the pointer belongs in. */
export const QUICKSTART_HEADING = '## How to run it';

/**
 * Ways of inviting somebody to take the design away with them.
 *
 * Verbs rather than a phrase, because the sentence is Rafael's to write and
 * this ticket corrects a gap rather than dictating a voice — the same posture
 * a gate should take for prose somebody else has to write.
 */
const INVITATION =
  /\b(copy|copied|copying|reuse|reused|reusing|re-use|borrow|borrowed|lift|lifted|steal|stolen|adapt|adapted|adapting|fork|forked)\b/i;

/** The design this repository is worth copying FOR, in the words it uses for it. */
const PATTERN = /\b(pattern|patterns|graph|graphs|contract|contracts|versioning|versioned|gate|gates)\b/i;

/** An opening or closing code fence, and the run of backticks that makes it. */
const FENCE = /^\s*(`{3,})/;

/** A backtick span, of any backtick run length, within one line. */
const SPAN = /(`+)(.+?)\1/g;

/** An inline markdown link, as `[display text](target)`. */
const LINK = /\[(?:[^[\]]|\[[^\]]*\])*\]\(([^()\s]+)\)/g;

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
 * Blanked rather than dropped, so the index of a line in the result is still
 * its number in the file.
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
 * One section of a document: its heading line and everything under it, up to
 * the next heading of the same level or shallower.
 *
 * @param {string} markdown Contents of one document.
 * @param {string} heading The heading line, `##` included.
 * @returns {string|null} The section, or `null` when the heading is not there.
 */
export function sectionOf(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return null;

  const depth = heading.match(/^#+/)[0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const opener = /^(#+)\s/.exec(line);
    return opener !== null && opener[1].length <= depth;
  });

  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** Every link target in one span of markdown, `#anchor` dropped. */
export function linkTargetsIn(markdown) {
  return [...markdown.matchAll(LINK)].map((match) => match[1].split('#')[0]);
}

/**
 * The paragraphs of a document that invite a reader to take the design.
 *
 * @param {string} markdown Contents of one document.
 * @returns {string[]} One entry per qualifying paragraph, in order.
 */
export function invitationsIn(markdown) {
  return proseOf(markdown)
    .join('\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').join(' ').trim())
    .filter((block) => INVITATION.test(block) && PATTERN.test(block));
}

/** The README, whole. */
function readme() {
  return readFileSync(path.join(ROOT, README), 'utf8');
}

test('AT3a — "How to run it" points at the cold-start walkthrough', () => {
  assert.ok(
    existsSync(path.join(ROOT, WALKTHROUGH)),
    `${WALKTHROUGH} is not in the tree; a link to a document that does not exist is worse ` +
      'than no link',
  );

  const section = sectionOf(readme(), QUICKSTART_HEADING);

  assert.notEqual(section, null, `the README no longer has a "${QUICKSTART_HEADING}" section`);

  const targets = linkTargetsIn(section).map((target) => target.replace(/^\.\//, ''));

  assert.ok(
    targets.includes(WALKTHROUGH),
    `"${QUICKSTART_HEADING}" never links ${WALKTHROUGH}; the quickstart stops at a running ` +
      'server, and the reader who wants to put work on the graph has nowhere to go next',
  );
});

test('AT3a — the section read is the section, and it stops at the next heading', () => {
  const document = '# t\n\n## How to run it\n\n[a](docs/getting-started.md)\n\n## Next\n\n[b](x.md)\n';

  assert.deepEqual(
    linkTargetsIn(sectionOf(document, QUICKSTART_HEADING)),
    ['docs/getting-started.md'],
    'a link in the NEXT section would satisfy the pointer without being where a stuck ' +
      'reader is standing',
  );

  assert.equal(sectionOf(document, '## Absent'), null, 'a heading that is not there is not a section');
});

test('AT3b — a sentence invites the reader to copy the patterns, not merely the code', () => {
  const found = invitationsIn(readme());

  assert.notEqual(
    found.length,
    0,
    'no paragraph of the README invites a reader to take the design away with them; ' +
      'Apache-2.0 grants the right to copy and says nothing about it being welcome, and ' +
      'this repository is a conceptual example whose product is the patterns',
  );
});

test('AT3b — the invitation is read as prose, and the licence alone does not satisfy it', () => {
  assert.deepEqual(
    invitationsIn('# x\n\nCopy the graph and its contracts into your own tool.\n'),
    ['Copy the graph and its contracts into your own tool.'],
    'an invitation naming a pattern is exactly what this gate is for',
  );

  assert.deepEqual(
    invitationsIn('# x\n\nApache-2.0 lets you copy, modify and redistribute this software.\n'),
    [],
    'restating the licence in friendlier words invites nobody to take the DESIGN, which ' +
      'is the half a reader cannot get by running npm install',
  );

  assert.deepEqual(
    invitationsIn('# x\n\nThe graph is frozen during execution and versioned between rounds.\n'),
    [],
    'describing the patterns is not inviting anybody to copy them',
  );

  assert.deepEqual(
    invitationsIn('# x\n\n```\ncp -r graph/ contracts/ ~/mine\n```\n'),
    [],
    'a shell transcript inside a fence invites nobody; the same cut the D24 sweeps take',
  );

  assert.deepEqual(
    invitationsIn('# x\n\nIt used to say `copy the graph` here.\n'),
    [],
    'a phrase quoted as data is a historical record, not a claim made to a reader',
  );
});
