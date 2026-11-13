/**
 * One runner process serving several projects (t1112).
 *
 * `runRunner` serves one project for its whole life: one controller, one
 * dispatch, one worktree manager, all out of one repository. This file is the
 * other composition, used when the command line names a selection
 * (`--projects 1,4,7` or `--all-projects`): ONE pairing and ONE identity for the
 * process, and one `Controller` per served project behind a round-robin
 * (`controller/project-rotation.ts`). Each controller is built by the same
 * `createProjectController` the single-project runner uses, out of THAT
 * project's repository, worktrees root and engine — so a lease, a worktree, a
 * bench or an input file of one project is never cut from another's
 * directories.
 *
 * Decisions worth stating, each with a plausible opposite:
 *
 * - **Each project's paths come from its settings, and only from there.** The
 *   command line refuses the four path flags with a selection
 *   (`cli/index.ts`): one `--working-dir` cannot be right for two projects.
 * - **A project that cannot be served is skipped, never fatal.** Missing
 *   settings, an engine nothing answers to, or a settings read that failed cost
 *   that project one stderr line — once per distinct reason — and the others go
 *   on. It is re-read at most every {@link SKIPPED_PROJECT_RECHECK_MS}, so a
 *   half-configured project does not cost a settings request per pass. A
 *   SERVED project is not re-read, the same as single-project mode: changing a
 *   ready project's paths needs a restart.
 * - **Engine facts are per engine, never per project.** One adapter, one model
 *   catalog and one MCP discovery per distinct engine name, shared by every
 *   project on it.
 * - **One probe per runner.** The control plane stores one probe per runner
 *   (latest wins), so the probe reports the workspace of the lowest served
 *   project id, and says so on stderr. A per-project probe would need a
 *   control-plane change this ticket does not make.
 * - **Still one session at a time.** A pass asks each project in turn and stops
 *   at the first dispatch; the dispatch is awaited before the next pass.
 *
 * English only.
 */

import { setTimeout as delay } from 'node:timers/promises';

import {
  ControlPlaneClient,
  ControlPlaneClientError,
  type ProbeReport,
} from '../controller/control-plane-client.ts';
import type { Controller } from '../controller/controller.ts';
import { ProjectRotation } from '../controller/project-rotation.ts';
import type { EngineRoute } from '../dispatch/dispatch.ts';
import {
  ENGINE_NAMES,
  buildEngineRoutes,
  buildProbeReport,
  buildWorkspaceReport,
  checkProjectSettings,
  createProjectController,
  deregisterQuietly,
  describeError,
  maybeServeRecheck,
  mcpDiscoveryOf,
  reportModels,
  type EngineName,
  type ProjectSelection,
  type ResolvedRunnerPaths,
  type RunnerOptions,
  type ServedProject,
  type SettingsProblem,
} from './run.ts';

/**
 * How long a skipped project waits before its settings are read again, in
 * milliseconds.
 *
 * Thirty seconds and no flag: long enough that a project nobody configured does
 * not cost a settings request on every two-second pass, short enough that
 * somebody who just fixed its settings sees it served without restarting.
 */
export const SKIPPED_PROJECT_RECHECK_MS = 30_000;

/**
 * `--all-projects` could not read the list of projects at startup.
 *
 * Its own class so that `failureMessage` (`cli/index.ts`) can say what happened
 * in terms of the flag the operator typed — and, for a 401/403, that listing
 * projects needs the operator credential — instead of reading it as a refused
 * pairing, which it is not: the pairing already went through.
 */
export class ProjectListingError extends Error {
  /** The HTTP status the control plane answered, or `null` when it did not answer. */
  readonly status: number | null;

  constructor(cause: unknown) {
    super(`--all-projects could not list the projects — ${describeError(cause)}`, { cause });
    this.name = 'ProjectListingError';
    this.status = cause instanceof ControlPlaneClientError ? cause.status : null;
  }
}

/** Test seams of {@link serveProjects}. Production passes none of them. */
export interface ServeProjectsSeams {
  /** The control plane. Default: a `ControlPlaneClient` built from the options. */
  client?: ControlPlaneClient;
  /** The clock the re-check window is measured with. Default: `Date.now`. */
  now?: () => number;
}

/** What is built once per engine name and shared by the projects on it. */
interface EngineState {
  /** The routing table: this engine, plus `shell`. */
  routes: Record<string, EngineRoute>;
  /** This engine's route, out of {@link routes}. */
  route: EngineRoute;
  /**
   * The probe built for the first project served on this engine: its CLI and
   * MCP halves are this engine's, and are reused for every project on it.
   */
  probe: ProbeReport | null;
}

/** One project being served. */
interface ServedRuntime {
  projectId: number;
  resolved: ResolvedRunnerPaths;
  controller: Controller;
}

/** A project that could not be served, and when it was last looked at. */
interface SkippedProject {
  reason: string;
  checkedAt: number;
}

/** The ids of a selection, sorted ascending with no duplicates. */
function sortedIds(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

/**
 * The one line a skipped project costs, after `project <id> skipped — `.
 *
 * It never mentions `--working-dir`/`--worktrees-root`, unlike the
 * single-project message: those flags are refused with a selection, and the
 * only place a multi-project runner reads paths from is each project's
 * settings.
 */
function describeProblem(problem: SettingsProblem): string {
  if (problem.kind === 'missing') {
    return (
      `its settings hold no ${problem.missing.join(' and no ')}: each project's workspace_root ` +
      'and worktrees_root come from its settings, and there is no safe default for where a ' +
      'session may write — set them with `PATCH /v1/settings`'
    );
  }
  return (
    `its engine setting is "${problem.engine}", which is not one of ${ENGINE_NAMES.join(', ')} — ` +
    'fix it with `PATCH /v1/settings`, or start this runner with --engine'
  );
}

/**
 * Runs a runner that serves several projects, until it is asked to stop.
 *
 * @param options What the command line settled; `options.projects` is set.
 * @param seams Test seams; production passes nothing.
 * @returns A promise that resolves once the loop has stopped and nothing it
 *   dispatched is still in flight.
 * @throws {ProjectListingError} `--all-projects` could not list the projects at
 *   startup. Anything the pairing throws travels up as itself.
 */
export async function serveProjects(
  options: RunnerOptions,
  seams: ServeProjectsSeams = {},
): Promise<void> {
  const selection: ProjectSelection | undefined = options.projects;
  if (selection === undefined) {
    throw new Error('serveProjects needs a selection of projects (options.projects)');
  }

  const client =
    seams.client ??
    new ControlPlaneClient({
      urlBase: options.url,
      token: options.token,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  const now = seams.now ?? Date.now;
  const stopped = (): boolean => options.signal?.aborted === true;
  const log = (line: string): void => {
    process.stderr.write(`cartografo-runner: ${line}\n`);
  };

  // The per-repository knobs are dropped from what every project is built
  // with: each project's bench and reference repository default to ITS
  // repository, which is what `createProjectController` does with them absent.
  const shared: RunnerOptions = {
    ...options,
    repoRoot: undefined,
    worktreesRoot: undefined,
    testBenchPath: undefined,
    referenceRepo: undefined,
  };

  const engines = new Map<EngineName, EngineState>();
  const served = new Map<number, ServedRuntime>();
  const skipped = new Map<number, SkippedProject>();
  const rotation = new ProjectRotation();
  let selected: number[] = selection.kind === 'list' ? sortedIds(selection.ids) : [];
  let lastListingFailure: string | null = null;
  let announced = false;
  let probedProjectId: number | null = null;

  /** The projects served now, in id order, limited to the current selection. */
  const servedNow = (): ServedRuntime[] =>
    selected.flatMap((id) => {
      const runtime = served.get(id);
      return runtime === undefined ? [] : [runtime];
    });

  /** Re-reads the list of projects, keeping the previous one if it fails. */
  const refreshListing = async (): Promise<void> => {
    if (selection.kind !== 'all') return;
    try {
      selected = sortedIds((await client.listProjects()).map((project) => project.id));
      lastListingFailure = null;
    } catch (error) {
      const message = describeError(error);
      if (message !== lastListingFailure) {
        log(`--all-projects could not list the projects; still serving the previous set — ${message}`);
        lastListingFailure = message;
      }
    }
  };

  /** Records why a project is not served, writing the line once per reason. */
  const skip = (projectId: number, reason: string): void => {
    if (skipped.get(projectId)?.reason !== reason) {
      log(`project ${String(projectId)} skipped — ${reason}`);
    }
    skipped.set(projectId, { reason, checkedAt: now() });
  };

  /**
   * The engine's routes, catalog and discovery, built the first time a project
   * on it is served.
   *
   * @returns The state, or `null` when a stop landed while it was being built.
   */
  const engineFor = async (resolved: ResolvedRunnerPaths): Promise<EngineState | null> => {
    const known = engines.get(resolved.engine);
    if (known !== undefined) return known;

    const routes = buildEngineRoutes(resolved.engine, options.engineFactory);
    const route = routes[resolved.engine] as EngineRoute;
    await reportModels(client, resolved.engine, route.adapter);
    if (stopped()) return null;

    let probe: ProbeReport | null = null;
    try {
      probe = await buildProbeReport(route.adapter, resolved.engine, resolved.repoRoot, resolved.worktreesRoot);
    } catch (error) {
      log(`could not build the probe of the "${resolved.engine}" engine — ${describeError(error)}`);
    }
    const state: EngineState = { routes, route, probe };
    engines.set(resolved.engine, state);
    return state;
  };

  /**
   * Resolves every selected project that is not served yet and is due a look.
   *
   * @returns `false` when a stop landed: no resolution starts after it.
   */
  const resolveRound = async (): Promise<boolean> => {
    for (const projectId of selected) {
      if (served.has(projectId)) continue;
      const previous = skipped.get(projectId);
      if (previous !== undefined && now() - previous.checkedAt < SKIPPED_PROJECT_RECHECK_MS) continue;
      if (stopped()) return false;

      let checked;
      try {
        checked = checkProjectSettings(await client.getSettings(projectId), { engine: options.engine });
      } catch (error) {
        skip(projectId, `its settings could not be read (${describeError(error)})`);
        continue;
      }
      if (checked.problem !== undefined) {
        skip(projectId, describeProblem(checked.problem));
        continue;
      }
      if (stopped()) return false;

      const { resolved } = checked;
      const engine = await engineFor(resolved);
      if (engine === null) return false;

      served.set(projectId, {
        projectId,
        resolved,
        controller: createProjectController({
          client,
          options: shared,
          projectId,
          resolved,
          engines: engine.routes,
          mcpDiscovery: mcpDiscoveryOf(engine.probe),
        }),
      });
      skipped.delete(projectId);
      if (announced) {
        log(
          `project ${String(projectId)} is now served — engine ${resolved.engine}, ` +
            `repository ${resolved.repoRoot}, worktrees root ${resolved.worktreesRoot}`,
        );
      }
    }
    return true;
  };

  /** Reports the probe for the lowest served project, when that project changed. */
  const reportProbeIfNeeded = async (): Promise<void> => {
    const first = servedNow()[0];
    if (first === undefined || first.projectId === probedProjectId) return;
    probedProjectId = first.projectId;

    const engine = engines.get(first.resolved.engine) as EngineState;
    const report: ProbeReport | null =
      engine.probe === null
        ? null
        : { ...engine.probe, workspace: buildWorkspaceReport(first.resolved.repoRoot, first.resolved.worktreesRoot) };
    if (report === null) return;

    log(
      `the probe reports project ${String(first.projectId)}'s workspace (${first.resolved.repoRoot}), ` +
        'the lowest project id served: the control plane keeps one probe per runner',
    );
    try {
      await client.reportProbe(options.runnerId, report);
    } catch (error) {
      log(`could not report the probe of "${options.runnerId}" — ${describeError(error)}`);
    }
  };

  // First call of the process, as in single-project mode: everything below
  // answers 404 for a runner the control plane has never heard of.
  await client.registerRunner(options.runnerId);

  try {
    if (stopped()) return;

    if (selection.kind === 'all') {
      try {
        selected = sortedIds((await client.listProjects()).map((project) => project.id));
      } catch (error) {
        throw new ProjectListingError(error);
      }
      if (stopped()) return;
    }

    if (!(await resolveRound())) return;
    await reportProbeIfNeeded();
    if (stopped()) return;

    announced = true;
    options.onReadyProjects?.(
      servedNow().map(({ projectId, resolved }): ServedProject => ({
        projectId,
        engine: resolved.engine,
        repoRoot: resolved.repoRoot,
        worktreesRoot: resolved.worktreesRoot,
      })),
    );

    let firstPass = true;
    while (!stopped()) {
      // Before every pass but the first, whose listing and resolution the
      // startup above already did.
      if (!firstPass) {
        await refreshListing();
        if (stopped()) break;
        if (!(await resolveRound())) break;
        await reportProbeIfNeeded();
        if (stopped()) break;
      }
      firstPass = false;

      try {
        await rotation.pass(
          servedNow().map(({ projectId, controller }) => ({ projectId, controller })),
          stopped,
        );
      } catch (error) {
        // Logged, as in single-project mode: the lease is already back, and the
        // rotation has already moved past the project that failed.
        log(`the tick failed — ${describeError(error)}`);
      }

      if (stopped()) break;

      const first = servedNow()[0];
      if (first !== undefined) {
        const engine = engines.get(first.resolved.engine) as EngineState;
        await maybeServeRecheck(client, shared, first.resolved, engine.route.adapter);
      }

      try {
        await client.registerRunner(options.runnerId);
      } catch (error) {
        log(`could not refresh "${options.runnerId}" — ${describeError(error)}`);
      }

      try {
        await delay(options.intervalMs, undefined, { signal: options.signal });
      } catch {
        break;
      }
    }
  } finally {
    await deregisterQuietly(client, options.runnerId);
  }
}
