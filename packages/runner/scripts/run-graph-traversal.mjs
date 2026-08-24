#!/usr/bin/env node
/**
 * Manual driver: ONE work crossing a WHOLE graph, on a control plane that is
 * already running (t165, FR8).
 *
 * NOT a CI test, and it must not become one — the same division every other
 * file in this directory keeps (`docs/formatos/engine-adapter.md:363-366`): the
 * suite runs against the fake engine so it never depends on an installed,
 * authenticated binary, and the manual gate is here, where the real CLIs are.
 *
 * It generalizes `spike-two-engine-traversal.mjs` on the two axes that ficha
 * fixed and this one needs open:
 *
 * - **Any node list, not a hardcoded pair.** The nodes and the task text of
 *   each come from a JSON plan file, so the same driver walks the five nodes of
 *   `grafos-de-fabrica/desenvolvimento-de-software` or two of a fixture.
 * - **A control plane that OUTLIVES the process.** The spike boots its own
 *   against a throwaway database and deletes it on exit, which is why nothing
 *   it produced could ever feed a surveyor. This one connects to a URL the
 *   operator already has running, so the telemetry stays in the database and
 *   round 2 can be compared with round 1. It never spawns a control plane, and
 *   never touches SQLite: it is an API client like every other
 *   (`scripts/check-single-writer.mjs` is the gate on that).
 *
 * **What changed under it in `t161`.** The node's instruction now comes from the
 * registered skill, and the dispatch takes the graph's edges by itself — so this
 * driver stopped supplying either. `nos` went from being the path it FORCES to
 * the path it EXPECTS: the loop just ticks, and at the end it compares where the
 * work actually walked against what the plan said it would. A mismatch is a real
 * finding about the graph or the sessions, and it is reported rather than
 * papered over.
 *
 * One consequence worth knowing before writing a plan: a work that lands on a
 * final node is `concluido` and stops being a candidate, so the final node's own
 * session is not something the loop runs (`t152` derives the flag from the
 * position alone). A plan whose last entry is the graph's final node will end
 * with that entry unwalked, and the driver says so.
 *
 * ## What the operator has to have ready
 *
 * 1. A control plane running against the database the run should land in:
 *
 *    ```sh
 *    CARTOGRAFO_DB_PATH=.cartografo/cartografo.db npx cartografo
 *    ```
 *
 * 2. The operator token it prints on its readiness line, in `CARTOGRAFO_TOKEN`
 *    or in `--token`. The seven routes this driver calls are operator-scoped;
 *    a pairing credential answers `403` on all of them (t147).
 *
 * 3. `claude` installed and authenticated (and `codex`, if the plan routes any
 *    node to it).
 *
 * ## The plan file
 *
 * ```jsonc
 * {
 *   titulo: "the title of the job",
 *   execucao_id: 165,
 *   grafo_versao_id: "sha256:…",      // the version THIS round runs under
 *   nos: [
 *     {id: "refinar",     task: "…"},
 *     {id: "desenvolver", task: "…", engine: "codex"}
 *   ]
 * }
 * ```
 *
 * `nos` is the path through the graph the plan EXPECTS, in order — the driver
 * creates the job on the first entry and lets the dispatch take it from there.
 * A path and not the node set: a graph with a rework cycle is crossed by naming
 * the same node twice, which is what a real round does. `task` and `engine`, if
 * present, are documentation only since `t161`: the instruction comes from the
 * registered skill and the engine from the node.
 *
 * `grafo_versao_id` is the field the whole ficha turns on. `POST /v1/jobs`
 * accepts it (`packages/core/src/repositories/job.ts`), and without it the
 * telemetry cannot be joined to a version — which is exactly why the first real
 * dogfood run (`notas/2026-08-15-first-execution.md`) is unusable as surveyor
 * input: `proposeFlowImprovement` refuses it with `execution_without_version`.
 *
 * Usage:
 *   npm run traverse --workspace @cartografo/runner -- <plano.json> [url] [--token <token>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClienteControle } from '../src/controller/cliente-controle.ts';
import { Controller } from '../src/controller/controller.ts';
import { createClaudeCodeDispatch, DEFAULT_ENGINE } from '../src/dispatch/dispatch.ts';
import {
  decodeClaudeCodeSessionText,
  decodeCodexSessionText,
} from '../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { CodexAdapter } from '../src/engine/codex-adapter.ts';

const DEFAULT_URL = 'http://127.0.0.1:4317';
const ENV_TOKEN = 'CARTOGRAFO_TOKEN';
const RUNNER_ID = 'traversal-driver';
const TIMEOUT_SECONDS = 900;

const USAGE = `usage: npm run traverse --workspace @cartografo/runner -- \\
  <plano.json> [url] [--token <token>]

  plano.json    {titulo, execucao_id, grafo_versao_id, nos: [{id, task, engine?}]}
  url           control plane ALREADY RUNNING (default: ${DEFAULT_URL})
  --token       operator credential (env ${ENV_TOKEN})`;

const log = (message) => console.log(`[traverse] ${message}`);

function die(message) {
  console.error(`\n[traverse] FAILED: ${message}\n`);
  process.exit(1);
}

/**
 * Reads the command line: one positional plan, one optional url, one flag.
 *
 * @param {readonly string[]} argv Arguments after the script name.
 * @returns {{plan: string, url: string, token: string | undefined}} The run.
 */
function parseArguments(argv) {
  const positional = [];
  let flagged;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === '--token') {
      flagged = argv[index + 1];
      index += 1;
      continue;
    }
    if (current.startsWith('--token=')) {
      flagged = current.slice('--token='.length);
      continue;
    }
    if (current.startsWith('--')) die(`unknown flag ${current}\n\n${USAGE}`);
    positional.push(current);
  }

  const [plan, url] = positional;
  if (plan === undefined) die(`the plan file is required\n\n${USAGE}`);

  const token = (flagged ?? process.env[ENV_TOKEN])?.trim();
  return { plan, url: url ?? DEFAULT_URL, token: token === '' ? undefined : token };
}

/**
 * Reads and checks the plan, so a typo fails before any session opens.
 *
 * @param {string} file Path of the plan.
 * @returns {{titulo: string, execucao_id: number, grafo_versao_id: string,
 *            nos: Array<{id: string, task: string, engine?: string}>}} The plan.
 */
function readPlan(file) {
  if (!existsSync(file)) die(`the plan file does not exist: ${file}`);
  const plan = JSON.parse(readFileSync(file, 'utf8'));

  if (typeof plan.titulo !== 'string' || plan.titulo === '') die('plan.titulo is required');
  if (!Number.isInteger(plan.execucao_id)) die('plan.execucao_id has to be an integer');
  if (typeof plan.grafo_versao_id !== 'string' || !plan.grafo_versao_id.startsWith('sha256:')) {
    die('plan.grafo_versao_id has to be the id of a registered version');
  }
  if (!Array.isArray(plan.nos) || plan.nos.length === 0) die('plan.nos has to be a non-empty list');
  for (const [index, node] of plan.nos.entries()) {
    if (typeof node?.id !== 'string' || node.id === '') die(`plan.nos[${index}].id is required`);
  }
  return plan;
}

/** Talks JSON with the control plane, dying on an unexpected status. */
async function api(url, token, method, route, body, expected = 200) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status !== expected) {
    die(`${method} ${route} answered ${response.status}: ${text}`);
  }
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * The disposable repository the sessions of this crossing work in.
 *
 * A git repository because the dispatch's `WorktreeManager` contract is about
 * trees, and because a session that decides to run `git status` should not find
 * a surprise. It is created fresh per run and never the operator's checkout.
 *
 * @returns {{root: string, repo: string}} Root and repository.
 */
function createDisposableRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-traverse-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

  git('init', '--quiet');
  git('config', 'user.email', 'traverse@cartografo.local');
  git('config', 'user.name', 'Traversal driver');
  writeFileSync(join(repo, 'README.md'), '# Repositório descartável da travessia\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'inicial');
  return { root, repo };
}

/**
 * One shared tree for the whole crossing, not one per session.
 *
 * The same minimal fake `spike-two-engine-traversal.mjs` uses, and for the same
 * reason: the nodes of a real graph hand work to each other through files, and
 * a fresh worktree per session would leave every node after the first with an
 * empty tree. Isolation has its own proof against real git in
 * `test/dispatch/session-worktree.test.ts`.
 *
 * @param {string} repo The disposable repository.
 * @returns {{acquire: (jobId: number) => Promise<{path: string, branch: string}>,
 *            release: () => Promise<{kept: boolean}>}} The manager.
 */
function sharedWorktree(repo) {
  return {
    acquire: (jobId) => Promise.resolve({ path: repo, branch: `ticket-${jobId}` }),
    release: () => Promise.resolve({ kept: false }),
  };
}

async function main() {
  const { plan: planFile, url, token } = parseArguments(process.argv.slice(2));
  const plan = readPlan(planFile);

  if (token === undefined) {
    die(`no credential: export ${ENV_TOKEN} or pass --token\n\n${USAGE}`);
  }

  // The control plane is somebody else's process. Reaching it before spending a
  // single session is the difference between "it is not running" and "the third
  // node died for an unrelated reason".
  const { graph_version: version } = await api(
    url,
    token,
    'GET',
    `/v1/graph-versions/${encodeURIComponent(plan.grafo_versao_id)}`,
  );
  const known = new Set((version.snapshot.nodes ?? []).map((no) => no.id));
  for (const node of plan.nos) {
    if (!known.has(node.id)) {
      die(`node "${node.id}" is not in version ${plan.grafo_versao_id}: ${[...known].join(', ')}`);
    }
  }
  log(`version ${version.id} of graph "${version.graph_id}" — ${known.size} node(s)`);

  const claudeAdapter = new ClaudeCodeAdapter();
  const needsCodex = plan.nos.some((node) => node.engine === 'codex');
  const codexAdapter = needsCodex ? new CodexAdapter() : null;

  for (const [name, adapter] of [
    [DEFAULT_ENGINE, claudeAdapter],
    ...(codexAdapter === null ? [] : [['codex', codexAdapter]]),
  ]) {
    const probe = await adapter.verifyCli();
    log(`verifyCli(${name}): ${JSON.stringify(probe)}`);
    if (!probe.available) die(`the \`${name}\` CLI did not answer --version — install it first`);
    if (!probe.authenticated) log(`WARNING: ${name} authenticated=false; going ahead anyway`);
  }

  const { root, repo } = createDisposableRepo();
  const worktrees = sharedWorktree(repo);
  log(`workingDir of the crossing: ${repo}`);

  const client = new ClienteControle({ urlBase: url, token });
  await client.registrarRunner(RUNNER_ID, 'o motor de travessia manual da t165');

  // `Controller.tick()` dispatches the first RELEASED job it can lease, not
  // "the job this script just created" — and on a database that survives the
  // process there are older ones. The first run of this driver against a
  // second round proved it the expensive way: five real sessions of round 2
  // opened on round 1's job, which was still standing unblocked on its last
  // node, so the whole round landed in the previous execution's log and node.
  //
  // There is no server-side "this one is done" to filter on: `concluido` is
  // true from the moment a job LANDS on a final node, before that node's own
  // session ever runs, so skipping those would have skipped the last node of
  // every crossing. Closing a job for good is `t109`'s.
  //
  // So the driver refuses to start rather than guessing. Loud, and the operator
  // keeps the decision — blocking someone else's work is not this script's call.
  const released = await client.listarTrabalhosLiberados();
  if (released.length > 0) {
    die(
      `the control plane has ${released.length} released job(s) — ` +
        `${released.map((job) => `#${job.id} on "${job.current_node_id}"`).join(', ')}. ` +
        'A tick would lease one of THEM instead of this crossing. Block them ' +
        '(POST /v1/jobs/:id/blocks) or finish them first',
    );
  }

  // The job is born ON the entry node of the plan and declaring its version.
  // That declaration is the whole point: without it the round produces
  // telemetry no surveyor can read.
  const job = await api(
    url,
    token,
    'POST',
    '/v1/jobs',
    {
      title: plan.titulo,
      entry_node_id: plan.nos[0].id,
      execution_id: plan.execucao_id,
      graph_version_id: plan.grafo_versao_id,
    },
    201,
  );
  log(`job ${job.id} created on node "${job.current_node_id}" (execution ${plan.execucao_id})`);

  const engines = {
    [DEFAULT_ENGINE]: { adapter: claudeAdapter, decodeSessionText: decodeClaudeCodeSessionText },
    ...(codexAdapter === null
      ? {}
      : { codex: { adapter: codexAdapter, decodeSessionText: decodeCodexSessionText } }),
  };

  // Nothing about the crossing is decided here since t161: the instruction comes
  // from the node's registered skill, the engine from the node, and the next
  // node from the graph's edges. This driver creates the work and ticks.
  const controller = new Controller({
    client,
    runnerId: RUNNER_ID,
    projectId: 1,
    runnerCap: 1,
    projectCap: 2,
    ttlSeconds: TIMEOUT_SECONDS,
    dispatch: createClaudeCodeDispatch({
      urlBase: url,
      token,
      engines,
      worktrees,
      timeoutSeconds: TIMEOUT_SECONDS,
    }),
  });

  // One tick per session, plus slack for a rework cycle the plan did not name.
  const maxTicks = plan.nos.length * 3;
  const walked = [];
  for (let attempt = 0; attempt < maxTicks; attempt += 1) {
    const current = await api(url, token, 'GET', `/v1/jobs/${job.id}`);
    if (current.completed) {
      log(`the work arrived at "${current.current_node_id}" and is no longer a candidate`);
      break;
    }
    if (current.blocked) {
      // A question is the one thing a crossing legitimately stops for, and
      // answering it is a person's job — not this driver's.
      const { input_requests: questions } = await api(
        url,
        token,
        'GET',
        '/v1/input-requests?status=pending',
      );
      const pending = questions.filter((question) => question.job_id === job.id);
      die(
        `the work is blocked on ${pending.length} pending question(s) and needs a person: ` +
          `${pending.map((question) => `#${question.id} "${question.question}"`).join(' | ')}`,
      );
    }

    log(`session ${walked.length + 1}: real session on "${current.current_node_id}"...`);
    const started = Date.now();
    const dispatched = await controller.tick();
    if (dispatched === null) die(`the tick on "${current.current_node_id}" dispatched nothing`);
    if (dispatched.jobId !== job.id) {
      // Belt to the braces of the released-jobs check above: a job released BY
      // somebody else mid-crossing would land here, and one wrong session is
      // worth stopping for — the round's telemetry is only worth anything if
      // every session in it belongs to the same crossing.
      die(`the tick on "${current.current_node_id}" leased job ${dispatched.jobId}, not ${job.id}`);
    }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`  dispatched job ${dispatched.jobId} in ${seconds}s`);
    walked.push({ node: current.current_node_id, seconds });
  }

  const expected = plan.nos.map((node) => node.id);
  const actual = walked.map((row) => row.node);
  if (actual.join(' -> ') !== expected.join(' -> ')) {
    log(`WARNING: the plan expected ${expected.join(' -> ')}`);
    log(`         the work actually walked ${actual.join(' -> ')}`);
    log('         (a plan ending on the graph\'s final node always shows that node unwalked)');
  }

  // The crossing is over, so this job stops being a candidate for the next one.
  // Without it the driver would leave behind exactly the competitor it refuses
  // to start next to — and the reason is written down, because that is what
  // whoever finds the job blocked will want to read.
  await api(url, token, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: `travessia da execução ${plan.execucao_id} concluída`,
  });

  // The evidence is read back from the control plane, never asserted from here.
  const { events } = await api(
    url,
    token,
    'GET',
    `/v1/executions/${plan.execucao_id}/events`,
  );
  const { metrics: byVersion } = await api(
    url,
    token,
    'GET',
    `/v1/executions/${plan.execucao_id}/metrics-by-version`,
  );

  const jsonl = join(root, 'events.jsonl');
  writeFileSync(jsonl, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

  console.log('\n===== traversal =====');
  console.log(`graph/version:  ${version.graph_id} / ${version.id}`);
  console.log(`execution_id:   ${plan.execucao_id}`);
  console.log(`job:            ${job.id}`);
  console.log(`nodes walked:   ${walked.map((row) => `${row.node} (${row.seconds}s)`).join(' → ')}`);
  console.log(`events:         ${events.length} (full log: ${jsonl})`);
  console.log(`metrics-by-version: ${JSON.stringify(byVersion)}`);
  console.log(`workdir:        ${repo}`);
  console.log('=====================\n');

  const orphan = byVersion.find((row) => row.graph_version_id === null);
  if (orphan !== undefined) {
    die(`${orphan.jobs} job(s) of this execution declared no version — the surveyor refuses that`);
  }
  log('traversal OK — the whole round is joinable to a graph version');
}

await main();
