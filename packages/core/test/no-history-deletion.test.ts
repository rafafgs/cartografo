/**
 * Gate of RF-42 — nothing in a history is deleted by an automatic routine (t372,
 * FR5).
 *
 * The requirement is about this phase of the product, and a guarantee about a
 * phase has to be one of CODE: a promise kept by everybody remembering it is a
 * promise until the first person who does not. So the sweep is the same one
 * `event-append-only.test.ts` runs over the log, widened to the two tables the
 * history is also made of — `session` and `input_request` — because a `DELETE`
 * on either of them erases a traversal just as thoroughly as one on `event`.
 *
 * `UPDATE` is deliberately NOT guarded here. Closing a session and answering a
 * question are legitimate `UPDATE`s on those two tables, and they exist today:
 * RF-42 is about deletion, not about a projection reaching its final state.
 * `event` keeps its own stricter rule in the file above — there, an update is a
 * fact rewritten, and it is forbidden.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PACKAGE_ROOT } from './support.ts';

const SOURCE_DIR = path.join(PACKAGE_ROOT, 'src');

/** The three tables a traversal's history is made of. */
const HISTORY_TABLES = ['event', 'session', 'input_request'];

/** `DELETE FROM <one of the three>`, in any case and spacing. */
const HISTORY_DELETION = new RegExp(
  String.raw`\bdelete\s+from\s+(?:${HISTORY_TABLES.join('|')})\b`,
  'i',
);

/** Lists the `.ts` files under a directory, recursively. */
function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listSources(filePath));
    } else if (entry.isFile() && filePath.endsWith('.ts')) {
      found.push(filePath);
    }
  }
  return found.sort();
}

/**
 * Strips comments before the sweep.
 *
 * A comment that MENTIONS the rule is not a violation of it — this file's own
 * header would be one otherwise.
 */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

test('t372 FR5 — no module of src/ deletes from event, session or input_request', () => {
  const violations: string[] = [];
  for (const file of listSources(SOURCE_DIR)) {
    const code = withoutComments(readFileSync(file, 'utf8'));
    if (HISTORY_DELETION.test(code)) violations.push(path.relative(PACKAGE_ROOT, file));
  }

  assert.deepEqual(
    violations,
    [],
    'the history is what makes a traversal reproducible; no routine erases it',
  );
});

test('t372 FR5 — the gate really does catch a deletion of each of the three', () => {
  // Without this proof the test above could be passing by accident: a regex
  // that never matches anything is indistinguishable from a clean tree.
  assert.ok(HISTORY_DELETION.test("db.exec('DELETE FROM session')"));
  assert.ok(HISTORY_DELETION.test("db.exec('delete from event where id = 1')"));
  assert.ok(HISTORY_DELETION.test('db.prepare("DELETE   FROM   input_request WHERE job_id = ?")'));
  assert.ok(HISTORY_DELETION.test("db.exec('DELETE\nFROM session')"));

  // And what it must NOT catch: another table, and the legitimate updates.
  assert.ok(!HISTORY_DELETION.test("db.prepare('DELETE FROM engine_model WHERE engine = ?')"));
  assert.ok(!HISTORY_DELETION.test("db.prepare('UPDATE session SET status = ? WHERE id = ?')"));
  assert.ok(!HISTORY_DELETION.test("db.prepare('UPDATE input_request SET answer = ?')"));
  assert.ok(!HISTORY_DELETION.test(withoutComments('// never DELETE FROM session here')));
});
