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
import { runImport } from './import.ts';
import { runProposeSkill, runRegisterSkill, runScanSkill } from './skill-import.ts';
import { runStatus } from './status.ts';
import { parseUpFlags, runUp } from './up.ts';
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
  status                 reports the server, the registered classes and the projects.

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
                         (scan-skill) draft file; default ./<id>.manifest.json
  --repo <repo>          (scan-skill) source repository, for origin.repo
  --ref <ref>            (scan-skill) commit or tag — never a branch (D4)
  --role work|gate       (scan-skill) role of the skill; always explicit
  --by <name>            (scan-skill) who is importing, for origin.imported_by
  --job <id>             (register-skill) job the approval was opened on
  --project <id|name>    project to work in (import, export, status); default 1.
                         A name is resolved against GET /v1/projects
  --json                 (status) prints the report as a single JSON object
  -h, --help             this text

Startup configuration: CARTOGRAFO_DB_PATH, CARTOGRAFO_PORT, CARTOGRAFO_HOST,
CARTOGRAFO_SCREEN_PORT.`;

/** Subcommands that talk to the control plane over HTTP; `up` is the other one. */
const API_SUBCOMMANDS = [
  'import',
  'export',
  'status',
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

  // One place, before any subcommand runs: from here on every request this
  // process makes carries the credential (t124, FR6).
  useToken(resolveToken(fromToken.value, env));

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
