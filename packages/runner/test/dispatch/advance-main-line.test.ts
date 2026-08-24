/**
 * Acceptance tests for the step that keeps the shared test bench true (t273,
 * AT1).
 *
 * `integrar-branch`'s own manifest promises it — the session never runs the
 * final merge, and it is the EXECUTOR that re-verifies and moves the main line
 * — and until this ficha nobody kept it: the t109 game run reported
 * `merge_commit ae41796`, the bench's `main` stayed where it was, and a person
 * typed `git merge --ff-only ticket-1` by hand before `testar` could open
 * (`notas/2026-08-17-t109-game-feature.md`, gap 3).
 *
 * The repositories here are REAL, cut per test into a scratch directory: what
 * is being asserted is what git does — a fast-forward that is possible, one
 * that is not, a branch that is not the main line — and a faked `git` would
 * only prove this package's opinion of it. Same discipline
 * `test/controller/factory-graph-software.e2e.test.ts` already applies to the
 * bench it reads.
 *
 * **The one seam is `onGitCommand`**, and it exists for AT6: "never a `git
 * stash`" is a claim about the commands ISSUED, and the only honest way to
 * assert it is to look at them. It observes and cannot change anything.
 *
 * English per the 2026-08-18 language rule.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type * as AdvanceMainLineModule from '../../src/dispatch/advance-main-line.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/advance-main-line.ts';

let cache: typeof AdvanceMainLineModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this directory already uses: in the red phase the
 * failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadModule(): Promise<typeof AdvanceMainLineModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/advance-main-line.ts', import.meta.url).href
  )) as typeof AdvanceMainLineModule;
  return cache;
}

/** One git command, run to completion, with its output trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** Identity of every commit these fixtures make. */
function identify(repoRoot: string): void {
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t273');
}

/** The two checkouts one advance touches, and the commits that matter in them. */
interface Scratch {
  /** Where the work is cut from and where the integrated commit was born. */
  repoRoot: string;
  /** The shared checkout the gate nodes observe — what this ficha advances. */
  benchPath: string;
  /** Where the bench's `main` starts, so "it did not move" can be asserted. */
  base: string;
  /**
   * What an integration would have reported.
   *
   * On a BRANCH of `repoRoot`, with `main` there left deliberately behind: the
   * manifest's own description says `merge_commit` is NOT a claim that the main
   * line already points there, and a fixture whose main had already moved would
   * prove nothing about who advances it.
   */
  integrated: string;
}

/** The file the integrated commit brings, read by AT4 to pin the ordering. */
const INTEGRATED_FILE = 'INTEGRATED.md';
const INTEGRATED_TEXT = 'the work the ticket integrated\n';

/** A main repository, a bench cloned off it, and one commit to advance to. */
function scratch(t: TestContext): Scratch {
  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t273-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repoRoot = path.join(root, 'principal');
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  identify(repoRoot);
  writeFileSync(path.join(repoRoot, 'README.md'), '# the main line\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'base');
  const base = git(repoRoot, 'rev-parse', 'main');

  const benchPath = path.join(root, 'banco-de-testes');
  git(root, 'clone', '--quiet', repoRoot, benchPath);
  identify(benchPath);

  git(repoRoot, 'checkout', '--quiet', '-b', 'ticket-273');
  writeFileSync(path.join(repoRoot, INTEGRATED_FILE), INTEGRATED_TEXT);
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'what the integration reconciled');
  const integrated = git(repoRoot, 'rev-parse', 'HEAD');
  git(repoRoot, 'checkout', '--quiet', 'main');

  return { repoRoot, benchPath, base, integrated };
}

test('AT1 — a clean fast-forward moves the bench to the reported commit', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, integrated } = scratch(t);

  const advance = createMainLineAdvancer({ testBenchPath: benchPath, repoRoot });
  await advance(integrated);

  assert.equal(
    git(benchPath, 'rev-parse', 'main'),
    integrated,
    'the bench observes the integrated commit, with nobody having typed anything',
  );
  assert.equal(git(benchPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(benchPath, 'status', '--porcelain'), '', 'and the checkout is clean');
  assert.equal(
    readFileSync(path.join(benchPath, INTEGRATED_FILE), 'utf8'),
    INTEGRATED_TEXT,
    'the work really arrived in the working tree the gate nodes read',
  );
});

test('AT2 — a bench on another branch fails closed, naming the branch it found', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, base, integrated } = scratch(t);

  git(benchPath, 'checkout', '--quiet', '-b', 'experimento');

  const advance = createMainLineAdvancer({ testBenchPath: benchPath, repoRoot });
  await assert.rejects(
    async () => {
      await advance(integrated);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('experimento'), `names what it found: ${error.message}`);
      assert.ok(error.message.includes('main'), `and what it expected: ${error.message}`);
      return true;
    },
  );

  assert.equal(git(benchPath, 'rev-parse', 'main'), base, 'and `main` was not touched');
});

test('AT3 — a diverged bench fails closed, and `main` does not move', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, integrated } = scratch(t);

  // Work of its own, committed on the bench's `main`: the integrated commit is
  // no longer an ancestor's descendant, so there is no fast-forward to make.
  writeFileSync(path.join(benchPath, 'LOCAL.md'), 'somebody committed straight into the bench\n');
  git(benchPath, 'add', '.');
  git(benchPath, 'commit', '--quiet', '-m', 'diverged');
  const diverged = git(benchPath, 'rev-parse', 'main');

  const advance = createMainLineAdvancer({ testBenchPath: benchPath, repoRoot });
  await assert.rejects(
    async () => {
      await advance(integrated);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes('merge') && error.message.includes('--ff-only'),
        `the command that refused is quoted: ${error.message}`,
      );
      return true;
    },
  );

  assert.equal(
    git(benchPath, 'rev-parse', 'main'),
    diverged,
    'never a rebase, never a forced move, never picking a side',
  );
});

test('AT4 — the install command runs after the merge, and its failure is reported', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, integrated } = scratch(t);

  // It reads the file the merge brought in, so a command that had run BEFORE
  // the fast-forward could not have produced this marker at all.
  await createMainLineAdvancer({
    testBenchPath: benchPath,
    repoRoot,
    installCommand: `cat ${INTEGRATED_FILE} > install-marker.txt`,
  })(integrated);

  assert.equal(
    readFileSync(path.join(benchPath, 'install-marker.txt'), 'utf8'),
    INTEGRATED_TEXT,
    'the bench was prepared, and it was prepared on the ALREADY advanced tree',
  );
});

test('AT4 — ...and an install command that exits non-zero carries its own output', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, integrated } = scratch(t);

  const advance = createMainLineAdvancer({
    testBenchPath: benchPath,
    repoRoot,
    installCommand: 'echo "npm ci: lockfile out of sync" >&2; exit 3',
  });

  await assert.rejects(
    async () => {
      await advance(integrated);
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes('lockfile out of sync'),
        `what it printed is what a person has to read: ${error.message}`,
      );
      assert.ok(error.message.includes('npm ci'), `and the command itself: ${error.message}`);
      return true;
    },
  );
});

test('AT5 — an absent install command is a no-op, and the merge alone succeeds', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, integrated } = scratch(t);

  await createMainLineAdvancer({ testBenchPath: benchPath, repoRoot })(integrated);

  assert.equal(git(benchPath, 'rev-parse', 'main'), integrated);
  assert.equal(
    git(benchPath, 'status', '--porcelain'),
    '',
    'nothing ran in the bench beyond the advance itself',
  );
});

test('AT6 — the git it issues is exactly three commands, and none of them is a stash', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, benchPath, integrated } = scratch(t);

  const issued: string[][] = [];
  await createMainLineAdvancer({
    testBenchPath: benchPath,
    repoRoot,
    onGitCommand: (args) => issued.push([...args]),
  })(integrated);

  assert.deepEqual(issued, [
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['fetch', repoRoot, integrated],
    ['merge', '--ff-only', integrated],
  ]);
  assert.ok(
    !issued.some((args) => args.includes('stash')),
    'the parallel ticket checkouts share ONE stash stack; a pop here would rob another agent',
  );
});

test('AT6 — ...and with the bench inside the repository itself there is no fetch', async (t) => {
  const { createMainLineAdvancer } = await loadModule();
  const { repoRoot, integrated } = scratch(t);

  const issued: string[][] = [];
  await createMainLineAdvancer({
    testBenchPath: repoRoot,
    repoRoot,
    onGitCommand: (args) => issued.push([...args]),
  })(integrated);

  assert.deepEqual(issued, [
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    ['merge', '--ff-only', integrated],
  ]);
  assert.equal(git(repoRoot, 'rev-parse', 'main'), integrated);
});
