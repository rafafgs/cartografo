/**
 * End-to-end acceptance test of a WHOLE traversal with no operator in it
 * (t161, AT-e2e).
 *
 * This is the ficha's central claim, and the only test in the repository that
 * can make it: `POST /v1/jobs` plus a running controller is enough to cross a
 * graph. Everything is real except the engine — a real control plane as a child
 * process (the pattern of `dispatch-and-lease.e2e.test.ts`), a real
 * `ClienteControle`, a real `Controller` taking real leases, the real dispatch,
 * the real skill registry and the real graph version. The engine is the fake one
 * for the reason the conformance kit already records: CI must be deterministic
 * and must not depend on an installed, authenticated CLI
 * (`docs/formatos/engine-adapter.md`). The other half of the proof — real
 * sessions crossing a real factory graph — is the manual spike
 * (`scripts/spike-graph-traversal.mjs`).
 *
 * What the test asserts it never does is as important as what it does: it calls
 * `POST /v1/jobs/:id/transitions` ZERO times. Every movement below is the
 * dispatch's. Before this ficha the first dogfood run had an operator making
 * exactly those calls by hand
 * (`notas/2026-08-15-primeira-execucao.md`, gap #1).
 *
 * English per D18; route segments, payload keys and the fixture's node ids stay
 * in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';
import type * as DispatchModule from '../../src/dispatch/dispatch.ts';
import type * as WorktreeModule from '../../src/dispatch/session-worktree.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(PACKAGE_ROOT, 'test', 'fixtures');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this traversal's telemetry lands in. */
const EXECUTION_ID = 1610;

/** ...and the one the t259 projection traversal below lands in. */
const PROJECTION_EXECUTION_ID = 2590;

interface Work {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  completed: boolean;
}

interface Question {
  id: number;
  job_id: number;
  question: string;
  status: string;
}

interface Event {
  id: number;
  type: string;
  entity: { type: string; id: number | string };
  actor: { type: string; ref: string };
  data: Record<string, unknown>;
}

/** A session, in the three fields the projection traversal reads back. */
interface SessionRecord {
  node_id: string | null;
  prompt: string;
  output: Record<string, unknown> | null;
}

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/**
 * Every call THIS TEST makes to the control plane, as a route string.
 *
 * The ledger is the assertion: the claim of this ficha is that a traversal
 * needs no operator, and the test is standing in for the operator. A
 * `/transitions` in here would be the test crossing the graph by hand, which is
 * exactly what the first dogfood run did.
 */
const testCalls: string[] = [];

/** Talks JSON with the control plane, asserting the status on the way. */
async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  testCalls.push(`${method} ${route}`);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Reads one of the committed fixtures of this package. */
function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as Record<string, unknown>;
}

/**
 * A worktree manager that hands out one directory per acquisition.
 *
 * The real `GitWorktreeManager` needs a repository and cuts a branch per job;
 * what this traversal is about is the movement between nodes, and a plain
 * directory per session is the same isolation every other e2e in this package
 * uses.
 */
function directoryWorktrees(root: string): WorktreeModule.WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      serial += 1;
      const dir = path.join(root, `sessao-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/** The `nota` every fake `implementar` session below reports. */
const NOTA = 'escrevi saida.md com o resumo da etapa';

/**
 * The lines a fake session prints when it just works and asks nothing.
 *
 * It closes with the block its node's `output_schema` declares since t259: a
 * `work` node is TOLD to report its result that way now
 * (`render-skill-instructions.ts`), and the report is what the next node's
 * `input` projection is built out of. Before that ficha nothing in the runner
 * turned a session's own result into an object, so this constant was bare prose
 * and the node downstream had nothing to read.
 */
const QUIET = JSON.stringify([
  { stream: 'stdout', text: 'Fiz o que o nó pedia; nada a perguntar.' },
  { stream: 'stdout', text: '```resultado' },
  { stream: 'stdout', text: JSON.stringify({ nota: NOTA }) },
  { stream: 'stdout', text: '```' },
]);

/** ...and the lines a fake gate prints when it chooses an edge by name. */
function routing(result: string): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'Conferi o artefato com evidência própria.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify({ resultado: result }) },
    { stream: 'stdout', text: '```' },
  ]);
}

/**
 * ...and the lines a gate prints under the merged protocol of t259: ONE block,
 * carrying the routing label AND the object its `output_schema` declares, never
 * a routing key on its own and a second block beside it.
 */
function verdict(result: string): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'Conferi o artefato com evidência própria.' },
    { stream: 'stdout', text: '```resultado' },
    {
      stream: 'stdout',
      text: JSON.stringify({
        resultado: result,
        outcome: 'pass',
        evidencia: 'li saida.md do começo ao fim',
      }),
    },
    { stream: 'stdout', text: '```' },
  ]);
}

/** ...and the lines it prints when it needs a person before it can decide. */
const ASKS = JSON.stringify([
  { stream: 'stdout', text: 'Uma coisa não está decidida, então eu pergunto:' },
  { stream: 'stdout', text: '```input-request' },
  {
    stream: 'stdout',
    text: JSON.stringify({
      question: 'O critério de aceite 3 vale para o caminho de erro?',
      context: 'A especificação só cita o caminho feliz.',
      options: ['Vale para os dois', 'Só para o feliz'],
      recommendation: 'Vale para os dois.',
      default: 'Vale para os dois',
    }),
  },
  { stream: 'stdout', text: '```' },
]);

test('t161 — one job crosses a whole graph with zero manual transitions', async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    'src/controller/cliente-controle.ts',
  );
  const { Controller } = await loadModule<typeof ControllerModule>('src/controller/controller.ts');
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(
    'src/dispatch/dispatch.ts',
  );

  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t161-worktrees-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- the world the traversal needs, all of it through the public API -------
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-travessia-fazer.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-travessia-conferir.json'), 201);

  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
    baseUrl,
    token,
    'POST',
    '/v1/graphs',
    fixture('grafo-travessia.json'),
    201,
  );

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: 'travessia inteira sem operador no meio',
      entry_node_id: 'implementar',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t161', 'o que atravessa sozinho');

  // The fake engine is configured per DISPATCH (`envOverrides` is fixed on the
  // spec), so what a session says is decided by swapping the dispatch between
  // ticks. It is the same device the t106 acceptance test uses, and it is what
  // lets one controller loop drive a gate that reproves once and then approves.
  const worktrees = directoryWorktrees(root);
  const dispatchWith = (
    lines: string,
  ): ((jobId: number) => Promise<DispatchModule.DispatchOutcome>) =>
    createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      engines: {
        'claude-code': {
          adapter: new ClaudeCodeAdapter({
            commandBuilder: (spec) => ({
              command: process.execPath,
              args: [FAKE_ENGINE, ...buildCommand(spec).args],
            }),
            graceMs: 300,
          }),
          decodeSessionText: decodeClaudeCodeSessionText,
        },
      },
      worktrees,
      timeoutSeconds: 60,
      envOverrides: { FAKE_ENGINE_LINES: lines },
    });

  let currentLines = QUIET;
  const controller = new Controller({
    client,
    runnerId: 'runner-t161',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    dispatch: async (jobId) => dispatchWith(currentLines)(jobId),
  });

  const nodeNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`);

  // --- 1. implementar → conferir: a single-edge node moves on its own -------
  assert.ok(await controller.tick(), 'the released job was picked up');
  assert.equal((await nodeNow()).current_node_id, 'conferir');

  // --- 2. the gate asks a human: the work blocks and does NOT move ----------
  currentLines = ASKS;
  assert.ok(await controller.tick());

  let blocked = await nodeNow();
  assert.equal(blocked.current_node_id, 'conferir', 'a session that asked cannot also have routed');
  assert.equal(blocked.blocked, true);
  assert.equal(
    await controller.tick(),
    null,
    'and while it is blocked it is not a candidate for anybody',
  );

  const { input_requests: pending } = await api<{ input_requests: Question[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/input-requests?status=pending',
  );
  assert.equal(pending.length, 1, 'exactly one question is waiting on a person');

  await api(baseUrl, token, 'PATCH', `/v1/input-requests/${pending[0].id}/answer`, {
    answer: 'Vale para os dois.',
    answered_by: 'rafael',
  });

  // --- 3. the answer resumes the SAME node, and the gate reproves -----------
  blocked = await nodeNow();
  assert.equal(blocked.blocked, false, 'answering unblocked it');
  assert.equal(blocked.current_node_id, 'conferir', 'and it resumes where it stopped');

  currentLines = routing('retrabalho');
  assert.ok(await controller.tick());
  assert.equal(
    (await nodeNow()).current_node_id,
    'implementar',
    'the gate reproved, and the rework edge is a real edge like any other',
  );

  // --- 4. round two: the same two nodes, and then the final one -------------
  currentLines = QUIET;
  assert.ok(await controller.tick());
  assert.equal((await nodeNow()).current_node_id, 'conferir');

  currentLines = routing('aprovado');
  assert.ok(await controller.tick());

  const arrived = await nodeNow();
  assert.equal(arrived.current_node_id, 'publicar', 'the approved edge leads to the final node');
  assert.equal(
    arrived.completed,
    false,
    'standing on the final node is not having run it: `publicar` pins a skill (t262)',
  );

  // --- 5. and the final node is a node: it runs, like every other one -------
  // Until t262 the traversal stopped here, one step short of its own end — the
  // job was `concluido` on arrival and the controller drops a `concluido` job
  // from its candidate list, so `publicar` never got a session. Both factory
  // bundles end exactly this way (`registro-monitoramento`, `implantar`).
  currentLines = QUIET;
  assert.ok(await controller.tick(), 'the final node has to be dispatched, not skipped');

  const finished = await nodeNow();
  assert.equal(finished.current_node_id, 'publicar', 'a final node has nowhere to go');
  assert.equal(
    finished.completed,
    true,
    'and NOW the walk is over: the last node reported what its skill declares',
  );

  // --- 6. a finished work stops being a candidate ---------------------------
  const released = await client.listarTrabalhosLiberados();
  assert.deepEqual(
    released.map((candidate) => candidate.id),
    [],
    'a work that arrived may never be dispatched again — that loop is gap 3 of this ficha',
  );
  assert.equal(
    await controller.tick(),
    null,
    'so the next tick finds nothing to do, instead of re-running the last node forever',
  );

  // --- 7. and NOTHING above was moved by hand -------------------------------
  assert.deepEqual(
    testCalls.filter((call) => call.endsWith('/transitions')),
    [],
    "the test — standing in for the operator — posted no transition at all",
  );

  const { events } = await api<{ events: Event[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/executions/${EXECUTION_ID}/events`,
  );
  const moves = events.filter((event) => event.type === 'job.transitioned');
  assert.deepEqual(
    moves.map((event) => String(event.data.to_node_id)),
    ['conferir', 'implementar', 'conferir', 'publicar'],
    'the log tells the whole traversal, rework cycle and all',
  );
  assert.deepEqual(
    [...new Set(moves.map((event) => `${event.actor.type}:${event.actor.ref}`))],
    ['system:runner'],
    'and the log says who moved it: the runner, on every single edge',
  );
});

/**
 * The projection, live: what a node produced is what the next node reads
 * (t259, AT1).
 *
 * t253 built both ends of this and could join neither. The control plane stores
 * a session's structured report (`PATCH /sessions/:id/finish`) and projects it
 * into the next node's input (`GET /jobs/:id/context`); the runner shipped
 * nothing to the first route and asked nothing of the second, so
 * `resolveInput` resolved `{}` and every manifest with a placeholder blocked.
 *
 * What this test asserts is the whole chain in one traversal, with a real
 * control plane and nothing faked but the engine: the `implementar` session
 * reports `{"nota": …}`, the report reaches `/finish`, `/context` shows it at
 * `input.producao.nota` — the bucket `implementar`'s own `contract.produces`
 * names — and the prompt of the session opened for `conferir` carries the value
 * where the placeholder used to be. Each link is checked on its own, so a break
 * says WHICH one broke.
 */
test('t259 — what a node produced reaches the next node through the real projection', async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    'src/controller/cliente-controle.ts',
  );
  const { Controller } = await loadModule<typeof ControllerModule>('src/controller/controller.ts');
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(
    'src/dispatch/dispatch.ts',
  );

  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t259-worktrees-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-travessia-fazer.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-travessia-conferir.json'), 201);

  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
    baseUrl,
    token,
    'POST',
    '/v1/graphs',
    fixture('grafo-travessia.json'),
    201,
  );

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: 'a saída de um nó é a entrada do seguinte',
      entry_node_id: 'implementar',
      execution_id: PROJECTION_EXECUTION_ID,
      graph_version_id: version.id,
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t259', 'o que atravessa lendo o que ficou para trás');

  const worktrees = directoryWorktrees(root);
  let currentLines = QUIET;
  // One sidecar per node: the rendered instructions travel on the ARGV, not in
  // the session's `prompt` column — `buildCommand` puts them there, and the
  // `prompt` the control plane stores is `buildPrompt`'s envelope
  // (`session-spec.ts`). What the model was told is the argv, so that is what
  // gets read back below.
  let currentRecord = path.join(root, 'implementar.json');
  const controller = new Controller({
    client,
    runnerId: 'runner-t259',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput`: the production default is the subject of this test.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: {
          'claude-code': {
            adapter: new ClaudeCodeAdapter({
              commandBuilder: (spec) => ({
                command: process.execPath,
                args: [FAKE_ENGINE, ...buildCommand(spec).args],
              }),
              graceMs: 300,
            }),
            decodeSessionText: decodeClaudeCodeSessionText,
          },
        },
        worktrees,
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: currentLines, FAKE_ENGINE_RECORD: currentRecord },
      })(jobId),
  });

  /** Everything one fake session was told, as the process received it. */
  const toldTo = (node: string): string =>
    (JSON.parse(readFileSync(path.join(root, `${node}.json`), 'utf8')) as { argv: string[] }).argv.join(
      '\n',
    );

  // --- 1. the work node runs and its report reaches the control plane -------
  assert.ok(await controller.tick(), 'the released job was picked up');

  const afterFirst = await api<{ sessions: SessionRecord[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/sessions?job_id=${job.id}`,
  );
  assert.equal(afterFirst.sessions.length, 1);
  assert.deepEqual(
    afterFirst.sessions[0].output,
    { nota: NOTA },
    'the session\'s own ```resultado``` block is what /finish stored as `output`',
  );

  // --- 2. ...and the projection puts it in the bucket the node declares -----
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.deepEqual(
    input.producao,
    { nota: NOTA },
    '`implementar` declares contract.produces: "producao", so that is where its report lands',
  );

  // --- 3. ...and the next node's instructions carry the value, not the token -
  assert.equal((await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`)).current_node_id, 'conferir');

  currentLines = verdict('aprovado');
  currentRecord = path.join(root, 'conferir.json');
  assert.ok(await controller.tick());

  const gate = toldTo('conferir');
  assert.ok(
    gate.includes(NOTA),
    `the gate has to be told what the step before it reported, and it was told:\n${gate}`,
  );
  assert.ok(!gate.includes('{{input.'), 'and not one placeholder may survive into a prompt (t204)');

  const { sessions } = await api<{ sessions: SessionRecord[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/sessions?job_id=${job.id}`,
  );
  assert.ok(
    sessions.some((session) => session.node_id === 'conferir'),
    'the gate opened a session of its own',
  );
});
