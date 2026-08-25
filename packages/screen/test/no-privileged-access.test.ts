/**
 * Acceptance tests of the screen's boundary (t100, FR7 / D11).
 *
 * The screen is one more client of the public API: it declares no SQLite
 * driver, does not reach `packages/core/src/db` and talks to the core over HTTP
 * only. The first two points are checked here by the same gate that runs in the
 * lint.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ScreenModule from '../src/index.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-single-writer.mjs');

/**
 * Written out by hand on purpose: importing the gate's constant would make the
 * screen depend on a repo script, which is exactly the kind of coupling this
 * test exists to prevent.
 */
const SQLITE_DRIVERS = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('AT16 — packages/screen declares no SQLite driver', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.keys(manifest[field] ?? {});
    for (const driver of SQLITE_DRIVERS) {
      assert.ok(
        !declared.includes(driver),
        `the screen must not declare "${driver}" in ${field} (D1: only the core touches the database)`,
      );
    }
  }
});

test('AT17 — the gate sweep over packages/screen reports nothing', () => {
  assert.ok(existsSync(GATE_SCRIPT), 'artifact does not exist yet: scripts/check-single-writer.mjs');

  const result = spawnSync(process.execPath, [GATE_SCRIPT, PACKAGE_ROOT], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `the gate rejected the screen:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
});

test('AT18 — the screen talks to the core over HTTP only, on the public /health route', async () => {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'index.ts')),
    'artifact does not exist yet: packages/screen/src/index.ts',
  );
  const { checkHealth } = (await import(
    new URL('../src/index.ts', import.meta.url).href
  )) as typeof ScreenModule;

  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response('{"status":"ok","db":"ok"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const health = await checkHealth('http://127.0.0.1:4317', fakeFetch);
  assert.deepEqual(health, { status: 'ok', db: 'ok' });
  assert.deepEqual(calls, ['http://127.0.0.1:4317/health']);
});
