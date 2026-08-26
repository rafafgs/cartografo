#!/usr/bin/env node
/**
 * Manual proof: a real execution, real `claude` sessions, and the first
 * surveyor proposal with evidence (t110).
 *
 * NOT a CI test, and it must not become one. The suite runs against the fake
 * engine precisely so it does not depend on an installed binary, credentials or
 * network (`docs/formats/engine-adapter.md:363-366`); this is the manual gate
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
 *    (`session.opened` / `session.finished`) through the API.
 * 3. Between them the work is blocked and unblocked through the API — the
 *    operator action a human escalation would produce — so the run has real
 *    wait time on a real node.
 * 4. The surveyor reads THAT execution through `GET /v1/executions/:id/events`,
 *    computes time per node, and dispatches one more real session to choose the
 *    semantic diff.
 * 5. Exactly one proposal lands in the book, `pending`, and its `evidence`
 *    cites event ids that are in the log. Nothing is applied: the graph's
 *    current version pointer is checked at the end and has not moved.
 *
 * Every field this script reads off an answer is spelled the way `/v1` answers
 * it, in English, and `test/no-portuguese-wire.test.ts` is what keeps it that
 * way (t266). It did not, for a long time: this proof was on no sweep's list,
 * so it went on destructuring `eventos` off a body that has answered `events`
 * since t226, and the run died at the hard-proof step on a `TypeError` about
 * `undefined` — a defect nothing in CI could see, because nothing in CI runs a
 * line of this file.
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

import { ControlPlaneClient } from '../src/controller/control-plane-client.ts';
import { createClaudeCodeDispatch, DEFAULT_ENGINE } from '../src/dispatch/dispatch.ts';
import { decodeClaudeCodeSessionText } from '../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../src/engine/claude-code-adapter.ts';
import { proposeFlowImprovement } from '../src/surveyor/proposal.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN_PATH = join(REPO_ROOT, 'packages/core/bin/cartografo.mjs');
const MINIMAL_GRAPH = join(REPO_ROOT, 'schema/examples/graph-valid-minimal.json');
const FIXTURES_DIR = join(REPO_ROOT, 'packages/runner/test/fixtures');

/** The manifest each node of the minimal graph runs, by node id (t161). */
const NODE_SKILLS = { redigir: 'skill-draft-note.json', revisar: 'skill-review-note.json' };

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
 * It serves this script's own `api()` calls and nothing else: `ControlPlaneClient`
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

/**
 * The `WorktreeManager` this proof hands the dispatch (t160, FR10).
 *
 * A minimal fake and not the real `GitWorktreeManager`, which the ficha allows
 * explicitly — and here it is the only thing that keeps the proof proving what
 * it proves. The two crossing sessions are two NODES of one work: the second
 * reads the `nota.md` the first wrote, neither commits anything ("do not commit,
 * do not create a branch, do not run git" is their instruction), and the evidence
 * printed at the end is read out of that same directory after both are gone.
 * A real worktree per session would break all three on something this proof is
 * not about.
 *
 * Isolation itself has its own proof, against real git and with no `claude` in
 * sight: `test/dispatch/session-worktree.test.ts`.
 *
 * @param {string} repo The disposable repository every session runs in.
 * @returns {{acquire: (jobId: number) => Promise<{path: string, branch: string}>,
 *            release: () => Promise<{kept: boolean}>}} The manager.
 */
function sharedWorktree(repo) {
  return {
    acquire: (jobId) => Promise.resolve({ path: repo, branch: `ticket-${jobId}` }),
    release: () => Promise.resolve({ kept: false }),
  };
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
  writeFileSync(join(repo, 'README.md'), '# Disposable repo of the t110 manual proof\n');
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

async function main() {
  const adapter = new ClaudeCodeAdapter();
  const probe = await adapter.verifyCli();
  log(`verifyCli: ${JSON.stringify(probe)}`);
  if (!probe.available) die('the `claude` CLI did not answer --version — install it before the proof');

  const { url, child } = await startControlPlane();
  log(`control plane: ${url}`);

  try {
    // --- 1. the graph becomes data -------------------------------------------
    //
    // The manifests first: since t161 the dispatch resolves the node's skill and
    // refuses to open a session for one the registry does not carry, so the task
    // of each node now comes from a registered manifest instead of from this
    // script. The fixture's own `skill_ref`s are placeholders that could never be
    // registered — the registry's ids are kebab-case, with no slash — so the pins
    // are rewired here to the manifests this package ships.
    const registered = new Map();
    for (const [nodeId, file] of Object.entries(NODE_SKILLS)) {
      const skill = await api(url, 'POST', '/v1/skills', JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')), 201);
      registered.set(nodeId, skill);
      log(`skill "${skill.id}" registered at ${skill.hash}`);
    }

    const fixture = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8'));
    const document = {
      ...fixture,
      nodes: fixture.nodes.map((no) => {
        const skill = registered.get(no.id);
        if (skill === undefined) die(`the fixture grew a node this proof has no skill for: "${no.id}"`);
        return { ...no, skill_ref: { id: skill.id, version: skill.version, hash: skill.hash } };
      }),
    };
    const { graph, graph_version: version } = await api(url, 'POST', '/v1/graphs', document, 201);
    log(`graph "${graph.id}" registered at version ${version.id}`);

    const { root, repo } = createDisposableRepo();
    const worktrees = sharedWorktree(repo);
    log(`workingDir of the crossing: ${repo}`);

    // --- 2. a real work, in execution 110 -------------------------------------
    const job = await api(
      url,
      'POST',
      '/v1/jobs',
      {
        title: 'a short note about the flow topographer',
        entry_node_id: 'redigir',
        execution_id: EXECUTION_ID,
        graph_version_id: version.id,
      },
      201,
    );
    log(`job ${job.id} created on node "${job.current_node_id}"`);

    // No `instructions` here since t161: the text of each node comes from the
    // manifest registered above, resolved from the node the work is standing on.
    const dispatch = () =>
      createClaudeCodeDispatch({
        urlBase: url,
        engines: { [DEFAULT_ENGINE]: { adapter, decodeSessionText: decodeClaudeCodeSessionText } },
        worktrees,
        timeoutSeconds: TIMEOUT_SECONDS,
        token: operatorToken,
      })(job.id);

    log('real session #1 — node "redigir"...');
    await dispatch();

    // --- 3. the work waits for a person (real wait time) ----------------------
    await api(url, 'POST', `/v1/jobs/${job.id}/blocks`, {
      reason: 'waiting for the operator to release the review',
    });
    log(`work blocked; waiting ${BLOCK_MS}ms of real clock`);
    await delay(BLOCK_MS);
    await api(url, 'POST', `/v1/jobs/${job.id}/unblocks`, {});

    // No transition posted here: since t161 the first session's own dispatch
    // took the single edge leaving `redigir`. What this proof still does by hand
    // is open the SECOND session — `revisar` is the graph's final node, so the
    // work is `concluido` the moment it lands there and the controller would
    // never offer it again.
    const moved = await api(url, 'GET', `/v1/jobs/${job.id}`);
    if (moved.current_node_id !== 'revisar')
      die(`the dispatch had to advance the work to "revisar"; it is on "${moved.current_node_id}"`);
    log('the dispatch advanced the work to "revisar" with nobody asking');

    log('real session #2 — node "revisar"...');
    await dispatch();

    // --- 4. the surveyor reads the execution and proposes ---------------------
    const { root: surveyorRoot, repo: surveyorRepo } = createDisposableRepo();
    log(`workingDir of the surveyor: ${surveyorRepo}`);
    log('real session #3 — the surveyor chooses the operations...');

    const result = await proposeFlowImprovement({
      client: new ControlPlaneClient({ urlBase: url, token: operatorToken }),
      adapter,
      executionId: EXECUTION_ID,
      workingDir: surveyorRepo,
      timeoutSeconds: TIMEOUT_SECONDS,
      log: (message) => log(`  ${message}`),
    });

    if (result.gargalo === null) die('the real execution produced no time signal at all');
    if (result.proposta === null) die('there was a bottleneck and no proposal was created');

    // --- 5. the hard proofs, read back from the API ---------------------------
    const { events } = await api(url, 'GET', `/v1/executions/${EXECUTION_ID}/events`);
    const logIds = new Set(events.map((event) => event.id));
    const { proposals } = await api(url, 'GET', '/v1/proposals');

    if (proposals.length !== 1) die(`the book has ${proposals.length} proposals; expected 1`);
    const proposal = proposals[0];
    if (proposal.status !== 'pending') die(`the proposal is "${proposal.status}"`);
    if (proposal.applied_version_id !== null) die('something applied the proposal');

    for (const id of proposal.evidence.event_ids) {
      if (!logIds.has(id)) die(`evidence.event_ids cites event ${id}, absent from the log`);
    }

    const graphAfter = await api(url, 'GET', `/v1/graphs/${graph.id}`);
    if (graphAfter.graph.current_version_id !== version.id) {
      die('the version pointer moved: the surveyor applied something');
    }

    const jsonl = join(root, 'events.jsonl');
    writeFileSync(jsonl, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    console.log('\n===== evidence =====');
    console.log(`CLI:              ${probe.version}`);
    console.log(`execution_id:      ${EXECUTION_ID}`);
    console.log(`events in the log: ${events.length}`);
    console.log(`proposal.id:      ${proposal.id}`);
    console.log(`status:           ${proposal.status}`);
    console.log(`graph/version:    ${proposal.graph_id} / ${proposal.target_version}`);
    console.log(`operations:       ${JSON.stringify(proposal.operations, null, 2)}`);
    console.log(`evidence:         ${JSON.stringify(proposal.evidence, null, 2)}`);
    console.log(`expected_metric:  ${JSON.stringify(proposal.expected_metric)}`);
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
