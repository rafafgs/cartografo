/**
 * `cartografo-runner prune` — the GC of retained worktrees and `ticket-N`
 * branches (t207-C).
 *
 * `session-worktree.ts` has named this command in its own header since t160:
 * "Kept trees... accumulate until a human or a later ficha prunes them — this
 * module only decides that they are kept, never how they eventually go away."
 * Since t207-B there is a second way for a tree to be kept — a session that
 * finished with work it never committed — so the pile grows on the ordinary
 * path too, not only on the failing one.
 *
 * Four rules hold this command together, and each of them has a plausible
 * opposite that would be wrong:
 *
 * - **The control plane decides what is finished, never this command** (D1).
 *   Eligibility is `completed === true` on `GET /v1/jobs/:id` and nothing else.
 *   `blocked` is NOT a terminal state: a blocked work can be unblocked and
 *   continue on the same node, with a fresh tree, and pruning its branch would
 *   take the work with it.
 * - **`git branch -d`, never `-D`.** `completed` says the traversal reached a
 *   final node of the graph. It says nothing whatsoever about whether the
 *   branch's commits were merged anywhere, and those two facts are independent.
 *   `-d` is the spelling that refuses to discard unmerged history; a refusal is
 *   an ordinary result of this command, reported and not counted as a failure.
 * - **Two sources of candidates, not one.** Most jobs that end cleanly leave no
 *   directory at all — `release` removed it — and a directory-only sweep would
 *   never reach their branches, which is most of what this command exists to
 *   collect.
 * - **Anything unrecognized is reported and left alone.** A directory whose name
 *   does not parse, or that git does not register as a worktree, is somebody
 *   else's; this command has no business deleting it, and no business staying
 *   quiet about it either.
 *
 * A note on the name: `git worktree prune` is a different command with the same
 * word in it. Git's own reconciles a worktree whose directory was deleted BY
 * HAND, leaving an orphan registration behind. That case is real and this
 * command does not cover it — folding it in here without a decision would be
 * two jobs behind one name.
 *
 * English per D18.
 */

import { execFile } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_REQUEST_TIMEOUT_MS } from '../controller/http-client.ts';
import {
  DEFAULT_CONTROL_PLANE_URL,
  TOKEN_ENV,
  URL_ENV,
  UsageError,
  resolveControlPlaneUrl,
  resolveToken,
  resolveWorktreePaths,
} from './index.ts';

/** Directory name of one session worktree, as `GitWorktreeManager` mints it. */
const WORKTREE_DIRECTORY = /^ticket-(\d+)-[0-9a-f]+$/;

/** Branch name of one job, as `GitWorktreeManager` mints it. */
const TICKET_BRANCH = /^ticket-(\d+)$/;

/** Seconds in a day, for the `--older-than` window. */
const DAY_SECONDS = 24 * 60 * 60;

/**
 * The two ways `git branch -d` says "no" without anything being wrong.
 *
 * Both are ordinary results of this command and neither changes the exit code:
 *
 * - **not fully merged** — the reason `-d` is used instead of `-D` at all.
 *   `completed` says the traversal reached a final node, which is independent
 *   of where the commits ended up, and discarding them would be this command
 *   destroying the only thing it was collecting around.
 * - **used by worktree** — the branch is checked out in a directory this run
 *   did not remove, which is what happens when it lives outside
 *   `--worktrees-root`: an operator's own checkout, or a root that was moved.
 *   The layout is somebody's choice and not a fault, and a prune on a cron that
 *   went red over it would be a prune nobody leaves running.
 *
 * Matched on the TEXT, which is why `runGit` pins `LC_ALL=C`.
 */
const ORDINARY_REFUSAL = /not fully merged|used by worktree/i;

/** Usage text. The same in `--help` (stdout) and on a wrong command line (stderr). */
export const PRUNE_USAGE = `usage: cartografo-runner prune [options]

Collects what finished work leaves behind: the session worktrees still on disk
and the \`ticket-<id>\` branches of jobs the control plane reports as concluded.
Nothing that is still in flight is touched, and a branch nobody merged is never
discarded.

options:
  --url <url>               control plane to ask (env ${URL_ENV};
                            default ${DEFAULT_CONTROL_PLANE_URL})
  --token <token>           credential of the control plane (env ${TOKEN_ENV})
  --working-dir <path>      the git repository the worktrees were cut from
                            (default: the current directory)
  --worktrees-root <path>   REQUIRED: directory those worktrees live under. A
                            SIBLING of --working-dir, never inside it
  --older-than <days>       only collect what has been sitting there for at
                            least this many days (default: no age filter — the
                            control plane's status is the only gate)
  --dry-run                 print what would be collected and touch nothing
  --request-timeout-ms <n>  how long any one call to the control plane may take
                            (default ${DEFAULT_REQUEST_TIMEOUT_MS})
  -h, --help                this text

Only --url and --token read an environment variable.

exit codes: 0 it ran, whether or not there was anything to collect; 1 the
control plane could not be reached at all, or a removal that should have worked
failed; 2 the command line is wrong. A branch kept because it is not fully
merged is an ordinary result and does not change the exit code.`;

/** Every option this subcommand takes a value for. */
const VALUE_OPTIONS = [
  '--url',
  '--token',
  '--working-dir',
  '--worktrees-root',
  '--older-than',
  '--request-timeout-ms',
] as const;

/** Every option that is a bare flag. */
const FLAG_OPTIONS = ['--dry-run'] as const;

/** What one prune run decided before it touched anything. */
export interface PruneOptions {
  /** Control plane to ask, with no trailing slash. */
  url: string;
  /** Credential presented on every call, when there is one. */
  token?: string;
  /** The repository the worktrees were cut from, absolute. */
  repoRoot: string;
  /** The directory they live under, absolute. */
  worktreesRoot: string;
  /** Age window in days; `0` means no age filter at all. */
  olderThanDays: number;
  /** Print what would happen and touch nothing. */
  dryRun: boolean;
  /** Deadline of one call to the control plane. */
  requestTimeoutMs: number;
}

/** Test seams of the subcommand. Production passes none of them. */
export interface PruneSeams {
  /** What performs the requests. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** The clock the age window is measured against. Default: `Date.now`. */
  now?: () => number;
  /**
   * Where the report goes, one line at a time. Default: `process.stdout`.
   *
   * A seam and not a global the tests patch: this command reports line by line
   * while it awaits git and the control plane, and a test that swapped
   * `process.stdout.write` for the duration would swallow whatever the test
   * runner itself printed in that window.
   */
  out?: (line: string) => void;
  /** Where a failure line goes. Default: `process.stderr`. */
  err?: (line: string) => void;
}

/**
 * Reads the command line into `--name` → value, refusing anything else.
 *
 * The same reader `parseRunnerOptions` uses, with the one difference this
 * subcommand needs: a bare flag (`--dry-run`) carries no value, so it is
 * recognized separately rather than made to swallow the next argument.
 *
 * @param args The subcommand's arguments — `prune` already removed.
 * @returns The value of each option that was given; a bare flag maps to `''`.
 * @throws {UsageError} On an unknown option, a stray argument or a missing value.
 */
function readOptions(args: string[]): Map<string, string> {
  const given = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);

    if ((FLAG_OPTIONS as readonly string[]).includes(name)) {
      if (equals !== -1) throw new UsageError(`${name} takes no value`);
      given.set(name, '');
      continue;
    }

    if (!(VALUE_OPTIONS as readonly string[]).includes(name)) {
      throw new UsageError(`does not understand "${argument}"`);
    }

    let value: string | undefined;
    if (equals === -1) {
      value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${name} needs a value`);
      }
      index += 1;
    } else {
      value = argument.slice(equals + 1);
    }

    if (value === '') throw new UsageError(`${name} needs a value`);
    given.set(name, value);
  }

  return given;
}

/**
 * Reads an option that has to be a non-negative integer.
 *
 * Non-negative and not positive, unlike the runner's own reader: `0` is a
 * meaningful value for `--older-than` — it spells "no age filter" explicitly,
 * which is what leaving the flag out already means.
 */
function nonNegativeInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new UsageError(`${name} has to be a non-negative integer (got: "${raw}")`);
  }
  return parsed;
}

/**
 * Turns a command line into the decision the run executes.
 *
 * Exported for the tests, and not only for them: this is the whole of what the
 * subcommand decides, and it decides it without touching the network or the
 * disk.
 *
 * @param args The subcommand's arguments — `prune` already removed.
 * @param env Process environment.
 * @returns Everything one prune run needs to know.
 * @throws {UsageError} On any command line this subcommand cannot read.
 */
export function parsePruneOptions(args: string[], env: NodeJS.ProcessEnv): PruneOptions {
  const given = readOptions(args);

  // The SAME function the runner uses, imported and not copied: a prune pointed
  // at a root the runner would have refused is a prune sweeping a directory no
  // session was ever allowed to write in (`index.ts`).
  const { repoRoot, worktreesRoot } = resolveWorktreePaths(
    given.get('--working-dir'),
    given.get('--worktrees-root'),
  );

  const token = resolveToken(given.get('--token'), env);
  return {
    url: resolveControlPlaneUrl(given.get('--url'), env),
    ...(token === undefined ? {} : { token }),
    repoRoot,
    worktreesRoot,
    olderThanDays: nonNegativeInteger('--older-than', given.get('--older-than'), 0),
    dryRun: given.has('--dry-run'),
    requestTimeoutMs: nonNegativeInteger(
      '--request-timeout-ms',
      given.get('--request-timeout-ms'),
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  };
}

/** What one `git` invocation answered. */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Exit code reported when `git` itself could not be executed. */
const SPAWN_FAILURE = -1;

/**
 * Runs git in a directory and reports what happened, never throwing.
 *
 * A non-zero exit is data here and not an exception, the same posture
 * `session-worktree.ts` takes: `branch -d` answers "this is not merged" with an
 * exit code, and that is an ordinary answer this command has to read rather
 * than catch.
 *
 * `LC_ALL=C` because one of those answers is read as TEXT: git's refusal to
 * delete an unmerged branch is distinguishable from a real failure only by what
 * it says, and a translated message would turn an expected result into an exit
 * code 1 on somebody's machine and not on ours.
 */
function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
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

/** One job's worth of prunable leftovers, from both sources at once. */
interface Candidate {
  jobId: number;
  /** The session directory still on disk, when there is one. */
  directory: string | null;
  /** The `ticket-<id>` branch, when the ref still exists. */
  branch: string | null;
}

/**
 * What `GET /v1/jobs/:id` gives back, in the part this command reads.
 *
 * The names are `WireJob`'s (`packages/core/src/repositories/job.ts`), which is
 * the shape the route really answers since t226 renamed the wire. Until t254
 * this interface declared `bloqueado`/`concluido`, and TypeScript had no way to
 * say so: the body arrives as `unknown` and is asserted into this type, so both
 * reads were `undefined` on every job and every candidate looked unfinished
 * forever. The command was a no-op that reported "not concluded" about work
 * that had finished weeks earlier.
 */
interface JobStatus {
  blocked: boolean;
  completed: boolean;
}

/**
 * A path as the filesystem really spells it, for comparing against git's.
 *
 * macOS hands out `/var/folders/...` temp directories that git reports back as
 * `/private/var/folders/...`; without this, every worktree of a temp root would
 * look unregistered and the command would refuse to collect anything.
 */
function canonical(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The session directories under the root, paired with the job they belong to.
 *
 * Two conditions, both required: the name has to parse as one this system
 * minted, AND git has to agree that the directory is a worktree of this
 * repository. Everything else is reported to the caller and never touched.
 */
function scanDirectories(
  worktreesRoot: string,
  registered: ReadonlySet<string>,
): { found: Map<number, string>; ignored: string[] } {
  const found = new Map<number, string>();
  const ignored: string[] = [];

  let entries;
  try {
    entries = readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    // A root that does not exist is a runner that never dispatched, not a
    // failure: there is simply nothing on disk to collect.
    return { found, ignored };
  }

  for (const entry of entries) {
    const target = path.join(worktreesRoot, entry.name);
    if (!entry.isDirectory()) {
      ignored.push(`${target} (not a directory)`);
      continue;
    }

    const match = WORKTREE_DIRECTORY.exec(entry.name);
    if (match === null) {
      ignored.push(`${target} (not a ticket-<id>-<hex> directory)`);
      continue;
    }
    if (!registered.has(canonical(target))) {
      ignored.push(`${target} (not registered as a git worktree)`);
      continue;
    }

    found.set(Number(match[1]), target);
  }

  return { found, ignored };
}

/** The worktree paths git itself registers for this repository, canonicalized. */
async function registeredWorktrees(repoRoot: string): Promise<Set<string>> {
  const listed = await runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const paths = new Set<string>();
  if (listed.code !== 0) return paths;

  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    paths.add(canonical(line.slice('worktree '.length).trim()));
  }
  return paths;
}

/** The `ticket-<id>` branches of this repository, paired with the job id. */
async function scanBranches(repoRoot: string): Promise<Map<number, string>> {
  const listed = await runGit(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads/ticket-*',
  ]);
  const found = new Map<number, string>();
  if (listed.code !== 0) return found;

  for (const line of listed.stdout.split('\n')) {
    const name = line.trim();
    const match = TICKET_BRANCH.exec(name);
    if (match !== null) found.set(Number(match[1]), name);
  }
  return found;
}

/** Seconds since the epoch of a branch's tip commit, or `null` if git would not say. */
async function branchTipSeconds(repoRoot: string, branch: string): Promise<number | null> {
  const shown = await runGit(repoRoot, ['log', '-1', '--format=%ct', branch]);
  if (shown.code !== 0) return null;
  const seconds = Number(shown.stdout.trim());
  return Number.isFinite(seconds) ? seconds : null;
}

/** What the run collected, or would have. */
interface Tally {
  worktrees: number;
  branches: number;
  leftAlone: number;
  /** A removal that should have worked and did not — the only thing that is a 1. */
  failures: number;
}

/**
 * Runs the prune and returns the exit code.
 *
 * @param options What the command line decided.
 * @param seams Test seams; production passes nothing.
 * @returns Exit code: `0` it ran, `1` the control plane was unreachable or a
 *   removal really failed.
 */
export async function runPrune(options: PruneOptions, seams: PruneSeams = {}): Promise<number> {
  const write =
    seams.out ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const doFetch = seams.fetchImpl ?? fetch;
  const nowSeconds = (seams.now ?? Date.now)() / 1000;
  const cutoff = options.olderThanDays > 0 ? nowSeconds - options.olderThanDays * DAY_SECONDS : null;

  const registered = await registeredWorktrees(options.repoRoot);
  const { found: directories, ignored } = scanDirectories(options.worktreesRoot, registered);
  const branches = await scanBranches(options.repoRoot);

  const tally: Tally = { worktrees: 0, branches: 0, leftAlone: ignored.length, failures: 0 };
  for (const line of ignored) write(`left alone: ${line}`);

  const candidates: Candidate[] = [...new Set([...directories.keys(), ...branches.keys()])]
    .sort((left, right) => left - right)
    .map((jobId) => ({
      jobId,
      directory: directories.get(jobId) ?? null,
      branch: branches.get(jobId) ?? null,
    }));

  if (candidates.length === 0) {
    write('prune: nothing to collect');
    return 0;
  }

  /**
   * Whether the control plane answered AT ALL, for any candidate.
   *
   * The distinction the exit codes rest on: one job that could not be looked up
   * is skipped and the run carries on (FR4), while a control plane that
   * answered nobody is a run that decided nothing and must not read as a
   * successful sweep of an empty board.
   */
  let answeredSomething = false;

  const eligible: Candidate[] = [];
  for (const candidate of candidates) {
    let status: JobStatus | null = null;
    try {
      const response = await doFetch(`${options.url}/v1/jobs/${candidate.jobId}`, {
        headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      answeredSomething = true;
      if (response.ok) {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null) status = body as JobStatus;
      }
    } catch {
      // One id's failure never ends the run: the next candidate may be exactly
      // the one somebody is waiting to have collected.
    }

    if (status?.completed !== true) {
      const why =
        status === null
          ? 'the control plane did not answer for it'
          : status.blocked
            ? 'blocked, which is not a terminal state'
            : 'not concluded';
      write(`left alone: job ${candidate.jobId} (${why})`);
      tally.leftAlone += 1;
      continue;
    }

    eligible.push(candidate);
  }

  if (!answeredSomething) return 1;

  for (const candidate of eligible) {
    // The directory FIRST, and the branch after it: git refuses to delete a
    // branch a worktree still has checked out, so the other order would refuse
    // every branch this command exists to collect.
    if (candidate.directory !== null) {
      if (cutoff !== null && statSync(candidate.directory).mtimeMs / 1000 > cutoff) {
        write(
          `left alone: ${candidate.directory} (touched less than ${options.olderThanDays} day(s) ago)`,
        );
        tally.leftAlone += 1;
      } else if (options.dryRun) {
        write(`would remove worktree: ${candidate.directory} (job ${candidate.jobId})`);
        tally.worktrees += 1;
      } else {
        const args = ['worktree', 'remove', candidate.directory, '--force'];
        const removed = await runGit(options.repoRoot, args);
        if (removed.code === 0) {
          write(`removed worktree: ${candidate.directory} (job ${candidate.jobId})`);
          tally.worktrees += 1;
        } else {
          write(`FAILED to remove worktree ${candidate.directory}: ${removed.stderr.trim()}`);
          tally.failures += 1;
          // The branch is not attempted: it is still checked out in a directory
          // that is still there, and git would refuse it for a reason that has
          // nothing to do with whether it was merged.
          continue;
        }
      }
    }

    if (candidate.branch === null) continue;

    if (cutoff !== null) {
      const tip = await branchTipSeconds(options.repoRoot, candidate.branch);
      if (tip !== null && tip > cutoff) {
        write(
          `left alone: branch ${candidate.branch} (tip commit less than ${options.olderThanDays} day(s) old)`,
        );
        tally.leftAlone += 1;
        continue;
      }
    }

    if (options.dryRun) {
      write(`would delete branch: ${candidate.branch}`);
      tally.branches += 1;
      continue;
    }

    // `-d` and never `-D`: this is the line that refuses to discard history
    // nobody merged. `completed` means the traversal reached a final node of the
    // graph, which is independent of where those commits ended up.
    const deleted = await runGit(options.repoRoot, ['branch', '-d', candidate.branch]);
    if (deleted.code === 0) {
      write(`deleted branch: ${candidate.branch}`);
      tally.branches += 1;
    } else if (ORDINARY_REFUSAL.test(deleted.stderr)) {
      write(`kept branch ${candidate.branch}: ${deleted.stderr.trim()}`);
      tally.leftAlone += 1;
    } else {
      write(`FAILED to delete branch ${candidate.branch}: ${deleted.stderr.trim()}`);
      tally.failures += 1;
    }
  }

  write(
    options.dryRun
      ? `prune (dry run): would remove ${tally.worktrees} worktree(s) and delete ${tally.branches} branch(es); ${tally.leftAlone} left alone`
      : `prune: removed ${tally.worktrees} worktree(s), deleted ${tally.branches} branch(es), left ${tally.leftAlone} alone`,
  );

  return tally.failures > 0 ? 1 : 0;
}

/**
 * Entry point of the subcommand: reads the command line and runs the prune.
 *
 * @param args The subcommand's arguments — `prune` already removed.
 * @param env Process environment.
 * @param seams Test seams; production passes nothing.
 * @returns Exit code.
 */
export async function runPruneCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  seams: PruneSeams = {},
): Promise<number> {
  const write =
    seams.out ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const fail =
    seams.err ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });

  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    write(PRUNE_USAGE);
    return 0;
  }

  let options: PruneOptions;
  try {
    options = parsePruneOptions(args, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    fail(`cartografo-runner: ${error.message} — run \`cartografo-runner prune --help\` for usage`);
    return 2;
  }

  const code = await runPrune(options, { ...seams, out: write });

  if (code === 1) {
    // The two ways to a `1` are both worth a line on stderr, and they read
    // differently: nothing was decided at all, or something that should have
    // worked did not. The report already says which.
    fail(
      `cartografo-runner prune: could not finish against the control plane at ${options.url} — see the report above`,
    );
  }
  return code;
}
