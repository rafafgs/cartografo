/**
 * D20 gate: no Portuguese term of the API surface survives on the wire (t226, FR9).
 *
 * The glossary's own placeholder for this file (`docs/spec/glossario-wire.md`,
 * "O que este glossário não decide") says the wire gate arrives "when there is
 * already an English wire to check". t226 is the ticket that built it, scoped to
 * exactly the surface it migrates (`api`), and each child since has widened it
 * to its own surface as that surface turned English.
 *
 * t230 (D20's fifth child) adds the second scan below: the graph validation
 * report, `superfície = routes-cli-report` in §5.3/5.4, over the three files of
 * this package that write or read it. It is the same machinery pointed at
 * another set of rows — a surface is a filter over the glossary here, never a
 * second gate.
 *
 * Complement, not substitute, of `no-portuguese-identifiers.test.ts`: that one
 * guards IDENTIFIERS and deliberately masks key and string positions — which is
 * exactly the value on the wire, and exactly what this file scans instead.
 *
 * The vocabulary is not re-declared here. It is read out of the glossary's
 * `superfície = api` rows at run time, so a row added there is a term checked
 * here on the next run, and the two cannot drift.
 *
 * ## What is masked, and why each one is a boundary and not a loophole
 *
 * A route file sits between two vocabularies. Below it the database still spells
 * everything in Portuguese (child 4 of D20 renames it, not this ticket); above
 * it the wire is English from this ticket on. So the same file legitimately
 * contains both, and the masks below are the line between them:
 *
 * - **Comments.** Prose about `grafo_versao` is documentation, not payload.
 * - **SQL literals.** A `FROM evento` is child 4's surface, untouched here.
 * - **Comparison operands.** `lease.status !== 'ativa'` reads a ROW value; FR1
 *   is explicit that internal route logic keeps comparing the Portuguese values
 *   and that only the boundary translates.
 * - **The KEYS of an object literal handed to the repository layer.** What a
 *   route passes to `grantLease` or `createDraft` is that layer's input shape,
 *   and it mirrors the untouched columns (FR2 translates EN→PT *before* calling
 *   it). Only the keys go blank, never the values: the value half of
 *   `{ projeto_id: integerFromQuery('project_id', …) }` still names a QUERY
 *   PARAMETER, and masking it would hide exactly what FR2 renames.
 * - **Object literals typed by an imported domain/repository type**, keys and
 *   values alike. A `const document: GraphDocument = {…}` is the graph document
 *   format (`schema/grafo.schema.json`), which is nobody's surface in D20, and
 *   its `lineage.type: 'variante'` is that format's value and not this API's.
 *
 * The validation report used to be masked here too, as another surface's
 * vocabulary riding inside a `/v1` 422. t230 renamed it, so the mask went with
 * it: a `mensagem` inside a `structure` object is now exactly as wrong as one
 * anywhere else, and the api sweep says so without a special case.
 *
 * The intake item followed in t255, from the other direction: it was never
 * masked, it was simply out of reach, because `DraftItem` is declared one layer
 * in (`domain/intake.ts`) and the route only ever spreads it. Sweeping that one
 * domain module (see {@link WIRE_DOMAIN}) is what closes the gap — the body of
 * `POST /v1/intake` is as much this API's JSON as the envelope around it.
 *
 * What is left after masking is a key or a value this API actually publishes.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');

/** The surface t226 migrated, as the glossary tags it. */
const SURFACE = 'api';

/**
 * The surface t230 migrated: screen routes, CLI flags and the report.
 *
 * Only the report half of it lands in this package. The routes are the screen's
 * and the flags are the runner's and the cost lens's, each policed by that
 * package's own port of this file — the same way `no-portuguese-identifiers`
 * is ported four times instead of reaching across package boundaries.
 */
const REPORT_SURFACE = 'routes-cli-report';

/**
 * The three files of this package that write or read the validation report.
 *
 * `domain/graph.ts` produces it, `routes/graphs.ts` hand-builds one literal of
 * it around the `problem_class` check, and `cli/import.ts` reads it twice — once
 * off `validateGraph` for a local bundle, once off the control plane's 422.
 * `routes/proposals.ts` only spreads what `validateGraph` returned, so it has no
 * report vocabulary of its own to police; the api sweep above covers it anyway.
 */
const REPORT_FILES = [
  path.join('src', 'domain', 'graph.ts'),
  path.join('src', 'routes', 'graphs.ts'),
  path.join('src', 'cli', 'import.ts'),
];

/**
 * `GET /health` is not `/v1`, and this ticket's Goal is the `/v1` surface.
 *
 * It sits outside the business API on purpose (`routes/health.ts`), it is not in
 * t226's Code Changes table, and its two values (`ok`/`erro`) are the probe's
 * contract, pinned byte for byte by `test/health.test.ts`. Renaming a
 * supervisor-facing payload is a decision with its own blast radius; whoever
 * takes it takes it deliberately, in the docs-and-gate child of D20.
 */
const OUTSIDE_V1 = ['health.ts'];

/**
 * Domain modules that publish a body of their own, and are swept as routes.
 *
 * `domain/intake.ts` is the whole list today (t255). It is not a route file, and
 * it is here for `auth.ts`'s reason squared: `DraftItem` IS the body of
 * `POST /v1/intake` and `ItemProblem[]` IS the body of that route's 400, so the
 * route file the sweep already walks contains barely a word of the vocabulary it
 * publishes. Until t255 those keys were declared an exemption in three comments;
 * D20's own text — "campos e parâmetros de query do JSON da API" — never granted
 * one, and the exemption is gone along with the Portuguese.
 */
const WIRE_DOMAIN = [path.join('src', 'domain', 'intake.ts')];

/**
 * Files that publish the wire: every `/v1` route, plus the credential gate.
 *
 * `auth.ts` is not a route file and is swept anyway, because it answers three
 * refusal bodies of its own on every `/v1` request — the three the glossary
 * gained a row for under FR6. A gate that skipped it would leave the only
 * refusal EVERY client can receive outside the only sweep that checks refusals.
 */
function scannedFiles(): string[] {
  const routes = path.join(PACKAGE_ROOT, 'src', 'routes');
  return [
    ...readdirSync(routes)
      .filter((entry) => entry.endsWith('.ts') && !OUTSIDE_V1.includes(entry))
      .map((entry) => path.join('src', 'routes', entry))
      .sort(),
    path.join('src', 'auth.ts'),
    ...WIRE_DOMAIN,
  ];
}

/**
 * The frozen hypothesis vocabulary, and the ONE file allowed to spell it.
 *
 * `domain/hypothesis.ts` documents `{nome, direcao, de, para}` and `{veredito,
 * antes, depois, execucao_id, avaliado_em}` as a data format D18 left out of the
 * English rule; the glossary maps none of it, and D20's list of what it unfreezes
 * does not mention it either. t226's FR5 therefore keeps the whole outcome flow
 * as one unit — `POST /proposals/:id/outcome`'s body, `?veredito=`, and the
 * refusal that echoes back the field it just read.
 *
 * Scoped to the file AND to the terms, deliberately: `routes/proposals.ts`
 * spelling any OTHER glossary term still fails this sweep, and any other file
 * spelling `execucao_id` still fails it too. A blanket exemption for the word
 * would be a hole; this is a door with one key.
 */
const FROZEN_HYPOTHESIS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'proposals.ts': ['execucao_id', 'depois', 'veredito', 'antes', 'avaliado_em'],
});

/** Modules whose exported names are the layer BELOW the wire. */
const LOWER_LAYERS = ['../repositories/', '../domain/', '../db/', './repositories/', './db/'];

/**
 * Domain types that are NOT below the wire: they are the wire.
 *
 * `maskLowerLayerLiterals` blanks a literal annotated with an imported domain
 * type, because a `const document: GraphDocument = {…}` is the graph document
 * format and nobody's D20 surface. The validation report is imported from the
 * same module and is the exact opposite — `routes/graphs.ts` hand-builds one
 * `StructureReport` literal that goes straight out in a 422 — so it is taken
 * out of that mask, or the sweep would skip the one thing it exists to check.
 */
const WIRE_TYPES = ['StructureReport', 'SoundnessReport', 'GraphReport'];

/** Rough test for "this string literal is SQL", not a parser. */
const SQL = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/i;

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** Blanks `[start, end)` of `source`, keeping its length and its newlines. */
function blankRange(source: string, start: number, end: number): string {
  return source.slice(0, start) + blank(source.slice(start, end)) + source.slice(end);
}

/**
 * Index just past the delimiter that closes the one opened at `open`.
 *
 * Quote-aware, because a `{` inside a string is not a brace. Returns the end of
 * the source when nothing closes it — a truncated file masks to its end rather
 * than throwing, which keeps a parse accident from reading as a clean sweep.
 */
function matchDelimiter(source: string, open: number): number {
  const opener = source[open];
  const closer = opener === '{' ? '}' : ')';
  let depth = 0;

  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      index = endOfString(source, index) - 1;
      continue;
    }
    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/** Index just past the string literal that starts at `start`. */
function endOfString(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === '\n' && quote !== '`') return index;
  }
  return source.length;
}

/** Blanks every comment, keeping the file's shape. */
function maskComments(source: string): string {
  let out = source;
  let index = 0;

  while (index < out.length) {
    const char = out[index];
    const next = out[index + 1];

    if (char === "'" || char === '"' || char === '`') {
      index = endOfString(out, index);
      continue;
    }
    if (char === '/' && next === '/') {
      const stop = out.indexOf('\n', index);
      const end = stop === -1 ? out.length : stop;
      out = blankRange(out, index, end);
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const stop = out.indexOf('*/', index + 2);
      const end = stop === -1 ? out.length : stop + 2;
      out = blankRange(out, index, end);
      index = end;
      continue;
    }
    index += 1;
  }

  return out;
}

/** Every name this file imports from a module of the layer below the wire. */
function lowerLayerNames(source: string): string[] {
  const names: string[] = [];
  const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;

  for (const match of source.matchAll(importPattern)) {
    if (!LOWER_LAYERS.some((prefix) => match[2].startsWith(prefix))) continue;
    for (const specifier of match[1].split(',')) {
      const name = specifier.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== '') names.push(name);
    }
  }

  return names;
}

/** Blanks every object-literal KEY inside the argument list of a lower-layer call. */
function maskLowerLayerArguments(source: string, names: readonly string[]): string {
  let out = source;

  for (const name of names) {
    const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (const match of [...out.matchAll(call)]) {
      const open = match.index + match[0].length - 1;
      const close = matchDelimiter(out, open);
      // Keys only. The VALUE half of `{ projeto_id: integerFromQuery('x', …) }`
      // is assembled out of the wire and still names query parameters, so it
      // stays in the sweep; the key is the repository's column shape.
      const masked = out
        .slice(open, close)
        .replace(/[A-Za-z_][A-Za-z0-9_]*\s*\??\s*:/g, (key) => blank(key));
      out = out.slice(0, open) + masked + out.slice(close);
    }
  }

  return out;
}

/**
 * Blanks object literals annotated with a type of the layer below the wire.
 *
 * Keys AND values, unlike a call argument: this is a whole foreign document, and
 * `lineage: { type: 'variante' }` inside a `GraphDocument` is that format's
 * value — `schema/grafo.schema.json`, which no D20 child renames.
 */
function maskLowerLayerLiterals(source: string, names: readonly string[]): string {
  let out = source;

  for (const name of names) {
    const annotated = new RegExp(`:\\s*${name}(?:\\[\\])?\\s*=\\s*\\{`, 'g');
    for (const match of [...out.matchAll(annotated)]) {
      const open = match.index + match[0].length - 1;
      const end = matchDelimiter(out, open);
      out = blankRange(out, open + 1, end - 1);
    }
  }

  return out;
}

/** Blanks SQL literals and the operands of a comparison (row values, FR1). */
function maskRowValues(source: string): string {
  let out = source;
  let index = 0;

  while (index < out.length) {
    const char = out[index];
    if (char !== "'" && char !== '"' && char !== '`') {
      index += 1;
      continue;
    }

    const end = endOfString(out, index);
    const literal = out.slice(index + 1, end - 1);
    const before = out.slice(Math.max(0, index - 40), index);
    const isComparison = /(===|!==|==|!=)\s*$/.test(before);

    if (SQL.test(literal) || isComparison) out = blankRange(out, index + 1, end - 1);
    index = end;
  }

  return out;
}

/** The whole masking chain, in the order the stages depend on each other. */
export function maskWireSource(source: string): string {
  const withoutComments = maskComments(source);
  const names = lowerLayerNames(withoutComments);
  const formats = names.filter((name) => !WIRE_TYPES.includes(name));
  return maskRowValues(
    maskLowerLayerLiterals(maskLowerLayerArguments(withoutComments, names), formats),
  );
}

/** A term of the glossary, with where it is written down. */
interface Term {
  term: string;
  english: string;
  line: number;
}

/**
 * Every Portuguese term the glossary maps on one surface.
 *
 * Rows whose replacement equals the term itself are dropped: they exist to say
 * "this name does not change" (`runner`, `/runners`, `soundness`), and scanning
 * for them would fail a file for spelling a word correctly. A qualified row
 * (`pergunta.tipo=pergunta`) contributes the VALUE, which is what travels.
 *
 * @param surface The `superfície` cell to filter on.
 * @param minimum Fewest rows the surface must parse to; a parser that quietly
 *   stopped matching the table would otherwise read as a clean sweep.
 */
function termsFor(surface: string, minimum: number): Term[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY} does not exist`);
  const terms: Term[] = [];

  readFileSync(GLOSSARY, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const cells = line.trim();
      if (!cells.startsWith('|')) return;
      const parts = cells.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
      if (parts[0] !== surface) return;

      const english = parts[2] ?? '';
      for (const spelling of (parts[1] ?? '').split(' / ')) {
        const term = spelling.includes('=') ? spelling.split('=').pop()!.trim() : spelling.trim();
        if (term === '' || term === english) continue;
        terms.push({ term, english, line: index + 1 });
      }
    });

  assert.ok(
    terms.length >= minimum,
    `the glossary's "${surface}" surface parsed to only ${terms.length} terms`,
  );
  return terms;
}

/** The `api` rows, which are what the first sweep below scans for. */
function apiTerms(): Term[] {
  return termsFor(SURFACE, 51);
}

/**
 * The `routes-cli-report` rows, minus the ones no file of this package can hold.
 *
 * A screen route and a CLI flag are other packages' surfaces; leaving them in
 * would cost nothing but would also claim a coverage this file does not have.
 */
function reportTerms(): Term[] {
  return termsFor(REPORT_SURFACE, 25).filter((entry) => !entry.term.startsWith('/') && !entry.term.startsWith('--'));
}

/**
 * Every hit of one term in already-masked source, as `line — what` records.
 *
 * @param masked Source with the boundaries above already blanked out.
 * @param entry The glossary row being looked for.
 * @param members Also count a MEMBER read (`report.estrutura`). Off for the api
 *   sweep, where a route legitimately reads a Portuguese column off a row it got
 *   from the repository layer; on for the report sweep, where the same member
 *   read IS the report's own vocabulary.
 */
function hitsFor(
  masked: string,
  entry: Term,
  members: boolean,
): Array<{ line: number; detail: string }> {
  const hits: Array<{ line: number; detail: string }> = [];
  // A key of an object literal or of an inline type, and a whole string
  // literal — the two shapes a Portuguese name still takes on the wire.
  const asKey = new RegExp(`(^|[{,(\\s])${entry.term}\\s*\\??\\s*:`);
  const asValue = new RegExp(`(['"\`])${entry.term}\\1`);
  const asMember = new RegExp(`\\.${entry.term}(?![A-Za-z0-9_])`);

  masked.split('\n').forEach((line, index) => {
    if (asKey.test(line)) {
      hits.push({ line: index + 1, detail: `key "${entry.term}" (glossary says "${entry.english}")` });
    }
    if (asValue.test(line)) {
      hits.push({ line: index + 1, detail: `value "${entry.term}" (glossary says "${entry.english}")` });
    }
    if (members && asMember.test(line)) {
      hits.push({ line: index + 1, detail: `read of ".${entry.term}" (glossary says "${entry.english}")` });
    }
  });

  return hits;
}

/**
 * Every hit in one file's source.
 *
 * @param source File contents.
 * @param terms The glossary rows to look for.
 * @param fileName Base name, used to look up the FR5 exemption; omitted in the
 *   unit cases below, which are not any file.
 * @param members Whether a member read counts as a hit; see {@link hitsFor}.
 * @returns One entry per hit, as `line: what`.
 */
export function wireHits(
  source: string,
  terms: readonly Term[],
  fileName = '',
  members = false,
): string[] {
  const masked = maskWireSource(source);
  const frozen = FROZEN_HYPOTHESIS[fileName] ?? [];
  return terms
    .filter((entry) => !frozen.includes(entry.term))
    .flatMap((entry) => hitsFor(masked, entry, members).map((hit) => `${hit.line}: ${hit.detail}`))
    .sort();
}

test('FR9 — every /v1 body speaks the English wire vocabulary of glossario-wire.md §1', () => {
  const terms = apiTerms();
  const files = scannedFiles();
  assert.ok(files.length > 10, `the sweep found only ${files.length} files; it is not walking the routes`);

  const hits = files.flatMap((relative) =>
    wireHits(
      readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'),
      terms,
      path.basename(relative),
    ).map((hit) => `${relative}:${hit}`),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese still on the wire (D20, glossario-wire.md §1):\n${hits.join('\n')}`,
  );
});

test('t255 — the intake item is swept like a route, and bites on its own old keys', () => {
  const terms = apiTerms();

  assert.ok(
    scannedFiles().includes(path.join('src', 'domain', 'intake.ts')),
    'the item the intake routes publish is not in the sweep',
  );

  // The pre-t255 `DraftItem` and `ItemProblem`, planted as source.
  const planted = [
    'export interface DraftItem { ref: string; titulo: string; corpo: string | null }',
    'export interface ItemProblem { codigo: string; mensagem: string; alvo: unknown }',
    "  criterios_de_aceite: string[] | null;",
    '  campos: Record<string, string> | null;',
    '  depende_de: string[];',
    "note({ codigo: PROBLEM_CODES.CYCLE, mensagem: 'x', alvo: cycle });",
    "export const PROBLEM_CODES = Object.freeze({ LIST: 'lista_invalida' });",
    "export const PROBLEM_CODES = Object.freeze({ CYCLE: 'ciclo_de_dependencia' });",
  ];
  for (const source of planted) {
    assert.ok(wireHits(source, terms).length > 0, `the sweep missed an intake wire name: ${source}`);
  }

  // And the English the same declarations take from t255 on.
  const renamed = [
    'export interface DraftItem { ref: string; title: string; body: string | null }',
    'export interface ItemProblem { code: string; message: string; target: unknown }',
    '  acceptance_criteria: string[] | null;',
    '  fields: Record<string, string> | null;',
    '  depends_on: string[];',
    "export const PROBLEM_CODES = Object.freeze({ LIST: 'invalid_list', CYCLE: 'dependency_cycle' });",
  ];
  for (const source of renamed) {
    assert.deepEqual(wireHits(source, terms), [], `the sweep flagged the English item: ${source}`);
  }
});

test('FR9 — the sweep bites on Portuguese that really is on the wire', () => {
  const terms = apiTerms();
  const caught = [
    "reply.code(422); return { erro: 'grafo_invalido' };",
    'return { trabalhos: listJobs(db) };',
    'return { grafo: graph, grafo_versao: version };',
    "return { lease: null, motivo: 'teto_runner' };",
    'const query = request.query as { execucao_id?: string };',
    "return { erro: 'credencial_ausente', mensagem: 'no token' };",
  ];
  for (const source of caught) {
    assert.ok(wireHits(source, terms).length > 0, `the sweep missed a Portuguese wire name: ${source}`);
  }
});

test('FR9 — the sweep does NOT bite on the boundaries D20 leaves in Portuguese', () => {
  const terms = apiTerms();
  const allowed = [
    // A row value compared inside the handler (FR1: only the boundary translates).
    "if (lease.status !== 'ativa') return conflict(reply);",
    "if (base.linhagem_tipo !== 'base' || draft.status !== 'pendente') return null;",
    // SQL, which is child 4's surface.
    "db.prepare('SELECT MAX(id) AS last_id FROM evento').get();",
    // The repository's own input shape, built by the route just before calling.
    [
      "import { grantLease } from '../repositories/leases.ts';",
      'const result = grantLease(db, { projeto_id: projectId, teto_runner: cap });',
    ].join('\n'),
    // A domain format nobody's D20 surface renames.
    [
      "import type { GraphDocument } from '../domain/graph.ts';",
      "const document: GraphDocument = { lineage: { type: 'variante' } };",
    ].join('\n'),
    // The structural report, riding inside a /v1 422 — English since t230, so
    // this line is a boundary only because there is nothing Portuguese left in it.
    "return { error: 'invalid_graph', structure: { errors: [{ message: 'x' }] } };",
    // English prose that merely contains a mapped word.
    'const message = `only a pending proposal can be approved`;',
    // A comment quoting the frozen vocabulary.
    '/** The `erro`/`mensagem` shape became `error`/`message` in t226. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(wireHits(source, terms), [], `the sweep flagged a D20 boundary: ${source}`);
  }
});

test('FR5 — the hypothesis exemption is scoped to its file and to its own words', () => {
  const terms = apiTerms();
  const outcome = "return refusal(reply, 422, 'x', undefined, { execucao_id: id });";

  assert.deepEqual(
    wireHits(outcome, terms, 'proposals.ts'),
    [],
    'the outcome flow keeps `execucao_id`, and the sweep has to let that one through',
  );
  assert.ok(
    wireHits(outcome, terms, 'jobs.ts').length > 0,
    'the same word anywhere else is still a hit: the exemption is a door, not a hole',
  );
  assert.ok(
    wireHits("return { propostas: rows };", terms, 'proposals.ts').length > 0,
    'and inside proposals.ts every OTHER glossary term is still swept',
  );
});

test('t230 — the graph validation report speaks the English of glossario-wire.md §5.3/5.4', () => {
  const terms = reportTerms();

  const hits = REPORT_FILES.flatMap((relative) =>
    wireHits(
      readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'),
      terms,
      path.basename(relative),
      true,
    ).map((hit) => `${relative}:${hit}`),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese still in the validation report (D20, glossario-wire.md §5):\n${hits.join('\n')}`,
  );
});

test('t230 — the report sweep bites on every shape the old vocabulary took', () => {
  const terms = reportTerms();
  const caught = [
    // The report's own type, and the literal that builds one.
    'export interface StructureError { codigo: string; mensagem: string; alvo: unknown }',
    "note('campo_invalido', '\"nodes\" has to be a list', 'nodes');",
    "violations.push({ regra: RULES.REACHABLE, alvo: id });",
    "return { valido: errors.length === 0, erros: errors };",
    // And every way of READING one back, which is what `cli/import.ts` does.
    'for (const error of report.estrutura.erros) print(error.codigo);',
    'for (const violation of soundness.violacoes) print(violation.regra);',
  ];
  for (const source of caught) {
    assert.ok(
      wireHits(source, terms, '', true).length > 0,
      `the report sweep missed a Portuguese report name: ${source}`,
    );
  }
});

test('t230 — the report sweep does NOT bite on what §5 leaves alone', () => {
  const terms = reportTerms();
  const allowed = [
    // `soundness` is a §5.3 row whose `hoje` equals its `vira`: it never moved.
    "return { valid: errors.length === 0, soundness: { valid: true, violations: [] } };",
    // The English report, whole.
    "note('invalid_field', '\"nodes\" has to be a list', 'nodes');",
    'for (const error of report.structure.errors) print(error.code, error.message);',
    // The document's own vocabulary, which is not this surface.
    "const document = { initial_node: 'redigir', final_nodes: ['revisar'] };",
    // A comment recalling the old spelling while explaining the rename.
    '/** `erros`/`violacoes` became `errors`/`violations` in t230. */',
  ];
  for (const source of allowed) {
    assert.deepEqual(
      wireHits(source, terms, '', true),
      [],
      `the report sweep flagged something §5 leaves alone: ${source}`,
    );
  }
});
