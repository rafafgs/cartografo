/**
 * Structural gate over the PT→EN wire glossary (t213, FR1-FR5).
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
 * The five child-ticket surfaces of D20, in D20's own order (FR4), plus one.
 *
 * `cost-lens` is not a child of t213: it arrived with t255, for the vocabulary
 * the cost surveyor puts on the wire (§5.5). It is a surface of its own rather
 * than another `routes-cli-report` row because the tag is what every gate
 * FILTERS on, and those keys are readable only by that package's gate — folding
 * them into §5's tag would point three other sweeps at names none of them can
 * see.
 */
const SURFACES = Object.freeze([
  'api',
  'events',
  'proposal-ops',
  'database',
  'routes-cli-report',
  'cost-lens',
]);

/** First header cell of a glossary table, normalized. */
const TABLE_MARKER = 'superficie';

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
