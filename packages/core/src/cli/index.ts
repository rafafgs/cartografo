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
 * The other three (`import`, `export`, `status`) are pure HTTP clients of the
 * public API: they open no database, do not import `src/db/**` and have no
 * privilege whatsoever over the screen or the runner (D1, D11). What they know
 * about the control plane fits in `cli/url.ts`.
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

import { DEFAULT_PORT, main } from '../index.ts';
import { runExport } from './export.ts';
import { runImport } from './import.ts';
import { runStatus } from './status.ts';
import { ENV_URL, NetworkError, UsageError, serverDownMessage, resolveBaseUrl } from './url.ts';

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

options:
  --url <url>            control plane to query (env ${ENV_URL};
                         default http://127.0.0.1:${DEFAULT_PORT})
  --out <path>           (export) output file; default ./<class>.grafo.json
  --json                 (status) prints the report as a single JSON object
  -h, --help             this text

Startup configuration: CARTOGRAFO_DB_PATH, CARTOGRAFO_PORT.`;

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
    console.error('cartografo: startup failed');
    console.error(error);
    return 1;
  }
}

/**
 * Routes one of the subcommands that talk to the API.
 *
 * @param subcommand `import`, `export` or `status`.
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
  const url = resolveBaseUrl(fromUrl.value, env);

  if (subcommand === 'import') {
    requireNothingElse(fromUrl.rest, 1, 'import');
    const inputPath = fromUrl.rest[0];
    if (inputPath === undefined) {
      throw new UsageError('import needs a path: a graph file or a bundle directory');
    }
    return await runImport({ path: inputPath, url });
  }

  if (subcommand === 'export') {
    const fromOutput = extractValue(fromUrl.rest, '--out');
    requireNothingElse(fromOutput.rest, 1, 'export');
    const className = fromOutput.rest[0];
    if (className === undefined) throw new UsageError('export needs the graph class');
    return await runExport({ className, url, output: fromOutput.value });
  }

  const fromFlag = extractFlag(fromUrl.rest, '--json');
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

  if (subcommand !== 'import' && subcommand !== 'export' && subcommand !== 'status') {
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
    if (error instanceof UsageError) {
      process.stderr.write(`cartografo: ${error.message}\n`);
      process.stderr.write('cartografo: run `cartografo --help` for usage\n');
      return 2;
    }
    throw error;
  }
}
