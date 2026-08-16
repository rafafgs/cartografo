/**
 * Acceptance tests of the cost surveyor's boundary (t114, AT10/AT11 — D1/D11).
 *
 * The same pattern as `packages/tela/test/no-privileged-access.test.ts`: the
 * surveyor is an ordinary client of the public API. It declares no SQLite
 * driver, it does not reach `packages/core/src/db` and it talks to the control
 * plane over HTTP only.
 *
 * Here that holds twice over. Beyond D1, it is the mechanical proof of that
 * ticket's criterion: if the cost lens needed to touch the core in order to
 * exist, "a surveyor is an extension point" would be a claim with nothing behind
 * it.
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
 * coupling this test exists to prevent (same note as `packages/tela`).
 */
const SQLITE_DRIVERS = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('AT10 — packages/topografo-custo declares no SQLite driver', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.keys(manifest[field] ?? {});
    for (const driver of SQLITE_DRIVERS) {
      assert.ok(
        !declared.includes(driver),
        `the surveyor cannot declare "${driver}" in ${field} (D1: only the core touches the database)`,
      );
    }
    assert.ok(
      !declared.includes('cartografo') && !declared.includes('@cartografo/runner'),
      `the surveyor depends on neither the core nor the runner in ${field}: the only surface is the public API`,
    );
  }
});

test('AT11 — the gate sweep over packages/topografo-custo flags nothing', () => {
  assert.ok(existsSync(GATE_PATH), 'artifact does not exist yet: scripts/check-single-writer.mjs');

  const result = spawnSync(process.execPath, [GATE_PATH, PACKAGE_ROOT], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `the gate rejected the surveyor:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
});
