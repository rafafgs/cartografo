/**
 * D24 gate: the prose inside a migration is English, though its NAME never moves
 * (t311).
 *
 * The last concentration of Portuguese D24's series left standing, and the one
 * that needed a distinction spelled out before it could be swept at all. D24's
 * exception list freezes *"the migration file names (t279, never renamed)"* —
 * the names, and nothing else. A migration file name is a primary key: it is
 * what `schema_migrations.id` holds in every database that ever ran, so moving
 * one re-runs a migration that already applied (`packages/core/src/db/migrate.ts`,
 * and `tests/no-portuguese-path-segments.test.mjs`'s `FROZEN_TREES` is the gate
 * that holds it). A `--` comment above the DDL is prose, D24 is about prose, and
 * the two facts live in the same file without touching.
 *
 * So this gate reads exactly the half the path sweep refuses to: the comment
 * span, never the name, and never the SQL either. Which is the whole boundary —
 * `FROZEN_TREES` excludes this directory from the NAME sweep, and this file is
 * what stops that exclusion from reading as "nothing in here is ever swept".
 *
 * ## Two cheap signals, and why they are enough
 *
 * The same two `tests/no-portuguese-reader-documents.test.mjs`,
 * `tests/no-portuguese-factory-bundles.test.mjs` and
 * `packages/core/test/no-portuguese-glossary-prose.test.ts` already stand on,
 * imported from `scripts/no-portuguese-prose.mjs` rather than transcribed a
 * fourth time:
 *
 * - a Portuguese diacritic, which no English word in this repository carries;
 * - a short list of function words common enough in Portuguese prose that a
 *   paragraph left behind is certain to carry one, and rare enough as English
 *   tokens that a translated comment never trips them.
 *
 * What stays here is the part that is this gate's own: WHICH span to point them
 * at. That is the split `scripts/no-portuguese-prose.mjs`'s header describes and
 * t287 recorded before it — the signals are one fact, the line-selection
 * strategies are several that merely rhyme, and a markdown gate's fence walking
 * has nothing to say about a `.sql` file.
 *
 * ## What is read, and what is deliberately not
 *
 * - **the `--`-to-end-of-line span, and only it.** Everything left of the `--`
 *   is DDL: table names, column names, `CHECK` values. FR3 leaves every SQL
 *   identifier exactly as it is even where one is Portuguese, so a gate that
 *   read them would be red for a reason no comment edit could fix. A `--` inside
 *   a quoted literal is not a comment and does not open one, which is why the
 *   scan below walks the line rather than splitting on the first `--` it sees;
 * - **no backtick span.** `` `job.criterios_de_aceite` `` quoted mid-sentence is
 *   the name of a column, not a word of the sentence, and FR1 asks for every one
 *   of them verbatim. Same cut the reader-facing sweep makes, for the same
 *   reason;
 * - **no gloss.** D24's convention is that where an English rendering would
 *   flatten a nuance the Portuguese carried, the original stays inline as
 *   `(literally "<phrase>")`. That span is the one place Portuguese is supposed
 *   to survive, so it is cut before the scan rather than exempted per file.
 *
 * Blanked rather than dropped, all three, so the index of a line in the result
 * is still its number in the file and a failure can name it.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC, GLOSS, STOPWORD, blank } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The directory this gate reads, repo-relative — the one D24 froze the names of. */
export const MIGRATIONS_DIR = 'packages/core/migrations';

/** A backtick span, of any backtick run length, within one line. */
const SPAN = /(`+)(.+?)\1/g;

/**
 * Where the line comment starts, or `-1` if the line has none.
 *
 * Walks rather than searching, because a `--` inside a quoted literal opens no
 * comment and the SQL left of it is not this gate's to read. SQLite escapes a
 * quote inside a literal by doubling it, which the toggle below handles by
 * arithmetic: two flips land back where they started.
 *
 * @param {string} line One line of a migration file.
 * @returns {number} Index of the first `-` of the comment marker, or `-1`.
 */
export function commentStart(line) {
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "'") {
      quoted = !quoted;
      continue;
    }
    if (!quoted && line[index] === '-' && line[index + 1] === '-') return index;
  }

  return -1;
}

/** The line with every backtick span blanked out; the backticks stay. */
function withoutSpans(line) {
  let kept = line;

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + blank(match[2]) + kept.slice(end);
  }

  return kept;
}

/**
 * The migration reduced to its prose: no DDL, no code span, no gloss.
 *
 * @param {string} sql Contents of one migration file.
 * @returns {string[]} One entry per line of the input, comment intact, rest blank.
 */
export function commentsOf(sql) {
  return sql.split('\n').map((line) => {
    const start = commentStart(line);
    if (start === -1) return blank(line);

    return blank(line.slice(0, start)) + withoutSpans(line.slice(start).replace(GLOSS, blank));
  });
}

/** Every migration this gate reads, as repo-relative paths, in applied order. */
export function migrationsInScope() {
  return readdirSync(path.join(ROOT, MIGRATIONS_DIR))
    .filter((entry) => entry.endsWith('.sql'))
    .sort()
    .map((entry) => `${MIGRATIONS_DIR}/${entry}`);
}

/**
 * Every offending comment line of one migration, with its number and what tripped it.
 *
 * Reported whole rather than stopping at the first: a half-translated migration
 * has dozens, and a gate that named one per run would take dozens of runs to
 * finish.
 *
 * @param {string} relativePath Repo-relative path of the migration to read.
 * @returns {string[]} One entry per offending line.
 */
export function offendersIn(relativePath) {
  const found = [];

  commentsOf(readFileSync(path.join(ROOT, relativePath), 'utf8')).forEach((line, index) => {
    const diacritic = DIACRITIC.exec(line);
    const stopword = STOPWORD.exec(line);
    if (diacritic === null && stopword === null) return;

    const why = diacritic === null ? `stopword "${stopword[0]}"` : `diacritic "${diacritic[0]}"`;
    found.push(`${relativePath}:${String(index + 1)}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

test('AT1 — no Portuguese survives in a migration comment', () => {
  const offenders = migrationsInScope().flatMap(offendersIn);

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives inside a migration comment:\n${offenders.join('\n')}`,
  );
});

test('AT1 — the gate reads every migration the package ships', () => {
  const migrations = migrationsInScope();

  assert.ok(
    migrations.length >= 24,
    `only ${String(migrations.length)} migrations read; the sweep is blind`,
  );

  for (const required of ['0001_init.sql', '0024_graph_version_contracts_state.sql']) {
    assert.ok(
      migrations.includes(`${MIGRATIONS_DIR}/${required}`),
      `${required} is not in the swept set`,
    );
  }
});

test('AT1 — the sweep bites on a Portuguese comment', () => {
  const portuguese = [
    '-- 0001_init — tabela de controle do runner de migração.',
    'CREATE TABLE job (  -- não é a tabela de domínio',
    '--   uma linha de continuação da prosa acima',
  ];

  for (const line of portuguese) {
    const [comment] = commentsOf(line);
    assert.ok(
      DIACRITIC.test(comment) || STOPWORD.test(comment),
      `the sweep missed a Portuguese comment: ${line}`,
    );
  }
});

test('AT1 — the sweep does NOT bite on an English comment, a quoted name or a gloss', () => {
  const legal = [
    '-- 0001_init — control table of the migration runner itself.',
    'ALTER TABLE job ADD COLUMN corpo TEXT;  -- the body of the job, as submitted',
    // A backticked span is a column name, an event name or a wire key, and FR1
    // asks for every one of them verbatim — `de`/`para` are edge keys D20 froze.
    '-- the proposal operation `{tipo, no_id, campo, de, para, inversa}`, before D20',
    '-- `job.criterios_de_aceite` holds JSON: `string[]`; NULL is not `[]`',
    // The one span where the original is supposed to survive.
    '-- a ledger (literally "livro-razão") that knows WHAT ran, not only whether',
  ];

  for (const line of legal) {
    const [comment] = commentsOf(line);
    assert.equal(DIACRITIC.test(comment), false, `the sweep flagged a legal comment: ${line}`);
    assert.equal(STOPWORD.test(comment), false, `the sweep flagged a legal comment: ${line}`);
  }
});

test('AT1 — the SQL body is out of this sweep, comment or no comment', () => {
  // FR3: no SQL identifier moves, even one found Portuguese. So a Portuguese
  // word in a DDL position has to be invisible here, or the gate would demand a
  // rename this ticket is forbidden to make.
  const ddl = [
    "INSERT INTO job (status) VALUES ('não-iniciado');",
    'ALTER TABLE session ADD COLUMN transcricao_truncada INTEGER NOT NULL DEFAULT 0;',
    // A `--` inside a literal opens no comment: everything here is still DDL.
    "UPDATE job SET corpo = 'a--não' WHERE id = 1;",
  ];

  for (const line of ddl) {
    const [comment] = commentsOf(line);
    assert.equal(comment.trim(), '', `SQL leaked into the comment scan: ${line}`);
  }
});

test('AT1 — a blanked line keeps its length, so a failure names the right line', () => {
  const sql = ['CREATE TABLE t (', '  id TEXT  -- a chave', ');'].join('\n');
  const comments = commentsOf(sql);

  assert.equal(comments.length, 3);
  assert.equal(comments[1].length, '  id TEXT  -- a chave'.length);
  assert.equal(comments[1].trimStart(), '-- a chave');
});
