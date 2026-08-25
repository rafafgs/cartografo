#!/usr/bin/env node
/**
 * The SAME number, read across several rounds (t239, FR6/FR7).
 *
 * `close-outcome` closes a hypothesis on ONE execution, and the control plane
 * grades it with a strict comparator that has no tolerance band, deliberately
 * (`packages/core/src/domain/hypothesis.ts`). That is the official verdict and
 * this command does not touch it. What it adds is the thing the only closed
 * cycle on record said it was missing
 * (`notes/2026-08-15-closed-learning-loop.md`): "uma rodada só não é
 * uma medição […] nada neste ciclo separa 'a mudança piorou' de 'a sessão
 * demorou mais dessa vez'". Three crossings of the version before and three of
 * the version after answer that, and only together.
 *
 * So: one metric name, a list of executions, one line per execution and one
 * summary. Run it once for the three rounds of version A and once for the three
 * of version B, and the note compares the two summaries in prose.
 *
 * **Read-only, and structurally so.** It calls three `GET`s
 * (`/v1/executions/:id/metrics-by-version`, `/v1/graph-versions/:id`,
 * `/v1/executions/:id/events`) and nothing else. `ControlPlaneClient` has no
 * method to apply, approve or reject anything, on purpose, and the one write it
 * does have (`closeProposalOutcome`) is not imported here. Measuring must
 * never be able to change what it measures.
 *
 * **It refuses rather than fabricating.** Every execution is measured, so one
 * run tells the operator about all of them; but if ANY of them measures
 * nothing, no summary is printed and the exit code is `1`. A mean folded over
 * five numbers and a gap would read as a measurement of six rounds — the same
 * failure `close-surveyor-outcome.mjs` refuses when it declines to close an
 * experiment with a zero.
 *
 * Each line also names the graph version the round ran under, because "three
 * rounds of A" is a claim about versions, not about ids, and it is the one
 * claim a reader of the note cannot check afterwards unless the tool printed
 * it. When the given executions did not all run under the same version the
 * command says so and keeps going: it is a fact for the note, not an error —
 * mixing sides is a mistake the operator can only see once they have looked.
 *
 * NOT a CI test — it talks to a running control plane, like everything else in
 * this directory. The pure half is `src/surveyor/spread.ts`, which the suite
 * covers; what lives here is the network and the exit code.
 *
 * Usage:
 *   npm run measure-executions --workspace @cartografo/runner -- \
 *     <metric> <execution_id> [execution_id ...] [--url <url>] [--token <token>]
 */

import { ControlPlaneClient } from '../src/controller/control-plane-client.ts';
import { isDenied, deniedMessage } from '../src/surveyor/command-line.ts';
import { calculateFlowMetrics } from '../src/surveyor/metrics.ts';
import { measureForExpectedMetric } from '../src/surveyor/outcome.ts';
import { MEASURE_USAGE, parseMeasureArguments, summarizeMeasurements } from '../src/surveyor/spread.ts';

const log = (message) => console.log(`[measure] ${message}`);

function die(message) {
  console.error(`\n[measure] FAILED: ${message}\n`);
  process.exit(1);
}

const parsed = parseMeasureArguments(process.argv.slice(2));
if (parsed.kind === 'usage') {
  console.error(`${parsed.message}\n\n${MEASURE_USAGE}`);
  process.exit(2);
}

const { metric, executionIds, url, token } = parsed.options;
const client = new ControlPlaneClient({
  urlBase: url,
  ...(token === undefined ? {} : { token }),
});

/** Node ids per graph version, so a side of three rounds fetches each snapshot once. */
const nodeIdsByVersion = new Map();

async function nodeIdsOf(versionId) {
  if (!nodeIdsByVersion.has(versionId)) {
    const version = await client.getGraphVersion(versionId);
    nodeIdsByVersion.set(versionId, (version.snapshot.nodes ?? []).map((no) => no.id));
  }
  return nodeIdsByVersion.get(versionId);
}

/**
 * Measures one execution, or says why it measures nothing.
 *
 * @param {number} executionId The round to read.
 * @returns {Promise<{executionId: number, versions: string[], value: number | null, why?: string}>}
 */
async function measure(executionId) {
  const byVersion = await client.metricsByVersion(executionId);
  const versions = byVersion
    .map((row) => row.graph_version_id)
    .filter((id) => typeof id === 'string' && id !== '');

  if (versions.length === 0) {
    // The same hole `proposeFlowImprovement` refuses with
    // `execution_without_version`: telemetry that cannot be joined to a graph
    // cannot be attributed to a node either.
    return { executionId, versions, value: null, why: 'no job of it declared a graph version' };
  }

  const events = await client.listExecutionEvents(executionId);
  if (events.length === 0) return { executionId, versions, value: null, why: 'it has no events' };

  // The union across versions, and not the first one: a round whose jobs
  // straddle two versions still has a ranking, and dropping the nodes of one
  // side of it would silently under-count the node the metric names.
  const nodeIds = [];
  for (const versionId of versions) {
    for (const nodeId of await nodeIdsOf(versionId)) {
      if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
    }
  }

  const value = measureForExpectedMetric(calculateFlowMetrics(events, nodeIds), metric);
  return {
    executionId,
    versions,
    value,
    ...(value === null
      ? { why: `"${metric}" names no node of the version(s) this round ran under` }
      : {}),
  };
}

try {
  log(`metric: ${metric}`);
  log(`control plane: ${url}`);

  const measured = [];
  for (const executionId of executionIds) measured.push(await measure(executionId));

  console.log('\n===== measurements =====');
  for (const row of measured) {
    const where = row.versions.length === 0 ? 'no version' : row.versions.join(', ');
    const value = row.value === null ? `nothing measured — ${row.why}` : String(row.value);
    console.log(`execution ${row.executionId} [${where}]  ${metric} = ${value}`);
  }

  const distinct = [...new Set(measured.flatMap((row) => row.versions))];
  if (distinct.length > 1) {
    console.log(
      `\nNOTE: these executions ran under ${distinct.length} different graph versions — ` +
        'a summary over two sides of a change is not a summary of either',
    );
  }

  const refused = measured.filter((row) => row.value === null);
  if (refused.length > 0) {
    console.log('========================\n');
    die(
      `${refused.length} of ${measured.length} execution(s) measured nothing ` +
        `(${refused.map((row) => row.executionId).join(', ')}). A mean folded over the rest ` +
        'would read as a measurement of all of them — refusing instead',
    );
  }

  const summary = summarizeMeasurements(measured.map((row) => row.value));
  if (summary === null) die('nothing to summarize');

  console.log('------------------------');
  console.log(`n:     ${measured.length}`);
  console.log(`mean:  ${summary.mean}`);
  console.log(`min:   ${summary.min}`);
  console.log(`max:   ${summary.max}`);
  console.log(`range: ${summary.range}`);
  console.log('========================\n');
  log('read-only: nothing was written to the control plane');
} catch (error) {
  if (isDenied(error)) die(deniedMessage(url));
  die(error instanceof Error ? `${error.message} ${JSON.stringify(error.body ?? '')}` : String(error));
}
