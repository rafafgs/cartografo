/**
 * Acceptance tests for the flow lens (t110, FR3/FR4).
 *
 * `calculateFlowMetrics` is the half of the surveyor that no agent touches:
 * given one execution's event log and the node ids of the graph it ran under,
 * it folds the log into time-in-node, time-waiting, time-in-queue and questions
 * per node, and names the worst one. Everything the proposal will later claim
 * as evidence is computed HERE — which is what makes "evidence traceable to
 * numbers in the log" structural instead of a promise about the agent's memory.
 *
 * The fixtures are hand-built envelopes, not a live control plane: the unit
 * under test is pure, and a real database would only add a clock we cannot
 * control. The timestamps are round on purpose — every expected number below is
 * a subtraction the reader can do by eye.
 *
 * The fold over `trabalho.transicao` is the same technique
 * `especificacoes/eventos/reducers/reconstruir-estado.mjs` already uses to
 * rebuild `no_atual`: the log is the only place the node a work sat on at a
 * given moment exists.
 *
 * English per D18; the domain vocabulary (`gargalo`, `tempo_agente_ms`) stays
 * in Portuguese because the ticket and the payload keys name it that way.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as MetricsModule from '../../src/surveyor/metrics.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const METRICS_MODULE = 'src/surveyor/metrics.ts';

/** One envelope, in the taxonomy's shape (t98), reduced to what the fold reads. */
interface Event {
  id: number;
  tipo: string;
  execucao_id: number | null;
  entidade: { tipo: string; id: number | string };
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

let cache: typeof MetricsModule | null = null;

async function loadMetrics(): Promise<typeof MetricsModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, METRICS_MODULE)),
    `artifact does not exist yet: packages/runner/${METRICS_MODULE}`,
  );
  cache ??= (await import(
    new URL(`../../${METRICS_MODULE}`, import.meta.url).href
  )) as typeof MetricsModule;
  return cache;
}

const NODES = ['implantar', 'redigir', 'revisar'];

/** `2026-08-14T10:00:00Z` plus `seconds`, so every expectation is arithmetic. */
function at(seconds: number): string {
  return new Date(Date.parse('2026-08-14T10:00:00.000Z') + seconds * 1_000).toISOString();
}

function event(
  id: number,
  type: string,
  entity: { tipo: string; id: number },
  seconds: number,
  payload: Record<string, unknown> = {},
): Event {
  return { id, tipo: type, execucao_id: 7, entidade: entity, ocorrido_em: at(seconds), dados: payload };
}

const work = (id: number): { tipo: string; id: number } => ({ tipo: 'trabalho', id });
const session = (id: number): { tipo: string; id: number } => ({ tipo: 'sessao', id });
const question = (id: number): { tipo: string; id: number } => ({ tipo: 'pergunta', id });

/**
 * One execution with a deliberate imbalance: `revisar` burns agent time, waits
 * two minutes on a human and sits half a minute in the dispatch queue, while
 * the other two nodes are nearly idle.
 */
function unbalancedLog(): Event[] {
  return [
    event(1, 'trabalho.criado', work(1), 0, { titulo: 'nota curta', no_entrada_id: 'redigir' }),

    // redigir: 3s of agent time, nothing else.
    event(2, 'sessao.aberta', session(10), 2, {
      trabalho_id: 1,
      no_id: 'redigir',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'redija',
    }),
    event(3, 'sessao.finalizada', session(10), 5, { status: 'concluida', exit_code: 0, uso: null }),

    // revisar: lands at 6s, session only opens at 36s — 30s of queue.
    event(4, 'trabalho.transicao', work(1), 6, { de_no_id: null, para_no_id: 'revisar' }),
    event(5, 'sessao.aberta', session(11), 36, {
      trabalho_id: 1,
      no_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'revise',
    }),
    event(6, 'pergunta.criada', question(20), 40, {
      trabalho_id: 1,
      sessao_id: 11,
      tipo: 'pergunta',
      pergunta: 'sigo?',
      auto_aprovavel: true,
    }),
    event(7, 'trabalho.bloqueado', work(1), 40, { motivo: 'aguardando resposta da pergunta 20' }),
    event(8, 'sessao.finalizada', session(11), 45, { status: 'concluida', exit_code: 0, uso: null }),
    // The answer is not what ends the wait — the unblock is.
    event(9, 'pergunta.respondida', question(20), 160, { resposta: 'siga', respondido_por: 'rafael' }),
    event(10, 'trabalho.desbloqueado', work(1), 160, {}),

    // implantar: 1s of queue, 2s of agent.
    event(11, 'trabalho.transicao', work(1), 161, { de_no_id: 'revisar', para_no_id: 'implantar' }),
    event(12, 'sessao.aberta', session(12), 162, {
      trabalho_id: 1,
      no_id: 'implantar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'implante',
    }),
    event(13, 'sessao.finalizada', session(12), 164, {
      status: 'concluida',
      exit_code: 0,
      uso: null,
    }),

    // A question nobody can attribute: no session, so no node. Counting it
    // anywhere would be inventing a number.
    event(14, 'pergunta.criada', question(21), 165, {
      trabalho_id: 1,
      sessao_id: null,
      tipo: 'pergunta',
      pergunta: 'e agora?',
      auto_aprovavel: true,
    }),
  ];
}

test('t110 — the flow lens computes the four numbers per node and names the bottleneck', async () => {
  const { calculateFlowMetrics } = await loadMetrics();

  const metrics = calculateFlowMetrics(unbalancedLog(), NODES);

  assert.deepEqual(metrics.por_no, [
    {
      no_id: 'revisar',
      tempo_agente_ms: 9_000,
      tempo_espera_ms: 120_000,
      tempo_fila_ms: 30_000,
      total_ms: 159_000,
      perguntas: 1,
      eventos: [4, 5, 6, 7, 8, 10],
    },
    {
      no_id: 'implantar',
      tempo_agente_ms: 2_000,
      tempo_espera_ms: 0,
      tempo_fila_ms: 1_000,
      total_ms: 3_000,
      perguntas: 0,
      eventos: [11, 12, 13],
    },
    {
      no_id: 'redigir',
      tempo_agente_ms: 3_000,
      tempo_espera_ms: 0,
      tempo_fila_ms: 0,
      total_ms: 3_000,
      perguntas: 0,
      eventos: [2, 3],
    },
  ]);

  assert.equal(metrics.gargalo?.no_id, 'revisar', 'the worst total is the bottleneck');
  assert.deepEqual(
    metrics.gargalo?.eventos,
    [4, 5, 6, 7, 8, 10],
    'every number carries the ids of the events it was computed from',
  );
});

test('t110 — a run with no time signal at all has no bottleneck', async () => {
  const { calculateFlowMetrics } = await loadMetrics();

  // Two works that were created and moved, and nothing ever ran: no session
  // opened, nothing blocked. Every total is zero.
  const flat: Event[] = [
    event(1, 'trabalho.criado', work(1), 0, { titulo: 'a', no_entrada_id: 'redigir' }),
    event(2, 'trabalho.criado', work(2), 0, { titulo: 'b', no_entrada_id: 'redigir' }),
    event(3, 'trabalho.transicao', work(1), 0, { de_no_id: null, para_no_id: 'revisar' }),
  ];

  const metrics = calculateFlowMetrics(flat, NODES);

  assert.equal(metrics.gargalo, null, '"nothing to propose" is a valid outcome, not an error');
  assert.deepEqual(
    metrics.por_no.map((row) => row.total_ms),
    [0, 0, 0],
    'the nodes are still reported — a report that hides what it measured lies about the total',
  );
  assert.deepEqual(
    metrics.por_no.map((row) => row.no_id),
    ['implantar', 'redigir', 'revisar'],
    'with every total tied at zero, the order is the node id',
  );
});

test('t110 — a tie is broken by node id, and nodes outside the graph are ignored', async () => {
  const { calculateFlowMetrics } = await loadMetrics();

  const tied: Event[] = [
    event(1, 'trabalho.criado', work(1), 0, { titulo: 'a', no_entrada_id: 'redigir' }),
    event(2, 'sessao.aberta', session(10), 0, {
      trabalho_id: 1,
      no_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'p',
    }),
    event(3, 'sessao.finalizada', session(10), 5, { status: 'concluida', exit_code: 0, uso: null }),
    event(4, 'sessao.aberta', session(11), 0, {
      trabalho_id: 1,
      no_id: 'implantar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'p',
    }),
    event(5, 'sessao.finalizada', session(11), 5, { status: 'concluida', exit_code: 0, uso: null }),
    // A node the graph does not have: telemetry of a version that already
    // changed. Attributing it to anything would be a made-up number.
    event(6, 'sessao.aberta', session(12), 0, {
      trabalho_id: 1,
      no_id: 'no_que_nao_existe_mais',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'p',
    }),
    event(7, 'sessao.finalizada', session(12), 600, {
      status: 'concluida',
      exit_code: 0,
      uso: null,
    }),
  ];

  const metrics = calculateFlowMetrics(tied, NODES);

  assert.equal(metrics.gargalo?.no_id, 'implantar', 'same total, lowest node id wins');
  assert.deepEqual(
    metrics.por_no.map((row) => row.no_id),
    ['implantar', 'revisar', 'redigir'],
    'the ranking lists every node of the graph, and only them',
  );
  assert.equal(
    metrics.por_no.find((row) => row.no_id === 'redigir')?.total_ms,
    0,
    'the ten minutes of a node outside the graph land nowhere',
  );
});
