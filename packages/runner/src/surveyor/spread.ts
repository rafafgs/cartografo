/**
 * How much a number moves on its own: the spread of n>1 rounds (t239, FR5/FR6).
 *
 * `outcome.ts` reads what ONE round measured, and that single number is what
 * closes a hypothesis — against a strict comparator with no tolerance band, on
 * purpose (`packages/core/src/domain/hypothesis.ts`: "A margin would be a
 * product decision about what counts as 'no effect', and burying one in a
 * comparison operator is how it would never get made on purpose"). The only
 * closed cycle this project has recorded (`notes/2026-08-15-closed-learning-loop.md`)
 * ends by naming exactly what it could not say: "One round is not a
 * measurement […] nothing in this cycle separates 'the change made it worse'
 * from 'the session took longer this time'".
 *
 * This module is the other half of that sentence — the product decision made
 * OUTSIDE the comparator. Three crossings of version A and three of version B
 * give six numbers, and whether the change moved anything is a question about
 * the six, not about the one the database closed on.
 *
 * What it reports is deliberately thin: `mean`, `min`, `max`, `range`. No
 * verdict, no band, no significance. The reading of the spread is prose in the
 * round's note, where a person can disagree with it and rewrite it; a verdict
 * computed here would be the same margin, buried in a different file. Nothing
 * in this module is ever written to the control plane — `measure-executions` is
 * read-only, and `close-outcome` keeps closing on one execution, unchanged.
 *
 * It refuses like {@link measureForExpectedMetric} refuses: an empty list is
 * `null`, never a zeroed summary. A `mean` of `0` over no measurement reads as
 * "the bottleneck vanished" — the best possible outcome — when what happened is
 * that nobody measured anything.
 *
 * Pure: no HTTP, no clock, no filesystem, no database. `measure-executions.mjs`
 * is left with the network and the exit code, the same split
 * `close-surveyor-outcome.mjs` keeps with `outcome.ts` and `cli.mjs` with
 * `command-line.ts`.
 *
 * English per D18/D20: what a person types and what a person reads are English,
 * and `metric`/`execution_id` are already the flow lens's spelling
 * (`docs/spec/glossary-wire.md` §5.6, {@link MEASURES}).
 */

import { DEFAULT_URL, ENV_TOKEN } from './command-line.ts';

/** What a list of measurements of the same metric looks like, folded. */
export interface MeasurementSummary {
  /** Sum over count. The number the note compares between the two sides. */
  mean: number;
  /** Smallest of the list. */
  min: number;
  /** Largest of the list. */
  max: number;
  /** `max - min`: how much this side moved without anything changing. */
  range: number;
}

/**
 * Folds a list of measurements into its mean and its spread.
 *
 * @param values Measurements of the SAME metric, one per round, in any order —
 *   the summary is a function of the set, so two operators listing the same
 *   executions differently reach the same four numbers.
 * @returns The summary, or `null` when there is nothing to summarize: an empty
 *   list, or a list carrying anything that is not a finite number. Both are the
 *   same refusal — a summary that folded a `NaN` would report a `mean` of `NaN`
 *   and a `range` computed off it, which is worse than no summary at all,
 *   because it looks like one.
 */
export function summarizeMeasurements(values: readonly number[]): MeasurementSummary | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  }

  let sum = 0;
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  return { mean: sum / values.length, min, max, range: max - min };
}

/* -------------------------------------------------------------------------- */
/* The command line of `measure-executions`                                    */
/* -------------------------------------------------------------------------- */

/** Usage text. Printed on stderr whenever the command line is refused. */
export const MEASURE_USAGE = `usage: npm run measure-executions --workspace @cartografo/runner -- \\
  <metric> <execution_id> [execution_id ...] [--url <url>] [--token <token>]

  metric        the "<measure>:<node_id>" the proposal declared, as in
                agent_ms:redigir (required)
  execution_id  one or more rounds to measure, integers (required)
  --url         control plane to read them from (default: ${DEFAULT_URL})
  --token       control plane credential (env ${ENV_TOKEN}); it is printed on
                the readiness line of the control plane's first startup`;

/** What a run of the command needs to know. */
export interface MeasureRunOptions {
  /** The `metrica_esperada.nome` to resolve in every round, `"<measure>:<node_id>"`. */
  metric: string;
  /** The rounds to measure, in the order they were typed. */
  executionIds: number[];
  /** Base URL of the control plane. */
  url: string;
  /** Credential to present; absent means no header at all. */
  token?: string;
}

/** Either the command line is runnable, or it is refused with a reason. */
export type ParsedMeasureCommand =
  | { kind: 'usage'; message: string }
  | { kind: 'run'; options: MeasureRunOptions };

/** Trims a candidate value and turns the blank ones into "none presented". */
function usable(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Reads the argv of the measure command.
 *
 * Hand-rolled and flag-anywhere, like `parseOutcomeArguments` and
 * `parseArguments` before it: the person running the manual commands of this
 * package is the same person, and a second convention would be a second thing
 * to remember.
 *
 * One departure, and it is forced: the control plane's address is `--url` here
 * instead of a trailing positional. The list of execution ids is variable
 * length, so a positional url would be indistinguishable from an id that failed
 * to parse — and guessing which one the operator meant is exactly the kind of
 * cleverness that makes a measurement unreproducible. `--url` is also what the
 * `cartografo` CLI and `cost-surveyor` already spell (`packages/core/src/cli/url.ts`).
 *
 * @param argv Arguments after the script name.
 * @param env Environment to read the credential from.
 * @returns A refusal with its message, or the run and its options.
 */
export function parseMeasureArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedMeasureCommand {
  const positional: string[] = [];
  let flaggedToken: string | undefined;
  let flaggedUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--token' || current === '--url') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return { kind: 'usage', message: `${current} needs a value` };
      }
      if (current === '--token') flaggedToken = next;
      else flaggedUrl = next;
      index += 1;
      continue;
    }
    if (current.startsWith('--token=') || current.startsWith('--url=')) {
      const separator = current.indexOf('=');
      const inline = current.slice(separator + 1);
      if (inline === '') {
        return { kind: 'usage', message: `${current.slice(0, separator)} needs a value` };
      }
      if (current.startsWith('--token=')) flaggedToken = inline;
      else flaggedUrl = inline;
      continue;
    }

    if (current.startsWith('--')) {
      return { kind: 'usage', message: `measure-executions does not understand ${current}` };
    }
    positional.push(current);
  }

  const [metric, ...rawExecutions] = positional;

  // A metric name carries a colon by construction (`"<measure>:<node_id>"`,
  // `outcome.ts`). Checking the shape here catches the operator who typed the
  // ids and forgot the metric, before three round trips end in a refusal they
  // have to decode backwards.
  if (metric === undefined || metric === '' || !metric.includes(':')) {
    return {
      kind: 'usage',
      message:
        'metric has to be shaped "<measure>:<node_id>", the way the proposal declared it ' +
        `(got: ${JSON.stringify(metric)})`,
    };
  }

  if (rawExecutions.length === 0) {
    return { kind: 'usage', message: 'at least one execution_id is required' };
  }

  const executionIds: number[] = [];
  for (const raw of rawExecutions) {
    const executionId = Number(raw);
    if (!Number.isInteger(executionId)) {
      return {
        kind: 'usage',
        message: `execution_id has to be an integer (got: ${JSON.stringify(raw)})`,
      };
    }
    executionIds.push(executionId);
  }

  const token = usable(flaggedToken) ?? usable(env[ENV_TOKEN]);

  return {
    kind: 'run',
    options: {
      metric,
      executionIds,
      url: usable(flaggedUrl) ?? DEFAULT_URL,
      ...(token === undefined ? {} : { token }),
    },
  };
}
