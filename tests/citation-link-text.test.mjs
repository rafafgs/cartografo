/**
 * Gate: a citation's display text names the file its link actually points at
 * (t302, from the alpha-test round on t300's FR7).
 *
 * The D24 rename moved fourteen specifications and thirteen notes, and FR7
 * repointed every citation of them. Repointing a citation is two edits, not
 * one: the target inside `(...)` and the name a human reads inside `[...]`.
 * Thirteen sites got both; one got only the first. `docs/spec/surveyor-flow.md`
 * ended up carrying `` [`extensao-e-qualidade.md`](../../notas/2026-08-14-extension-and-quality.md) ``
 * — an href pointing at the real file under a display text spelling a file that
 * no longer exists anywhere in the tree.
 *
 * That asymmetry is why this gate exists at all. A broken href announces itself:
 * the first person to click it gets nothing, and half a dozen tools will flag it
 * on the way. A stale display text is invisible to every one of those tools and
 * to the click — the link works — and it lies only to the reader who does what
 * this repository's prose constantly asks and reads the name instead of
 * following the link. That reader goes looking for `extensao-e-qualidade.md`,
 * finds nothing, and concludes the note was deleted.
 *
 * ## The rule
 *
 * For every inline link in a tracked `.md` file whose display text contains a
 * token ending in `.md`, that token and the link target must name the SAME
 * file — compared by basename, with any `#anchor` dropped first.
 *
 * Basename rather than the whole path, because the two halves of a citation are
 * written for different readers and are allowed to disagree about depth. Both of
 * these are correct and both pass:
 *
 * - `` [`§3 of entities-versioning.md`](entities-versioning.md) `` — a sibling
 *   cited by name alone.
 * - `` [`notas/2026-08-14-extension-and-quality.md`](../../notas/2026-08-14-extension-and-quality.md) ``
 *   — the same file cited from two directories down, where the display text
 *   carries the directory a reader needs and the target carries the `../..` a
 *   filesystem needs.
 *
 * Only links whose text NAMES a file are read. `[the flow surveyor](surveyor-flow.md)`
 * makes no claim about a filename and this gate has nothing to say about it.
 *
 * ## What this gate does not claim
 *
 * That the target resolves. It compares the two halves of a citation with each
 * other, not either half with the filesystem, and a citation where both halves
 * spell the same dead name passes here — that is the dimension
 * `tests/decisions-rename-integrity.test.mjs` and
 * `tests/no-portuguese-document-tree.test.mjs` already sweep.
 *
 * The boundary is deliberate, not an oversight. A target-existence sweep over
 * this tree goes red today on
 * `packages/core/test/fixtures/external-skills/feature-dev/SKILL.md`, whose
 * `../../../DECISIONS.md` is relative to the repository that skill was imported
 * FROM: it is fixture data pinned by hash (D4), it is not a citation anybody
 * follows from here, and it must not be edited to satisfy a gate about our own
 * documents. Adding that claim here would mean carving an exemption for the one
 * file the claim was never about.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * An inline markdown link, as `[display text](target)`.
 *
 * The display text may run over a line break — this repository wraps its prose
 * at eighty columns and a citation is often the thing that does not fit — so the
 * whole file is matched at once rather than line by line, and line numbers are
 * recovered from the match offset. The target may not contain whitespace or
 * parentheses, which is what keeps `(see [x](y))` from swallowing the closer.
 */
const LINK = /\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^()\s]+)\)/g;

/** A token that names a markdown file, wherever it sits inside display text. */
const MARKDOWN_NAME = /[A-Za-z0-9._/-]+\.md/g;

/** The note whose citation the alpha-test round found stale. */
export const RENAMED_NOTE = 'notas/2026-08-14-extension-and-quality.md';

/** The document that carried the stale display text. */
export const REPAIRED_DOCUMENT = 'docs/spec/surveyor-flow.md';

/** The name the note used to have, which no display text may spell again. */
export const RETIRED_NOTE_NAME = 'extensao-e-qualidade.md';

/** Every tracked markdown file, as repo-relative paths. */
export function trackedMarkdown() {
  return execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((entry) => entry !== '')
    .filter((entry) => !entry.includes('node_modules/'));
}

/**
 * Every citation in one file: a link whose display text names a markdown file.
 *
 * Backticks are stripped from the display text before the name is read, because
 * the house style writes a cited filename as a code span and the backticks are
 * typography, not part of the name.
 *
 * @param {string} relativePath Repo-relative path of the file to read.
 * @returns {Array<{file: string, line: number, named: string, target: string}>}
 *   One entry per named file per link; a text naming two files yields two.
 */
export function citationsIn(relativePath) {
  const contents = readFileSync(path.join(ROOT, relativePath), 'utf8');
  const found = [];

  for (const match of contents.matchAll(LINK)) {
    const displayText = match[1].replaceAll('`', '');
    const named = displayText.match(MARKDOWN_NAME);
    if (named === null) continue;

    const line = contents.slice(0, match.index).split('\n').length;
    for (const name of named) {
      found.push({ file: relativePath, line, named: name, target: match[2] });
    }
  }

  return found;
}

/** The file a link target names, with any anchor dropped. `a/b.md#c` → `b.md`. */
export function targetBasename(target) {
  return path.basename(target.split('#')[0]);
}

test('every citation displays the name of the file it links to', () => {
  const files = trackedMarkdown();
  assert.ok(
    files.length >= 30,
    `only ${String(files.length)} markdown files listed; the sweep is not reading the tree`,
  );

  const citations = files.flatMap((relativePath) => citationsIn(relativePath));
  assert.ok(
    citations.length >= 50,
    `only ${String(citations.length)} citations found; the link pattern is not matching`,
  );

  const stale = citations
    .filter((citation) => path.basename(citation.named) !== targetBasename(citation.target))
    .map(
      (citation) =>
        `${citation.file}:${String(citation.line)}: reads "${citation.named}", links to "${citation.target}"`,
    );

  assert.deepEqual(
    stale,
    [],
    'a citation shows a reader one filename and points at another:\n' + stale.join('\n'),
  );
});

test('the flow surveyor cites the extension-and-quality note by its real name', () => {
  const wanted = path.basename(RENAMED_NOTE);
  const citations = citationsIn(REPAIRED_DOCUMENT).filter(
    (citation) => targetBasename(citation.target) === wanted,
  );

  assert.ok(
    citations.length >= 2,
    `${REPAIRED_DOCUMENT} cites ${wanted} ${String(citations.length)} time(s); the round found two sites`,
  );

  for (const citation of citations) {
    assert.equal(
      path.basename(citation.named),
      wanted,
      `${REPAIRED_DOCUMENT}:${String(citation.line)} still reads "${citation.named}"`,
    );
  }
});

test('no tracked document spells the note by the name the rename retired', () => {
  const offenders = trackedMarkdown().flatMap((relativePath) =>
    readFileSync(path.join(ROOT, relativePath), 'utf8')
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => entry.line.includes(RETIRED_NOTE_NAME))
      .map((entry) => `${relativePath}:${String(entry.number)}: ${entry.line.trim().slice(0, 120)}`),
  );

  assert.deepEqual(
    offenders,
    [],
    `${RETIRED_NOTE_NAME} has not existed since t300 renamed it:\n` + offenders.join('\n'),
  );
});
