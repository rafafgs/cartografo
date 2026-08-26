/**
 * D20 gate: the command line of the watcher is English (t247, AT9).
 *
 * Port of `packages/cost-surveyor/test/no-portuguese-wire.test.ts`, narrowed
 * to the one section of `docs/spec/glossary-wire.md` this package has a
 * surface on:
 *
 * - **§5.2**, what a person TYPES — every flag, plus the subcommand, which is
 *   as typed as a flag.
 *
 * The sibling's second half (§5.5, the candidate the cost lens PUTS on the
 * wire) is deliberately absent: this package posts nothing itself. Every write
 * it causes is made by one of the two lenses through their own clients, and
 * each of those is gated in its own package. A copy of that sweep here would
 * assert about files this package does not own.
 *
 * The glossary gains no row for this ticket, and that is the finding rather
 * than an omission: `watch`, `--lens`, `--dry-run` and the five outcomes were
 * born English, so there is no "today → becomes" pair to record. What this gate
 * catches is a later change that reaches for the old vocabulary — which is
 * exactly what happened to `avaliar`, one row away from the gate that would
 * have caught it.
 *
 * The sweep is raw text over everything outside a comment: none of these names
 * is ever anything but the name. Comments are masked for the reason the core's
 * original gives — prose about a name is documentation, not the name.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { type GlossaryTerm, glossaryTerms } from '@cartografo/test-support';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Every file of this package that publishes the command line. */
const SCANNED_FILES = [path.join('src', 'cli.ts'), path.join('bin', 'surveyor.mjs')];

/**
 * The §5.2 rows: what a person types at a command of this repository.
 *
 * By section and not by surface tag, which is why the shared reader is asked
 * that way: §5 holds the screen's routes and the graph report as well, under
 * the same `routes-cli-report` tag, and neither is anything this package can
 * write.
 */
function glossaryFlags(): GlossaryTerm[] {
  return glossaryTerms({ section: '5.2' }, 5);
}

/** Blanks every comment, so prose about a name is not read as the name. */
function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (span) => span.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (span) => span.replace(/[^\n]/g, ' '));
}

/**
 * Every hit of an old spelling in one source text, as `line: what`.
 *
 * The boundary on the right is what stops `--teto-tokens` from reading as a hit
 * on a longer flag that merely starts the same way: only the old spelling,
 * whole, counts. The one on the left is what keeps a bare term from firing
 * inside a longer name. It was written when the cost package's own spelling
 * carried the `custo` row; t303 gave that package an English name and the
 * collision went with it, but the boundary stays — a package name is a name a
 * person types, and D18 moves code, never that.
 */
export function cliHits(source: string, terms: ReadonlyArray<GlossaryTerm>): string[] {
  const hits: string[] = [];

  maskComments(source).split('\n').forEach((line, index) => {
    for (const entry of terms) {
      if (new RegExp(`(?<![A-Za-z0-9_-])${entry.term}(?![A-Za-z0-9_-])`).test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (English: "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

test('t247 — the watcher takes the English command line of D20 §5.2', () => {
  const terms = glossaryFlags();

  const hits = SCANNED_FILES.flatMap((relative) => {
    const full = path.join(PACKAGE_ROOT, relative);
    assert.ok(existsSync(full), `artifact does not exist yet: packages/surveyor/${relative}`);
    return cliHits(readFileSync(full, 'utf8'), terms).map((hit) => `${relative}:${hit}`);
  });

  assert.deepEqual(
    hits,
    [],
    `Portuguese still typed at this command (D20, glossary-wire.md §5.2):\n${hits.join('\n')}`,
  );
});

test('t247 — the glossary needs no new row for this command', () => {
  const typed = ['watch', '--url', '--token', '--lens', '--dry-run', '--help'];
  const terms = glossaryFlags();

  for (const word of typed) {
    assert.deepEqual(
      terms.filter((entry) => entry.english === word),
      [],
      `"${word}" was born English: a glossary row would be recording a migration that never happened`,
    );
  }
});

test('t247 — the flag sweep bites on the old spellings, and only on those', () => {
  const terms = glossaryFlags();

  const caught = [
    "const fromExecution = extractValue(rest, '--execucao');",
    "if (subcommand !== 'avaliar') return 2;",
    "const out = extractValue(rest, '--saida');",
  ];
  for (const source of caught) {
    assert.ok(cliHits(source, terms).length > 0, `the sweep missed an old flag: ${source}`);
  }

  const allowed = [
    "const fromLens = extractValue(fromToken.rest, '--lens');",
    "if (subcommand !== 'watch') return 2;",
    '  --dry-run              report what each lens would run, and run neither',
    // The repository's own brand, which is a name and not a term (D18).
    "process.stderr.write('cartografo-surveyor: run `cartografo-surveyor --help`');",
    "const { evaluateExecution } = await import('@cartografo/cost-surveyor/cli');",
    // Prose about a rename, which is how a header explains one.
    '/** `--teto-tokens` became `--token-cap` with t230; nothing answers to it. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(cliHits(source, terms), [], `the sweep flagged something it should not: ${source}`);
  }
});
