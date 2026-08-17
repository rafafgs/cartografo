/**
 * Acceptance tests of the watcher's boundary (t247, AT8 — D1/D11).
 *
 * The same pattern as `packages/topografo-custo/test/no-privileged-access.test.ts`
 * and `packages/tela/test/no-privileged-access.test.ts`: an observer is an
 * ordinary client of the public API. It declares no SQLite driver, it never
 * reaches `packages/core/src/db/**`, and every write it causes travels over
 * HTTP through the two lenses it triggers.
 *
 * One assertion of the sibling's is deliberately NOT ported. `topografo-custo`
 * asserts that it "depends on neither the core nor the runner", and that is a
 * true statement about a package whose whole point is that a second surveyor
 * needs nothing but the public API. This package's whole point is the opposite:
 * it runs BOTH lenses in process, so it depends on `@cartografo/runner` and on
 * `@cartografo/topografo-custo` by construction. D1/D11's line is about who
 * writes to the database, not about which sibling package is imported — and the
 * two rules below are that line, unchanged.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GATE_PATH = path.join(REPO_ROOT, 'scripts', 'check-single-writer.mjs');

/**
 * A hand-written list on purpose: importing the constant from the gate would
 * make the package depend on a script of the repo, which is exactly the kind of
 * coupling this test exists to prevent (same note as the two siblings).
 */
const SQLITE_DRIVERS = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('t247 AT8 — packages/topografo declares no SQLite driver', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.keys(manifest[field] ?? {});
    for (const driver of SQLITE_DRIVERS) {
      assert.ok(
        !declared.includes(driver),
        `the watcher cannot declare "${driver}" in ${field} (D1: only the core touches the database)`,
      );
    }
    assert.ok(
      !declared.includes('cartografo'),
      `the watcher does not depend on the core in ${field}: its only surface is the public API (D11)`,
    );
  }
});

test('t247 AT8 — the gate sweep over packages/topografo flags nothing', () => {
  assert.ok(existsSync(GATE_PATH), 'artifact does not exist yet: scripts/check-single-writer.mjs');

  const result = spawnSync(process.execPath, [GATE_PATH, PACKAGE_ROOT], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `the gate rejected the watcher:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
});
