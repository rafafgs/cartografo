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
import test from 'node:test';

import { runGroups } from './run-all-tests.mjs';

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
