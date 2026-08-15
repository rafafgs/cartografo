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
 * - `1` — the session failed, timed out, returned no usable `operacoes`, or the
 *   control plane refused the credential. Nothing was posted.
 *
 * This file is wiring and nothing else: the command line — argv, the
 * environment, the credential and the messages — lives in `command-line.ts`,
 * where a test reaches it without spawning a process. What stays here is what
 * genuinely needs one: the engine, the scratch directory, stdout and the exit
 * code.
 *
 * Usage:
 *   npm run surveyor --workspace @cartografo/runner -- \
 *     <execucao_id> [url] [dir] [--token <token>]
 *
 * Defaults: url `http://127.0.0.1:4317`, dir a fresh temporary directory,
 * token the `CARTOGRAFO_TOKEN` of the environment. Every `/v1` route this
 * command touches demands one (t124), so without it the run is denied.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import {
  USAGE,
  createClient,
  deniedMessage,
  isDenied,
  parseArguments,
} from './command-line.ts';
import { SurveyorError, proposeFlowImprovement } from './proposal.ts';

const log = (message) => console.log(`[surveyor] ${message}`);

function die(message, details = []) {
  console.error(`\n[surveyor] FAILED: ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  console.error('');
  process.exit(1);
}

/** A command line that was typed wrong: the reason, and then how to type it. */
function dieWithUsage(message) {
  console.error(`\n[surveyor] FAILED: ${message}\n`);
  console.error(`${USAGE}\n`);
  process.exit(1);
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === 'usage') dieWithUsage(parsed.message);

  const { executionId, url } = parsed.options;
  const workingDir =
    parsed.options.workingDir ?? mkdtempSync(join(tmpdir(), 'cartografo-surveyor-'));
  const client = createClient(parsed.options);
  const adapter = new ClaudeCodeAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die('the `claude` CLI did not answer --version — install it before running the surveyor');
  }

  log(`execution ${executionId} · control plane ${url} · workdir ${workingDir}`);

  let result;
  try {
    result = await proposeFlowImprovement({
      client,
      adapter,
      executionId,
      workingDir,
      log,
    });
  } catch (error) {
    // A 401 is never a domain answer here: no route this command calls means
    // anything by it, and the person reading the failure has exactly one thing
    // to do about it. Saying which is the difference between a broken command
    // and a command waiting for a token.
    if (isDenied(error)) die(deniedMessage(url));
    throw error;
  }

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
