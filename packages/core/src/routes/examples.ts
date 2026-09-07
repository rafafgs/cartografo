/**
 * The examples routes (t408, RF-13/RF-27 to RF-29).
 *
 * Everything downstream of "a job exists" was already here: `cartografo import`
 * registers a bundle, the escalation cycle blocks a job on a question and
 * resumes it on the answer, the runner crosses a graph node by node. What was
 * missing is the ONE CLICK — nothing discovered which bundles are ready to be
 * demonstrated, nothing registered one it had never seen, and nothing opened a
 * job on it without a person choosing an execution id by hand.
 *
 * ## Why the scan lives here and not on the screen
 *
 * The screen is one more client of the public API, with no privilege at all
 * (D11): it opens no directory, imports nothing from this package and does not
 * know where the bundles are. So a screen that listed `factory-graphs/` by
 * itself would be the exact anti-pattern D11 exists to prevent, and
 * `docs/spec/screen.md` §4 records the precedent — every gap that layer hit was
 * closed with a new route on this side. These are the fourth and the fifth.
 *
 * ## Two routes, and the shape of each
 *
 * `GET /examples` scans an examples root for every immediate subdirectory that
 * carries a `demo/job.json`, and answers what it can read whole. A bundle
 * missing either file, or carrying an unparsable one, is SKIPPED in silence:
 * this is a discovery route, and a directory nobody can run is not an error
 * anybody asked about. Nothing here names a bundle.
 *
 * `POST /examples/:class/run` registers the bundle if this project has never
 * seen the class, then opens its demo job in a round of its own. It performs no
 * local `verifyBundle`-style pre-check, unlike `cli/import.ts`: that check
 * exists to save an HTTP round trip before the authoritative gates run, and
 * there is no round trip here — `registerSkill` and `registerGraphDocument` are
 * called in process, and they are the gates. Manifests already registered before
 * a later refusal stay registered, which is the same posture the CLI documents
 * for its own partial imports: each one passed the same gate on its own.
 *
 * ## The bundle that needs a repository (t409)
 *
 * Two of the three bundles this repository ships need nothing on disk to be
 * demonstrated: register, create the job, done. `software-development` is the
 * exception, and structurally so — every one of its nodes is dispatched into a
 * git worktree the runner cuts from its `repoRoot`, which with no flag on the
 * command line is the project's own `workspace_root` setting (t404). What
 * `cartografo up` leaves there is an EMPTY repository with one empty commit
 * (`cli/up.ts`'s `ensureDefaultWorkspace`), and a `develop` session dispatched
 * into an empty repository demonstrates nothing.
 *
 * So a bundle may ship a `demo/repo/` — a plain directory, with no `.git` in
 * this monorepo — and when it does, the run route COPIES it into
 * `workspace_root` and commits it there before the job is created. That copy is
 * the one destructive thing either route does, and {@link provisionDemoWorkspace}
 * is written to be certain rather than convenient: it provisions only a path
 * nobody can be using — missing, empty, or exactly the pristine one-empty-commit
 * repository `up` leaves behind — and otherwise refuses, having touched nothing.
 * A second run over a workspace the first one filled is refused by that same
 * rule, on purpose: resetting the workspace between demos is the operator's own
 * action, and guessing which of the files in there were disposable is not
 * something this route can do safely.
 *
 * The refusals come BEFORE the registration and before `createJob`, so a run
 * that cannot provision leaves the database exactly as it found it. And a bundle
 * with no `demo/repo/` never reaches any of it — `workspace_root` is not even
 * read.
 *
 * ## What it does NOT do
 *
 * It calls no route of its own API. Registering the graph goes through
 * `registerGraphDocument` — the body of `POST /v1/graphs`, extracted by this
 * ticket precisely so there is no loopback HTTP hop — and the job goes through
 * `createJob`, the same function `POST /v1/jobs` calls. Every refusal either of
 * them can produce is mapped here to the status code the equivalent route
 * already answers, so a client that knows one knows the other.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.ts';
import { getClassBase } from '../repositories/graphs.ts';
import { GraphVersionNotReadyError, createJob, nextExecutionId } from '../repositories/job.ts';
import { getSettings } from '../repositories/settings.ts';
import { SkillRejected, registerSkill } from '../repositories/skill.ts';
import { isObject } from '../util/is-object.ts';
import { registerGraphDocument } from './graphs.ts';
import {
  ERROR_RESPONSE_SCHEMA,
  OPEN_OBJECT_SCHEMA,
  refusal,
  requireProject,
  withValidation,
  type ErrorResponse,
} from './common.ts';

/**
 * Where the bundles are looked for.
 *
 * The default assumes a checkout, and the README already says so for
 * `cartografo import` in the same words: `factory-graphs/` is a directory of
 * this repository and is not shipped inside the package, so a bare `npm install
 * -g cartografo` has nothing to point at. Making that work — deciding whether
 * the example graphs ship, are fetched or are generated — is its own ticket, and
 * this variable is the seam it will land on.
 */
export const EXAMPLES_ROOT_ENV = 'CARTOGRAFO_EXAMPLES_ROOT';

/** One entry of `GET /examples`. */
interface Example {
  /** The graph document's `problem_class` — the identity of the lineage (D8). */
  class: string;
  /** The directory name under the examples root. */
  bundle: string;
  /** The `title` of the bundle's `demo/job.json`. */
  demo_title: string;
  /** Whether this project already has a base graph for the class. */
  registered: boolean;
}

/** A bundle that can be run, with everything already read off disk. */
interface ScannedExample {
  class: string;
  bundle: string;
  directory: string;
  document: unknown;
  demo: DemoJob;
  /**
   * `<bundle>/demo/repo`, when the bundle ships one (t409).
   *
   * `undefined` is the ordinary case and means exactly one thing: running this
   * example touches no directory anywhere. Every provisioning step below is
   * conditional on this field being set.
   */
  repoDir?: string;
}

/** The demo job a bundle ships, in the slice the run route uses. */
interface DemoJob {
  title: string;
  body?: unknown;
  entry_node_id?: unknown;
  fields?: unknown;
}

/** `{examples: […]}` and the two refusals every route of this file can give. */
const LIST_SCHEMA = {
  response: {
    200: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    404: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/**
 * Contract of `POST /examples/:class/run` in the public document.
 *
 * Five statuses, and only two of them are this route's own: `404` is the class
 * nobody ships (plus the unknown project every route answers), `422` is `POST
 * /v1/graphs`'s refusal passed through, `400` is a demo job whose body the event
 * contract refuses. `409` carries four different refusals under one code — the
 * registry's and `POST /v1/jobs`'s, plus `workspace_root_unset` and
 * `workspace_not_empty` (t409), which are about the disk and not the database.
 * The set of codes did not change when those two arrived, which is why this
 * schema did not either.
 */
const RUN_SCHEMA = {
  params: {
    type: 'object',
    properties: { class: { type: 'string' } },
    required: ['class'],
  },
  response: {
    201: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    404: ERROR_RESPONSE_SCHEMA,
    409: ERROR_RESPONSE_SCHEMA,
    422: ERROR_RESPONSE_SCHEMA,
  },
} as const;

interface ClassParam {
  Params: { class: string };
}

/**
 * The directory the routes scan, resolved on every request.
 *
 * Read at call time rather than captured at registration so a process can be
 * pointed somewhere else without being restarted — and so a test can exercise
 * both a fixture root and the repository's own.
 *
 * @param env Environment to read; the process's by default.
 * @returns An absolute path, which may well not exist.
 */
export function examplesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env[EXAMPLES_ROOT_ENV];
  if (declared !== undefined && declared.trim() !== '') return path.resolve(declared.trim());
  return path.resolve(process.cwd(), 'factory-graphs');
}

/** Parses a JSON file, or answers `undefined` — a bundle nobody can read is skipped. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Is there a directory at this path? A missing one is an answer, not a fault. */
function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Identity the provisioning commit carries, on its own command line.
 *
 * The same three `-c` pairs `cli/up.ts` passes, spelled out again here rather
 * than imported from it. The duplication is the point: what the two share is a
 * reason — a machine whose only stated prerequisites are Node and `git` has no
 * global `user.email`, and an operator with `commit.gpgsign=true` has nobody
 * standing by to type a passphrase — and not a value either side may change on
 * the other's behalf. `up`'s commit is empty and belongs to a directory it
 * provisions at startup; this one carries a fixture and is triggered by a click.
 */
const COMMIT_IDENTITY = Object.freeze([
  '-c',
  'user.name=cartografo',
  '-c',
  'user.email=cartografo@localhost',
  '-c',
  'commit.gpgsign=false',
]);

/** Message of the commit that puts the demo repository into the workspace. */
const DEMO_COMMIT_MESSAGE =
  'chore: the demo project of the example bundle, as the workspace found it';

/**
 * The branch the first commit lands on.
 *
 * Named rather than left to the operator's own `init.defaultBranch`, which is
 * `master` on plenty of machines: the class this exists for declares `main` in
 * the graph's own project block, and the runner's bench advancer defaults to the
 * same name. A workspace whose main line answers to a name nothing else uses is
 * a demo that stops at the first integration.
 *
 * Passed as configuration rather than as `--initial-branch` so that a `git` too
 * old to know either one degrades to its own default instead of failing the
 * whole run on an unrecognised flag.
 */
const DEMO_INITIAL_BRANCH = Object.freeze(['-c', 'init.defaultBranch=main']);

/** What {@link provisionDemoWorkspace} decided, and why when it refused. */
type Provisioning = { ok: true } | { ok: false; reason: 'not_empty' };

/** Runs one git command to completion, answering whether it succeeded. */
function git(cwd: string, args: readonly string[]): boolean {
  try {
    execFileSync('git', [...args], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Runs one git command and answers its stdout, or `undefined` when it failed. */
function gitOutput(cwd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', [...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
  } catch {
    return undefined;
  }
}

/**
 * Is this non-empty directory safe to overwrite?
 *
 * Exactly one state answers yes: the repository `ensureDefaultWorkspace` leaves
 * behind and nothing has touched since — its own `.git` (never a parent's,
 * which is why `.git` is looked for HERE and not asked of `git rev-parse`), one
 * commit on `HEAD`, that commit EMPTY, and a clean working tree. A repository
 * with a history, or with content, or with work in it, or a directory that is
 * not a repository at all, belongs to somebody, and this route is not the one to
 * decide what of it was disposable.
 *
 * The empty-tree condition is what makes the check honest about the workspace
 * this route provisioned ITSELF: over a path that did not exist yet the demo's
 * commit is the first one, so counting commits alone would call it pristine and
 * a second run would silently overwrite the first run's work. What
 * `ensureDefaultWorkspace` leaves is an empty commit, and it is empty on
 * purpose — it exists so `git worktree add` has something to branch from and for
 * nothing else.
 *
 * @param workspaceRoot Directory to judge.
 * @returns `true` only for the pristine provisioned workspace.
 */
function isPristineWorkspace(workspaceRoot: string): boolean {
  if (!isDirectory(path.join(workspaceRoot, '.git'))) return false;

  const commits = gitOutput(workspaceRoot, ['rev-list', '--count', 'HEAD']);
  if (commits?.trim() !== '1') return false;

  const tracked = gitOutput(workspaceRoot, ['ls-tree', '-r', '--name-only', 'HEAD']);
  if (tracked === undefined || tracked.trim() !== '') return false;

  const status = gitOutput(workspaceRoot, ['status', '--porcelain']);
  return status !== undefined && status.trim() === '';
}

/**
 * Puts a bundle's demo repository into the project's workspace, or refuses.
 *
 * Three shapes are provisioned, and they are the three that cannot cost anybody
 * anything: a path that does not exist, an empty directory, and the pristine
 * one-commit repository described above. The first two are `git init`ed here;
 * the third already is one, and re-initialising it would only risk renaming the
 * branch its commit is on.
 *
 * Everything else answers `not_empty` having read the directory and written
 * nothing — including a workspace a PREVIOUS run of this same demo filled, which
 * by then carries a second commit. That is deliberate and documented: the
 * alternative is a route that deletes files an operator put somewhere the demo
 * happened to be pointed at.
 *
 * @param workspaceRoot What the project's `workspace_root` setting says.
 * @param repoDir The bundle's `demo/repo`, copied whole.
 * @returns `{ok: true}` once the copy is committed; `{ok: false}` when nothing
 *   at all was done.
 */
function provisionDemoWorkspace(workspaceRoot: string, repoDir: string): Provisioning {
  const exists = existsSync(workspaceRoot);
  const empty = exists && isDirectory(workspaceRoot) && readdirSync(workspaceRoot).length === 0;

  if (!exists || empty) {
    mkdirSync(workspaceRoot, { recursive: true });
    if (!git(workspaceRoot, [...DEMO_INITIAL_BRANCH, 'init', '--quiet'])) {
      return { ok: false, reason: 'not_empty' };
    }
  } else if (!isPristineWorkspace(workspaceRoot)) {
    return { ok: false, reason: 'not_empty' };
  }

  cpSync(repoDir, workspaceRoot, { recursive: true });
  git(workspaceRoot, ['add', '-A']);
  git(workspaceRoot, [...COMMIT_IDENTITY, 'commit', '--quiet', '--message', DEMO_COMMIT_MESSAGE]);

  return { ok: true };
}

/**
 * Every bundle of the root that is ready to be demonstrated.
 *
 * The three things a bundle owes are a readable `graph.json`, a readable
 * `demo/job.json`, and a `problem_class` that can serve as an identity. A
 * `title` is the fourth and is demanded for the same reason: it is what the
 * card shows and what the job is named, and a demo with no title could be
 * listed but never run — which is a worse answer than not being listed.
 *
 * A root that does not exist answers an empty list, not an error: "there are no
 * examples here" is exactly what a control plane started outside a checkout has
 * to say.
 *
 * @param root Directory to scan.
 * @returns The bundles that can be run, sorted by directory name.
 */
function scanExamples(root: string): ScannedExample[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const found: ScannedExample[] = [];
  for (const bundle of entries.sort()) {
    const directory = path.join(root, bundle);

    const demo = readJson(path.join(directory, 'demo', 'job.json'));
    if (!isObject(demo) || typeof demo.title !== 'string' || demo.title.trim() === '') continue;

    const document = readJson(path.join(directory, 'graph.json'));
    if (!isObject(document)) continue;
    const className = document.problem_class;
    if (typeof className !== 'string' || className.trim() === '') continue;

    const repoDir = path.join(directory, 'demo', 'repo');
    found.push({
      class: className,
      bundle,
      directory,
      document,
      demo: demo as unknown as DemoJob,
      repoDir: isDirectory(repoDir) ? repoDir : undefined,
    });
  }

  return found;
}

/**
 * Offers every manifest of the bundle to the registry, in file-name order.
 *
 * The same order and the same gate as `cli/import.ts`, one HTTP hop shorter. A
 * `SkillRejected` is not caught here: it carries its own status, code and
 * problem list, and the route turns it into exactly the body `POST /v1/skills`
 * would have answered.
 *
 * A bundle with no `skills/` at all registers nothing and is not an error — the
 * graph's own gate is what decides whether that is survivable.
 *
 * @param db Open database.
 * @param directory Bundle directory.
 * @param projectId Partition the manifests land in.
 * @throws {SkillRejected} When the registry refuses one of them.
 */
function registerBundleSkills(db: Database, directory: string, projectId: number): void {
  const skillsDir = path.join(directory, 'skills');
  let files: string[];
  try {
    files = readdirSync(skillsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return;
  }

  for (const file of files) {
    registerSkill(db, readJson(path.join(skillsDir, file)), projectId);
  }
}

/**
 * Registers the examples routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerExamples(app: FastifyInstance, db: Database): void {
  app.get('/examples', { schema: LIST_SCHEMA }, async (request, reply) =>
    withValidation(reply, () => list(db, request, reply)),
  );

  app.post<ClassParam>('/examples/:class/run', { schema: RUN_SCHEMA }, async (request, reply) => {
    try {
      return await withValidation(reply, () => run(db, request, reply));
    } catch (error) {
      // Both of these are somebody else's refusal, re-answered verbatim: the
      // registry's `422`/`409` (D4's "one version never names two bodies") and
      // the `409` `POST /v1/jobs` gives for a version that is not `checked`
      // (t283). Neither is a verdict about THIS request's body, which is why
      // `withValidation` correctly re-throws them.
      if (error instanceof SkillRejected) {
        reply.code(error.status);
        return { error: error.code, details: error.problems } satisfies ErrorResponse;
      }
      if (error instanceof GraphVersionNotReadyError) {
        return refusal(reply, 409, error.code, error.message, {
          graph_version_id: error.graphVersionId,
          contracts: error.contracts,
        });
      }
      throw error;
    }
  });
}

/** `GET /examples` — what is on disk, and what this project already knows. */
function list(db: Database, request: FastifyRequest, reply: FastifyReply): unknown {
  const scope = requireProject(db, request, reply);
  if (scope.project === undefined) return scope.refusal;
  const project = scope.project;

  const examples: Example[] = scanExamples(examplesRoot()).map((example) => ({
    class: example.class,
    bundle: example.bundle,
    demo_title: example.demo.title,
    registered: getClassBase(db, example.class, project.id) !== undefined,
  }));

  return { examples };
}

/** `POST /examples/:class/run` — register if needed, then open the demo job. */
function run(db: Database, request: FastifyRequest<ClassParam>, reply: FastifyReply): unknown {
  const scope = requireProject(db, request, reply);
  if (scope.project === undefined) return scope.refusal;
  const project = scope.project;

  const className = request.params.class;
  const example = scanExamples(examplesRoot()).find((entry) => entry.class === className);
  if (example === undefined) {
    return refusal(
      reply,
      404,
      'unknown_example',
      `no bundle under the examples root registers the class "${className}"`,
      { class: className },
    );
  }

  // Whether THIS call registers is decided once, before anything is written:
  // it is what the answer publishes, and re-reading it afterwards would report
  // "already there" for the registration that had just happened.
  const registered = getClassBase(db, className, project.id) === undefined;

  // ...and the workspace is settled before the first WRITE, because it is the
  // one step that can refuse for a reason nothing in the database knows about
  // (t409). A run that registered the bundle and then discovered it had nowhere
  // to put the demo project would leave a class registered for a demo that
  // never ran. A bundle with no `demo/repo/` skips all of it, and never so much
  // as reads `workspace_root`.
  if (example.repoDir !== undefined) {
    const workspaceRoot = getSettings(db, project.id).workspace_root;
    if (workspaceRoot === undefined || workspaceRoot.trim() === '') {
      return refusal(
        reply,
        409,
        'workspace_root_unset',
        `the "${className}" demo runs against a checkout, and this project's workspace_root setting points nowhere; set it with PATCH /v1/settings`,
        { class: className, project_id: project.id },
      );
    }

    if (!provisionDemoWorkspace(workspaceRoot, example.repoDir).ok) {
      return refusal(
        reply,
        409,
        'workspace_not_empty',
        `the workspace at "${workspaceRoot}" already holds work, so the "${className}" demo project was not copied into it; empty it, or point workspace_root somewhere else, and run the example again`,
        { class: className, workspace_root: workspaceRoot },
      );
    }
  }

  if (registered) {
    registerBundleSkills(db, example.directory, project.id);

    const outcome = registerGraphDocument(db, example.document, project.id);
    switch (outcome.status) {
      case 'invalid_graph':
        reply.code(422);
        return {
          error: 'invalid_graph',
          valid: false,
          structure: outcome.structure,
          soundness: outcome.soundness,
        };
      case 'contracts_failed':
        reply.code(422);
        return {
          error: 'invalid_graph',
          valid: false,
          structure: outcome.structure,
          soundness: outcome.soundness,
          contracts: outcome.contracts,
        };
      case 'lineage_not_base':
        return refusal(
          reply,
          400,
          'lineage_not_base',
          'an example bundle registers only a base graph; a variant is born from POST /v1/graphs/:id/fork (D13)',
          { lineage_type: outcome.lineageType },
        );
      case 'class_already_registered':
        // Unreachable through the check above, and answered anyway: the two
        // reads are one transaction apart, and a refusal nobody wrote is how a
        // race becomes a 500.
        return refusal(
          reply,
          409,
          'class_already_registered',
          `class "${className}" already has a base graph; a new version over an existing lineage is the proposal flow`,
          { class: className, project_id: project.id },
        );
      default:
        break;
    }
  }

  // Read back rather than taken off the outcome, because the two paths meet
  // here: the class was either just registered or was already there, and both
  // answer the same question — which version does a job of this class run
  // against right now.
  const base = getClassBase(db, className, project.id);
  const executionId = nextExecutionId(db, project.id);

  const job = createJob(db, {
    title: example.demo.title,
    body: example.demo.body,
    entry_node_id: example.demo.entry_node_id,
    fields: example.demo.fields,
    execution_id: executionId,
    graph_version_id: base?.current_version_id,
    project_id: project.id,
  });

  reply.code(201);
  return { job, execution_id: executionId, registered };
}
