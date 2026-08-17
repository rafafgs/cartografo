#!/usr/bin/env node
/**
 * Manual proof: a WHOLE graph crossed with nobody driving it (t161, DoD).
 *
 * NOT a CI test, and it must not become one — the same division every other
 * spike in this directory keeps (`docs/formatos/engine-adapter.md`): the suite
 * runs against the fake engine so it never depends on an installed,
 * authenticated binary, and the manual gate is here, where the real CLI is. Its
 * CI counterpart, which proves the same wiring deterministically against a
 * purpose-built three-node fixture, is
 * `test/controller/graph-traversal.e2e.test.ts`.
 *
 * What this one adds is the half a fake engine cannot give: the node's
 * instruction really is the registered manifest, a real model really reads it,
 * and the edge the traversal takes really comes from what that model wrote.
 *
 * What it demonstrates, with nothing simulated:
 *
 * 1. A real control plane runs as a child process and is the only writer (D1).
 * 2. The factory graph this repository ships — read from disk, never an inline
 *    copy — is registered through POST /v1/graphs, and so are the five skill
 *    manifests its nodes pin, each from its own committed file.
 * 3. One job is created on the entry node, and then NOTHING else is done to it.
 *    Every movement is the dispatch's: this script posts no transition, and
 *    the assertion at the end reads the actors off the log to prove it.
 * 4. A deliberate hash tamper is refused. Before the traversal starts, a
 *    doctored copy of the graph — one node's `skill_ref.hash` changed by one
 *    character — is registered as a class of its own and dispatched; the
 *    dispatch has to answer `SkillPinMismatchError` with no session opened.
 * 5. A mid-traversal escalation blocks the job, and answering it resumes the
 *    SAME node with the question and the answer already in the prompt.
 *
 * ## What the operator has to have ready
 *
 * - `claude` installed and authenticated. Every node of the factory graph runs
 *   on the default engine, so no second CLI is needed.
 * - The operator credential is NOT something to prepare: this script boots its
 *   own control plane against a throwaway database and uses the token that boot
 *   announces on its readiness line.
 * - Time and quota. Five real sessions against a real account; the job is a
 *   deliberately tiny ticket (one file, one function) so the run is minutes
 *   rather than an afternoon, but it is a real run and it costs real money.
 *
 * ## A prerequisite this script checks before spending anything
 *
 * A skill whose declared permissions the adapter cannot ENFORCE does not open a
 * session at all — `ClaudeCodeAdapter.startSession` refuses it up front (t125),
 * which is the correct behaviour and not a bug: a session that quietly enforced
 * less than what was declared is the one outcome a permission system may never
 * produce. The claude-code adapter can express "all writing or none" and "the
 * network open or closed", and nothing in between.
 *
 * At the time this ficha landed, `grafos-de-fabrica/desenvolvimento-de-software`
 * has exactly one manifest the adapter cannot honour: `testar-alpha` declares
 * `network: {allowed: true, domains: [...]}`, a per-domain allowlist that would
 * take an egress proxy. So the preflight below stops the run BEFORE the first
 * session, naming the node, the skill and the reason — instead of letting five
 * minutes of real work die on the fourth node. Whoever wants the full crossing
 * has a product decision to take first, and it is one line: either that gate
 * declares `allowed: false` (it reads a checkout and runs commands; the
 * domains it lists are loopback), or the adapter grows an egress proxy. Both
 * change a manifest's hash, which is exactly the human gate D4 wants them to
 * pass through — so neither belongs in this script.
 *
 * Usage: npm run spike:traversal --workspace @cartografo/runner
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { Controller } from '../src/controller/controller.ts';
import { createClaudeCodeDispatch, DEFAULT_ENGINE } from '../src/dispatch/dispatch.ts';
import { resolveSkillPermissions } from '../src/dispatch/render-skill-instructions.ts';
import { decodeClaudeCodeSessionText } from '../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { resolvePermissions } from '../src/engine/permission-policy.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'packages/core/bin/cartografo.mjs');

/**
 * The factory graph under proof, and the directory its manifests live in.
 *
 * `grafos-de-fabrica/desenvolvimento-de-software` and not
 * `schema/exemplos/grafo-valido-flowpilot.json`: the two are the same flowpilot
 * port, but only this one can be registered end to end. The schema example's
 * `skill_ref.id`s are namespaced (`cartografo/refinar-ticket`) and the registry's
 * ids are kebab-case with no slash (`packages/core/src/domain/manifest.ts`), so
 * its skills could never enter the registry whose pin is being checked — the
 * example is a document that validates against the graph schema, not a graph
 * anything can run.
 */
const FACTORY_DIR = join(REPO_ROOT, 'grafos-de-fabrica/desenvolvimento-de-software');
const GRAPH_PATH = join(FACTORY_DIR, 'grafo.json');
const SKILLS_DIR = join(FACTORY_DIR, 'skills');

const EXECUTION_ID = 161;
const RUNNER_ID = 'spike-t161';
const TIMEOUT_SECONDS = 1800;
const DEADLINE_MS = 60_000;

/** How many ticks the loop is allowed before it gives up on converging. */
const MAX_TICKS = 12;

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

/** Every committed manifest of the factory graph, read off disk. */
function readManifests() {
  return readdirSync(SKILLS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(SKILLS_DIR, name), 'utf8')));
}

/**
 * Refuses to spend a single session on a graph whose skills cannot be enforced.
 *
 * The check is the adapter's own policy resolution, not a copy of its rules:
 * whatever `startSession` would refuse, this refuses first — with the node and
 * the skill named, which is the difference between a diagnosis and a trace on the
 * fourth node of five.
 */
function preflightPermissions(document, manifests) {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const problems = [];

  for (const node of document.nodes) {
    const manifest = byId.get(node.skill_ref.id);
    if (manifest === undefined) {
      problems.push(`node "${node.id}" pins skill "${node.skill_ref.id}", which has no manifest on disk`);
      continue;
    }
    const { refusals } = resolvePermissions(resolveSkillPermissions(manifest.permissions));
    for (const refusal of refusals) {
      problems.push(`node "${node.id}" (skill "${manifest.id}"): ${refusal}`);
    }
  }

  if (problems.length > 0) {
    die(
      'the adapter cannot enforce what these skills declare, so their sessions would be ' +
        `refused before they opened (t125):\n  - ${problems.join('\n  - ')}\n\n` +
        '  See "A prerequisite this script checks" at the top of this file: the fix is a\n' +
        '  manifest decision that has to pass the human gate, not a flag in this script.',
    );
  }
}

/** Disposable git repository — the `workingDir` every session runs in. */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-spike-t161-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'spike@cartografo.local');
  git('config', 'user.name', 'Spike t161');
  writeFileSync(join(repo, 'README.md'), '# Repo descartável da prova manual da t161\n');
  writeFileSync(
    join(repo, 'Makefile'),
    'check:\n\t@test -s soma.js && node -e "const s=require(\'./soma.js\'); if (s(2,3)!==5) process.exit(1)"\nsmoke: check\n',
  );
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

/**
 * One tree for the whole crossing, on purpose.
 *
 * The five nodes of this graph hand work from one to the next through the
 * checkout itself — `integrar` merges what `desenvolver` committed, `testar`
 * exercises what `integrar` merged. A worktree per session would leave each node
 * looking at an empty tree, and the run would fail for a reason that has nothing
 * to do with what is under proof. Isolation has its own proof, against real git
 * and with no CLI in sight: `test/dispatch/session-worktree.test.ts`.
 */
function sharedWorktree(repo) {
  return {
    acquire: (jobId) => Promise.resolve({ path: repo, branch: `ticket-${jobId}` }),
    release: () => Promise.resolve({ kept: false }),
  };
}

/** Boots the real control plane, arming this process with what it announced. */
async function startControlPlane() {
  if (!existsSync(BIN_PATH)) die(`the control plane binary does not exist: ${BIN_PATH}`);

  const base = mkdtempSync(join(tmpdir(), 'cartografo-spike-t161-db-'));
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

async function main() {
  const adapter = new ClaudeCodeAdapter();
  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) die('the `claude` CLI did not answer --version — install it before the proof');

  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));
  const manifests = readManifests();
  log(`factory graph: ${document.nodes.length} nodes, ${manifests.length} manifests on disk`);
  preflightPermissions(document, manifests);

  const { root, repo } = createDisposableRepo();
  const { url, child } = await startControlPlane();
  log(`control plane: ${url}`);
  log(`workingDir of the crossing: ${repo}`);

  try {
    // --- 1. the registry, from the committed manifests ------------------------
    for (const manifest of manifests) {
      const registered = await api(url, 'POST', '/v1/skills', manifest, 201);
      log(`skill "${registered.id}" registered at ${registered.hash}`);
    }

    // --- 2. the graph, from the committed document ----------------------------
    const { grafo: graph, grafo_versao: version } = await api(url, 'POST', '/v1/graphs', document, 201);
    log(`graph "${graph.id}" registered at version ${version.id}`);

    const client = new ClienteControle({ urlBase: url, token: operatorToken });
    await client.registrarRunner(RUNNER_ID, 'a prova manual da travessia automática');

    const engines = {
      [DEFAULT_ENGINE]: { adapter, decodeSessionText: decodeClaudeCodeSessionText },
    };
    const worktrees = sharedWorktree(repo);
    const dispatch = createClaudeCodeDispatch({
      urlBase: url,
      token: operatorToken,
      engines,
      worktrees,
      timeoutSeconds: TIMEOUT_SECONDS,
    });

    // --- 3. the tamper, refused before anything is spent ----------------------
    //
    // A copy of the same document under a class of its own, with one node's pin
    // changed by one character. Registered and dispatched: what has to come back
    // is a refusal, and no session anywhere.
    const doctoredNodes = document.nodes.map((node) =>
      node.id === document.initial_node
        ? { ...node, skill_ref: { ...node.skill_ref, hash: `sha256:${'0'.repeat(64)}` } }
        : node,
    );
    const doctored = await api(
      url,
      'POST',
      '/v1/graphs',
      { ...document, problem_class: `${document.problem_class}-adulterado`, nodes: doctoredNodes },
      201,
    );
    const poison = await api(
      url,
      'POST',
      '/v1/jobs',
      {
        title: 'ficha cujo nó aponta para uma skill adulterada',
        entry_node_id: document.initial_node,
        execution_id: EXECUTION_ID + 1,
        graph_version_id: doctored.grafo_versao.id,
      },
      201,
    );

    let refusal = null;
    try {
      await dispatch(poison.id);
    } catch (error) {
      refusal = error;
    }
    if (refusal === null || refusal.name !== 'SkillPinMismatchError') {
      die(`a tampered pin had to refuse the dispatch; got: ${refusal === null ? 'nothing' : String(refusal)}`);
    }
    const poisonSessions = await api(url, 'GET', `/v1/sessions?execucao_id=${EXECUTION_ID + 1}`);
    if (poisonSessions.sessoes.length !== 0) {
      die(`the refusal opened ${poisonSessions.sessoes.length} session(s); it must open none`);
    }
    log(`tamper refused: ${refusal.message}`);
    await api(url, 'POST', `/v1/jobs/${poison.id}/blocks`, { reason: 'ficha envenenada, fora da fila' });

    // --- 4. the real job, and then hands off ----------------------------------
    const job = await api(
      url,
      'POST',
      '/v1/jobs',
      {
        title: 'somar dois números',
        corpo: [
          'Crie `soma.js` na raiz do repositório, exportando via CommonJS uma função',
          '`soma(a, b)` que devolve a soma dos dois argumentos.',
          '',
          'É tudo. Não crie nenhum outro arquivo, não instale nada, não configure nada.',
        ].join('\n'),
        acceptance_criteria: [
          '`soma.js` existe na raiz e exporta uma função de dois argumentos',
          '`make check` passa',
        ],
        entry_node_id: document.initial_node,
        execution_id: EXECUTION_ID,
        graph_version_id: version.id,
      },
      201,
    );
    log(`job ${job.id} created on node "${job.no_atual}" — from here on, nobody drives it`);

    const controller = new Controller({
      client,
      runnerId: RUNNER_ID,
      projectId: 1,
      runnerCap: 1,
      projectCap: 2,
      ttlSeconds: TIMEOUT_SECONDS,
      dispatch,
    });

    // --- 5. the loop: tick until it arrives, answering whatever it asks -------
    const answered = [];
    let ticks = 0;
    for (; ticks < MAX_TICKS; ticks += 1) {
      const current = await api(url, 'GET', `/v1/jobs/${job.id}`);
      if (current.concluido) {
        log(`the job arrived at "${current.no_atual}" after ${ticks} tick(s)`);
        break;
      }

      if (current.bloqueado) {
        // A question is the one thing a traversal legitimately stops for. This
        // is the operator being a HUMAN, not a driver: it answers and stands
        // back, and the next tick re-enters the same node with the answer
        // already in the prompt.
        const { perguntas: questions } = await api(url, 'GET', '/v1/input-requests?status=pendente');
        const pending = questions.find((question) => question.job_id === job.id);
        if (pending === undefined) die(`job ${job.id} is blocked with no pending question`);

        const answer = pending.default_answer ?? pending.recommendation ?? 'Siga com o caminho mais simples.';
        log(`node "${current.no_atual}" asked: ${pending.question}`);
        await api(url, 'PATCH', `/v1/input-requests/${pending.id}/answer`, {
          answer: answer,
          answered_by: 'spike-t161',
        });
        answered.push({ node: current.no_atual, question: pending.question, answer });
        continue;
      }

      log(`tick ${ticks + 1}: real session on node "${current.no_atual}"...`);
      const started = Date.now();
      const dispatched = await controller.tick();
      if (dispatched === null) die(`the tick on "${current.no_atual}" dispatched nothing`);
      log(`  done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }

    // --- 6. the hard proofs, read back from the control plane ------------------
    const arrived = await api(url, 'GET', `/v1/jobs/${job.id}`);
    if (!arrived.concluido) {
      die(`the job stopped at "${arrived.no_atual}" after ${ticks} tick(s) without arriving`);
    }

    const { eventos: events } = await api(url, 'GET', `/v1/executions/${EXECUTION_ID}/events`);
    const moves = events.filter((event) => event.type === 'job.transitioned');
    if (moves.length === 0) die('the job arrived without a single recorded movement');

    // THE claim of this ficha: every edge was taken by the runner. An operator
    // moving the job by hand would show up right here, as a different actor.
    const drivers = [...new Set(moves.map((event) => `${event.actor.tipo}:${event.actor.ref}`))];
    if (drivers.length !== 1 || drivers[0] !== 'system:runner') {
      die(`the traversal was driven by ${drivers.join(', ')} — it had to be the runner alone`);
    }

    const walked = [document.initial_node, ...moves.map((event) => event.data.to_node_id)];
    const gate = document.nodes.find((node) => node.node_type === 'gate');
    const revisits = walked.filter((id, index) => walked.indexOf(id) !== index);

    const jsonl = join(root, 'eventos.jsonl');
    writeFileSync(jsonl, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    console.log('\n===== evidence =====');
    console.log(`graph/version:      ${graph.id} / ${version.id}`);
    console.log(`execution_id:        ${EXECUTION_ID}`);
    console.log(`path walked:        ${walked.join(' -> ')}`);
    console.log(`moved by:           ${drivers[0]} (zero operator movements)`);
    console.log(`tamper refusal:     ${refusal.name} on node "${document.initial_node}", no session opened`);
    console.log(`sessions:           ${events.filter((e) => e.type === 'session.opened').length}`);
    console.log(`questions answered: ${answered.length}`);
    for (const row of answered) console.log(`  - "${row.node}" asked: ${row.question}`);
    console.log(`rework cycle:       ${revisits.length > 0 ? `yes — revisited ${[...new Set(revisits)].join(', ')}` : 'NOT exercised this run'}`);
    if (revisits.length === 0 && gate !== undefined) {
      console.log(
        `                    (the gate "${gate.id}" approved on its first pass; the cycle is\n` +
          '                     the model\'s verdict to give, not this script\'s to force —\n' +
          '                     graph-traversal.e2e.test.ts proves the edge deterministically)',
      );
    }
    console.log(`events:             ${events.length} (full log: ${jsonl})`);
    console.log(`workingDir:         ${repo}`);
    console.log('\n[spike] PASSED\n');
  } finally {
    child.kill('SIGTERM');
  }
}

await main();
