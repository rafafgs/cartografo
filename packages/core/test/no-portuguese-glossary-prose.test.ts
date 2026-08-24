/**
 * D24 gate: the wire glossary's PROSE is English, its data cells are not (t281).
 *
 * `docs/spec/glossario-wire.md` is the one document of D24's series that could
 * not simply be translated. It is a map of RETIRED names, so its `today`/
 * `becomes` cells have to keep citing the Portuguese spellings forever — that is
 * the historical record the five per-package wire sweeps check code against, and
 * `glossario-wire-docs.test.ts` excludes the file from its own citation sweep for
 * exactly that reason. Everything AROUND those cells is ordinary prose, and D24
 * moves it to English like every other document.
 *
 * A sweep is what keeps the two halves apart after today. Without one, the next
 * edit to a paragraph is written in whichever language the editor was reading,
 * and nothing says so until a stranger opens the file.
 *
 * ## What is read, and what is not
 *
 * The scan is the one `tests/no-portuguese-factory-bundles.test.mjs` proved on
 * the factory bundles — a Portuguese diacritic, plus a short list of function
 * words too common in Portuguese prose to survive a paragraph and too rare in
 * English to fire on one — pointed at what is left after two cuts:
 *
 * - **every line that starts with `|`**, which is every table row. That is where
 *   the retired names live, and a gate that read them would be asking the
 *   glossary to stop being a glossary;
 * - **every backtick span and fenced block**, because a name quoted as code is
 *   the name and not a word. `` `metrica_esperada` `` stays Portuguese in an
 *   English sentence for the same reason `` `criado_em` `` does: it is what the
 *   column is still called.
 *
 * What is left is titles, paragraphs and list items — the positions where the
 * document is talking rather than citing, and the only positions D24 moves.
 *
 * Complement, not substitute, of `glossario-wire.test.ts`: that one guards the
 * document's STRUCTURE (one glossary table per section, no colliding
 * replacements, the English header row of FR2) and never reads a sentence.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');
const GLOSSARY_LABEL = path.relative(REPO_ROOT, GLOSSARY);

/** A Portuguese diacritic. No English word in this repository carries one. */
const DIACRITIC = /[çãõáéíóúê]/i;

/** Portuguese function words, common in its prose and absent from English. */
const STOPWORD = /\b(não|você|para|com|uma|nesta|deste)\b/;

/** An opening or closing code fence, and the run of backticks that makes it. */
const FENCE = /^\s*(`{3,})/;

/** A backtick span, of any backtick run length, within one line. */
const SPAN = /(`+)(.+?)\1/g;

/** Replaces a span with same-length blanks, so a column number stays honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** The line with every backtick span blanked out; the backticks stay. */
function withoutSpans(line: string): string {
  let kept = line;

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + blank(match[2]) + kept.slice(end);
  }

  return kept;
}

/**
 * The document reduced to its prose: no table row, no code span, no fenced block.
 *
 * Blanked rather than dropped, so the index of a line in the result is still its
 * line number in the file and a failure can name it.
 *
 * @param markdown Contents of the glossary.
 * @returns One entry per line of the input, prose lines intact and the rest
 *   blank.
 */
export function proseOf(markdown: string): string[] {
  const prose: string[] = [];
  let fence: string | null = null;

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

    prose.push(line.trimStart().startsWith('|') ? '' : withoutSpans(line));
  }

  return prose;
}

/**
 * Every prose line that still reads as Portuguese, with what tripped it.
 *
 * Reported whole rather than stopping at the first, the same way the factory
 * bundle sweep does: a half-translated document has dozens, and a gate that
 * named one per run would take dozens of runs to finish.
 *
 * @param markdown Contents of the glossary.
 * @returns One entry per offending line, as `line: why — the line`.
 */
export function offendersIn(markdown: string): string[] {
  const found: string[] = [];

  proseOf(markdown).forEach((line, index) => {
    const diacritic = DIACRITIC.exec(line);
    const stopword = STOPWORD.exec(line);
    if (diacritic === null && stopword === null) return;

    const why = diacritic === null ? `stopword "${stopword?.[0]}"` : `diacritic "${diacritic[0]}"`;
    found.push(`${GLOSSARY_LABEL}:${index + 1}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

test('D24 — no Portuguese prose survives in the wire glossary', () => {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY_LABEL} does not exist`);
  const markdown = readFileSync(GLOSSARY, 'utf8');

  const prose = proseOf(markdown).filter((line) => line.trim() !== '');
  assert.ok(
    prose.length >= 100,
    `only ${prose.length} prose lines were read out of ${GLOSSARY_LABEL}; the sweep is blind`,
  );

  const offenders = offendersIn(markdown);
  assert.deepEqual(
    offenders,
    [],
    `Portuguese prose survives in ${GLOSSARY_LABEL}:\n${offenders.join('\n')}`,
  );
});

test('D24 — the sweep bites on prose and leaves the retired names alone', () => {
  const fixture = [
    '# The wire glossary',
    'A paragraph that stayed in Portuguese: cada linha vira uma coluna.',
    'An English paragraph citing `criado_em`, `não` and `metrica_esperada` as code.',
    '| surface | today | becomes | defined in |',
    '|---|---|---|---|',
    '| database | `criado_em` / `criada_em` | `created_at` | `0002_grafo_versao_proposta.sql` |',
    '```',
    'uma linha de código que ninguém traduz',
    '```',
  ].join('\n');

  const offenders = offendersIn(fixture);
  assert.equal(offenders.length, 1, `unexpected offenders:\n${offenders.join('\n')}`);

  // Asserted by prefix rather than by a pattern over the Portuguese sentence:
  // a regular expression is an identifier position for the D18 sweep next door,
  // and this fixture's whole point is to carry words that sweep refuses.
  assert.ok(
    offenders[0].startsWith(`${GLOSSARY_LABEL}:2: stopword `),
    `the sweep pointed somewhere other than the untranslated line: ${offenders[0]}`,
  );
});
