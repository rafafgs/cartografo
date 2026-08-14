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
 *   npm run topografo --workspace @cartografo/runner -- <execucao_id> [url] [dir]
 *
 * Defaults: url `http://127.0.0.1:4317`, dir a fresh temporary directory.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClienteControle } from '../controller/cliente-controle.ts';
import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import { ErroDoTopografo, proporMelhoriaDeFluxo } from './proposta.ts';

const URL_PADRAO = 'http://127.0.0.1:4317';

const registrar = (mensagem) => console.log(`[topografo] ${mensagem}`);

function morrer(mensagem, detalhes = []) {
  console.error(`\n[topografo] FALHOU: ${mensagem}`);
  for (const detalhe of detalhes) console.error(`  - ${detalhe}`);
  console.error('');
  process.exit(1);
}

async function principal() {
  const [bruto, url = URL_PADRAO, dir] = process.argv.slice(2);

  const execucaoId = Number(bruto);
  if (!Number.isInteger(execucaoId)) {
    morrer(
      'uso: npm run topografo --workspace @cartografo/runner -- <execucao_id> [url] [dir]',
      [`execucao_id precisa ser um inteiro (recebido: ${JSON.stringify(bruto)})`],
    );
  }

  const workingDir = dir ?? mkdtempSync(join(tmpdir(), 'cartografo-topografo-'));
  const cliente = new ClienteControle({ urlBase: url });
  const adapter = new ClaudeCodeAdapter();

  const sonda = await adapter.verifyCli();
  registrar(`verifyCli: ${JSON.stringify(sonda)}`);
  if (!sonda.available) {
    morrer('a CLI `claude` não respondeu a --version — instale antes de rodar o topógrafo');
  }

  registrar(`execução ${execucaoId} · control plane ${url} · workdir ${workingDir}`);

  const resultado = await proporMelhoriaDeFluxo({
    cliente,
    adapter,
    execucaoId,
    workingDir,
    registrar,
  });

  if (resultado.gargalo === null) {
    // Zero proposals is not a failure: a run with no measurable cost has
    // nothing to say, and inventing a proposal to look busy is exactly what
    // makes an evaluator untrustworthy.
    registrar('nada a propor nesta execução — saindo com 0');
    return;
  }

  console.log('\n===== proposta =====');
  console.log(`proposta.id:      ${resultado.proposta.id}`);
  console.log(`status:           ${resultado.proposta.status}`);
  console.log(`grafo:            ${resultado.proposta.grafo_id}`);
  console.log(`versao_alvo:      ${resultado.proposta.versao_alvo}`);
  console.log(`gargalo:          ${resultado.gargalo.no_id}`);
  console.log(`evidencia:        ${JSON.stringify(resultado.evidencia)}`);
  console.log(`metrica_esperada: ${JSON.stringify(resultado.metrica_esperada)}`);
  console.log('====================\n');
  registrar('a proposta está pendente no livro; aplicar é decisão humana');
}

try {
  await principal();
} catch (erro) {
  if (erro instanceof ErroDoTopografo) morrer(erro.message, erro.detalhes);
  morrer(erro instanceof Error ? erro.message : String(erro));
}
