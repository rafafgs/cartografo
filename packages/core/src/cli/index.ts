/**
 * Router of the `cartografo` command (t108, FR1/FR7).
 *
 * The command was born doing one thing only — starting the control plane — and
 * still needs no subcommand to do it. That is not backward-compatibility out of
 * politeness: `npx cartografo` is the project's front door, and
 * time-to-first-graph is a quality non-negotiable
 * (`notes/2026-08-14-extension-and-quality.md`). A mandatory subcommand would add
 * a word to the most travelled path of the product for nobody's benefit.
 *
 * Since t405 that front door brings up three processes rather than one — the
 * control plane, the screen and a local runner — and `cli/up.ts` is what
 * decides all of it. Two consequences reach this file: the leading argument of
 * an implicit `up` may now be one of that subcommand's own `--no-*` flags
 * rather than a subcommand name, and a `UsageError` can come out of `up` like
 * it comes out of any other subcommand.
 *
 * Every other subcommand — `import`, `export`, `status` and the three steps of
 * the D4 skill-import gate — is a pure HTTP client of the public API: they open
 * no database, do not import `src/db/**` and have no privilege whatsoever over
 * the screen or the runner (D1, D11). What they know about the control plane
 * fits in `cli/url.ts`. The one thing this router takes from `src/db/` is the
 * `LockHeldError` TYPE, to recognize it and print its line (t209, FR4): no
 * handle, no query, nothing opened — the only file that talks to the driver is
 * still `db/connection.ts`.
 *
 * One single exit-code convention:
 *
 * - `0` — the command did what it promised;
 * - `1` — the command ran and the result was negative (server down, graph
 *   refused, unknown class);
 * - `2` — the command line is wrong (nonexistent subcommand, missing argument).
 *   It is the same `2` that `scripts/validar-bundle-fabrica.mjs` uses for
 *   incorrect usage.
 */

import { LockHeldError } from '../db/lock.ts';
import { DEFAULT_PORT } from '../index.ts';
import { runExport } from './export.ts';
import { historyScope, runExportHistory } from './export-history.ts';
import { runGraph } from './graph.ts';
import { runImport } from './import.ts';
import { runInterview } from './interview.ts';
import {
  runAnswer,
  runBlock,
  runCreateJob,
  runExampleRun,
  runExamples,
  runRunners,
  runRunnersRecheck,
  runSettingsGet,
  runSettingsSet,
  runUnblock,
} from './ops.ts';
import {
  runExecution,
  runExecutions,
  runInputRequests,
  runJob,
  runJobs,
  runSessions,
  runTranscript,
} from './reads.ts';
import { runProposals } from './proposals.ts';
import { runProposeSkill, runRegisterSkill, runScanSkill } from './skill-import.ts';
import { runStatus } from './status.ts';
import { parseUpFlags, runUp } from './up.ts';
import { runWatch, validateWatchFlags } from './watch.ts';
import { isObject } from '../util/is-object.ts';
import {
  DEFAULT_PROJECT_ID,
  DeniedError,
  ENV_TOKEN,
  ENV_URL,
  NetworkError,
  UsageError,
  deniedMessage,
  requestJson,
  resolveBaseUrl,
  resolveToken,
  serverDownMessage,
  useToken,
} from './url.ts';

/** Usage text. The same in `--help` (stdout) and on a wrong subcommand (stderr). */
export const USAGE = `usage: cartografo [subcommand] [options]

subcommands:
  up                     brings the whole product up: the control plane
                         (database, migrations and HTTP), the screen and one
                         local runner, and opens the browser on the screen. It
                         is the default — \`cartografo\` with no argument does
                         this, and the three \`--no-*\` options below belong to
                         it whether the word is typed or not.
  import <path>          registers a graph as a new base lineage. <path> is a
                         graph file or a bundle directory (with graph.json and,
                         optionally, skills/ to check).
  export <class>         writes the current version of the class to a file, in
                         the same format import accepts back.
  export-history         writes a job's or a round's whole history to a file, as
                         JSON Lines: a header with the map version, then every
                         event in id order. Export only — there is no import
                         back.
  status                 reports the server, the registered classes and the projects.

  reads, with board parity (D26) — each has a --json form:

  jobs                   lists jobs, the same set GET /v1/jobs returns.
                         --state filters client-side on the six words RF-30
                         defines (awaiting_you, blocked_unasked, running,
                         unowned, completed, queued); --execution narrows to
                         one round.
  job <id>               one job's timeline in three buckets — the queue, an
                         agent working, a human being asked — with its
                         artifacts and sessions. The same content as the
                         screen's job page, minus the board's map position.
  executions             the rounds: jobs, blocked jobs and pending questions
                         per round.
  execution <id>         one round's jobs, sessions and pending questions.
                         Never 404s — an execution is not an entity.
  sessions               lists sessions; --job and --execution filter to one
                         job or one round.
  transcript <session-id>
                         a session's decoded transcript, its own failed line
                         (a non-zero exit code) marked with ">>> ". --tail N
                         shows only the last N lines.
  input-requests         the escalation inbox; --status defaults to pending.
  watch                  tails the event stream, reconnecting forever past the
                         first connection; --job/--execution filter client-side
                         (the route has neither parameter); --since/--from-start
                         pick where it starts; --until-done exits 0 the moment
                         the named job or round finishes.
  examples               the bundles this control plane can demonstrate, and
                         whether this project has already registered each one.
  runners                the fleet and whether each one is ready to pick work
                         up — the check page's own decision logic, in text.

  the writes, closing the gap D26 leaves open (t544):

  answer <request-id> (<text> | --file <path>)
                         answers a pending escalation; the control plane
                         unblocks the job in the same transaction.
  block <job-id>         raises a job's blocked flag; --reason is required.
  unblock <job-id>       lowers a job's blocked flag; --note is optional.
  job create --graph <graph-version-id> --input <file>
                         opens a job on a specific graph version, from a JSON
                         file of the job's fields.
  example run <class>    registers the bundle if this project has never seen
                         the class, then opens its demo job.
  runners recheck <runner-id>
                         asks one runner to report about its own machine again.
  settings [get]         reads this project's recorded defaults.
  settings set <key> <value>
                         writes one setting; the key is checked locally before
                         any request goes out.

  interview              draws a map by conversation, in the terminal (D26): asks
                         for a title and a description, then every question as
                         it arrives — a number or text for a decision, one
                         prompt per field for a form, Enter for the default —
                         printing the map as it grows. Once it is finished,
                         \`register\` it, \`export <dir>\` it, or press Enter to
                         leave it as a draft.
                           interview [--resume <id>] [--answers <file>] [--by <name>]

  proposals <verb>       decides and reads proposals (D26): the CLI's own
                         version of the inbox page, on par with the screen.
                           proposals list [--status <status>] [--json]
                           proposals show <id> [--json]
                           proposals approve <id> [--by <name>] [--json]
                           proposals apply <id> [--by <name>] [--json]
                           proposals reject <id> --reason <text> [--by <name>] [--json]
                           proposals revert <id> --reason <text> [--by <name>] [--json]
                         list groups into PENDING/HISTORY unless --status is
                         given; show prints the semantic diff; approve/apply
                         take no --reason; reject/revert require one, checked
                         before any request is sent. --by defaults to the OS
                         user (env USER/USERNAME as a fallback).

  graph <verb>           edits a graph as a file and pushes the edit through
                         the proposal door (D26): export, edit, propose.
                           graph propose <file> [--graph <id>] [--by <name>]
                                 [--evidence <text>] [--dry-run | --no-apply] [--json]
                           graph versions <id> [--json]
                           graph show <id> [--version <version-id>] [--json]
                         propose diffs the file against the lineage's current
                         version, then creates, approves and applies the
                         proposal as --by. --graph defaults to the file's
                         problem_class, which is right only for a base
                         lineage: for a variant, pass --graph <variant-id>.
                         A node's id (paired by position in the nodes array —
                         add nodes at the end, remove them from the end) and
                         its engine are frozen and refused locally; a
                         node_type change becomes a remove plus an add.
                         --dry-run prints the operations and runs the
                         soundness gate locally, sending nothing; --no-apply
                         leaves the proposal pending. versions lists the
                         whole chain oldest first; show prints the current
                         version, or --version, refused if it belongs to
                         another lineage.

  the D4 skill-import gate, in three steps:

  scan-skill <path>      derives a draft manifest from the SKILL.md of an
                         already-cloned local checkout. Guesses nothing: what
                         only a human can write comes out as a placeholder.
  propose-skill <file>   opens the human approval for a completed manifest and
                         blocks a job on it. Never auto-approvable.
  register-skill         sends what the human approved to the registry, which
                         verifies it again before anything is stored.

options:
  --no-browser           (up) do not open the browser
  --no-runner            (up) do not start a local runner
  --no-screen            (up) do not start the screen
  --url <url>            control plane to query (env ${ENV_URL};
                         default http://127.0.0.1:${DEFAULT_PORT})
  --token <token>        credential of the control plane (env ${ENV_TOKEN});
                         it is printed when the control plane first starts
  --out <path>           (export) output file; default ./<class>.graph.json
                         (export-history) output file; default
                         ./job-<id>.history.jsonl or ./execution-<id>.history.jsonl
                         (scan-skill) draft file; default ./<id>.manifest.json
  --repo <repo>          (scan-skill) source repository, for origin.repo
  --ref <ref>            (scan-skill) commit or tag — never a branch (D4)
  --role work|gate       (scan-skill) role of the skill; always explicit
  --by <name>            (scan-skill) who is importing, for origin.imported_by
                         (answer, block, unblock) who is doing it, for the
                         recorded actor; default the OS user, else "operator"
                         (proposals approve/apply/reject/revert, graph propose)
                         who decides; default the OS user
                         (interview) who answers; default the OS user
  --resume <id>          (interview) picks an interview up again where the
                         control plane says it stands
  --answers <file>       (interview) reads every line from this file instead
                         of the terminal; running out of lines before the
                         interview finishes exits 1
  --reason <text>        (proposals reject, proposals revert) mandatory;
                         checked before any request is sent
                         (block) why the job stops here; required
  --evidence <text>      (graph propose) the proposal's evidence note; default
                         "manual edit via cartografo graph propose"
  --dry-run              (graph propose) print the operations and run the
                         soundness gate locally; send nothing
  --no-apply             (graph propose) create the proposal and leave it
                         pending; not combinable with --dry-run
  --version <id>         (graph show) a version of the lineage other than the
                         current one
  --job <id>             (register-skill) job the approval was opened on
                         (export-history) job whose history to export
                         (sessions) filter to one job's sessions
                         (watch) filter client-side to one job; combines with
                         --execution (ANDed); with --until-done, exactly one
                         of --job/--execution is required
  --execution <id>       (export-history) round whose history to export; exactly
                         one of --job/--execution
                         (jobs, sessions) filter to one round
                         (watch) filter client-side to one round; see --job
                         (job create) the round the job lands in
  --since <event-id>     (watch) resume from this event id (exclusive);
                         mutually exclusive with --from-start
  --from-start           (watch) start from the whole log (event id 0) instead
                         of from now; mutually exclusive with --since
  --until-done           (watch) exit 0 the moment the named job or round
                         finishes; needs exactly one of --job/--execution
  --state <state>        (jobs) filter to one of the six job states:
                         awaiting_you, blocked_unasked, running, unowned,
                         completed, queued
  --status <status>      (input-requests) filter by status; default pending
                         (proposals list) filter by status; default groups
                         into PENDING/HISTORY instead
  --tail <n>             (transcript) show only the last N lines, counting
                         back from the session's own last non-blank line
  --note <text>          (unblock) why the job can move again; optional
  --file <path>          (answer) reads the answer text from this file
                         instead of a positional argument
  --graph <id>           (job create) the graph version id the job travels;
                         required
                         (graph propose) lineage to propose against; default
                         the file's problem_class (base lineages only)
  --input <file>         (job create) a JSON file with the job's fields
                         (title, entry_node_id and, optionally, body, fields,
                         acceptance_criteria, tier); required
  --project <id|name>    project to work in (import, export, export-history,
                         status, jobs, job, executions, execution, sessions,
                         transcript, input-requests, watch, proposals,
                         examples, runners, job create, example run, settings,
                         interview, graph);
                         default 1. Accepted but inert on answer/block/unblock/
                         runners recheck, none of whose routes are
                         project-scoped. A name is resolved against
                         GET /v1/projects
  --json                 (status, jobs, job, executions, execution, sessions,
                         transcript, input-requests, watch, proposals, examples,
                         runners, answer, block, unblock, job create, example
                         run, runners recheck, settings, graph) prints
                         machine-readable JSON instead of the human table/card
                         (watch: JSON Lines, one whole envelope per line)
  -h, --help             this text

Startup configuration: CARTOGRAFO_DB_PATH, CARTOGRAFO_PORT, CARTOGRAFO_HOST,
CARTOGRAFO_SCREEN_PORT.`;

/** Subcommands that talk to the control plane over HTTP; `up` is the other one. */
const API_SUBCOMMANDS = [
  'import',
  'export',
  'export-history',
  'status',
  'jobs',
  'job',
  'executions',
  'execution',
  'sessions',
  'transcript',
  'input-requests',
  'watch',
  'examples',
  'runners',
  'answer',
  'block',
  'unblock',
  'example',
  'settings',
  'interview',
  'proposals',
  'graph',
  'scan-skill',
  'propose-skill',
  'register-skill',
];

/** What is left of the command line after taking one option out. */
interface Extraction {
  value?: string;
  rest: string[];
}

/**
 * Takes an option with a value (`--name value` or `--name=value`) out of the list.
 *
 * @param args Arguments of the subcommand.
 * @param name Long name of the option, with the two dashes.
 * @returns The value, when present, and the list without it.
 */
function extractValue(args: string[], name: string): Extraction {
  const rest: string[] = [];
  let value: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === name) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${name} needs a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      value = current.slice(name.length + 1);
      if (value === '') throw new UsageError(`${name} needs a value`);
      continue;
    }
    rest.push(current);
  }

  return { value, rest };
}

/** Takes a boolean flag out of the list. */
function extractFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((argument) => argument !== name);
  return { present: rest.length !== args.length, rest };
}

/** Reads a command-line value as an integer, or refuses the command line. */
function parseIntegerOption(raw: string, label: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value)) {
    throw new UsageError(`${label} has to be an integer (got: "${raw}")`);
  }
  return value;
}

/** Same, but refuses anything that is not strictly positive (`--tail`). */
function parsePositiveIntegerOption(raw: string, label: string): number {
  const value = parseIntegerOption(raw, label);
  if (value <= 0) throw new UsageError(`${label} has to be a positive integer (got: "${raw}")`);
  return value;
}

/** Same, but refuses a negative value (`--since`, an event id). */
function parseNonNegativeIntegerOption(raw: string, label: string): number {
  const value = parseIntegerOption(raw, label);
  if (value < 0) throw new UsageError(`${label} has to be a non-negative integer (got: "${raw}")`);
  return value;
}

/**
 * The one shape a wrong command line has, wherever it was read.
 *
 * `up` reads its own flags and every other subcommand reads its own options, so
 * a `UsageError` reaches this router from two different places; what a person
 * sees has to be the same line either way.
 *
 * @param error What the parsing threw.
 * @returns The exit code of a wrong command line.
 */
function wrongCommandLine(error: UsageError): number {
  process.stderr.write(`cartografo: ${error.message}\n`);
  process.stderr.write('cartografo: run `cartografo --help` for usage\n');
  return 2;
}

/** Refuses what is left on the command line instead of ignoring it silently. */
function requireNothingElse(left: string[], positionalCount: number, subcommand: string): void {
  const extras = left.slice(positionalCount);
  if (extras.length > 0) {
    throw new UsageError(`${subcommand} does not understand: ${extras.map((extra) => `"${extra}"`).join(', ')}`);
  }
}

/**
 * Starts the whole product, preserving the failure message the startup had.
 *
 * @param args Command line of `up` — the part after the subcommand, or all of
 *   it when the subcommand was left implicit.
 * @returns Exit code; it only returns once the command has been asked to stop.
 * @throws {UsageError} On a command line `up` cannot read — thrown BEFORE the
 *   try below, deliberately: that catch turns everything it sees into a `1`,
 *   and a wrong command line is a `2` in this CLI whatever the subcommand.
 */
async function startControlPlane(args: string[]): Promise<number> {
  const flags = parseUpFlags(args);

  try {
    await runUp(flags);
    return 0;
  } catch (error) {
    // A held lock is not a defect: it is the answer to "is one already
    // running?", and the answer fits in the line the error carries — the pid to
    // look for and the file it holds (t209, FR4). Dumping a stack on top of it
    // would only bury the two things the operator needs to read.
    if (error instanceof LockHeldError) {
      console.error(error.message);
      return 1;
    }
    console.error('cartografo: startup failed');
    console.error(error);
    return 1;
  }
}

/**
 * Routes one of the subcommands that talk to the API.
 *
 * @param subcommand Any of `API_SUBCOMMANDS`.
 * @param args Arguments after the subcommand.
 * @param env Environment the default URL comes from.
 * @returns Process exit code.
 */
async function runApiClient(
  subcommand: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const fromUrl = extractValue(args, '--url');
  const fromToken = extractValue(fromUrl.rest, '--token');
  const fromProject = extractValue(fromToken.rest, '--project');
  const url = resolveBaseUrl(fromUrl.value, env);
  const token = resolveToken(fromToken.value, env);

  // One place, before any subcommand runs: from here on every request this
  // process makes carries the credential (t124, FR6). `watch` also takes it
  // directly (below): it makes its own raw `fetch` calls for the stream
  // itself, which `requestJson`'s module-level credential does not reach.
  useToken(token);

  if (subcommand === 'import') {
    requireNothingElse(fromProject.rest, 1, 'import');
    const inputPath = fromProject.rest[0];
    if (inputPath === undefined) {
      throw new UsageError('import needs a path: a graph file or a bundle directory');
    }
    return await runImport({
      path: inputPath,
      url,
      projectId: await resolveProjectId(fromProject.value, url),
    });
  }

  if (subcommand === 'export') {
    const fromOutput = extractValue(fromProject.rest, '--out');
    requireNothingElse(fromOutput.rest, 1, 'export');
    const className = fromOutput.rest[0];
    if (className === undefined) throw new UsageError('export needs the graph class');
    return await runExport({
      className,
      url,
      output: fromOutput.value,
      projectId: await resolveProjectId(fromProject.value, url),
    });
  }

  if (subcommand === 'export-history') {
    const fromJob = extractValue(fromProject.rest, '--job');
    const fromExecution = extractValue(fromJob.rest, '--execution');
    const fromOutput = extractValue(fromExecution.rest, '--out');
    requireNothingElse(fromOutput.rest, 0, 'export-history');

    // Read once here and once inside the subcommand, on purpose: the scope is
    // refused BEFORE `--project` is resolved, and resolving a project name is
    // itself a request (t372, FR1). The subcommand still owns its own contract,
    // and the function is pure, so the second reading costs nothing.
    historyScope({ job: fromJob.value, execution: fromExecution.value });

    return await runExportHistory({
      job: fromJob.value,
      execution: fromExecution.value,
      url,
      output: fromOutput.value,
      projectId: await resolveProjectId(fromProject.value, url),
    });
  }

  if (subcommand === 'scan-skill') {
    const fromRepo = extractValue(fromProject.rest, '--repo');
    const fromRef = extractValue(fromRepo.rest, '--ref');
    const fromRole = extractValue(fromRef.rest, '--role');
    const fromBy = extractValue(fromRole.rest, '--by');
    const fromOutput = extractValue(fromBy.rest, '--out');
    requireNothingElse(fromOutput.rest, 1, 'scan-skill');

    const source = fromOutput.rest[0];
    if (source === undefined) throw new UsageError('scan-skill needs the path of a SKILL.md');

    // None of the four has a default, and none gets one: each is either a field
    // of `origin` — the provenance D4 makes mandatory — or the `role` the same
    // decision refuses to have inferred. A default here would be the tool
    // deciding something the gate exists to make a person decide.
    const mandatory = (name: string, value?: string): string => {
      if (value === undefined) throw new UsageError(`scan-skill needs ${name}`);
      return value;
    };

    return await runScanSkill({
      source,
      repo: mandatory('--repo', fromRepo.value),
      ref: mandatory('--ref', fromRef.value),
      role: mandatory('--role', fromRole.value),
      by: mandatory('--by', fromBy.value),
      url,
      output: fromOutput.value,
    });
  }

  if (subcommand === 'propose-skill') {
    requireNothingElse(fromProject.rest, 1, 'propose-skill');
    const manifestPath = fromProject.rest[0];
    if (manifestPath === undefined) {
      throw new UsageError('propose-skill needs the path of a completed manifest file');
    }
    return await runProposeSkill({ path: manifestPath, url });
  }

  if (subcommand === 'register-skill') {
    const fromJob = extractValue(fromProject.rest, '--job');
    requireNothingElse(fromJob.rest, 0, 'register-skill');
    if (fromJob.value === undefined) throw new UsageError('register-skill needs --job');
    const jobId = Number(fromJob.value);
    if (!Number.isInteger(jobId)) {
      throw new UsageError(`--job has to be an integer (got: "${fromJob.value}")`);
    }
    return await runRegisterSkill({ jobId, url });
  }

  if (subcommand === 'proposals') {
    // The verb and everything past it are `cli/proposals.ts`'s own to parse
    // (FR1); this router only extracts the two things every other subcommand
    // already extracts before it gets a say — the address and the project.
    const verb = fromProject.rest[0];
    return await runProposals(verb, fromProject.rest.slice(1), {
      url,
      projectId: await resolveProjectId(fromProject.value, url),
    });
  }

  if (subcommand === 'graph') {
    // Same hand-off as `proposals`: the verb and everything past it are
    // `cli/graph.ts`'s own to parse (t545, FR1).
    const verb = fromProject.rest[0];
    return await runGraph(verb, fromProject.rest.slice(1), {
      url,
      projectId: await resolveProjectId(fromProject.value, url),
    });
  }

  if (subcommand === 'interview') {
    const fromResume = extractValue(fromProject.rest, '--resume');
    const fromAnswers = extractValue(fromResume.rest, '--answers');
    const fromBy = extractValue(fromAnswers.rest, '--by');
    requireNothingElse(fromBy.rest, 0, 'interview');

    // Checked before `--project` is resolved, like `watch`'s flags: a wrong
    // command line costs the server nothing.
    const resumeId =
      fromResume.value === undefined ? undefined : parseIntegerOption(fromResume.value, 'interview --resume');

    return await runInterview({
      url,
      token,
      projectId: await resolveProjectId(fromProject.value, url),
      resumeId,
      answersPath: fromAnswers.value,
      by: fromBy.value,
    });
  }

  if (subcommand === 'jobs') {
    const fromState = extractValue(fromProject.rest, '--state');
    const fromExecution = extractValue(fromState.rest, '--execution');
    const fromJson = extractFlag(fromExecution.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'jobs');

    return await runJobs({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      state: fromState.value,
      executionId:
        fromExecution.value === undefined
          ? undefined
          : parseIntegerOption(fromExecution.value, 'jobs --execution'),
      json: fromJson.present,
    });
  }

  if (subcommand === 'job' && fromProject.rest[0] === 'create') {
    const afterCreate = fromProject.rest.slice(1);
    const fromGraph = extractValue(afterCreate, '--graph');
    const fromInput = extractValue(fromGraph.rest, '--input');
    const fromExecution = extractValue(fromInput.rest, '--execution');
    const fromJson = extractFlag(fromExecution.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'job create');

    if (fromGraph.value === undefined) throw new UsageError('job create needs --graph');
    if (fromInput.value === undefined) throw new UsageError('job create needs --input');

    return await runCreateJob({
      url,
      graphVersionId: fromGraph.value,
      inputPath: fromInput.value,
      executionId:
        fromExecution.value === undefined ? undefined : parseIntegerOption(fromExecution.value, 'job create --execution'),
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  if (subcommand === 'job') {
    const fromJson = extractFlag(fromProject.rest, '--json');
    requireNothingElse(fromJson.rest, 1, 'job');
    const rawId = fromJson.rest[0];
    if (rawId === undefined) throw new UsageError('job needs an id');

    return await runJob({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      id: parseIntegerOption(rawId, 'job <id>'),
      json: fromJson.present,
    });
  }

  if (subcommand === 'executions') {
    const fromJson = extractFlag(fromProject.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'executions');

    return await runExecutions({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  if (subcommand === 'execution') {
    const fromJson = extractFlag(fromProject.rest, '--json');
    requireNothingElse(fromJson.rest, 1, 'execution');
    const rawId = fromJson.rest[0];
    if (rawId === undefined) throw new UsageError('execution needs an id');

    return await runExecution({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      id: parseIntegerOption(rawId, 'execution <id>'),
      json: fromJson.present,
    });
  }

  if (subcommand === 'sessions') {
    const fromJob = extractValue(fromProject.rest, '--job');
    const fromExecution = extractValue(fromJob.rest, '--execution');
    const fromJson = extractFlag(fromExecution.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'sessions');

    return await runSessions({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      jobId: fromJob.value === undefined ? undefined : parseIntegerOption(fromJob.value, 'sessions --job'),
      executionId:
        fromExecution.value === undefined
          ? undefined
          : parseIntegerOption(fromExecution.value, 'sessions --execution'),
      json: fromJson.present,
    });
  }

  if (subcommand === 'transcript') {
    const fromTail = extractValue(fromProject.rest, '--tail');
    const fromJson = extractFlag(fromTail.rest, '--json');
    requireNothingElse(fromJson.rest, 1, 'transcript');
    const rawId = fromJson.rest[0];
    if (rawId === undefined) throw new UsageError('transcript needs a session id');

    return await runTranscript({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      id: parseIntegerOption(rawId, 'transcript <session-id>'),
      tail: fromTail.value === undefined ? undefined : parsePositiveIntegerOption(fromTail.value, '--tail'),
      json: fromJson.present,
    });
  }

  if (subcommand === 'input-requests') {
    const fromStatus = extractValue(fromProject.rest, '--status');
    const fromJson = extractFlag(fromStatus.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'input-requests');

    return await runInputRequests({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      status: fromStatus.value ?? 'pending',
      json: fromJson.present,
    });
  }

  if (subcommand === 'watch') {
    const fromJob = extractValue(fromProject.rest, '--job');
    const fromExecution = extractValue(fromJob.rest, '--execution');
    const fromSince = extractValue(fromExecution.rest, '--since');
    const fromFromStart = extractFlag(fromSince.rest, '--from-start');
    const fromJson = extractFlag(fromFromStart.rest, '--json');
    const fromUntilDone = extractFlag(fromJson.rest, '--until-done');
    requireNothingElse(fromUntilDone.rest, 0, 'watch');

    const jobId = fromJob.value === undefined ? undefined : parseIntegerOption(fromJob.value, 'watch --job');
    const executionId =
      fromExecution.value === undefined ? undefined : parseIntegerOption(fromExecution.value, 'watch --execution');
    const since = fromSince.value === undefined ? undefined : parseNonNegativeIntegerOption(fromSince.value, 'watch --since');
    const fromStart = fromFromStart.present;
    const untilDone = fromUntilDone.present;

    // Pure and synchronous, before `--project` is resolved (a name is a
    // request of its own): a wrong command line costs the server nothing
    // (AT6), the same posture `export-history`'s `historyScope` keeps.
    validateWatchFlags({ job: jobId, execution: executionId, since, fromStart, untilDone });

    return await runWatch({
      url,
      token,
      projectId: await resolveProjectId(fromProject.value, url),
      jobId,
      executionId,
      since,
      fromStart,
      json: fromJson.present,
      untilDone,
    });
  }

  if (subcommand === 'examples') {
    const fromJson = extractFlag(fromProject.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'examples');

    return await runExamples({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  if (subcommand === 'example') {
    if (fromProject.rest[0] !== 'run') throw new UsageError('example needs a subcommand: run <class>');
    const afterRun = fromProject.rest.slice(1);
    const fromJson = extractFlag(afterRun, '--json');
    requireNothingElse(fromJson.rest, 1, 'example run');
    const className = fromJson.rest[0];
    if (className === undefined) throw new UsageError('example run needs a class');

    return await runExampleRun({
      url,
      className,
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  if (subcommand === 'runners' && fromProject.rest[0] === 'recheck') {
    const afterRecheck = fromProject.rest.slice(1);
    const fromJson = extractFlag(afterRecheck, '--json');
    requireNothingElse(fromJson.rest, 1, 'runners recheck');
    const runnerId = fromJson.rest[0];
    if (runnerId === undefined) throw new UsageError('runners recheck needs a runner id');

    return await runRunnersRecheck({ url, runnerId, json: fromJson.present });
  }

  if (subcommand === 'runners') {
    const fromJson = extractFlag(fromProject.rest, '--json');
    requireNothingElse(fromJson.rest, 0, 'runners');

    return await runRunners({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  if (subcommand === 'answer') {
    const fromFile = extractValue(fromProject.rest, '--file');
    const fromBy = extractValue(fromFile.rest, '--by');
    const fromJson = extractFlag(fromBy.rest, '--json');
    requireNothingElse(fromJson.rest, 2, 'answer');

    const rawId = fromJson.rest[0];
    if (rawId === undefined) throw new UsageError('answer needs a request id');

    return await runAnswer({
      url,
      id: parseIntegerOption(rawId, 'answer <request-id>'),
      text: fromJson.rest[1],
      file: fromFile.value,
      by: fromBy.value,
      json: fromJson.present,
    });
  }

  if (subcommand === 'block') {
    const fromReason = extractValue(fromProject.rest, '--reason');
    const fromBy = extractValue(fromReason.rest, '--by');
    const fromJson = extractFlag(fromBy.rest, '--json');
    requireNothingElse(fromJson.rest, 1, 'block');

    const rawId = fromJson.rest[0];
    if (rawId === undefined) throw new UsageError('block needs a job id');

    return await runBlock({
      url,
      id: parseIntegerOption(rawId, 'block <job-id>'),
      reason: fromReason.value,
      by: fromBy.value,
      json: fromJson.present,
    });
  }

  if (subcommand === 'unblock') {
    const fromNote = extractValue(fromProject.rest, '--note');
    const fromBy = extractValue(fromNote.rest, '--by');
    const fromJson = extractFlag(fromBy.rest, '--json');
    requireNothingElse(fromJson.rest, 1, 'unblock');

    const rawId = fromJson.rest[0];
    if (rawId === undefined) throw new UsageError('unblock needs a job id');

    return await runUnblock({
      url,
      id: parseIntegerOption(rawId, 'unblock <job-id>'),
      note: fromNote.value,
      by: fromBy.value,
      json: fromJson.present,
    });
  }

  if (subcommand === 'settings' && fromProject.rest[0] === 'set') {
    const afterSet = fromProject.rest.slice(1);
    const fromJson = extractFlag(afterSet, '--json');
    requireNothingElse(fromJson.rest, 2, 'settings set');

    const key = fromJson.rest[0];
    const value = fromJson.rest[1];
    if (key === undefined || value === undefined) {
      throw new UsageError('settings set needs a key and a value');
    }

    return await runSettingsSet({
      url,
      key,
      value,
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  if (subcommand === 'settings') {
    const positional = fromProject.rest[0] === 'get' ? fromProject.rest.slice(1) : fromProject.rest;
    const fromJson = extractFlag(positional, '--json');
    requireNothingElse(fromJson.rest, 0, 'settings');

    return await runSettingsGet({
      url,
      projectId: await resolveProjectId(fromProject.value, url),
      json: fromJson.present,
    });
  }

  const fromFlag = extractFlag(fromProject.rest, '--json');
  requireNothingElse(fromFlag.rest, 0, 'status');
  return await runStatus({
    url,
    json: fromFlag.present,
    projectId: await resolveProjectId(fromProject.value, url),
  });
}

/**
 * Turns `--project <id|name>` into the id every request carries (t354, FR6).
 *
 * Resolved ONCE, here, and then threaded into the subcommand: the wire only
 * speaks ids (`routes/common.ts` says why), so a name has to become one before
 * any other call goes out, and doing it per call would mean asking the control
 * plane the same question three times in one command.
 *
 * A run of digits is an id and anything else is a name — told apart by shape,
 * never by trying one and falling back to the other, or a project somebody
 * named `2` would be reachable by accident from a caller that meant the id.
 *
 * @param declared What `--project` said, if it was given.
 * @param url Base URL of the control plane.
 * @returns The numeric id; `DEFAULT_PROJECT_ID` when the flag was absent.
 * @throws {UsageError} When a name answers to no project — a scope nobody
 *   declared is a wrong command line, not a server that said no.
 */
async function resolveProjectId(declared: string | undefined, url: string): Promise<number> {
  if (declared === undefined) return DEFAULT_PROJECT_ID;
  if (/^[0-9]+$/.test(declared)) return Number(declared);

  const response = await requestJson(`${url}/v1/projects`);
  const body = isObject(response.body) ? response.body : {};
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const match = projects
    .filter(isObject)
    .find((project) => project.name === declared);

  if (match === undefined || typeof match.id !== 'number') {
    throw new UsageError(`--project: no project named "${declared}" at ${url}`);
  }
  return match.id;
}

/**
 * Entry point of the command: decides the subcommand and returns the exit code.
 *
 * It does not call `process.exit`: the `bin` decides that, and `up` needs the
 * process to stay alive serving HTTP after this function returns.
 *
 * @param args `process.argv.slice(2)`.
 * @param env Process environment.
 * @returns Exit code.
 */
export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (args.some((argument) => argument === '--help' || argument === '-h' || argument === 'help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  // A leading `--…` belongs to the implicit `up`, and is not a subcommand
  // nobody declared (t405, FR2). Without this line `npx cartografo
  // --no-browser` dies with `unknown subcommand: "--no-browser"`, which would
  // make the three flags of the product's own front door reachable only by
  // typing the word the front door exists not to require. It is backwards
  // compatible by construction: no subcommand of this command starts with a
  // dash, so nothing that used to route somewhere still does.
  const leading = args[0];
  const implicitUp = leading === undefined || leading.startsWith('--');
  const subcommand = implicitUp ? 'up' : leading;
  const rest = implicitUp ? args : args.slice(1);

  if (subcommand === 'up') {
    try {
      return await startControlPlane(rest);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      return wrongCommandLine(error);
    }
  }

  if (!API_SUBCOMMANDS.includes(subcommand)) {
    process.stderr.write(`cartografo: unknown subcommand: "${subcommand}"\n${USAGE}\n`);
    return 2;
  }

  try {
    return await runApiClient(subcommand, rest, env);
  } catch (error) {
    if (error instanceof NetworkError) {
      process.stderr.write(`${serverDownMessage(error.url)}\n`);
      return 1;
    }
    if (error instanceof DeniedError) {
      // A negative result, not a wrong command line: the command was right and
      // the server said no. Same exit code as a server that is down.
      process.stderr.write(`${deniedMessage(error.url)}\n`);
      return 1;
    }
    if (error instanceof UsageError) return wrongCommandLine(error);
    throw error;
  }
}
