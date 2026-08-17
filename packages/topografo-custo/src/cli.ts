/**
 * The `topografo-custo` command (t114, FR5).
 *
 * A single subcommand: `avaliar`. It reads the telemetry of an execution through
 * the public API, aggregates cost by `(version, node)`, applies the policies and
 * creates one **pending** proposal per candidate.
 *
 * ```
 * topografo-custo avaliar --url http://127.0.0.1:4317 --execucao 7 --teto-tokens 200000
 * ```
 *
 * What it deliberately does NOT do:
 *
 * - **it applies nothing.** `POST /v1/proposals/:id/apply` is called nowhere in
 *   this package: applying is a human decision at the gate (README, principle 5),
 *   and the inbox is a ticket of its own (`t111`).
 * - **it does not deduplicate.** Running twice over the same telemetry creates
 *   repeated proposals. `GET /v1/proposals` exists and would allow a check, but
 *   idempotency is not what this ticket proves and nothing here implements it:
 *   declared out of scope (ticket, §6), not a silent bug.
 *
 * Exit codes, in the same convention as the `cartografo` CLI
 * (`packages/core/src/cli/index.ts`):
 *
 * - `0` — the command did what it promised (including when there was no candidate);
 * - `1` — it ran and the result was negative (server down, API refused);
 * - `2` — the command line is wrong.
 */

import {
  ApiError,
  createProposal,
  getGraphVersion,
  getJobs,
  getSessions,
  type GraphVersion,
} from './client.ts';
import { aggregateCost, identifiedRows } from './cost.ts';
import { evaluatePolicies } from './policy.ts';

/**
 * Usage text. It is the same on `--help` (stdout) and on a usage error (stderr).
 *
 * In English since t180, like every command output in the repository. What a
 * person TYPES — the `avaliar` subcommand and the `--teto-tokens`,
 * `--tier-minimo-nos`, … options — stays as it is: D20 freezes the CLI surface
 * as wire vocabulary, and it migrates to English only under t213, never under a
 * per-package D18 sweep.
 */
export const USAGE = `usage: topografo-custo avaliar --url <url> --execucao <id> [options]

subcommands:
  avaliar                reads the telemetry of an execution, aggregates cost by
                         (graph version, node) and creates one pending proposal
                         per policy candidate. It never applies a proposal.

options:
  --url <url>            control plane to query (required)
  --execucao <id>        execution to evaluate (required)
  --teto-tokens <n>      a candidate when tokens_total of the node passes <n>
  --teto-segundos <n>    a candidate when tempo_total_segundos of the node
                         passes <n>
  --tier-fator <n>       multiple of the version median that makes an outlier
                         (default 3)
  --tier-minimo-nos <n>  fewest measured nodes in a version for tier to be
                         evaluated (default 3)
  --token <token>        control plane credential (env CARTOGRAFO_TOKEN); it is
                         printed the first time the control plane starts
  -h, --help             this text

With no ceiling declared, the ceiling policy does not run: there is nothing to
exceed.`;

/** The command line is wrong. Exits 2, as in `cartografo`. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** What `avaliar` needs to know. */
export interface EvaluateOptions {
  url: string;
  executionId: number;
  tokenCeiling?: number;
  secondCeiling?: number;
  tierFactor?: number;
  tierMinNodes?: number;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  doFetch?: typeof fetch;
}

/** A proposal this command has just created. */
export interface CreatedProposal {
  id: number;
  status: string;
  no_id: string;
  grafo_versao_id: string;
  tipo: 'teto' | 'tier';
}

/** What can be injected into a run of the command. All of it for tests only. */
export interface CliContext {
  doFetch?: typeof fetch;
  write?: (text: string) => void;
}

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

/** Converts a numeric option, refusing junk instead of becoming `NaN`. */
function asNumber(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`${name} needs a non-negative number, got "${raw}"`);
  }
  return parsed;
}

/** The current description of a node inside an already fetched snapshot. */
function nodeDescriptionInSnapshot(version: GraphVersion | undefined, nodeId: string): string {
  const node = version?.snapshot?.nodes?.find((candidate) => candidate.id === nodeId);
  return node?.description ?? '';
}

/**
 * The body of the `avaliar` subcommand (FR5).
 *
 * Fetches the sessions and jobs of the execution, builds the map
 * `trabalho_id -> grafo_versao_id`, aggregates, reads the snapshot of each
 * distinct version to learn the current description of the nodes, evaluates the
 * policies and creates one proposal per candidate.
 *
 * @param options URL, execution and policy calibration.
 * @returns The proposals created, in the order they were created.
 * @throws {ApiError} When the API refuses any of the calls.
 */
export async function evaluateExecution(options: EvaluateOptions): Promise<CreatedProposal[]> {
  const { url, executionId, doFetch } = options;
  const filter = { execution_id: executionId };

  const [sessions, jobs] = await Promise.all([
    getSessions(url, filter, doFetch),
    getJobs(url, filter, doFetch),
  ]);

  const versionByJob = new Map(jobs.map((job) => [job.id, job.graph_version_id] as const));
  const rows = identifiedRows(aggregateCost(sessions, versionByJob));

  // One snapshot per distinct version, not one per candidate: the same version
  // usually explains several expensive nodes, and fetching it again for each one
  // would be noise on the API with no new information.
  const snapshots = new Map<string, GraphVersion>();
  for (const versionId of new Set(rows.map((row) => row.grafo_versao_id))) {
    snapshots.set(versionId, await getGraphVersion(url, versionId, doFetch));
  }

  const candidates = evaluatePolicies(rows, {
    tokenCeiling: options.tokenCeiling,
    secondCeiling: options.secondCeiling,
    tierFactor: options.tierFactor,
    tierMinNodes: options.tierMinNodes,
    currentDescription: (graphVersionId, nodeId) =>
      nodeDescriptionInSnapshot(snapshots.get(graphVersionId), nodeId),
  });

  const created: CreatedProposal[] = [];
  for (const candidate of candidates) {
    const version = snapshots.get(candidate.grafo_versao_id);
    if (version === undefined) continue;

    const proposal = await createProposal(
      url,
      {
        graph_id: version.graph_id,
        target_version: version.id,
        operations: candidate.operacoes,
        evidence: candidate.evidencia,
        expected_metric: candidate.metrica_esperada,
      },
      doFetch,
    );

    created.push({
      id: proposal.id,
      status: proposal.status,
      no_id: candidate.no_id,
      grafo_versao_id: candidate.grafo_versao_id,
      tipo: candidate.tipo,
    });
  }

  return created;
}

/** One report line per proposal created. */
function reportLine(created: CreatedProposal): string {
  return `proposal ${created.id} · node ${created.no_id} · ${created.tipo} · ${created.status}\n`;
}

/**
 * Entry point of the command: decides the subcommand and returns the exit code.
 *
 * It does not call `process.exit`: whoever invokes decides that — the same
 * choice as `runCli` in the core package.
 *
 * @param args `process.argv.slice(2)`.
 * @param context Test injections (`fetch` and output writer).
 * @returns Exit code.
 */
export async function runCli(args: string[], context: CliContext = {}): Promise<number> {
  const write = context.write ?? ((text: string) => void process.stdout.write(text));

  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    write(`${USAGE}\n`);
    return 0;
  }

  const subcommand = args[0];
  if (subcommand !== 'avaliar') {
    process.stderr.write(`topografo-custo: unknown subcommand: "${subcommand ?? ''}"\n${USAGE}\n`);
    return 2;
  }

  try {
    const options = parseArguments(args.slice(1), context.doFetch);
    const created = await evaluateExecution(options);

    if (created.length === 0) {
      write('no candidate: the telemetry of this execution broke no policy\n');
      return 0;
    }
    for (const proposal of created) write(reportLine(proposal));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`topografo-custo: ${error.message}\n`);
      process.stderr.write('topografo-custo: run `topografo-custo --help` for the usage\n');
      return 2;
    }
    if (error instanceof ApiError) {
      process.stderr.write(
        `topografo-custo: ${error.message}\n${JSON.stringify(error.body ?? null)}\n`,
      );
      return 1;
    }
    // `fetch` throws a TypeError when nobody is listening on the port. That is a
    // negative result (server down), not a bug — and it is the most common case
    // of all the first time somebody runs the command.
    if (error instanceof TypeError) {
      process.stderr.write(`topografo-custo: could not reach the control plane: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

/**
 * Environment variable that carries the control plane credential (t124).
 *
 * The same one as `cartografo`: whoever exports the token once in the shell uses
 * the command of that control plane without repeating anything.
 */
export const ENV_TOKEN = 'CARTOGRAFO_TOKEN';

/**
 * Wraps `fetch` so that the credential is presented on every call (t124).
 *
 * The injection point already existed — `doFetch` — and it is through it that
 * the credential comes in: the four functions of `client.ts` still know nothing
 * about authentication existing, the same way they do not know there is a network
 * beyond the `fetch` they receive.
 *
 * @param doFetch Base implementation (default: the global `fetch`).
 * @param token Token to present; without it, nothing is added to the request.
 * @returns The `fetch` the lens is going to use.
 */
export function withCredential(doFetch: typeof fetch = fetch, token?: string): typeof fetch {
  if (token === undefined || token === '') return doFetch;

  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return await doFetch(input, { ...init, headers });
  };
}

/** Reads the options of `avaliar`, refusing what it does not understand. */
function parseArguments(
  args: string[],
  doFetch?: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): EvaluateOptions {
  const fromUrl = extractValue(args, '--url');
  const fromToken = extractValue(fromUrl.rest, '--token');
  const fromExecution = extractValue(fromToken.rest, '--execucao');
  const fromTokenCeiling = extractValue(fromExecution.rest, '--teto-tokens');
  const fromSecondCeiling = extractValue(fromTokenCeiling.rest, '--teto-segundos');
  const fromFactor = extractValue(fromSecondCeiling.rest, '--tier-fator');
  const fromMinNodes = extractValue(fromFactor.rest, '--tier-minimo-nos');

  if (fromMinNodes.rest.length > 0) {
    throw new UsageError(
      `avaliar does not understand: ${fromMinNodes.rest.map((extra) => `"${extra}"`).join(', ')}`,
    );
  }

  if (fromUrl.value === undefined) throw new UsageError('avaliar needs --url');
  if (fromExecution.value === undefined) throw new UsageError('avaliar needs --execucao');

  const executionId = Number(fromExecution.value);
  if (!Number.isInteger(executionId)) {
    throw new UsageError(`--execucao needs an integer id, got "${fromExecution.value}"`);
  }

  return {
    url: fromUrl.value,
    executionId,
    tokenCeiling: asNumber('--teto-tokens', fromTokenCeiling.value),
    secondCeiling: asNumber('--teto-segundos', fromSecondCeiling.value),
    tierFactor: asNumber('--tier-fator', fromFactor.value),
    tierMinNodes: asNumber('--tier-minimo-nos', fromMinNodes.value),
    doFetch: withCredential(doFetch, fromToken.value?.trim() ?? env[ENV_TOKEN]?.trim()),
  };
}

// The production path is the package's own `bin` (t199, FR3), and it imports
// this module rather than executing it:
// `npx topografo-custo avaliar --url ... --execucao ...`.
// The guard stays here for the OTHER half: without it, any `import { runCli }`
// (which is what `test/cli.test.ts` does) would run the CLI just by loading the
// file. As a bonus, `node --import tsx src/cli.ts` keeps working for whoever is
// debugging the package from the inside.
if (import.meta.filename === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
