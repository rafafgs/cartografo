/**
 * The packaged composition: what the runner IS, once it stops being four
 * objects and becomes a process (t162, FR5–FR7).
 *
 * Everything below already existed and is already tested on its own —
 * `ClienteControle` (t103) speaks HTTP, `Controller` (t103) turns a tick into a
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
 *   lease without having registered gets `404 runner_desconhecido`
 *   (`packages/core/src/routes/leases.ts:169`), which is a configuration error
 *   dressed as a queue answer — insisting on it never helps.
 * - **A tick that rejects is logged and the loop keeps turning.** The lease is
 *   already back by the time the rejection gets here: the controller returns it
 *   in its own `finally` (`controller.ts:143-160`) whatever the dispatch did.
 *   So what is left to decide is only whether ONE bad job may end a runner's
 *   day, and it may not — a graph node asking for an engine this runner has no
 *   route for is exactly that kind of local failure.
 * - **Shutdown waits for the dispatch in flight.** Aborting stops the loop from
 *   SCHEDULING, never mid-session: killing a live session from out here would
 *   leave a process writing in its worktree with nobody left to report what it
 *   did — and nobody left to give the worktree back. A dispatch that is already
 *   running finishes (or fails) through the paths `dispatch-claude-code.ts`
 *   already has, and only then does the promise this function returns resolve.
 * - **The worktree manager is built here, out of two paths the operator gave**
 *   (t179). `createClaudeCodeDispatch` requires a `WorktreeManager` and has no
 *   default for it, and `GitWorktreeManager` has no default for either of its
 *   paths — deliberately, both of them: where a session may write is the
 *   operator's decision, and a location guessed in code is how the first
 *   dogfood run ended up with sessions writing in the operator's own checkout
 *   (`notas/2026-08-15-primeira-execucao.md`, gap #6). This function is the
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

import { ClienteControle } from '../controller/cliente-controle.ts';
import { Controller } from '../controller/controller.ts';
import { createClaudeCodeDispatch, type EngineRoute } from '../dispatch/dispatch-claude-code.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
} from '../dispatch/session-text.ts';
import { GitWorktreeManager } from '../dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import { CodexAdapter } from '../engine/codex-adapter.ts';

/**
 * The engines a packaged runner can be pointed at.
 *
 * The two adapters that exist, and it is not a coincidence that there are two:
 * t141 froze the `EngineAdapter` interface only once a second consumer had
 * shipped (rule of two consumers). A third name here means a third adapter, not
 * a third branch.
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
  /** Cap of simultaneous sessions this runner declares for itself. */
  runnerCap: number;
  /** Cap of simultaneous sessions declared for the project. */
  projectCap: number;
  /** Wait between one tick and the next, in milliseconds. */
  intervalMs: number;
  /** Term of the lease asked for, in seconds. */
  leaseTtlSeconds: number;
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
}

/** The real adapters, each paired with the decoder for its own frames. */
export function defaultEngineFactory(engine: EngineName): EngineRoute {
  return engine === 'codex'
    ? { adapter: new CodexAdapter(), decodeSessionText: decodeCodexSessionText }
    : { adapter: new ClaudeCodeAdapter(), decodeSessionText: decodeClaudeCodeSessionText };
}

/** One line about a failure, for stderr: name and message, never a stack. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Runs a runner until it is asked to stop.
 *
 * @param options Control plane, identity, engine and the loop's numbers.
 * @returns A promise that resolves once the loop has stopped and nothing it
 *   dispatched is still in flight.
 */
export async function runRunner(options: RunnerOptions): Promise<void> {
  const client = new ClienteControle({ urlBase: options.url, token: options.token });

  // First call of the process, and it is not negotiable: everything below
  // answers 404 for a runner the control plane has never heard of.
  await client.registrarRunner(options.runnerId);

  // Exactly one route, and the key is the engine's own name: the dispatch
  // resolves the engine from the NODE the work is standing on, so a node that
  // declares another one lands on `UnknownEngineError` instead of quietly
  // running somewhere nobody chose (t141, FR5).
  const route = (options.engineFactory ?? defaultEngineFactory)(options.engine);
  const engines: Record<string, EngineRoute> = { [options.engine]: route };

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
      // One manager for the whole process, and one worktree per dispatch out of
      // it: the isolation is per session, never per runner (t160, FR6).
      worktrees: new GitWorktreeManager({
        repoRoot: options.repoRoot,
        worktreesRoot: options.worktreesRoot,
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
