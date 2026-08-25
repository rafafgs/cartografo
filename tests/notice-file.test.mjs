/**
 * Gate: the repository carries the `NOTICE` file its licence presupposes
 * (t121, AT1).
 *
 * `LICENSE` is the canonical Apache-2.0 text with its appendix copyright line
 * filled in (t297). That appendix is not decoration: section 4(d) of the terms
 * makes `NOTICE` a load-bearing artefact — a redistributor has to carry forward
 * whatever attribution notices the work ships with, and the file named `NOTICE`
 * at the root is where the licence expects to find them. A repository that
 * declares Apache-2.0 and ships no `NOTICE` leaves the next person to guess
 * whether there is nothing to pass on or whether somebody forgot.
 *
 * ## Why the file says so little
 *
 * There is no third-party notice to pass on. This tree vendors nothing, forks
 * nothing and carries no inherited attribution; its dependencies arrive through
 * `package-lock.json` and keep their own notices in their own packages. So the
 * whole content is the two facts a reader needs — WHOSE work this is, under
 * WHICH name — and the discipline t297 recorded for the README's status line
 * applies here with more force than anywhere else: a `NOTICE` is quoted
 * verbatim by everyone who redistributes, so a claim invented here propagates.
 *
 * ## Why the copyright line is read off `LICENSE` and not written down here
 *
 * The claim is that the two files say the SAME thing, and a fixture repeating
 * the string would go green on the day somebody corrected one of them. So AT1
 * extracts the appendix copyright line from `LICENSE` at test time and asks
 * `NOTICE` for exactly it: the assertion is about agreement between two files
 * in the tree, which is the only property worth pinning. `tests/license-file.test.mjs`
 * is what holds `LICENSE`'s own line against Apache's canonical text.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The file this ticket adds, at the root where the licence points a reader. */
export const NOTICE_PATH = path.join(ROOT, 'NOTICE');

/** The licence whose appendix presupposes it, and whose line NOTICE repeats. */
export const LICENSE_PATH = path.join(ROOT, 'LICENSE');

/** The project's own name, D24's first permanent exception. */
export const PROJECT_NAME = 'cartografo';

/**
 * A line opening the appendix's copyright notice, indentation aside.
 *
 * The same anchored expression `tests/license-file.test.mjs` reads `LICENSE`
 * with, restated rather than imported: importing a test module runs its tests a
 * second time under this file's name.
 */
const COPYRIGHT = /^\s*Copyright /;

/** The copyright line `LICENSE` carries, trimmed, or `null` when it has none. */
export function copyrightLineOfLicense() {
  const found = readFileSync(LICENSE_PATH, 'utf8')
    .split('\n')
    .find((line) => COPYRIGHT.test(line));

  return found === undefined ? null : found.trim();
}

/** The file, or `null` when it is not there — so AT1 reports the absence itself. */
function readOrNull(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

test('AT1 — NOTICE exists at the repository root and is not empty', () => {
  const notice = readOrNull(NOTICE_PATH);

  assert.notEqual(
    notice,
    null,
    'LICENSE is the canonical Apache-2.0 text and its appendix presupposes a NOTICE file; ' +
      'there is none, so a redistributor cannot tell whether there is nothing to carry ' +
      'forward or whether somebody forgot',
  );

  assert.notEqual(notice.trim(), '', 'NOTICE is there and says nothing, which is worse than absent');
});

test('AT1 — NOTICE names the project', () => {
  const notice = readOrNull(NOTICE_PATH);
  assert.notEqual(notice, null, 'NOTICE is missing; there is nothing to read (AT1)');

  assert.ok(
    notice.includes(PROJECT_NAME),
    `NOTICE never says "${PROJECT_NAME}"; a notice quoted downstream has to name what it ` +
      'is a notice about',
  );
});

test('AT1 — NOTICE carries exactly the copyright line LICENSE carries', () => {
  const notice = readOrNull(NOTICE_PATH);
  assert.notEqual(notice, null, 'NOTICE is missing; there is nothing to read (AT1)');

  const licenseLine = copyrightLineOfLicense();

  assert.notEqual(
    licenseLine,
    null,
    'LICENSE has no line opening with "Copyright "; there is nothing for NOTICE to agree with',
  );

  const lines = notice.split('\n').map((line) => line.trim());
  const noticeLines = lines.filter((line) => COPYRIGHT.test(line));

  assert.deepEqual(
    noticeLines,
    [licenseLine],
    `NOTICE must carry exactly one copyright line and it must be "${licenseLine}", the line ` +
      'LICENSE fills its appendix in with; two files stating the attribution differently is ' +
      'the repository saying two things at once',
  );
});

test('AT1 — NOTICE ends with exactly one trailing newline', () => {
  const notice = readOrNull(NOTICE_PATH);
  assert.notEqual(notice, null, 'NOTICE is missing; there is nothing to read (AT1)');

  const lines = notice.split('\n');

  assert.equal(lines.at(-1), '', 'NOTICE must end with a newline, like every other text file here');
  assert.notEqual(
    lines.at(-2),
    '',
    'NOTICE ends with a blank line; one trailing newline, not two',
  );
});
