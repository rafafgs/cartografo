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
 * The fold over `job.transitioned` is the same technique
 * `specs/events/reducers/reconstruct-state.mjs` already uses to
 * rebuild `no_atual`: the log is the only place the node a work sat on at a
 * given moment exists.
 *
 * English per D18. The payload keys of the ranking went English with t264
 * (`docs/spec/glossario-wire.md` §5.6), which is what the assertions below
 * spell; `gargalo` is the module's own result key and is identifier debt of
 * another ficha, not a wire name.
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
  type: string;
  execution_id: number | null;
  entity: { type: string; id: number | string };
  occurred_at: string;
  data: Record<string, unknown>;
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
  entity: { type: string; id: number },
  seconds: number,
  payload: Record<string, unknown> = {},
): Event {
  return { id, type, execution_id: 7, entity, occurred_at: at(seconds), data: payload };
}

const work = (id: number): { type: string; id: number } => ({ type: 'job', id });
const session = (id: number): { type: string; id: number } => ({ type: 'session', id });
const question = (id: number): { type: string; id: number } => ({ type: 'input_request', id });

/**
 * One execution with a deliberate imbalance: `revisar` burns agent time, waits
 * two minutes on a human and sits half a minute in the dispatch queue, while
 * the other two nodes are nearly idle.
 */
function unbalancedLog(): Event[] {
  return [
    event(1, 'job.created', work(1), 0, { title: 'nota curta', entry_node_id: 'redigir' }),

    // redigir: 3s of agent time, nothing else.
    event(2, 'session.opened', session(10), 2, {
      job_id: 1,
      node_id: 'redigir',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'redija',
    }),
    event(3, 'session.finished', session(10), 5, { status: 'completed', exit_code: 0, usage: null }),

    // revisar: lands at 6s, session only opens at 36s — 30s of queue.
    event(4, 'job.transitioned', work(1), 6, { from_node_id: null, to_node_id: 'revisar' }),
    event(5, 'session.opened', session(11), 36, {
      job_id: 1,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'revise',
    }),
    event(6, 'input_request.created', question(20), 40, {
      job_id: 1,
      session_id: 11,
      kind: 'question',
      question: 'sigo?',
      auto_approvable: true,
    }),
    event(7, 'job.blocked', work(1), 40, { reason: 'aguardando resposta da pergunta 20' }),
    event(8, 'session.finished', session(11), 45, { status: 'completed', exit_code: 0, usage: null }),
    // The answer is not what ends the wait — the unblock is.
    event(9, 'input_request.answered', question(20), 160, { answer: 'siga', answered_by: 'rafael' }),
    event(10, 'job.unblocked', work(1), 160, {}),

    // implantar: 1s of queue, 2s of agent.
    event(11, 'job.transitioned', work(1), 161, { from_node_id: 'revisar', to_node_id: 'implantar' }),
    event(12, 'session.opened', session(12), 162, {
      job_id: 1,
      node_id: 'implantar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'implante',
    }),
    event(13, 'session.finished', session(12), 164, {
      status: 'completed',
      exit_code: 0,
      usage: null,
    }),

    // A question nobody can attribute: no session, so no node. Counting it
    // anywhere would be inventing a number.
    event(14, 'input_request.created', question(21), 165, {
      job_id: 1,
      session_id: null,
      kind: 'question',
      question: 'e agora?',
      auto_approvable: true,
    }),
  ];
}

test('t110 — the flow lens computes the four numbers per node and names the bottleneck', async () => {
  const { calculateFlowMetrics } = await loadMetrics();

  const metrics = calculateFlowMetrics(unbalancedLog(), NODES);

  assert.deepEqual(metrics.by_node, [
    {
      node_id: 'revisar',
      agent_ms: 9_000,
      blocked_ms: 120_000,
      queue_ms: 30_000,
      total_ms: 159_000,
      input_requests: 1,
      event_ids: [4, 5, 6, 7, 8, 10],
    },
    {
      node_id: 'implantar',
      agent_ms: 2_000,
      blocked_ms: 0,
      queue_ms: 1_000,
      total_ms: 3_000,
      input_requests: 0,
      event_ids: [11, 12, 13],
    },
    {
      node_id: 'redigir',
      agent_ms: 3_000,
      blocked_ms: 0,
      queue_ms: 0,
      total_ms: 3_000,
      input_requests: 0,
      event_ids: [2, 3],
    },
  ]);

  assert.equal(metrics.gargalo?.node_id, 'revisar', 'the worst total is the bottleneck');
  assert.deepEqual(
    metrics.gargalo?.event_ids,
    [4, 5, 6, 7, 8, 10],
    'every number carries the ids of the events it was computed from',
  );
});

test('t110 — a run with no time signal at all has no bottleneck', async () => {
  const { calculateFlowMetrics } = await loadMetrics();

  // Two works that were created and moved, and nothing ever ran: no session
  // opened, nothing blocked. Every total is zero.
  const flat: Event[] = [
    event(1, 'job.created', work(1), 0, { title: 'a', entry_node_id: 'redigir' }),
    event(2, 'job.created', work(2), 0, { title: 'b', entry_node_id: 'redigir' }),
    event(3, 'job.transitioned', work(1), 0, { from_node_id: null, to_node_id: 'revisar' }),
  ];

  const metrics = calculateFlowMetrics(flat, NODES);

  assert.equal(metrics.gargalo, null, '"nothing to propose" is a valid outcome, not an error');
  assert.deepEqual(
    metrics.by_node.map((row) => row.total_ms),
    [0, 0, 0],
    'the nodes are still reported — a report that hides what it measured lies about the total',
  );
  assert.deepEqual(
    metrics.by_node.map((row) => row.node_id),
    ['implantar', 'redigir', 'revisar'],
    'with every total tied at zero, the order is the node id',
  );
});

test('t110 — a tie is broken by node id, and nodes outside the graph are ignored', async () => {
  const { calculateFlowMetrics } = await loadMetrics();

  const tied: Event[] = [
    event(1, 'job.created', work(1), 0, { title: 'a', entry_node_id: 'redigir' }),
    event(2, 'session.opened', session(10), 0, {
      job_id: 1,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'p',
    }),
    event(3, 'session.finished', session(10), 5, { status: 'completed', exit_code: 0, usage: null }),
    event(4, 'session.opened', session(11), 0, {
      job_id: 1,
      node_id: 'implantar',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'p',
    }),
    event(5, 'session.finished', session(11), 5, { status: 'completed', exit_code: 0, usage: null }),
    // A node the graph does not have: telemetry of a version that already
    // changed. Attributing it to anything would be a made-up number.
    event(6, 'session.opened', session(12), 0, {
      job_id: 1,
      node_id: 'no_que_nao_existe_mais',
      engine: 'claude-code',
      working_dir: '/tmp/x',
      prompt: 'p',
    }),
    event(7, 'session.finished', session(12), 600, {
      status: 'completed',
      exit_code: 0,
      usage: null,
    }),
  ];

  const metrics = calculateFlowMetrics(tied, NODES);

  assert.equal(metrics.gargalo?.node_id, 'implantar', 'same total, lowest node id wins');
  assert.deepEqual(
    metrics.by_node.map((row) => row.node_id),
    ['implantar', 'revisar', 'redigir'],
    'the ranking lists every node of the graph, and only them',
  );
  assert.equal(
    metrics.by_node.find((row) => row.node_id === 'redigir')?.total_ms,
    0,
    'the ten minutes of a node outside the graph land nowhere',
  );
});
