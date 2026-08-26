/**
 * Unit tests for the hypothesis verdict (t112, FR4).
 *
 * A proposal is a hypothesis, approving it is the experiment, and the next
 * round's telemetry is the outcome (`notes/2026-08-14-learning.md`). The
 * whole judgement is one pure comparison against the metric the proposal
 * declared, so it is tested here without a database, a server or a fixture:
 * `computeVerdict` never reads anything it was not handed.
 *
 * There is no tolerance band on purpose — strict `===`. A margin would be a
 * product decision about what counts as "no effect", and inventing one here
 * would bury it in a comparison operator.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as HypothesisModule from '../src/domain/hypothesis.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

let cachedHypothesis: typeof HypothesisModule | null = null;

/** Loads the module on demand so the initial red NAMES the missing artifact. */
async function loadHypothesis(): Promise<typeof HypothesisModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'domain', 'hypothesis.ts')),
    'artifact does not exist yet: packages/core/src/domain/hypothesis.ts',
  );
  cachedHypothesis ??= (await import(
    new URL('../src/domain/hypothesis.ts', import.meta.url).href
  )) as typeof HypothesisModule;
  return cachedHypothesis;
}

/** The shape the fixture of `test/rotas-propostas.test.ts` already uses. */
const FALLING = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };
const RISING = { nome: 'aprovacao_de_primeira', direcao: 'sobe', de: 0.5, para: 0.9 };

test('AT-U1 — a metric declared to fall that fell is confirmada', async () => {
  const { computeVerdict } = await loadHypothesis();

  const report = computeVerdict(FALLING, 0.2);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.verdict, 'confirmada');
});

test('AT-U2 — a metric that did not move at all is sem_efeito', async () => {
  const { computeVerdict } = await loadHypothesis();

  const report = computeVerdict(FALLING, 0.4);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.verdict, 'sem_efeito', 'no movement is not a confirmed hypothesis');
});

test('AT-U3 — a metric declared to fall that rose is piorou', async () => {
  const { computeVerdict } = await loadHypothesis();

  const report = computeVerdict(FALLING, 0.7);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.verdict, 'piorou');
});

test('AT-U4 — the "sobe" direction reads the same movement the other way round', async () => {
  const { computeVerdict } = await loadHypothesis();

  assert.equal(computeVerdict(RISING, 0.8).verdict, 'confirmada');
  assert.equal(computeVerdict(RISING, 0.5).verdict, 'sem_efeito');
  assert.equal(computeVerdict(RISING, 0.3).verdict, 'piorou');
});

test('AT-U5 — a metric without a usable "direcao" reports errors instead of throwing', async () => {
  const { computeVerdict } = await loadHypothesis();

  const missing = computeVerdict({ nome: 'retrabalho', de: 0.4, para: 0.1 }, 0.2);
  assert.equal(missing.valid, false);
  assert.equal(missing.verdict, null, 'there is no verdict to give over an incomplete hypothesis');
  assert.ok(missing.errors.length > 0, 'an invalid report has to say what is wrong');

  const unknown = computeVerdict({ ...FALLING, direcao: 'oscila' }, 0.2);
  assert.equal(unknown.valid, false);
  assert.equal(unknown.verdict, null);
  assert.ok(unknown.errors.length > 0);
});

test('AT-U6 — a metric that is not an object, or whose "de" is not a number, is invalid', async () => {
  const { computeVerdict } = await loadHypothesis();

  for (const notAMetric of [null, undefined, 'retrabalho', 42, [FALLING]]) {
    const report = computeVerdict(notAMetric, 0.2);
    assert.equal(report.valid, false, `${JSON.stringify(notAMetric)} is not a metric`);
    assert.equal(report.verdict, null);
  }

  const textualBaseline = computeVerdict({ ...FALLING, de: '0.4' }, 0.2);
  assert.equal(textualBaseline.valid, false, '"de" is the number the verdict compares against');
  assert.equal(textualBaseline.verdict, null);
});

test('t180 — the direcao problem is reported in English, quoting the frozen values', async () => {
  const { validateExpectedMetric } = await loadHypothesis();

  const problems = validateExpectedMetric({ ...FALLING, direcao: 'lado' });
  const direction = problems.find((problem) => problem.code === 'direcao_invalida');

  assert.ok(direction !== undefined, 'an unknown direcao is a problem');
  assert.equal(
    direction.message,
    'metrica_esperada.direcao has to be "sobe" or "cai", got "lado"',
    'the prose is English; "sobe"/"cai" are the stored values and are not translated (FR2)',
  );
});
