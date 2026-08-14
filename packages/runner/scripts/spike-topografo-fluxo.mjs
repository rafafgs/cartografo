#!/usr/bin/env node
/**
 * Manual proof: a real execution, real `claude` sessions, and the first
 * surveyor proposal with evidence (t110).
 *
 * NOT a CI test, and it must not become one. The suite runs against the fake
 * engine precisely so it does not depend on an installed binary, credentials or
 * network (`docs/formatos/engine-adapter.md:363-366`); this is the manual gate
 * on the other side — the half the suite cannot prove because it has no real
 * CLI. Same division `spike-real-session.mjs` (t104) and
 * `spike-t106-human-escalation.mjs` set up: evidence attached to the ficha,
 * never an automatic gate.
 *
 * What it demonstrates, end to end, with nothing simulated:
 *
 * 1. A real control plane runs as a child process against a disposable
 *    database, and is the only writer (D1).
 * 2. A real work crosses a real graph: two `claude` sessions, dispatched by
 *    `createClaudeCodeDispatch`, one per node, each writing its own telemetry
 *    (`sessao.aberta` / `sessao.finalizada`) through the API.
 * 3. Between them the work is blocked and unblocked through the API — the
 *    operator action a human escalation would produce — so the run has real
 *    wait time on a real node.
 * 4. The surveyor reads THAT execution through `GET /v1/execucoes/:id/eventos`,
 *    computes time per node, and dispatches one more real session to choose the
 *    semantic diff.
 * 5. Exactly one proposal lands in the book, `pendente`, and its `evidencia`
 *    cites event ids that are in the log. Nothing is applied: the graph's
 *    current version pointer is checked at the end and has not moved.
 *
 * The evidence printed at the end is the control plane's own record, read back
 * from the API — not this script's opinion of what happened.
 *
 * Usage: npm run spike:topografo --workspace @cartografo/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { createClaudeCodeDispatch } from '../src/dispatch/dispatch-claude-code.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { proporMelhoriaDeFluxo } from '../src/topografo/proposta.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'packages/core/bin/cartografo.mjs');
const GRAFO_MINIMO = join(REPO_ROOT, 'schema/exemplos/grafo-valido-minimo.json');

const EXECUCAO_ID = 110;
const TIMEOUT_SECONDS = 300;
const DEADLINE_MS = 60_000;
/** How long the work stays blocked. Real seconds, so the wait is a real number. */
const BLOQUEIO_MS = 5_000;

const registrar = (mensagem) => console.log(`[spike] ${mensagem}`);

function morrer(mensagem) {
  console.error(`\n[spike] FALHOU: ${mensagem}\n`);
  process.exit(1);
}

/** Disposable git repository — the `workingDir` of the crossing. */
function criarRepoDescartavel() {
  const raiz = mkdtempSync(join(tmpdir(), 'cartografo-spike-t110-'));
  const repo = join(raiz, 'repo');
  mkdirSync(repo);
  const git = (...argumentos) =>
    execFileSync('git', argumentos, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t110');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t110\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { raiz, repo };
}

/** Boots the real control plane and returns the URL it announced. */
async function subirControlPlane() {
  if (!existsSync(BIN_PATH)) morrer(`binário do control plane não existe: ${BIN_PATH}`);

  const base = mkdtempSync(join(tmpdir(), 'cartografo-spike-t110-db-'));
  const filho = spawn(process.execPath, [BIN_PATH], {
    cwd: base,
    env: { ...process.env, CARTOGRAFO_DB_PATH: join(base, 'cartografo.db'), CARTOGRAFO_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  filho.stdout.setEncoding('utf8');
  filho.stderr.setEncoding('utf8');
  filho.stdout.on('data', (pedaco) => {
    saida += pedaco;
  });
  filho.stderr.on('data', (pedaco) => process.stderr.write(`  [server] ${pedaco}`));

  const prazo = Date.now() + DEADLINE_MS;
  while (Date.now() < prazo) {
    if (filho.exitCode !== null) morrer(`o control plane morreu (código ${filho.exitCode})`);
    const linha = saida
      .split('\n')
      .map((texto) => texto.trim())
      .find((texto) => texto.startsWith('{') && texto.includes('cartografo.pronto'));
    if (linha !== undefined) return { url: JSON.parse(linha).url, filho, base };
    await esperar(50);
  }
  morrer(`o control plane não ficou pronto em ${DEADLINE_MS}ms`);
}

/** Talks JSON with the control plane, dying on an unexpected status. */
async function api(url, metodo, rota, corpo, esperado = 200) {
  const resposta = await fetch(`${url}${rota}`, {
    method: metodo,
    headers: corpo === undefined ? undefined : { 'content-type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const texto = await resposta.text();
  if (resposta.status !== esperado) {
    morrer(`${metodo} ${rota} respondeu ${resposta.status}: ${texto}`);
  }
  return texto === '' ? undefined : JSON.parse(texto);
}

/** The instruction of each node — the stand-in for the skill the graph injects. */
function instrucoesDoNo(no, tarefa) {
  return [
    `Você é uma sessão do nó \`${no}\` de um grafo do cartografo.`,
    '',
    'Trabalhe no diretório atual, faça exatamente o que se pede e nada além disso.',
    'Não commite, não crie branch, não rode git.',
    '',
    `Tarefa do nó: ${tarefa}`,
  ].join('\n');
}

async function principal() {
  const adapter = new ClaudeCodeAdapter();
  const sonda = await adapter.verifyCli();
  registrar(`verifyCli: ${JSON.stringify(sonda)}`);
  if (!sonda.available) morrer('a CLI `claude` não respondeu a --version — instale antes da prova');

  const { url, filho } = await subirControlPlane();
  registrar(`control plane: ${url}`);

  try {
    // --- 1. o grafo vira dado -------------------------------------------------
    const documento = JSON.parse(readFileSync(GRAFO_MINIMO, 'utf8'));
    const { grafo, grafo_versao: versao } = await api(url, 'POST', '/v1/grafos', documento, 201);
    registrar(`grafo "${grafo.id}" registrado na versão ${versao.id}`);

    const { raiz, repo } = criarRepoDescartavel();
    registrar(`workingDir da travessia: ${repo}`);

    // --- 2. um trabalho de verdade, na execução 110 ---------------------------
    const trabalho = await api(
      url,
      'POST',
      '/v1/trabalhos',
      {
        titulo: 'nota curta sobre o topógrafo de fluxo',
        no_entrada_id: 'redigir',
        execucao_id: EXECUCAO_ID,
        grafo_versao_id: versao.id,
      },
      201,
    );
    registrar(`trabalho ${trabalho.id} criado no nó "${trabalho.no_atual}"`);

    const despachar = (no, tarefa) =>
      createClaudeCodeDispatch({
        urlBase: url,
        adapter,
        workingDir: repo,
        timeoutSeconds: TIMEOUT_SECONDS,
        instructions: instrucoesDoNo(no, tarefa),
      })(trabalho.id);

    registrar('sessão real #1 — nó "redigir"...');
    await despachar(
      'redigir',
      'escreva o arquivo `nota.md` com 3 a 5 linhas sobre o que é um gargalo de fluxo em um grafo de trabalho.',
    );

    // --- 3. o trabalho espera por gente (tempo de espera de verdade) ----------
    await api(url, 'POST', `/v1/trabalhos/${trabalho.id}/bloqueios`, {
      motivo: 'aguardando o operador liberar a revisão',
    });
    registrar(`trabalho bloqueado; esperando ${BLOQUEIO_MS}ms de relógio real`);
    await esperar(BLOQUEIO_MS);
    await api(url, 'POST', `/v1/trabalhos/${trabalho.id}/desbloqueios`, {});

    await api(url, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, { para_no_id: 'revisar' });
    registrar('trabalho transicionado para "revisar"');

    registrar('sessão real #2 — nó "revisar"...');
    await despachar(
      'revisar',
      'leia `nota.md` e escreva `revisao.md` com o veredito (passou/falhou) e a linha que sustenta o veredito.',
    );

    // --- 4. o topógrafo lê a execução e propõe -------------------------------
    const { raiz: raizTopografo, repo: repoTopografo } = criarRepoDescartavel();
    registrar(`workingDir do topógrafo: ${repoTopografo}`);
    registrar('sessão real #3 — o topógrafo escolhe as operações...');

    const resultado = await proporMelhoriaDeFluxo({
      cliente: new ClienteControle({ urlBase: url }),
      adapter,
      execucaoId: EXECUCAO_ID,
      workingDir: repoTopografo,
      timeoutSeconds: TIMEOUT_SECONDS,
      registrar: (mensagem) => registrar(`  ${mensagem}`),
    });

    if (resultado.gargalo === null) morrer('a execução real não produziu sinal nenhum de tempo');
    if (resultado.proposta === null) morrer('havia gargalo e nenhuma proposta foi criada');

    // --- 5. as provas duras, lidas de volta da API ---------------------------
    const { eventos } = await api(url, 'GET', `/v1/execucoes/${EXECUCAO_ID}/eventos`);
    const idsDoLog = new Set(eventos.map((evento) => evento.id));
    const { propostas } = await api(url, 'GET', '/v1/propostas');

    if (propostas.length !== 1) morrer(`o livro tem ${propostas.length} propostas; esperava 1`);
    const proposta = propostas[0];
    if (proposta.status !== 'pendente') morrer(`a proposta está "${proposta.status}"`);
    if (proposta.versao_aplicada_id !== null) morrer('alguma coisa aplicou a proposta');

    for (const id of proposta.evidencia.eventos) {
      if (!idsDoLog.has(id)) morrer(`evidencia.eventos cita o evento ${id}, ausente do log`);
    }

    const grafoDepois = await api(url, 'GET', `/v1/grafos/${grafo.id}`);
    if (grafoDepois.grafo.versao_corrente_id !== versao.id) {
      morrer('o ponteiro de versão se moveu: o topógrafo aplicou alguma coisa');
    }

    const jsonl = join(raiz, 'eventos.jsonl');
    writeFileSync(jsonl, `${eventos.map((evento) => JSON.stringify(evento)).join('\n')}\n`);

    console.log('\n===== evidência =====');
    console.log(`CLI:              ${sonda.version}`);
    console.log(`execucao_id:      ${EXECUCAO_ID}`);
    console.log(`eventos no log:   ${eventos.length}`);
    console.log(`proposta.id:      ${proposta.id}`);
    console.log(`status:           ${proposta.status}`);
    console.log(`grafo/versao:     ${proposta.grafo_id} / ${proposta.versao_alvo}`);
    console.log(`operacoes:        ${JSON.stringify(proposta.operacoes, null, 2)}`);
    console.log(`evidencia:        ${JSON.stringify(proposta.evidencia, null, 2)}`);
    console.log(`metrica_esperada: ${JSON.stringify(proposta.metrica_esperada)}`);
    console.log(`log completo:     ${jsonl}`);
    console.log(`workdirs:         ${repo} · ${repoTopografo}`);
    console.log(`(raiz do topógrafo: ${raizTopografo})`);
    console.log('=====================\n');
    registrar('prova manual OK — a proposta está pendente e nada foi aplicado');
  } finally {
    filho.kill('SIGTERM');
  }
}

await principal();
