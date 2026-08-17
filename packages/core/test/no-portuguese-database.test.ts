/**
 * D20 gate: no Portuguese term of the DATABASE surface survives in SQL (t229, FR10).
 *
 * Sibling of `no-portuguese-wire.test.ts`, scoped to the surface the glossary
 * tags `database` (`docs/spec/glossario-wire.md` §4.1 tables, §4.2 columns)
 * instead of `api`. The vocabulary is not re-declared here: it is read out of the
 * glossary's own rows at run time, so a row added there is a term checked here on
 * the next run, and the two cannot drift.
 *
 * ## What is swept, and what is masked
 *
 * The sweep looks ONLY at SQL. Every file it walks legitimately holds two
 * vocabularies at once — below the SQL is the schema, which this ticket moves to
 * English; above it are the repository's own TypeScript field names, which it
 * deliberately does NOT move (FR4: `Job.titulo` stays, because `routes/*.ts`
 * reads it and the routes are outside this ticket's surface). So a Portuguese
 * name is a violation in a SQL identifier position and nowhere else, and the
 * masks below are that line:
 *
 * - **Comments.** Prose about `trabalho` is documentation, not a query.
 * - **Everything that is not a SQL string literal.** An interface field, a map
 *   key, a property access — that is the layer FR4 keeps in Portuguese.
 * - **`${…}` inside a template literal.** That is TypeScript spliced into SQL,
 *   not SQL; the constant it names is a literal of its own and is swept as one.
 * - **A quoted run INSIDE the SQL.** `status = 'pendente'` and
 *   `entity_type = 'trabalho'` are stored VALUES, and the founder's 2026-08-17
 *   decision keeps every CHECK-constrained value Portuguese: this ticket renames
 *   identifiers only.
 * - **`AS <name>`.** The alias is the bridge FR4 is built on — a `SELECT title AS
 *   titulo` is precisely how a renamed column reaches an unrenamed TypeScript
 *   field without dragging `routes/`, `packages/runner` and `packages/tela` into
 *   this ticket.
 *
 * What is left after masking is a table or a column this package really does
 * name in a query.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GLOSSARY = path.join(REPO_ROOT, 'docs', 'spec', 'glossario-wire.md');

/** The surface this ticket migrates, as the glossary tags it. */
const SURFACE = 'database';

/**
 * The files that speak SQL against the renamed schema.
 *
 * Every repository, the owner of the log, and the one raw query left outside
 * both (`routes/events.ts`, the stream's cursor). D1 is what keeps the list this
 * short: nothing in `packages/runner`, `packages/tela` or
 * `packages/topografo-custo` touches the database at all.
 */
function scannedFiles(): string[] {
  const repositories = path.join(PACKAGE_ROOT, 'src', 'repositories');
  return [
    ...readdirSync(repositories)
      .filter((entry) => entry.endsWith('.ts'))
      .map((entry) => path.join('src', 'repositories', entry))
      .sort(),
    path.join('src', 'db', 'events.ts'),
    path.join('src', 'routes', 'events.ts'),
  ];
}

/**
 * Is this string literal SQL?
 *
 * Not a parser, and it does not need to be: the package writes SQL as whole
 * statements (`SELECT … FROM …`), as clause fragments assembled into one
 * (`'execucao_id = ?'`, `'desativada_em IS NULL'`) and as bare column lists
 * spliced in through `${COLUMNS}`. All three shapes are here, and a literal that
 * matches none of them is prose, an error message or a stored value.
 */
const SQL_SHAPE: readonly RegExp[] = [
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|INTO|JOIN|WHERE|VALUES|SET|ORDER\s+BY|GROUP\s+BY|IS\s+(?:NOT\s+)?NULL)\b/i,
  /\bIN\s*\(/i,
  /\bAS\s+[A-Za-z_]/i,
  /[A-Za-z_][A-Za-z0-9_]*\s*=\s*[?@]/,
  /^\s*[A-Za-z_][A-Za-z0-9_.]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_.]*){2,}\s*$/,
];

function isSql(body: string): boolean {
  return SQL_SHAPE.some((shape) => shape.test(body));
}

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
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
      out = out.slice(0, index) + blank(out.slice(index, end)) + out.slice(end);
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const stop = out.indexOf('*/', index + 2);
      const end = stop === -1 ? out.length : stop + 2;
      out = out.slice(0, index) + blank(out.slice(index, end)) + out.slice(end);
      index = end;
      continue;
    }
    index += 1;
  }

  return out;
}

/**
 * Blanks every `${…}` of a template literal, braces balanced.
 *
 * What rides in one is TypeScript — `${COLUMNS}`, `${where}`, `${sql}` — and the
 * constant it names is a literal of its own, swept on its own turn. Counting
 * braces rather than stopping at the first `}` matters for the one substitution
 * in the package that nests them (`db/events.ts`'s type filter).
 */
function blankSubstitutions(body: string): string {
  const out = body.split('');
  let index = 0;

  while (index < body.length - 1) {
    if (body[index] !== '$' || body[index + 1] !== '{') {
      index += 1;
      continue;
    }
    let depth = 0;
    let cursor = index + 1;
    for (; cursor < body.length; cursor += 1) {
      if (body[cursor] === '{') depth += 1;
      else if (body[cursor] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const end = cursor === body.length ? body.length : cursor + 1;
    for (let position = index; position < end; position += 1) {
      if (out[position] !== '\n') out[position] = ' ';
    }
    index = end;
  }

  return out.join('');
}

/** Blanks the three things a Portuguese word may still legitimately be inside SQL. */
function maskInsideSql(body: string): string {
  return blankSubstitutions(body)
    .replace(/'[^'\n]*'/g, blank)
    .replace(/"[^"\n]*"/g, blank)
    .replace(/\bAS\s+[A-Za-z_][A-Za-z0-9_]*/gi, blank);
}

/**
 * The whole masking chain: everything that is not SQL goes blank.
 *
 * The result keeps the source's length and its newlines, so a hit's line number
 * is the line number of the file.
 */
export function sqlOnly(source: string): string {
  const code = maskComments(source);
  const out: string[] = code.split('').map((char) => (char === '\n' ? '\n' : ' '));
  let index = 0;

  while (index < code.length) {
    const char = code[index];
    if (char !== "'" && char !== '"' && char !== '`') {
      index += 1;
      continue;
    }

    const end = endOfString(code, index);
    const body = end - 1 > index ? code.slice(index + 1, end - 1) : '';
    if (isSql(body)) {
      const masked = maskInsideSql(body);
      for (let position = 0; position < masked.length; position += 1) {
        out[index + 1 + position] = masked[position];
      }
    }
    index = end;
  }

  return out.join('');
}

/** A term of the glossary's database surface, with what it has to become. */
interface Term {
  term: string;
  english: string;
}

/**
 * Every Portuguese name the glossary maps on the `database` surface.
 *
 * Rows whose replacement equals the term itself are dropped: they exist to say
 * "this name does not change" (`runner`, `lease`, `skill`), and scanning for
 * them would fail a file for spelling a table correctly. A QUALIFIED row
 * (`evento.tipo`) names the table only to disambiguate which `tipo` is meant —
 * what a SQL identifier position actually spells is the column, so the term is
 * the part after the dot, and the three of them collapse into one entry that
 * lists all three English names.
 */
function databaseTerms(): Term[] {
  assert.ok(existsSync(GLOSSARY), `${GLOSSARY} does not exist`);
  const byTerm = new Map<string, string[]>();

  for (const line of readFileSync(GLOSSARY, 'utf8').split('\n')) {
    const cells = line.trim();
    if (!cells.startsWith('|')) continue;
    const parts = cells.slice(1).split('|').map((cell) => cell.replace(/`/g, '').trim());
    if (parts[0] !== SURFACE) continue;

    const english = parts[2] ?? '';
    for (const spelling of (parts[1] ?? '').split(' / ')) {
      const term = spelling.includes('.') ? spelling.split('.').pop()!.trim() : spelling.trim();
      if (term === '' || term === english) continue;
      const known = byTerm.get(term) ?? [];
      if (!known.includes(english)) known.push(english);
      byTerm.set(term, known);
    }
  }

  const terms = [...byTerm].map(([term, englishes]) => ({ term, english: englishes.join(' / ') }));
  assert.ok(
    terms.length > 80,
    `the glossary's "${SURFACE}" surface parsed to only ${terms.length} terms`,
  );
  return terms;
}

/**
 * Every hit in one file's source, as `line: what`.
 *
 * @param source File contents.
 * @param terms The glossary's `database` rows.
 * @returns One entry per Portuguese name still standing in a SQL identifier
 *   position.
 */
export function databaseHits(source: string, terms: readonly Term[]): string[] {
  const lines = sqlOnly(source).split('\n');
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

test('FR10 — every query speaks the English schema of glossario-wire.md §4', () => {
  const terms = databaseTerms();
  const files = scannedFiles();
  assert.ok(files.length > 10, `the sweep found only ${files.length} files; it is not walking src/`);

  const hits = files.flatMap((relative) =>
    databaseHits(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'), terms).map(
      (hit) => `${relative}:${hit}`,
    ),
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese still in a SQL identifier position (D20, glossario-wire.md §4):\n${hits.join('\n')}`,
  );
});

test('FR10 — the sweep bites on Portuguese that really is in the SQL', () => {
  const terms = databaseTerms();
  const caught = [
    "db.prepare('SELECT id, titulo FROM trabalho WHERE id = ?');",
    "db.prepare('INSERT INTO evento (tipo, projeto_id) VALUES (?, ?)');",
    "db.prepare('UPDATE pergunta SET status = ?, respondida_em = ? WHERE id = ?');",
    "db.prepare('SELECT valor FROM segredo_gancho WHERE nome = ?');",
    "conditions.push('execucao_id = ?');",
    "conditions.push('desativada_em IS NULL');",
    "const COLUMNS = 'id, projeto_id, titulo, no_atual, criado_em';",
    "conditions.push(`tipo IN (${filter.tipos.map((_, i) => `@t_${i}`).join(', ')})`);",
  ];
  for (const source of caught) {
    assert.ok(
      databaseHits(source, terms).length > 0,
      `the sweep missed a Portuguese name in the SQL: ${source}`,
    );
  }
});

test('FR10 — the sweep does NOT bite on the boundaries D20 leaves in Portuguese', () => {
  const terms = databaseTerms();
  const allowed = [
    // Stored values: the founder's 2026-08-17 decision is identifiers only.
    'db.prepare("SELECT id FROM lease WHERE status = \'ativa\'");',
    'db.prepare("SELECT 1 FROM event WHERE entity_type = \'trabalho\' LIMIT 1");',
    // The alias FR4 is built on: a renamed column reaching an unrenamed field.
    "db.prepare('SELECT title AS titulo, current_node_id AS no_atual FROM job');",
    // The row ↔ wire translation maps, which are TypeScript and not SQL.
    "const ENTITY_COLUMN = { job: 'trabalho', session: 'sessao' };",
    // The repository's own projection, which FR4 deliberately does not rename.
    'export interface Job { titulo: string; no_atual: string; criado_em: string }',
    // A message that happens to name a domain word.
    'blockJob(db, id, { reason: `aguardando resposta da pergunta ${id}` });',
    // A comment quoting the schema as it used to be.
    '// the old query said FROM evento, before D20 fourth child',
    '/* `trabalho` and `pergunta` are what migration 0003 called them. */',
    // Already-English SQL over the renamed schema.
    "db.prepare('SELECT COUNT(*) AS total FROM job WHERE execution_id = ?');",
  ];
  for (const source of allowed) {
    assert.deepEqual(
      databaseHits(source, terms),
      [],
      `the sweep flagged a D20 boundary: ${source}`,
    );
  }
});
