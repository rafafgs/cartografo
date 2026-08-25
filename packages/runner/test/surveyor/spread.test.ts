/**
 * Acceptance tests for the spread of n>1 measurements (t239, FR5/FR6).
 *
 * `outcome.ts` answers "what did this ONE round measure?", and that is the
 * number the control plane closes a hypothesis with — a strict comparison with
 * no tolerance band, deliberately (`packages/core/src/domain/hypothesis.ts`:
 * "A margin would be a product decision about what counts as 'no effect', and
 * burying one in a comparison operator is how it would never get made on
 * purpose"). This module is the other half of that sentence: the product
 * decision made OUTSIDE the comparator. Three rounds of version A and three of
 * version B produce six numbers, and the only honest way to say whether the
 * change moved anything is to look at how much those numbers move on their own.
 *
 * So {@link summarizeMeasurements} reports `mean`, `min`, `max` and `range` and
 * nothing else: no verdict, no band, no p-value. The reading of the spread is
 * prose in the round's note, where a person can disagree with it — never a
 * number written to a column, where nobody could.
 *
 * It refuses the same way `measureForExpectedMetric` does. An empty list is
 * `null` and not a zeroed summary, because a `mean` of `0` over no measurement
 * reads as "the bottleneck vanished", which is the best possible result, when
 * what happened is that nobody measured anything.
 *
 * English per D18/D20, the same rule `outcome.test.ts` keeps for
 * `close-outcome`: what a person types and what a person reads are English, and
 * the last test here is that guard applied to the new command.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as SpreadModule from '../../src/surveyor/spread.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SPREAD_MODULE = 'src/surveyor/spread.ts';

let cache: typeof SpreadModule | null = null;

async function loadSpread(): Promise<typeof SpreadModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, SPREAD_MODULE)),
    `artifact does not exist yet: packages/runner/${SPREAD_MODULE}`,
  );
  cache ??= (await import(
    new URL(`../../${SPREAD_MODULE}`, import.meta.url).href
  )) as typeof SpreadModule;
  return cache;
}

test('t239 AT1 — three measurements report mean, min, max and range', async () => {
  const { summarizeMeasurements } = await loadSpread();

  const summary = summarizeMeasurements([16_406, 12_000, 20_000]);
  assert.notEqual(summary, null, 'three real numbers are three real numbers');
  assert.equal(summary?.mean, 48_406 / 3, 'the mean is the sum over the count, undivided');
  assert.equal(summary?.min, 12_000);
  assert.equal(summary?.max, 20_000);
  assert.equal(summary?.range, 8_000, 'the range is max - min: how much this side moves on its own');

  // Order is not a fact about the round: the same three crossings summarize the
  // same way whichever order the operator listed their execution ids in.
  assert.deepEqual(summarizeMeasurements([20_000, 16_406, 12_000]), summary);
});

test('t239 AT2 — one measurement is a summary with a range of zero', async () => {
  const { summarizeMeasurements } = await loadSpread();

  const summary = summarizeMeasurements([4_000]);
  assert.notEqual(summary, null, 'n=1 is a measurement, however weak a one');
  assert.equal(summary?.mean, 4_000);
  assert.equal(summary?.min, 4_000);
  assert.equal(summary?.max, 4_000);
  // Zero here is the truth and not a fabrication: one number does not move.
  // What it does NOT mean is "no noise", and that is the note's job to say.
  assert.equal(summary?.range, 0);
});

test('t239 AT3 — an empty list summarizes to null, never to a zeroed summary', async () => {
  const { summarizeMeasurements } = await loadSpread();

  assert.equal(
    summarizeMeasurements([]),
    null,
    'a mean of zero over nothing would read as the best possible result',
  );
});

test('t239 — a list carrying something that is not a finite number is null too', async () => {
  const { summarizeMeasurements } = await loadSpread();

  // The types say `number[]`, and the `.mjs` command that calls this is not
  // typechecked at its call site. A `NaN` folded into a sum poisons `mean`
  // silently, which is the one failure mode this module exists to prevent.
  assert.equal(summarizeMeasurements([16_406, Number.NaN, 12_000]), null);
  assert.equal(summarizeMeasurements([Number.POSITIVE_INFINITY]), null);
  assert.equal(summarizeMeasurements(['4000' as unknown as number]), null);
});

test('t239 AT4 — the command line of measure-executions takes one metric and a list', async () => {
  const { parseMeasureArguments } = await loadSpread();

  const run = parseMeasureArguments(['agent_ms:redigir', '11', '12', '13'], {});
  assert.ok(run.kind === 'run', `expected a run, got ${JSON.stringify(run)}`);
  assert.equal(run.options.metric, 'agent_ms:redigir');
  assert.deepEqual(run.options.executionIds, [11, 12, 13], 'in the order they were typed');
  assert.equal(run.options.url, 'http://127.0.0.1:4317');
  assert.equal(run.options.token, undefined);

  // The three refusals of the ticket, each with a message that names what is
  // missing rather than reprinting the usage and leaving it at that.
  const noExecution = parseMeasureArguments(['agent_ms:redigir'], {});
  assert.ok(noExecution.kind === 'usage');
  assert.match(noExecution.message, /at least one execution_id/);

  const notInteger = parseMeasureArguments(['agent_ms:redigir', '11', 'nao-e-numero'], {});
  assert.ok(notInteger.kind === 'usage');
  assert.match(notInteger.message, /^execution_id has to be an integer/);

  const noMetric = parseMeasureArguments([], {});
  assert.ok(noMetric.kind === 'usage');
  assert.match(noMetric.message, /^metric has to be/);

  // A metric name is shaped "<measure>:<node_id>", so a first positional that
  // is an execution id is somebody who forgot the metric — caught here, before
  // three round trips end in a refusal the operator has to decode.
  const forgotten = parseMeasureArguments(['11', '12', '13'], {});
  assert.ok(forgotten.kind === 'usage');
  assert.match(forgotten.message, /^metric has to be/);

  // The credential travels the way it does in every other command of this
  // package: `--token` first, environment second, nothing third.
  const flagged = parseMeasureArguments(['agent_ms:redigir', '11', '--token', 'from-flag'], {
    CARTOGRAFO_TOKEN: 'from-env',
  });
  assert.ok(flagged.kind === 'run');
  assert.equal(flagged.options.token, 'from-flag');

  const fromEnv = parseMeasureArguments(['agent_ms:redigir', '11'], {
    CARTOGRAFO_TOKEN: 'from-env',
  });
  assert.ok(fromEnv.kind === 'run');
  assert.equal(fromEnv.options.token, 'from-env');

  // The url is a FLAG here and not a trailing positional, which is the one
  // place this command line departs from `close-outcome`: with a variable-length
  // list of ids, a positional url would be indistinguishable from an id.
  const addressed = parseMeasureArguments(
    ['agent_ms:redigir', '11', '--url', 'http://127.0.0.1:5000'],
    {},
  );
  assert.ok(addressed.kind === 'run');
  assert.equal(addressed.options.url, 'http://127.0.0.1:5000');
  assert.deepEqual(addressed.options.executionIds, [11]);

  const unknownFlag = parseMeasureArguments(['agent_ms:redigir', '11', '--depois'], {});
  assert.ok(unknownFlag.kind === 'usage');
  assert.match(unknownFlag.message, /does not understand --depois/);
});

/**
 * t239 AT5 — what this command PRINTS is English (D18/D20 §5.1/§1).
 *
 * The mirror of the t230 test `outcome.test.ts` runs for `close-outcome`, and
 * for the same reason: this is an operational command a person types by hand,
 * so its usage and its refusals are user-facing text, not wire vocabulary.
 * `execution_id` and `metric` are what the flow lens already spells in English
 * (`docs/spec/glossario-wire.md` §5.6, `outcome.ts:MEASURES`).
 */
test('t239 AT5 — the usage and the refusals of measure-executions are in English', async () => {
  const { MEASURE_USAGE, parseMeasureArguments } = await loadSpread();

  assert.match(MEASURE_USAGE, /<metric> <execution_id>/);
  assert.match(MEASURE_USAGE, /^ {2}metric {8}/m);
  assert.match(MEASURE_USAGE, /^ {2}execution_id {2}/m);
  assert.match(MEASURE_USAGE, /^ {2}--url {8}/m);
  assert.match(MEASURE_USAGE, /^ {2}--token {6}/m);

  for (const gone of ['execucao_id', 'metrica', 'proposta_id', 'medida']) {
    assert.ok(!MEASURE_USAGE.includes(gone), `the usage still shows ${gone}`);
  }

  const refusals = [
    parseMeasureArguments([], {}),
    parseMeasureArguments(['agent_ms:redigir'], {}),
    parseMeasureArguments(['agent_ms:redigir', 'x'], {}),
    parseMeasureArguments(['agent_ms:redigir', '11', '--token'], {}),
    parseMeasureArguments(['agent_ms:redigir', '11', '--url'], {}),
  ];

  // The same detector the package-wide guard uses, applied to the text this
  // module owns: a diacritic or a Portuguese stopword in a message a person
  // reads is the thing D18 forbids. `nao-e-numero` above is quoted INPUT, which
  // is why no refusal is checked against the raw argument it echoes.
  const PORTUGUESE = /[áàâãéêíóôõúç]|\b(não|precisa|ser|para|com|uma|sem|deve)\b/i;
  for (const refusal of refusals) {
    assert.ok(refusal.kind === 'usage', `expected a refusal, got ${JSON.stringify(refusal)}`);
    assert.ok(
      !PORTUGUESE.test(refusal.message),
      `refusal is not in English: ${refusal.message}`,
    );
    assert.ok(refusal.message.length > 0);
  }

  assert.ok(!PORTUGUESE.test(MEASURE_USAGE), 'the usage is not in English');
});
