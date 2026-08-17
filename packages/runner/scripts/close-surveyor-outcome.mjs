#!/usr/bin/env node
/**
 * Closes the experiment of ONE proposal against the round that ran after it
 * (t165, FR9).
 *
 * This is the last step of the circle principle 5 describes — propose, gate,
 * apply, MEASURE, close — and the one that had no code. `POST
 * /v1/proposals/:id/outcome` (t112) takes `depois` as a plain number and says
 * so on purpose: "there is no engine of named metrics in v1, whoever calculates
 * it is whoever calls" (`docs/spec/entidades-versionamento.md` §5). Until this
 * script that caller was a person reading a ranking and typing a float, which
 * is the exact spot where a measured loop degrades into a remembered one.
 *
 * What it does, all of it deterministic:
 *
 * 1. reads the proposal (`GET /v1/proposals/:id`) for the `metrica_esperada`
 *    the hypothesis declared;
 * 2. reads the given execution's log and the snapshot of the version the
 *    proposal applied;
 * 3. folds the log with `calculateFlowMetrics` — the same function that
 *    produced the `de` of the hypothesis, so the two numbers are comparable by
 *    construction;
 * 4. resolves `depois` with `measureForExpectedMetric`, and REFUSES to close
 *    the experiment when that comes back `null`. A zero there would read as the
 *    best possible verdict when what happened is that nobody measured;
 * 5. calls `fecharResultadoDeProposta`. The verdict itself is computed by the
 *    control plane (`domain/hypothesis.ts`), never by this script.
 *
 * It never applies, reverts, approves or rejects anything: the client has no
 * method for any of those, deliberately (`cliente-controle.ts`).
 *
 * NOT a CI test — it talks to a running control plane, like everything else in
 * this directory. The pure half is `src/surveyor/outcome.ts`, which the suite
 * does cover; what lives here is the network and the exit code, the same split
 * `src/surveyor/cli.mjs` keeps with `command-line.ts`.
 *
 * Usage:
 *   npm run close-outcome --workspace @cartografo/runner -- \
 *     <proposal_id> <execution_id> [url] [--token <token>]
 */

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { calculateFlowMetrics } from '../src/surveyor/metrics.ts';
import { isDenied, deniedMessage } from '../src/surveyor/command-line.ts';
import {
  measureForExpectedMetric,
  describeBottleneck,
  parseOutcomeArguments,
  OUTCOME_USAGE,
} from '../src/surveyor/outcome.ts';

const log = (message) => console.log(`[outcome] ${message}`);

function die(message) {
  console.error(`\n[outcome] FAILED: ${message}\n`);
  process.exit(1);
}

const parsed = parseOutcomeArguments(process.argv.slice(2));
if (parsed.kind === 'usage') {
  console.error(`${parsed.message}\n\n${OUTCOME_USAGE}`);
  process.exit(2);
}

const { proposalId, executionId, url, token } = parsed.options;
const client = new ClienteControle({
  urlBase: url,
  ...(token === undefined ? {} : { token }),
});

try {
  const proposal = await client.buscarProposta(proposalId);
  log(`proposal ${proposal.id} of graph "${proposal.grafo_id}" is "${proposal.status}"`);

  if (proposal.status !== 'aplicada') {
    die(`only an applied proposal has an experiment to close; this one is "${proposal.status}"`);
  }
  if (proposal.resultado !== null && proposal.resultado !== undefined) {
    die(`this hypothesis was already closed: ${JSON.stringify(proposal.resultado)}`);
  }

  const metric = proposal.metrica_esperada;
  const name = typeof metric === 'object' && metric !== null ? metric.nome : undefined;
  if (typeof name !== 'string' || name === '') {
    die(`proposal ${proposalId} declares no readable metrica_esperada.nome: ${JSON.stringify(metric)}`);
  }
  log(`hypothesis: ${JSON.stringify(metric)}`);

  // The node ids come from the version the proposal APPLIED — the graph that
  // actually ran in this round. Reading them from the target version would
  // measure the round against the graph it replaced.
  const appliedVersionId = proposal.versao_aplicada_id;
  if (appliedVersionId === null) die(`proposal ${proposalId} has no versao_aplicada_id`);
  const version = await client.buscarVersaoDeGrafo(appliedVersionId);
  const nodeIds = (version.snapshot.nodes ?? []).map((no) => no.id);

  const events = await client.listarEventosDaExecucao(executionId);
  if (events.length === 0) die(`execution ${executionId} has no events`);

  // The join that proves this round is the NEXT one, checked here so the
  // failure names the problem instead of arriving as a 422 from the route.
  const byVersion = await client.metricasPorVersao(executionId);
  const underApplied = byVersion.find((row) => row.grafo_versao_id === appliedVersionId);
  if (underApplied === undefined || underApplied.trabalhos < 1) {
    die(
      `no job of execution ${executionId} ran under ${appliedVersionId} — ` +
        `this is not the round that follows the proposal (${JSON.stringify(byVersion)})`,
    );
  }

  const metrics = calculateFlowMetrics(events, nodeIds);
  log(`${events.length} event(s), bottleneck of this round → ${describeBottleneck(metrics)}`);

  const after = measureForExpectedMetric(metrics, name);
  if (after === null) {
    die(
      `"${name}" measures nothing in execution ${executionId}: the node is not in the ` +
        'ranking of the applied version, or the name is not "<medida>:<no_id>". ' +
        'Closing with a zero would read as the best possible verdict — refusing instead',
    );
  }
  log(`measured ${name} = ${after} (declared de=${metric.de}, para=${metric.para})`);

  const written = await client.fecharResultadoDeProposta(proposalId, {
    execucao_id: executionId,
    depois: after,
  });

  console.log('\n===== outcome =====');
  console.log(`proposal:    ${written.id} (${written.status})`);
  console.log(`version:     ${written.versao_aplicada_id}`);
  console.log(`outcome:     ${JSON.stringify(written.resultado)}`);
  console.log('===================\n');
  log('the hypothesis is closed — verdict computed by the control plane, from real numbers');
} catch (error) {
  if (isDenied(error)) die(deniedMessage(url));
  die(error instanceof Error ? `${error.message} ${JSON.stringify(error.corpo ?? '')}` : String(error));
}
