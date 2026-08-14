#!/usr/bin/env node
/**
 * The surveyor, invoked by hand after a run (t110, FR10).
 *
 * Deliberately a command a person types, not a node of the graph and not a step
 * of the controller's dispatch loop. That is the safety ladder of README
 * principle 5 and D10's "copiloto no MVP" posture: the evaluator only
 * *suggests* at first, and even the suggestion is something a human asked for.
 * Wiring it to run automatically is a later ficha, and it will be a decision,
 * not a refactor.
 *
 * What it does: reads one execution's telemetry through the public API,
 * computes time per node, and — if some node actually cost time — dispatches a
 * single real `claude` session to choose the semantic diff, then posts exactly
 * one proposal. The proposal lands `pendente` and nothing applies it.
 *
 * Exit codes are the contract, because this is what a person or a cron reads:
 *
 * - `0` — a proposal was created (its id is printed), OR the run had no signal
 *   and there was nothing to propose. Both are successful outcomes;
 * - `1` — the session failed, timed out, or returned no usable `operacoes`.
 *   Nothing was posted.
 *
 * Usage:
 *   npm run surveyor --workspace @cartografo/runner -- <execucao_id> [url] [dir]
 *
 * Defaults: url `http://127.0.0.1:4317`, dir a fresh temporary directory.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClienteControle } from '../controller/cliente-controle.ts';
import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import { SurveyorError, proposeFlowImprovement } from './proposal.ts';

const DEFAULT_URL = 'http://127.0.0.1:4317';

const log = (message) => console.log(`[surveyor] ${message}`);

function die(message, details = []) {
  console.error(`\n[surveyor] FAILED: ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  console.error('');
  process.exit(1);
}

async function main() {
  const [rawId, url = DEFAULT_URL, dir] = process.argv.slice(2);

  const executionId = Number(rawId);
  if (!Number.isInteger(executionId)) {
    die(
      'usage: npm run surveyor --workspace @cartografo/runner -- <execucao_id> [url] [dir]',
      [`execucao_id has to be an integer (got: ${JSON.stringify(rawId)})`],
    );
  }

  const workingDir = dir ?? mkdtempSync(join(tmpdir(), 'cartografo-surveyor-'));
  const client = new ClienteControle({ urlBase: url });
  const adapter = new ClaudeCodeAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die('the `claude` CLI did not answer --version — install it before running the surveyor');
  }

  log(`execution ${executionId} · control plane ${url} · workdir ${workingDir}`);

  const result = await proposeFlowImprovement({
    client,
    adapter,
    executionId,
    workingDir,
    log,
  });

  if (result.gargalo === null) {
    // Zero proposals is not a failure: a run with no measurable cost has
    // nothing to say, and inventing a proposal to look busy is exactly what
    // makes an evaluator untrustworthy.
    log('nothing to propose in this execution — exiting with 0');
    return;
  }

  console.log('\n===== proposal =====');
  console.log(`proposta.id:      ${result.proposta.id}`);
  console.log(`status:           ${result.proposta.status}`);
  console.log(`grafo:            ${result.proposta.grafo_id}`);
  console.log(`versao_alvo:      ${result.proposta.versao_alvo}`);
  console.log(`gargalo:          ${result.gargalo.no_id}`);
  console.log(`evidencia:        ${JSON.stringify(result.evidencia)}`);
  console.log(`metrica_esperada: ${JSON.stringify(result.metrica_esperada)}`);
  console.log('====================\n');
  log('the proposal is pending in the book; applying it is a human decision');
}

try {
  await main();
} catch (error) {
  if (error instanceof SurveyorError) die(error.message, error.details);
  die(error instanceof Error ? error.message : String(error));
}
