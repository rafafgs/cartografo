/**
 * Acceptance tests for the surveyor's one agentic step and the proposal it
 * lands in the book (t110, FR5–FR9).
 *
 * This is D16's "beat the flowpilot" milestone exercised end to end: a real
 * control plane over HTTP, a real event log read back through
 * `GET /v1/executions/:id/events`, a real `EngineAdapter` session (the fake
 * engine, for the reason the conformance kit records), and a real
 * `POST /v1/proposals` — with the evidence computed by our own code, never by
 * the agent's recall.
 *
 * Three claims, one per test:
 *
 * 1. a run with a clear bottleneck produces EXACTLY ONE pending proposal whose
 *    `evidencia.eventos` are ids that exist in the seeded log, and never calls
 *    `.../aplicar` — the safety ladder of README principle 5 is the point;
 * 2. a session that returns nothing usable aborts, and posts nothing;
 * 3. a flat run posts nothing AND never opens a session at all.
 *
 * The control-plane boot is the same pattern as
 * `test/dispatch/dispatch-claude-code.test.ts`: spawn the real binary, wait for
 * the readiness line, never `sleep` and hope. It is duplicated rather than
 * extracted because that file belongs to another ticket's surface.
 *
 * English per D18; route segments and payload keys stay in Portuguese.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type {
  EngineAdapter,
  EngineCapabilities,
  SessionListener,
  SessionSpec,
  SessionStatus,
} from '../../src/engine/types.ts';
import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ProposalModule from '../../src/surveyor/proposal.ts';

import { authorizeGlobalFetch } from '../authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const PROPOSAL_MODULE = 'src/surveyor/proposal.ts';

/** Deadline for anything this test waits on. Wide on purpose. */
const DEADLINE_MS = 30_000;

/** Execution with a bottleneck, and the flat one. */
const EXECUTION_WITH_SIGNAL = 7;
const FLAT_EXECUTION = 8;

/**
 * Slack between two timestamps of the seeded telemetry.
 *
 * `ocorrido_em` has millisecond resolution, so two writes in the same tick
 * would produce a zero interval and a run with no signal — which is the OTHER
 * test's scenario. Small enough not to slow the suite, large enough that the
 * clock cannot collapse it.
 */
const GAP_MS = 25;

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

interface GraphVersion {
  id: string;
  grafo_id: string;
}

interface Work {
  id: number;
}

interface Session {
  id: number;
}

interface Question {
  id: number;
}

interface Event {
  id: number;
  tipo: string;
}

interface Proposal {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: Array<Record<string, unknown>>;
  evidencia: Record<string, unknown>;
  metrica_esperada: Record<string, unknown>;
  status: string;
  versao_aplicada_id: string | null;
}

let clientCache: typeof ClientModule | null = null;
let proposalCache: typeof ProposalModule | null = null;

async function loadClient(): Promise<typeof ClientModule> {
  clientCache ??= (await import(
    new URL('../../src/controller/cliente-controle.ts', import.meta.url).href
  )) as typeof ClientModule;
  return clientCache;
}

async function loadProposal(): Promise<typeof ProposalModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, PROPOSAL_MODULE)),
    `artifact does not exist yet: packages/runner/${PROPOSAL_MODULE}`,
  );
  proposalCache ??= (await import(
    new URL(`../../${PROPOSAL_MODULE}`, import.meta.url).href
  )) as typeof ProposalModule;
  return proposalCache;
}

/** Boots the real control plane and returns the URL it announced. */
async function startControlPlane(t: TestHook): Promise<string> {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t110-e2e-'));
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
      // plane prints the one it minted, and this suite presents it from here on.
      const readiness = JSON.parse(line) as { url: string; bootstrapToken: string | null };
      authorizeGlobalFetch(t, { baseUrl: readiness.url, token: readiness.bootstrapToken ?? '' });
      return readiness.url;
    }
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

/** Everything a test needs: a control plane, a seeded graph and a work dir. */
interface Scenario {
  baseUrl: string;
  version: GraphVersion;
  workingDir: string;
  eventIds: number[];
  calls: string[];
  client: ClientModule.ClienteControle;
}

/**
 * Seeds one execution whose `revisar` node is unmistakably the bottleneck:
 * queued, then busy, then blocked on a question, plus the question itself.
 *
 * Every number comes from the real clock of the control plane — this test does
 * not fabricate timestamps, precisely because FR1's stream is what the surveyor
 * will read in production.
 */
async function seedBottleneck(baseUrl: string, versionId: string): Promise<void> {
  const work = await api<Work>(
    baseUrl,
    'POST',
    '/v1/jobs',
    {
      titulo: 'travessia com gargalo',
      no_entrada_id: 'redigir',
      execucao_id: EXECUTION_WITH_SIGNAL,
      grafo_versao_id: versionId,
    },
    201,
  );

  // Lands on `revisar` and waits in the dispatch queue.
  await api(baseUrl, 'POST', `/v1/jobs/${work.id}/transitions`, { para_no_id: 'revisar' });
  await delay(GAP_MS);

  const session = await api<Session>(
    baseUrl,
    'POST',
    '/v1/sessions',
    {
      trabalho_id: work.id,
      no_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revise a nota',
    },
    201,
  );

  // Asks, which blocks the work in the same transaction (t106).
  const question = await api<Question>(
    baseUrl,
    'POST',
    '/v1/input-requests',
    {
      trabalho_id: work.id,
      sessao_id: session.id,
      tipo: 'pergunta',
      pergunta: 'a nota responde ao tema?',
      auto_aprovavel: true,
    },
    201,
  );
  await delay(GAP_MS);

  await api(baseUrl, 'PATCH', `/v1/input-requests/${question.id}/answer`, {
    resposta: 'responde, siga',
    respondido_por: 'rafael',
  });
  await api(baseUrl, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
    uso: null,
  });
}

async function buildScenario(t: TestHook): Promise<Scenario> {
  const { ClienteControle } = await loadClient();
  const baseUrl = await startControlPlane(t);

  const document: unknown = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8'));
  const { grafo_versao: version } = await api<{ grafo_versao: GraphVersion }>(
    baseUrl,
    'POST',
    '/v1/graphs',
    document,
    201,
  );

  await seedBottleneck(baseUrl, version.id);

  // The flat execution: a work that was created under the same version and
  // never moved. No session, no block — no signal.
  await api(
    baseUrl,
    'POST',
    '/v1/jobs',
    {
      titulo: 'travessia sem sinal',
      no_entrada_id: 'redigir',
      execucao_id: FLAT_EXECUTION,
      grafo_versao_id: version.id,
    },
    201,
  );

  const workingDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t110-workdir-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const { eventos: events } = await api<{ eventos: Event[] }>(
    baseUrl,
    'GET',
    `/v1/executions/${EXECUTION_WITH_SIGNAL}/events`,
  );
  assert.ok(events.length >= 6, `the seeded log is too short: ${JSON.stringify(events)}`);

  const calls: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return await fetch(input, init);
  };

  return {
    baseUrl,
    version,
    workingDir,
    eventIds: events.map((event) => event.id),
    calls,
    client: new ClienteControle({ urlBase: baseUrl, buscar: doFetch }),
  };
}

/** The `claude` argv, handed whole to the fake engine — only the binary changes. */
function fakeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec: SessionSpec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });
}

/** Counts sessions without changing anything the adapter does. */
class CountingAdapter implements EngineAdapter {
  readonly engineName: string;
  sessions = 0;
  readonly #inner: EngineAdapter;

  constructor(inner: EngineAdapter) {
    this.#inner = inner;
    this.engineName = inner.engineName;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    this.sessions += 1;
    return await this.#inner.startSession(spec, listener);
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return await this.#inner.getStatus(sessionId);
  }

  async cancel(sessionId: string, status?: SessionStatus): Promise<void> {
    await this.#inner.cancel(sessionId, status);
  }

  capabilities(): EngineCapabilities {
    return this.#inner.capabilities();
  }

  async verifyCli(): ReturnType<EngineAdapter['verifyCli']> {
    return await this.#inner.verifyCli();
  }
}

/** A well-formed semantic diff, in the vocabulary of `entidades-versionamento` §3. */
const VALID_OPERATIONS = [
  {
    tipo: 'alterar_campo_no',
    no_id: 'revisar',
    campo: 'descricao',
    de: 'Confere a nota contra o tema declarado e encerra a travessia.',
    para: 'Confere a nota contra o tema declarado, com um checklist de três itens.',
    inversa: {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'descricao',
      de: 'Confere a nota contra o tema declarado, com um checklist de três itens.',
      para: 'Confere a nota contra o tema declarado e encerra a travessia.',
    },
  },
];

/** Configures the fake engine to write `conteudo` where the surveyor reads it. */
function engineWriting(file: string, content: string): Record<string, string> {
  return { FAKE_ENGINE_WRITE_FILES: JSON.stringify({ [file]: content }) };
}

const postsToProposals = (calls: readonly string[]): string[] =>
  calls.filter((call) => call === 'POST /v1/proposals');

test('t110 — a run with a bottleneck lands exactly one pending proposal, backed by real event ids', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);
  const adapter = new CountingAdapter(fakeAdapter());

  const result = await proposeFlowImprovement({
    client: scenario.client,
    adapter,
    executionId: EXECUTION_WITH_SIGNAL,
    workingDir: scenario.workingDir,
    timeoutSeconds: 60,
    envOverrides: engineWriting(
      OUTPUT_FILE,
      JSON.stringify({ operacoes: VALID_OPERATIONS }, null, 2),
    ),
  });

  assert.equal(adapter.sessions, 1, 'exactly one agent session decides the operations');
  assert.equal(result.gargalo?.no_id, 'revisar', 'the seeded bottleneck is the one found');
  assert.ok(result.proposta !== null, 'a bottleneck with a well-formed diff becomes a proposal');

  assert.deepEqual(
    postsToProposals(scenario.calls),
    ['POST /v1/proposals'],
    'exactly one POST /v1/proposals, never two',
  );
  assert.deepEqual(
    scenario.calls.filter((call) => call.includes('/aplicar')),
    [],
    'a surveyor proposal only ever reaches "pendente" (README, princípio 5)',
  );

  const { propostas: proposals } = await api<{ propostas: Proposal[] }>(
    scenario.baseUrl,
    'GET',
    '/v1/proposals',
  );
  assert.equal(proposals.length, 1);
  const proposal = proposals[0];

  assert.equal(proposal.id, result.proposta.id);
  assert.equal(proposal.status, 'pendente');
  assert.equal(proposal.versao_aplicada_id, null, 'nothing was applied');
  assert.equal(proposal.grafo_id, scenario.version.grafo_id);
  assert.equal(proposal.versao_alvo, scenario.version.id);
  assert.deepEqual(proposal.operacoes, VALID_OPERATIONS, 'the session chose the operations');

  // The evidence is ours, not the agent's: the four numbers plus the ids of the
  // events they were computed from, every one of them real.
  const evidence = proposal.evidencia;
  assert.equal(evidence.no_id, 'revisar');
  assert.equal(evidence.execucao_id, EXECUTION_WITH_SIGNAL);
  const ids = evidence.eventos as number[];
  assert.ok(Array.isArray(ids) && ids.length > 0, 'evidence without ids is a summary, not evidence');
  for (const id of ids) {
    assert.ok(scenario.eventIds.includes(id), `evidencia.eventos cites ${id}, absent from the log`);
  }
  for (const field of ['tempo_agente_ms', 'tempo_espera_ms', 'tempo_fila_ms', 'perguntas']) {
    assert.equal(typeof evidence[field], 'number', `evidencia.${field} must be a number`);
  }
  assert.ok((evidence.total_ms as number) > 0, 'the bottleneck has to have cost something');

  // `metrica_esperada` has the shape t112's verdict can read.
  const metric = proposal.metrica_esperada;
  assert.equal(typeof metric.nome, 'string');
  assert.ok(['sobe', 'cai'].includes(metric.direcao as string));
  assert.equal(typeof metric.de, 'number');
  assert.equal(typeof metric.para, 'number');
});

test('t110 — a session that returns nothing usable aborts, and posts nothing', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);

  const run = async (envOverrides: Record<string, string>): Promise<void> => {
    await proposeFlowImprovement({
      client: scenario.client,
      adapter: fakeAdapter(),
      executionId: EXECUTION_WITH_SIGNAL,
      workingDir: scenario.workingDir,
      timeoutSeconds: 60,
      envOverrides,
    });
  };

  // 1. An empty diff: a proposal that changes nothing is not a proposal.
  // The pattern is built from a string, not a regex literal, because what it
  // matches is the frozen wire key and not an identifier of ours (D18/FR2).
  await assert.rejects(
    async () => run(engineWriting(OUTPUT_FILE, JSON.stringify({ operacoes: [] }))),
    new RegExp('operacoes', 'i'),
  );

  // 2. Structurally malformed: an operation with no inverse, which the server
  // would refuse with 400 — and which never gets that far.
  await assert.rejects(
    async () =>
      run(
        engineWriting(
          OUTPUT_FILE,
          JSON.stringify({ operacoes: [{ tipo: 'adicionar_no', no: { id: 'red_team' } }] }),
        ),
      ),
    new RegExp('operation|operacoes', 'i'),
  );

  // 3. The session wrote nothing at all.
  await assert.rejects(async () => run({ FAKE_ENGINE_LINES: '[]' }));

  // 4. The session died.
  await assert.rejects(async () => run({ FAKE_ENGINE_EXIT_CODE: '3' }));

  assert.deepEqual(postsToProposals(scenario.calls), [], 'no proposal may be posted from a bad run');
  const { propostas: proposals } = await api<{ propostas: Proposal[] }>(
    scenario.baseUrl,
    'GET',
    '/v1/proposals',
  );
  assert.deepEqual(proposals, [], 'and nothing landed in the book');
});

test('t110 — a flat run exits quietly: no session, no proposal', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);
  const adapter = new CountingAdapter(fakeAdapter());

  const result = await proposeFlowImprovement({
    client: scenario.client,
    adapter,
    executionId: FLAT_EXECUTION,
    workingDir: scenario.workingDir,
    timeoutSeconds: 60,
    envOverrides: engineWriting(
      OUTPUT_FILE,
      JSON.stringify({ operacoes: VALID_OPERATIONS }),
    ),
  });

  assert.equal(result.gargalo, null, 'no signal, nothing to propose');
  assert.equal(result.proposta, null);
  assert.equal(adapter.sessions, 0, 'with nothing to explain, no agent is paid to explain it');
  assert.deepEqual(postsToProposals(scenario.calls), []);
});
