/**
 * Acceptance tests for the measurement that closes a hypothesis (t165, FR6).
 *
 * `measureForExpectedMetric` is the missing half of the learning loop. The
 * surveyor names the number it expects to move as `"<medida>:<no_id>"`
 * (`docs/spec/topografo-fluxo.md` §4, `proposal.ts:buildExpectedMetric`); the
 * outcome route wants the same number measured in the NEXT round
 * (`POST /v1/proposals/:id/outcome`, t112). Between the two there was nothing —
 * a human reading a ranking and typing a float. This function is that step, and
 * it is pure for the same reason `metrics.ts` is: what closes an experiment has
 * to be a subtraction anyone can redo, not an agent's recollection.
 *
 * It never invents a number. A version that dropped the node, a round with zero
 * signal on it, a `nome` from a vocabulary this code does not know: all `null`,
 * and what to do about that belongs to the caller — the script refuses to close
 * the experiment rather than closing it with a zero.
 *
 * English per D18; the measure names stay in Portuguese because they are the
 * payload keys of `proposta.metrica_esperada` and of `FlowMetrics`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as OutcomeModule from '../../src/surveyor/outcome.ts';
import type { FlowMetrics, NodeMetric } from '../../src/surveyor/metrics.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUTCOME_MODULE = 'src/surveyor/outcome.ts';

let cache: typeof OutcomeModule | null = null;

async function loadOutcome(): Promise<typeof OutcomeModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, OUTCOME_MODULE)),
    `artifact does not exist yet: packages/runner/${OUTCOME_MODULE}`,
  );
  cache ??= (await import(
    new URL(`../../${OUTCOME_MODULE}`, import.meta.url).href
  )) as typeof OutcomeModule;
  return cache;
}

/** One row of the ranking, in the exact shape `calculateFlowMetrics` produces. */
function nodeMetric(no_id: string, values: Partial<NodeMetric> = {}): NodeMetric {
  const tempo_agente_ms = values.tempo_agente_ms ?? 0;
  const tempo_espera_ms = values.tempo_espera_ms ?? 0;
  const tempo_fila_ms = values.tempo_fila_ms ?? 0;
  return {
    no_id,
    tempo_agente_ms,
    tempo_espera_ms,
    tempo_fila_ms,
    total_ms: tempo_agente_ms + tempo_espera_ms + tempo_fila_ms,
    perguntas: values.perguntas ?? 0,
    eventos: values.eventos ?? [],
  };
}

/** The ranking of a round: `redigir` costly, `revisar` cheap, `implantar` free. */
function metrics(): FlowMetrics {
  const por_no = [
    nodeMetric('redigir', {
      tempo_agente_ms: 16_406,
      tempo_espera_ms: 5_009,
      tempo_fila_ms: 12,
      perguntas: 1,
      eventos: [2, 3, 4, 5],
    }),
    nodeMetric('revisar', { tempo_agente_ms: 4_000, eventos: [8, 9] }),
    nodeMetric('implantar'),
  ];
  return { por_no, gargalo: por_no[0] };
}

test('t165 AT8 — a "<medida>:<no_id>" name resolves to that node\'s number', async () => {
  const { measureForExpectedMetric } = await loadOutcome();
  const round = metrics();

  assert.equal(
    measureForExpectedMetric(round, 'tempo_agente_ms:redigir'),
    16_406,
    'the name the surveyor writes is the name that gets read back',
  );
  assert.equal(measureForExpectedMetric(round, 'tempo_espera_ms:redigir'), 5_009);
  assert.equal(measureForExpectedMetric(round, 'tempo_fila_ms:redigir'), 12);
  assert.equal(measureForExpectedMetric(round, 'total_ms:redigir'), 21_427);
  assert.equal(measureForExpectedMetric(round, 'perguntas:redigir'), 1);

  // A node that ran and cost nothing measures zero — which is a real number and
  // not an absence. Confusing the two is how "the bottleneck disappeared" would
  // read as "the node disappeared".
  assert.equal(measureForExpectedMetric(round, 'tempo_agente_ms:implantar'), 0);

  // The node is picked by id, never by position in the ranking.
  assert.equal(measureForExpectedMetric(round, 'tempo_agente_ms:revisar'), 4_000);
});

test('t165 AT9 — a node absent from the ranking measures null', async () => {
  const { measureForExpectedMetric } = await loadOutcome();
  const round = metrics();

  assert.equal(
    measureForExpectedMetric(round, 'tempo_agente_ms:checar_fatos'),
    null,
    'a version that dropped the node has no number to report for it',
  );
  assert.equal(
    measureForExpectedMetric({ por_no: [], gargalo: null }, 'tempo_agente_ms:redigir'),
    null,
    'and a round with no ranking at all reports nothing, rather than zero',
  );
});

test('t165 AT10 — a malformed or unknown name measures null instead of crashing', async () => {
  const { measureForExpectedMetric } = await loadOutcome();
  const round = metrics();

  assert.equal(measureForExpectedMetric(round, 'tempo_agente_ms'), null, 'no ":" at all');
  assert.equal(measureForExpectedMetric(round, 'retrabalho_por_travessia'), null);
  assert.equal(measureForExpectedMetric(round, 'custo_usd:redigir'), null, 'unknown measure');
  assert.equal(measureForExpectedMetric(round, ':redigir'), null, 'empty measure');
  assert.equal(measureForExpectedMetric(round, 'tempo_agente_ms:'), null, 'empty node');
  assert.equal(measureForExpectedMetric(round, ''), null);

  // A node id carrying a colon is not a thing the graph schema allows, and the
  // split has to stay predictable rather than clever: first colon wins.
  assert.equal(measureForExpectedMetric(round, 'tempo_agente_ms:redigir:extra'), null);

  // The prototype chain is not a vocabulary: `constructor` names no measure.
  assert.equal(measureForExpectedMetric(round, 'constructor:redigir'), null);
  assert.equal(measureForExpectedMetric(round, 'node_id:redigir'), null, 'no_id is not a measure');
});

/**
 * t230 — the two positionals `close-outcome` PRINTS are English (D20 §5.1/§1).
 *
 * Display names only. The `execucao_id` this command sends inside the body of
 * `POST /v1/proposals/:id/outcome` is the frozen hypothesis vocabulary
 * (`docs/spec/entidades-versionamento.md` §5) and does not move — conflating
 * the two would rename a wire field that no D20 child owns.
 */
test('t230 — the usage and the refusals of close-outcome name execution_id and proposal_id', async () => {
  const { OUTCOME_USAGE, parseOutcomeArguments } = await loadOutcome();

  assert.match(OUTCOME_USAGE, /<proposal_id> <execution_id>/);
  assert.match(OUTCOME_USAGE, /^ {2}proposal_id {3}/m);
  assert.match(OUTCOME_USAGE, /^ {2}execution_id {2}/m);
  for (const gone of ['proposta_id', 'execucao_id']) {
    assert.ok(!OUTCOME_USAGE.includes(gone), `the usage still shows ${gone}`);
  }

  const noProposal = parseOutcomeArguments(['nao-e-numero', '7'], {});
  assert.ok(noProposal.kind === 'usage');
  assert.match(noProposal.message, /^proposal_id has to be an integer/);

  const noExecution = parseOutcomeArguments(['3', 'nao-e-numero'], {});
  assert.ok(noExecution.kind === 'usage');
  assert.match(noExecution.message, /^execution_id has to be an integer/);
});
