/**
 * Acceptance tests of the multi-project selection on the command line (t1112,
 * AT1–AT7).
 *
 * Pure parsing, like `index.test.ts`: nothing here opens a socket. A selection
 * the command cannot read, or one combined with a flag that contradicts it,
 * dies with a `2` and one line before `runRunner` is ever reached, and the spy
 * handed in as the `run` seam is what proves it was not.
 *
 * English only.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as CliModule from '../../src/cli/index.ts';
import type * as RunModule from '../../src/cli/run.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI_MODULE = 'src/cli/index.ts';

/** A repository a case names when it does not care which one. */
const SOME_REPO = path.join(tmpdir(), 'cartografo-t1112-repo');

/** ...and a sibling root for its worktrees. */
const SOME_WORKTREES = `${SOME_REPO}-worktrees`;

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Swallows and records what the command writes on stderr while it is armed. */
function captureStderr(): { written: () => string; restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  let written = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  return {
    written: () => written,
    restore: () => {
      process.stderr.write = original;
    },
  };
}

/** The non-empty lines of a captured stream. */
function linesOf(written: string): string[] {
  return written.split('\n').filter((line) => line !== '');
}

/** A `run` seam that records what it was handed and never dials anything. */
function spyRun(): {
  seen: RunModule.RunnerOptions[];
  run: (options: RunModule.RunnerOptions) => Promise<void>;
} {
  const seen: RunModule.RunnerOptions[] = [];
  return {
    seen,
    run: async (options) => {
      seen.push(options);
    },
  };
}

/** Runs the command with a spy for `run`, capturing stderr. */
async function runCaptured(
  args: string[],
): Promise<{ code: number; stderr: string; seen: RunModule.RunnerOptions[] }> {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);
  const spy = spyRun();
  const stderr = captureStderr();
  let code: number;
  try {
    code = await runRunnerCli(args, {}, { run: spy.run });
  } finally {
    stderr.restore();
  }
  return { code, stderr: stderr.written(), seen: spy.seen };
}

test('AT1 — --projects parses to a sorted, de-duplicated list and leaves every path undefined', async () => {
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);

  const options = parseRunnerOptions(['--projects', '1,4,7'], {});
  assert.deepEqual(options.projects, { kind: 'list', ids: [1, 4, 7] });
  assert.equal(options.repoRoot, undefined);
  assert.equal(options.worktreesRoot, undefined);
  assert.equal(options.testBenchPath, undefined);

  assert.deepEqual(parseRunnerOptions(['--projects', '7,1,1'], {}).projects, {
    kind: 'list',
    ids: [1, 7],
  });
  assert.deepEqual(parseRunnerOptions(['--projects=4'], {}).projects, { kind: 'list', ids: [4] });
});

test('AT2 — --all-projects is a value-less flag; no selection keeps today\'s project id', async () => {
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);

  assert.deepEqual(parseRunnerOptions(['--all-projects'], {}).projects, { kind: 'all' });
  // A value-less flag does not swallow the next option.
  const followed = parseRunnerOptions(['--all-projects', '--interval-ms', '700'], {});
  assert.deepEqual(followed.projects, { kind: 'all' });
  assert.equal(followed.intervalMs, 700);

  const none = parseRunnerOptions([], {});
  assert.equal(none.projects, undefined);
  assert.equal(none.projectId, 1);

  const one = parseRunnerOptions(['--project', '7'], {});
  assert.equal(one.projectId, 7);
  assert.equal(one.projects, undefined);
});

test('AT3 — a bad --projects value is a usage error naming --projects, before any call', async () => {
  for (const value of ['', '1,,2', '1,x', '0', '-1', '1.5']) {
    const { code, stderr, seen } = await runCaptured([`--projects=${value}`]);
    assert.equal(code, 2, `--projects "${value}" exits 2`);
    assert.equal(linesOf(stderr).length, 1, `one line for "${value}":\n${stderr}`);
    assert.match(stderr, /--projects/, `the line for "${value}" names --projects`);
    assert.deepEqual(seen, [], `"${value}" never reaches run`);
  }
});

test('AT4 — the three selections exclude each other, and the line names both options', async () => {
  const cases: Array<{ args: string[]; names: [RegExp, RegExp] }> = [
    { args: ['--project', '1', '--projects', '1,2'], names: [/--project\b(?!s)/, /--projects/] },
    { args: ['--project', '1', '--all-projects'], names: [/--project\b(?!s)/, /--all-projects/] },
    { args: ['--projects', '1', '--all-projects'], names: [/--projects/, /--all-projects/] },
  ];

  for (const { args, names } of cases) {
    const { code, stderr, seen } = await runCaptured(args);
    assert.equal(code, 2, `${args.join(' ')} exits 2`);
    assert.equal(linesOf(stderr).length, 1, `one line for ${args.join(' ')}:\n${stderr}`);
    for (const name of names) assert.match(stderr, name, `${args.join(' ')}: ${stderr}`);
    assert.deepEqual(seen, []);
  }
});

test('AT5 — with a selection, each path flag is refused with one line naming it and the settings', async () => {
  const pathFlags: Array<[string, string]> = [
    ['--working-dir', SOME_REPO],
    ['--worktrees-root', SOME_WORKTREES],
    ['--test-bench-path', SOME_REPO],
    ['--reference-repo', SOME_REPO],
  ];
  const selections = [['--projects', '1,2'], ['--all-projects']];

  for (const [flag, value] of pathFlags) {
    for (const selection of selections) {
      const args = [...selection, flag, value];
      const { code, stderr, seen } = await runCaptured(args);
      assert.equal(code, 2, `${args.join(' ')} exits 2`);
      assert.equal(linesOf(stderr).length, 1, `one line for ${args.join(' ')}:\n${stderr}`);
      assert.ok(stderr.includes(flag), `the line names ${flag}: ${stderr}`);
      assert.match(stderr, /workspace_root/);
      assert.match(stderr, /worktrees_root/);
      assert.deepEqual(seen, [], `${args.join(' ')} never reaches run`);
    }
  }

  // ...and without a selection, the four still parse exactly as today.
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);
  const today = parseRunnerOptions(
    [
      '--working-dir',
      SOME_REPO,
      '--worktrees-root',
      SOME_WORKTREES,
      '--test-bench-path',
      SOME_REPO,
      '--reference-repo',
      SOME_REPO,
    ],
    {},
  );
  assert.equal(today.repoRoot, SOME_REPO);
  assert.equal(today.worktreesRoot, SOME_WORKTREES);
  assert.equal(today.testBenchPath, SOME_REPO);
  assert.equal(today.referenceRepo, SOME_REPO);
  assert.equal(today.projects, undefined);
});

test('AT6 — the process-wide options are accepted with a selection', async () => {
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);

  const options = parseRunnerOptions(
    ['--engine', 'codex', '--projects', '1,2', '--bench-install-command', 'npm ci', '--main-branch', 'trunk'],
    {},
  );
  assert.deepEqual(options.projects, { kind: 'list', ids: [1, 2] });
  assert.equal(options.engine, 'codex');
  assert.equal(options.benchInstallCommand, 'npm ci');
  assert.equal(options.mainBranch, 'trunk');

  // With no --engine, each project's own setting is left to speak.
  assert.equal(parseRunnerOptions(['--all-projects'], {}).engine, undefined);
});

test('AT7 — USAGE documents --projects and --all-projects', async () => {
  const { USAGE } = await loadModule<typeof CliModule>(CLI_MODULE);
  assert.match(USAGE, /--projects/);
  assert.match(USAGE, /--all-projects/);
});
