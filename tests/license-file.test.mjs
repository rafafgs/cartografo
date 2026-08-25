/**
 * Gate: the repository carries the licence it declares (t297, AC1).
 *
 * `package.json` has said `"license": "Apache-2.0"` since the manifest existed,
 * and D12 recorded that choice on 2026-08-14. The text itself was never added.
 * A declaration with no file behind it is the weakest possible form of a
 * licence: a stranger who wants to know what they may do with this code finds a
 * four-word claim in a build manifest and no terms anywhere.
 *
 * ## Why a checked-in fixture rather than the network
 *
 * The claim this gate makes is that `LICENSE` is the CANONICAL Apache-2.0 text
 * and not a retyped, reflowed or half-remembered version of it. Checking that
 * against `https://www.apache.org/licenses/LICENSE-2.0.txt` at test time would
 * make the whole suite depend on the network — red in CI behind a proxy, red on
 * a plane, and red for good on the day that URL moves. So the canonical text is
 * checked in once, verbatim, as `tests/fixtures/apache-2.0-license.txt`, and
 * this gate diffs against the fixture.
 *
 * The fixture then needs its own guard, or the whole thing is circular: an
 * editor who breaks `LICENSE` and re-copies it over the fixture turns the diff
 * green again. So AT2 also pins the fixture by digest, against the SHA-256 of
 * the published file as fetched on 2026-08-25. That digest is what ties this
 * tree to Apache's text; everything else here is a comparison between two local
 * files.
 *
 * ## Where `LICENSE` ends, and why
 *
 * The canonical file runs 202 lines: the terms (sections 1-9), the line
 * `END OF TERMS AND CONDITIONS`, and then an APPENDIX that is not part of the
 * terms at all — it is the instruction for applying the licence to a SOURCE
 * FILE, ending in a boilerplate notice with `[yyyy]` and
 * `[name of copyright owner]` to fill in.
 *
 * This repository's `LICENSE` stops at that appendix's copyright line, filled
 * in (FR1, AT3). What it carries is every word that is binding — the terms end
 * at `END OF TERMS AND CONDITIONS` — plus the appendix's own explanation and
 * the attribution of who holds the copyright. What it drops is the per-file
 * header boilerplate, which belongs at the top of a source file and not in the
 * licence of a repository. The ticket pins that shape in two halves that
 * together cover the file with no gap: everything BEFORE the copyright line is
 * the canonical text byte for byte (AT2), and the copyright line is the LAST
 * line (AT3).
 *
 * The line keeps the appendix's three-space indentation, because FR1 changes
 * the line's CONTENT and nothing else; `trim()` is what reads it here.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The licence file this ticket adds, at the root where a reader looks first. */
export const LICENSE_PATH = path.join(ROOT, 'LICENSE');

/** The unedited canonical text, checked in so the gate needs no network. */
export const FIXTURE_PATH = path.join(ROOT, 'tests', 'fixtures', 'apache-2.0-license.txt');

/**
 * SHA-256 of `https://www.apache.org/licenses/LICENSE-2.0.txt`, fetched
 * 2026-08-25. The one assertion in this file that is about Apache's text rather
 * than about this repository's copy of it.
 */
export const CANONICAL_DIGEST = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

/** The appendix line this repository fills in, and the only line it changes. */
export const COPYRIGHT_LINE = 'Copyright 2026 Rafael Gomes';

/**
 * A line that opens the appendix's copyright notice, indentation aside.
 *
 * It matches exactly one line of the canonical text (line 190). Section 2's
 * heading also spells the word — `2. Grant of Copyright License` — but not at
 * the start of the line, which is what keeps this anchored expression honest.
 */
const COPYRIGHT = /^\s*Copyright /;

/** The placeholders the canonical appendix carries, which a filled-in one has not. */
const PLACEHOLDERS = Object.freeze(['[yyyy]', '[name of copyright owner]']);

/**
 * One text split at its appendix copyright line.
 *
 * @param {string} contents The whole file.
 * @returns {{before: string[], at: number, line: string|null}} Lines before the
 *   copyright line, its zero-based index (-1 if absent) and the line itself.
 */
export function splitAtCopyright(contents) {
  const lines = contents.split('\n');
  const at = lines.findIndex((line) => COPYRIGHT.test(line));

  return {
    before: at === -1 ? lines : lines.slice(0, at),
    at,
    line: at === -1 ? null : lines[at],
  };
}

/** The file, or `null` when it is not there — so AT1 reports the absence itself. */
function readOrNull(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

test('AT1 — LICENSE exists at the repository root', () => {
  assert.ok(
    existsSync(LICENSE_PATH),
    'package.json declares "license": "Apache-2.0" (D12) and there is no LICENSE file ' +
      'to back it; the declaration is the only thing a stranger can read',
  );
});

test('AT2 — everything before the copyright line is the canonical text, byte for byte', () => {
  const fixture = readFileSync(FIXTURE_PATH, 'utf8');

  assert.equal(
    createHash('sha256').update(fixture).digest('hex'),
    CANONICAL_DIGEST,
    'tests/fixtures/apache-2.0-license.txt is not the published Apache-2.0 text any more; ' +
      'it is the anchor of this gate and it is never edited to make a diff green',
  );

  const license = readOrNull(LICENSE_PATH);
  assert.notEqual(license, null, 'LICENSE is missing; there is nothing to compare (AT1)');

  const mine = splitAtCopyright(license);
  const canonical = splitAtCopyright(fixture);

  assert.ok(canonical.at > 0, 'the fixture has no appendix copyright line; it is not the text');
  assert.notEqual(
    mine.at,
    -1,
    'LICENSE has no line opening with "Copyright "; the appendix boilerplate is not there',
  );

  assert.equal(
    mine.before.join('\n'),
    canonical.before.join('\n'),
    'LICENSE diverges from the canonical Apache-2.0 text before the copyright line; ' +
      'sections 1-9 are unmodified or they are not the licence',
  );
});

test('AT3 — LICENSE ends at the filled-in copyright line, with nothing after it', () => {
  const license = readOrNull(LICENSE_PATH);
  assert.notEqual(license, null, 'LICENSE is missing; there is nothing to read (AT1)');

  const lines = license.split('\n');

  assert.equal(lines.at(-1), '', 'LICENSE must end with exactly one trailing newline');
  assert.equal(
    lines.at(-2)?.trim(),
    COPYRIGHT_LINE,
    `the last line of LICENSE must be "${COPYRIGHT_LINE}"; the per-file header boilerplate ` +
      'that follows it in the canonical appendix belongs in a source file, not here',
  );

  const copyrights = lines.filter((line) => COPYRIGHT.test(line)).map((line) => line.trim());

  assert.deepEqual(
    copyrights,
    [COPYRIGHT_LINE],
    'exactly one copyright line, and it is the filled-in one',
  );

  for (const placeholder of PLACEHOLDERS) {
    assert.ok(
      !license.includes(placeholder),
      `LICENSE still carries the canonical placeholder ${placeholder}; the appendix line is ` +
        'filled in, not copied',
    );
  }
});

test('AT4 — package.json declares exactly the licence the file carries', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(
    manifest.license,
    'Apache-2.0',
    'the manifest and the LICENSE file are one claim in two places (D12); they agree or ' +
      'the repository says two things at once',
  );
});
