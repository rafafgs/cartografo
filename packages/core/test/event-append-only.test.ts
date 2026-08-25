/**
 * Gate of the log's append-only rule (t102, AT16).
 *
 * The taxonomy is explicit: "the only operation on the log is insert", and the
 * guarantee has to be one of CODE, not of convention — parity with flowpilot's
 * `TicketEventRepository`, which exposes `create` and reads and nothing else,
 * with a test that sweeps the source for update/delete against the table
 * (`specs/events/taxonomy.md:90-98`).
 *
 * Two rules here:
 *
 * 1. `src/db/events.ts` exports EXACTLY three functions at runtime;
 * 2. no other module of `src/` writes update/delete SQL against `event`.
 *
 * The table is `event` and no longer `evento` since D20's fourth child (t229)
 * renamed the schema; the rule it guards did not move by one inch.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { T102_ARTIFACTS, PACKAGE_ROOT, loadEvents, requireArtifacts } from './support.ts';

const SOURCE_DIR = path.join(PACKAGE_ROOT, 'src');

/** The module that owns the log — the only one exempt from the sweep. */
const LOG_OWNER = path.join(PACKAGE_ROOT, T102_ARTIFACTS.events);

/** `UPDATE event` / `DELETE FROM event`, in any case and spacing. */
const DESTRUCTIVE_WRITE = new RegExp(String.raw`\b(?:update|delete\s+from)\s+event\b`, 'i');

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
 * A comment that MENTIONS the rule is not a violation of it — and without this
 * the gate would punish precisely whoever documents the reason for not doing it.
 */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

test('AT16 — src/db/events.ts exposes only insert and reads', async () => {
  requireArtifacts(T102_ARTIFACTS.events);
  const module = await loadEvents();

  assert.deepEqual(
    Object.keys(module).sort(),
    ['getEventsByEntity', 'listEvents', 'recordEvent'],
    'no update/delete function can exist in the owner of the log',
  );
  for (const name of ['recordEvent', 'listEvents', 'getEventsByEntity'] as const) {
    assert.equal(typeof module[name], 'function', `${name} has to be a function`);
  }
});

test('AT16 — no module of src/ writes UPDATE/DELETE against the event table', () => {
  requireArtifacts(T102_ARTIFACTS.events);

  const violations: string[] = [];
  for (const file of listSources(SOURCE_DIR)) {
    if (file === LOG_OWNER) continue;
    const code = withoutComments(readFileSync(file, 'utf8'));
    if (DESTRUCTIVE_WRITE.test(code)) {
      violations.push(path.relative(PACKAGE_ROOT, file));
    }
  }

  assert.deepEqual(
    violations,
    [],
    'a fact recorded wrong is corrected by another fact, never by overwriting',
  );
});

test('AT16 — the gate really does catch a destructive write', () => {
  // Without this proof the test above could be passing by accident — a regex
  // that never matches anything is indistinguishable from clean code.
  assert.ok(DESTRUCTIVE_WRITE.test("db.prepare('UPDATE event SET data = ? WHERE id = ?')"));
  assert.ok(DESTRUCTIVE_WRITE.test('db.exec("delete from event")'));
  assert.ok(DESTRUCTIVE_WRITE.test("db.exec('DELETE   FROM   event WHERE id = 1')"));
  assert.ok(!DESTRUCTIVE_WRITE.test("db.prepare('UPDATE job SET current_node_id = ?')"));
  assert.ok(!DESTRUCTIVE_WRITE.test("db.prepare('INSERT INTO event (type) VALUES (?)')"));
  assert.ok(!DESTRUCTIVE_WRITE.test(withoutComments('// never do UPDATE event here')));
});
