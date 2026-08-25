/**
 * Router of the `cartografo-runner` command (t162, FR2–FR4, FR8).
 *
 * The product's fourth command, and its own binary rather than a subcommand of
 * `cartografo`, for the same reason the screen has one (D11): the runner is
 * another process, on another machine as often as not, holding no privilege
 * over the control plane. Two binaries is what that boundary looks like from
 * the outside.
 *
 * Everything this file does happens before the first packet: it reads a command
 * line, resolves the configuration, and hands `runRunner` a settled decision.
 * A command line it cannot read dies here with a `2` and one line — dialling a
 * control plane to discover that `--project abc` is not a number spends a round
 * trip on something that was knowable at argument zero.
 *
 * The exit-code convention is `packages/core/src/cli/index.ts`'s, unchanged:
 *
 * - `0` — the runner ran and was asked to stop;
 * - `1` — the runner could not run (control plane down, credential refused);
 * - `2` — the command line is wrong.
 *
 * Address precedence, also the core's: `--url` > `CARTOGRAFO_URL` >
 * `http://127.0.0.1:4317`. The default is REDECLARED here and not imported from
 * `@cartografo/core`: the runner imports nothing from the control plane's
 * package (D1), which is the boundary `cliente-controle.ts`'s own header states
 * and `packages/screen/src/router.ts:83-92` already set the precedent for. The
 * price is a constant in two places; the alternative is a package boundary that
 * only holds while nobody looks.
 *
 * English per D18.
 */

import { hostname } from 'node:os';
import path from 'node:path';

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../controller/http-client.ts';
// TYPE-only, and the subcommand itself is loaded with a dynamic `import()`
// below. `prune.ts` imports the resolvers and the two environment-variable
// names from THIS file, so a static import here would close a cycle — and a
// cycle whose modules both build a usage string at evaluation time is not the
// benign kind: whichever side loads second reads the other's `const`s in their
// temporal dead zone and throws before a single test runs. A type import is
// erased, and the dynamic one happens when this file is long since evaluated.
import type { PruneSeams } from './prune.ts';
import {
  DEFAULT_ENGINE_NAME,
  ENGINE_NAMES,
  runRunner,
  type EngineName,
  type RunnerOptions,
} from './run.ts';
import type { ReferenceMode } from '../dispatch/resolve-executor-environment.ts';

/** Environment variable that points at the control plane (the CLI's own). */
export const URL_ENV = 'CARTOGRAFO_URL';

/** Environment variable that carries the credential of the control plane. */
export const TOKEN_ENV = 'CARTOGRAFO_TOKEN';

/** Default control plane address. */
export const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:4317';

/**
 * Project the leases are asked under when nobody says otherwise.
 *
 * The same `1` every other part of the system falls back to
 * (`DEFAULT_PROJECT`, `packages/core/src/repositories/common.ts:25`), spelled
 * out here for the same boundary reason the URL is.
 */
export const DEFAULT_PROJECT = 1;

/** Ceiling this runner declares for itself, when nothing is asked for. */
export const DEFAULT_DECLARED_RUNNER_CAP = 1;

/** Cap of simultaneous sessions of the project, when nothing is asked for. */
export const DEFAULT_PROJECT_CAP = 4;

/** Wait between ticks, in milliseconds, when nothing is asked for. */
export const DEFAULT_INTERVAL_MS = 2_000;

/** Term of the lease asked for, in seconds, when nothing is asked for. */
export const DEFAULT_LEASE_TTL_SECONDS = 60;

/**
 * How long a stop waits for the session in flight, in seconds, by default.
 *
 * Two minutes, and the number is a compromise with a name at each end: shorter
 * kills sessions that were about to finish and would have reported their own
 * outcome; longer is indistinguishable, to whoever is watching a terminal or a
 * supervisor, from a runner that hung. Anybody who knows their own sessions
 * better says so with the flag.
 */
export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 120;

/**
 * The two ways `input.referencia.commit` can be read (t270).
 *
 * The vocabulary is the skill manifest's, not this command's: it is the enum
 * `implantar-release.json` declares for `referencia.modo`, and a third name
 * here would be a third name the manifests do not know.
 */
export const REFERENCE_MODES = ['instalacao_em_uso', 'ponta_do_principal'] as const;

/** How the reference is read when nobody says otherwise. */
export const DEFAULT_REFERENCE_MODE: ReferenceMode = 'ponta_do_principal';

/** Branch the live reference is read from, when nobody names one. */
export const DEFAULT_MAIN_BRANCH = 'main';

/** Name of the readiness event printed on stdout, once the runner has paired. */
export const READY_EVENT = 'cartografo.runner.ready';

/** The one subcommand this binary has, and the only bare word it accepts. */
export const PRUNE_SUBCOMMAND = 'prune';

/** Usage text. The same in `--help` (stdout) and on a wrong command line (stderr). */
export const USAGE = `usage: cartografo-runner [options]
       cartografo-runner ${PRUNE_SUBCOMMAND} [options]

Starts a runner: it pairs with the control plane and, from then on, asks for
released work, takes a lease and dispatches a session for it — each session in
a git worktree of its own — one tick every --interval-ms, until SIGINT or
SIGTERM.

options:
  --url <url>               control plane to dial (env ${URL_ENV};
                            default ${DEFAULT_CONTROL_PLANE_URL})
  --token <token>           credential of the control plane (env ${TOKEN_ENV});
                            it is printed when the control plane first starts
  --project <id>            project the leases are asked under
                            (default ${DEFAULT_PROJECT})
  --runner-id <id>          identity this runner declares at pairing
                            (default: this host and this pid)
  --engine <${ENGINE_NAMES.join('|')}>
                            engine every session of this runner opens on
                            (default ${DEFAULT_ENGINE_NAME}); one per process
  --working-dir <path>      the git repository the sessions' worktrees are cut
                            from (default: the current directory)
  --worktrees-root <path>   REQUIRED: directory those worktrees are created
                            under. A SIBLING of --working-dir, never inside it
                            — e.g. --working-dir ~/proj
                            --worktrees-root ~/proj-worktrees
  --test-bench-path <path>  the integrated checkout the gate nodes OBSERVE,
                            published to the session as
                            \`input.banco_de_testes.caminho\` (default: the same
                            as --working-dir). The runner fast-forwards it onto
                            the merge commit an accepted report names, before
                            letting that work move on
  --bench-install-command <command>
                            one shell command run in that bench right after it
                            advances — the class declares its own spelling of it
                            in the graph's \`project.comando_instalacao\`, e.g.
                            \`npm ci\`. Optional: with none, advancing is all
                            that happens. A non-zero exit stops the work
  --reference-mode <${REFERENCE_MODES.join('|')}>
                            how \`input.referencia.commit\` is read (default
                            ${DEFAULT_REFERENCE_MODE}): ponta_do_principal reads the
                            live tip of --main-branch on every dispatch;
                            instalacao_em_uso reads HEAD once and never again,
                            because it is an assertion about THIS process
  --reference-repo <path>   repository that reference is read from
                            (default: --test-bench-path)
  --main-branch <name>      branch ponta_do_principal reads
                            (default ${DEFAULT_MAIN_BRANCH})
  --declared-runner-cap <n>
                            ceiling this runner DECLARES to the control plane
                            for its own runner id (runner_cap); the server
                            takes the MIN with its own configured ceiling and
                            is the one that enforces it (D1). It is not
                            sessions in flight here: this process dispatches
                            one at a time whatever the value, because a tick
                            awaits the whole dispatch before asking again
                            (default ${DEFAULT_DECLARED_RUNNER_CAP})
  --project-cap <n>         simultaneous sessions of the project
                            (default ${DEFAULT_PROJECT_CAP})
  --interval-ms <n>         wait between ticks, in milliseconds
                            (default ${DEFAULT_INTERVAL_MS})
  --lease-ttl-seconds <n>   term of the lease asked for
                            (default ${DEFAULT_LEASE_TTL_SECONDS})
  --request-timeout-ms <n>  how long any one call to the control plane may
                            take before it is given up on
                            (default ${DEFAULT_REQUEST_TIMEOUT_MS})
  --shutdown-grace-seconds <n>
                            how long a stop waits for the session in flight
                            before taking it down (default
                            ${DEFAULT_SHUTDOWN_GRACE_SECONDS}); a second SIGINT
                            or SIGTERM does not wait at all
  -h, --help                this text

Only --url and --token read an environment variable; every other flag above,
these two included, is command line only.

subcommands:
  ${PRUNE_SUBCOMMAND}                     collects the session worktrees and
                            \`ticket-<id>\` branches of jobs the control plane
                            reports as concluded; \`cartografo-runner
                            ${PRUNE_SUBCOMMAND} --help\` for its own options

exit codes: 0 the runner ran and was asked to stop, 1 it could not run,
2 the command line is wrong.`;

/** Wrong use of the command — becomes one line, never a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Every option this command takes a value for. */
const VALUE_OPTIONS = [
  '--url',
  '--token',
  '--project',
  '--runner-id',
  '--engine',
  '--working-dir',
  '--worktrees-root',
  '--test-bench-path',
  '--bench-install-command',
  '--reference-mode',
  '--reference-repo',
  '--main-branch',
  '--declared-runner-cap',
  '--project-cap',
  '--interval-ms',
  '--lease-ttl-seconds',
  '--request-timeout-ms',
  '--shutdown-grace-seconds',
] as const;

/** The two signals that ask a runner to stop. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Reads the command line into `--name` → value, refusing anything else.
 *
 * Both spellings, `--name value` and `--name=value`, because whoever wires a
 * runner into a supervisor uses the second one and would otherwise find out at
 * runtime. Anything that is not one of the known options — a flag nobody
 * declared, a stray positional — is a usage error rather than a silent
 * ignore: a runner started with a typo would otherwise run happily against the
 * wrong control plane.
 *
 * @param args `process.argv.slice(2)`.
 * @returns The value of each option that was given.
 * @throws {UsageError} On an unknown option, a stray argument or a missing value.
 */
function readOptions(args: string[]): Map<string, string> {
  const given = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const equals = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equals === -1 ? argument : argument.slice(0, equals);

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
 * Resolves the control plane's address.
 *
 * @param option Value of `--url`, when it came on the command line.
 * @param env Environment to read `CARTOGRAFO_URL` from.
 * @returns Base URL with no trailing slash.
 */
export function resolveControlPlaneUrl(option: string | undefined, env: NodeJS.ProcessEnv): string {
  const fromEnv = env[URL_ENV]?.trim();
  const chosen =
    option !== undefined && option.trim() !== ''
      ? option.trim()
      : fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : DEFAULT_CONTROL_PLANE_URL;

  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new UsageError(`invalid URL: "${chosen}" (expected something like ${DEFAULT_CONTROL_PLANE_URL})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`the URL has to be http or https: "${chosen}"`);
  }

  return chosen.replace(/\/+$/, '');
}

/**
 * Resolves the credential the runner presents.
 *
 * @param option Value of `--token`, when it came on the command line.
 * @param env Environment to read `CARTOGRAFO_TOKEN` from.
 * @returns The token, or `undefined` when there is none to present — which is
 *   honest: an empty header would look like a credential.
 */
export function resolveToken(
  option: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const chosen = option?.trim() !== undefined && option.trim() !== '' ? option.trim() : env[TOKEN_ENV]?.trim();
  return chosen === undefined || chosen === '' ? undefined : chosen;
}

/**
 * Reads an option that has to be a positive integer.
 *
 * @param name Option name, for the message.
 * @param raw Value as it came, or `undefined`.
 * @param fallback What it means to leave it out.
 * @returns The number to use.
 * @throws {UsageError} When the value is not a positive integer.
 */
function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`${name} has to be a positive integer (got: "${raw}")`);
  }
  return parsed;
}

/**
 * Resolves the two paths that decide where sessions write (t179).
 *
 * `--worktrees-root` is the one option of this command with no default, and
 * that is a decision rather than an omission: `GitWorktreeManager` refuses to
 * guess a location because "a default location is a silent guess about which
 * repository a session may write in" (`session-worktree.ts:24-26`), and a
 * default invented one layer up here would be exactly that guess wearing a
 * different hat.
 *
 * The overlap check is the other half of it. A worktree created inside the
 * repository it was cut from is untracked content in that repository's own
 * `git status` — the same class of problem gap #6 of the first dogfood named
 * ("the session works in the shared checkout; the OPERATOR itself became a
 * concurrent writer"), and one that a runner would only reveal on its first
 * dispatch, in somebody else's tree.
 *
 * Only that direction is refused. `--working-dir` inside `--worktrees-root` is
 * an odd layout, but it pollutes nothing, and a guard nobody can name a failure
 * for is a rule people route around.
 *
 * @param workingDir Value of `--working-dir`, when it came on the command line.
 * @param worktreesRoot Value of `--worktrees-root`.
 * @returns The repository and the root, both absolute.
 * @throws {UsageError} `--worktrees-root` absent, or overlapping the repository.
 */
export function resolveWorktreePaths(
  workingDir: string | undefined,
  worktreesRoot: string | undefined,
): { repoRoot: string; worktreesRoot: string } {
  if (worktreesRoot === undefined) {
    throw new UsageError(
      '--worktrees-root is required: it says where the sessions\' git worktrees are created, ' +
        'and there is no safe default for it — pass a directory next to --working-dir ' +
        '(e.g. --working-dir ~/proj --worktrees-root ~/proj-worktrees)',
    );
  }

  const repoRoot = workingDir === undefined ? process.cwd() : path.resolve(workingDir);
  const resolved = path.resolve(worktreesRoot);

  // `+ path.sep`, and not a bare `startsWith`: `~/proj-worktrees` starts with
  // `~/proj` as a string while being a sibling of it on disk — and a sibling is
  // precisely the layout the usage text recommends.
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new UsageError(
      `--worktrees-root has to be outside --working-dir (got "${resolved}", inside "${repoRoot}"): ` +
        'a worktree created inside the repository it was cut from shows up as untracked content ' +
        'in that repository\'s own `git status` — use a sibling directory instead ' +
        '(e.g. --working-dir ~/proj --worktrees-root ~/proj-worktrees)',
    );
  }

  return { repoRoot, worktreesRoot: resolved };
}

/**
 * The identity a runner declares when it was not given one.
 *
 * Host plus pid, and regenerated every run: a persisted identity is a config
 * file this ficha deliberately does not add (Out of Scope), and pairing is
 * idempotent on the server, so a name that changes per restart costs nothing
 * but a row.
 */
function defaultRunnerId(): string {
  return `${hostname()}-${process.pid}`;
}

/**
 * Turns a command line into the decision `runRunner` executes.
 *
 * Exported for the tests, and not only for them: this is the whole of what the
 * command decides, and it decides it without touching the network.
 *
 * @param args `process.argv.slice(2)`.
 * @param env Process environment.
 * @returns Everything one runner process needs to know about itself.
 * @throws {UsageError} On any command line this command cannot read.
 */
export function parseRunnerOptions(args: string[], env: NodeJS.ProcessEnv): RunnerOptions {
  const given = readOptions(args);

  const engine = given.get('--engine') ?? DEFAULT_ENGINE_NAME;
  if (!(ENGINE_NAMES as readonly string[]).includes(engine)) {
    throw new UsageError(`--engine has to be one of ${ENGINE_NAMES.join(', ')} (got: "${engine}")`);
  }

  const { repoRoot, worktreesRoot } = resolveWorktreePaths(
    given.get('--working-dir'),
    given.get('--worktrees-root'),
  );
  const runnerId = given.get('--runner-id');

  // The mode is the manifest's enum and not free text: a typo here would only
  // show up as a `referencia.modo` no skill's `output` accepts, one dispatch
  // and one session too late.
  const referenceMode = given.get('--reference-mode') ?? DEFAULT_REFERENCE_MODE;
  if (!(REFERENCE_MODES as readonly string[]).includes(referenceMode)) {
    throw new UsageError(
      `--reference-mode has to be one of ${REFERENCE_MODES.join(', ')} (got: "${referenceMode}")`,
    );
  }

  // Resolved here, where every other path of this command is resolved: what
  // reaches `git -C` is absolute, so a runner started from another directory
  // reads the bench it was pointed at and not one relative to wherever it
  // happened to be launched.
  const testBenchPath = given.get('--test-bench-path');
  const referenceRepo = given.get('--reference-repo');
  // Not resolved and not split: it is a command line for a shell, run with the
  // bench as its working directory, and anything this command did to it would
  // be this file deciding what the operator meant (t273).
  const benchInstallCommand = given.get('--bench-install-command');

  return {
    url: resolveControlPlaneUrl(given.get('--url'), env),
    token: resolveToken(given.get('--token'), env),
    projectId: positiveInteger('--project', given.get('--project'), DEFAULT_PROJECT),
    runnerId: runnerId === undefined ? defaultRunnerId() : runnerId,
    engine: engine as EngineName,
    repoRoot,
    worktreesRoot,
    testBenchPath: testBenchPath === undefined ? repoRoot : path.resolve(testBenchPath),
    ...(benchInstallCommand === undefined ? {} : { benchInstallCommand }),
    referenceMode: referenceMode as ReferenceMode,
    ...(referenceRepo === undefined ? {} : { referenceRepo: path.resolve(referenceRepo) }),
    mainBranch: given.get('--main-branch') ?? DEFAULT_MAIN_BRANCH,
    runnerCap: positiveInteger(
      '--declared-runner-cap',
      given.get('--declared-runner-cap'),
      DEFAULT_DECLARED_RUNNER_CAP,
    ),
    projectCap: positiveInteger('--project-cap', given.get('--project-cap'), DEFAULT_PROJECT_CAP),
    intervalMs: positiveInteger('--interval-ms', given.get('--interval-ms'), DEFAULT_INTERVAL_MS),
    leaseTtlSeconds: positiveInteger(
      '--lease-ttl-seconds',
      given.get('--lease-ttl-seconds'),
      DEFAULT_LEASE_TTL_SECONDS,
    ),
    requestTimeoutMs: positiveInteger(
      '--request-timeout-ms',
      given.get('--request-timeout-ms'),
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    shutdownGraceSeconds: positiveInteger(
      '--shutdown-grace-seconds',
      given.get('--shutdown-grace-seconds'),
      DEFAULT_SHUTDOWN_GRACE_SECONDS,
    ),
  };
}

/** Test seams of the router. Production passes none of them. */
export interface CliSeams extends PruneSeams {
  /** What actually runs the loop. Default: {@link runRunner}. */
  run?: (options: RunnerOptions) => Promise<void>;
}

/** One line about a failure, for stderr: name and message, never a stack. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The one line a runner that could not run leaves behind.
 *
 * Its characteristic failure is being started against a control plane that is
 * not there, or with a credential it will not take — and `TypeError: fetch
 * failed` describes the stack instead of the situation. Same discipline
 * `packages/core/src/cli/url.ts` states for the same two cases, and the same
 * reason: whoever ran this in a clean terminal did not fail for lack of a
 * server, they failed for not knowing they needed to start one.
 *
 * The raw description rides along in parentheses on the unrecognized path, so
 * that a real bug in here is still legible instead of being dressed up as a
 * control plane that is down.
 *
 * @param error What the startup threw.
 * @param url Address the runner was pointed at.
 * @returns One line for stderr.
 */
export function failureMessage(error: unknown, url: string): string {
  if (error instanceof ErroDoControlPlane) {
    return error.status === 401 || error.status === 403
      ? `the control plane at ${url} refused the credential (${error.status}) — set ${TOKEN_ENV} or pass --token with the token printed when the control plane started`
      : `the control plane at ${url} refused the pairing — ${error.message}`;
  }
  return `could not talk to the control plane at ${url} — run \`npx cartografo\` first, or point somewhere else with --url (${describeError(error)})`;
}

/**
 * Entry point of the command: runs a runner and returns the exit code.
 *
 * It does not call `process.exit`, on the same grounds as the core's router:
 * the `bin` records the code and lets the process end when there is nothing
 * left to do. Here that matters twice over — the stop is asynchronous by
 * construction, and an `exit` would cut off the very dispatch this shutdown
 * exists to wait for.
 *
 * @param args `process.argv.slice(2)`.
 * @param env Process environment.
 * @param seams Test seams; production passes nothing.
 * @returns Exit code.
 */
export async function runRunnerCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  seams: CliSeams = {},
): Promise<number> {
  // The subcommand is decided BEFORE `--help`, and that order is the whole
  // difference between one help text and two: `prune --help` has to reach the
  // subcommand's own usage rather than this one's.
  //
  // The same shape `packages/core/src/cli/index.ts:285` already uses — an
  // explicit subcommand when the first argument is a known bare word, the
  // flags-only invocation otherwise. It is backwards compatible by
  // construction: no option of this command is a bare word, so nothing that
  // used to run a runner can be read as a subcommand now.
  if (args[0] === PRUNE_SUBCOMMAND) {
    const { runPruneCli } = await import('./prune.ts');
    return await runPruneCli(args.slice(1), env, seams);
  }

  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let options: RunnerOptions;
  try {
    options = parseRunnerOptions(args, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    // One line, and it carries the way out: a second line saying "see --help"
    // is a line nobody reads twice.
    process.stderr.write(
      `cartografo-runner: ${error.message} — run \`cartografo-runner --help\` for usage\n`,
    );
    return 2;
  }

  const run = seams.run ?? runRunner;
  const aborter = new AbortController();

  /**
   * The live session's cancel, or `null` when there is none (t193, FR7).
   *
   * Valid only between `onSessionStarted` and `onSessionEnded`, which is what
   * keeps it from ever being stale: outside that window there is no process to
   * take down, and `null` is a no-op rather than a call into a dead handle.
   */
  let liveCancel: (() => Promise<void>) | null = null;
  let stopping = false;
  let grace: NodeJS.Timeout | null = null;

  /** Takes the live session down now, if there is one. Idempotent, by the `null`. */
  const forceDown = (): void => {
    if (grace !== null) {
      clearTimeout(grace);
      grace = null;
    }
    const cancel = liveCancel;
    liveCancel = null;
    if (cancel === null) return;

    // Not awaited, and it cannot be: this runs on a signal handler, and what
    // resumes after the cancel is the dispatch itself — reporting the outcome,
    // giving the worktree back and settling the promise `run` is already
    // awaiting below. A failure here is swallowed for the same reason the
    // dispatch swallows its own cleanup errors: the session is going down
    // either way, and there is nobody left up here to tell.
    void cancel().catch(() => undefined);
  };

  /**
   * What a stop signal does — and it does something different the second time.
   *
   * The first one aborts the loop, so nothing new is scheduled, and starts a
   * clock. The second one, or that clock running out, ends the session in
   * flight instead of waiting for it. Before t193 there was only the first
   * half, registered with `process.once`: a second signal found no listener and
   * killed the process under Node's default disposition, with the engine still
   * running in a worktree nobody was left to give back.
   */
  const stop = (): void => {
    if (stopping) {
      forceDown();
      return;
    }
    stopping = true;
    aborter.abort();

    // `unref`ed: a runner whose session already ended has no reason to stay up
    // waiting out a grace it no longer needs.
    const graceSeconds = options.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;
    grace = setTimeout(forceDown, graceSeconds * 1_000);
    grace.unref();
  };

  // Registered on the real process, and removed again on the way out: a
  // listener left behind would keep answering for a runner that no longer
  // exists — which is exactly what a test process would find out the hard way.
  // `on` and not `once` (t193): the second signal is the one that stops waiting.
  for (const signal of STOP_SIGNALS) process.on(signal, stop);

  try {
    await run({
      ...options,
      signal: aborter.signal,
      onSessionStarted: (cancel) => {
        liveCancel = cancel;
        // A session that came up AFTER the stop was asked for — the tick that
        // was already in flight when the signal landed. It gets no grace of its
        // own: the clock started with the signal, and if it has already run out
        // this session is taken down as soon as it exists.
        if (stopping && grace === null) forceDown();
      },
      onSessionEnded: () => {
        liveCancel = null;
      },
      onReady: () => {
        process.stdout.write(
          `${JSON.stringify({
            event: READY_EVENT,
            url: options.url,
            runnerId: options.runnerId,
            projectId: options.projectId,
            engine: options.engine,
            repoRoot: options.repoRoot,
            worktreesRoot: options.worktreesRoot,
          })}\n`,
        );
      },
    });
    return 0;
  } catch (error) {
    // Everything that reaches here happened before or instead of the loop —
    // the pairing being refused, the control plane being down. A tick that
    // fails never gets this far: the loop logs it and carries on.
    process.stderr.write(`cartografo-runner: ${failureMessage(error, options.url)}\n`);
    return 1;
  } finally {
    for (const signal of STOP_SIGNALS) process.off(signal, stop);
    if (grace !== null) clearTimeout(grace);
  }
}
