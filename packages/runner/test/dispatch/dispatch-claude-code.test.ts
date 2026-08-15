/**
 * Acceptance test for the human-escalation cycle, end to end (t106, FR8).
 *
 * This is the ticket's central claim, exercised against a REAL control plane
 * over HTTP and a real `EngineAdapter`: a dispatched session asks a question,
 * the work blocks by itself, a human answers through the API, the work is a
 * candidate again, and the next `tick()` re-dispatches a session whose prompt
 * already carries the question and the answer.
 *
 * The engine is the fake one (`test/fixtures/fake-engine.mjs`), for the reason
 * the conformance kit already records: CI must be deterministic and must not
 * depend on an installed, authenticated CLI
 * (`docs/formatos/engine-adapter.md:363-366`). The other half of the proof —
 * a real `claude` session emitting a real block — is the manual spike
 * (`scripts/spike-t106-human-escalation.mjs`), same discipline t104 used.
 *
 * The control-plane boot is the same pattern as
 * `test/controller/dispatch-and-lease.e2e.test.ts`: spawn the real binary, wait
 * for the readiness line, never `sleep` and hope. It is duplicated rather than
 * extracted because that file belongs to another ticket's surface.
 *
 * The t147 tests at the bottom boot through {@link bootControlPlane} and stop
 * there — they never call `authorizeGlobalFetch`. That is the whole point of
 * them: the shared {@link startControlPlane} patches `globalThis.fetch`, the
 * dispatcher captures the already-patched global as its `doFetch`, and every
 * test above therefore rode the harness's own token instead of exercising the
 * dispatcher's. That is how a dispatcher with no `Authorization` header at all
 * stayed green from t124 to t147.
 *
 * English per D18; this directory is post-decision code.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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

import { authorizeGlobalFetch } from '../authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const DISPATCH_MODULE = 'src/dispatch/dispatch-claude-code.ts';

/** Deadline for anything this test waits on. Wide on purpose. */
const DEADLINE_MS = 30_000;

/** The escalation the fake session emits on the first dispatch. */
const ESCALATION = {
  question: 'Renumerar a migração para 0003?',
  context: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  options: ['Renumerar para 0003', 'Manter 0002'],
  recommendation: 'Manter 0002 e renumerar só se colidir no merge.',
  default: 'Manter 0002',
};

/** What the human answers through the API. */
const ANSWER = 'Manter 0002 e renumerar só no merge';
const ANSWERED_BY = 'rafael';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Work {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  execucao_id: number | null;
}

interface Question {
  id: number;
  trabalho_id: number;
  sessao_id: number | null;
  tipo: string;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  auto_aprovavel: boolean;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
}

interface Session {
  id: number;
  trabalho_id: number | null;
  no_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  status: string;
  exit_code: number | null;
  finalizada_em: string | null;
}

interface Event {
  id: number;
  tipo: string;
  entidade: { tipo: string; id: number | string };
  ator: { tipo: string; ref: string };
  dados: Record<string, unknown>;
}

/** What the fake engine recorded about the process it was given. */
interface FakeRecord {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** The readiness line the control plane prints when it is up. */
interface Readiness {
  url: string;
  bootstrapToken: string | null;
}

/**
 * Boots the real control plane and returns its readiness line, verbatim.
 *
 * It touches no global: whoever calls it decides how the credential reaches the
 * requests. {@link startControlPlane} arms `globalThis.fetch` on top of this;
 * the t147 tests hand the token to the code under test instead, which is the
 * only way to find out whether that code presents one.
 */
async function bootControlPlane(t: TestHook): Promise<Readiness> {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t106-e2e-'));
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
      // Since t124 the API answers nothing without a credential; the control
      // plane prints the one it minted, on this very line.
      return JSON.parse(line) as Readiness;
    }
    await delay(50);
  }

  throw new Error(`the control plane was not ready within ${DEADLINE_MS}ms\nstdout:\n${out}`);
}

/**
 * Boots the control plane and makes every `fetch` of this test present its
 * token — the shape the t106 and t125 tests below were written against.
 */
async function startControlPlane(t: TestHook): Promise<string> {
  const readiness = await bootControlPlane(t);
  authorizeGlobalFetch(t, { baseUrl: readiness.url, token: readiness.bootstrapToken ?? '' });
  return readiness.url;
}

/**
 * Talks JSON with the control plane, asserting the status on the way.
 *
 * `token` is optional because the tests that boot through
 * {@link startControlPlane} have their credential armed on the global already;
 * the t147 tests leave that global alone, so they pass it in here.
 */
async function api<T>(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** The lines the fake session prints when it needs the founder. */
function linesWithBlock(): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'Li a ficha e os arquivos que ela nomeia.' },
    { stream: 'stdout', text: 'Uma coisa a ficha não resolve, então eu pergunto:' },
    { stream: 'stdout', text: '```input-request' },
    { stream: 'stdout', text: JSON.stringify(ESCALATION) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** ...and the lines it prints when it has the answer and just works. */
function linesWithoutBlock(): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'A resposta já veio no prompt; segui com ela.' },
    { stream: 'stdout', text: 'Terminei o trabalho, nada a perguntar.' },
  ]);
}

/** The engine's own answer when a tool the policy denied is attempted (t125). */
const DENIAL_TEXT = 'Claude requested permissions to use WebFetch, but you have not granted it.';

/** The frames of a session that tried a denied tool and was told no. */
function linesWithDenial(): string {
  return JSON.stringify([
    {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'assistant',
        session_id: 'cc-t125',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_t125',
              name: 'WebFetch',
              input: { url: 'https://example.com' },
            },
          ],
        },
      }),
    },
    {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'user',
        session_id: 'cc-t125',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_t125',
              is_error: true,
              content: DENIAL_TEXT,
            },
          ],
        },
      }),
    },
    { stream: 'stdout', text: 'Sem rede, segui pelo que já estava no repositório.' },
  ]);
}

/**
 * The frames of a session that was denied a tool AND ended up asking something.
 *
 * One session that touches every write route a dispatch has, which is what
 * makes the t147 green test say something about all seven of `call`'s routes
 * instead of only the five a quiet session reaches.
 */
function linesWithDenialAndBlock(): string {
  return JSON.stringify([
    ...(JSON.parse(linesWithDenial()) as unknown[]),
    ...(JSON.parse(linesWithBlock()) as unknown[]),
  ]);
}

test('t106 — question, block, answer, unblock and re-dispatch, over real HTTP', async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    'src/controller/cliente-controle.ts',
  );
  const { Controller } = await loadModule<typeof ControllerModule>('src/controller/controller.ts');
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const baseUrl = await startControlPlane(t);

  const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t106-workdir-'));
  const firstRecord = path.join(workDir, 'primeiro-despacho.json');
  const secondRecord = path.join(workDir, 'segundo-despacho.json');
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const client = new ClienteControle({ urlBase: baseUrl });
  await client.registrarRunner('runner-t106', 'o que despacha de verdade');

  const work = await api<Work>(
    baseUrl,
    'POST',
    '/v1/jobs',
    { titulo: 'ficha que escala', no_entrada_id: 'implementar', execucao_id: 7 },
    201,
  );

  // The seam the conformance kit already defines: the argv the real `claude`
  // would receive, handed whole to the fake engine. Only the binary changes.
  const adapter = new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });

  const dispatchOptions = {
    urlBase: baseUrl,
    adapter,
    workingDir: workDir,
    timeoutSeconds: 60,
  };

  // Two real dispatches, differing only in how the fake engine is configured:
  // `envOverrides` is fixed per dispatch (the `SessionSpec` has no other way to
  // reach the engine's environment), so swapping the dispatch between ticks is
  // how this test says "this time the session has nothing to ask".
  const dispatchThatAsks = createClaudeCodeDispatch({
    ...dispatchOptions,
    envOverrides: { FAKE_ENGINE_RECORD: firstRecord, FAKE_ENGINE_LINES: linesWithBlock() },
  });
  const dispatchThatFinishes = createClaudeCodeDispatch({
    ...dispatchOptions,
    envOverrides: { FAKE_ENGINE_RECORD: secondRecord, FAKE_ENGINE_LINES: linesWithoutBlock() },
  });

  let currentDispatch = dispatchThatAsks;
  const controller = new Controller({
    client,
    runnerId: 'runner-t106',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    dispatch: async (jobId) => currentDispatch(jobId),
  });

  // --- 1. the first tick dispatches, and the session asks -------------------
  const first = await controller.tick();
  assert.ok(first !== null, 'the first tick should have found and dispatched the work');
  assert.equal(first.jobId, work.id);

  const blocked = await api<Work>(baseUrl, 'GET', `/v1/jobs/${work.id}`);
  assert.equal(blocked.bloqueado, true, 'asking blocks the work, without the runner asking for it');

  const pending = await api<{ perguntas: Question[] }>(
    baseUrl,
    'GET',
    '/v1/input-requests?status=pendente',
  );
  assert.equal(pending.perguntas.length, 1);
  const question = pending.perguntas[0];
  assert.equal(
    blocked.motivo_bloqueio,
    `aguardando resposta da pergunta ${question.id}`,
    'the reason names the question that unblocks the work',
  );

  // The queue carries enough to decide without opening the repository — the
  // criterion t102 set for the question entity, now fed by a real session.
  assert.equal(question.trabalho_id, work.id);
  assert.equal(question.tipo, 'pergunta');
  assert.equal(question.pergunta, ESCALATION.question);
  assert.equal(question.contexto, ESCALATION.context);
  assert.deepEqual(question.opcoes, ESCALATION.options);
  assert.equal(question.recomendacao, ESCALATION.recommendation);
  assert.equal(question.resposta_padrao, ESCALATION.default);
  assert.equal(question.auto_aprovavel, true);
  assert.ok(question.sessao_id !== null, 'the question knows which session raised it');

  // A blocked work is nobody's candidate: the loop keeps turning and finds
  // nothing to do, which is exactly the point of the flag.
  assert.equal(await controller.tick(), null, 'a blocked work is not dispatched again');

  // --- 2. a human answers through the API -----------------------------------
  const answered = await api<Question>(
    baseUrl,
    'PATCH',
    `/v1/input-requests/${question.id}/answer`,
    { resposta: ANSWER, respondido_por: ANSWERED_BY },
  );
  assert.equal(answered.status, 'respondida');
  assert.equal(answered.origem, 'usuario');

  const unblocked = await api<Work>(baseUrl, 'GET', `/v1/jobs/${work.id}`);
  assert.equal(unblocked.bloqueado, false, 'answering returns the work to the queue');
  assert.equal(unblocked.motivo_bloqueio, null);

  // --- 3. the next tick re-dispatches, and this time the session knows ------
  currentDispatch = dispatchThatFinishes;
  const second = await controller.tick();
  assert.ok(second !== null, 'the answered work is a candidate again');
  assert.equal(second.jobId, work.id);

  const record = JSON.parse(readFileSync(secondRecord, 'utf8')) as FakeRecord;
  const prompt = record.argv[record.argv.length - 1];
  assert.ok(
    prompt.includes(ESCALATION.question),
    `the re-dispatched prompt must carry the question that was asked:\n${prompt}`,
  );
  assert.ok(
    prompt.includes(ANSWER),
    `the re-dispatched prompt must carry the answer that was given:\n${prompt}`,
  );
  // `realpathSync` because macOS hands out `/var/folders/...` temp dirs that
  // the child process reports as `/private/var/folders/...`.
  assert.equal(record.cwd, realpathSync(workDir), 'the session ran in the working dir it was given');

  const questions = await api<{ perguntas: Question[] }>(baseUrl, 'GET', '/v1/input-requests');
  assert.equal(
    questions.perguntas.length,
    1,
    'knowing the answer, the second session did not ask the same thing again',
  );

  // --- 4. and the log tells the whole story ---------------------------------
  const timeline = await api<{ eventos: Event[] }>(
    baseUrl,
    'GET',
    `/v1/jobs/${work.id}/events`,
  );
  assert.deepEqual(
    timeline.eventos.map((event) => event.tipo),
    [
      'trabalho.criado',
      'sessao.aberta',
      'pergunta.criada',
      'trabalho.bloqueado',
      'trabalho.desbloqueado',
      'sessao.aberta',
    ],
    // `sessao.finalizada` and `pergunta.respondida` are absent BY CONTRACT, not
    // by omission: their payloads carry no `trabalho_id`, so the work timeline
    // cannot see them (t102, `packages/core/src/db/events.ts`
    // `FiltroDeEventos`). They are proven below, on the projections.
    'the work timeline, in the order the log recorded it',
  );

  const created = timeline.eventos.find((event) => event.tipo === 'pergunta.criada');
  assert.deepEqual(created?.ator, { tipo: 'agente', ref: work.no_atual }, 'the agent asked');
  const blockEvent = timeline.eventos.find((event) => event.tipo === 'trabalho.bloqueado');
  assert.equal(blockEvent?.ator.tipo, 'sistema', 'the flag was raised by the wiring');
  const unblockEvent = timeline.eventos.find((event) => event.tipo === 'trabalho.desbloqueado');
  assert.equal(unblockEvent?.ator.tipo, 'usuario', 'the flag was lowered by the human who answered');

  const sessions = await api<{ sessoes: Session[] }>(baseUrl, 'GET', '/v1/sessions?execucao_id=7');
  assert.equal(sessions.sessoes.length, 2, 'two sessions: the one that asked and the one that knew');
  for (const session of sessions.sessoes) {
    assert.equal(session.trabalho_id, work.id);
    assert.equal(session.no_id, work.no_atual);
    assert.equal(session.engine, 'claude-code');
    assert.equal(session.working_dir, workDir);
    assert.equal(session.status, 'concluida', 'the taxonomy vocabulary, not the interface one');
    assert.equal(session.exit_code, 0);
    assert.ok(session.finalizada_em !== null);
  }
  assert.ok(
    sessions.sessoes[1].prompt.includes(ANSWER),
    'the persisted prompt of the second session carries the answer, for the audit trail',
  );
});

test('t125 — a denied tool becomes one permission-denial call, and does not fail the dispatch', async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    'src/controller/cliente-controle.ts',
  );
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const baseUrl = await startControlPlane(t);

  const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t125-workdir-'));
  const record = path.join(workDir, 'despacho-com-negacao.json');
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const client = new ClienteControle({ urlBase: baseUrl });
  await client.registrarRunner('runner-t125', 'o que despacha com política de permissão');

  const work = await api<Work>(
    baseUrl,
    'POST',
    '/v1/jobs',
    { titulo: 'ficha com skill de terceiro', no_entrada_id: 'implementar', execucao_id: 9 },
    201,
  );

  // A spy in front of the real `fetch`: the claim is "exactly one call, with
  // this body", and the control plane on the other side is real — so the same
  // test proves the route accepts what the runner sends.
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? 'GET',
      route: String(input).slice(baseUrl.length),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return fetch(input, init);
  };

  const adapter = new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });

  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    adapter,
    workingDir: workDir,
    timeoutSeconds: 60,
    doFetch,
    permissions: { filesystem: { write: ['**'] }, network: { allowed: false } },
    envOverrides: { FAKE_ENGINE_RECORD: record, FAKE_ENGINE_LINES: linesWithDenial() },
  });

  // Asking is not failing, and neither is being denied: the dispatch of a
  // session that tried a closed door resolves normally.
  await dispatch(work.id);

  const sessions = await api<{ sessoes: Session[] }>(baseUrl, 'GET', '/v1/sessions?execucao_id=9');
  assert.equal(sessions.sessoes.length, 1);
  const session = sessions.sessoes[0];
  assert.equal(session.status, 'concluida', 'a denial is an incident, never a terminal status');

  const denials = calls.filter((call) => call.route.endsWith('/permission-denials'));
  assert.equal(denials.length, 1, `expected exactly one denial call, got ${denials.length}`);
  assert.equal(denials[0].method, 'POST');
  assert.equal(denials[0].route, `/v1/sessions/${session.id}/permission-denials`);
  assert.deepEqual(denials[0].body, {
    recurso: 'rede',
    ferramenta: 'WebFetch',
    motivo: DENIAL_TEXT,
    ator: { tipo: 'sistema', ref: 'runner' },
  });

  // ...and the policy really reached the engine process, by the only channel
  // that counts: the argv (case C2's discipline).
  const received = JSON.parse(readFileSync(record, 'utf8')) as FakeRecord;
  assert.ok(received.argv.includes('--disallowedTools'));
  assert.ok(received.argv.includes('WebFetch'));
});

/** The fake engine, wired the way every test in this file wires it. */
function fakeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });
}

/**
 * Boots a control plane for a t147 test and hands back what it announced.
 *
 * No `authorizeGlobalFetch`, and that absence is the test device: with the
 * global untouched, the only credential that can reach the API is one the code
 * under test presents itself.
 */
async function bootUnpatched(t: TestHook): Promise<{ baseUrl: string; token: string }> {
  const readiness = await bootControlPlane(t);
  assert.ok(
    readiness.bootstrapToken !== null && readiness.bootstrapToken !== '',
    'each test boots against a database that never existed, so startup always mints and prints a token',
  );
  return { baseUrl: readiness.url, token: readiness.bootstrapToken };
}

test('t147 — with no token, the dispatch is refused 401 on its very first call', async (t) => {
  const { ErroDoControlPlane } = await loadModule<typeof ClientModule>(
    'src/controller/cliente-controle.ts',
  );
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t147-anonymous-workdir-'));
  const record = path.join(workDir, 'despacho-sem-token.json');
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    'POST',
    '/v1/jobs',
    { titulo: 'ficha despachada contra um control plane autenticado', no_entrada_id: 'implementar', execucao_id: 147 },
    201,
    token,
  );

  // Everything a working dispatch gets, minus the credential.
  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    adapter: fakeAdapter(),
    workingDir: workDir,
    timeoutSeconds: 60,
    envOverrides: { FAKE_ENGINE_RECORD: record, FAKE_ENGINE_LINES: linesWithoutBlock() },
  });

  await assert.rejects(
    async () => dispatch(work.id),
    (error: unknown) => {
      assert.ok(
        error instanceof ErroDoControlPlane,
        `expected the control plane's own refusal, got: ${String(error)}`,
      );
      assert.equal(error.status, 401);
      assert.equal(
        error.message,
        `GET /v1/jobs/${work.id} answered 401`,
        'the read that opens a dispatch is where it dies: nothing after it ever runs',
      );
      return true;
    },
  );

  // Which is to say: no engine was started and no telemetry was written. A
  // dispatch that cannot read the work does not half-happen.
  assert.ok(!existsSync(record), 'the engine process must never have been spawned');
  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    'GET',
    '/v1/sessions?execucao_id=147',
    undefined,
    200,
    token,
  );
  assert.equal(sessions.sessoes.length, 0);
});

test('t147 — with a token, the dispatch crosses every route it uses', async (t) => {
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t147-authorized-workdir-'));
  const record = path.join(workDir, 'despacho-com-token.json');
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    'POST',
    '/v1/jobs',
    { titulo: 'ficha despachada com credencial', no_entrada_id: 'implementar', execucao_id: 147 },
    201,
    token,
  );

  // The operator token, which is what production has to pass here: none of the
  // seven routes this dispatch touches is on the runner surface t143 opened
  // (`packages/core/src/auth.ts`), so a pairing token would be refused 403.
  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    adapter: fakeAdapter(),
    workingDir: workDir,
    timeoutSeconds: 60,
    token,
    permissions: { filesystem: { write: ['**'] }, network: { allowed: false } },
    envOverrides: { FAKE_ENGINE_RECORD: record, FAKE_ENGINE_LINES: linesWithDenialAndBlock() },
  });

  // Resolving is already most of the proof: a refusal on ANY of the seven
  // routes rejects — the reads and the two writes at once, and the denial
  // report by way of the failure the dispatch re-throws at the very end.
  await dispatch(work.id);

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    'GET',
    '/v1/sessions?execucao_id=147',
    undefined,
    200,
    token,
  );
  assert.equal(sessions.sessoes.length, 1, 'the session was opened through POST /v1/sessions');
  assert.equal(
    sessions.sessoes[0].status,
    'concluida',
    'and closed through PATCH /v1/sessions/:id/finish',
  );

  const questions = await api<{ perguntas: Question[] }>(
    baseUrl,
    'GET',
    '/v1/input-requests',
    undefined,
    200,
    token,
  );
  assert.equal(questions.perguntas.length, 1, 'the question reached POST /v1/input-requests');
  assert.equal(questions.perguntas[0].pergunta, ESCALATION.question);

  const timeline = await api<{ eventos: Event[] }>(
    baseUrl,
    'GET',
    `/v1/jobs/${work.id}/events`,
    undefined,
    200,
    token,
  );
  assert.ok(
    timeline.eventos.some((event) => event.tipo === 'sessao.permissao_negada'),
    'the denial reached POST /v1/sessions/:id/permission-denials',
  );
});
