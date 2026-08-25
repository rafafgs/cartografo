/**
 * One git worktree per session (t160).
 *
 * `SessionSpec.workingDir` is the ENTIRE write scope of a session — "the
 * adapter never gives the engine access to a directory beyond
 * `spec.workingDir`" (`docs/formats/engine-adapter.md`, invariant 7). Until
 * this module existed, every dispatch of this runner produced the same string
 * for it, which is to say: every session, forever, could write into every other
 * session's in-flight state. The first real dogfood run found that out the
 * cheap way — "the session works in the shared checkout; the OPERATOR itself
 * became a concurrent writer (a verification `git checkout` under a live
 * session — harmless by luck)" (`notas/2026-08-15-first-execution.md`, gap
 * #6) — and the flowpilot law it cites (worktree-per-session) is what this
 * module implements.
 *
 * What it does NOT do, on purpose:
 *
 * - it never picks a base ref: the branch is cut from whatever `repoRoot` has
 *   checked out, because no field in the job or graph schema names one yet;
 * - it never reuses a directory. Every `acquire` mints a fresh one, including a
 *   retry of the same job. Kept trees — `release` with `keep: true`, and since
 *   t207 also a tree whose session left uncommitted work in it — accumulate
 *   until a human or `cartografo-runner prune` takes them away; this module only
 *   decides that they are kept, never how they eventually go away;
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
   * pipeline (t109) has to tell a session which branch it is committing on —
   * the branch `develop-ticket` commits on, and the reconciliation
   * `integrate-branch` does. Nothing in this ficha reads it.
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
   *
   * `keep: false` is a REQUEST and not an order (t207): a manager may find work
   * in the tree that exists nowhere else and retain it anyway. That is what the
   * answer is for — the caller cannot tell "removed" from "retained" by looking
   * at anything else, and a caller that assumed removal is exactly how a
   * session's uncommitted output used to disappear in silence.
   *
   * @returns `kept: true` when the directory is still on disk after this call.
   */
  release(worktree: SessionWorktree, outcome: { keep: boolean }): Promise<{ kept: boolean }>;
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
   * Until t207 the removal ran on the premise that "committed work already
   * lives in the branch's history no matter what happens to this directory".
   * That premise is only true while the session committed, and nothing enforces
   * that it did: a skill that forgot the `git commit`, or a node whose contract
   * never asked for one, ends `completed` with its whole output sitting here
   * untracked — and `--force` used to throw it away without anybody being told.
   *
   * So a removal now asks `git status --porcelain` first, and a dirty tree is
   * RETAINED. The judgement of what that means belongs to whoever called: this
   * module still only decides that a tree is kept, never why or for how long
   * (the header's own rule).
   *
   * `--force` survives on the removal path. What it covers is not the dirt —
   * there is none left by the time it runs — but the ordinary refusals git
   * raises about a tree it has its own opinion of, and losing it would turn a
   * clean cleanup into a failure on the machine of whoever has a `.gitignore`.
   *
   * @param worktree What {@link acquire} handed out.
   * @param outcome `keep: true` removes nothing at all.
   * @returns `kept: true` when the directory is still there afterwards.
   * @throws {WorktreeError} git refused to remove it, or could not report on it.
   */
  async release(
    worktree: SessionWorktree,
    outcome: { keep: boolean },
  ): Promise<{ kept: boolean }> {
    if (outcome.keep) return { kept: true };

    // In the worktree and not in `repoRoot`: what is being asked about is what
    // THIS session left behind, and the repository the tree was cut from has a
    // status of its own that has nothing to do with it.
    const statusArgs = ['status', '--porcelain'];
    const status = await runGit(worktree.path, statusArgs);
    if (status.code !== 0) {
      // A git that cannot answer is not an answer: treating the failure as
      // "clean" would delete on exactly the reading this check exists to make,
      // and treating it as "dirty" would silently retain every tree the moment
      // git broke. It is a fault, and it is reported as one.
      throw new WorktreeError(
        `the worktree of branch ${worktree.branch} could not be inspected before removal`,
        describe(worktree.path, statusArgs),
        status.stderr,
      );
    }
    if (status.stdout.trim() !== '') return { kept: true };

    const args = ['worktree', 'remove', worktree.path, '--force'];
    const removed = await runGit(this.#repoRoot, args);
    if (removed.code !== 0) {
      throw new WorktreeError(
        `the worktree of branch ${worktree.branch} could not be removed`,
        describe(this.#repoRoot, args),
        removed.stderr,
      );
    }

    return { kept: false };
  }
}

/**
 * Gives ONE session's tree back, exactly once, whatever path the dispatch
 * leaves by (t160, t207-B; extracted from `dispatch.ts` in t272).
 *
 * It was three `let`s and a closure inside the orchestrator, and it moved here
 * for the reason every earlier split of that file ran under: the ORDER the
 * release happens in is the sequence and stays there, but the mechanism — once,
 * remember what was answered, never throw — is about worktrees and belongs next
 * to the manager it calls. Nothing was renamed and nothing changed: the two
 * call sites still decide when to release and with which fate.
 */
export class WorktreeRelease {
  readonly #manager: WorktreeManager;
  readonly #worktree: SessionWorktree;
  #released = false;
  #keptByManager: boolean | null = null;
  #failure: unknown = null;

  constructor(manager: WorktreeManager, worktree: SessionWorktree) {
    this.#manager = manager;
    this.#worktree = worktree;
  }

  /**
   * What the manager ANSWERED, when it answered at all (t207-B).
   *
   * `null` while no release has completed — including a release that threw.
   * That distinction is the point: a `true` here is the manager saying "I looked
   * and I kept it", which is what a completed session's work gets blocked over,
   * and a release that blew up is a fault with an owner already
   * ({@link failure}). Collapsing the two would block a work over a broken
   * `git`.
   */
  get keptByManager(): boolean | null {
    return this.#keptByManager;
  }

  /** What a release that blew up left behind, or `null`. */
  get failure(): unknown {
    return this.#failure;
  }

  /**
   * Hands the tree back, if it has not been handed back already.
   *
   * Idempotent because the dispatch's paths overlap on purpose: the terminal
   * path releases with the fate the outcome earned, and its catch releases
   * whatever it finds still held — including what the terminal path already
   * handed over on its way to throwing. The failure is captured and never thrown
   * from here, exactly as the dispatch's denial and closure faults are: a
   * cleanup that could not be done is a fault worth reporting, never a reason to
   * replace the error already unwinding with a symptom of it.
   *
   * @param keep What to ASK for — a request the manager may refuse (t207-B).
   */
  async release(keep: boolean): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      this.#keptByManager = (await this.#manager.release(this.#worktree, { keep })).kept;
    } catch (error) {
      this.#failure = error;
    }
  }
}
