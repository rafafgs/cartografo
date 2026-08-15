/**
 * Acceptance tests for the per-session worktree (t160, AT1-AT7).
 *
 * The claim under test is the isolation invariant the frozen `EngineAdapter`
 * spells out — "the adapter never gives the engine access to a directory beyond
 * `spec.workingDir`" (`docs/formatos/engine-adapter.md:490-493`, invariant 7).
 * `workingDir` is the ENTIRE write scope of a session, so whoever produces that
 * string decides whether two concurrent sessions can step on each other. Until
 * this ficha every dispatch produced the SAME string, and the first real
 * dogfood run paid for it: "the session works in the shared checkout; the
 * OPERATOR itself became a concurrent writer"
 * (`notas/2026-08-15-primeira-execucao.md`, gap #6).
 *
 * Against a REAL git repository and a real `git worktree`, on purpose: what is
 * being asserted is what git does — a second checkout of a branch already
 * checked out elsewhere (AT7), a commit crossing between two worktrees of the
 * same branch (AT3), a registration disappearing from `worktree list` (AT4).
 * A fake `git` would only prove this module's opinion of git.
 *
 * English per D18; the fixture content is Portuguese, like every other fixture
 * in this package.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as WorktreeModule from '../../src/dispatch/session-worktree.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const WORKTREE_MODULE = 'src/dispatch/session-worktree.ts';

/** The tracked file every fixture repository carries, content and all. */
const TRACKED_FILE = 'README.md';
const TRACKED_CONTENT = '# Repo de fixture da t160\n';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom `dispatch-claude-code.test.ts` already uses: in the red phase the
 * failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadModule(): Promise<typeof WorktreeModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, WORKTREE_MODULE)),
    `artifact does not exist yet: packages/runner/${WORKTREE_MODULE}`,
  );
  return (await import(new URL(`../../${WORKTREE_MODULE}`, import.meta.url).href)) as typeof WorktreeModule;
}

/** Runs git in a directory and gives back its stdout, trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** `true` when the branch exists in the repository. */
function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The worktrees git itself reports, by directory name.
 *
 * By basename and not by full path because macOS hands out `/var/folders/...`
 * temp dirs that git reports back as `/private/var/folders/...`; the random
 * suffix of every acquired directory makes the basename unique anyway.
 */
function registeredWorktrees(repoRoot: string): string[] {
  return git(repoRoot, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.basename(line.slice('worktree '.length)));
}

interface Fixture {
  /** A real git repository with one commit. */
  repoRoot: string;
  /** Where the worktrees go — deliberately NOT created (FR3). */
  worktreesRoot: string;
}

/**
 * A disposable repository plus the (still nonexistent) root its worktrees go in.
 *
 * `worktreesRoot` points inside the same temp base so that one `rmSync` at the
 * end takes the repository, its worktrees and git's registration of them.
 */
function fixture(t: TestHook, label: string): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), `cartografo-t160-${label}-`));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const repoRoot = path.join(base, 'repo');
  mkdirSync(repoRoot);
  git(repoRoot, 'init', '--quiet');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t160');
  writeFileSync(path.join(repoRoot, TRACKED_FILE), TRACKED_CONTENT);
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'inicial');

  return { repoRoot, worktreesRoot: path.join(base, 'worktrees') };
}

test('AT1 — acquire mints a real checkout of the repo on branch ticket-<jobId>', async (t) => {
  const { GitWorktreeManager } = await loadModule();
  const { repoRoot, worktreesRoot } = fixture(t, 'at1');

  // The root does not exist yet: creating it is the manager's job (FR3), and a
  // manager that assumed it fails on the very first dispatch of a fresh runner.
  assert.ok(!existsSync(worktreesRoot), 'the fixture must hand over a root that does not exist');

  const manager = new GitWorktreeManager({ repoRoot, worktreesRoot });
  const worktree = await manager.acquire(160);

  assert.equal(worktree.branch, 'ticket-160', 'the branch is derived from the job id');
  assert.ok(
    worktree.path.startsWith(worktreesRoot + path.sep),
    `the worktree must live under the root it was given: ${worktree.path}`,
  );
  assert.ok(branchExists(repoRoot, 'ticket-160'), 'the branch was never created in the repository');
  assert.equal(git(worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ticket-160');

  // A checkout, not an empty directory: the session has to find the repository
  // it was dispatched against.
  assert.equal(
    readFileSync(path.join(worktree.path, TRACKED_FILE), 'utf8'),
    TRACKED_CONTENT,
    'the worktree does not carry the tracked files of the repository',
  );
});

test('AT2 — two jobs get two trees, and neither can see what the other wrote', async (t) => {
  const { GitWorktreeManager } = await loadModule();
  const { repoRoot, worktreesRoot } = fixture(t, 'at2');
  const manager = new GitWorktreeManager({ repoRoot, worktreesRoot });

  const first = await manager.acquire(160);
  const second = await manager.acquire(161);

  assert.notEqual(first.path, second.path, 'two concurrent sessions on one project got one directory');
  assert.equal(first.branch, 'ticket-160');
  assert.equal(second.branch, 'ticket-161');

  writeFileSync(path.join(first.path, 'rascunho.md'), 'trabalho em voo da sessão 160\n');
  assert.ok(
    !existsSync(path.join(second.path, 'rascunho.md')),
    'one session can see the in-flight state of the other: the isolation this ficha exists for is gone',
  );
});

test('AT3 — a retry of the same job gets a new directory on the same branch, with the history', async (t) => {
  const { GitWorktreeManager } = await loadModule();
  const { repoRoot, worktreesRoot } = fixture(t, 'at3');
  const manager = new GitWorktreeManager({ repoRoot, worktreesRoot });

  const first = await manager.acquire(160);
  const second = await manager.acquire(160);

  assert.notEqual(first.path, second.path, 'a retry must never be handed the directory of the attempt before it');
  assert.equal(second.branch, first.branch, 'the same job is the same branch: that is where its work accumulates');

  // What the first session committed is what the second one continues from —
  // the whole reason a retry keeps the branch instead of minting another.
  const subject = 'trabalho da primeira sessão';
  writeFileSync(path.join(first.path, 'nota.md'), 'o que a primeira sessão fez\n');
  git(first.path, 'add', '.');
  git(first.path, 'commit', '--quiet', '-m', subject);

  assert.ok(
    git(second.path, 'log', '--format=%s').includes(subject),
    'the retry does not see the commit of the session before it',
  );
});

test('AT4 — release without keeping takes the directory and the registration with it', async (t) => {
  const { GitWorktreeManager } = await loadModule();
  const { repoRoot, worktreesRoot } = fixture(t, 'at4');
  const manager = new GitWorktreeManager({ repoRoot, worktreesRoot });

  const worktree = await manager.acquire(160);
  const name = path.basename(worktree.path);
  assert.ok(registeredWorktrees(repoRoot).includes(name));

  // Uncommitted scratch on purpose: cleanup discards it (FR5), and a `remove`
  // without `--force` would refuse exactly here — on the ordinary case of a
  // session that left a file behind.
  writeFileSync(path.join(worktree.path, 'rascunho.md'), 'sujeira não commitada\n');

  await manager.release(worktree, { keep: false });

  assert.ok(!existsSync(worktree.path), 'the directory survived a release that was told not to keep it');
  assert.ok(
    !registeredWorktrees(repoRoot).includes(name),
    'git still registers the worktree: the next `worktree add` inherits a stale entry',
  );
});

test('AT5 — release that keeps leaves everything exactly as the session left it', async (t) => {
  const { GitWorktreeManager } = await loadModule();
  const { repoRoot, worktreesRoot } = fixture(t, 'at5');
  const manager = new GitWorktreeManager({ repoRoot, worktreesRoot });

  const worktree = await manager.acquire(160);
  writeFileSync(path.join(worktree.path, 'diagnostico.md'), 'o que a sessão deixou para trás\n');

  await manager.release(worktree, { keep: true });

  assert.equal(
    readFileSync(path.join(worktree.path, 'diagnostico.md'), 'utf8'),
    'o que a sessão deixou para trás\n',
    'a kept worktree is what a human diagnoses a failed session from',
  );
  assert.ok(
    registeredWorktrees(repoRoot).includes(path.basename(worktree.path)),
    'the worktree left git`s registration: `worktree list` no longer shows a human where to look',
  );
});

test('AT6 — a repoRoot that is not a git repository fails before anything is created', async (t) => {
  const { GitWorktreeManager, WorktreeError } = await loadModule();
  const { worktreesRoot } = fixture(t, 'at6');

  const notARepo = mkdtempSync(path.join(tmpdir(), 'cartografo-t160-at6-plain-'));
  t.after(() => {
    rmSync(notARepo, { recursive: true, force: true });
  });

  const manager = new GitWorktreeManager({ repoRoot: notARepo, worktreesRoot });

  await assert.rejects(
    async () => manager.acquire(160),
    (error: unknown) => {
      assert.ok(error instanceof WorktreeError, `expected WorktreeError, got: ${String(error)}`);
      // What a human needs in order to fix it: the command that failed and what
      // git said about it.
      assert.match(error.message, /git/, `the message names no git command:\n${error.message}`);
      return true;
    },
  );

  assert.deepEqual(
    existsSync(worktreesRoot) ? readdirSync(worktreesRoot) : [],
    [],
    'a failed acquire left a directory behind: the next attempt inherits half a worktree',
  );
});

test('AT7 — a kept worktree does not wedge the next dispatch of the same job', async (t) => {
  const { GitWorktreeManager } = await loadModule();
  const { repoRoot, worktreesRoot } = fixture(t, 'at7');
  const manager = new GitWorktreeManager({ repoRoot, worktreesRoot });

  const failed = await manager.acquire(160);
  await manager.release(failed, { keep: true });

  // The branch is checked out in the kept worktree, which is precisely what git
  // refuses to do twice without `--force` (FR3). Without it, a session kept for
  // diagnosis would block every retry of its own job, forever.
  const retry = await manager.acquire(160);

  assert.notEqual(retry.path, failed.path);
  assert.equal(retry.branch, 'ticket-160');
  assert.equal(
    readFileSync(path.join(retry.path, TRACKED_FILE), 'utf8'),
    TRACKED_CONTENT,
    'the retry got a directory that is not a checkout',
  );
  assert.ok(existsSync(failed.path), 'the kept worktree was removed by the acquire that came after it');
});
