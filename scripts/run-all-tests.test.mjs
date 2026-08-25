/**
 * Acceptance tests of t191 — the aggregator that stops one red group from
 * hiding another's state.
 *
 * The bug this pins is the `&&` the root `test` script used to carry: when the
 * workspaces group failed, the 238 root-level tests never ran, and the state of
 * the format validators, the event replay and the factory bundles stayed
 * invisible behind an unrelated package's red.
 *
 * So the rule under test is sequencing, not spawning: `runGroups` takes an
 * injected `spawn`, which is what makes the aggregation assertable without
 * launching the real suite inside itself (the same exported-function-plus-CLI
 * shape as `check-single-writer.mjs`). The CLI entrypoint — two real
 * `spawnSync` calls — is covered by the CI run, not duplicated here.
 *
 * Run with: `node --test scripts/`
 */

import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GROUPS as DECLARED_GROUPS, runGroups } from './run-all-tests.mjs';

/** The two groups the CLI runs, reduced to what the stub needs. */
const GROUPS = Object.freeze([
  Object.freeze({ name: 'workspaces', command: 'npm', args: ['run', 'test', '--workspaces'] }),
  Object.freeze({ name: 'root', command: 'node', args: ['--test', 'tests/**/*.test.mjs'] }),
]);

/**
 * A `spawn` stub that answers with the exit codes it is handed, in order, and
 * records every call it received.
 *
 * @param {readonly number[]} codes One exit code per expected call.
 * @returns {{spawn: Function, calls: Array<{command: string, args: string[]}>}}
 */
function stubSpawn(codes) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: codes[calls.length - 1] };
  };
  return { spawn, calls };
}

test('AT1 — runGroups runs every group even after an earlier one fails', () => {
  const { spawn, calls } = stubSpawn([1, 0]);

  const report = runGroups(GROUPS, { spawn });

  assert.equal(calls.length, 2, 'the second group must not be skipped by the first failing');
  assert.deepEqual(
    calls.map((call) => call.command),
    ['npm', 'node'],
    'both groups have to reach the spawn, in declaration order',
  );
  assert.deepEqual(report.results, [
    { name: 'workspaces', status: 1 },
    { name: 'root', status: 0 },
  ]);
});

test('AT2 — runGroups reports allPassed: false when any group fails', () => {
  const { spawn } = stubSpawn([1, 0]);

  const report = runGroups(GROUPS, { spawn });

  assert.equal(report.allPassed, false, 'one red group is enough to fail the whole run');
});

test('AT3 — runGroups reports allPassed: true only when every group exits 0', () => {
  const { spawn, calls } = stubSpawn([0, 0]);

  const report = runGroups(GROUPS, { spawn });

  assert.equal(calls.length, 2, 'every group runs on the green path too');
  assert.equal(report.allPassed, true);
  assert.deepEqual(report.results, [
    { name: 'workspaces', status: 0 },
    { name: 'root', status: 0 },
  ]);
});

/**
 * The root group's glob patterns, read off the real declaration.
 *
 * Read from `GROUPS` rather than spelled again here, which is the whole point:
 * a test that repeated the patterns would keep passing while the file it is
 * about pointed somewhere else.
 */
function rootPatterns() {
  const root = DECLARED_GROUPS.find((group) => group.name === 'root');
  assert.ok(root !== undefined, 'the root group is gone from GROUPS; the suite lost half itself');

  return root.args.filter((argument) => argument.endsWith('.test.mjs'));
}

/**
 * How many files one of those patterns really finds, from the repository root.
 *
 * `node --test` does its own glob matching and `fs.globSync` is the same
 * implementation, so this counts what the runner would count. What it must NOT
 * do is spawn the runner: these very patterns include `scripts/**` and this file
 * is under it.
 *
 * @param {string} pattern One glob, as `run-all-tests.mjs` passes it.
 * @returns {number} How many test files it matches.
 */
function discovered(pattern) {
  return globSync(pattern, { cwd: path.resolve(import.meta.dirname, '..') }).length;
}

test('AT4 — no glob of the root group has gone dead (t282)', () => {
  const empty = rootPatterns().filter((pattern) => discovered(pattern) === 0);

  assert.deepEqual(
    empty,
    [],
    'a root-group glob matches no file at all, and a glob that matches nothing does ' +
      `not fail — \`node --test\` reports "tests 0" and exits 0:\n${empty.join('\n')}`,
  );
});

test('AT4 — the specs glob still finds every specification test (t282)', () => {
  const specs = rootPatterns().filter((pattern) => pattern.startsWith('specs/'));

  assert.equal(
    specs.length,
    1,
    'the root group no longer carries exactly one specs pattern; the rename of t282 ' +
      'moved `specs/**/*.test.mjs` to `specs/**/*.test.mjs` and nothing else',
  );

  assert.ok(
    discovered(specs[0]) >= 4,
    `${specs[0]} finds ${String(discovered(specs[0]))} test files; the four that ran under ` +
      '`specs/**/*.test.mjs` before t282 renamed the tree have to still run',
  );
});
