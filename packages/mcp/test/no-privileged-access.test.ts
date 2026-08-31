/**
 * Acceptance tests of this package's boundary (D1 / D11).
 *
 * The MCP server is one more client of the public API. It declares no SQLite
 * driver, does not reach `packages/core/src/db`, and imports nothing from the
 * core at all — which is a stronger claim than the gate checks, and the reason
 * the third test here is written by hand: the core's modules are ordinary
 * TypeScript that would import perfectly, and the day one of them is pulled in
 * "just for a type" this package stops being an unprivileged client and starts
 * being part of the server.
 *
 * Port of `packages/screen/test/no-privileged-access.test.ts`, which is where
 * the first two tests come from verbatim.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-single-writer.mjs');

/**
 * Written out by hand on purpose: importing the gate's constant would make this
 * package depend on a repo script, which is exactly the kind of coupling these
 * tests exist to prevent.
 */
const SQLITE_DRIVERS = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Every code file under `relative`, absolute. */
function walk(relative: string): string[] {
  const root = path.join(PACKAGE_ROOT, relative);
  if (!existsSync(root)) return [];

  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(path.join(relative, entry)));
      continue;
    }
    if (/\.(ts|mts|mjs|js)$/.test(entry)) found.push(full);
  }
  return found;
}

test('packages/mcp declares no SQLite driver', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.keys(manifest[field] ?? {});
    for (const driver of SQLITE_DRIVERS) {
      assert.ok(
        !declared.includes(driver),
        `the MCP server must not declare "${driver}" in ${field} (D1: only the core touches the database)`,
      );
    }
  }
});

test('the gate sweep over packages/mcp reports nothing', () => {
  assert.ok(existsSync(GATE_SCRIPT), 'artifact does not exist yet: scripts/check-single-writer.mjs');

  const result = spawnSync(process.execPath, [GATE_SCRIPT, PACKAGE_ROOT], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `the gate rejected the MCP server:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
});

test('nothing in packages/mcp imports the core', () => {
  const files = walk('src').concat(walk('bin'));
  assert.ok(files.length > 0, 'the sweep found no files, which means it is not sweeping');

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(REPO_ROOT, file);
    assert.ok(
      !/from\s+['"][^'"]*packages\/core/.test(source) && !/@cartografo\/core/.test(source),
      `${relative} imports the core; the only surface between this package and the state is HTTP (D11)`,
    );
  }
});
