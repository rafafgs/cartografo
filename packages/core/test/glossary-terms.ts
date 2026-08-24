/**
 * The glossary rows the two D20 database sweeps read (t235, FR7/FR8).
 *
 * `no-portuguese-database.test.ts` asks it of the QUERIES this package writes
 * and `migrate.test.ts` asks it of the SCHEMA the migrations build, and both
 * questions are the same one: does a Portuguese name the glossary retired still
 * stand? Declaring the vocabulary twice is how the two start disagreeing about
 * what "retired" means, so it is declared here once and read out of
 * `docs/spec/glossario-wire.md` at run time — a row added there is a term
 * checked by both on the next run.
 *
 * ## Which rows
 *
 * Two slices of the document, because after this ticket the schema speaks
 * English in both of its vocabularies:
 *
 * - **§4** (`database`), the NAMES: tables in §4.1, columns in §4.2, and the
 *   indexes that inherit the column's name.
 * - **§1.6** (`api`), the enum VALUES. They are tagged `api` because the same
 *   value also travels on the wire, and the document's own intro says why it
 *   lists them once and not twice: "Every enum value lives here, once only,
 *   even when it also travels … in the migration's `CHECK`". Reading them off
 *   that surface is what lets `status = 'pendente'` be a hit without the value
 *   being registered a second time under `database`.
 *
 * ## How a cell becomes a term
 *
 * - **A row whose replacement equals its term is dropped.** `runner`, `lease`
 *   and `skill` are there to say "this name does not change", and sweeping for
 *   them would fail a file for spelling a table correctly.
 * - **A QUALIFIED row names the table only to disambiguate.** `evento.tipo`,
 *   `pergunta.tipo` and `credencial.tipo` are three meanings of one word, and
 *   what a SQL position actually spells is the column — so the term is the part
 *   after the dot, and the three collapse into one entry listing all three
 *   English names.
 * - **`pergunta.tipo=pergunta` carries the VALUE after the `=`.** It is the one
 *   §1.6 row qualified by key AND value, and the term is `pergunta`: the same
 *   word is the retired table name, so the bare word is a hit either way and the
 *   suggested replacement is allowed to be approximate (FR7).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The one mapping document, and the label a failure quotes. */
export const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');
export const GLOSSARY_LABEL = path.relative(REPO_ROOT, GLOSSARY);

/** The surface that owns the schema's names. */
const NAME_SURFACE = 'database';

/** The surface that owns every enum value, wire and column alike. */
const VALUE_SURFACE = 'api';

/** The section of {@link VALUE_SURFACE} that holds them (§1.6). */
const VALUE_SECTION = '1.6';

/** Separator between two spellings of one name inside a single cell. */
const SPELLING_SEPARATOR = ' / ';

/** A Portuguese name the schema retired, and what it has to become. */
export interface Term {
  term: string;
  english: string;
}

/** `### 1.6 Enum values` → `1.6`. */
const SECTION_HEADING = /^#{2,4}\s+(\d+(?:\.\d+)*)\s/;

/** The term a `today` cell names, past the qualifier the glossary writes it with. */
function termOf(spelling: string): string {
  const cell = spelling.trim();
  if (cell.includes('=')) return cell.slice(cell.lastIndexOf('=') + 1).trim();
  if (cell.includes('.')) return cell.slice(cell.lastIndexOf('.') + 1).trim();
  return cell;
}

/**
 * Every mapping row of one selection of the document, in the order it is written.
 *
 * @param wanted Answers, for a row's surface tag and section number, whether the
 *   caller wants it.
 * @returns One entry per (term, English) pair; a cell with two spellings of one
 *   name yields one entry each.
 */
function mappings(wanted: (surface: string, section: string) => boolean): Term[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY_LABEL} does not exist`);
  const found: Term[] = [];
  let section = '';

  for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
    const heading = SECTION_HEADING.exec(line);
    if (heading !== null) {
      section = heading[1];
      continue;
    }

    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.slice(1).split('|').map((cell) => cell.replaceAll('`', '').trim());
    if (!wanted(cells[0] ?? '', section)) continue;

    const english = cells[2] ?? '';
    for (const spelling of (cells[1] ?? '').split(SPELLING_SEPARATOR)) {
      const term = termOf(spelling);
      if (term === '' || term === english) continue;
      found.push({ term, english });
    }
  }

  return found;
}

/**
 * The §4 rows, each with the one English name that row gives it.
 *
 * Unmerged on purpose, unlike {@link databaseTerms}: whoever reads this is
 * resolving a name against the live schema (`spec-database-citations.test.ts`),
 * and `evento.tipo` → `type` and `credencial.tipo` → `owner_type` are two
 * answers that a joined cell would make unusable.
 */
export function databaseNameRows(): Term[] {
  const rows = mappings((surface) => surface === NAME_SURFACE);
  assert.ok(rows.length > 80, `the glossary's §4 parsed to only ${rows.length} rows`);
  return rows;
}

/**
 * Every Portuguese word the schema retires, with the English that replaced it.
 *
 * @returns One entry per distinct term; a term the glossary maps on more than
 *   one row lists every English name it was given, joined by ` / `.
 */
export function databaseTerms(): Term[] {
  const byTerm = new Map<string, string[]>();

  for (const row of mappings(
    (surface, section) =>
      surface === NAME_SURFACE || (surface === VALUE_SURFACE && section === VALUE_SECTION),
  )) {
    const known = byTerm.get(row.term) ?? [];
    if (!known.includes(row.english)) known.push(row.english);
    byTerm.set(row.term, known);
  }

  const terms = [...byTerm].map(([term, englishes]) => ({ term, english: englishes.join(' / ') }));
  assert.ok(
    terms.length > 100,
    `the glossary's schema surfaces parsed to only ${terms.length} terms`,
  );
  return terms;
}

/**
 * Every hit of {@link databaseTerms} in one text, as `line: what`.
 *
 * Shared so the two sweeps report a hit the same way; WHAT each of them feeds in
 * is their own business — one masks a TypeScript file down to its SQL, the other
 * strips the comments out of the DDL the database gives back.
 *
 * @param text Already reduced to the positions where a name can only be a name.
 * @param terms The glossary's rows.
 * @returns One entry per retired name still standing, sorted.
 */
export function termHits(text: string, terms: readonly Term[]): string[] {
  const lines = text.split('\n');
  const hits: string[] = [];

  for (const entry of terms) {
    const pattern = new RegExp(`\\b${entry.term}\\b`);
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (glossary says "${entry.english}")`);
      }
    });
  }

  return hits.sort();
}
