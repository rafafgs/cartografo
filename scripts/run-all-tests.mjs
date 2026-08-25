/**
 * The whole suite, in groups, with no group hiding another (t191, FR3/FR4).
 *
 * The root `test` script used to be `npm run test --workspaces && node --test
 * …`. The `&&` is the bug: when any of the four workspaces went red, the
 * root-level tests — the format validators, the event replay, the factory
 * bundles — never ran at all, and their state stayed invisible behind an
 * unrelated package's failure. That is how two tickets merged green in
 * isolation and left `main` red with no signal.
 *
 * So every group runs, always, in sequence, whatever the one before it did.
 * The exit code is the AND of all of them: 0 only if every group passed.
 *
 * Output is inherited, not captured: `node --test`'s reporter is what a person
 * reads to find out WHICH test broke, and buffering it to reprint later would
 * only delay it. What this file adds on top is a one-line-per-group summary at
 * the end, because with two groups streaming in sequence the first group's
 * verdict has long scrolled away by the time the second finishes.
 *
 * Same shape as `check-single-writer.mjs`: exported function plus a CLI, zero
 * dependencies. `runGroups` takes its `spawn` by injection so the sequencing
 * rule above is unit-testable without launching this very suite inside itself.
 *
 * CLI use: `node scripts/run-all-tests.mjs` (this is the root `npm test`).
 */

import { spawnSync } from 'node:child_process';

/**
 * The two groups, in the order a person wants to read them.
 *
 * The root group's patterns are passed as literal arguments, unquoted and
 * unexpanded by a shell: `node --test` does its own glob matching, and going
 * through a shell would leave the expansion to the platform instead.
 */
export const GROUPS = Object.freeze([
  Object.freeze({
    name: 'workspaces',
    command: 'npm',
    args: ['run', 'test', '--workspaces', '--if-present'],
  }),
  Object.freeze({
    name: 'root',
    command: 'node',
    args: [
      '--test',
      'tests/**/*.test.mjs',
      'specs/**/*.test.mjs',
      'scripts/**/*.test.mjs',
    ],
  }),
]);

/**
 * Runs every group in sequence and reports how each one ended.
 *
 * No early return: a failing group is recorded and the next one starts anyway.
 * That is the entire point of this function.
 *
 * @param {ReadonlyArray<{name: string, command: string, args: string[]}>} groups
 * @param {{spawn?: Function}} [options] `spawn` defaults to `spawnSync`.
 * @returns {{results: Array<{name: string, status: number}>, allPassed: boolean}}
 */
export function runGroups(groups, { spawn = spawnSync } = {}) {
  const results = [];

  for (const group of groups) {
    const ended = spawn(group.command, group.args, { stdio: 'inherit' });
    results.push({ name: group.name, status: exitCodeOf(ended) });
  }

  return { results, allPassed: results.every((entry) => entry.status === 0) };
}

/**
 * The exit code of a finished child, as a number that is 0 only on success.
 *
 * `spawnSync` answers with `status: null` in two cases that are both failures
 * and neither of which is an exit code: the child died on a signal, or it never
 * started (`error` set, e.g. the command is not on PATH). Both become 1.
 */
function exitCodeOf(ended) {
  if (ended?.error) return 1;
  return typeof ended?.status === 'number' ? ended.status : 1;
}

function main() {
  const { results, allPassed } = runGroups(GROUPS);

  console.log('');
  for (const entry of results) {
    console.log(`${entry.status === 0 ? 'PASS' : 'FAIL'}  ${entry.name}`);
  }

  return allPassed ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main();
}
