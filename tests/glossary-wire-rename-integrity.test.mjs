/**
 * D24 gate: the wire glossary is `glossary-wire.md`, and nothing still points at
 * the name it had (t326).
 *
 * This document was the last surface of D24's series carrying a Portuguese path.
 * It fell between two tickets and stayed there: t281 translated its CONTENTS and
 * owned the file, so t299 — which renamed every other Portuguese filename under
 * `docs/spec/` — skipped it on purpose and wrote the skip down in three separate
 * gates. The result was a document that was English inside and Portuguese
 * outside for two days. t326 closes it.
 *
 * A rename with a hundred and fifty citations behind it fails in two ways, and
 * only one of them is loud:
 *
 * - **Loud.** Two of the citations are parsers. `glossary-wire.test.ts` and
 *   `glossary-wire-docs.test.ts` open the document at run time and assert
 *   structure over its tables, and five more gates resolve it through path
 *   constants. Every one of those breaks on the spot if a path is left stale.
 * - **Silent.** The other ~140 are prose: a docblock, a table cell, a sentence
 *   in a closing note. A stale one costs nothing at build time and everything to
 *   the reader who clicks it, which is exactly the failure `decisions-rename-integrity.test.mjs`
 *   was written for one rename earlier. This file is modelled on it.
 *
 * So four claims are held here:
 *
 * - **AT1 — the three files moved.** The document and its two parser suites, old
 *   names gone and new names present. Named one by one rather than swept,
 *   because a rename that half-landed leaves both halves on disk and only a
 *   named pair notices.
 * - **AT2 — no tracked file still spells the retired stem.** Case-insensitive,
 *   and the bare stem rather than the whole filename: `glossario` has never been
 *   a path segment in this tree except as part of these three names, so hunting
 *   the stem costs nothing and catches the spelling creeping back in a form the
 *   filename alone would miss.
 * - **AT3 — the rename carried no content edit.** The line count is pinned to
 *   what it was before the `git mv`. t326 renames and re-points; it translates
 *   nothing, and it is the only reason every line citation into this document
 *   survived the ticket without being re-read.
 * - **AT4 — the two cited lines still say what their citations claim.** Six
 *   citations across three packages name a line of this document by number.
 *   Asserting the numbers still resolve is what turns AC2 from a read somebody
 *   did once into a claim that stays true.
 *
 * ## The two places the retired stem is allowed to survive
 *
 * Both are gates that cannot retire a name without spelling it, which is the
 * same reason twice:
 *
 * - **This file.** AT2 cannot hunt a substring its own assertion has to write.
 *   `decisions-rename-integrity.test.mjs` skips itself for that reason and says
 *   so out loud; this one does the same.
 * - **`tests/no-portuguese-path-segments.test.mjs`.** D24's path-segment sweep
 *   carries one stem per Portuguese word ever retired from a path here, and
 *   t326 adds `glossario` as the twelfth. A list of retired words is written in
 *   retired words, permanently — the same shape as the carve-outs the two prose
 *   sweeps give the glossary itself.
 *
 * An exclusion that covers nothing is a hole nobody is watching, so the second
 * one is not merely skipped: AT2 asserts that the stem gate really does carry
 * the stem. The day somebody drops it from `RETIRED_STEMS`, this reds instead of
 * quietly widening its own blind spot.
 *
 * The closing note of this ticket is read like every other tracked file, which
 * is why it names the retired document without its stem — the same discipline
 * t299's note recorded for the ledger.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RETIRED_STEMS } from './no-portuguese-path-segments.test.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The Portuguese stem this rename retires, and the substring AT2 hunts. */
export const RETIRED_STEM = 'glossario';

/** The three files t326 renames: what each was, and what each is now. */
export const RENAMES = Object.freeze(
  [
    { from: 'docs/spec/glossario-wire.md', to: 'docs/spec/glossary-wire.md' },
    {
      from: 'packages/core/test/glossario-wire.test.ts',
      to: 'packages/core/test/glossary-wire.test.ts',
    },
    {
      from: 'packages/core/test/glossario-wire-docs.test.ts',
      to: 'packages/core/test/glossary-wire-docs.test.ts',
    },
  ].map((entry) => Object.freeze(entry)),
);

/** The document itself, repo-relative, after the rename. */
export const GLOSSARY = 'docs/spec/glossary-wire.md';

/**
 * The document's length, read off the file before the `git mv`.
 *
 * The fixture is the whole of AT3. A pure rename cannot change it, and any edit
 * to the contents almost certainly does — which is what makes this the cheapest
 * possible proof that t326 kept its own Out of Scope.
 */
export const GLOSSARY_LINES = 838;

/**
 * The lines other files cite by number, and what each citation claims is there.
 *
 * Two numbers, six sites. `:796` is the live one — `packages/runner/test/no-portuguese-wire.test.ts`
 * twice and `packages/runner/scripts/close-surveyor-outcome.mjs` once, all three
 * naming the frozen hypothesis format. `:791` is a historical one: three sites in
 * `notes/2026-08-24-t281-closing-note.md` recording what was true while t281 ran,
 * before the translation grew the document and pushed the same sentence down five
 * lines. Both are asserted, because both are numbers a reader is told to trust —
 * and neither is "repaired" into the other, since the note's own text is what
 * dates its claim.
 */
export const ANCHORS = Object.freeze(
  [
    { line: 791, claims: ['`total_ms`', '`lens` are already English'] },
    { line: 796, claims: ['`metrica_esperada`', '`{nome, direcao, de, para}`'] },
  ].map((anchor) => Object.freeze({ ...anchor, claims: Object.freeze(anchor.claims) })),
);

/** This file, repo-relative: the first place the retired stem may be written. */
const SELF = path.join('tests', 'glossary-wire-rename-integrity.test.mjs');

/** D24's path-stem sweep: the second, and the reason is in the header. */
const STEM_GATE = path.join('tests', 'no-portuguese-path-segments.test.mjs');

/** Every file git tracks, as repo-relative paths, the two exclusions dropped. */
export function trackedFiles() {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });

  return listed
    .split('\0')
    .filter((entry) => entry !== '')
    .filter((entry) => entry !== SELF && entry !== STEM_GATE)
    .filter((entry) => !entry.includes('node_modules/'));
}

test('AT1 — the document and its two parsers carry English names', () => {
  for (const { from, to } of RENAMES) {
    assert.equal(
      existsSync(path.join(ROOT, from)),
      false,
      `${from} is still on disk; FR1/FR2 rename it to ${to}`,
    );
    assert.ok(existsSync(path.join(ROOT, to)), `${to} does not exist`);
  }
});

test('AT2 — no tracked file still spells the retired stem', () => {
  const tracked = trackedFiles();

  assert.ok(
    tracked.length >= 100,
    `only ${String(tracked.length)} files listed; the sweep is not reading the tree`,
  );

  const offenders = tracked.flatMap((relativePath) => {
    const absolute = path.join(ROOT, relativePath);
    if (!existsSync(absolute)) return [];

    return readFileSync(absolute, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.toLowerCase().includes(RETIRED_STEM))
      .map(
        (entry) => `${relativePath}:${String(entry.index + 1)}: ${entry.line.trim().slice(0, 120)}`,
      );
  });

  assert.deepEqual(
    offenders,
    [],
    `a citation still points at a file that does not exist:\n${offenders.join('\n')}`,
  );
});

test('AT2 — the stem gate really does carry the stem it is excused for', () => {
  assert.ok(
    RETIRED_STEMS.includes(RETIRED_STEM),
    `${STEM_GATE} no longer retires "${RETIRED_STEM}"; the exclusion above is covering nothing`,
  );
});

test('AT3 — the rename carried no edit to the document', () => {
  const absolute = path.join(ROOT, GLOSSARY);
  assert.ok(existsSync(absolute), `${GLOSSARY} does not exist`);

  assert.equal(
    readFileSync(absolute, 'utf8').split('\n').length - 1,
    GLOSSARY_LINES,
    `${GLOSSARY} is not the length it was before the rename; t326 renames and re-points, ` +
      'and every line citation into this document depends on its contents not moving',
  );
});

test('AT4 — the lines other files cite by number still say what they claim', () => {
  const absolute = path.join(ROOT, GLOSSARY);
  assert.ok(existsSync(absolute), `${GLOSSARY} does not exist`);

  const lines = readFileSync(absolute, 'utf8').split('\n');

  for (const { line, claims } of ANCHORS) {
    const read = lines[line - 1];
    assert.ok(read !== undefined, `${GLOSSARY} has no line ${String(line)}`);

    for (const claim of claims) {
      assert.ok(
        read.includes(claim),
        `${GLOSSARY}:${String(line)} no longer contains ${claim}; a citation names it and ` +
          `the line reads: ${read.trim().slice(0, 120)}`,
      );
    }
  }
});
