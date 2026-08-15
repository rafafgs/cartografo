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
 * 4. The surveyor reads THAT execution through `GET /v1/executions/:id/events`,
 *    computes time per node, and dispatches one more real session to choose the
 *    semantic diff.
 * 5. Exactly one proposal lands in the book, `pendente`, and its `evidencia`
 *    cites event ids that are in the log. Nothing is applied: the graph's
 *    current version pointer is checked at the end and has not moved.
 *
 * The evidence printed at the end is the control plane's own record, read back
 * from the API — not this script's opinion of what happened.
 *
 * Every one of those calls presents a credential (t124, t146): the operator
 * token this proof's own control plane prints on its readiness line, since it
 * boots against a database that never existed before. Nothing has to be
 * exported into the environment to run it, and nothing here would work if it
 * did not — `/v1` has answered nothing anonymously since t124.
 *
 * Usage: npm run spike:surveyor --workspace @cartografo/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { createClaudeCodeDispatch } from '../src/dispatch/dispatch-claude-code.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { proposeFlowImprovement } from '../src/surveyor/proposal.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'packages/core/bin/cartografo.mjs');
const MINIMAL_GRAPH = join(REPO_ROOT, 'schema/exemplos/grafo-valido-minimo.json');

const EXECUTION_ID = 110;
const TIMEOUT_SECONDS = 300;
const DEADLINE_MS = 60_000;
/** How long the work stays blocked. Real seconds, so the wait is a real number. */
const BLOCK_MS = 5_000;

const log = (message) => console.log(`[spike] ${message}`);

function die(message) {
  console.error(`\n[spike] FAILED: ${message}\n`);
  process.exit(1);
}

/**
 * The credential of the control plane this proof boots (t124, t146).
 *
 * A module-level value and not a parameter threaded through eight calls, for
 * the reason `packages/core/src/cli/url.ts` records about its own: there is
 * exactly one control plane in this process, the token is one more thing about
 * reaching it, and setting it is the boot's job, once.
 *
 * It stays `null` only in the impossible case — this proof always boots against
 * a fresh disposable database, so its startup is always the one that mints and
 * prints the operator credential.
 */
let operatorToken = null;

/**
 * The only `fetch` of this script, and the one that arms the request.
 *
 * It serves this script's own `api()` calls and nothing else: `ClienteControle`
 * carries its own token, and since t147 so does the dispatch. Threading this
 * closure in through the dispatch's `doFetch` seam is how this proof worked
 * around a dispatcher that had no notion of a credential — the seam was never
 * the fix, and the workaround retired with the defect.
 *
 * @param {string | URL | Request} input Target of the request.
 * @param {RequestInit} [init] The rest of the request.
 * @returns {Promise<Response>} What the control plane answered.
 */
function authorizedFetch(input, init) {
  const headers = new Headers(init?.headers);
  if (operatorToken !== null) headers.set('authorization', `Bearer ${operatorToken}`);
  return fetch(input, { ...init, headers });
}

/** Disposable git repository — the `workingDir` of the crossing. */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-spike-t110-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t110');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t110\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

/** Boots the real control plane, arming this process with what it announced. */
async function startControlPlane() {
  if (!existsSync(BIN_PATH)) die(`the control plane binary does not exist: ${BIN_PATH}`);

  const base = mkdtempSync(join(tmpdir(), 'cartografo-spike-t110-db-'));
  const child = spawn(process.execPath, [BIN_PATH], {
    cwd: base,
    env: { ...process.env, CARTOGRAFO_DB_PATH: join(base, 'cartografo.db'), CARTOGRAFO_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`  [server] ${chunk}`));

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) die(`the control plane died (code ${child.exitCode})`);
    const line = out
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      const ready = JSON.parse(line);
      // The database is brand new, so this startup is the one that minted the
      // operator credential and this line is the only place it will ever be
      // legible: the table keeps a digest, and every `/v1` route wants it.
      if (typeof ready.bootstrapToken !== 'string' || ready.bootstrapToken === '') {
        die('the control plane started without announcing a token; nothing here could authenticate');
      }
      operatorToken = ready.bootstrapToken;
      return { url: ready.url, child, base };
    }
    await delay(50);
  }
  die(`the control plane was not ready within ${DEADLINE_MS}ms`);
}

/** Talks JSON with the control plane, dying on an unexpected status. */
async function api(url, method, route, body, expected = 200) {
  const response = await authorizedFetch(`${url}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expected) {
    die(`${method} ${route} answered ${response.status}: ${text}`);
  }
  return text === '' ? undefined : JSON.parse(text);
}

/** The instruction of each node — the stand-in for the skill the graph injects. */
function nodeInstructions(node, task) {
  return [
    `Você é uma sessão do nó \`${node}\` de um grafo do cartografo.`,
    '',
    'Trabalhe no diretório atual, faça exatamente o que se pede e nada além disso.',
    'Não commite, não crie branch, não rode git.',
    '',
    `Tarefa do nó: ${task}`,
  ].join('\n');
}

async function main() {
  const adapter = new ClaudeCodeAdapter();
  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) die('the `claude` CLI did not answer --version — install it before the proof');

  const { url, child } = await startControlPlane();
  log(`control plane: ${url}`);

  try {
    // --- 1. the graph becomes data -------------------------------------------
    const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8'));
    const { grafo: graph, grafo_versao: version } = await api(url, 'POST', '/v1/graphs', document, 201);
    log(`graph "${graph.id}" registered at version ${version.id}`);

    const { root, repo } = createDisposableRepo();
    log(`workingDir of the crossing: ${repo}`);

    // --- 2. a real work, in execution 110 -------------------------------------
    const job = await api(
      url,
      'POST',
      '/v1/jobs',
      {
        titulo: 'nota curta sobre o topógrafo de fluxo',
        no_entrada_id: 'redigir',
        execucao_id: EXECUTION_ID,
        grafo_versao_id: version.id,
      },
      201,
    );
    log(`job ${job.id} created on node "${job.no_atual}"`);

    const dispatch = (node, task) =>
      createClaudeCodeDispatch({
        urlBase: url,
        adapter,
        workingDir: repo,
        timeoutSeconds: TIMEOUT_SECONDS,
        instructions: nodeInstructions(node, task),
        token: operatorToken,
      })(job.id);

    log('real session #1 — node "redigir"...');
    await dispatch(
      'redigir',
      'escreva o arquivo `nota.md` com 3 a 5 linhas sobre o que é um gargalo de fluxo em um grafo de trabalho.',
    );

    // --- 3. the work waits for a person (real wait time) ----------------------
    await api(url, 'POST', `/v1/jobs/${job.id}/blocks`, {
      motivo: 'aguardando o operador liberar a revisão',
    });
    log(`work blocked; waiting ${BLOCK_MS}ms of real clock`);
    await delay(BLOCK_MS);
    await api(url, 'POST', `/v1/jobs/${job.id}/unblocks`, {});

    await api(url, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'revisar' });
    log('work transitioned to "revisar"');

    log('real session #2 — node "revisar"...');
    await dispatch(
      'revisar',
      'leia `nota.md` e escreva `revisao.md` com o veredito (passou/falhou) e a linha que sustenta o veredito.',
    );

    // --- 4. the surveyor reads the execution and proposes ---------------------
    const { root: surveyorRoot, repo: surveyorRepo } = createDisposableRepo();
    log(`workingDir of the surveyor: ${surveyorRepo}`);
    log('real session #3 — the surveyor chooses the operations...');

    const result = await proposeFlowImprovement({
      client: new ClienteControle({ urlBase: url, token: operatorToken }),
      adapter,
      executionId: EXECUTION_ID,
      workingDir: surveyorRepo,
      timeoutSeconds: TIMEOUT_SECONDS,
      log: (message) => log(`  ${message}`),
    });

    if (result.gargalo === null) die('the real execution produced no time signal at all');
    if (result.proposta === null) die('there was a bottleneck and no proposal was created');

    // --- 5. the hard proofs, read back from the API ---------------------------
    const { eventos: events } = await api(url, 'GET', `/v1/executions/${EXECUTION_ID}/events`);
    const logIds = new Set(events.map((event) => event.id));
    const { propostas: proposals } = await api(url, 'GET', '/v1/proposals');

    if (proposals.length !== 1) die(`the book has ${proposals.length} proposals; expected 1`);
    const proposal = proposals[0];
    if (proposal.status !== 'pendente') die(`the proposal is "${proposal.status}"`);
    if (proposal.versao_aplicada_id !== null) die('something applied the proposal');

    for (const id of proposal.evidencia.eventos) {
      if (!logIds.has(id)) die(`evidencia.eventos cites event ${id}, absent from the log`);
    }

    const graphAfter = await api(url, 'GET', `/v1/graphs/${graph.id}`);
    if (graphAfter.grafo.versao_corrente_id !== version.id) {
      die('the version pointer moved: the surveyor applied something');
    }

    const jsonl = join(root, 'eventos.jsonl');
    writeFileSync(jsonl, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    console.log('\n===== evidence =====');
    console.log(`CLI:              ${probe.version}`);
    console.log(`execucao_id:      ${EXECUTION_ID}`);
    console.log(`events in the log: ${events.length}`);
    console.log(`proposta.id:      ${proposal.id}`);
    console.log(`status:           ${proposal.status}`);
    console.log(`grafo/versao:     ${proposal.grafo_id} / ${proposal.versao_alvo}`);
    console.log(`operacoes:        ${JSON.stringify(proposal.operacoes, null, 2)}`);
    console.log(`evidencia:        ${JSON.stringify(proposal.evidencia, null, 2)}`);
    console.log(`metrica_esperada: ${JSON.stringify(proposal.metrica_esperada)}`);
    console.log(`full log:         ${jsonl}`);
    console.log(`workdirs:         ${repo} · ${surveyorRepo}`);
    console.log(`(surveyor root: ${surveyorRoot})`);
    console.log('=====================\n');
    log('manual proof OK — the proposal is pending and nothing was applied');
  } finally {
    child.kill('SIGTERM');
  }
}

await main();
