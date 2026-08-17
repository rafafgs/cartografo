/**
 * Acceptance tests of the watcher's dispatch (t247, AT6).
 *
 * Everything here is `runWatch` with the two lenses injected: what it has to
 * prove is the DISPATCH — who is called for which `--lens`, what a `--dry-run`
 * costs, and what one lens's failure does to the other — and none of that needs
 * a real agent session or a real control plane. The two lenses are proven
 * against the real thing by their own suites (`packages/runner/test/surveyor/`
 * and `packages/topografo-custo/test/`), and by `watch.e2e.test.ts` next door.
 *
 * The line shape is asserted key by key, not by a substring match, because it
 * is the whole output contract of this command: one JSON line per outcome, with
 * `proposal_id`, `message` and `reason` present only where FR3 says they are.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as StreamModule from '../src/stream.ts';
import type * as WatchModule from '../src/watch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const WATCH_MODULE = 'src/watch.ts';

let cache: typeof WatchModule | null = null;

async function loadWatch(): Promise<typeof WatchModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, WATCH_MODULE)),
    `artifact does not exist yet: packages/topografo/${WATCH_MODULE}`,
  );
  cache ??= (await import(new URL(`../${WATCH_MODULE}`, import.meta.url).href)) as typeof WatchModule;
  return cache;
}

/** A finished-execution message, as the stream consumer hands it over. */
function finished(id: number, executionId: number): StreamModule.StreamMessage {
  return {
    id,
    type: 'execution.finished',
    envelope: {
      id,
      type: 'execution.finished',
      project_id: 1,
      execution_id: executionId,
      entity: { type: 'execution', id: executionId },
      actor: { type: 'system', ref: 'control-plane' },
      occurred_at: '2026-08-17T10:00:00.000Z',
      data: {},
    },
  };
}

/** A finite stand-in for the stream: the watcher stops when it runs dry. */
async function* streamOf(
  ...messages: StreamModule.StreamMessage[]
): AsyncGenerator<StreamModule.StreamMessage> {
  for (const message of messages) yield message;
}

/** Everything one run wrote, already decoded. */
interface Run {
  lines: Array<Record<string, unknown>>;
  flowCalls: number[];
  costCalls: number[];
}

/** Runs the watcher over a fixed list of events, recording what it did. */
async function watch(
  options: Partial<WatchModule.WatchOptions>,
  ...messages: StreamModule.StreamMessage[]
): Promise<Run> {
  const { runWatch } = await loadWatch();
  const lines: Array<Record<string, unknown>> = [];
  const flowCalls: number[] = [];
  const costCalls: number[] = [];

  await runWatch({
    url: 'http://127.0.0.1:4317',
    token: 'operator-token',
    events: streamOf(...messages),
    runFlowLens: async (executionId) => {
      flowCalls.push(executionId);
      return { proposal_id: 900 + executionId, created: true };
    },
    runCostLens: async (executionId) => {
      costCalls.push(executionId);
      return [{ proposal_id: 700 + executionId, created: true }];
    },
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    ...options,
  });

  return { lines, flowCalls, costCalls };
}

test('t247 AT6 — --lens all runs both lenses per event, in stream order', async () => {
  const run = await watch({}, finished(1, 41), finished(2, 42));

  assert.deepEqual(run.flowCalls, [41, 42], 'the flow lens runs once per finished execution');
  assert.deepEqual(run.costCalls, [41, 42], 'and so does the cost lens');

  assert.deepEqual(run.lines, [
    { execution_id: 41, lens: 'flow', outcome: 'posted', proposal_id: 941 },
    { execution_id: 41, lens: 'cost', outcome: 'posted', proposal_id: 741 },
    { execution_id: 42, lens: 'flow', outcome: 'posted', proposal_id: 942 },
    { execution_id: 42, lens: 'cost', outcome: 'posted', proposal_id: 742 },
  ]);
});

test('t247 AT6 — --lens flow and --lens cost each run only the one they name', async () => {
  const onlyFlow = await watch({ lens: 'flow' }, finished(1, 51));
  assert.deepEqual(onlyFlow.flowCalls, [51]);
  assert.deepEqual(onlyFlow.costCalls, [], 'the cost lens is skipped entirely, not run and discarded');
  assert.deepEqual(
    onlyFlow.lines.map((line) => line.lens),
    ['flow'],
  );

  const onlyCost = await watch({ lens: 'cost' }, finished(1, 52));
  assert.deepEqual(onlyCost.costCalls, [52]);
  assert.deepEqual(onlyCost.flowCalls, [], 'and the flow lens — the expensive one — never opens a session');
  assert.deepEqual(
    onlyCost.lines.map((line) => line.lens),
    ['cost'],
  );
});

test('t247 AT6 — --dry-run calls neither lens and says so, once per lens', async () => {
  const run = await watch({ dryRun: true }, finished(1, 61));

  assert.deepEqual(run.flowCalls, [], 'a dry run costs no agent session at all');
  assert.deepEqual(run.costCalls, [], 'and no API call either');
  assert.deepEqual(run.lines, [
    { execution_id: 61, lens: 'flow', outcome: 'skipped', reason: 'dry-run' },
    { execution_id: 61, lens: 'cost', outcome: 'skipped', reason: 'dry-run' },
  ]);
});

test('t247 AT6 — a lens that throws is one error line, and the other lens still runs', async () => {
  const { runWatch } = await loadWatch();
  const lines: Array<Record<string, unknown>> = [];
  const costCalls: number[] = [];

  await runWatch({
    url: 'http://127.0.0.1:4317',
    token: 'operator-token',
    events: streamOf(finished(1, 71), finished(2, 72)),
    runFlowLens: async (executionId) => {
      if (executionId === 71) throw new Error('the session ended as "failed" (exit 3)');
      return { proposal_id: 971, created: false };
    },
    runCostLens: async (executionId) => {
      costCalls.push(executionId);
      return [];
    },
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });

  assert.deepEqual(
    costCalls,
    [71, 72],
    'the cost lens of the SAME event runs after the flow lens failed — one bad lens is not a bad event',
  );
  assert.deepEqual(lines, [
    {
      execution_id: 71,
      lens: 'flow',
      outcome: 'error',
      message: 'the session ended as "failed" (exit 3)',
    },
    { execution_id: 71, lens: 'cost', outcome: 'nothing' },
    { execution_id: 72, lens: 'flow', outcome: 'deduped', proposal_id: 971 },
    { execution_id: 72, lens: 'cost', outcome: 'nothing' },
  ]);
});

test('t247 AT6 — the line shape is exactly FR3: nothing carries a field it has no news for', async () => {
  const { runWatch } = await loadWatch();
  const lines: Array<Record<string, unknown>> = [];

  await runWatch({
    url: 'http://127.0.0.1:4317',
    token: 'operator-token',
    events: streamOf(finished(1, 81)),
    // No bottleneck: `proposal_id` is null and `created` is null with it, which
    // is the one outcome that is neither posted nor deduped nor an error.
    runFlowLens: async () => ({ proposal_id: null, created: null }),
    // Two candidates in one call, one of each: the cost lens writes one line
    // per candidate, never one line per execution.
    runCostLens: async () => [
      { proposal_id: 11, created: true },
      { proposal_id: 12, created: false },
    ],
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });

  assert.deepEqual(lines, [
    { execution_id: 81, lens: 'flow', outcome: 'nothing' },
    { execution_id: 81, lens: 'cost', outcome: 'posted', proposal_id: 11 },
    { execution_id: 81, lens: 'cost', outcome: 'deduped', proposal_id: 12 },
  ]);

  for (const line of lines) {
    assert.deepEqual(
      Object.keys(line).slice(0, 3),
      ['execution_id', 'lens', 'outcome'],
      `every line opens with the three fields that identify it: ${JSON.stringify(line)}`,
    );
    assert.equal(line.reason, undefined, 'only a skipped line explains itself with a reason');
    assert.equal(line.message, undefined, 'only an error line carries a message');
  }
});

test('t247 FR3 — one execution at a time: two lens runs never overlap in one process', async () => {
  const { runWatch } = await loadWatch();
  const timeline: string[] = [];
  let running = 0;

  const busy = async (label: string, executionId: number): Promise<void> => {
    running += 1;
    assert.equal(running, 1, `${label} of ${executionId} started while another lens was in flight`);
    timeline.push(`${label}:${executionId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  };

  await runWatch({
    url: 'http://127.0.0.1:4317',
    token: 'operator-token',
    events: streamOf(finished(1, 91), finished(2, 92)),
    runFlowLens: async (executionId) => {
      await busy('flow', executionId);
      return { proposal_id: null, created: null };
    },
    runCostLens: async (executionId) => {
      await busy('cost', executionId);
      return [];
    },
    write: () => undefined,
  });

  assert.deepEqual(timeline, ['flow:91', 'cost:91', 'flow:92', 'cost:92']);
});
