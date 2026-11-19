/**
 * Static hygiene guard over every test tree (t1334).
 *
 * A test that creates a directory under the OS temp dir and never removes it
 * leaves it there for good; thousands of them filled a host's disk, and a full
 * disk makes the next gate fail for the machine, not for the code. This guard
 * counts, per file, the `tmpdir()`-rooted `mkdtemp` calls against the removal
 * calls and fails when a file creates more than it removes.
 *
 * It is a count, not a data-flow analysis: a file that removes one directory
 * twice and leaks another passes. `packages/core/test/cli-support-hygiene.test.ts`
 * covers the highest-volume leak (`runCli`) behaviourally. There is no
 * allowlist, on purpose.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

const CREATION = /mkdtemp(?:Sync)?\(\s*(?:path\.)?join\(\s*tmpdir\(\)/g;
const REMOVAL = /\brmSync\(|\brm\(|execFileSync\(\s*['"]rm['"]|\brimraf\(/g;

/** The creation and removal counts of one source text. */
function countTempLifecycle(source) {
  return {
    creations: (source.match(CREATION) ?? []).length,
    removals: (source.match(REMOVAL) ?? []).length,
  };
}

/** The files among `entries` ([name, source]) that create more than they remove. */
function offenders(entries) {
  const found = [];
  for (const [name, source] of entries) {
    const { creations, removals } = countTempLifecycle(source);
    if (removals < creations) found.push({ name, creations, removals });
  }
  return found;
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, accept, into) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, into);
    else if (accept(full)) into.push(full);
  }
}

function testFiles() {
  const files = [];
  const isSource = (file) => /\.(?:ts|mjs)$/.test(file);
  for (const pkg of readdirSync(path.join(REPO_ROOT, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const testDir = path.join(REPO_ROOT, 'packages', pkg.name, 'test');
    try {
      walk(testDir, isSource, files);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  walk(path.join(REPO_ROOT, 'tests'), isSource, files);
  walk(path.join(REPO_ROOT, 'scripts'), (file) => file.endsWith('.test.mjs'), files);
  return files.filter((file) => file !== SELF);
}

test('t1334 AT3 — no test file creates more temp dirs than it removes', () => {
  const files = testFiles();
  assert.ok(files.length > 50, `the walk found only ${files.length} test files`);

  const found = offenders(
    files.map((file) => [path.relative(REPO_ROOT, file), readFileSync(file, 'utf8')]),
  );

  assert.deepEqual(
    found,
    [],
    `files that create more temp dirs than they remove:\n${found
      .map((o) => `  ${o.name}: ${o.creations} creations, ${o.removals} removals`)
      .join('\n')}`,
  );
});

test('t1334 AT3 — the regexes flag a leak and accept a removal', () => {
  const leaking = "const d = mkdtempSync(path.join(tmpdir(), 'x-'));\n";
  const removing = `${leaking}t.after(() => rmSync(d, { recursive: true, force: true }));\n`;

  assert.deepEqual(offenders([['leaking.ts', leaking]]), [
    { name: 'leaking.ts', creations: 1, removals: 0 },
  ]);
  assert.deepEqual(offenders([['removing.ts', removing]]), []);
  assert.equal(countTempLifecycle("execFileSync('rm', ['-rf', d]); rimraf(d)").removals, 2);
});
