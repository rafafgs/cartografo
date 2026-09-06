#!/usr/bin/env node
/**
 * The working directory `check-intake` is dispatched into, in the suite (t407).
 *
 * The third program under `test/fixtures/`, and the only one that runs BESIDE a
 * session rather than as one. `fake-engine.mjs` stands in for an engine and
 * `shell-node.mjs` stands in for a command; this one stands in for nothing. It
 * prepares a place, and the thing that runs there is real.
 *
 * ## Why a whole checkout, and not a directory
 *
 * `factory-graphs/b3-flow-radar`'s entry node declares `"engine": "shell"` and
 * its pinned skill `check-flow-intake` carries this argv, relative and shipped:
 *
 * ```
 * node factory-graphs/b3-flow-radar/scripts/check-intake.mjs \
 *   {{input.trading_day}} {{input.project.expected_row_counts}}
 * ```
 *
 * t332's traversal could sidestep that question because its shell skill was a
 * throwaway whose argv was rewritten to an absolute path. t407's cannot: the
 * claim it makes is that the bundle crosses with nothing moved by hand, so the
 * manifest is registered verbatim and the relative path has to resolve. It
 * resolves against the session's working directory and nowhere else —
 * `ShellAdapter` spawns with `cwd: spec.workingDir` and enforces nothing about
 * what that directory holds (invariant 7) — so the working directory has to be a
 * tree with the real script and the real `fixtures/day-1/*.json` inside it. The
 * bundle's README says the same thing from the other side: "a job of this class
 * has the cartografo checkout as its working directory, because that is where
 * the data is" (recorded divergence #1).
 *
 * ## Why NOT the checkout the test is running in
 *
 * Because no e2e in this package has ever pointed a spawned child at the live
 * working tree, and this one will not be the first. The software bundle's
 * crossing builds `benchRepository()` — real repositories, disposable ones —
 * for exactly this reason, and the risk here is the same one: a command under
 * test that turns out to write, or a `check-intake.mjs` that changes shape
 * later, must not be able to reach the tree the suite is running from. What it
 * gets instead is a detached worktree of this repository at the same `HEAD`:
 * real script, real fixtures, real row counts, and nothing anybody minds losing.
 *
 * A worktree and not a clone because it is the cheap answer — no object copy, a
 * quarter of a second — and because `git worktree remove` is a real release
 * rather than an `rm -rf` that hopes. What it costs is one entry in the shared
 * repository's own worktree registry for the length of the test, which is why
 * {@link release} verifies the registry is clean again instead of assuming it.
 *
 * ## Why a program and not a module
 *
 * Every `.mjs` under this directory is spawned, never imported, and here that is
 * also what the type gate requires: `allowJs` is off in `tsconfig.base.json`, so
 * an untyped `.mjs` on an `import` line in a `.ts` test fails `tsc --noEmit`.
 *
 * ```
 * node b3-flow-radar-check-intake.mjs prepare          -> {"path": "<absolute>"}
 * node b3-flow-radar-check-intake.mjs release <path>
 * ```
 *
 * `prepare` answers the path with its symlinks already resolved, which is not a
 * detail: on macOS `os.tmpdir()` is a symlink, `process.cwd()` inside the child
 * is not, and a test comparing the two would be comparing two spellings of one
 * directory.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The repository the checkout is cut from: this one. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** Runs git against the repository, and lets a failure be a failure. */
function git(...args) {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

/** Every path the shared repository currently registers as a worktree. */
function registeredWorktrees() {
  return git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * A detached worktree of this repository at `HEAD`, in a temporary directory.
 *
 * Detached on purpose: a named branch would collide with whatever the operator
 * has checked out, and this tree is read, never committed to.
 *
 * @returns {string} Absolute path of the checkout, symlinks resolved.
 */
function prepare() {
  // Resolved BEFORE git ever sees it, so the registry, the answer this prints
  // and `process.cwd()` inside the spawned command are all one spelling.
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'cartografo-t407-checkout-')));
  const checkout = path.join(parent, 'repo');
  git('worktree', 'add', '--detach', '--quiet', checkout, 'HEAD');
  return checkout;
}

/**
 * Gives the checkout back, and proves it went.
 *
 * Tolerant about HOW it goes and strict about WHETHER it went: `git worktree
 * remove` is the clean path, but a run that died mid-test may have left the
 * directory in a state git declines to remove, and a fixture that then left an
 * entry behind would poison every later `git worktree list` in a repository
 * several checkouts share. So a refusal falls through to removing the directory
 * and pruning, and the registry is read back afterwards.
 *
 * @param {string} checkout What {@link prepare} answered.
 */
function release(checkout) {
  try {
    git('worktree', 'remove', '--force', checkout);
  } catch {
    rmSync(checkout, { recursive: true, force: true });
    git('worktree', 'prune');
  }
  rmSync(path.dirname(checkout), { recursive: true, force: true });

  if (registeredWorktrees().includes(checkout)) {
    throw new Error(`the checkout is still registered as a worktree: ${checkout}`);
  }
}

function main(argv) {
  const [verb, target] = argv;

  if (verb === 'prepare') {
    process.stdout.write(`${JSON.stringify({ path: prepare() })}\n`);
    return 0;
  }
  if (verb === 'release') {
    if (target === undefined) {
      process.stderr.write('usage: b3-flow-radar-check-intake.mjs release <path>\n');
      return 2;
    }
    release(target);
    return 0;
  }

  process.stderr.write('usage: b3-flow-radar-check-intake.mjs prepare | release <path>\n');
  return 2;
}

process.exitCode = main(process.argv.slice(2));
