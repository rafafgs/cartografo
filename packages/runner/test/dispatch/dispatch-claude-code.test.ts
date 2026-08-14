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
 * `test/controller/dispatch-e-lease.e2e.test.ts`: spawn the real binary, wait
 * for the readiness line, never `sleep` and hope. It is duplicated rather than
 * extracted because that file belongs to another ticket's surface.
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

/** Boots the real control plane and returns the URL it announced. */
async function startControlPlane(t: TestHook): Promise<string> {
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
      .find((text) => text.startsWith('{') && text.includes('cartografo.pronto'));
    if (line !== undefined) return (JSON.parse(line) as { url: string }).url;
    await delay(50);
  }

  throw new Error(`the control plane was not ready within ${DEADLINE_MS}ms\nstdout:\n${out}`);
}

/** Talks JSON with the control plane, asserting the status on the way. */
async function api<T>(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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
    '/v1/trabalhos',
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
    cliente: client,
    runnerId: 'runner-t106',
    projetoId: 1,
    tetoRunner: 1,
    tetoProjeto: 4,
    ttlSegundos: 30,
    despachar: async (workId) => currentDispatch(workId),
  });

  // --- 1. the first tick dispatches, and the session asks -------------------
  const first = await controller.tick();
  assert.ok(first !== null, 'the first tick should have found and dispatched the work');
  assert.equal(first.trabalhoId, work.id);

  const blocked = await api<Work>(baseUrl, 'GET', `/v1/trabalhos/${work.id}`);
  assert.equal(blocked.bloqueado, true, 'asking blocks the work, without the runner asking for it');

  const pending = await api<{ perguntas: Question[] }>(
    baseUrl,
    'GET',
    '/v1/perguntas?status=pendente',
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
    `/v1/perguntas/${question.id}/resposta`,
    { resposta: ANSWER, respondido_por: ANSWERED_BY },
  );
  assert.equal(answered.status, 'respondida');
  assert.equal(answered.origem, 'usuario');

  const unblocked = await api<Work>(baseUrl, 'GET', `/v1/trabalhos/${work.id}`);
  assert.equal(unblocked.bloqueado, false, 'answering returns the work to the queue');
  assert.equal(unblocked.motivo_bloqueio, null);

  // --- 3. the next tick re-dispatches, and this time the session knows ------
  currentDispatch = dispatchThatFinishes;
  const second = await controller.tick();
  assert.ok(second !== null, 'the answered work is a candidate again');
  assert.equal(second.trabalhoId, work.id);

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

  const questions = await api<{ perguntas: Question[] }>(baseUrl, 'GET', '/v1/perguntas');
  assert.equal(
    questions.perguntas.length,
    1,
    'knowing the answer, the second session did not ask the same thing again',
  );

  // --- 4. and the log tells the whole story ---------------------------------
  const timeline = await api<{ eventos: Event[] }>(
    baseUrl,
    'GET',
    `/v1/trabalhos/${work.id}/eventos`,
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
    // cannot see them (t102, `packages/core/src/db/eventos.ts`
    // `FiltroDeEventos`). They are proven below, on the projections.
    'the work timeline, in the order the log recorded it',
  );

  const created = timeline.eventos.find((event) => event.tipo === 'pergunta.criada');
  assert.deepEqual(created?.ator, { tipo: 'agente', ref: work.no_atual }, 'the agent asked');
  const blockEvent = timeline.eventos.find((event) => event.tipo === 'trabalho.bloqueado');
  assert.equal(blockEvent?.ator.tipo, 'sistema', 'the flag was raised by the wiring');
  const unblockEvent = timeline.eventos.find((event) => event.tipo === 'trabalho.desbloqueado');
  assert.equal(unblockEvent?.ator.tipo, 'usuario', 'the flag was lowered by the human who answered');

  const sessions = await api<{ sessoes: Session[] }>(baseUrl, 'GET', '/v1/sessoes?execucao_id=7');
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
