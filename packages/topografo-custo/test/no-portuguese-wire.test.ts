/**
 * D20 gate: no Portuguese flag survives in the cost lens's CLI (t230, AC).
 *
 * Port of `packages/core/test/no-portuguese-wire.test.ts`, the same way
 * `no-portuguese-identifiers.test.ts` is a port of the screen's: one gate per
 * package, each reading the rows of `docs/spec/glossario-wire.md` that belong to
 * it. The rows that belong here are `superfície = routes-cli-report` — the flag
 * half of §5.2 — plus three flags of this package's own, explained below.
 *
 * The sweep is raw text over everything outside a comment, because a flag is
 * never anything but a flag: this package's `--teto-tokens` only ever appeared
 * in the argv `parseArguments` reads or in the `USAGE` it prints, and both are
 * code. Comments are masked for the reason the core's original gives — prose
 * about a name is documentation, not the name, and `src/cli.ts`'s own header
 * can only explain the rename by writing both sides of it down.
 *
 * ## The three flags the glossary does not carry
 *
 * §5.2 has exactly two rows (`--classe`, `--saida`), and neither is this
 * package's. What this package publishes is `--execucao`, `--teto-tokens` and
 * `--teto-segundos`, all three named by t230's own Scope but absent from the
 * table. The spelling is derived from the already-applied API rows for the same
 * words — `execucao_id` → `execution_id` (§1.1), `teto_runner` → `runner_cap`
 * and `teto_projeto` → `project_cap` (§1.5) — rather than invented here, and
 * they are listed inline instead of appended to a document no child ticket has
 * edited since t213 delivered it.
 *
 * `--tier-fator` and `--tier-minimo-nos` are NOT here: no glossary row, not
 * named in t230's Scope, and they stay Portuguese until a ticket says otherwise.
 * They are what keeps this gate honest — it flags what moved, not every
 * Portuguese word it can see.
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

/** Every file of this package that publishes the command line. */
const SCANNED_FILES = [
  path.join('src', 'cli.ts'),
  path.join('bin', 'topografo-custo.mjs'),
];

/** A term of the glossary, with the English it has to be written in. */
interface Term {
  term: string;
  english: string;
}

/**
 * This package's own flags, derived from the API rows for the same words.
 *
 * Not in the glossary; see this file's header for why they are here instead.
 */
const DERIVED_FLAGS: ReadonlyArray<Term> = Object.freeze([
  { term: '--execucao', english: '--execution' },
  { term: '--teto-tokens', english: '--token-cap' },
  { term: '--teto-segundos', english: '--second-cap' },
]);

/** The flags §5.2 renames, none of which this package publishes today. */
function glossaryFlags(): Term[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY} does not exist`);
  const flags: Term[] = [];

  for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
    const cells = line.trim();
    if (!cells.startsWith('|')) continue;
    const parts = cells.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
    if (parts[0] !== SURFACE) continue;

    const english = parts[2] ?? '';
    const term = (parts[1] ?? '').trim();
    if (term === '' || term === english || !term.startsWith('--')) continue;
    flags.push({ term, english });
  }

  assert.equal(flags.length, 2, 'the glossary maps two CLI flags on this surface (§5.2)');
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
 * The boundary on the right is what stops `--teto-tokens` from reading as a hit
 * on a longer flag that merely starts the same way: only the old spelling,
 * whole, counts.
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

test('t230 — the cost lens takes the English flags of D20 §5.2 and its derivations', () => {
  const terms = [...glossaryFlags(), ...DERIVED_FLAGS];

  const hits = SCANNED_FILES.flatMap((relative) => {
    const full = path.join(PACKAGE_ROOT, relative);
    assert.ok(existsSync(full), `artifact does not exist: ${relative}`);
    return cliHits(readFileSync(full, 'utf8'), terms).map((hit) => `${relative}:${hit}`);
  });

  assert.deepEqual(
    hits,
    [],
    `Portuguese CLI flags still typed (D20, glossario-wire.md §5.2):\n${hits.join('\n')}`,
  );
});

test('t230 — the sweep bites on the old spellings, and only on those', () => {
  const terms = [...glossaryFlags(), ...DERIVED_FLAGS];

  const caught = [
    "const fromExecution = extractValue(fromToken.rest, '--execucao');",
    "  --teto-tokens <n>      a candidate when tokens_total of the node passes <n>",
    "    secondCeiling: asNumber('--teto-segundos', fromSecondCeiling.value),",
  ];
  for (const source of caught) {
    assert.ok(cliHits(source, terms).length > 0, `the sweep missed an old flag: ${source}`);
  }

  const allowed = [
    "const fromExecution = extractValue(fromToken.rest, '--execution');",
    "  --token-cap <n>        a candidate when tokens_total of the node passes <n>",
    "    secondCeiling: asNumber('--second-cap', fromSecondCeiling.value),",
    // The two flags t230 leaves in Portuguese, on purpose.
    "const fromFactor = extractValue(fromSecondCeiling.rest, '--tier-fator');",
    "const fromMinNodes = extractValue(fromFactor.rest, '--tier-minimo-nos');",
    // The subcommand a person types is not a flag, and does not move either.
    "if (subcommand !== 'avaliar') return 2;",
    // Prose about the rename, which is how a header explains one.
    '/** `--teto-tokens` became `--token-cap` with t230; nothing answers to it. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(cliHits(source, terms), [], `the sweep flagged something it should not: ${source}`);
  }
});
