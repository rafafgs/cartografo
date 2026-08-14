#!/usr/bin/env node
/**
 * Manual proof: the whole human-escalation cycle, with the real `claude` CLI.
 *
 * NOT a CI test, and it must not become one. The suite runs against the fake
 * engine precisely so it does not depend on an installed binary, credentials or
 * network (`docs/formatos/engine-adapter.md:363-366`); this is the manual gate
 * on the other side — the half the kit cannot prove because it has no real CLI.
 * Same division t104's `spike-real-session.mjs` set up: evidence attached to
 * the ticket, never an automatic gate.
 *
 * What it demonstrates, end to end, with nothing simulated:
 *
 * 1. A real control plane runs as a child process, against a disposable
 *    database, and is the only writer (D1).
 * 2. A real `Controller` tick takes a lease and dispatches a real `claude`
 *    session through `ClaudeCodeAdapter`.
 * 3. That session hits something it may not decide alone, emits a real
 *    ```input-request block and stops. The work blocks BY ITSELF — nobody in
 *    this script posts a block.
 * 4. A human answers through the API (`PATCH /v1/input-requests/:id/answer`), and
 *    the work is unblocked and dispatchable again.
 * 5. A second tick dispatches a second real session with the SAME instructions
 *    — and this one behaves differently only because the question and its
 *    answer are in its prompt. That is the proof that "resuming" without
 *    engine-native resume actually works.
 *
 * The evidence written at the end (timeline JSONL, sessions, questions) is the
 * control plane's own record, not this script's opinion of what happened.
 *
 * Usage: npm run spike:escalation --workspace @cartografo/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { Controller } from '../src/controller/controller.ts';
import { createClaudeCodeDispatch, INSTRUCOES_PADRAO } from '../src/dispatch/dispatch-claude-code.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'packages/core/bin/cartografo.mjs');

const PHRASE = 'ciclo de escalacao humana da t106, ponta a ponta';
const CHOSEN_NAME = 'PROVA-T106.md';
const TIMEOUT_SECONDS = 300;
const DEADLINE_MS = 60_000;

/**
 * The node instruction, identical on both dispatches.
 *
 * This is the whole point of the spike: the session is never told "ask" or
 * "do it" — it is told the file name is not its call, and it decides which of
 * the two situations it is in by reading its own prompt.
 */
const INSTRUCTIONS = [
  INSTRUCOES_PADRAO,
  '',
  '## Regra deste nó',
  '',
  'Você precisa criar UM arquivo markdown no diretório atual, contendo exatamente',
  `uma linha com o texto: ${PHRASE}`,
  '',
  'O NOME do arquivo não é decisão sua.',
  '',
  '- Se o nome ainda não estiver escrito neste prompt, NÃO crie nada e NÃO chute:',
  '  pergunte qual deve ser o nome, com o bloco input-request, e pare.',
  '- Se o nome já estiver escrito neste prompt (numa pergunta já respondida),',
  '  crie o arquivo com exatamente aquele nome, escreva a linha, e não pergunte',
  '  mais nada.',
  '',
  'Não commite, não crie nenhum outro arquivo.',
].join('\n');

const log = (message) => console.log(`[spike] ${message}`);

function die(message) {
  console.error(`\n[spike] FALHOU: ${message}\n`);
  process.exit(1);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A disposable git repository — the session's `workingDir`. */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-spike-t106-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t106');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t106\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

/** Boots the real control plane and returns its URL plus a way to kill it. */
async function startControlPlane(root) {
  if (!existsSync(BIN_PATH)) die(`o control plane não existe em ${BIN_PATH}`);

  const child = spawn(process.execPath, [BIN_PATH], {
    cwd: root,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: join(root, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });

  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      die(`o control plane morreu antes de ficar pronto (código ${child.exitCode})\n${err}`);
    }
    const line = out
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) return { url: JSON.parse(line).url, stop };
    await wait(50);
  }

  stop();
  die(`o control plane não ficou pronto em ${DEADLINE_MS}ms\n${out}`);
  return null;
}

async function main() {
  const adapter = new ClaudeCodeAdapter();

  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) {
    die('a CLI `claude` não respondeu a --version — instale antes de rodar a prova');
  }
  if (!probe.authenticated) {
    log('AVISO: authenticated=false. É melhor esforço, não garantia; seguindo assim mesmo.');
  }

  const { root, repo } = createDisposableRepo();
  const plane = await startControlPlane(root);
  log(`control plane: ${plane.url}`);
  log(`workingDir:    ${repo}`);

  const api = async (method, route, body) => {
    const response = await fetch(`${plane.url}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) die(`${method} ${route} respondeu ${response.status}: ${text}`);
    return text === '' ? undefined : JSON.parse(text);
  };

  try {
    const client = new ClienteControle({ urlBase: plane.url });
    await client.registrarRunner('spike-t106', 'prova manual da escalação humana');

    const work = await api('POST', '/v1/jobs', {
      titulo: 'Criar o arquivo de prova da t106, com o nome que a pessoa escolher',
      no_entrada_id: 'implementar',
      execucao_id: 106,
    });
    log(`trabalho #${work.id} criado`);

    const dispatch = createClaudeCodeDispatch({
      urlBase: plane.url,
      adapter,
      workingDir: repo,
      timeoutSeconds: TIMEOUT_SECONDS,
      instructions: INSTRUCTIONS,
    });

    const controller = new Controller({
      cliente: client,
      runnerId: 'spike-t106',
      projetoId: 1,
      tetoRunner: 1,
      tetoProjeto: 2,
      ttlSegundos: TIMEOUT_SECONDS,
      despachar: dispatch,
    });

    // --- 1. first tick: the session should ask --------------------------------
    log('primeiro tick: despachando uma sessão real do `claude`...');
    const first = await controller.tick();
    if (first === null) die('o primeiro tick não despachou nada');
    log(`primeiro despacho: trabalho ${first.trabalhoId}, lease ${first.leaseId}`);

    const blocked = await api('GET', `/v1/jobs/${work.id}`);
    if (blocked.bloqueado !== true) {
      die('a sessão real não escalou: o trabalho continuou liberado (nenhum bloco input-request?)');
    }
    log(`trabalho bloqueado: ${blocked.motivo_bloqueio}`);

    const { perguntas: pending } = await api('GET', '/v1/input-requests?status=pendente');
    if (pending.length !== 1) die(`esperava 1 pergunta pendente, achei ${pending.length}`);
    const question = pending[0];
    log(`pergunta #${question.id}: ${question.pergunta}`);
    if (blocked.motivo_bloqueio !== `aguardando resposta da pergunta ${question.id}`) {
      die(`o motivo do bloqueio não cita a pergunta: ${blocked.motivo_bloqueio}`);
    }
    if (existsSync(join(repo, CHOSEN_NAME))) {
      die('a sessão perguntou E criou o arquivo — devia ter parado ao perguntar');
    }

    const idle = await controller.tick();
    if (idle !== null) die('um trabalho bloqueado não pode ser despachado de novo');
    log('trabalho bloqueado não é candidato de nenhum tick — confirmado');

    // --- 2. a human answers ---------------------------------------------------
    const answered = await api('PATCH', `/v1/input-requests/${question.id}/answer`, {
      resposta: `Use o nome ${CHOSEN_NAME}`,
      respondido_por: 'spike-t106',
    });
    log(`resposta registrada: ${answered.resposta} (origem ${answered.origem})`);

    const unblocked = await api('GET', `/v1/jobs/${work.id}`);
    if (unblocked.bloqueado !== false) die('responder não desbloqueou o trabalho');
    log('trabalho desbloqueado pela resposta');

    // --- 3. second tick: same instructions, different behaviour ---------------
    log('segundo tick: despachando a sessão que já sabe a resposta...');
    const second = await controller.tick();
    if (second === null) die('o trabalho respondido não voltou a ser candidato');
    log(`segundo despacho: trabalho ${second.trabalhoId}, lease ${second.leaseId}`);

    const produced = join(repo, CHOSEN_NAME);
    if (!existsSync(produced)) {
      die(`a segunda sessão não criou ${CHOSEN_NAME} — não usou a resposta que estava no prompt`);
    }
    const content = readFileSync(produced, 'utf8');
    if (!content.includes(PHRASE)) {
      die(`${CHOSEN_NAME} existe mas não tem a frase pedida:\n${content}`);
    }

    const { perguntas: allQuestions } = await api('GET', '/v1/input-requests');
    if (allQuestions.length !== 1) {
      die(`a segunda sessão perguntou de novo: ${allQuestions.length} perguntas no total`);
    }

    // --- 4. the evidence ------------------------------------------------------
    const { eventos } = await api('GET', `/v1/jobs/${work.id}/events`);
    const { sessoes } = await api('GET', '/v1/sessions?execucao_id=106');
    const types = eventos.map((event) => event.tipo);
    for (const expected of ['pergunta.criada', 'trabalho.bloqueado', 'trabalho.desbloqueado']) {
      if (!types.includes(expected)) die(`falta ${expected} na linha do tempo: ${types.join(', ')}`);
    }
    if (sessoes.length !== 2) die(`esperava 2 sessões, achei ${sessoes.length}`);
    if (!sessoes[1].prompt.includes(question.pergunta)) {
      die('o prompt da segunda sessão não carrega a pergunta anterior');
    }

    const timelinePath = join(root, 'linha-do-tempo.jsonl');
    writeFileSync(timelinePath, `${eventos.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const sessionsPath = join(root, 'sessoes.json');
    writeFileSync(sessionsPath, `${JSON.stringify(sessoes, null, 2)}\n`);
    const questionsPath = join(root, 'perguntas.json');
    writeFileSync(questionsPath, `${JSON.stringify(allQuestions, null, 2)}\n`);

    console.log('\n===== evidência =====');
    console.log(`CLI:            ${probe.version}`);
    console.log(`engineName:     ${adapter.engineName}`);
    console.log(`pergunta:       ${JSON.stringify(question.pergunta)}`);
    console.log(`contexto:       ${JSON.stringify(question.contexto)}`);
    console.log(`opções:         ${JSON.stringify(question.opcoes)}`);
    console.log(`recomendação:   ${JSON.stringify(question.recomendacao)}`);
    console.log(`resposta:       ${JSON.stringify(answered.resposta)}`);
    console.log(`eventos:        ${types.join(' -> ')}`);
    console.log(`${CHOSEN_NAME}:  ${JSON.stringify(content.trim())}`);
    console.log(`linha do tempo: ${timelinePath}`);
    console.log(`sessões:        ${sessionsPath}`);
    console.log(`perguntas:      ${questionsPath}`);
    console.log(`workdir:        ${repo}`);
    console.log('=====================\n');
    log('prova manual OK');
  } finally {
    plane.stop();
  }
}

await main();
