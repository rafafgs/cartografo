/**
 * Who keeps the shared test bench TRUE, after an integration (t273).
 *
 * `integrar-branch`'s own manifest has promised this since the bundle was
 * written — the session never runs the final merge, and it is the EXECUTOR that
 * moves the main line — and until this ficha nobody kept the promise. The t109
 * game run is the whole evidence: the session reported `merge_commit ae41796`
 * with every gate green, the bench's `main` stayed on the commit before it, and
 * a person typed `git merge --ff-only ticket-1` by hand before `testar` could
 * open at all (`notes/2026-08-17-t109-game-feature.md`, gap 3).
 *
 * t270 built the READ half and said so in its own header: it resolves
 * `banco_de_testes.caminho` and `referencia.commit` off a bench it assumes
 * already exists and never writes to. This module is the other half — the one
 * that makes what that read observes worth reading.
 *
 * ## What triggers it is the SHAPE of the report, never a node id
 *
 * Any node whose accepted report carries a non-empty `merge_commit` advances
 * the bench. Not `integrar`, not `integrar-branch`: the field IS the contract
 * (D9), and a second graph whose integration node declares the same output is
 * covered here with no runner change at all. A hardcoded id would have made
 * this module a special case for one bundle, which is exactly what the
 * contract-first convention exists to avoid.
 *
 * ## Fast-forward or nothing
 *
 * Three ways this refuses, and each of them is a bench that would otherwise be
 * observed as something it is not:
 *
 * - the bench is not on the main line — somebody left it on another branch, and
 *   advancing it would move a branch nobody meant;
 * - the fast-forward is not possible — the bench has commits of its own, and
 *   what is asked for is a MERGE. Reconciling is `integrar`'s job, in its own
 *   worktree, with a session behind it; picking a side out here would be a
 *   machine resolving a divergence nobody looked at;
 * - the bench-install command exited non-zero — the checkout moved but is not
 *   usable, and a gate node that ran against it would be measuring the install
 *   failure and calling it a test result.
 *
 * Never a rebase, never `--force`, and never a `git stash`: the parallel ticket
 * checkouts of this project share ONE stash stack, and a pop here would take
 * another agent's work (it is a project-wide rule, and it applies doubly to a
 * directory every integration touches).
 *
 * ## A refusal stops the work; it does not throw
 *
 * Same reading t252 and t265 already wrote down: a git that refuses here
 * refuses identically on every retry — the branch is still wrong, the history
 * is still diverged — so throwing would buy the same answer every two seconds
 * forever, with nothing in anybody's inbox. {@link advanceMainLineForReport}
 * blocks the work with a reason a person can act on and hands that reason back;
 * the caller (`report.ts`'s `advance`) keeps the work exactly where it is.
 *
 * English per the 2026-08-18 language rule; the keys read off a report
 * (`merge_commit`) are the skill manifest format's vocabulary.
 */

import { exec, execFile } from 'node:child_process';

import { blockForMainLineAdvanceFailure, type JobRef } from './blocks.ts';
import type { ControlPlaneCall } from './control-plane-client.ts';
import { parseNodeResult } from './parse-node-result.ts';

/**
 * The bench could not be advanced, or could not be prepared.
 *
 * Same shape as `session-worktree.ts`'s `WorktreeError` and
 * `resolve-executor-environment.ts`'s `ExecutorEnvironmentError`, deliberately:
 * all three are a command that did not do what the runner needed, and whoever
 * reads any of them wants the command as it was issued plus what it printed.
 *
 * The field is `output` and not `stderr`, which is where it differs from those
 * two: the branch check fails on what git printed to STDOUT — the branch name
 * itself — and calling that `stderr` would be a label that lies in the one
 * failure a reader is most likely to hit.
 */
export class MainLineAdvanceError extends Error {
  /** The command that failed, as it was issued. */
  readonly command: string;
  /** What it printed, trimmed — stderr for a failure, stdout for a refusal. */
  readonly output: string;

  constructor(summary: string, command: string, output: string) {
    const detail = output.trim();
    super(`${summary} — \`${command}\` said: ${detail === '' ? '(no output)' : detail}`);
    this.name = 'MainLineAdvanceError';
    this.command = command;
    this.output = detail;
  }
}

/** Everything one runner process needs to know to keep its bench true. */
export interface MainLineAdvancerConfig {
  /**
   * The checkout the gate nodes observe — `--test-bench-path`.
   *
   * The same directory t270 publishes as `input.banco_de_testes.caminho`, and
   * the only one this module writes in. Never a session worktree: those are cut
   * per dispatch and thrown away, and advancing one would move a branch nobody
   * reads.
   */
  testBenchPath: string;
  /**
   * The repository the reported commit was born in — `--working-dir`.
   *
   * Where the objects live: a session works in a worktree of THIS repository,
   * so whatever `integrar` reconciled is in its object store and in no other.
   * When the bench is that same directory there is nothing to fetch.
   */
  repoRoot: string;
  /** The branch the bench has to be on, and the one that moves. Default: `main`. */
  mainBranch?: string;
  /**
   * One shell command that prepares the advanced bench, if the deployment has
   * one — `--bench-install-command`.
   *
   * Optional, and absent contributes nothing: the same posture
   * `resolve-executor-environment.ts` has for `comandos_de_dados`. What it is
   * for is the step every session of the t109 run typed by hand for lack of it
   * (`npm ci --offline`), and the class declares its own spelling of it in the
   * graph's `project.comando_instalacao` — what an operator points this flag at.
   */
  installCommand?: string;
  /**
   * Called with every git invocation, before it runs. Observation seam only.
   *
   * It exists because "this never runs a `git stash`" is a claim about the
   * commands ISSUED, and the only honest way to check a claim like that is to
   * look at them (`test/dispatch/advance-main-line.test.ts`, AT6). It cannot
   * change anything: the arguments are already decided when it is called.
   */
  onGitCommand?: (args: readonly string[]) => void;
}

/**
 * Moves the bench onto one commit, and prepares it.
 *
 * The whole surface `dispatch.ts` is configured with — one function, one
 * argument — so that the layer above it needs to know nothing about git, paths
 * or install commands, and a test at that layer can reject with no repository
 * anywhere.
 */
export type MainLineAdvancer = (mergeCommit: string) => Promise<void>;

/** What a command answered. */
interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Exit code reported when the program itself could not be executed. */
const SPAWN_FAILURE = -1;

/** How much output of the install command is kept before it is cut off. */
const INSTALL_OUTPUT_LIMIT = 10 * 1024 * 1024;

/**
 * Runs git in a repository and reports what happened, never throwing.
 *
 * The same shape `session-worktree.ts` and `resolve-executor-environment.ts`
 * use, and for the same reason: a non-zero exit is data, and deciding what it
 * MEANS belongs to the caller that knows which question it asked.
 *
 * @param repoRoot Repository the command runs against.
 * @param args The command, minus `git -C <repoRoot>`.
 * @param observe Told what is about to run, for the seam above.
 * @returns Exit code and both streams.
 */
function runGit(
  repoRoot: string,
  args: readonly string[],
  observe?: (args: readonly string[]) => void,
): Promise<Ran> {
  observe?.(args);
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

/**
 * Runs the install command through a shell, and reports what happened.
 *
 * A shell and not an argv, because what the operator configures is a COMMAND
 * LINE — `npm ci`, and whatever else a project needs typed after it. It is the
 * operator's own string, from the process's own command line, and it runs with
 * the runner's privileges wherever the bench is: nothing a graph document or a
 * session reports reaches this argument.
 *
 * @param command What to run.
 * @param cwd The already-advanced bench.
 * @returns Exit code and both streams.
 */
function runInstall(command: string, cwd: string): Promise<Ran> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, encoding: 'utf8', maxBuffer: INSTALL_OUTPUT_LIMIT },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : SPAWN_FAILURE;
        resolve({ code, stdout, stderr: stderr === '' ? error.message : stderr });
      },
    );
  });
}

/** The command, as a human would have typed it, for the error message. */
function describe(repoRoot: string, args: readonly string[]): string {
  return ['git', '-C', repoRoot, ...args].join(' ');
}

/**
 * Builds the dispatch's `advanceMainLine` out of one runner's configuration.
 *
 * Built once, for the life of the process, exactly like
 * `createExecutorEnvironmentResolver` beside it: the bench is a fact about the
 * MACHINE, identical for every job this runner takes.
 *
 * @param config The bench, the repository, the branch and the optional command.
 * @returns The function `dispatch.ts` calls with a reported merge commit.
 */
export function createMainLineAdvancer(config: MainLineAdvancerConfig): MainLineAdvancer {
  const mainBranch = config.mainBranch ?? 'main';
  const bench = config.testBenchPath;

  return async (mergeCommit: string): Promise<void> => {
    // FIRST, and it is not merely a precondition: a bench on another branch is
    // a bench somebody is using for something, and `merge --ff-only` there would
    // quietly move THAT branch. Detached `HEAD` answers `HEAD` and is refused
    // by the same comparison, which is the right answer for it too.
    const branchArgs = ['rev-parse', '--abbrev-ref', 'HEAD'];
    const onBranch = await runGit(bench, branchArgs, config.onGitCommand);
    const branch = onBranch.stdout.trim();
    if (onBranch.code !== 0 || branch !== mainBranch) {
      throw new MainLineAdvanceError(
        `the test bench \`${bench}\` is not on the main line \`${mainBranch}\``,
        describe(bench, branchArgs),
        onBranch.code === 0 ? branch : onBranch.stderr,
      );
    }

    // The commit lives in the repository the session's worktree was cut from,
    // and the bench is a different clone with a different object store — so it
    // is fetched by sha, from a path, with no remote and no refspec involved.
    // Skipped when the two are the same directory: there is nothing to fetch
    // from oneself, and asking would be a network-shaped no-op.
    if (bench !== config.repoRoot) {
      const fetchArgs = ['fetch', config.repoRoot, mergeCommit];
      const fetched = await runGit(bench, fetchArgs, config.onGitCommand);
      if (fetched.code !== 0) {
        throw new MainLineAdvanceError(
          `the commit \`${mergeCommit}\` could not be brought into the test bench`,
          describe(bench, fetchArgs),
          fetched.stderr,
        );
      }
    }

    // `--ff-only` is the whole policy. What it refuses is a bench that has
    // commits the reported one does not carry, and that refusal is correct:
    // reconciling two histories is what `integrar` does, with a session, in a
    // worktree of its own.
    const mergeArgs = ['merge', '--ff-only', mergeCommit];
    const merged = await runGit(bench, mergeArgs, config.onGitCommand);
    if (merged.code !== 0) {
      throw new MainLineAdvanceError(
        `the test bench could not be fast-forwarded onto \`${mergeCommit}\``,
        describe(bench, mergeArgs),
        merged.stderr,
      );
    }

    // AFTER the merge and only after it: what the command is for is the tree
    // that just arrived — dependencies of the commit being observed, not of the
    // one before it.
    if (config.installCommand === undefined || config.installCommand === '') return;

    const installed = await runInstall(config.installCommand, bench);
    if (installed.code !== 0) {
      throw new MainLineAdvanceError(
        `the test bench was advanced but could not be prepared (exit ${String(installed.code)})`,
        config.installCommand,
        installed.stderr === '' ? installed.stdout : installed.stderr,
      );
    }
  };
}

/** The message an error carries, whatever it turned out to be. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Advances the bench for a report that named a commit, or stops the work.
 *
 * Called from `report.ts`'s `advance`, ahead of everything it does, so that the
 * two facts cannot come apart: the work may not leave a node whose bench did not
 * move. Putting it there rather than at the orchestrator's call site is what
 * makes that structural instead of remembered.
 *
 * Three ways this is a no-op, and all three are ordinary. No report, or one with
 * no `merge_commit`: every node that is not an integration, which is most of
 * them. No advancer configured: a bets runner has no bench, and neither does a
 * deployment that has not set one up — the same "absent contributes nothing"
 * posture the executor environment already has.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param output Everything the session printed, decoded — the same string the
 *   routing decision reads, parsed the same way, so the two cannot disagree
 *   about what the session said.
 * @param advance What moves the bench, when this runner has one.
 * @returns `null` when the work may go on — the bench moved, or there was
 *   nothing to move it for — and the block's own reason when it stopped.
 */
export async function advanceMainLineForReport(
  call: ControlPlaneCall,
  job: JobRef,
  output: string,
  advance?: MainLineAdvancer,
): Promise<string | null> {
  if (advance === undefined) return null;

  const reported = parseNodeResult(output)?.merge_commit;
  if (typeof reported !== 'string' || reported.trim() === '') return null;

  try {
    await advance(reported.trim());
  } catch (error) {
    return await blockForMainLineAdvanceFailure(call, job, messageOf(error));
  }

  return null;
}
