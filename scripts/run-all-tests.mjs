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
 * Output streams live AND is copied (t1032). `node --test`'s reporter is what
 * a person reads to find out WHICH test broke, so each chunk of a group's
 * stdout and stderr is forwarded to ours the moment it arrives; buffering it
 * would only delay it. A copy of stdout is kept for one reason: the names of
 * the failing tests print at the end of each workspace's own output, long
 * before the root group runs, and a reader (or a gate that keeps only the last
 * 1,600 characters of the output) never sees them. So the script ends with a
 * one-line-per-group verdict and, when anything failed, a bounded
 * `Failing tests:` block built from that copy. The full output above it stays
 * the source of truth.
 *
 * Consequence of the pipe: the child's stdout is no longer the parent's TTY,
 * so `node --test` picks its non-TTY default reporter. Where that differs from
 * the TTY one the live format changes (not its content); the extractor reads
 * both grammars (spec and TAP), and colour is kept by `FORCE_COLOR=1` when our
 * own stdout is a terminal.
 *
 * Same shape as `check-single-writer.mjs`: exported functions plus a CLI, zero
 * dependencies. `runGroups` takes its `spawn` and its output sinks by injection
 * so the sequencing rule above is unit-testable without launching this very
 * suite inside itself.
 *
 * CLI use: `node scripts/run-all-tests.mjs` (this is the root `npm test`).
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

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

/** The most entries the summary block shows. */
const MAX_ENTRIES = 15;
/** The longest a test name may be, ellipsis included. */
const MAX_NAME = 120;
/**
 * The most the whole tail (blank line, PASS/FAIL lines and block) may print.
 * The FlowPilot integration gate keeps the last 1,600 characters of an output.
 */
const MAX_TAIL = 1400;

/**
 * Runs every group in sequence and reports how each one ended.
 *
 * No early return: a failing group is recorded and the next one starts anyway.
 * That is the entire point of this function.
 *
 * @param {ReadonlyArray<{name: string, command: string, args: string[]}>} groups
 * @param {{
 *   spawn?: Function,
 *   stdout?: {write: Function},
 *   stderr?: {write: Function},
 *   isTTY?: boolean,
 *   env?: Record<string, string | undefined>,
 * }} [options] `spawn` has the `node:child_process` `spawn` shape; `isTTY` is
 *   whether OUR stdout is a terminal.
 * @returns {Promise<{
 *   results: Array<{name: string, status: number, failing: Array<{name: string, file: string | null}>}>,
 *   allPassed: boolean,
 * }>}
 */
export async function runGroups(
  groups,
  {
    spawn = nodeSpawn,
    stdout = process.stdout,
    stderr = process.stderr,
    isTTY = process.stdout.isTTY === true,
    env = process.env,
  } = {},
) {
  const results = [];

  for (const group of groups) {
    const ended = await runOne(group, { spawn, stdout, stderr, env: childEnv(env, isTTY) });
    results.push({
      name: group.name,
      status: ended.status,
      failing: extractFailingTests(ended.output),
    });
  }

  return { results, allPassed: results.every((entry) => entry.status === 0) };
}

/**
 * The environment a group runs in. A piped child no longer sees our terminal,
 * so colour would silently vanish; `FORCE_COLOR=1` keeps it, but only when we
 * are the terminal and the caller has not said anything about colour.
 */
function childEnv(env, isTTY) {
  const next = { ...env };
  if (isTTY && next.NO_COLOR === undefined && next.FORCE_COLOR === undefined) {
    next.FORCE_COLOR = '1';
  }
  return next;
}

/**
 * Runs one group, forwarding its output as it arrives, and resolves with its
 * exit code and a copy of its stdout.
 *
 * The exit code is 0 only on success: a child that died on a signal (`close`
 * with `code: null`) or never started (`error`) is a failure, and both become 1.
 */
function runOne(group, { spawn, stdout, stderr, env }) {
  return new Promise((resolve) => {
    const kept = [];
    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      resolve({ status, output: Buffer.concat(kept).toString('utf8') });
    };

    const child = spawn(group.command, group.args, { stdio: ['inherit', 'pipe', 'pipe'], env });

    child.stdout?.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      kept.push(bytes);
      stdout.write(bytes);
    });
    child.stderr?.on('data', (chunk) => {
      stderr.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    child.on('error', () => settle(1));
    child.on('close', (code) => settle(typeof code === 'number' ? code : 1));
  });
}

/**
 * The failing tests named in a `node --test` stdout, in the order printed.
 *
 * Reads both reporter grammars:
 *
 * - spec: after `✖ failing tests:`, one stanza per failing LEAF test, a
 *   `test at <file>:<line>:<col>` line then a `✖ <name> (<n>ms)` line;
 * - TAP: `not ok <n> - <name>` lines, each followed by a YAML block with
 *   `location:` and `failureType:`. A parent whose `failureType` is
 *   `subtestsFailed` failed only through a child and is skipped.
 *
 * Each test is listed once (name plus file), however many workspace sections
 * print it.
 *
 * @param {string} text
 * @returns {Array<{name: string, file: string | null}>}
 */
export function extractFailingTests(text) {
  const lines = stripVTControlCharacters(String(text)).split(/\r?\n/);
  const found = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const at = /^test at (.+?)(?::\d+:\d+)?$/.exec(line);
    if (at) {
      const named = /^✖ (.*?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/.exec(lines[index + 1] ?? '');
      if (named) found.push({ name: named[1], file: at[1] });
      continue;
    }

    const tap = /^\s*not ok \d+ - (.*)$/.exec(line);
    if (tap) {
      const name = tap[1];
      if (/\s#\s*(?:SKIP|TODO)\b/i.test(name)) continue;
      let file = null;
      let failureType = null;
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^\s*(?:not ok|ok) \d+|^\s*# Subtest|^\s*1\.\.\d+/.test(lines[next])) break;
        const location = /^\s*location: '(.*?)(?::\d+:\d+)?'\s*$/.exec(lines[next]);
        if (location) file = location[1];
        const type = /^\s*failureType: '(.*)'\s*$/.exec(lines[next]);
        if (type) failureType = type[1];
      }
      if (failureType === 'subtestsFailed') continue;
      found.push({ name: name.replace(/\\#/g, '#'), file });
    }
  }

  const seen = new Set();
  return found.filter((entry) => {
    const key = `${entry.name}\u0000${entry.file ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A test name on one line, at most `MAX_NAME` characters, ellipsis included. */
function shortName(name) {
  const flat = name.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_NAME ? flat : `${flat.slice(0, MAX_NAME - 1)}…`;
}

/**
 * Everything printed after the groups have run: a blank line, one PASS/FAIL
 * line per group and, when a group failed, the `Failing tests:` block.
 *
 * The block is bounded (see `MAX_ENTRIES`, `MAX_NAME`, `MAX_TAIL`). The
 * character budget wins over the entry cap: entries are dropped from the end
 * until it fits, and `+N more` counts every failing test not shown.
 *
 * @param {ReadonlyArray<{name: string, status: number, failing?: Array<{name: string, file: string | null}>}>} results
 * @returns {string}
 */
export function renderSummary(results) {
  const verdicts = results
    .map((entry) => `${entry.status === 0 ? 'PASS' : 'FAIL'}  ${entry.name}`)
    .join('\n');
  const base = `\n${verdicts}\n`;

  const red = results.filter((entry) => entry.status !== 0);
  if (red.length === 0) return base;

  const flat = red.flatMap((entry) =>
    (entry.failing ?? []).map((test) => ({ group: entry.name, ...test })),
  );

  const block = (shown) => {
    const lines = ['', 'Failing tests:'];
    let taken = 0;
    for (const entry of red) {
      const count = (entry.failing ?? []).length;
      if (count === 0) {
        lines.push(`${entry.name} failed with exit ${entry.status}, no failing test found in its output`);
        continue;
      }
      const mine = flat.slice(taken, taken + count).slice(0, Math.max(0, shown - taken));
      taken += count;
      if (mine.length === 0) continue;
      lines.push(`${entry.name}:`);
      for (const test of mine) {
        lines.push(`  ✖ ${shortName(test.name)}${test.file ? ` (${test.file})` : ''}`);
      }
    }
    const hidden = flat.length - shown;
    if (hidden > 0) lines.push(`+${hidden} more`);
    return `${base}${lines.join('\n')}\n`;
  };

  let shown = Math.min(MAX_ENTRIES, flat.length);
  while (shown > 0 && block(shown).length > MAX_TAIL) shown -= 1;
  return block(shown);
}

async function main() {
  const { results, allPassed } = await runGroups(GROUPS);

  process.stdout.write(renderSummary(results));

  return allPassed ? 0 : 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main();
}
