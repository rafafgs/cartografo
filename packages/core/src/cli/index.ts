/**
 * Router of the `cartografo` command (t108, FR1/FR7).
 *
 * The command was born doing one thing only — starting the control plane — and
 * keeps doing exactly that when called with no argument. That is not
 * backward-compatibility out of politeness: `npx cartografo` is the project's
 * front door, and time-to-first-graph is a quality non-negotiable
 * (`notas/2026-08-14-extensao-e-qualidade.md`). A mandatory subcommand would add
 * a word to the most travelled path of the product for nobody's benefit.
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
import { DEFAULT_PORT, main } from '../index.ts';
import { runExport } from './export.ts';
import { runImport } from './import.ts';
import { runProposeSkill, runRegisterSkill, runScanSkill } from './skill-import.ts';
import { runStatus } from './status.ts';
import {
  DeniedError,
  ENV_TOKEN,
  ENV_URL,
  NetworkError,
  UsageError,
  deniedMessage,
  resolveBaseUrl,
  resolveToken,
  serverDownMessage,
  useToken,
} from './url.ts';

/** Usage text. The same in `--help` (stdout) and on a wrong subcommand (stderr). */
export const USAGE = `usage: cartografo [subcommand] [options]

subcommands:
  up                     starts the control plane: database, migrations and HTTP.
                         It is the default — \`cartografo\` with no argument does this.
  import <path>          registers a graph as a new base lineage. <path> is a
                         graph file or a bundle directory (with grafo.json and,
                         optionally, skills/ to check).
  export <class>         writes the current version of the class to a file, in
                         the same format import accepts back.
  status                 reports the server and the registered projects.

  the D4 skill-import gate, in three steps:

  scan-skill <path>      derives a draft manifest from the SKILL.md of an
                         already-cloned local checkout. Guesses nothing: what
                         only a human can write comes out as a placeholder.
  propose-skill <file>   opens the human approval for a completed manifest and
                         blocks a job on it. Never auto-approvable.
  register-skill         sends what the human approved to the registry, which
                         verifies it again before anything is stored.

options:
  --url <url>            control plane to query (env ${ENV_URL};
                         default http://127.0.0.1:${DEFAULT_PORT})
  --token <token>        credential of the control plane (env ${ENV_TOKEN});
                         it is printed when the control plane first starts
  --out <path>           (export) output file; default ./<class>.grafo.json
                         (scan-skill) draft file; default ./<id>.manifest.json
  --repo <repo>          (scan-skill) source repository, for origin.repo
  --ref <ref>            (scan-skill) commit or tag — never a branch (D4)
  --role work|gate       (scan-skill) role of the skill; always explicit
  --by <name>            (scan-skill) who is importing, for origin.imported_by
  --job <id>             (register-skill) job the approval was opened on
  --json                 (status) prints the report as a single JSON object
  -h, --help             this text

Startup configuration: CARTOGRAFO_DB_PATH, CARTOGRAFO_PORT, CARTOGRAFO_HOST.`;

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

/** Refuses what is left on the command line instead of ignoring it silently. */
function requireNothingElse(left: string[], positionalCount: number, subcommand: string): void {
  const extras = left.slice(positionalCount);
  if (extras.length > 0) {
    throw new UsageError(`${subcommand} does not understand: ${extras.map((extra) => `"${extra}"`).join(', ')}`);
  }
}

/** Starts the control plane, preserving the failure message the startup already had. */
async function startControlPlane(): Promise<number> {
  try {
    await main();
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
  const url = resolveBaseUrl(fromUrl.value, env);

  // One place, before any subcommand runs: from here on every request this
  // process makes carries the credential (t124, FR6).
  useToken(resolveToken(fromToken.value, env));

  if (subcommand === 'import') {
    requireNothingElse(fromToken.rest, 1, 'import');
    const inputPath = fromToken.rest[0];
    if (inputPath === undefined) {
      throw new UsageError('import needs a path: a graph file or a bundle directory');
    }
    return await runImport({ path: inputPath, url });
  }

  if (subcommand === 'export') {
    const fromOutput = extractValue(fromToken.rest, '--out');
    requireNothingElse(fromOutput.rest, 1, 'export');
    const className = fromOutput.rest[0];
    if (className === undefined) throw new UsageError('export needs the graph class');
    return await runExport({ className, url, output: fromOutput.value });
  }

  if (subcommand === 'scan-skill') {
    const fromRepo = extractValue(fromToken.rest, '--repo');
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
    requireNothingElse(fromToken.rest, 1, 'propose-skill');
    const manifestPath = fromToken.rest[0];
    if (manifestPath === undefined) {
      throw new UsageError('propose-skill needs the path of a completed manifest file');
    }
    return await runProposeSkill({ path: manifestPath, url });
  }

  if (subcommand === 'register-skill') {
    const fromJob = extractValue(fromToken.rest, '--job');
    requireNothingElse(fromJob.rest, 0, 'register-skill');
    if (fromJob.value === undefined) throw new UsageError('register-skill needs --job');
    const jobId = Number(fromJob.value);
    if (!Number.isInteger(jobId)) {
      throw new UsageError(`--job has to be an integer (got: "${fromJob.value}")`);
    }
    return await runRegisterSkill({ jobId, url });
  }

  const fromFlag = extractFlag(fromToken.rest, '--json');
  requireNothingElse(fromFlag.rest, 0, 'status');
  return await runStatus({ url, json: fromFlag.present });
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

  const subcommand = args[0] ?? 'up';
  const rest = args.slice(1);

  if (subcommand === 'up') return await startControlPlane();

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
    if (error instanceof UsageError) {
      process.stderr.write(`cartografo: ${error.message}\n`);
      process.stderr.write('cartografo: run `cartografo --help` for usage\n');
      return 2;
    }
    throw error;
  }
}
