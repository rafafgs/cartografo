/**
 * Acceptance tests for the runner's boundary (t103, FR12 / D1).
 *
 * "The runner only speaks HTTP to the server; zero access to the database file"
 * is an acceptance criterion of the ticket, and D1 is the decision behind it:
 * only the control plane writes to SQLite. A runner that opened the database
 * file would break the single-writer guarantee in the exact scenario where it
 * matters most — several distributed runners competing for the same work.
 *
 * Same pair of assertions as `packages/screen/test/no-privileged-access.test.ts`,
 * through the same gate (`scripts/check-single-writer.mjs`).
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
 * A hand-written list on purpose, as in the UI package: importing the gate's
 * constant would make the runner depend on a script of the repo, which is
 * exactly the kind of coupling this test exists to prevent.
 */
const SQLITE_DRIVERS = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('AT18 — packages/runner declares no SQLite driver', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.keys(manifest[field] ?? {});
    for (const driver of SQLITE_DRIVERS) {
      assert.ok(
        !declared.includes(driver),
        `the runner may not declare "${driver}" in ${field} (D1: only the core touches the database)`,
      );
    }
  }
});

test('AT19 — the gate sweep over packages/runner flags nothing', () => {
  assert.ok(
    existsSync(GATE_PATH),
    'artifact does not exist yet: scripts/check-single-writer.mjs',
  );

  const result = spawnSync(process.execPath, [GATE_PATH, PACKAGE_ROOT], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `the gate rejected the runner:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
});
