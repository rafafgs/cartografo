/**
 * The packaged composition: what the runner IS, once it stops being four
 * objects and becomes a process (t162, FR5–FR7).
 *
 * Everything below already existed and is already tested on its own —
 * `ControlPlaneClient` (t103) speaks HTTP, `Controller` (t103) turns a tick into a
 * lease, `createClaudeCodeDispatch` (t106/t141) opens the session and reports
 * back, and the two `EngineAdapter`s (t104/t119) run the CLIs. What did NOT
 * exist was the wiring that puts them together, which until this ficha lived
 * only inside `scripts/spike-two-engine-traversal.mjs`, written by hand as a
 * manual proof. This file is that same composition, packaged, so that the
 * fourth command of the product runs it instead of an operator re-typing it.
 *
 * Three decisions worth stating, because each one has a plausible opposite:
 *
 * - **Pairing comes before the first tick, always.** A runner that asks for a
 *   lease without having registered gets `404 unknown_runner`
 *   (`packages/core/src/routes/leases.ts:203`), which is a configuration error
 *   dressed as a queue answer — insisting on it never helps.
 * - **A tick that rejects is logged and the loop keeps turning.** The lease is
 *   already back by the time the rejection gets here: the controller returns it
 *   in its own `finally` (`controller.ts:143-160`) whatever the dispatch did.
 *   So what is left to decide is only whether ONE bad job may end a runner's
 *   day, and it may not — a graph node asking for an engine this runner has no
 *   route for is exactly that kind of local failure. Since t252 that particular
 *   example no longer reaches this catch at all: five pre-session failures that
 *   would reproduce on every retry block the work with a reason instead, so
 *   what still lands here is what is genuinely worth retrying.
 * - **Shutdown waits for the dispatch in flight — but not forever** (t193).
 *   Aborting stops the loop from SCHEDULING, never mid-session: killing a live
 *   session from out here would leave a process writing in its worktree with
 *   nobody left to report what it did — and nobody left to give the worktree
 *   back. A dispatch that is already running finishes (or fails) through the
 *   paths `dispatch.ts` already has, and only then does the promise
 *   this function returns resolve. What t193 added is the bound: waiting was
 *   the ONLY thing a stop could do, and an hour is how long that wait could
 *   last. The session is now cancellable from outside, through
 *   {@link RunnerOptions.onSessionStarted} — and cancelling still travels those
 *   same paths, so the worktree is given back and the outcome is reported
 *   exactly as it would have been.
 * - **The worktree manager is built here, out of two paths the operator gave**
 *   (t179). `createClaudeCodeDispatch` requires a `WorktreeManager` and has no
 *   default for it, and `GitWorktreeManager` has no default for either of its
 *   paths — deliberately, both of them: where a session may write is the
 *   operator's decision, and a location guessed in code is how the first
 *   dogfood run ended up with sessions writing in the operator's own checkout
 *   (`notes/2026-08-15-first-execution.md`, gap #6). This function is the
 *   last place that could have invented one, and it does not.
 *
 * The `engineFactory` seam is the same shape `commandBuilder` already is on
 * both adapters (`engine/claude-code-adapter.ts:82`): production gets the real
 * adapter, the suite points it at the fake engine, and neither one has to know
 * about the other.
 *
 * English per D18.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ControlPlaneClient,
  type ProbeReport,
} from '../controller/control-plane-client.ts';
import { Controller } from '../controller/controller.ts';
import { createMainLineAdvancer } from '../dispatch/advance-main-line.ts';
import { createClaudeCodeDispatch, type EngineRoute } from '../dispatch/dispatch.ts';
import { createDispatchControlPlaneClient } from '../dispatch/control-plane-client.ts';
import {
  createExecutorEnvironmentResolver,
  type McpDiscoveryResult,
  type ReferenceMode,
} from '../dispatch/resolve-executor-environment.ts';
import { createClassPrecedentsResolver } from '../dispatch/resolve-input.ts';
import {
  createSkillSourceResolver,
  type SkillSource,
  type SkillSourceResult,
} from '../dispatch/resolve-skill-source.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
  decodeShellSessionText,
} from '../dispatch/session-text.ts';
import { GitWorktreeManager } from '../dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import { CodexAdapter } from '../engine/codex-adapter.ts';
import { ShellAdapter } from '../engine/shell-adapter.ts';
import { SHELL_ENGINE_NAME } from '../engine/shell-command.ts';
import type { EngineAdapter } from '../engine/types.ts';

/**
 * The engines a packaged runner can be pointed at.
 *
 * The two AGENT adapters, and it is not a coincidence that there are two: t141
 * froze the `EngineAdapter` interface only once a second consumer had shipped
 * (rule of two consumers).
 *
 * `shell` is deliberately NOT here, and the third adapter arriving in t332 did
 * not change it. What `--engine` selects is which agent CLI this process
 * authenticates as — a credential, a preflight, a model catalog, one per
 * process — and `ShellAdapter` has none of those to choose between. It is
 * registered unconditionally instead, beside whatever this flag picked
 * ({@link buildEngineRoutes}).
 */
export const ENGINE_NAMES = ['claude-code', 'codex'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

/** The engine a runner opens its sessions on when nobody says otherwise. */
export const DEFAULT_ENGINE_NAME: EngineName = 'claude-code';

/**
 * The three values a runner cannot start without, once they are all known
 * (t404).
 *
 * They arrive from two sources and never from three: the command line, or the
 * project's settings on the control plane. What this type marks is the moment
 * the two sources have been reconciled — past it, nothing in this file reads
 * `options.repoRoot`, `options.worktreesRoot` or `options.engine` again.
 */
export interface ResolvedRunnerPaths {
  /** The git repository each session's worktree is cut from. */
  repoRoot: string;
  /** The directory those worktrees are created under. */
  worktreesRoot: string;
  /** The engine every session of this process opens on. */
  engine: EngineName;
}

/**
 * The settings could not answer what the command line did not (t404, FR6).
 *
 * A failure of the CONFIGURATION and not of the call: the fetch itself
 * succeeded, and what came back had no `workspace_root`/`worktrees_root` for
 * this project — or an `engine` that is not one this runner can open a session
 * on. A fetch that FAILS is a different thing entirely and travels up as
 * itself, `ControlPlaneClientError` and network error alike.
 *
 * It is separate from `cli/index.ts`'s `UsageError` because it is not a wrong
 * command line: nothing the operator typed was wrong, and there was nothing
 * for them to type. `failureMessage` prints it verbatim for that reason — it is
 * already phrased for a terminal, and the runner exits 1 rather than 2.
 */
export class SettingsFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsFallbackError';
  }
}

/** Everything one runner process needs to know about itself. */
export interface RunnerOptions {
  /** Control plane to dial, with no trailing slash. */
  url: string;
  /**
   * Credential presented on every call — pairing included (t162, Refinement
   * Log). It is the operator token: `POST /v1/runners` is operator-only
   * (`packages/core/src/routes/runners.ts:19-22`) and the five routes a
   * runner-scoped credential reaches do not cover the seven a dispatch calls.
   * Cutting a credential that reaches exactly this surface is another ficha.
   */
  token?: string;
  /** Project the leases are asked under. */
  projectId: number;
  /** Identity this runner declares at pairing. */
  runnerId: string;
  /**
   * The one engine every session of this process opens on.
   *
   * `undefined` means "resolve from `GET /v1/settings` after pairing" (t404):
   * a runner started with no path flags at all takes the project's `engine`
   * from the control plane. It never means a default invented in this file —
   * {@link DEFAULT_ENGINE_NAME} is applied once, in {@link resolveRunnerPaths},
   * and only after the settings have had their say.
   */
  engine?: EngineName;
  /**
   * The git repository each session's worktree is cut from (t179).
   *
   * `--working-dir` on the command line, and NOT what a session writes in: the
   * directory a session actually gets is a worktree of this repository, minted
   * per dispatch (`SessionSpec.workingDir`, `session-worktree.ts`). The two
   * were the same string until t160, which is what the first dogfood run paid
   * for; the names are different now so that the code cannot confuse them
   * again.
   *
   * Optional since t404, and `undefined` means "resolve from `GET /v1/settings`
   * after pairing" — the project's `workspace_root`. It never means
   * `process.cwd()`, and never means a directory this file picked: where a
   * session may write is somebody's explicit decision, whether that somebody
   * typed `--working-dir` or wrote the setting down.
   */
  repoRoot?: string;
  /**
   * The directory those worktrees are created under.
   *
   * A sibling of {@link repoRoot} and never inside it: a worktree cut into the
   * repository it came from shows up as untracked content in that repository's
   * own `git status`. Required, with no default — `--worktrees-root` on the
   * command line, and the CLI is where that is enforced.
   *
   * Optional since t404, on the same terms as {@link repoRoot}: `undefined` is
   * "resolve from `GET /v1/settings` after pairing" — the project's
   * `worktrees_root` — and a settings answer that carries none is a
   * {@link SettingsFallbackError}, never a guess.
   */
  worktreesRoot?: string;
  /**
   * The checkout the sessions OBSERVE — `--test-bench-path` (t270).
   *
   * Not where they write: that is a worktree of {@link repoRoot}, minted per
   * dispatch. This is the integrated checkout a gate node exercises, published
   * to the session as `input.banco_de_testes.caminho`, and it is deliberately a
   * different concept from both paths above — a point of observation, which the
   * manifest tells the session it has no write permission in.
   *
   * Default: {@link repoRoot}, which is a real answer and not a placeholder —
   * the ordinary single-machine deployment observes the same checkout it cuts
   * sessions from.
   *
   * Since t273 this process also KEEPS that bench true: an accepted report that
   * names a `merge_commit` fast-forwards this checkout onto it — and runs
   * {@link benchInstallCommand} in it — before the work is allowed off the node
   * that reported it. Until then the reads of t270 observed a directory nobody
   * ever moved, and an operator merged by hand between two nodes.
   */
  testBenchPath?: string;
  /**
   * One shell command that prepares the bench after it advances — t273.
   *
   * `--bench-install-command`, optional, and absent contributes nothing: the
   * same posture every other bench knob has. What it is for is the step each
   * session of the t109 run typed by hand for lack of it (`npm ci --offline`);
   * the class declares its own spelling of it in the graph's
   * `project.comando_instalacao`, and this flag is where an operator points the
   * runner at it. It runs with this process's privileges, in the bench, which is
   * why it comes from the command line and never from a graph document.
   */
  benchInstallCommand?: string;
  /**
   * Which question `input.referencia.commit` answers — `--reference-mode`.
   *
   * `ponta_do_principal` (the default) reads the live tip of the main line on
   * every dispatch; `instalacao_em_uso` reads `HEAD` once, at the first
   * dispatch, and never again, because it is an assertion about THIS process.
   * The two are the manifest's own vocabulary
   * (`implantar-release.json`), not this file's invention.
   */
  referenceMode?: ReferenceMode;
  /** Repository the reference is read from — `--reference-repo`. Default: the bench. */
  referenceRepo?: string;
  /** Branch `ponta_do_principal` reads — `--main-branch`. Default: `main`. */
  mainBranch?: string;
  /**
   * The ceiling this runner declares for itself — `--declared-runner-cap`.
   *
   * A declaration and nothing else: it travels as `teto_runner`, the server
   * takes the MIN with its own configured ceiling and the server is what
   * enforces it (D1). It is NOT the number of sessions this process runs at
   * once — the loop below dispatches one at a time whatever the value, because
   * `tick()` awaits the whole dispatch before it can ask for another lease
   * (t208). More throughput is more runner processes, not a bigger number here.
   */
  runnerCap: number;
  /** Cap of simultaneous sessions declared for the project. */
  projectCap: number;
  /** Wait between one tick and the next, in milliseconds. */
  intervalMs: number;
  /** Term of the lease asked for, in seconds. */
  leaseTtlSeconds: number;
  /**
   * Deadline of every control-plane call, in milliseconds (t193).
   *
   * Threaded to both clients this function builds — `ControlPlaneClient` and the
   * dispatch's own — because a runner has exactly one control plane and no
   * reason to give up on it at two different moments. Default:
   * `DEFAULT_REQUEST_TIMEOUT_MS`.
   */
  requestTimeoutMs?: number;
  /**
   * How long a stop waits for the session in flight before taking it down, in
   * seconds (t193).
   *
   * Parsed here because this is where a runner's command line becomes a
   * decision, and CONSUMED by whoever owns the process (`cli/index.ts`): the
   * loop below stops scheduling on the abort and has nothing else to do with
   * the number. Same shape {@link onReady} already has, read from the other
   * end.
   */
  shutdownGraceSeconds?: number;
  /**
   * Stops the loop. Aborting it stops NEW ticks; the one in flight is awaited.
   * Absent, the loop never ends on its own.
   */
  signal?: AbortSignal;
  /**
   * Builds the route for the selected engine. Default: the real adapters.
   *
   * The suite's seam, in the same mould as the adapters' own `commandBuilder`:
   * a fake engine is a different binary, never a different composition.
   */
  engineFactory?: (engine: EngineName) => EngineRoute;
  /**
   * Called once, after the pairing and before the first tick.
   *
   * It exists so that whoever owns the process — `cli/index.ts` — can announce
   * readiness, in the shape `packages/core/src/index.ts` set: the fact worth
   * announcing is that this runner EXISTS for the control plane, and this
   * function is the only one that knows when that became true.
   *
   * Since t404 it is handed the three values that were RESOLVED, and that is
   * the whole reason it takes an argument: in settings-fallback mode the three
   * fields of `options` are `undefined`, so a process owner closing over them
   * would announce a runner whose paths nobody can read.
   */
  onReady?: (resolved: ResolvedRunnerPaths) => void;
  /**
   * Called whenever a session goes live, with the one function that takes it
   * down (t193, FR8).
   *
   * Same shape and same reason as {@link onReady}: the process owner needs a
   * fact only the layer below knows. Here the fact is "there is an engine
   * running right now, and this is how it is stopped" — without it, a stop can
   * only wait the session out, for up to the dispatch's own hour.
   */
  onSessionStarted?: (cancel: () => Promise<void>) => void;
  /** Called once that session's outcome is known: there is nothing to cancel now. */
  onSessionEnded?: () => void;
}

/** The real adapters, each paired with the decoder for its own frames. */
export function defaultEngineFactory(engine: EngineName): EngineRoute {
  return engine === 'codex'
    ? { adapter: new CodexAdapter(), decodeSessionText: decodeCodexSessionText }
    : { adapter: new ClaudeCodeAdapter(), decodeSessionText: decodeClaudeCodeSessionText };
}

/**
 * Everything one runner process can route a node to: the selected agent engine,
 * and `shell` (t332, FR9).
 *
 * **`shell` goes in unconditionally, with no flag to turn it off**, and there
 * are two reasons — one about what it costs, one about what the alternative
 * costs.
 *
 * It costs nothing. Every other engine in this table is a CLI that has to be
 * installed and authenticated, which is exactly why `--engine` exists: a runner
 * declares which one it can actually reach. `ShellAdapter` has no binary of its
 * own to find, no credential to present and no preflight that can fail, so an
 * operator opting out of it would be opting out of nothing.
 *
 * And the alternative is unsafe today. The obvious shape — one shell-capable
 * runner beside a claude-code one, both drawing from the same queue — loses the
 * race it depends on: a node's engine is resolved AFTER the lease is taken, and
 * an engine with no route raises `UnknownEngineError`, which is a hard block
 * needing a human to clear (`pre-session-failure.ts`). The claude-code-only
 * runner that won the lease of a shell node would STOP the job rather than hand
 * it back. Until a runner can decline work it cannot run — or give a lease back
 * as unclaimed — every runner has to be able to run every deterministic node.
 *
 * The selected engine is written first and `shell` second, so the shell key can
 * never be shadowed by a factory that answered under that name.
 *
 * @param engine The agent engine `--engine` selected.
 * @param engineFactory Builds that engine's route. The suite's seam.
 * @returns The routing table, by declared engine name.
 */
export function buildEngineRoutes(
  engine: EngineName,
  engineFactory: (engine: EngineName) => EngineRoute = defaultEngineFactory,
): Record<string, EngineRoute> {
  return {
    [engine]: engineFactory(engine),
    // Built here and never asked of the factory: that seam is typed for the two
    // names `--engine` accepts, and a runner's ability to run a deterministic
    // node must not depend on whoever supplied it.
    [SHELL_ENGINE_NAME]: {
      adapter: new ShellAdapter(),
      decodeSessionText: decodeShellSessionText,
    },
  };
}

/** One line about a failure, for stderr: name and message, never a stack. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Runs the engine's preflight, and answers whether it is worth asking anything
 * else of that CLI (t186, FR11).
 *
 * FR11 states the catalog is reported "after pairing and `verifyCli()`
 * succeed", and until t186 the second half of that sentence had no code: the
 * probe existed, was tested, and was reached only from three diagnostic
 * commands — never from the daemon's own startup. This is that gate, and it
 * decides one thing only.
 *
 * Three decisions, each with a plausible opposite:
 *
 * - **`available` is the whole question, and `authenticated` is not part of
 *   it.** The specification demoted `authenticated` to best effort in writing —
 *   there is an engine whose credential failure only shows up in the middle of
 *   the first session (`engine/types.ts`, `CliProbe`). Gating on a field that
 *   promises no more than "I found no reason to fail" would hide the catalog of
 *   installations that work, which is a false negative bought with nothing.
 * - **A probe that THROWS is a probe that failed.** Neither adapter's
 *   `verifyCli` rejects today — a missing binary resolves `available: false` —
 *   but the interface is published and a third-party adapter may reject. Read
 *   here as "no", never as an exception travelling up into the startup path.
 * - **Never fatal, and that is deliberate.** The runner comes up either way.
 *   The catalog is discovery, never enforcement (`engine/types.ts`,
 *   `listModels`), so a preflight that found nothing costs a menu — while
 *   refusing to start costs every job this machine would have taken, including
 *   the ones a probe can be wrong about.
 *
 * @param engine Name this runner's engine answers to.
 * @param adapter The adapter to probe.
 * @returns `true` when the CLI answered.
 */
async function verifyEngineCli(engine: string, adapter: EngineAdapter): Promise<boolean> {
  try {
    const probe = await adapter.verifyCli();
    if (probe.available) return true;

    process.stderr.write(
      `cartografo-runner: the "${engine}" CLI did not answer the preflight — no model catalog will be reported\n`,
    );
    return false;
  } catch (error) {
    process.stderr.write(
      `cartografo-runner: the "${engine}" preflight failed — ${describeError(error)}\n`,
    );
    return false;
  }
}

/**
 * Tells the control plane which models this runner's engine offers (t166, FR11).
 *
 * Four decisions, each with a plausible opposite:
 *
 * - **Never fatal.** A catalog that could not be reported is a menu an operator
 *   cannot read; a runner that refused to start over it is a machine that does
 *   no work at all. The second is strictly worse, and the posture matches
 *   `Controller.lastHeartbeatError` — log it and keep going.
 * - **After pairing, before the first tick.** The route is inside `/v1`, so it
 *   needs a credential the pairing has already presented, and reporting a
 *   catalog nobody can attribute to a known runner would be reporting into the
 *   dark. Before the first tick because that is when the process knows what it
 *   is and has not started spending.
 * - **After the CLI answered, and not before** (t186). A catalog is what a
 *   binary CAN run, and an adapter whose binary is not there is reciting a menu
 *   for a kitchen nobody found: the operator picking a model off it in a graph
 *   would have their choice refused at the first session, one node too late.
 *   The probe is cheap and spends no quota — that is what the interface
 *   promises of it — so the honest order costs one `--version` per process.
 * - **Skipped, silently, for an adapter that does not implement it.**
 *   `listModels` is optional ON THE MEMBER (`engine/types.ts`), and an adapter
 *   without one is a legitimate adapter, not a broken one. There is nothing to
 *   warn about.
 *
 * The adapter's vocabulary dies here: `EngineModel`'s `id`/`label`/`origin`
 * become the API's `modelo_id`/`rotulo`/`origem`, which is the boundary the
 * client already keeps for every other route.
 *
 * @param client Control plane client, already credentialed.
 * @param engine Name this runner's engine answers to.
 * @param adapter The adapter to ask.
 */
async function reportModels(
  client: ControlPlaneClient,
  engine: string,
  adapter: EngineAdapter,
): Promise<void> {
  if (adapter.listModels === undefined) return;

  // The probe comes first and the order is the point: an adapter with no
  // listModels is asked for nothing at all, so the preflight only runs for an
  // engine that actually has a catalog to report (t186).
  if (!(await verifyEngineCli(engine, adapter))) return;

  try {
    const catalog = await adapter.listModels();
    await client.reportEngineModels(
      engine,
      catalog.models.map((model) => ({
        model_id: model.id,
        label: model.label ?? null,
        source: model.origin,
      })),
    );
  } catch (error) {
    process.stderr.write(
      `cartografo-runner: could not report the model catalog of "${engine}" — ${describeError(error)}\n`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* t401 — what this machine is, reported to whoever has to operate it          */
/* -------------------------------------------------------------------------- */

/**
 * Is this directory inside a git working tree?
 *
 * Never throws, on the discipline `mcp-discovery.ts`'s file readers already
 * keep: a missing `git` binary, a directory that is not a repository and a
 * spawn that failed are all `false`, because the fact being reported is "this
 * runner cannot cut a worktree here" and an exception travelling out of a
 * DISCOVERY call would take the whole report with it.
 *
 * `--is-inside-work-tree` and not `--git-dir`: what matters is whether a
 * session's worktree can be cut from this path, and a bare repository answers
 * the second question and not the first.
 *
 * **`execFileSync`, and measured before being left that way (t434).** This is
 * the only synchronous subprocess spawn in the runner — every adapter uses
 * async `spawn()` — so it was the first suspect when the startup window this
 * report is built in went over AT12's shutdown bound. It is not the cause: it
 * measured 18-39ms across the startup of every case in
 * `test/cli/run.e2e.test.ts`, against 2_100-3_600ms for the MCP discovery two
 * lines below it in the same report. Named here rather than changed, because
 * rewriting the call that is 1% of the window would have made the number look
 * addressed while the other 99% stayed. Whoever finds a host where a `git
 * rev-parse` costs more than that has the timing above to compare against.
 *
 * @param directory Absolute path to ask about.
 * @returns Whether git claims it is inside a working tree.
 */
function isGitRepository(directory: string): boolean {
  try {
    const answer = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return answer.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Could this process create the worktrees root, whether or not it exists yet?
 *
 * The walk up is the whole point. `GitWorktreeManager` creates the root lazily,
 * on the first `acquire()` (`dispatch/session-worktree.ts`), so "does not exist
 * yet" is the ORDINARY state of a runner that has not dispatched anything —
 * and asking `access()` about a path that is not there would answer `false` for
 * every healthy new machine. What an operator wants to know is whether the
 * runner will be able to make it, so the question is asked of the nearest
 * ancestor that does exist.
 *
 * The loop terminates at the filesystem root, where `path.dirname` returns its
 * own argument.
 *
 * @param directory Absolute path of the root, existing or not.
 * @returns Whether the nearest existing ancestor is writable.
 */
function couldCreate(directory: string): boolean {
  let candidate = directory;
  for (;;) {
    if (existsSync(candidate)) {
      try {
        accessSync(candidate, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}

/**
 * Builds the report of what this machine is (t401, FR7/FR8).
 *
 * Three sources, and the posture of each is different on purpose:
 *
 * - **`verifyCli()` is called FRESH, never reused.** `verifyEngineCli` above
 *   throws its `CliProbe` away and keeps one boolean, and a report assembled
 *   from that boolean would be inventing a `version` and an `authenticated` it
 *   never saw. The probe spends no quota — that is what the interface promises
 *   of it — so calling it twice costs one `--version` per process.
 * - **`discoverMcpServers` is guarded on the METHOD**, and its absence is
 *   reported as `{supported: false}` rather than as an empty list. The
 *   interface is explicit about why (`engine/types.ts`): an adapter that never
 *   implemented discovery is not an engine with zero MCP servers, and a caller
 *   that collapses the two tells an operator a lie about their own machine. A
 *   call that THROWS reads the same way — the adapter could not answer — and is
 *   logged rather than propagated.
 * - **A probe that fails is still a probe.** `available: false` is the fact
 *   worth reporting, which is exactly where this diverges from the model
 *   catalog: `reportModels` skips for a CLI that did not answer, because a menu
 *   for a kitchen nobody found is worse than no menu. There is no equivalent
 *   here — "the binary is not there" is what an operator opened the page to
 *   learn.
 *
 * Never throws. Every branch that could is caught here, because the caller is a
 * startup path and a loop iteration, and neither one may die over discovery.
 *
 * @param adapter The adapter to ask.
 * @param engine Name this runner's engine answers to, for the log lines.
 * @param repoRoot The git repository this runner works out of, as it was
 *   settled: `--working-dir` as the operator wrote it, or the project's
 *   `workspace_root` for a runner started with no path flags (t404).
 * @param worktreesRoot The directory worktrees are cut under, settled the same
 *   way from `--worktrees-root` or the project's `worktrees_root`.
 * @returns The report, ready to post.
 */
export async function buildProbeReport(
  adapter: EngineAdapter,
  engine: string,
  repoRoot: string,
  worktreesRoot: string,
): Promise<ProbeReport> {
  let cli = { available: false, version: null as string | null, authenticated: false };
  try {
    const probe = await adapter.verifyCli();
    cli = { available: probe.available, version: probe.version, authenticated: probe.authenticated };
  } catch (error) {
    process.stderr.write(
      `cartografo-runner: the "${engine}" preflight failed — ${describeError(error)}\n`,
    );
  }

  let mcp: ProbeReport['mcp'] = { supported: false };
  if (adapter.discoverMcpServers !== undefined) {
    try {
      const discovered = await adapter.discoverMcpServers();
      mcp = {
        supported: true,
        servers: discovered.servers.map((server) => ({ name: server.name })),
        origin: discovered.origin,
        resolved_at: discovered.resolvedAt,
      };
    } catch (error) {
      // Reported as "not supported" rather than as an empty list, and the log
      // line is what tells the two apart for whoever is debugging: an adapter
      // that could not answer knows no more about this machine's MCP servers
      // than one that has no discovery at all.
      process.stderr.write(
        `cartografo-runner: MCP discovery of "${engine}" failed — ${describeError(error)}\n`,
      );
    }
  }

  const workingDirResolved = path.resolve(repoRoot);
  const worktreesRootResolved = path.resolve(worktreesRoot);

  return {
    cli,
    mcp,
    workspace: {
      working_dir: repoRoot,
      working_dir_resolved: workingDirResolved,
      is_git_repo: isGitRepository(workingDirResolved),
      worktrees_root: worktreesRoot,
      worktrees_root_resolved: worktreesRootResolved,
      worktrees_root_exists: existsSync(worktreesRootResolved),
      worktrees_root_writable: couldCreate(worktreesRootResolved),
    },
  };
}

/**
 * Builds the report and posts it, swallowing a refusal (t401, FR7).
 *
 * Never fatal, on `reportModels`'s own reasoning: a probe the control plane
 * would not take is a page an operator cannot read, and a runner that refused
 * to start over it is a machine that does no work at all. The second is
 * strictly worse.
 *
 * @param client Control plane client, already credentialed.
 * @param options The runner's own identity.
 * @param resolved The engine and the two paths, as t404's fallback settled
 *   them. Read from here and never off `options`: a runner spawned with no path
 *   flags carries `undefined` there, and a probe reporting `undefined` for the
 *   workspace is exactly the page an operator opened to read the paths on.
 * @param adapter The adapter to ask.
 * @returns The report that was built, whether or not the control plane took it;
 *   `null` when building it threw. The startup reads its `mcp` half and hands
 *   it to the dispatch (t360, FR4), which is the whole reason this stopped
 *   being a `void`: the discovery inside it costs one CLI spawn, and a second
 *   resolver calling `discoverMcpServers()` again would spend one more per
 *   session for an answer that cannot have changed inside a process.
 */
async function reportProbe(
  client: ControlPlaneClient,
  options: RunnerOptions,
  resolved: ResolvedRunnerPaths,
  adapter: EngineAdapter,
): Promise<ProbeReport | null> {
  let report: ProbeReport;
  try {
    report = await buildProbeReport(
      adapter,
      resolved.engine,
      resolved.repoRoot,
      resolved.worktreesRoot,
    );
  } catch (error) {
    process.stderr.write(
      `cartografo-runner: could not build the probe of "${options.runnerId}" — ${describeError(error)}\n`,
    );
    return null;
  }

  try {
    await client.reportProbe(options.runnerId, report);
  } catch (error) {
    process.stderr.write(
      `cartografo-runner: could not report the probe of "${options.runnerId}" — ${describeError(error)}\n`,
    );
  }
  return report;
}

/**
 * The probe's MCP half, in the shape the executor environment declares (t360).
 *
 * A mapper and nothing else, and it exists so that the honesty rule survives the
 * translation: `{supported: false}` stays `{supported: false}` — never an empty
 * list — because an adapter that implements no discovery knows no more about
 * this machine than one that found nothing, and the session has to be able to
 * tell those apart (`engine/types.ts`, t400 FR7).
 *
 * A report that could not be built at all reads the same way, which is why the
 * `null` case lands here too: nothing was discovered, and nothing is claimed.
 *
 * @param report What the startup probe found, or `null`.
 * @returns The discovery, as the dispatch's seam takes it.
 */
function mcpDiscoveryOf(report: ProbeReport | null): McpDiscoveryResult {
  const mcp = report?.mcp;
  if (mcp === undefined || mcp.supported !== true) return { supported: false };
  return { supported: true, servers: mcp.servers.map((server) => server.name) };
}

/**
 * Asks whether anybody wants a fresh probe, and reports one if so (t401, FR9).
 *
 * Called from `runRunner`'s own loop, beside `controller.tick()` and NOT inside
 * `Controller`: the re-check has nothing to do with lease dispatch, which is
 * that class's one job and whose only seam is the injected `dispatch` callback.
 *
 * The same cadence as the dispatch tick, and deliberately no interval of its
 * own: no code in this repository has two interval knobs yet, and inventing one
 * here is scope nobody asked for.
 *
 * Never throws, and never stops the loop. A control plane that refused the
 * question is the same class of failure as one that refused the report — logged
 * to stderr, and the next iteration asks again.
 *
 * @param client Control plane client, already credentialed.
 * @param options The runner's own identity.
 * @param resolved The engine and the two paths t404's fallback settled, for the
 *   fresh report this may end up sending.
 * @param adapter The adapter to ask, when there is something to answer.
 */
async function maybeServeRecheck(
  client: ControlPlaneClient,
  options: RunnerOptions,
  resolved: ResolvedRunnerPaths,
  adapter: EngineAdapter,
): Promise<void> {
  let pending;
  try {
    pending = await client.getPendingRecheck(options.runnerId);
  } catch (error) {
    process.stderr.write(
      `cartografo-runner: could not ask about a re-check — ${describeError(error)}\n`,
    );
    return;
  }

  // Nothing pending, nothing else happens: the ordinary answer, on every
  // iteration of a runner nobody is asking anything of.
  if (pending === null) return;

  // Reporting the fresh probe is ALSO what marks the request served — the
  // control plane does it in the same transaction as the write, so there is no
  // acknowledgement call to make here and no window in which a served request
  // has no probe behind it.
  await reportProbe(client, options, resolved, adapter);
}

/**
 * Decides where this runner writes and what it opens sessions on (t404, FR5).
 *
 * Two modes, and which one applies is read off the command line rather than
 * configured: an operator who named both paths gets exactly what they named and
 * **no network call at all** — asking a control plane to confirm a decision
 * somebody already typed is a round trip that can only disagree. Anybody else
 * — the one-command startup's runner, spawned with no flags of its own — gets
 * the project's settings, and the flags that WERE given still win, field by
 * field.
 *
 * The fetch happens after the pairing, on purpose: `GET /v1/settings` is
 * inside `/v1`, so it needs a credential the pairing has already presented, and
 * a runner that could not pair has nothing to configure anyway.
 *
 * `DEFAULT_ENGINE_NAME` is applied here and nowhere else. It is the last of
 * three sources — the flag, then the setting, then the default — which is what
 * keeps a default that means "claude-code" from silently beating a project that
 * said `codex`.
 *
 * @param client Control plane client, already paired.
 * @param options What the command line settled.
 * @returns The three values, all defined and all valid.
 * @throws {SettingsFallbackError} When the settings answered with no path, or
 *   with an engine this runner has no adapter for.
 */
async function resolveRunnerPaths(
  client: ControlPlaneClient,
  options: RunnerOptions,
): Promise<ResolvedRunnerPaths> {
  if (options.repoRoot !== undefined && options.worktreesRoot !== undefined) {
    return {
      repoRoot: options.repoRoot,
      worktreesRoot: options.worktreesRoot,
      // Defensive only: the CLI defaults the engine whenever a path flag was
      // given, so this branch never sees an undefined one from that door.
      engine: options.engine ?? DEFAULT_ENGINE_NAME,
    };
  }

  const settings = await client.getSettings(options.projectId);
  const repoRoot = options.repoRoot ?? settings.workspace_root;
  const worktreesRoot = options.worktreesRoot ?? settings.worktrees_root;
  const engine = options.engine ?? (settings.engine as EngineName | undefined) ?? DEFAULT_ENGINE_NAME;

  if (repoRoot === undefined || worktreesRoot === undefined) {
    const missing = [
      ...(repoRoot === undefined ? ['workspace_root'] : []),
      ...(worktreesRoot === undefined ? ['worktrees_root'] : []),
    ];
    throw new SettingsFallbackError(
      `the control plane holds no ${missing.join(' and no ')} for project ${String(options.projectId)}, ` +
        'and this runner was started without --working-dir/--worktrees-root: those two say which ' +
        'repository a session\'s worktree is cut from and where it is created, and there is no ' +
        'safe default for where a session may write — set them with `PATCH /v1/settings`, or ' +
        'start this runner with --working-dir and --worktrees-root',
    );
  }

  // Checked here rather than left to the dispatch: an engine name nothing
  // answers to would come back as an `UnknownEngineError` on the first node,
  // one lease and one blocked job later, saying nothing about the setting that
  // caused it.
  if (!(ENGINE_NAMES as readonly string[]).includes(engine)) {
    throw new SettingsFallbackError(
      `the control plane's engine for project ${String(options.projectId)} is "${engine}", which is ` +
        `not one of ${ENGINE_NAMES.join(', ')} — fix it with \`PATCH /v1/settings\`, or start this ` +
        'runner with --engine',
    );
  }

  return { repoRoot, worktreesRoot, engine };
}

/**
 * Builds the hook that reads the skills a person already has (t440, FR7).
 *
 * Two things it owns, and they are the two this file is the only place for: the
 * `allow_git_clone` setting, which has no command-line flag of its own, and the
 * scratch directory the clones land in — `<worktreesRoot>/.skill-sources`,
 * beside the worktrees and never inside one, because the input is resolved
 * before a worktree exists (`dispatch.ts:271` vs `:303`).
 *
 * **The settings are read on FIRST USE and not at startup**, which is the one
 * departure this ficha takes from its own wording, and it is forced by a test
 * that already existed: t404 AT8 pins that a runner given both `--working-dir`
 * and `--worktrees-root` never calls `GET /v1/settings` at all — "an operator
 * who said where the worktrees go is not asked to confirm it over HTTP". A
 * second unconditional read at boot would have broken that promise for every
 * runner, in exchange for reading a switch most dispatches never need. Read
 * lazily, the route is touched only by an installation that actually interviews
 * somebody, and once per process after that.
 *
 * A settings read that fails is not a refusal and not a crash: it comes back as
 * this hook's `error`, which the interview relays to the person, and the memo is
 * dropped so the next turn tries again.
 *
 * @param client Control plane client, already paired.
 * @param projectId Project whose `allow_git_clone` governs this runner (D25).
 * @param worktreesRoot Where the worktrees go; the scratch root is its sibling.
 * @returns The `resolveSkillSource` hook of the executor environment.
 */
function createConfiguredSkillSourceResolver(
  client: ControlPlaneClient,
  projectId: number,
  worktreesRoot: string,
): (source: SkillSource) => Promise<SkillSourceResult> {
  const scratchRoot = path.join(worktreesRoot, '.skill-sources');
  let configured: Promise<(source: SkillSource) => Promise<SkillSourceResult>> | null = null;

  const build = async (): Promise<(source: SkillSource) => Promise<SkillSourceResult>> => {
    const settings = await client.getSettings(projectId);
    // Seeded `'true'` (t439), so an unconfigured project clones: anything but
    // the literal `'false'` is yes, which is the same reading every other
    // string setting of this table gets.
    return createSkillSourceResolver({
      allowGitClone: settings.allow_git_clone !== 'false',
      scratchRoot,
    });
  };

  return async (source: SkillSource): Promise<SkillSourceResult> => {
    try {
      return await (await (configured ??= build()))(source);
    } catch (error) {
      configured = null;
      return {
        drafts: [],
        error:
          `this runner could not read project ${String(projectId)}'s settings, so it does not ` +
          `know whether it may clone: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };
}

/**
 * Runs a runner until it is asked to stop.
 *
 * @param options Control plane, identity, engine and the loop's numbers.
 * @returns A promise that resolves once the loop has stopped and nothing it
 *   dispatched is still in flight.
 */
export async function runRunner(options: RunnerOptions): Promise<void> {
  const client = new ControlPlaneClient({
    urlBase: options.url,
    token: options.token,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  /** Has a stop been asked for? Read fresh: the answer changes under an await. */
  const stopped = (): boolean => options.signal?.aborted === true;

  // Declared HERE, above the startup, and read between every phase of it
  // (t434, FR3). Until this ticket the first read was after all four had run,
  // so a stop that landed during the startup waited out the rest of it — and
  // the startup is no longer the cheap thing that assumption was written
  // against: `reportProbe` grew a second preflight and an MCP discovery
  // (t401, t360), and that discovery spawns the engine's own CLI. `claude mcp
  // list` measured 2_142ms on an unloaded developer host, and fork/exec is one
  // of the few costs in this path that scales badly under contention, which is
  // how the same window reached ~5.5s on a machine at load 31.
  //
  // The check is BETWEEN the phases and never inside them: the awaited phase
  // is already spent, and abandoning it mid-flight would leave a report the
  // control plane half-took. What it buys is that no phase which had not
  // STARTED begins after the signal fired.
  //
  // A bare `return` and nothing to unwind: no lease has been taken, no session
  // is in flight, and `onReady` has not fired — the runner never came up, so
  // there is nothing for it to announce or hand back.

  // First call of the process, and it is not negotiable: everything below
  // answers 404 for a runner the control plane has never heard of.
  await client.registerRunner(options.runnerId);
  if (stopped()) return;

  // Second call, and only when there is something left to decide: the three
  // values everything below reads come either from the command line or from
  // this project's settings, and until this line a settings-mode runner does
  // not know where it may write (t404, FR5).
  const resolved = await resolveRunnerPaths(client, options);
  if (stopped()) return;

  // Two routes, and the key of each is the engine's own name: the dispatch
  // resolves the engine from the NODE the work is standing on, so a node that
  // declares a third one lands on `UnknownEngineError` instead of quietly
  // running somewhere nobody chose (t141, FR5). Which two, and why `shell` is
  // not a `--engine` choice, is {@link buildEngineRoutes}.
  const engines = buildEngineRoutes(resolved.engine, options.engineFactory);
  const route = engines[resolved.engine] as EngineRoute;

  // Preflight and then discovery, in that order and after the pairing — the
  // whole of FR11's precondition, in one call (t166, t186). Neither half is on
  // the critical path: a CLI that did not answer and a report that was refused
  // are both logged, and the runner goes on to work.
  await reportModels(client, resolved.engine, route.adapter);
  if (stopped()) return;

  // ...and then what the operator page reads: the same preflight, the MCP
  // servers this engine names, and the two directories this process was pointed
  // at (t401, FR7). Unconditional, unlike the catalogue above: a CLI that did
  // not answer is exactly the fact worth reporting.
  //
  // Kept, since t360, rather than discarded: the discovery inside it is also
  // what a dispatched session is told at `input.environment.mcp_servers`, and
  // computing it twice would be two CLI spawns and two answers about one
  // machine.
  const probe = await reportProbe(client, options, resolved, route.adapter);
  if (stopped()) return;

  // The client the precedent resolver speaks through: the same address, the
  // same credential and the same deadline the dispatch itself uses. Built here
  // because `executorEnvironment` is an OPTION of the dispatch and is therefore
  // assembled before the dispatch exists — there is no earlier moment at which
  // its own internal client could be borrowed.
  const precedentsClient = createDispatchControlPlaneClient({
    urlBase: options.url,
    token: options.token,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });

  const controller = new Controller({
    client,
    runnerId: options.runnerId,
    projectId: options.projectId,
    runnerCap: options.runnerCap,
    projectCap: options.projectCap,
    ttlSeconds: options.leaseTtlSeconds,
    dispatch: createClaudeCodeDispatch({
      urlBase: options.url,
      token: options.token,
      engines,
      // The same project the controller polls and leases in (t410): three of
      // the dispatch's reads are scoped to one partition, and a dispatch left
      // reading the default project would be told the work it just leased does
      // not exist — a lease taken and given back on every tick, in silence.
      projectId: options.projectId,
      requestTimeoutMs: options.requestTimeoutMs,
      // Passed straight through: what this function knows about a live session
      // is nothing, and what the process owner needs is the handle to it (t193).
      onSessionStarted: options.onSessionStarted,
      onSessionEnded: options.onSessionEnded,
      // One manager for the whole process, and one worktree per dispatch out of
      // it: the isolation is per session, never per runner (t160, FR6).
      worktrees: new GitWorktreeManager({
        repoRoot: resolved.repoRoot,
        worktreesRoot: resolved.worktreesRoot,
      }),
      // Built ONCE for the whole process, and that is what makes
      // `instalacao_em_uso` mean anything: the single read it memoizes is
      // memoized for the life of THIS runner, which is the process the mode is
      // an assertion about (t270).
      executorEnvironment: createExecutorEnvironmentResolver({
        testBenchPath: options.testBenchPath ?? resolved.repoRoot,
        referenceMode: options.referenceMode ?? 'ponta_do_principal',
        ...(options.referenceRepo === undefined ? {} : { referenceRepo: options.referenceRepo }),
        ...(options.mainBranch === undefined ? {} : { mainBranch: options.mainBranch }),
        // A VALUE for the one that is a fact about this process, and a FUNCTION
        // for the one that is a fact about each job (t360, FR4).
        mcpDiscovery: mcpDiscoveryOf(probe),
        classPrecedents: createClassPrecedentsResolver(precedentsClient, options.projectId),
        // ...and a function of the SOURCE for the third: what a person answered
        // when the interview asked where their existing skills are (t440, FR7).
        // It reads a folder, or clones a repository shallow and throws it away;
        // nothing it finds is executed, and nothing enters the registry without
        // somebody registering it (D4).
        resolveSkillSource: createConfiguredSkillSourceResolver(
          client,
          options.projectId,
          resolved.worktreesRoot,
        ),
      }),
      // ...and the half that WRITES to that same bench (t273). Built once too,
      // out of the same two paths: the bench to advance, and the repository the
      // reported commit was born in — a worktree of `repoRoot` is where every
      // session works, so its object store is the only one that has it.
      advanceMainLine: createMainLineAdvancer({
        testBenchPath: options.testBenchPath ?? resolved.repoRoot,
        repoRoot: resolved.repoRoot,
        ...(options.mainBranch === undefined ? {} : { mainBranch: options.mainBranch }),
        ...(options.benchInstallCommand === undefined
          ? {}
          : { installCommand: options.benchInstallCommand }),
      }),
    }),
  });

  options.onReady?.(resolved);

  while (!stopped()) {
    try {
      await controller.tick();
    } catch (error) {
      // Logged, and that is all: the lease is already back, and the next tick
      // is a fresh question to the queue.
      process.stderr.write(`cartografo-runner: the tick failed — ${describeError(error)}\n`);
    }

    // Checked here as well as at the top: the abort usually lands while a
    // dispatch is running, and waiting out a full interval to notice would make
    // a stop look like a hang.
    if (stopped()) break;

    // Beside the tick and not inside it (t401, FR9): a re-check is a question
    // about this machine, and the controller's one job is turning a tick into a
    // lease. It swallows its own failures, so there is nothing to catch here.
    //
    // AFTER the stop check and not before it: a runner already asked to shut
    // down owes nobody a fresh probe, and one more round trip on the way out is
    // exactly the kind of delay the check above exists to avoid.
    await maybeServeRecheck(client, options, resolved, route.adapter);

    try {
      await delay(options.intervalMs, undefined, { signal: options.signal });
    } catch {
      // The only way this rejects is the shutdown landing while the loop was
      // waiting out its interval. That is the answer, not an error.
      break;
    }
  }
}
