/**
 * D24 gate: every document a stranger reads before the code is English (t299).
 *
 * The series' first sibling (t281) took `docs/spec/glossario-wire.md`, the one
 * document that could not simply be translated because it is a map of retired
 * names. This one takes the opposite half: the documents somebody opens BEFORE
 * touching a line of source — the README, the product explainer, the two format
 * documents and the fifteen specifications — where nothing is a historical
 * record and everything is prose.
 *
 * A sweep is what keeps that closed after today. Without one, the next paragraph
 * appended to a specification is written in whichever language its author was
 * reading, and nothing says so until a stranger opens the file.
 *
 * ## Two cheap signals, and why they are enough
 *
 * The scan is the one `tests/no-portuguese-factory-bundles.test.mjs` proved on
 * the factory bundles, and that `packages/core/test/no-portuguese-glossary-prose.test.ts`
 * pointed at a specification for the first time:
 *
 * - a Portuguese diacritic, which no English word in this repository carries;
 * - a short list of function words common enough in Portuguese prose that a
 *   paragraph left behind is certain to contain one, and rare enough as English
 *   tokens that a translated document never trips them.
 *
 * ## What is read, and what is not
 *
 * Two cuts, both taken from the glossary-prose gate:
 *
 * - **every fenced block**, which is where the JSON of the graph document, the
 *   DDL of the migrations and the frames of a session live. Those keys are
 *   frozen wire vocabulary (D20, and D18's carve-out before it): `nos`,
 *   `arestas`, `de`, `para`, `condicao`, `execucao_id`, `pendente`. Translating
 *   them is not this ticket's act — it is not anybody's, until a decision says
 *   so;
 * - **every backtick span**, for the same reason one line up. `` `classe` ``
 *   quoted mid-sentence is the name of a field, not a word of the sentence.
 *
 * What is left is titles, paragraphs, list items and table cells — and the table
 * cells are deliberately IN, unlike the glossary's. There the rows are the
 * retired-name data itself; here a table is prose that happens to be laid out in
 * columns, and D24 moves it like any other sentence.
 *
 * ## The gloss exception
 *
 * The series' convention is that where an English rendering would flatten a
 * nuance the Portuguese carried, the original stays inline as
 * `(literally "<phrase>")`. That span is the one place Portuguese is supposed to
 * survive, so it is cut before the scan rather than exempted per file.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The one document under `docs/spec/` this gate never reads.
 *
 * t281 owns it and gave it a gate of its own
 * (`packages/core/test/no-portuguese-glossary-prose.test.ts`), which sweeps its
 * prose and spares its table rows. A carve-out that names its subject and its
 * owner is the convention the identifier sweeps established; this one has both,
 * and it is permanent by design rather than by neglect — a map of retired names
 * is written in retired names forever.
 */
export const NOT_SWEPT = 'glossario-wire.md';

/** A Portuguese diacritic. No English word in this repository carries one. */
const DIACRITIC = /[çãõáéíóúê]/i;

/** Portuguese function words, common in its prose and absent from English. */
const STOPWORD = /\b(não|você|para|com|uma|nesta|deste)\b/;

/** The one span where the original is supposed to survive. */
const GLOSS = /\(literally "[^"]*"\)/g;

/** An opening or closing code fence, and the run of backticks that makes it. */
const FENCE = /^\s*(`{3,})/;

/** A backtick span, of any backtick run length, within one line. */
const SPAN = /(`+)(.+?)\1/g;

/** Replaces a span with same-length blanks, so a column number stays honest. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

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
 * The document reduced to its prose: no code span, no fenced block.
 *
 * Blanked rather than dropped, so the index of a line in the result is still its
 * number in the file and a failure can name it.
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

/** Every document this gate reads, as repo-relative paths, in reading order. */
export function documentsInScope() {
  const under = (directory) =>
    readdirSync(path.join(ROOT, directory))
      .filter((entry) => entry.endsWith('.md') && entry !== NOT_SWEPT)
      .sort()
      .map((entry) => `${directory}/${entry}`);

  return [
    'README.md',
    'DECISIONS.md',
    'docs/o-que-e-o-cartografo.md',
    ...under('docs/formatos'),
    ...under('docs/spec'),
  ];
}

/**
 * Every offending line of one document, with its number and what tripped it.
 *
 * Reported whole rather than stopping at the first: a half-translated document
 * has dozens, and a gate that named one per run would take dozens of runs to
 * finish. A document that is not there at all is one offender of its own, which
 * is what keeps this gate red — rather than crashing — while the rename of FR6
 * has not happened yet.
 *
 * @param {string} relativePath Repo-relative path of the document to read.
 * @returns {string[]} One entry per offending line.
 */
export function offendersIn(relativePath) {
  const absolute = path.join(ROOT, relativePath);
  if (!existsSync(absolute)) return [`${relativePath}: does not exist`];

  const found = [];

  proseOf(readFileSync(absolute, 'utf8')).forEach((line, index) => {
    const diacritic = DIACRITIC.exec(line);
    const stopword = STOPWORD.exec(line);
    if (diacritic === null && stopword === null) return;

    const why = diacritic === null ? `stopword "${stopword[0]}"` : `diacritic "${diacritic[0]}"`;
    found.push(`${relativePath}:${String(index + 1)}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

test('AT1 — no Portuguese survives in the documents a stranger reads first', () => {
  const documents = documentsInScope();

  assert.ok(
    documents.length >= 20,
    `only ${String(documents.length)} documents read; the sweep is blind`,
  );

  const offenders = documents.flatMap(offendersIn);

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives in a reader-facing document:\n${offenders.join('\n')}`,
  );
});

test('AT1 — the gate reads the whole reader-facing set, and only the glossary is out', () => {
  const documents = documentsInScope();

  for (const required of ['README.md', 'DECISIONS.md', 'docs/o-que-e-o-cartografo.md']) {
    assert.ok(documents.includes(required), `${required} is not in the swept set`);
  }

  assert.ok(
    documents.some((entry) => entry.startsWith('docs/formatos/')),
    'no format document is swept; the directory read is not resolving',
  );

  assert.deepEqual(
    documents.filter((entry) => entry.endsWith(NOT_SWEPT)),
    [],
    'the wire glossary is t281\'s and has a gate of its own; this one must not read it',
  );
});
