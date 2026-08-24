/**
 * D20 gate: no Portuguese survives in the cost lens's CLI or in what it posts
 * (t230, AC; widened by t255).
 *
 * Port of `packages/core/test/no-portuguese-wire.test.ts`, the same way
 * `no-portuguese-identifiers.test.ts` is a port of the screen's: one gate per
 * package, each reading the rows of `docs/spec/glossario-wire.md` that belong to
 * it. Two selections belong here, and they are read off the document by SECTION,
 * so a row added there is a term checked here on the next run:
 *
 * - **§5.2**, the command line a person types — every flag of it, plus the
 *   subcommand, which is typed exactly the same way a flag is;
 * - **§5.5**, the candidate and evidence this lens PUTS on the wire, which is
 *   the surface t255 added after the v2 review found it still Portuguese.
 *
 * The sweep is raw text over everything outside a comment, because none of these
 * names is ever anything but the name: `--teto-tokens` only ever appeared in the
 * argv `parseArguments` reads or in the `USAGE` it prints, and `evidencia` only
 * ever appeared as the key of the object `createProposal` sends. Comments are
 * masked for the reason the core's original gives — prose about a name is
 * documentation, not the name, and `src/cli.ts`'s own header can only explain a
 * rename by writing both sides of it down.
 *
 * ## What t255 took away from this file
 *
 * Until t255 three flags of this package (`--execucao`, `--teto-tokens`,
 * `--teto-segundos`) were listed in a local `DERIVED_FLAGS` array, because the
 * glossary carried no row for them; and `avaliar`, `--tier-fator` and
 * `--tier-minimo-nos` had test cases declaring they stay Portuguese on purpose.
 * Both were t230 narrowing its own delivery, not a decision: D20's text names
 * "flags de CLI" without an exception, and the founder restated the end state on
 * 2026-08-17. So the six live in §5.2 now, the local array is gone, and this
 * gate has exactly one source of truth again.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { type GlossaryTerm, glossaryTerms } from '@cartografo/test-support';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Every file of this package that publishes the command line. */
const SCANNED_FILES = [
  path.join('src', 'cli.ts'),
  path.join('bin', 'topografo-custo.mjs'),
];

/**
 * Every file of this package that writes the candidate onto the wire.
 *
 * `policy.ts` builds it and `cli.ts` maps it into `createProposal`; `client.ts`
 * only declares the five keys of the body, which went English with t226 and are
 * checked by `client.test.ts` instead. `cost.ts` is deliberately absent: it is
 * the layer `policy.ts` reads FROM, never serialized, and masking a lower-layer
 * read is the same convention the core's gate follows.
 */
const CANDIDATE_FILES = [path.join('src', 'policy.ts'), path.join('src', 'cli.ts')];

/**
 * The §5.2 rows: what a person types at a command of this repository.
 *
 * By section and not by surface tag, which is why the shared reader is asked
 * that way: §5 holds the screen's routes and the graph report as well, under
 * the same `routes-cli-report` tag, and neither is anything this package can
 * write.
 *
 * Flags AND the bare subcommand. t230 read only the `--`-prefixed half, which is
 * how `avaliar` sat one row away from a gate that could have caught it.
 */
function glossaryFlags(): GlossaryTerm[] {
  return glossaryTerms({ section: '5.2' }, 5);
}

/** The §5.5 rows: the candidate and the evidence this lens posts. */
function candidateTerms(): GlossaryTerm[] {
  return glossaryTerms({ section: '5.5' }, 10);
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
 * whole, counts. The one on the left arrived with t255 and the §5.5 rows, where
 * a bare word is the term: without it `custo` fires on this package's own name
 * in `topografo-custo`, which is the brand and not the lens's key (D18).
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

/**
 * Every hit of a §5.5 name in KEY or VALUE position, as `line: what`.
 *
 * Not the raw-text sweep the flags get, and the difference is the whole reason
 * `cost.ts` can stay out of scope: `policy.ts` legitimately READS
 * `row.tempo_total_segundos` off an `IdentifiedCostRow`, which is the layer
 * below the wire, while the `total_seconds` it WRITES beside it is the wire. A
 * key and a quoted value are the two positions where this module publishes a
 * name; a member read is where it consumes somebody else's. Same split the
 * core's api sweep makes, for the same reason.
 *
 * A renamed key with a stale accessor left behind does not escape either — it
 * stops compiling, which is what `npm run typecheck` is for.
 */
export function candidateHits(source: string, terms: ReadonlyArray<GlossaryTerm>): string[] {
  const hits: string[] = [];

  maskComments(source).split('\n').forEach((line, index) => {
    for (const entry of terms) {
      const asKey = new RegExp(`(^|[{,(\\s])${entry.term}\\s*\\??\\s*:`);
      const asValue = new RegExp(`(['"\`])${entry.term}\\1`);
      if (asKey.test(line)) {
        hits.push(`${index + 1}: key "${entry.term}" (English: "${entry.english}")`);
      }
      if (asValue.test(line)) {
        hits.push(`${index + 1}: value "${entry.term}" (English: "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

test('t230 — the cost lens takes the English command line of D20 §5.2', () => {
  const terms = glossaryFlags();

  const hits = SCANNED_FILES.flatMap((relative) => {
    const full = path.join(PACKAGE_ROOT, relative);
    assert.ok(existsSync(full), `artifact does not exist: ${relative}`);
    return cliHits(readFileSync(full, 'utf8'), terms).map((hit) => `${relative}:${hit}`);
  });

  assert.deepEqual(
    hits,
    [],
    `Portuguese still typed at this command (D20, glossario-wire.md §5.2):\n${hits.join('\n')}`,
  );
});

test('t255 — the candidate this lens posts takes the English keys of §5.5', () => {
  const terms = candidateTerms();

  const hits = CANDIDATE_FILES.flatMap((relative) => {
    const full = path.join(PACKAGE_ROOT, relative);
    assert.ok(existsSync(full), `artifact does not exist: ${relative}`);
    return candidateHits(readFileSync(full, 'utf8'), terms).map((hit) => `${relative}:${hit}`);
  });

  assert.deepEqual(
    hits,
    [],
    `Portuguese still on the candidate (D20, glossario-wire.md §5.5):\n${hits.join('\n')}`,
  );
});

test('t230 — the flag sweep bites on the old spellings, and only on those', () => {
  const terms = glossaryFlags();

  const caught = [
    "const fromExecution = extractValue(fromToken.rest, '--execucao');",
    "  --teto-tokens <n>      a candidate when tokens_total of the node passes <n>",
    "    secondCeiling: asNumber('--teto-segundos', fromSecondCeiling.value),",
    // The three t230 declared out of its own scope, and t255 put back in.
    "const fromFactor = extractValue(fromSecondCeiling.rest, '--tier-fator');",
    "const fromMinNodes = extractValue(fromFactor.rest, '--tier-minimo-nos');",
    "if (subcommand !== 'avaliar') return 2;",
  ];
  for (const source of caught) {
    assert.ok(cliHits(source, terms).length > 0, `the sweep missed an old flag: ${source}`);
  }

  const allowed = [
    "const fromExecution = extractValue(fromToken.rest, '--execution');",
    "  --token-cap <n>        a candidate when tokens_total of the node passes <n>",
    "    secondCeiling: asNumber('--second-cap', fromSecondCeiling.value),",
    "const fromFactor = extractValue(fromSecondCeiling.rest, '--tier-factor');",
    "if (subcommand !== 'evaluate') return 2;",
    // The package's own name, which is the brand and does not move (D18) — the
    // reason `cliHits` grew a left boundary with t255.
    "process.stderr.write('topografo-custo: run `topografo-custo --help`');",
    // Prose about the rename, which is how a header explains one.
    '/** `--teto-tokens` became `--token-cap` with t230; nothing answers to it. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(cliHits(source, terms), [], `the sweep flagged something it should not: ${source}`);
  }
});

test('t255 — the candidate sweep tells what this lens writes from what it reads', () => {
  const terms = candidateTerms();

  const caught = [
    "export interface CostEvidence { lente: 'custo'; teto_excedido: 'tokens' | null }",
    '  operacoes: [ChangeNodeDescription];',
    '  evidencia: CostEvidence;',
    '  metrica_esperada: ExpectedMetric;',
    "    tipo: type,",
    "    const exceeded = overTokens ? 'tokens' : 'tempo';",
    "  no_id: row.no_id,",
  ];
  for (const source of caught) {
    assert.ok(candidateHits(source, terms).length > 0, `the sweep missed an old key: ${source}`);
  }

  const allowed = [
    "export interface CostEvidence { lens: 'cost'; ceiling_exceeded: 'tokens' | null }",
    '  operations: [ChangeNodeDescription];',
    '  evidence: CostEvidence;',
    '  expected_metric: ExpectedMetric;',
    // The reads of `IdentifiedCostRow`, which `cost.ts` owns and this ticket
    // leaves alone: a member read is the layer below the wire, not the wire.
    '    const sample = overTokens ? row.sessoes_com_uso : row.sessoes_com_tempo;',
    '    node_id: row.no_id,',
    '    total_seconds: row.tempo_total_segundos,',
    '    graph_version_id: row.grafo_versao_id,',
    // Prose about the rename, which is how a header explains one.
    '/** `evidencia` became `evidence` with t255; nothing answers to it. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(
      candidateHits(source, terms),
      [],
      `the candidate sweep flagged something it should not: ${source}`,
    );
  }
});
