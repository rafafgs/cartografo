/**
 * D20 gate: the job cluster's repositories no longer translate (t286, AC1/AC2).
 *
 * The fourth and fifth children of D20 (t229, t235) renamed the TABLE and the
 * values it stores, and left the TypeScript projections spelled the old way,
 * because `routes/*.ts` read them and the routes were outside those tickets'
 * surface. Two pieces of machinery held the two halves together: a `SELECT`
 * that aliased every renamed column back onto its old field name, and a
 * `toWire*` function that translated the same field forward again on its way to
 * `/v1`. A name went English, then Portuguese, then English again, and the
 * middle step was visible from nowhere.
 *
 * This ticket deletes that round trip for the four import-closed files of the
 * job cluster, and this is the sweep that keeps it deleted.
 *
 * ## What the first test actually asserts, and why not the bare count
 *
 * The ticket's AC1 is written as "`grep -oE '\bAS [a-z_]+'` over the four files
 * returns nothing". Taken literally that is not reachable, and the ticket says
 * so in its own Out of Scope section without noticing the contradiction: it
 * exempts `db/connection.ts`'s `SELECT 1 AS one` and `routes/events.ts`'s
 * `SELECT MAX(id) AS last_id` as "legitimate English aliases naming an
 * anonymous column". The four files here hold twelve of exactly that species —
 * `COUNT(*)`, `COALESCE(SUM(…), 0)`, a correlated `SELECT`, and the
 * `finished_at` subquery — and SQLite gives an unaliased expression a column
 * name made of its own source text. There is no way to drop those aliases; there
 * is only a way to spell them in English.
 *
 * So the rule this sweep enforces is the one the ticket's Goal states rather
 * than the one its checkbox counts: **no alias may RENAME a column.** An alias
 * whose left-hand side is a bare column reference is a translation and is
 * forbidden; an alias whose left-hand side closes a `)` or a `${…}` is naming an
 * expression that has no name of its own, and is allowed. That distinction is
 * mechanical, it is what "the round trip is gone" actually means, and it does
 * not go soft the day somebody adds a legitimate aggregate.
 *
 * The second test pins the residue by name, so the exemption cannot quietly
 * grow: those twelve aliases are listed here, in English, and a thirteenth
 * fails the run until somebody writes it down.
 *
 * ## Scope
 *
 * The alias rule is per-cluster: this ticket owns `job.ts`, `intake.ts`,
 * `input-request.ts` and `session.ts`, and the other ten repositories keep their
 * aliases until the two follow-up tickets land. The `toWire`/`fromWire` rule is
 * already repo-wide, and not by accident — every one of the 54 occurrences that
 * existed before this ticket lived in these four files and the five route files
 * that consume them, so deleting the cluster's translation deletes the whole
 * category at once.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/**
 * The import-closed cluster this ticket owns, relative to `packages/core`.
 *
 * `job.ts` is the hub — `intake.ts`, `input-request.ts` and `session.ts` all
 * import it — which is why the four move together and why the other ten
 * repositories could not be split off one file at a time.
 */
const CLUSTER = Object.freeze([
  'src/repositories/job.ts',
  'src/repositories/intake.ts',
  'src/repositories/input-request.ts',
  'src/repositories/session.ts',
]);

/**
 * Every alias these four files are still allowed to write, and what it names.
 *
 * All twelve name an anonymous SQL expression: an aggregate, a correlated
 * subquery, or the `finished_at` scalar subquery `finishedAtOf` builds. None of
 * them renames a column, and all of them are English — which is the whole
 * exemption, stated as a list instead of as a habit.
 */
const EXPRESSION_ALIASES = Object.freeze({
  'src/repositories/job.ts': Object.freeze([
    // metricsByVersion (FR17)
    'jobs',
    'events',
    // listExecutions / getExecution (t107 FR1, t245 FR7)
    'jobs',
    'blocked_jobs',
    'pending_input_requests',
    'finished_at',
    'jobs',
    'blocked_jobs',
    'pending_input_requests',
    'finished_at',
  ]),
  'src/repositories/intake.ts': Object.freeze([]),
  'src/repositories/input-request.ts': Object.freeze([
    // questionsByNode (t167)
    'input_requests',
  ]),
  'src/repositories/session.ts': Object.freeze([]),
});

/**
 * Blanks every comment, keeping the file's shape.
 *
 * The same pass `no-portuguese-database.test.ts` runs and for the same reason:
 * prose about an alias is documentation, not a query, and this very file's
 * header would otherwise fail the sweep it defines. Copied rather than imported
 * because that module masks `AS <name>` on its way out — it is looking for what
 * survives the alias, and this one is looking at the alias itself.
 *
 * @param source File contents.
 * @returns The same text, same length, with comment spans blanked.
 */
function maskComments(source: string): string {
  const out = source.split('');
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "'" || char === '"' || char === '`') {
      // Skip the literal whole: a quote inside it never opens a comment.
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === char) break;
        if (source[index] === '\n' && char !== '`') break;
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === '/' && (next === '/' || next === '*')) {
      const stop = next === '/' ? source.indexOf('\n', index) : source.indexOf('*/', index + 2);
      const end = stop === -1 ? source.length : next === '/' ? stop : stop + 2;
      for (let position = index; position < end; position += 1) {
        if (out[position] !== '\n') out[position] = ' ';
      }
      index = end;
      continue;
    }

    index += 1;
  }

  return out.join('');
}

/** One alias found in a file: what it is called, and what it was applied to. */
interface Alias {
  line: number;
  name: string;
  /** Whether the left-hand side is an expression rather than a column. */
  expression: boolean;
}

/**
 * Every `AS <name>` a file writes, classified.
 *
 * The alias is matched lowercase, exactly as the ticket's own grep writes it —
 * which is also what keeps `CAST(x AS TEXT)` out of the result without a special
 * case, since a SQLite type name is uppercase in every query this package holds.
 *
 * The classification is the character that closes the left-hand side. A `)`
 * ends an aggregate or a subquery and a `}` ends a `${…}` substitution — both
 * are expressions with no name of their own. Anything else is the tail of a
 * column reference, which means the alias is renaming a column.
 *
 * @param source File contents, comments already masked.
 * @returns One entry per alias, in source order.
 */
export function aliasesIn(source: string): Alias[] {
  const found: Alias[] = [];
  const pattern = /\bAS\s+([a-z_][a-z0-9_]*)/g;

  let match = pattern.exec(source);
  while (match !== null) {
    const before = source.slice(0, match.index).trimEnd();
    const closer = before[before.length - 1];
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      name: match[1],
      expression: closer === ')' || closer === '}',
    });
    match = pattern.exec(source);
  }

  return found;
}

/** Reads one file of the package, by its path relative to `packages/core`. */
function read(relative: string): string {
  return maskComments(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'));
}

test('AC1 — no SELECT in the job cluster renames a column onto another spelling', () => {
  const offenders = CLUSTER.flatMap((relative) =>
    aliasesIn(read(relative))
      .filter((alias) => !alias.expression)
      .map((alias) => `${relative}:${alias.line} — AS ${alias.name}`),
  );

  assert.deepEqual(
    offenders,
    [],
    'a column is being read back under a second name; the projection is supposed to ' +
      `carry the column's own name now (D20, t286 FR3-FR6):\n${offenders.join('\n')}`,
  );
});

test('AC1 — the aliases that survive are the listed anonymous-expression ones', () => {
  for (const relative of CLUSTER) {
    const surviving = aliasesIn(read(relative)).map((alias) => alias.name);
    assert.deepEqual(
      surviving,
      [...EXPRESSION_ALIASES[relative as keyof typeof EXPRESSION_ALIASES]],
      `${relative} writes an alias this sweep does not know about; an aggregate or a ` +
        'subquery may be named, but the name goes on the list above first',
    );
  }
});

/** Whether the path exists and is a directory. */
function existsDirectory(absolute: string): boolean {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/** Every `.ts` file under `packages/<name>/src`, relative to the repository root. */
function packageSources(): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute)) {
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.endsWith('.ts')) found.push(path.relative(REPO_ROOT, child));
    }
  };

  const packages = path.join(REPO_ROOT, 'packages');
  for (const entry of readdirSync(packages).sort()) {
    const source = path.join(packages, entry, 'src');
    if (existsDirectory(source)) walk(source);
  }
  return found.sort();
}

test('AC2 — no source file in any package mentions toWire or fromWire', () => {
  const files = packageSources();
  assert.ok(files.length > 50, `the sweep found only ${files.length} files; it is not walking src/`);

  const hits = files.flatMap((relative) => {
    const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    return source
      .split('\n')
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter((entry) => /toWire|fromWire/.test(entry.text))
      .map((entry) => `${relative}:${entry.line}`);
  });

  assert.deepEqual(
    hits,
    [],
    'the row -> wire translation is supposed to be gone everywhere, not moved ' +
      `(t286 AC2):\n${hits.join('\n')}`,
  );
});

test('AC1 — the sweep tells a renamed column from a named expression', () => {
  const renames = [
    'const COLUMNS = `id, project_id AS projeto_id, title AS titulo`;',
    "db.prepare('SELECT current_node_id AS no_atual FROM job');",
    // A self-alias renames nothing, and is still an alias nobody needs.
    "db.prepare('SELECT j.graph_version_id AS graph_version_id FROM job j');",
  ];
  for (const source of renames) {
    const [alias] = aliasesIn(source);
    assert.ok(alias !== undefined, `the sweep saw no alias at all in: ${source}`);
    assert.equal(alias.expression, false, `the sweep read a column rename as an expression: ${source}`);
  }

  const expressions = [
    "db.prepare('SELECT COUNT(*) AS jobs FROM job');",
    "db.prepare('SELECT COALESCE(SUM(t.blocked), 0) AS blocked_jobs FROM job t');",
    'db.prepare(`SELECT ${finishedAtOf("t.execution_id")} AS finished_at FROM job t`);',
  ];
  for (const source of expressions) {
    const [alias] = aliasesIn(source);
    assert.ok(alias !== undefined, `the sweep saw no alias at all in: ${source}`);
    assert.equal(alias.expression, true, `the sweep read a named expression as a rename: ${source}`);
  }

  // `CAST(… AS TEXT)` is not an alias, and the lowercase match is what says so.
  assert.deepEqual(aliasesIn("db.prepare('SELECT CAST(t.id AS TEXT) FROM job t');"), []);

  // Prose about an alias is documentation; only the query counts.
  assert.deepEqual(aliasesIn(maskComments('// every SELECT does title AS titulo\n')), []);
});
