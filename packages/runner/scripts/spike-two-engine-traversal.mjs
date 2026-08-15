#!/usr/bin/env node
/**
 * Manual proof: ONE graph, ONE work, TWO engines (t141, FR9).
 *
 * NOT a CI test, and it must not become one — the same division every other
 * spike in this repository keeps (`docs/formatos/engine-adapter.md:363-366`):
 * the suite runs against the fake engine so it never depends on an installed,
 * authenticated binary, and the manual gate is here, where the real CLIs are.
 *
 * This is the proof that makes the second adapter more than decoration. t119
 * froze the interface two adapters satisfy; until this ficha nothing in the
 * running system could put two different engines on two different steps of the
 * same graph. What it demonstrates, with nothing simulated:
 *
 * 1. A real control plane runs as a child process and is the only writer (D1).
 * 2. `schema/exemplos/grafo-valido-dois-engines.json` — the committed fixture,
 *    read from disk, not an inline copy — is registered through
 *    `POST /v1/graphs`. Its first node declares no engine; its second declares
 *    `"engine": "codex"`.
 * 3. One work crosses it, and two `Controller.tick()`s dispatch it: the first
 *    node through a real `ClaudeCodeAdapter`, the second through a real,
 *    credentialed `CodexAdapter`. The routing is the DISPATCH's, resolved from
 *    the node — this script never picks an engine.
 * 4. Both sessions actually WORKED: each produced the file its node was asked
 *    for. That is the same bar `spike-real-session-codex.mjs` names, and without
 *    it "it exited with 0" proves nothing.
 * 5. The log tells the truth about which engine ran where: for each node, the
 *    `sessao.aberta` carries the expected `engine`, and the `sessao.finalizada`
 *    of that same session says `concluida`. Both validate against the taxonomy
 *    schemas (t98).
 *
 * ## What the operator has to have ready
 *
 * Two real CLIs, both authenticated. `claude` as every other spike needs it,
 * and `codex` with two prerequisites that cost a run each to discover:
 *
 * - **The credential under the RIGHT variable name.** Of the three
 *   `CODEX_CREDENTIAL_VARIABLES` names, only `CODEX_API_KEY` actually
 *   authenticates: the same key exported as `OPENAI_API_KEY` — the obvious
 *   guess, and the one this ficha started from — dies on
 *   `401 Unauthorized ... wss://api.openai.com/v1/responses` every single turn,
 *   which is exactly the `auth mode none` t119 had already recorded for it
 *   without running a session to find out what it meant. Environment only, no
 *   `codex login` and no `auth.json` anywhere:
 *
 *   ```sh
 *   export CODEX_API_KEY="$(grep ^OPENAI_API_KEY= ~/inbox-bot/.env | cut -d= -f2-)"
 *   ```
 *
 * - **Permission to write in its own workspace.** `codex exec` defaults to a
 *   read-only sandbox, and a read-only session cannot create the file this proof
 *   asks for: it answers, politely, that the environment is read-only, exits 0,
 *   and produces nothing. `$CODEX_HOME/config.toml` needs:
 *
 *   ```toml
 *   sandbox_mode = "workspace-write"
 *   approval_policy = "never"
 *   ```
 *
 *   That file carries a setting and never a credential — pointing `CODEX_HOME`
 *   at a throwaway directory holding only this `config.toml` is how both proofs
 *   of this ficha were run.
 *
 * Neither is a knob this repository owns — `buildCommand` deliberately does not
 * pass a sandbox flag, and changing that would edit the argv of an adapter
 * already certified against C1–C7. They are properties of the operator's CLI,
 * exactly like `claude login` is for the first adapter.
 *
 * Usage: npm run spike:two-engine --workspace @cartografo/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import AjvModule from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { Controller } from '../src/controller/controller.ts';
import { createClaudeCodeDispatch, DEFAULT_ENGINE } from '../src/dispatch/dispatch-claude-code.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
} from '../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { CodexAdapter } from '../src/engine/codex-adapter.ts';
import { buildCommand as buildCodexCommand, buildEnvironment } from '../src/engine/codex-command.ts';

const Ajv2020 = AjvModule.default ?? AjvModule;
const addFormats = formatsModule.default ?? formatsModule;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'packages/core/bin/cartografo.mjs');
const GRAPH_FIXTURE = join(REPO_ROOT, 'schema/exemplos/grafo-valido-dois-engines.json');
const SCHEMAS_DIR = join(REPO_ROOT, 'especificacoes/eventos/schemas');

const EXECUTION_ID = 141;
const RUNNER_ID = 'spike-t141';
const TIMEOUT_SECONDS = 300;
const DEADLINE_MS = 60_000;

/** The real binary, when `codex` is not on the PATH under the plain name. */
const CODEX_BINARY_OVERRIDE = process.env.CODEX_BINARY_PATH?.trim();

/**
 * The two nodes of the fixture, each with the engine it must run on and the
 * file that proves it actually worked.
 *
 * `engine` here is what this script EXPECTS the dispatch to resolve — it is
 * never handed to the dispatch. The fixture is the only place the routing is
 * declared, which is the whole claim under proof.
 */
const NODES = [
  {
    id: 'redigir',
    engine: DEFAULT_ENGINE,
    file: 'nota.md',
    task:
      'escreva o arquivo `nota.md` com 3 a 5 linhas sobre o que é rotear engine por nó em um ' +
      'grafo de trabalho. Não crie nenhum outro arquivo.',
  },
  {
    id: 'conferir',
    engine: 'codex',
    file: 'parecer.md',
    task:
      'leia `nota.md` no diretório atual e escreva `parecer.md` com o veredito (passou ou falhou) ' +
      'e a linha de `nota.md` que sustenta o veredito. Não crie nenhum outro arquivo.',
  },
];

const log = (message) => console.log(`[spike] ${message}`);

function die(message) {
  console.error(`\n[spike] FAILED: ${message}\n`);
  process.exit(1);
}

/** The operator credential this proof's own control plane mints on boot. */
let operatorToken = null;

/** The only `fetch` of this script, and the one that arms the request (t146). */
function authorizedFetch(input, init) {
  const headers = new Headers(init?.headers);
  if (operatorToken !== null) headers.set('authorization', `Bearer ${operatorToken}`);
  return fetch(input, { ...init, headers });
}

/** Talks JSON with the control plane, dying on an unexpected status. */
async function api(url, method, route, body, expected = 200) {
  const response = await authorizedFetch(`${url}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expected) die(`${method} ${route} answered ${response.status}: ${text}`);
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * The Codex adapter under proof, pointed at the real binary.
 *
 * When `CODEX_BINARY_PATH` is set only the COMMAND changes — every argument
 * `buildCommand` produced goes through whole, the same discipline
 * `spike-real-session-codex.mjs` applies, and for the same reason: an override
 * that rewrote the argv would prove a different command from the one the adapter
 * actually issues.
 */
function buildCodexAdapter() {
  if (!CODEX_BINARY_OVERRIDE) return new CodexAdapter();
  return new CodexAdapter({
    commandBuilder: (spec) => ({
      command: CODEX_BINARY_OVERRIDE,
      args: buildCodexCommand(spec).args,
    }),
    environmentBuilder: (spec) => buildEnvironment(spec),
    probeCommandBuilder: () => ({ command: CODEX_BINARY_OVERRIDE, args: ['--version'] }),
  });
}

/**
 * The `WorktreeManager` this proof hands the dispatch (t160, FR10).
 *
 * A minimal fake and not the real `GitWorktreeManager`, which the ficha allows
 * explicitly — and here it is the only thing that keeps the proof proving what
 * it proves. The two nodes of this traversal hand a file from one to the other
 * (`conferir` reads the `nota.md` that `redigir` wrote), nothing commits, and
 * the evidence at the end reads both files out of that directory. A real
 * worktree per session would leave the second engine with an empty tree, and
 * the failure would be about this ficha instead of about routing.
 *
 * Isolation itself has its own proof, against real git and with no CLI in
 * sight: `test/dispatch/session-worktree.test.ts`.
 *
 * @param {string} repo The disposable repository every session runs in.
 * @returns {{acquire: (jobId: number) => Promise<{path: string, branch: string}>,
 *            release: () => Promise<void>}} The manager.
 */
function sharedWorktree(repo) {
  return {
    acquire: (jobId) => Promise.resolve({ path: repo, branch: `ticket-${jobId}` }),
    release: () => Promise.resolve(),
  };
}

/** Disposable git repository — the `workingDir` of the crossing. */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-spike-t141-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t141');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t141\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

/** Boots the real control plane, arming this process with what it announced. */
async function startControlPlane() {
  if (!existsSync(BIN_PATH)) die(`the control plane binary does not exist: ${BIN_PATH}`);

  const base = mkdtempSync(join(tmpdir(), 'cartografo-spike-t141-db-'));
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
      if (typeof ready.bootstrapToken !== 'string' || ready.bootstrapToken === '') {
        die('the control plane started without announcing a token');
      }
      operatorToken = ready.bootstrapToken;
      return { url: ready.url, child };
    }
    await delay(50);
  }
  die(`the control plane was not ready within ${DEADLINE_MS}ms`);
  return null;
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

/** Validates the taxonomy events, with ajv, against the real schemas (t98). */
function buildValidator() {
  // `allowUnionTypes` because the taxonomy uses a type union on purpose:
  // `entidade.id` is an integer for most entities and a string for
  // `grafo_versao`, whose id is the snapshot hash (D15).
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  addFormats(ajv);
  for (const name of ['envelope', 'sessao.aberta', 'sessao.finalizada']) {
    ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, `${name}.schema.json`), 'utf8')));
  }
  return (type, event) => {
    if (!ajv.validate(`${type}.schema.json`, event)) {
      die(`event ${type} does not validate:\n${ajv.errorsText(ajv.errors, { separator: '\n' })}`);
    }
  };
}

async function main() {
  const claudeAdapter = new ClaudeCodeAdapter();
  const codexAdapter = buildCodexAdapter();

  for (const [name, adapter] of [
    ['claude', claudeAdapter],
    ['codex', codexAdapter],
  ]) {
    const probe = await adapter.verifyCli();
    log(`verifyCli(${name}): ${JSON.stringify(probe)}`);
    if (!probe.available) die(`the \`${name}\` CLI did not answer --version — install it first`);
    if (!probe.authenticated) {
      log(`WARNING: ${name} authenticated=false. Best effort, not a guarantee; going ahead.`);
    }
  }

  const { root, repo } = createDisposableRepo();
  const worktrees = sharedWorktree(repo);
  const { url, child } = await startControlPlane();
  log(`control plane: ${url}`);
  log(`workingDir of the crossing: ${repo}`);

  try {
    // --- 1. the committed fixture becomes data -------------------------------
    const document = JSON.parse(readFileSync(GRAPH_FIXTURE, 'utf8'));
    const declared = Object.fromEntries(document.nos.map((no) => [no.id, no.engine ?? null]));
    log(`fixture declares: ${JSON.stringify(declared)}`);

    const { grafo: graph, grafo_versao: version } = await api(
      url,
      'POST',
      '/v1/graphs',
      document,
      201,
    );
    log(`graph "${graph.id}" registered at version ${version.id}`);

    // --- 2. one work, on the graph, at the first node -------------------------
    const client = new ClienteControle({ urlBase: url, token: operatorToken });
    await client.registrarRunner(RUNNER_ID, 'a prova manual do roteamento por nó');

    const job = await api(
      url,
      'POST',
      '/v1/jobs',
      {
        titulo: 'travessia de dois engines num grafo só',
        no_entrada_id: NODES[0].id,
        execucao_id: EXECUTION_ID,
        grafo_versao_id: version.id,
      },
      201,
    );
    log(`job ${job.id} created on node "${job.no_atual}"`);

    // Both routes are registered ONCE, and which one runs is never decided
    // here: the dispatch resolves it from the node the work is standing on.
    const engines = {
      [DEFAULT_ENGINE]: {
        adapter: claudeAdapter,
        decodeSessionText: decodeClaudeCodeSessionText,
      },
      codex: {
        adapter: codexAdapter,
        decodeSessionText: decodeCodexSessionText,
      },
    };

    let current = NODES[0];
    const controller = new Controller({
      client,
      runnerId: RUNNER_ID,
      projectId: 1,
      runnerCap: 1,
      projectCap: 2,
      ttlSeconds: TIMEOUT_SECONDS,
      dispatch: (jobId) =>
        createClaudeCodeDispatch({
          urlBase: url,
          token: operatorToken,
          engines,
          worktrees,
          timeoutSeconds: TIMEOUT_SECONDS,
          instructions: nodeInstructions(current.id, current.task),
        })(jobId),
    });

    // --- 3. two ticks, two engines -------------------------------------------
    for (const [index, node] of NODES.entries()) {
      current = node;
      if (index > 0) {
        await api(url, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: node.id });
        log(`work transitioned to "${node.id}"`);
      }

      log(`tick ${index + 1}: real session on node "${node.id}" (expecting ${node.engine})...`);
      const started = Date.now();
      const dispatched = await controller.tick();
      if (dispatched === null) die(`tick ${index + 1} dispatched nothing`);
      log(`  dispatched job ${dispatched.jobId} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }

    // --- 4. the hard proofs, read back from the control plane -----------------
    const validate = buildValidator();
    const { eventos: events } = await api(url, 'GET', `/v1/executions/${EXECUTION_ID}/events`);

    const opened = events.filter((event) => event.tipo === 'sessao.aberta');
    const finished = events.filter((event) => event.tipo === 'sessao.finalizada');
    if (opened.length !== NODES.length) {
      die(`expected ${NODES.length} sessao.aberta, found ${opened.length}`);
    }

    const evidence = [];
    for (const node of NODES) {
      // The pair, tied by the session the events are recorded against.
      const open = opened.find((event) => event.dados.no_id === node.id);
      if (open === undefined) die(`no sessao.aberta for node "${node.id}"`);
      validate('sessao.aberta', open);

      if (open.dados.engine !== node.engine) {
        die(
          `node "${node.id}" ran on engine "${open.dados.engine}" — the fixture declares ` +
            `${JSON.stringify(declared[node.id])}, so the dispatch had to resolve "${node.engine}"`,
        );
      }

      const close = finished.find((event) => event.entidade.id === open.entidade.id);
      if (close === undefined) die(`session ${open.entidade.id} ("${node.id}") never finished`);
      validate('sessao.finalizada', close);
      if (close.dados.status !== 'concluida') {
        die(`the session of node "${node.id}" ended as "${close.dados.status}"`);
      }

      // ...and the session actually WORKED. Without this the two above only
      // prove that a process started and exited.
      const produced = join(repo, node.file);
      if (!existsSync(produced)) {
        die(`node "${node.id}" did not create ${node.file} — it finished without working`);
      }
      const content = readFileSync(produced, 'utf8');
      if (content.trim() === '') die(`${node.file} exists but is empty`);

      evidence.push({
        node: node.id,
        engine: open.dados.engine,
        session: open.entidade.id,
        engineRef: open.dados.engine_session_ref,
        status: close.dados.status,
        exitCode: close.dados.exit_code,
        file: node.file,
        bytes: content.length,
      });
    }

    // Two engines, and the log has to be able to tell them apart.
    const enginesSeen = new Set(evidence.map((row) => row.engine));
    if (enginesSeen.size !== 2) {
      die(`the traversal ran on ${enginesSeen.size} distinct engine(s): ${[...enginesSeen]}`);
    }

    const jsonl = join(root, 'eventos.jsonl');
    writeFileSync(jsonl, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    console.log('\n===== evidence =====');
    console.log(`graph/version:   ${graph.id} / ${version.id}`);
    console.log(`execucao_id:     ${EXECUTION_ID}`);
    console.log(`events:          ${events.length} (full log: ${jsonl})`);
    for (const row of evidence) {
      console.log(
        `node ${row.node.padEnd(9)} engine=${row.engine.padEnd(11)} sessao=${row.session} ` +
          `status=${row.status} exit=${row.exitCode} ref=${row.engineRef} -> ${row.file} (${row.bytes}B)`,
      );
    }
    for (const node of NODES) {
      console.log(`\n--- ${node.file} ---\n${readFileSync(join(repo, node.file), 'utf8').trim()}`);
    }
    console.log(`\nworkdir:         ${repo}`);
    console.log('=====================\n');
    log('manual proof OK — one graph, one work, two engines, each recorded as itself');
  } finally {
    child.kill('SIGTERM');
  }
}

await main();
