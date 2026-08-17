/**
 * Closing the experiment: from the next round's ranking back to ONE number
 * (t165, FR6/FR9).
 *
 * The surveyor opens a hypothesis naming the number it expects to move, and it
 * names it as `"<medida>:<no_id>"` — `"tempo_agente_ms:redigir"`
 * (`docs/spec/topografo-fluxo.md` §4, `proposal.ts:buildExpectedMetric`). The
 * control plane closes it against `depois`, a plain number the caller computes
 * (`POST /v1/proposals/:id/outcome`, t112: "there is no engine of named metrics
 * in v1"). Between the two there was nothing but a person reading a ranking and
 * typing a float — which is exactly the step where a learning loop stops being
 * evidence and becomes an opinion.
 *
 * {@link measureForExpectedMetric} is that step, and it is pure for the same
 * reason `metrics.ts` is: what closes an experiment has to be a subtraction
 * anybody can redo from the log, not an agent's recollection.
 *
 * It never invents a number. A version that dropped the node, a round with no
 * signal on it, a name from a vocabulary this code does not know: all `null`,
 * and what to do about it belongs to the caller. `close-surveyor-outcome.mjs`
 * refuses to close the experiment rather than closing it with a zero, because a
 * zero would read as "the bottleneck vanished" — the best possible verdict —
 * when what actually happened is that nobody measured anything.
 *
 * The command line lives here too, for the reason `command-line.ts` records
 * about its own: what a test can reach without spawning a process is what stays
 * covered, so the `.mjs` is left with the network and the exit code.
 *
 * English per D18; the measure names stay in Portuguese because they are the
 * payload keys of `proposta.metrica_esperada` and of `FlowMetrics`.
 */

import type { FlowMetrics, NodeMetric } from './metrics.ts';
import { DEFAULT_URL, ENV_TOKEN } from './command-line.ts';

/**
 * The measures of the ranking that name a number, and only those.
 *
 * A closed list and not "any key of `NodeMetric`": `no_id` and `eventos` are
 * not measurements, and reading an arbitrary key off an object would let
 * `"constructor:redigir"` resolve to something. The five here are exactly the
 * four of `topografo-fluxo.md` §2 plus the total the ranking sorts by.
 */
export const MEASURES = Object.freeze([
  'tempo_agente_ms',
  'tempo_espera_ms',
  'tempo_fila_ms',
  'total_ms',
  'perguntas',
]);

/** One of {@link MEASURES}. */
export type MeasureName = 'tempo_agente_ms' | 'tempo_espera_ms' | 'tempo_fila_ms' | 'total_ms' | 'perguntas';

/**
 * Reads the number an `ExpectedMetric.nome` points at, out of a round's ranking.
 *
 * @param metrics The next round's metrics, straight out of
 *   `calculateFlowMetrics` — the same shape the proposal's evidence was built
 *   from, which is what makes the two numbers comparable at all.
 * @param name The `nome` the proposal declared, shaped `"<medida>:<no_id>"`.
 * @returns The measured value, or `null` when the name is malformed, names a
 *   measure this code does not know, or names a node absent from the ranking. A
 *   node that ran and cost nothing measures `0`, which is a number and not an
 *   absence — telling those two apart is the whole reason this returns `null`
 *   instead of falling back to zero.
 */
export function measureForExpectedMetric(metrics: FlowMetrics, name: string): number | null {
  if (typeof name !== 'string') return null;

  // First colon wins, and a second one is a refusal rather than a guess: no
  // node id in the graph schema carries a `:`, so a name with two of them is
  // not a name this function can honestly resolve.
  const parts = name.split(':');
  if (parts.length !== 2) return null;

  const [measure, nodeId] = parts;
  if (measure === '' || nodeId === '') return null;
  if (!MEASURES.includes(measure)) return null;

  const row = metrics.por_no.find((candidate) => candidate.no_id === nodeId);
  if (row === undefined) return null;

  const value = row[measure as MeasureName];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The node the ranking blames this round, as a line for the operator's log.
 *
 * @param metrics The round's metrics.
 * @returns A one-line summary, or the honest sentence when nothing cost time.
 */
export function describeBottleneck(metrics: FlowMetrics): string {
  const worst: NodeMetric | null = metrics.gargalo;
  if (worst === null) return 'nenhum nó custou tempo nesta rodada';
  return (
    `${worst.no_id}: total_ms=${worst.total_ms} ` +
    `(agente=${worst.tempo_agente_ms}, espera=${worst.tempo_espera_ms}, fila=${worst.tempo_fila_ms})`
  );
}

/* -------------------------------------------------------------------------- */
/* The command line of `close-outcome`                                         */
/* -------------------------------------------------------------------------- */

/** Usage text. Printed on stderr whenever the command line is refused. */
export const OUTCOME_USAGE = `usage: npm run close-outcome --workspace @cartografo/runner -- \\
  <proposal_id> <execution_id> [url] [--token <token>]

  proposal_id   the applied proposal whose hypothesis is being closed (integer)
  execution_id  the NEXT round, the one that ran under the applied version (integer)
  url           control plane to read it from (default: ${DEFAULT_URL})
  --token       control plane credential (env ${ENV_TOKEN}); it is printed on
                the readiness line of the control plane's first startup`;

/** What a run of the command needs to know. */
export interface OutcomeRunOptions {
  /** The proposal whose hypothesis is being closed. */
  proposalId: number;
  /** The execution that ran under the version that proposal applied. */
  executionId: number;
  /** Base URL of the control plane. */
  url: string;
  /** Credential to present; absent means no header at all. */
  token?: string;
}

/** Either the command line is runnable, or it is refused with a reason. */
export type ParsedOutcomeCommand =
  | { kind: 'usage'; message: string }
  | { kind: 'run'; options: OutcomeRunOptions };

/** Trims a candidate token and turns the blank ones into "none presented". */
function usableToken(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Reads the argv of the outcome command.
 *
 * Hand-rolled and flag-anywhere, the same shape `parseArguments` uses in
 * `command-line.ts`: the person running the three manual commands of this
 * package is the same person, and a second convention would be a second thing
 * to remember.
 *
 * @param argv Arguments after the script name.
 * @param env Environment to read the credential from.
 * @returns A refusal with its message, or the run and its options.
 */
export function parseOutcomeArguments(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedOutcomeCommand {
  const positional: string[] = [];
  let flagged: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--token') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return { kind: 'usage', message: '--token needs a value' };
      }
      flagged = next;
      index += 1;
      continue;
    }
    if (current.startsWith('--token=')) {
      const inline = current.slice('--token='.length);
      if (inline === '') return { kind: 'usage', message: '--token needs a value' };
      flagged = inline;
      continue;
    }
    if (current.startsWith('--')) {
      return { kind: 'usage', message: `close-outcome does not understand ${current}` };
    }
    positional.push(current);
  }

  const [rawProposal, rawExecution, url, ...extra] = positional;
  if (extra.length > 0) {
    return {
      kind: 'usage',
      message: `close-outcome does not understand: ${extra.map((one) => `"${one}"`).join(', ')}`,
    };
  }

  const proposalId = Number(rawProposal);
  if (rawProposal === undefined || !Number.isInteger(proposalId)) {
    return { kind: 'usage', message: `proposal_id has to be an integer (got: ${JSON.stringify(rawProposal)})` };
  }

  const executionId = Number(rawExecution);
  if (rawExecution === undefined || !Number.isInteger(executionId)) {
    return { kind: 'usage', message: `execution_id has to be an integer (got: ${JSON.stringify(rawExecution)})` };
  }

  const token = usableToken(flagged) ?? usableToken(env[ENV_TOKEN]);

  return {
    kind: 'run',
    options: {
      proposalId,
      executionId,
      url: url ?? DEFAULT_URL,
      ...(token === undefined ? {} : { token }),
    },
  };
}
