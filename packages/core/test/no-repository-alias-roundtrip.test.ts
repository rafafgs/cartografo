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
 * anonymous column". The four files here hold eleven of exactly that species —
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
 * grow: those eleven aliases are listed here, in English, and a twelfth fails
 * the run until somebody writes it down.
 *
 * ## Scope
 *
 * The alias rule grew one cluster at a time and this file is where it stopped
 * growing. t286 owned the job cluster — `job.ts`, `intake.ts`,
 * `input-request.ts` and `session.ts`; t289 added the second — `graphs.ts`,
 * `skill.ts`, `proposals.ts`, `hooks.ts` and `hook-secrets.ts`; and t290 adds
 * the third and last — `leases.ts`, `runners.ts`, `credentials.ts`,
 * `engine-models.ts`, `webhooks.ts` and `db/events.ts`. Nothing keeps its
 * aliases any more: the three lists below name every file in the package that
 * reads a renamed column, and the round trip D20 opened is closed.
 *
 * The count the three tickets were measured against: 181 column-renaming
 * aliases when t286 started, 44 of them in this last cluster, 0 now. What a
 * `grep -rEo '\bAS [a-z_]+'` over every package's source still answers with is
 * 24 — the ten anonymous expressions named below, plus fourteen outside the
 * clusters (`job.ts`'s and `input-request.ts`'s aggregates,
 * `db/connection.ts`'s `SELECT 1 AS one`, `routes/events.ts`'s
 * `MAX(id) AS last_id`, and one sentence in `packages/tela/src/router.ts` that
 * happens to say the word "AS" in prose).
 *
 * The `toWire`/`fromWire` rule is already repo-wide, and not by accident — every
 * one of the 54 occurrences that existed before t286 lived in the job cluster
 * and the five route files that consume it, so deleting that cluster's
 * translation deleted the whole category at once. The second cluster had none of
 * its own to delete: its five translators were named `toGraph`, `toGraphVersion`,
 * `toClass`, `toSkill`, `toProposal` and `toHookSecret` instead, same species
 * under different names, and the sweep below is what says they are gone.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/**
 * The import-closed cluster t286 owned, relative to `packages/core`.
 *
 * `job.ts` is the hub — `intake.ts`, `input-request.ts` and `session.ts` all
 * import it — which is why the four move together and why the other ten
 * repositories could not be split off one file at a time.
 */
const JOB_CLUSTER = Object.freeze([
  'src/repositories/job.ts',
  'src/repositories/intake.ts',
  'src/repositories/input-request.ts',
  'src/repositories/session.ts',
]);

/**
 * The second cluster, t289's, relative to `packages/core`.
 *
 * Grouped by what reads them rather than by what they import: `routes/graphs.ts`
 * and `routes/proposals.ts` each read three of the five, so the graph, the skill,
 * the proposal and the two hook repositories reach `/v1` through the same two
 * files and could not be renamed one at a time either.
 */
const GRAPH_CLUSTER = Object.freeze([
  'src/repositories/graphs.ts',
  'src/repositories/skill.ts',
  'src/repositories/proposals.ts',
  'src/repositories/hooks.ts',
  'src/repositories/hook-secrets.ts',
]);

/**
 * The third and last cluster, t290's, relative to `packages/core`.
 *
 * The one grouping that is not held together by an import or by a reader: it is
 * the remainder. Four of the six are the runner fleet — a lease is granted to a
 * runner, a runner is paired with a credential, and an engine catalogue is what
 * a runner reports on the way in — and the other two are the log and the
 * fan-out that reads it. They land in one ticket because this is the ticket that
 * owns the repo-wide zero, and a zero cannot be reached in halves.
 */
const LEASE_CLUSTER = Object.freeze([
  'src/repositories/leases.ts',
  'src/repositories/runners.ts',
  'src/repositories/credentials.ts',
  'src/repositories/engine-models.ts',
  'src/repositories/webhooks.ts',
  'src/db/events.ts',
]);

/**
 * Every alias these four files are still allowed to write, and what it names.
 *
 * All eleven name an anonymous SQL expression: an aggregate, a correlated
 * subquery, or the `finished_at` scalar subquery `finishedAtOf` builds. None of
 * them renames a column, and all of them are English — which is the whole
 * exemption, stated as a list instead of as a habit.
 */
const JOB_EXPRESSION_ALIASES = Object.freeze({
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
 * Every alias the second cluster is allowed to write: none, in all five files.
 *
 * Not an accident of how the rewrite went, and not a stricter rule than the job
 * cluster's — it is the same rule reaching a different total. All 51 aliases
 * these files carried before t289 renamed a column; not one of them named an
 * aggregate or a subquery, because none of these five repositories counts, sums
 * or correlates anything. So the list of legitimate survivors comes out empty,
 * and an empty list is a sharper gate than a populated one: the next `AS` written
 * here fails the run whatever it is called, and whoever writes it has to add the
 * name below and say what expression it names.
 *
 * Two of those 51 could not simply lose their alias, and became a mapping in
 * TypeScript instead — `graph.id` reaching the class catalogue as `graph_id`, and
 * `skill.source` reaching the manifest as `origin`. Both are places where the
 * COLUMN and the published field genuinely have different names, which an alias
 * would have hidden behind a rename this sweep forbids; see the two repositories
 * for why the wire could not move to meet them.
 */
const GRAPH_EXPRESSION_ALIASES = Object.freeze({
  'src/repositories/graphs.ts': Object.freeze([]),
  'src/repositories/skill.ts': Object.freeze([]),
  'src/repositories/proposals.ts': Object.freeze([]),
  'src/repositories/hooks.ts': Object.freeze([]),
  'src/repositories/hook-secrets.ts': Object.freeze([]),
});

/**
 * Every alias the third cluster is allowed to write: ten, in four of six files.
 *
 * The two empty entries are the sharper half of the list. `engine-models.ts`
 * counts nothing and correlates nothing, and neither does `db/events.ts` — the
 * log's only reads are a `WHERE` and an `ORDER BY` — so the next `AS` written in
 * either is a rename whatever it is called.
 *
 * The other four name an expression that has no name of its own. Two of them
 * did not survive the rewrite unchanged and are worth pointing at: the fleet
 * query's `COUNT(CASE …)` and `MAX(l.heartbeat_at)` used to be called
 * `leases_ativas` and `ultimo_heartbeat`, which made them look exactly like the
 * translations around them. They are not translations — there is no column
 * either one could be renaming — so they were spelled in English rather than
 * deleted, and `RunnerHealth` publishes them under the names they now carry.
 */
const LEASE_EXPRESSION_ALIASES = Object.freeze({
  'src/repositories/leases.ts': Object.freeze([
    // grantLease's two cap counts (t103, FR9)
    'total',
    'total',
  ]),
  'src/repositories/runners.ts': Object.freeze([
    // listRunnersWithHealth's fleet aggregates (t164, FR1)
    'active_leases',
    'last_heartbeat',
    // ... and the window that picks each runner's latest expired lease
    'recency',
  ]),
  'src/repositories/credentials.ts': Object.freeze([
    // hasLiveCredential asks whether a row comes back, never what is in it
    'one',
  ]),
  'src/repositories/engine-models.ts': Object.freeze([]),
  'src/repositories/webhooks.ts': Object.freeze([
    // createSubscription's anchor and fanoutCursor's resume point (t142, FR4)
    'last_id',
    'last_id',
    // dueDeliveries joins two tables that both have an `id` (t142, FR5)
    'delivery',
    'subscription',
  ]),
  'src/db/events.ts': Object.freeze([]),
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
  /** Whether the left-hand side is something OTHER than a column reference. */
  expression: boolean;
}

/**
 * Every `AS <name>` a file writes, classified.
 *
 * The alias is matched lowercase, exactly as the ticket's own grep writes it —
 * which is also what keeps `CAST(x AS TEXT)` out of the result without a special
 * case, since a SQLite type name is uppercase in every query this package holds.
 *
 * The classification asks one question — is the thing on the left a COLUMN? —
 * and there are four ways for the answer to be no, all four of them visible in
 * the character or the word that closes the left-hand side:
 *
 * - `)` ends an aggregate or a subquery, and `}` ends a `${…}` substitution.
 *   Both are expressions SQLite would otherwise name after their own source
 *   text, so the alias is the only name they have.
 * - A bare integer is the same case one character shorter: `SELECT 1 AS one`
 *   asks whether a row comes back, and `1` is not a column being renamed.
 * - `FROM x AS y` / `JOIN x AS y` renames a TABLE. That is a different object
 *   with a different rule: two tables in one join can both have an `id`, and
 *   shortening their names is how the projection stays readable. The round trip
 *   this sweep deletes was never about them.
 *
 * Anything else is the tail of a column reference, which means the alias is
 * renaming a column.
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
      expression:
        closer === ')' ||
        closer === '}' ||
        /(?:^|[^\w.])\d+$/.test(before) ||
        /\b(?:FROM|JOIN)\s+[A-Za-z_][A-Za-z0-9_]*$/i.test(before),
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
  const offenders = JOB_CLUSTER.flatMap((relative) =>
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

test('AC1 — the aliases that survive the job cluster are the listed anonymous-expression ones', () => {
  for (const relative of JOB_CLUSTER) {
    const surviving = aliasesIn(read(relative)).map((alias) => alias.name);
    assert.deepEqual(
      surviving,
      [...JOB_EXPRESSION_ALIASES[relative as keyof typeof JOB_EXPRESSION_ALIASES]],
      `${relative} writes an alias this sweep does not know about; an aggregate or a ` +
        'subquery may be named, but the name goes on the list above first',
    );
  }
});

test('AC1 — no SELECT in the graph/skill/proposal/hook cluster renames a column onto another spelling', () => {
  const offenders = GRAPH_CLUSTER.flatMap((relative) =>
    aliasesIn(read(relative))
      .filter((alias) => !alias.expression)
      .map((alias) => `${relative}:${alias.line} — AS ${alias.name}`),
  );

  assert.deepEqual(
    offenders,
    [],
    'a column is being read back under a second name; the projection is supposed to ' +
      `carry the column's own name now (D20, t289 FR1-FR7):\n${offenders.join('\n')}`,
  );
});

test('AC1 — the aliases that survive the graph/skill/proposal/hook cluster are the listed anonymous-expression ones', () => {
  for (const relative of GRAPH_CLUSTER) {
    const surviving = aliasesIn(read(relative)).map((alias) => alias.name);
    assert.deepEqual(
      surviving,
      [...GRAPH_EXPRESSION_ALIASES[relative as keyof typeof GRAPH_EXPRESSION_ALIASES]],
      `${relative} writes an alias, and this cluster is allowed none: every column it ` +
        'reads already carries the published name, so an alias here is either a rename ' +
        'the sweep forbids or an expression whose name goes on the list above first',
    );
  }
});

test('AC1 — no SELECT in the lease/runner/credential/engine/webhook/event cluster renames a column onto another spelling', () => {
  const offenders = LEASE_CLUSTER.flatMap((relative) =>
    aliasesIn(read(relative))
      .filter((alias) => !alias.expression)
      .map((alias) => `${relative}:${alias.line} — AS ${alias.name}`),
  );

  assert.deepEqual(
    offenders,
    [],
    'a column is being read back under a second name; the projection is supposed to ' +
      `carry the column's own name now (D20, t290 FR1-FR6):\n${offenders.join('\n')}`,
  );
});

test('AC1 — the aliases that survive the lease/runner/credential/engine/webhook/event cluster are the listed anonymous-expression ones', () => {
  for (const relative of LEASE_CLUSTER) {
    const surviving = aliasesIn(read(relative)).map((alias) => alias.name);
    assert.deepEqual(
      surviving,
      [...LEASE_EXPRESSION_ALIASES[relative as keyof typeof LEASE_EXPRESSION_ALIASES]],
      `${relative} writes an alias this sweep does not know about; an aggregate, a ` +
        'window or a join alias may be named, but the name goes on the list above first',
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
  assert.ok(
    files.length > 50,
    `the sweep found only ${files.length} files; it is not walking src/`,
  );

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
    // A column whose name merely ENDS in a digit is still a column.
    "db.prepare('SELECT sha256 AS digest FROM credential');",
  ];
  for (const source of renames) {
    const [alias] = aliasesIn(source);
    assert.ok(alias !== undefined, `the sweep saw no alias at all in: ${source}`);
    assert.equal(
      alias.expression,
      false,
      `the sweep read a column rename as an expression: ${source}`,
    );
  }

  const expressions = [
    "db.prepare('SELECT COUNT(*) AS jobs FROM job');",
    "db.prepare('SELECT COALESCE(SUM(t.blocked), 0) AS blocked_jobs FROM job t');",
    'db.prepare(`SELECT ${finishedAtOf("t.execution_id")} AS finished_at FROM job t`);',
    // A literal answers "did a row come back", and names nothing of the table.
    "db.prepare('SELECT 1 AS one FROM credential WHERE owner_type = ?');",
    // A table alias renames a table; two joined tables can both have an `id`.
    "db.prepare('SELECT d.id FROM webhook_delivery AS delivery');",
    "db.prepare('JOIN webhook_subscription AS subscription ON subscription.id = d.id');",
  ];
  for (const source of expressions) {
    const [alias] = aliasesIn(source);
    assert.ok(alias !== undefined, `the sweep saw no alias at all in: ${source}`);
    assert.equal(
      alias.expression,
      true,
      `the sweep read a named expression as a rename: ${source}`,
    );
  }

  // `CAST(… AS TEXT)` is not an alias, and the lowercase match is what says so.
  assert.deepEqual(aliasesIn("db.prepare('SELECT CAST(t.id AS TEXT) FROM job t');"), []);

  // Prose about an alias is documentation; only the query counts.
  assert.deepEqual(aliasesIn(maskComments('// every SELECT does title AS titulo\n')), []);
});
