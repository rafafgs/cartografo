/**
 * The one parser of `docs/spec/glossario-wire.md`'s tables (t287, FR1).
 *
 * Five per-package wire gates ask the same document the same question — which
 * Portuguese terms does my surface still owe a rename? — and until t287 each of
 * them answered it with a parser of its own. Five readers of one spec is five
 * ways to break the day its shape changes, and the five had already drifted:
 * `packages/core/test/no-portuguese-wire.test.ts` split a multi-spelling cell on
 * ` / ` and took a qualified cell's tail past the `=`, the screen's and the
 * runner's did neither, and the two topographers tracked `### N.N` headings
 * instead of the surface column. A row the document adds tomorrow would land in
 * some of them and not the others, and nothing would say so.
 *
 * So the reading has an owner now, and the gates own their assertions. The
 * precedent is `packages/core/test/glossary-terms.ts`, which did exactly this
 * for the database dimension and never for the wire one; `scripts/no-anti-
 * portuguese-duplication.test.mjs` is what keeps this the only copy.
 *
 * ## The two ways a caller names its rows
 *
 * They are not interchangeable, which is why the selector is a union and not a
 * string:
 *
 * - **by surface** — the `superfície` cell, the first column. A surface is
 *   split across more than one table (`api` fills §1.1 through §1.7), so the
 *   column is the only thing that gathers it, and the section a row sits in is
 *   irrelevant to whoever asks this way.
 * - **by section** — the `5.2`-style number of one table. §5 mixes the screen's
 *   routes, the CLI and the graph report under a single `routes-cli-report`
 *   tag, so a package that owns one of those three and none of the other two
 *   can only say which by naming the table.
 *
 * Section mode carries one extra guard: the table's own header row spells
 * `hoje` in the term column, and a section has no surface filter to drop it the
 * way the column comparison implicitly does. It stays scoped to that mode, as
 * it was in both topographers before this file existed — surface mode has never
 * needed it, and widening it here would be an unreviewed change to what four
 * gates sweep for.
 *
 * ## How a cell becomes a term
 *
 * The richest of the five readings, which is a superset of the other four:
 *
 * - a cell holding **two spellings of one name** is split on ` / `, the
 *   convention the document states for itself ("Duas grafias do MESMO nome …
 *   vão na mesma linha, separadas por ` / `");
 * - a spelling **qualified by key and value** (`pergunta.tipo=pergunta`) keeps
 *   what comes after the last `=`, because the value is what travels;
 * - a row whose replacement **equals** its term is dropped. Those exist to say
 *   "this name does not change" (`runner`, `soundness`), and sweeping for them
 *   would fail a file for spelling a word correctly.
 *
 * The `.`-qualified form `glossary-terms.ts` also strips is deliberately absent:
 * it is the database dimension's, where a SQL position spells the column and
 * never the table, and no wire caller has ever asked for it.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The one mapping document every wire gate reads. */
export const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');

/** `### 5.2 Linha de comando` → `5.2`. */
const SECTION_HEADING = /^#{2,4}\s+(\d+(?:\.\d+)*)\s/;

/** Separator between two spellings of one name inside a single cell. */
const SPELLING_SEPARATOR = ' / ';

/** The header cell of the term column, which section mode meets as a row. */
const HEADER_CELL = 'hoje';

/** A Portuguese term the glossary retires, and the English that replaces it. */
export interface GlossaryTerm {
  term: string;
  english: string;
}

/** Which rows the caller wants: one surface tag, or one numbered table. */
export type GlossarySelector = { surface: string } | { section: string };

/** The term one spelling names, past the qualifier the glossary writes it with. */
function termOf(spelling: string): string {
  const cell = spelling.trim();
  return cell.includes('=') ? cell.slice(cell.lastIndexOf('=') + 1).trim() : cell;
}

/**
 * Every mapping row of one selection of the document, in the order it is written.
 *
 * @param selector The `superfície` tag, or the `5.2`-style number of one table.
 * @param minimum Fewest entries the selection must parse to; a parser that
 *   quietly stopped matching the table would otherwise read as a clean sweep.
 * @returns One entry per (term, English) pair; a cell with two spellings of one
 *   name yields one entry each.
 */
export function glossaryTerms(selector: GlossarySelector, minimum: number): GlossaryTerm[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY} does not exist`);

  const bySection = 'section' in selector;
  const terms: GlossaryTerm[] = [];
  let section = '';

  for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
    const heading = SECTION_HEADING.exec(line);
    if (heading !== null) {
      section = heading[1] ?? '';
      continue;
    }

    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
    if (!(bySection ? section === selector.section : cells[0] === selector.surface)) continue;

    const english = cells[2] ?? '';
    for (const spelling of (cells[1] ?? '').split(SPELLING_SEPARATOR)) {
      const term = termOf(spelling);
      if (term === '' || term === english) continue;
      if (bySection && term === HEADER_CELL) continue;
      terms.push({ term, english });
    }
  }

  assert.ok(
    terms.length >= minimum,
    bySection
      ? `the glossary's §${selector.section} parsed to only ${terms.length} rows`
      : `the glossary's "${selector.surface}" surface parsed to only ${terms.length} terms`,
  );
  return terms;
}
