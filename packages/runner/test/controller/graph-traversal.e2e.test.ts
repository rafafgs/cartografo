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
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';
import type * as DispatchModule from '../../src/dispatch/dispatch-claude-code.ts';
import type * as WorktreeModule from '../../src/dispatch/session-worktree.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');
const FIXTURES = path.join(PACKAGE_ROOT, 'test', 'fixtures');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Deadline for anything this test waits on. Wide on purpose. */
const DEADLINE_MS = 30_000;

/** The execution this traversal's telemetry lands in. */
const EXECUTION_ID = 1610;

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Work {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  concluido: boolean;
}

interface Question {
  id: number;
  trabalho_id: number;
  pergunta: string;
  status: string;
}

interface Event {
  id: number;
  tipo: string;
  entidade: { tipo: string; id: number | string };
  ator: { tipo: string; ref: string };
  dados: Record<string, unknown>;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Boots the real control plane and hands back its address and credential. */
async function startControlPlane(t: TestHook): Promise<{ baseUrl: string; token: string }> {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t161-e2e-'));
  const child: CommandChild = spawn(process.execPath, [BIN_PATH], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(100);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before it was ready (code ${child.exitCode})\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    const line = out
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      const readiness = JSON.parse(line) as { url: string; bootstrapToken: string | null };
      assert.ok(
        readiness.bootstrapToken !== null && readiness.bootstrapToken !== '',
        'a brand-new database always mints and prints a credential',
      );
      return { baseUrl: readiness.url, token: readiness.bootstrapToken ?? '' };
    }
    await delay(50);
  }

  throw new Error(`the control plane was not ready within ${DEADLINE_MS}ms\nstdout:\n${out}`);
}

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
    release: () => Promise.resolve(),
  };
}

/** The lines a fake session prints when it just works and asks nothing. */
const QUIET = JSON.stringify([
  { stream: 'stdout', text: 'Fiz o que o nó pedia; nada a perguntar.' },
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
    'src/dispatch/dispatch-claude-code.ts',
  );

  const { baseUrl, token } = await startControlPlane(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t161-worktrees-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- the world the traversal needs, all of it through the public API -------
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-travessia-fazer.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-travessia-conferir.json'), 201);

  const { grafo_versao: version } = await api<{ grafo_versao: { id: string } }>(
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
      titulo: 'travessia inteira sem operador no meio',
      no_entrada_id: 'implementar',
      execucao_id: EXECUTION_ID,
      grafo_versao_id: version.id,
    },
    201,
  );

  // The ONE call this test is not allowed to make. Everything below goes
  // through this wrapper, so the assertion at the end is a measurement and not
  // a promise: a transition posted from here would be counted.
  const manualTransitions: string[] = [];
  const watched: typeof fetch = async (input, init) => {
    const route = String(input);
    if ((init?.method ?? 'GET') === 'POST' && route.endsWith('/transitions')) {
      manualTransitions.push(route);
    }
    return fetch(input, init);
  };

  const client = new ClienteControle({ urlBase: baseUrl, token, buscar: watched });
  await client.registrarRunner('runner-t161', 'o que atravessa sozinho');

  // The fake engine is configured per DISPATCH (`envOverrides` is fixed on the
  // spec), so what a session says is decided by swapping the dispatch between
  // ticks. It is the same device the t106 acceptance test uses, and it is what
  // lets one controller loop drive a gate that reproves once and then approves.
  const worktrees = directoryWorktrees(root);
  const dispatchWith = (lines: string): ((jobId: number) => Promise<void>) =>
    createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      doFetch: watched,
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
  assert.equal((await nodeNow()).no_atual, 'conferir');

  // --- 2. the gate asks a human: the work blocks and does NOT move ----------
  currentLines = ASKS;
  assert.ok(await controller.tick());

  let blocked = await nodeNow();
  assert.equal(blocked.no_atual, 'conferir', 'a session that asked cannot also have routed');
  assert.equal(blocked.bloqueado, true);
  assert.equal(
    await controller.tick(),
    null,
    'and while it is blocked it is not a candidate for anybody',
  );

  const { perguntas: pending } = await api<{ perguntas: Question[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/input-requests?status=pendente',
  );
  assert.equal(pending.length, 1, 'exactly one question is waiting on a person');

  await api(baseUrl, token, 'PATCH', `/v1/input-requests/${pending[0].id}/answer`, {
    resposta: 'Vale para os dois.',
    respondido_por: 'rafael',
  });

  // --- 3. the answer resumes the SAME node, and the gate reproves -----------
  blocked = await nodeNow();
  assert.equal(blocked.bloqueado, false, 'answering unblocked it');
  assert.equal(blocked.no_atual, 'conferir', 'and it resumes where it stopped');

  currentLines = routing('retrabalho');
  assert.ok(await controller.tick());
  assert.equal(
    (await nodeNow()).no_atual,
    'implementar',
    'the gate reproved, and the rework edge is a real edge like any other',
  );

  // --- 4. round two: implementar → conferir → publicar ----------------------
  currentLines = QUIET;
  assert.ok(await controller.tick());
  assert.equal((await nodeNow()).no_atual, 'conferir');

  currentLines = routing('aprovado');
  assert.ok(await controller.tick());

  const arrived = await nodeNow();
  assert.equal(arrived.no_atual, 'publicar', 'the approved edge leads to the final node');
  assert.equal(arrived.concluido, true, 'and a work standing on a final node is done');

  // --- 5. a finished work stops being a candidate ---------------------------
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

  // --- 6. and NOTHING above was moved by hand -------------------------------
  assert.deepEqual(
    manualTransitions,
    [],
    'every movement in this traversal was the dispatch\'s; the test posted no transition at all',
  );

  const { eventos: events } = await api<{ eventos: Event[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/executions/${EXECUTION_ID}/events`,
  );
  const walked = events
    .filter((event) => event.tipo === 'trabalho.transicao')
    .map((event) => String(event.dados.para_no_id));
  assert.deepEqual(
    walked,
    ['conferir', 'implementar', 'conferir', 'publicar'],
    'the log tells the whole traversal, rework cycle and all',
  );
});
