/**
 * D20 gate: no Portuguese flag or positional survives in this package's CLIs
 * (t230, AC).
 *
 * Port of `packages/core/test/no-portuguese-wire.test.ts`, the same way
 * `no-portuguese-identifiers.test.ts` is a port of the core's: one gate per
 * package, each reading the rows of `docs/spec/glossario-wire.md` that belong to
 * it. The rows that belong here are `superfície = routes-cli-report` — the flag
 * half of §5.2, since the routes are the screen's and the report is the core's.
 *
 * The sweep is raw text over everything outside a comment, because a flag is
 * never anything but a flag: `--classe` in this package only ever appears in the
 * argv it parses or in the help it prints, and both are code. Comments are
 * masked for the reason the core's original gives — prose about a name is
 * documentation, not the name, and explaining a rename means writing both
 * sides of it down.
 *
 * ## The two positionals, which the glossary does not carry
 *
 * §5.2 has exactly two rows (`--classe`, `--saida`). The surveyor's commands
 * PRINT two more Portuguese names — `<execucao_id>` and `<proposta_id>` in their
 * usage text — and t230 moves them by deriving the spelling from the API rows
 * for the same words (`execucao_id` → `execution_id`, §1.1; `proposta` →
 * `proposal`, §1.3), without adding rows to a document no child ticket has
 * edited since t213. They are listed inline below, and that is why.
 *
 * The scope of that derivation is DISPLAY, and the file list is what keeps it
 * there: `src/surveyor/proposal.ts` builds the body of
 * `POST /v1/proposals/:id/outcome`, whose `execucao_id` is the frozen
 * hypothesis vocabulary (`docs/spec/entidades-versionamento.md` §5), and it is
 * deliberately not swept. The CLI's display name and the wire field it feeds are
 * two different things, and renaming the second one is nobody's ticket.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');

/** The surface t230 migrates, as the glossary tags it. */
const SURFACE = 'routes-cli-report';

/** The commands whose flags §5.2 renames. */
const FLAG_FILES = [
  path.join('src', 'intake', 'command-line.ts'),
  path.join('src', 'intake', 'cli.mjs'),
  path.join('src', 'intake', 'generate.ts'),
  path.join('src', 'synthesizer', 'synthesize.ts'),
  path.join('src', 'synthesizer', 'cli.mjs'),
];

/** The commands whose usage text names a positional. */
const POSITIONAL_FILES = [
  path.join('src', 'surveyor', 'command-line.ts'),
  path.join('src', 'surveyor', 'outcome.ts'),
  path.join('src', 'surveyor', 'cli.mjs'),
];

/**
 * The displayed positionals, derived from the API rows for the same words.
 *
 * Not in the glossary; see this file's header for why they are here instead.
 */
const DISPLAYED_POSITIONALS: ReadonlyArray<{ term: string; english: string }> = Object.freeze([
  { term: 'execucao_id', english: 'execution_id' },
  { term: 'proposta_id', english: 'proposal_id' },
]);

/** A term of the glossary, with the English it has to be written in. */
interface Term {
  term: string;
  english: string;
}

/** Every Portuguese term the glossary maps on this surface. */
function surfaceTerms(): Term[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY} does not exist`);
  const terms: Term[] = [];

  for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
    const cells = line.trim();
    if (!cells.startsWith('|')) continue;
    const parts = cells.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
    if (parts[0] !== SURFACE) continue;

    const english = parts[2] ?? '';
    const term = (parts[1] ?? '').trim();
    if (term === '' || term === english) continue;
    terms.push({ term, english });
  }

  assert.ok(terms.length >= 25, `the glossary's "${SURFACE}" surface parsed to only ${terms.length} terms`);
  return terms;
}

/**
 * The §5.2 rows: the flags a person types at a command of this repository.
 *
 * Not only this package's. §5.2 also carries the cost lens's flags — since t255,
 * which moved them out of a local array in that package's own gate and into the
 * glossary — and sweeping them here costs nothing and claims nothing: a runner
 * command that ever spelled one would be caught by the row that already exists.
 * The floor is a floor and not an equality for that reason: another package's
 * row landing in §5.2 must not turn this gate red.
 */
function flagTerms(): Term[] {
  const flags = surfaceTerms().filter((entry) => entry.term.startsWith('--'));
  assert.ok(flags.length >= 2, `the glossary's §5.2 parsed to only ${flags.length} CLI flags`);
  return flags;
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
 * The boundary on the right is what keeps `--class` from reading as a hit on
 * `--classe`, and `execution_id` from reading as one on `execucao_id`: only the
 * old spelling, whole, counts.
 */
export function cliHits(source: string, terms: ReadonlyArray<Term>): string[] {
  const hits: string[] = [];

  maskComments(source).split('\n').forEach((line, index) => {
    for (const entry of terms) {
      if (new RegExp(`${entry.term}(?![A-Za-z0-9_-])`).test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (English: "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

/** Reads one scanned file, failing loudly if the list went stale. */
function sourceOf(relative: string): string {
  const full = path.join(PACKAGE_ROOT, relative);
  assert.ok(existsSync(full), `artifact does not exist: ${relative}`);
  return readFileSync(full, 'utf8');
}

test('t230 — the intake and synthesizer commands take the English flags of §5.2', () => {
  const terms = flagTerms();

  const hits = FLAG_FILES.flatMap((relative) =>
    cliHits(sourceOf(relative), terms).map((hit) => `${relative}:${hit}`),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese CLI flags still typed (D20, glossario-wire.md §5.2):\n${hits.join('\n')}`,
  );
});

test('t230 — the surveyor commands print English positionals, without touching the frozen body', () => {
  const hits = POSITIONAL_FILES.flatMap((relative) =>
    cliHits(sourceOf(relative), DISPLAYED_POSITIONALS).map((hit) => `${relative}:${hit}`),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese positionals still printed (D20, derived from §1.1/§1.3):\n${hits.join('\n')}`,
  );

  // And the frozen half is still spelled the old way, on purpose: a sweep that
  // had quietly renamed it too would have moved a wire field no D20 child owns.
  const proposal = sourceOf(path.join('src', 'surveyor', 'proposal.ts'));
  assert.ok(
    proposal.includes('execucao_id'),
    'the hypothesis body lost `execucao_id`; that field is frozen (entidades-versionamento.md §5)',
  );
});

test('t230 — the sweep bites on the old spellings and lets the new ones through', () => {
  const flags = flagTerms();

  const caught = [
    "  '    \"<request>\" --classe <name> [options]',",
    "if (name === '--classe') return 1;",
    "  '  --saida <path>      where to write the draft (default',",
  ];
  for (const source of caught) {
    assert.ok(cliHits(source, flags).length > 0, `the sweep missed an old flag: ${source}`);
  }

  const allowed = [
    "  '    \"<request>\" --class <name> [options]',",
    "  '  --out <path>        where to write the draft (default',",
    // A flag that merely starts the same way is not the old one.
    "  '  --classes-url <url> where the registry lives',",
    // Prose about the rename, which is how a header explains one.
    '/** flags (`--classe`, `--saida`), renamed by t230 to `--class` and `--out`. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(cliHits(source, flags), [], `the sweep flagged the new spelling: ${source}`);
  }

  const caughtPositionals = [
    '  <proposta_id> <execucao_id> [url] [--token <token>]',
    'return refuse(`execucao_id has to be an integer (got: ${JSON.stringify(rawId)})`);',
  ];
  for (const source of caughtPositionals) {
    assert.ok(
      cliHits(source, DISPLAYED_POSITIONALS).length > 0,
      `the sweep missed an old positional: ${source}`,
    );
  }
  assert.deepEqual(
    cliHits('  <proposal_id> <execution_id> [url] [--token <token>]', DISPLAYED_POSITIONALS),
    [],
    'the English positionals have to pass',
  );
});
