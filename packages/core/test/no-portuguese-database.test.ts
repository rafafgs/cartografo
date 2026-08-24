/**
 * D20 gate: no Portuguese of the schema survives in SQL (t229 FR10, t235 FR7).
 *
 * Sibling of `no-portuguese-wire.test.ts`, scoped to the database instead of to
 * the wire. The vocabulary is not re-declared here: `glossary-terms.ts` reads it
 * out of `docs/spec/glossario-wire.md` at run time and `migrate.test.ts` reads
 * the same list, so this sweep and the one over the built schema cannot drift.
 *
 * t229 renamed the NAMES and left every CHECK-constrained VALUE in Portuguese;
 * t235 finished the job by rewriting the migrations so the schema is born
 * English in both vocabularies. That is why the term set is now §4 **and** §1.6,
 * and why a quoted run inside a query is swept instead of blanked: `status =
 * 'pendente'` used to be a stored value this gate had to tolerate, and today it
 * is a query written against a column that cannot hold that word.
 *
 * ## What is swept, and what is masked
 *
 * The sweep looks ONLY at SQL. Most files it walks legitimately hold two
 * vocabularies at once — below the SQL is the schema, which is English; above it
 * are the repository's own TypeScript field names, which t229 FR4 and t235 FR5
 * deliberately did NOT move, because `routes/*.ts` read them and the routes were
 * outside both tickets' surface. So a Portuguese word is a violation in a SQL
 * position and nowhere else, and the masks below are that line:
 *
 * Which files still hold two vocabularies is shrinking. t286 collapsed them into
 * one for `job.ts`, `intake.ts`, `input-request.ts` and `session.ts`, and t289
 * did the same for `graphs.ts`, `skill.ts`, `proposals.ts`, `hooks.ts` and
 * `hook-secrets.ts`: those nine spell every field the way the column does, and
 * their `SELECT`s carry no alias at all —
 * `test/no-repository-alias-roundtrip.test.ts` is the gate that keeps it so.
 * What still reads the old way is `webhooks.ts`, `runners.ts`, `leases.ts`,
 * `engine-models.ts`, `credentials.ts` and `db/events.ts`, which one follow-up
 * ticket owns. Everything below is written for those six; it stays exactly as
 * correct when the last of them lands and the two vocabularies become one.
 *
 * - **Comments.** Prose about `trabalho` is documentation, not a query.
 * - **Everything that is not a SQL string literal.** An interface field, a map
 *   key, a property access — that is the layer FR5 keeps in Portuguese. A
 *   literal that is prose rather than SQL goes with them, which is what keeps a
 *   free-text `reason` naming a domain word out of the sweep: it matches none of
 *   {@link SQL_SHAPE}, so it is blanked whole.
 * - **`${…}` inside a template literal.** That is TypeScript spliced into SQL,
 *   not SQL; the constant it names is a literal of its own and is swept as one.
 * - **`AS <name>`.** The alias is the bridge the still-unconverted repositories
 *   are built on — a `SELECT title AS titulo` is precisely how a renamed column
 *   reaches an unrenamed TypeScript field without dragging `routes/`,
 *   `packages/runner` and `packages/tela` into one ticket. Masking it here is
 *   about the SQL position and says nothing about whether the alias should
 *   exist; that question belongs to the sweep named above.
 *
 * What is left after masking is a table, a column or a stored value this package
 * really does write into a query.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { databaseTerms, termHits, type Term } from './glossary-terms.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

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

/**
 * Blanks the two things a Portuguese word may still legitimately be inside SQL.
 *
 * The quoted run is NOT one of them any more (t235, FR7). Until this ticket the
 * schema held Portuguese values under English column names, so a run like
 * `status = 'pendente'` was the one Portuguese a query was allowed to write; now
 * the column's own `CHECK` spells `pending`, and a query that still says
 * `pendente` writes a value the database refuses.
 */
function maskInsideSql(body: string): string {
  return blankSubstitutions(body).replace(/\bAS\s+[A-Za-z_][A-Za-z0-9_]*/gi, blank);
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

/**
 * Every hit in one file's source, as `line: what`.
 *
 * @param source File contents.
 * @param terms The glossary's schema rows (§4 names, §1.6 values).
 * @returns One entry per Portuguese word still standing in a SQL position.
 */
export function databaseHits(source: string, terms: readonly Term[]): string[] {
  return termHits(sqlOnly(source), terms);
}

test('FR10 — every query speaks the English schema of glossario-wire.md §4 and §1.6', () => {
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
    `Portuguese still in a SQL position (D20, glossario-wire.md §4 and §1.6):\n${hits.join('\n')}`,
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
    // t235, FR7: a stored VALUE is a hit now, wherever the query writes one —
    // a comparison, an `INSERT … VALUES`, an `UPDATE … SET` or an `IN (…)`.
    'db.prepare("SELECT id FROM lease WHERE status = \'ativa\'");',
    'db.prepare("SELECT 1 FROM event WHERE entity_type = \'trabalho\' LIMIT 1");',
    "db.prepare(`INSERT INTO intake_draft (class, status) VALUES (?, 'pendente')`);",
    "db.prepare(\"UPDATE proposal SET status = 'rejeitada' WHERE id = ?\");",
    "db.prepare(\"SELECT id FROM input_request WHERE kind IN ('pergunta','aprovacao')\");",
  ];
  for (const source of caught) {
    assert.ok(
      databaseHits(source, terms).length > 0,
      `the sweep missed Portuguese in the SQL: ${source}`,
    );
  }
});

test('FR10 — the sweep does NOT bite on the boundaries D20 leaves in Portuguese', () => {
  const terms = databaseTerms();
  const allowed = [
    // The alias the unconverted repositories are built on: a renamed column
    // reaching a field that still spells itself the old way. Synthetic, and
    // deliberately so — what it pins is that a SQL alias is a masked position,
    // which holds whether or not any real file still writes one.
    "db.prepare('SELECT title AS titulo, current_node_id AS no_atual FROM job');",
    // A repository's own projection, in the same synthetic spelling.
    'export interface Job { titulo: string; no_atual: string; criado_em: string }',
    // A TypeScript object literal is not SQL, whatever it spells.
    "const LABELS = { job: 'trabalho', session: 'sessao' };",
    // A message that happens to name a domain word: prose, not a query.
    'blockJob(db, id, { reason: `aguardando resposta da pergunta ${id}` });',
    // A comment quoting the schema as it used to be.
    '// the old query said FROM evento, before D20 fourth child',
    '/* `trabalho` and `pergunta` are what migration 0003 called them. */',
    // Already-English SQL over the renamed schema, names and values alike.
    "db.prepare('SELECT COUNT(*) AS total FROM job WHERE execution_id = ?');",
    'db.prepare("SELECT id FROM lease WHERE status = \'active\'");',
    "db.prepare(\"UPDATE proposal SET status = 'rejected' WHERE id = ?\");",
  ];
  for (const source of allowed) {
    assert.deepEqual(
      databaseHits(source, terms),
      [],
      `the sweep flagged a D20 boundary: ${source}`,
    );
  }
});
