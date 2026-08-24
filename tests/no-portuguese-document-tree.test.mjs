/**
 * D24 gate: the whole document tree is English, names included (t300).
 *
 * The third and last sweep of D24's document series. Its two siblings each took
 * a slice of the tree and gated the slice they took: t281 the wire glossary's
 * prose (`packages/core/test/no-portuguese-glossary-prose.test.ts`), t299 the
 * documents a stranger reads before the code
 * (`tests/no-portuguese-reader-documents.test.mjs`). What neither reached is the
 * internal record — `especificacoes/`, `notas/`, `schema/` — and what none of
 * the three reached at all is the one thing a reader sees before opening
 * anything: the FILE NAMES.
 *
 * So this gate walks the tracked tree once and asks two questions of it.
 *
 * ## The names
 *
 * A sweep that reads only contents is blind to `notas/2026-08-14-mercado.md`.
 * The name is prose too — it is what a directory listing says, what a citation
 * spells and what a link resolves — and until now nothing in this repository
 * checked one. Every path component under the swept trees goes through the same
 * two signals the contents do.
 *
 * ## The contents
 *
 * Two readings, chosen by extension, because the two file shapes hide
 * Portuguese in opposite places:
 *
 * - **`.md`** — fenced blocks and backtick spans are blanked before the scan,
 *   the cut t299 established. Those are where frozen wire vocabulary lives
 *   (`nos`, `arestas`, `condicao`, `pendente`): data quoted inside a sentence,
 *   not words of it. Blanked rather than dropped, so a line keeps its number.
 * - **`.json` / `.jsonl`** — read raw, the cut `no-portuguese-factory-bundles`
 *   established. JSON has no fence to hide behind, and its frozen snake_case
 *   keys carry neither a diacritic nor a stopword, so a raw read costs nothing
 *   and misses nothing.
 *
 * `.mjs` files under these trees are read by neither: identifier positions in
 * source are `tests/no-portuguese-identifiers.test.mjs`'s dimension, and a gate
 * that scanned a reducer's string literals as prose would be answering a
 * question that already has an owner.
 *
 * ## What overlaps, and why it is kept
 *
 * `docs/` and the two root documents are already content-swept by t299's gate.
 * Reading them again here is duplicated work that will always be green, and it
 * is kept: one uniform walk over the whole tree is easier to trust than a walk
 * with a hole in it whose shape depends on which sibling ticket landed first.
 * What is NOT duplicated is those same files' path segments, which no other
 * sweep reads.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC, GLOSS, STOPWORD, blank } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The directories walked whole, each as a repo-relative prefix. */
export const TREES = Object.freeze(['docs/', 'especificacoes/', 'notas/', 'schema/']);

/** The two documents at the root that belong to the tree without living in it. */
export const ROOT_DOCUMENTS = Object.freeze(['README.md', 'DECISIONS.md']);

/**
 * The one document whose CONTENTS this gate never reads.
 *
 * t281 owns `docs/spec/glossario-wire.md` and gave it a gate of its own
 * (`packages/core/test/no-portuguese-glossary-prose.test.ts`), which sweeps its
 * prose and spares its table rows — because the rows are the data: a map of
 * retired Portuguese names is written in retired Portuguese names forever.
 * t299's sweep carves it out for the same reason. Its path segments are still
 * read here; only its lines are spared.
 */
export const CONTENT_NOT_SWEPT = 'docs/spec/glossario-wire.md';

/**
 * The path segments that stay Portuguese, each with its reason and its owner.
 *
 * D24 moves file names; it does not move directory names. Renaming a directory
 * moves every path that ends in it at once — every citation, every `path.join`,
 * every relative link — and that fan-out is a ticket of its own, t282's, which
 * is the one that empties this list.
 *
 * Declared as SEGMENTS rather than paths: one entry for `especificacoes` covers
 * everything under it, which is what keeps the list five lines long instead of
 * eighty-seven.
 *
 * **What this list is, honestly.** None of these five trips the two signals
 * today — `especificacoes` carries no cedilla, `exemplos` is not a stopword — so
 * removing an entry would not turn the gate red on its own. Its teeth are the
 * assertion below that every entry still names a segment the tree really has:
 * the day t282 renames one, the entry goes stale, the gate reds, and the reason
 * text gets read by whoever is standing there. A carve-out that outlives its
 * subject is how a carve-out becomes permanent.
 */
export const ALLOWED_SEGMENTS = Object.freeze([
  Object.freeze({
    segment: 'especificacoes',
    reason: 'The format and event specifications; renaming the directory moves every citation of it — t282',
  }),
  Object.freeze({
    segment: 'notas',
    reason: 'The working notes; the four English closing notes already live under this name — t282',
  }),
  Object.freeze({
    segment: 'eventos',
    reason: 'The event taxonomy, its schemas and its reducer, under especificacoes/ — t282',
  }),
  Object.freeze({
    segment: 'formatos',
    reason: 'Two directories share this name, under docs/ and under especificacoes/ — t282',
  }),
  Object.freeze({
    segment: 'exemplos',
    reason: 'Three fixture directories share this name, under schema/ and twice under especificacoes/ — t282',
  }),
]);

/** The ticket every carve-out here names as the one that removes it. */
const OWNER_TICKET = 't282';

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
 * A document reduced to its prose: no code span, no fenced block, no gloss.
 *
 * The strategy t299's gate established, kept local on purpose: the shared module
 * holds the two signals, not the decision about which lines to point them at
 * (see `scripts/no-portuguese-prose.mjs`).
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

/**
 * The lines of one file as this gate wants to read them, or `null` to skip it.
 *
 * @param {string} relativePath Repo-relative path, which chooses the reading.
 * @param {string} contents The file, whole.
 * @returns {string[]|null} Lines to scan, or `null` for a file with no reading.
 */
export function linesToScan(relativePath, contents) {
  if (relativePath === CONTENT_NOT_SWEPT) return null;

  const extension = path.extname(relativePath);
  if (extension === '.md') return proseOf(contents);
  if (extension === '.json' || extension === '.jsonl') {
    return contents.split('\n').map((line) => line.replace(GLOSS, ''));
  }

  return null;
}

/** The first of the two signals a line trips, as a phrase, or `null`. */
function signalIn(text) {
  const diacritic = DIACRITIC.exec(text);
  if (diacritic !== null) return `diacritic "${diacritic[0]}"`;

  const stopword = STOPWORD.exec(text);
  if (stopword !== null) return `stopword "${stopword[0]}"`;

  return null;
}

/** Every allowlisted segment, as a set, for the membership test below. */
function allowedSegments() {
  return new Set(ALLOWED_SEGMENTS.map((entry) => entry.segment));
}

/**
 * Every offending component of one path, with what tripped it.
 *
 * Pure: it reads the string, never the disk, which is what lets a regression
 * fixture hand it a path that does not exist (AT4).
 *
 * @param {string} relativePath Repo-relative path to read as a name.
 * @returns {string[]} One entry per offending component.
 */
export function segmentOffendersIn(relativePath) {
  const allowed = allowedSegments();

  return relativePath
    .split('/')
    .filter((segment) => !allowed.has(segment))
    .map((segment) => {
      const why = signalIn(segment);
      return why === null ? null : `${relativePath}: path segment "${segment}": ${why}`;
    })
    .filter((entry) => entry !== null);
}

/**
 * Every offending line of one file, with its number and what tripped it.
 *
 * Pure, for the same reason as above. Reported whole rather than stopping at the
 * first: a half-translated document has dozens, and a gate that named one per
 * run would take dozens of runs to finish.
 *
 * @param {string} relativePath Repo-relative path, which chooses the reading.
 * @param {string} contents The file, whole.
 * @returns {string[]} One entry per offending line.
 */
export function contentOffendersIn(relativePath, contents) {
  const lines = linesToScan(relativePath, contents);
  if (lines === null) return [];

  const found = [];

  lines.forEach((line, index) => {
    const why = signalIn(line);
    if (why === null) return;

    found.push(`${relativePath}:${String(index + 1)}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

/**
 * Every tracked file this gate walks, as repo-relative paths.
 *
 * Read off `git ls-files` rather than off the filesystem, and the difference
 * matters here: a translation ticket leaves renamed files behind in a dirty
 * checkout, and a build artefact or an editor backup under `notas/` is not part
 * of the tree this gate is making a claim about. The same reading
 * `tests/decisions-rename-integrity.test.mjs` uses.
 *
 * @returns {string[]} Tracked paths under the swept trees, plus the root pair.
 */
export function documentsInScope() {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });

  return listed
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) => TREES.some((tree) => entry.startsWith(tree)) || ROOT_DOCUMENTS.includes(entry),
    )
    .sort();
}

test('AT1 — no Portuguese survives in any path segment of the document tree', () => {
  const documents = documentsInScope();

  assert.ok(
    documents.length >= 80,
    `only ${String(documents.length)} tracked files walked; the sweep is blind`,
  );

  const offenders = documents.flatMap(segmentOffendersIn);

  assert.deepEqual(
    offenders,
    [],
    `a file or directory of the document tree is still named in Portuguese:\n${offenders.join('\n')}`,
  );
});

test('AT2 — no Portuguese survives in the contents of the document tree', () => {
  const documents = documentsInScope();

  const offenders = documents.flatMap((relativePath) =>
    contentOffendersIn(relativePath, readFileSync(path.join(ROOT, relativePath), 'utf8')),
  );

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives inside the document tree:\n${offenders.join('\n')}`,
  );
});

test('AT2 — the walk really reaches all four trees and both root documents', () => {
  const documents = documentsInScope();

  for (const tree of TREES) {
    assert.ok(
      documents.some((entry) => entry.startsWith(tree)),
      `nothing under ${tree} is walked; the tree read is not resolving`,
    );
  }

  for (const required of ROOT_DOCUMENTS) {
    assert.ok(documents.includes(required), `${required} is not in the walked set`);
  }

  const read = documents.filter(
    (entry) => linesToScan(entry, '') !== null && entry.endsWith('.md'),
  );

  assert.ok(
    read.length >= 35,
    `only ${String(read.length)} documents are content-read; the extension dispatch is wrong`,
  );
});

test('AT3 — every carve-out names a reason, its owner, and a segment that exists', () => {
  const segments = new Set(documentsInScope().flatMap((entry) => entry.split('/')));

  assert.ok(ALLOWED_SEGMENTS.length > 0, 'the carve-out list is the FR10 record; it is not empty');

  for (const entry of ALLOWED_SEGMENTS) {
    assert.ok(entry.reason.length > 20, `"${entry.segment}" has no reason worth reading`);

    assert.ok(
      entry.reason.includes(OWNER_TICKET),
      `"${entry.segment}" names no ticket that removes it; a carve-out with no owner is permanent`,
    );

    assert.ok(
      segments.has(entry.segment),
      `"${entry.segment}" is not a path segment of this tree any more: a carve-out that ` +
        'outlives its subject is a hole nobody is watching',
    );
  }
});

test('AT4 — the sweep bites on a reintroduced Portuguese name', () => {
  assert.deepEqual(
    segmentOffendersIn('notas/2026-08-14-execucao-não-feita.md'),
    [
      'notas/2026-08-14-execucao-não-feita.md: path segment ' +
        '"2026-08-14-execucao-não-feita.md": diacritic "ã"',
    ],
    'a diacritic in a file name has to be seen',
  );

  assert.deepEqual(
    segmentOffendersIn('docs/spec/graph-com-ganchos.md'),
    ['docs/spec/graph-com-ganchos.md: path segment "graph-com-ganchos.md": stopword "com"'],
    'a stopword between hyphens has to be seen; the hyphen is a word boundary',
  );

  assert.deepEqual(
    segmentOffendersIn('especificacoes/eventos/exemplos/example-log.jsonl'),
    [],
    'the four carved-out segments must not be reported; that is what the list is for',
  );
});

test('AT4 — the sweep bites on reintroduced Portuguese contents', () => {
  assert.deepEqual(
    contentOffendersIn('notas/note.md', 'A execução não termina.\nAnd this line is English.\n'),
    ['notas/note.md:1: diacritic "ç" — A execução não termina.'],
    'a Portuguese sentence in a note has to be seen, and only the line that carries it',
  );

  assert.deepEqual(
    contentOffendersIn('schema/exemplos/graph.json', '{\n  "description": "a condição"\n}\n'),
    ['schema/exemplos/graph.json:2: diacritic "ç" — "description": "a condição"'],
    'JSON is read raw: a fixture has no fence to hide behind',
  );

  assert.deepEqual(
    contentOffendersIn('notas/note.md', 'The frozen key is `condicao`, and `não` is data.\n'),
    [],
    'a backtick span is quoted vocabulary, not a word of the sentence',
  );

  assert.deepEqual(
    contentOffendersIn('notas/note.md', 'Rendered (literally "ausência tem nome") in §3.\n'),
    [],
    'the gloss is the one span where the original is supposed to survive',
  );

  assert.deepEqual(
    contentOffendersIn(CONTENT_NOT_SWEPT, 'A execução não termina.\n'),
    [],
    "the wire glossary's rows are t281's data; its lines are never read here",
  );

  assert.deepEqual(
    contentOffendersIn('especificacoes/eventos/reducers/reconstruct-state.mjs', 'const não = 1;\n'),
    [],
    'a .mjs source is the identifier sweep\'s dimension, not this one\'s',
  );
});
