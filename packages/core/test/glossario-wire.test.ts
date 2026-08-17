/**
 * Structural gate over the PT→EN wire glossary (t213, FR1-FR5; t257, FR24).
 *
 * D20 splits the D18 wire rename into six surface tickets — API/errors, events,
 * proposal operations, database, routes/CLI/report, docs and gate — and this
 * file guards the artifact all six read from: `docs/spec/glossario-wire.md`.
 * Without one registered mapping, each of those tickets invents its own English
 * name for the same Portuguese term, and the rename ends with two vocabularies
 * instead of one.
 *
 * What is checked here is STRUCTURE, never word choice. Whether `trabalho`
 * becomes `job` or `task` is the document's content, reviewed like any other
 * spec (the ticket's TDD Exceptions section says so); what a test can decide is
 * that the term is mapped at all, that it is mapped once, that two different
 * terms of one surface do not collapse into the same English name, and that a
 * name the code already exposes in English is not re-used for another concept
 * (FR2).
 *
 * Two conventions of the document this parser depends on, both stated in its own
 * header:
 *
 * - **A glossary table is one whose first column is `superfície`.** Any other
 *   Markdown table in the file — a legend, an example — is prose and is skipped,
 *   so the document can grow explanatory tables without feeding this sweep.
 * - **A cell never contains a `|`,** because that is the column separator; a set
 *   of enum values is written with commas. And a row whose Portuguese term has
 *   two spellings of the SAME name (`criado_em` and `criada_em`, one column
 *   spelled by gender) carries both in one cell separated by ` / `: they are one
 *   term with one English replacement, and splitting them into two rows would
 *   read as two different names colliding on one translation.
 *
 * Repo convention (the same as `domain-graph.test.ts` and `support.ts`): the
 * artifact is required behind an explicit `existsSync`, so the initial red names
 * the missing document instead of blowing up somewhere inside a parser.
 *
 * ## The one non-structural check: a citation that names a line (t257, FR24)
 *
 * `onde está hoje` is the fourth cell, and when it names a LINE it is making a
 * claim a test can settle: the row's name is written on that line of that file.
 * The t255 round copied two citations out of its own ticket text instead of
 * re-reading the tree it had just changed, and both landed next to the code they
 * meant — the signature header three lines past the JSDoc block the same commit
 * added above it, and the screen's `404` bodies four lines off. A reader who
 * follows either one lands on an import list or a success path and has no way to
 * tell a stale citation from a name that moved.
 *
 * Only the files of {@link RESOLVED_FILES} are resolved, and that is a scope, not
 * a rule about which citations matter. The document carries around a hundred and
 * forty line-numbered citations whose lines drifted the same way, over months of
 * tickets editing code without coming back here, and re-pointing all of them is a
 * ticket of its own — one that has to decide, name by name, WHICH line a term
 * with several occurrences should point at. This gate holds the citations t255
 * wrote, so at least the ones a reader was just told to trust are true; widening
 * it is adding a path to that list and fixing what turns red.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');
const GLOSSARY_LABEL = path.relative(REPO_ROOT, GLOSSARY);

/**
 * The five child-ticket surfaces of D20, in D20's own order (FR4), plus two.
 *
 * `cost-lens` is not a child of t213: it arrived with t255, for the vocabulary
 * the cost surveyor puts on the wire (§5.5). It is a surface of its own rather
 * than another `routes-cli-report` row because the tag is what every gate
 * FILTERS on, and those keys are readable only by that package's gate — folding
 * them into §5's tag would point three other sweeps at names none of them can
 * see.
 *
 * `flow-lens` is the same story one ticket later (§5.6, t264), and it is a
 * SEVENTH tag rather than more `cost-lens` rows for a reason of its own: the two
 * lenses write into the same `proposal.evidence` with different key sets, and
 * one tag over both would let a name of either read as a name of the other.
 */
const SURFACES = Object.freeze([
  'api',
  'events',
  'proposal-ops',
  'database',
  'routes-cli-report',
  'cost-lens',
  'flow-lens',
]);

/** First header cell of a glossary table, normalized. */
const TABLE_MARKER = 'superficie';

/**
 * The files whose line-numbered citations this gate resolves (FR24).
 *
 * Both arrived with t255 — §1.7's header constant and the three §1.4 rows that
 * point at the screen's own `404` — and both were wrong the day they were
 * written. The header says why the list is two paths and not every file the
 * document cites.
 */
const RESOLVED_FILES = Object.freeze([
  'packages/core/src/webhooks/signature.ts',
  'packages/tela/src/static.ts',
]);

/** Separator between two spellings of one term inside a single cell. */
const SPELLING_SEPARATOR = ' / ';

/**
 * The terms t213's spec cites by name, which the document has to map (FR3).
 *
 * This list mirrors the ticket's Context section — the inventory spot-checked
 * against the tree on 2026-08-17 — and nothing else. The glossary is expected to
 * carry considerably more than this: the fixture is the floor the ticket names,
 * not a ceiling, and a term missing here would be one the six child tickets have
 * to name on their own.
 */
const REQUIRED_TERMS = Object.freeze([
  // API: fields, query params, enum values, error envelope, lease reasons.
  'execucao_id',
  'projeto_id',
  'no_atual',
  'limite',
  'classe',
  'pendente',
  'aprovada',
  'aplicada',
  'revertida',
  'rejeitada',
  'motivo',
  'teto_runner',
  'teto_projeto',
  'erro',
  'mensagem',

  // Events: type names, envelope keys, entity and actor types.
  'trabalho.transicao',
  'pergunta.criada',
  'sessao.aberta',
  'grafo_versao.aplicada',
  'lease.concedida',
  'tipo',
  'entidade',
  'ator',
  'ocorrido_em',
  'dados',
  'usuario',
  'agente',
  'sistema',

  // Proposal operations: operation names and the operations' own keys.
  'adicionar_no',
  'remover_no',
  'adicionar_aresta',
  'remover_aresta',
  'alterar_campo_no',
  'no',
  'no_id',
  'de',
  'para',
  'inversa',

  // Database: table names.
  'trabalho',
  'grafo',
  'grafo_versao',
  'proposta',
  'sessao',
  'pergunta',
  'evento',
  'lease',
  'runner',
  'credencial',
  'skill',
  'intake_rascunho',
  'entrega_webhook',
  'assinatura_webhook',
  'entrega_gancho',
  'motor_modelo',
  'trabalho_dependencia',

  // Screen routes, CLI flags and the soundness report.
  '/quadro',
  '/execucoes',
  '/perguntas',
  '/runners',
  '/trabalhos/:id',
  '--classe',
  'estrutura',
  'erros',
  'soundness',
  'violacoes',
  'codigo',
  'alvo',
  'aresta_com_condicao',
  'no_inalcancavel',
  'gancho_no_inexistente',
]);

/**
 * Names the code already spells in English, and the one concept each belongs to.
 *
 * This is FR2 turned into a check. `/v1/jobs` exists (`src/server.ts`), so
 * `trabalho`-as-a-record has to land on `job` and nothing else may claim that
 * word — a second concept translated to `job` would be the rename inventing a
 * synonym for a name the API already publishes. The keys and the values are
 * compared normalized, so `graph_version`, `graph-version` and `/graph-versions`
 * are the same claim.
 */
const ALREADY_ENGLISH: Readonly<Record<string, readonly string[]>> = Object.freeze({
  job: ['trabalho'],
  execution: ['execucao'],
  'input-request': ['pergunta'],
  session: ['sessao'],
  graph: ['grafo'],
  'graph-version': ['grafo_versao'],
});

/** A parsed glossary row. */
interface Row {
  surface: string;
  /** The Portuguese cell, verbatim minus the backticks. */
  pt: string;
  /** The spellings that cell carries — one, or the `a / b` pair of one name. */
  terms: string[];
  en: string;
  source: string;
  /** 1-based line of the document, so a failure points at the row. */
  line: number;
}

/** Lowercase, without diacritics: how a cell is compared. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .trim();
}

/** The cell as a term: no backticks, no surrounding blanks. */
function clean(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

/**
 * A name reduced to what makes two spellings of it the same claim.
 *
 * `--class`, `/board` and `graph_version` are a flag, a route and a column, and
 * the punctuation that says which is exactly what has to fall away before
 * {@link ALREADY_ENGLISH} can compare them.
 */
function nameOf(value: string): string {
  return normalize(clean(value))
    .replace(/^--/, '')
    .replace(/^\/+/, '')
    .replace(/_/g, '-');
}

/** Splits a Markdown table line into its cells. */
function cellsOf(line: string): string[] {
  const trimmed = line.trim();
  return trimmed
    .slice(1, trimmed.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim());
}

/** Is this the `|---|---|` line under a header? */
function isSeparator(line: string): boolean {
  return /^\s*\|[\s|:-]+\|\s*$/.test(line);
}

/**
 * Reads every glossary table of the document into rows.
 *
 * @param markdown Contents of the glossary.
 * @returns One row per data line of every table whose first column is the
 *   surface tag; tables that are not glossary tables are skipped whole.
 */
function parseRows(markdown: string): Row[] {
  const lines = markdown.split('\n');
  const rows: Row[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) continue;

    const header = cellsOf(line);
    if (normalize(header[0] ?? '') !== TABLE_MARKER) continue;
    if (!isSeparator(lines[index + 1] ?? '')) continue;

    index += 2;
    for (; index < lines.length && lines[index].trim().startsWith('|'); index += 1) {
      const cells = cellsOf(lines[index]);
      const pt = clean(cells[1] ?? '');
      rows.push({
        surface: normalize(cells[0] ?? ''),
        pt,
        terms: pt.split(SPELLING_SEPARATOR).map((term) => term.trim()),
        en: clean(cells[2] ?? ''),
        source: (cells[3] ?? '').trim(),
        line: index + 1,
      });
    }
    index -= 1;
  }

  return rows;
}

let parsed: Row[] | null = null;

/** The document's rows, parsed once, behind the explicit artifact check. */
function glossaryRows(): Row[] {
  if (parsed === null) {
    assert.ok(
      existsSync(GLOSSARY),
      `${GLOSSARY_LABEL} does not exist yet: it is t213's deliverable`,
    );
    parsed = parseRows(readFileSync(GLOSSARY, 'utf8'));
  }
  return parsed;
}

/**
 * The five checks, each as a function of the rows alone.
 *
 * Written this way so the last test can run them over a document broken on
 * purpose: a sweep that never fires is a sweep nobody notices going quiet, and
 * this file's whole job is to fire.
 */

/** Terms of {@link REQUIRED_TERMS} that no row maps. */
function unmapped(rows: readonly Row[]): string[] {
  const mapped = new Set(rows.flatMap((row) => row.terms));
  return REQUIRED_TERMS.filter((term) => !mapped.has(term));
}

/** Terms listed more than once on one surface (FR3). */
function repeated(rows: readonly Row[]): string[] {
  const problems: string[] = [];
  for (const surface of SURFACES) {
    const seen = new Map<string, number>();
    for (const row of rows.filter((candidate) => candidate.surface === surface)) {
      for (const term of row.terms) {
        const first = seen.get(term);
        if (first === undefined) seen.set(term, row.line);
        else problems.push(`line ${row.line}: "${term}" is already mapped on "${surface}" at line ${first}`);
      }
    }
  }
  return problems;
}

/** Two terms of one surface translated to the same English name (FR3). */
function colliding(rows: readonly Row[]): string[] {
  const problems: string[] = [];
  for (const surface of SURFACES) {
    const claimed = new Map<string, Row>();
    for (const row of rows.filter((candidate) => candidate.surface === surface)) {
      const owner = claimed.get(row.en);
      if (owner === undefined) claimed.set(row.en, row);
      else {
        problems.push(
          `line ${row.line}: "${row.en}" is already the replacement of "${owner.pt}" on "${surface}" (line ${owner.line})`,
        );
      }
    }
  }
  return problems;
}

/** One term translated two ways across the document (FR3). */
function inconsistent(rows: readonly Row[]): string[] {
  const problems: string[] = [];
  const chosen = new Map<string, Row>();
  for (const row of rows) {
    for (const term of row.terms) {
      const first = chosen.get(term);
      if (first === undefined) chosen.set(term, row);
      else if (first.en !== row.en) {
        problems.push(
          `line ${row.line}: "${term}" becomes "${row.en}" here and "${first.en}" at line ${first.line}`,
        );
      }
    }
  }
  return problems;
}

/** An already-English name taken by a concept that does not own it (FR2). */
function misusedEnglish(rows: readonly Row[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const owners = ALREADY_ENGLISH[nameOf(row.en)];
    if (owners === undefined) continue;
    const allowed = owners.map((term) => nameOf(term));
    if (row.terms.some((term) => allowed.includes(nameOf(term)))) continue;
    problems.push(
      `line ${row.line}: "${row.en}" is the name the code already uses for "${owners.join(', ')}", not for "${row.pt}"`,
    );
  }
  return problems;
}

/**
 * The sixth check, which is the only one that reads something other than the rows.
 *
 * It takes the file reader by injection for the same reason the fixture at the
 * bottom of this file exists: a sweep that resolves paths against the real tree
 * cannot be shown to fire without editing the tree.
 */

/**
 * A citation that names lines: a path, then `41`, `75,88` or `72-87` after a `:`.
 *
 * One cell holds several citations separated by commas — the same comma the
 * `75,88` tail uses — so the path is what anchors a match and the tail is read as
 * far as digits, commas and hyphens go.
 */
const LINE_CITATION = /([\w./-]+\.[a-z]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;

/** One piece of a tail: the lines it covers, and how the cell writes it. */
interface Claim {
  written: string;
  lines: number[];
}

/** A citation of one file by one row, split into its claims. */
interface Citation {
  row: Row;
  /** The path as the cell writes it, relative to the repository root. */
  file: string;
  claims: Claim[];
}

/**
 * The claims a tail makes: one per comma-separated piece, ranges expanded.
 *
 * A piece is a claim of its own because that is what the notation means. `75,88`
 * says the name is on both lines and `72-87` says it is somewhere in that block,
 * so a range is satisfied by one of its lines and a bare number only by itself.
 */
function claimsOf(tail: string): Claim[] {
  return tail.split(',').map((piece) => {
    const [first, last = first] = piece.split('-').map(Number);
    return {
      written: piece,
      lines: Array.from({ length: last - first + 1 }, (_, offset) => first + offset),
    };
  });
}

/** Every line-numbered citation the rows make of one of `files`. */
function citationsOf(rows: readonly Row[], files: readonly string[]): Citation[] {
  const found: Citation[] = [];

  for (const row of rows) {
    for (const [, file, tail] of row.source.matchAll(LINE_CITATION)) {
      if (!files.includes(file)) continue;
      found.push({ row, file, claims: claimsOf(tail) });
    }
  }

  return found;
}

/**
 * Every citation whose lines do not carry the name the row is about (FR24).
 *
 * Either spelling counts — the English one the code stands on after its surface
 * converges, the Portuguese one before — so the check reads the same on both
 * sides of a rename and never asks a row to be edited twice.
 *
 * @param citations What to resolve.
 * @param read The file's lines, or `null` when there is no such file.
 * @returns One entry per claim that misses, naming the lines that DO carry the
 *   name, so the failure message is already the fix.
 */
function misplaced(
  citations: readonly Citation[],
  read: (file: string) => string[] | null,
): string[] {
  const problems: string[] = [];

  for (const citation of citations) {
    const where = `line ${citation.row.line}`;
    const lines = read(citation.file);
    if (lines === null) {
      problems.push(`${where}: ${citation.file} does not exist`);
      continue;
    }

    const spellings = [...citation.row.terms, citation.row.en];
    const carries = (number: number): boolean =>
      spellings.some((spelling) => (lines[number - 1] ?? '').includes(spelling));
    const missed = citation.claims.filter((claim) => !claim.lines.some(carries));
    if (missed.length === 0) continue;

    const real = lines.map((_, index) => index + 1).filter(carries);
    problems.push(
      `${where}: ${citation.file}:${missed.map((claim) => claim.written).join(',')} does not write ` +
        `"${citation.row.en}"; it is on ${real.length === 0 ? 'no line of that file' : `line ${real.join(', ')}`}`,
    );
  }

  return problems;
}

/** The lines of one repository file, or `null` when it is not there. */
function readLines(file: string): string[] | null {
  const absolute = path.join(REPO_ROOT, file);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8').split('\n') : null;
}

test('every glossary table parses into surface/pt/en/source rows', () => {
  const rows = glossaryRows();
  assert.ok(rows.length > 0, `${GLOSSARY_LABEL} has no glossary table`);

  for (const row of rows) {
    const where = `${GLOSSARY_LABEL}:${row.line}`;
    assert.ok(SURFACES.includes(row.surface), `${where}: unknown surface "${row.surface}"`);
    assert.ok(row.pt !== '', `${where}: the Portuguese term is empty`);
    assert.ok(row.en !== '', `${where}: the English replacement is empty`);
    assert.ok(row.source !== '', `${where}: the row names no file`);
  }

  for (const surface of SURFACES) {
    const ofSurface = rows.filter((row) => row.surface === surface);
    assert.ok(ofSurface.length > 0, `surface "${surface}" has no row`);
  }
});

test('every wire term t213 names has a row', () => {
  assert.deepEqual(unmapped(glossaryRows()), [], `terms with no row in ${GLOSSARY_LABEL}`);
});

test('no Portuguese term is listed twice on the same surface', () => {
  assert.deepEqual(repeated(glossaryRows()), [], `repeated terms in ${GLOSSARY_LABEL}`);
});

test('two terms of one surface never claim the same English name', () => {
  assert.deepEqual(colliding(glossaryRows()), [], `colliding replacements in ${GLOSSARY_LABEL}`);
});

test('a term mapped on more than one surface maps to the same English name', () => {
  assert.deepEqual(inconsistent(glossaryRows()), [], `terms translated two ways in ${GLOSSARY_LABEL}`);
});

test('a name the code already spells in English is reused only for its own concept', () => {
  assert.deepEqual(misusedEnglish(glossaryRows()), [], `English names taken in ${GLOSSARY_LABEL}`);
});

test('FR24 — a citation that names a line points at the line the name is on', () => {
  const citations = citationsOf(glossaryRows(), RESOLVED_FILES);
  assert.ok(
    citations.length >= 4,
    `only ${citations.length} line-numbered citations of ${RESOLVED_FILES.join(' and ')} were parsed`,
  );

  assert.deepEqual(
    misplaced(citations, readLines),
    [],
    `a row of ${GLOSSARY_LABEL} sends the reader to the wrong line`,
  );
});

test('FR24 — the citation check bites on a line number that drifted', () => {
  const rows = parseRows(
    [
      '| superfície | hoje | vira | onde está hoje |',
      '|---|---|---|---|',
      '| api | `assinatura` | `signature` | `a/b.ts:1` |',
      '| api | `cabecalho` | `header` | `a/b.ts:1` |',
      '| api | `fim` | `tail` | `a/b.ts:1-3` |',
      '| api | `nada` | `absent` | `a/b.ts:1-3` |',
      '| api | `perdido` | `lost` | `a/c.ts:1` |',
      '| api | `sem_linha` | `no_line` | `a/b.ts` |',
    ].join('\n'),
  );
  const body = ['const header = 1;', "const signature = 'x';", 'const tail = 2;'];
  const citations = citationsOf(rows, ['a/b.ts', 'a/c.ts']);

  assert.equal(citations.length, 5, 'a citation with no line number is not this check’s business');

  const problems = misplaced(citations, (file) => (file === 'a/b.ts' ? body : null));
  assert.equal(problems.length, 3, `unexpected problems:\n${problems.join('\n')}`);
  assert.match(problems[0], /a\/b\.ts:1 does not write "signature"; it is on line 2$/);
  assert.match(problems[1], /a\/b\.ts:1-3 does not write "absent"; it is on no line of that file$/);
  assert.match(problems[2], /a\/c\.ts does not exist$/);
});

test('the checks bite on a glossary broken on purpose', () => {
  const broken = parseRows(
    [
      '| superfície | hoje | vira | onde está hoje |',
      '|---|---|---|---|',
      '| api | `trabalho` | `task` | `x.ts` |',
      '| api | `trabalho` | `chore` | `x.ts` |',
      '| api | `servico` | `chore` | `x.ts` |',
      '| events | `servico` | `service` | `x.ts` |',
      '',
      '| coluna | que não é | do glossário | nenhuma |',
      '|---|---|---|---|',
      '| api | `nada` | `nothing` | `x.ts` |',
    ].join('\n'),
  );

  assert.equal(broken.length, 4, 'a table that is not a glossary table has to be skipped whole');
  assert.ok(unmapped(broken).length > 0, 'the fixture list has to notice a missing term');
  assert.equal(repeated(broken).length, 1, '"trabalho" is listed twice on "api"');
  assert.equal(colliding(broken).length, 1, '"chore" is claimed twice on "api"');
  assert.equal(
    inconsistent(broken).length,
    2,
    '"trabalho" and "servico" are each translated two ways',
  );
  assert.equal(misusedEnglish(broken).length, 0, 'no row here claims an already-English name');
  assert.equal(
    misusedEnglish(parseRows('| superfície | a | b | c |\n|---|---|---|---|\n| api | `x` | `job` | `y` |'))
      .length,
    1,
    '"job" belongs to "trabalho" and to nothing else',
  );
});
