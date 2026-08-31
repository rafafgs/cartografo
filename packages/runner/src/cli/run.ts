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

import { setTimeout as delay } from 'node:timers/promises';

import { ControlPlaneClient } from '../controller/control-plane-client.ts';
import { Controller } from '../controller/controller.ts';
import { createMainLineAdvancer } from '../dispatch/advance-main-line.ts';
import { createClaudeCodeDispatch, type EngineRoute } from '../dispatch/dispatch.ts';
import {
  createExecutorEnvironmentResolver,
  type ReferenceMode,
} from '../dispatch/resolve-executor-environment.ts';
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
  /** The one engine every session of this process opens on. */
  engine: EngineName;
  /**
   * The git repository each session's worktree is cut from (t179).
   *
   * `--working-dir` on the command line, and NOT what a session writes in: the
   * directory a session actually gets is a worktree of this repository, minted
   * per dispatch (`SessionSpec.workingDir`, `session-worktree.ts`). The two
   * were the same string until t160, which is what the first dogfood run paid
   * for; the names are different now so that the code cannot confuse them
   * again.
   */
  repoRoot: string;
  /**
   * The directory those worktrees are created under.
   *
   * A sibling of {@link repoRoot} and never inside it: a worktree cut into the
   * repository it came from shows up as untracked content in that repository's
   * own `git status`. Required, with no default — `--worktrees-root` on the
   * command line, and the CLI is where that is enforced.
   */
  worktreesRoot: string;
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
   */
  onReady?: () => void;
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

  // First call of the process, and it is not negotiable: everything below
  // answers 404 for a runner the control plane has never heard of.
  await client.registerRunner(options.runnerId);

  // Two routes, and the key of each is the engine's own name: the dispatch
  // resolves the engine from the NODE the work is standing on, so a node that
  // declares a third one lands on `UnknownEngineError` instead of quietly
  // running somewhere nobody chose (t141, FR5). Which two, and why `shell` is
  // not a `--engine` choice, is {@link buildEngineRoutes}.
  const engines = buildEngineRoutes(options.engine, options.engineFactory);
  const route = engines[options.engine] as EngineRoute;

  // Preflight and then discovery, in that order and after the pairing — the
  // whole of FR11's precondition, in one call (t166, t186). Neither half is on
  // the critical path: a CLI that did not answer and a report that was refused
  // are both logged, and the runner goes on to work.
  await reportModels(client, options.engine, route.adapter);

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
      requestTimeoutMs: options.requestTimeoutMs,
      // Passed straight through: what this function knows about a live session
      // is nothing, and what the process owner needs is the handle to it (t193).
      onSessionStarted: options.onSessionStarted,
      onSessionEnded: options.onSessionEnded,
      // One manager for the whole process, and one worktree per dispatch out of
      // it: the isolation is per session, never per runner (t160, FR6).
      worktrees: new GitWorktreeManager({
        repoRoot: options.repoRoot,
        worktreesRoot: options.worktreesRoot,
      }),
      // Built ONCE for the whole process, and that is what makes
      // `instalacao_em_uso` mean anything: the single read it memoizes is
      // memoized for the life of THIS runner, which is the process the mode is
      // an assertion about (t270).
      executorEnvironment: createExecutorEnvironmentResolver({
        testBenchPath: options.testBenchPath ?? options.repoRoot,
        referenceMode: options.referenceMode ?? 'ponta_do_principal',
        ...(options.referenceRepo === undefined ? {} : { referenceRepo: options.referenceRepo }),
        ...(options.mainBranch === undefined ? {} : { mainBranch: options.mainBranch }),
      }),
      // ...and the half that WRITES to that same bench (t273). Built once too,
      // out of the same two paths: the bench to advance, and the repository the
      // reported commit was born in — a worktree of `repoRoot` is where every
      // session works, so its object store is the only one that has it.
      advanceMainLine: createMainLineAdvancer({
        testBenchPath: options.testBenchPath ?? options.repoRoot,
        repoRoot: options.repoRoot,
        ...(options.mainBranch === undefined ? {} : { mainBranch: options.mainBranch }),
        ...(options.benchInstallCommand === undefined
          ? {}
          : { installCommand: options.benchInstallCommand }),
      }),
    }),
  });

  options.onReady?.();

  /** Has a stop been asked for? Read fresh: the answer changes under an await. */
  const stopped = (): boolean => options.signal?.aborted === true;

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

    try {
      await delay(options.intervalMs, undefined, { signal: options.signal });
    } catch {
      // The only way this rejects is the shutdown landing while the loop was
      // waiting out its interval. That is the answer, not an error.
      break;
    }
  }
}
