/**
 * One git worktree per session (t160).
 *
 * `SessionSpec.workingDir` is the ENTIRE write scope of a session — "the
 * adapter never gives the engine access to a directory beyond
 * `spec.workingDir`" (`docs/formatos/engine-adapter.md`, invariant 7). Until
 * this module existed, every dispatch of this runner produced the same string
 * for it, which is to say: every session, forever, could write into every other
 * session's in-flight state. The first real dogfood run found that out the
 * cheap way — "the session works in the shared checkout; the OPERATOR itself
 * became a concurrent writer (a verification `git checkout` under a live
 * session — harmless by luck)" (`notas/2026-08-15-primeira-execucao.md`, gap
 * #6) — and the flowpilot law it cites (worktree-per-session) is what this
 * module implements.
 *
 * What it does NOT do, on purpose:
 *
 * - it never picks a base ref: the branch is cut from whatever `repoRoot` has
 *   checked out, because no field in the job or graph schema names one yet;
 * - it never reuses a directory. Every `acquire` mints a fresh one, including a
 *   retry of the same job. Kept trees (`release` with `keep: true`) accumulate
 *   until a human or a later ficha prunes them — this module only decides that
 *   they are kept, never how they eventually go away;
 * - it has no default for `repoRoot` nor for `worktreesRoot`. A default
 *   location is a silent guess about which repository a session may write in,
 *   and that is precisely the guess this ficha exists to remove.
 *
 * Filesystem and `git` only: nothing here touches the database, which is the
 * server's alone (D1), and nothing here speaks to the API.
 *
 * English per D18.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** The isolated tree one session runs in. */
export interface SessionWorktree {
  /** Absolute path — what becomes `SessionSpec.workingDir`. */
  path: string;
  /**
   * The branch checked out in it.
   *
   * Returned for the consumer that does not exist yet: the skill-rendering
   * pipeline (t109) has to tell a session which branch it is committing on
   * (`workspace.caminho` of `desenvolver-ticket`, and the reconciliation
   * `integrar-branch` does). Nothing in this ficha reads it.
   */
  branch: string;
}

/**
 * Who hands a session its working directory, and takes it back afterwards.
 *
 * An interface and not just the class below because the dispatch is wired with
 * one of these, and a test that had to `git worktree add` for every case would
 * pay for real git on assertions that are about the dispatch.
 */
export interface WorktreeManager {
  /**
   * The tree for this job's session, ready to be written in.
   *
   * Called BEFORE any engine session opens; a rejection stops the dispatch
   * while stopping it is still free.
   */
  acquire(jobId: number): Promise<SessionWorktree>;

  /**
   * Gives the tree back.
   *
   * `keep: true` removes nothing — a session that did not end well is diagnosed
   * from the directory it left behind, and there is no second chance to look at
   * it once it is gone.
   */
  release(worktree: SessionWorktree, outcome: { keep: boolean }): Promise<void>;
}

/**
 * A worktree could not be created or removed.
 *
 * The message carries the command and what it printed on stderr, because that
 * is what a human needs to fix it: "fatal: not a git repository" and
 * "is already checked out" are two completely different mornings.
 */
export class WorktreeError extends Error {
  /** The command that failed, as it was issued. */
  readonly command: string;
  /** What it printed on stderr, trimmed. */
  readonly stderr: string;

  constructor(summary: string, command: string, stderr: string) {
    const detail = stderr.trim();
    super(`${summary}: \`${command}\` failed — ${detail === '' ? '(no output)' : detail}`);
    this.name = 'WorktreeError';
    this.command = command;
    this.stderr = detail;
  }
}

/** Where the real manager cuts worktrees from, and where it puts them. */
export interface GitWorktreeManagerOptions {
  /** The repository the sessions work on. Both a git working tree and a path. */
  repoRoot: string;
  /** Directory the session trees are created under. Created if absent. */
  worktreesRoot: string;
}

/** Exit code reported when `git` itself could not be executed. */
const SPAWN_FAILURE = -1;

/** Bytes of randomness in a directory name. */
const SUFFIX_BYTES = 4;

/** What one `git` invocation answered. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs git in a repository and reports what happened, never throwing.
 *
 * A non-zero exit is data here, not an exception: `show-ref --verify` answers
 * "the branch is not there" with exit 1, and a caller that had to catch that
 * would be catching an ordinary answer.
 *
 * @param repoRoot Repository the command runs against.
 * @param args The command, minus `git -C <repoRoot>`.
 * @returns Exit code and both streams.
 */
function runGit(repoRoot: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr });
        return;
      }
      // A process that exited non-zero reports a numeric `code`; a `git` that
      // could not be spawned at all reports a string one (`ENOENT`) and says
      // what happened only in its message.
      const code = typeof error.code === 'number' ? error.code : SPAWN_FAILURE;
      resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
    });
  });
}

/** The command, as a human would have typed it, for the error message. */
function describe(repoRoot: string, args: readonly string[]): string {
  return ['git', '-C', repoRoot, ...args].join(' ');
}

/**
 * The real manager: one `git worktree` per session, on a branch per job.
 *
 * @example
 * const worktrees = new GitWorktreeManager({
 *   repoRoot: '/srv/projects/cartografo',
 *   worktreesRoot: '/srv/worktrees/cartografo',
 * });
 */
export class GitWorktreeManager implements WorktreeManager {
  readonly #repoRoot: string;
  readonly #worktreesRoot: string;

  constructor(options: GitWorktreeManagerOptions) {
    this.#repoRoot = options.repoRoot;
    this.#worktreesRoot = options.worktreesRoot;
  }

  /**
   * Creates the session's tree on `ticket-<jobId>`.
   *
   * A fresh directory every time, so a retry never inherits the half-written
   * state of the attempt that failed — while landing on the SAME branch, which
   * is where the work of that job accumulates across attempts.
   *
   * `--force` on both spellings of `worktree add` is what keeps a tree kept for
   * diagnosis from wedging its own job forever: git refuses to check a branch
   * out twice, and the kept tree still has it checked out.
   *
   * @param jobId The work being dispatched.
   * @returns The directory and the branch in it.
   * @throws {WorktreeError} The root could not be created, or git refused.
   */
  async acquire(jobId: number): Promise<SessionWorktree> {
    const branch = `ticket-${jobId}`;
    const target = path.join(
      this.#worktreesRoot,
      `${branch}-${randomBytes(SUFFIX_BYTES).toString('hex')}`,
    );

    try {
      mkdirSync(this.#worktreesRoot, { recursive: true });
    } catch (error) {
      throw new WorktreeError(
        `the worktrees root of job ${jobId} could not be created`,
        `mkdir -p ${this.#worktreesRoot}`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Two spellings of one command, chosen by whether the branch is already
    // there: `-b` CREATES it (the first dispatch of this job), and the bare
    // form checks the existing one out (every dispatch after that). Asking git
    // first, rather than trying one and reading the failure, is what keeps a
    // real error — a repository that is not one — from looking like a branch
    // that merely exists.
    const known = await runGit(this.#repoRoot, [
      'show-ref',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]);
    const args =
      known.code === 0
        ? ['worktree', 'add', '--force', target, branch]
        : ['worktree', 'add', '--force', '-b', branch, target];

    const added = await runGit(this.#repoRoot, args);
    if (added.code !== 0) {
      // Nothing half-created survives a failure: the next attempt has to find a
      // clean root, and a directory git gave up on midway is not one.
      rmSync(target, { recursive: true, force: true });
      throw new WorktreeError(
        `the worktree of job ${jobId} could not be created`,
        describe(this.#repoRoot, args),
        added.stderr,
      );
    }

    return { path: target, branch };
  }

  /**
   * Removes the tree, or leaves it exactly as the session left it.
   *
   * `--force` on the removal because cleanup discards scratch: an uncommitted
   * file is the ordinary end of a session, and committed work already lives in
   * the branch's history no matter what happens to this directory.
   *
   * @param worktree What {@link acquire} handed out.
   * @param outcome `keep: true` removes nothing at all.
   * @throws {WorktreeError} git refused to remove it.
   */
  async release(worktree: SessionWorktree, outcome: { keep: boolean }): Promise<void> {
    if (outcome.keep) return;

    const args = ['worktree', 'remove', worktree.path, '--force'];
    const removed = await runGit(this.#repoRoot, args);
    if (removed.code !== 0) {
      throw new WorktreeError(
        `the worktree of branch ${worktree.branch} could not be removed`,
        describe(this.#repoRoot, args),
        removed.stderr,
      );
    }
  }
}
