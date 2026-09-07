/**
 * Acceptance tests for the draft the collector sends while a session runs
 * (t465, FR6).
 *
 * The collector has always kept every line in `lines` and handed the array to
 * the dispatch once, at the end. This ticket adds one thing and deliberately
 * only one: on a throttle, it decodes what it has SO FAR — with the very
 * function the final decode uses, never a second one — and sends it to
 * `PATCH /v1/sessions/:id/partial-text`.
 *
 * Three properties, and each is the reason a line of the implementation exists:
 *
 * - **it is off the critical path.** The call is not awaited and its rejection
 *   is swallowed, so a control plane that blinks costs one interval of
 *   staleness and nothing else — the next tick resends the whole, larger
 *   buffer. Nothing downstream of `onOutput` may ever wait on it;
 * - **it is throttled to the poll's own rate**, not the engine's. A session
 *   printing a thousand frames a second is not a thousand writes a second;
 * - **the decode is injected**, which is what makes "the partial rendering uses
 *   the same accumulation rule as the final one" a property this test can check
 *   rather than a claim the two implementations agree on.
 *
 * The clock is injected too, for the reason every timed component of this
 * package injects one (`ClaudeCodeAdapterOptions.graceMs`): a test that had to
 * sleep three real seconds to observe a throttle would be a test nobody runs.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as CollectorModule from '../../src/dispatch/session-collector.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/session-collector.ts';

async function loadCollector(): Promise<typeof CollectorModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(
    new URL('../../src/dispatch/session-collector.ts', import.meta.url).href
  )) as typeof CollectorModule;
}

/** The interval the fixtures step over; the production default is the same 3000. */
const INTERVAL_MS = 3000;

/** One recorded call to the control plane. */
interface Recorded {
  route: string;
  method: string;
  body: unknown;
}

/** A clock the test moves by hand, and a client that only remembers. */
function harness(reject = false): {
  calls: Recorded[];
  call: <T>(route: string, method: string, body?: unknown) => Promise<T>;
  advance: (ms: number) => void;
  now: () => number;
} {
  const calls: Recorded[] = [];
  let clock = 1_000_000;
  return {
    calls,
    call: async <T,>(route: string, method: string, body?: unknown): Promise<T> => {
      calls.push({ route, method, body });
      if (reject) throw new Error('the control plane is not answering right now');
      return undefined as T;
    },
    advance: (ms: number): void => {
      clock += ms;
    },
    now: (): number => clock,
  };
}

/**
 * The decode this collector is given — a marker, not a real one.
 *
 * The point of the assertion is that whatever the dispatch hands over is what
 * gets sent, so the fixture makes its own signature unmistakable.
 */
function decode(lines: readonly string[]): string {
  return `decoded(${lines.join('|')})`;
}

/** The drafts of every PATCH recorded, in order. */
function drafts(calls: Recorded[], sessionId: number): unknown[] {
  return calls
    .filter((entry) => entry.route === `/v1/sessions/${String(sessionId)}/partial-text`)
    .map((entry) => {
      assert.equal(entry.method, 'PATCH');
      return (entry.body as { text: unknown }).text;
    });
}

test('t465 AT12 — before the session is bound, nothing is sent anywhere', async () => {
  const { createSessionCollector } = await loadCollector();
  const stub = harness();

  const collected = createSessionCollector(stub.call, undefined, decode, {
    partialTextIntervalMs: INTERVAL_MS,
    now: stub.now,
  });

  collected.listener.onOutput('the first line');
  stub.advance(INTERVAL_MS * 10);
  collected.listener.onOutput('the second line');

  assert.deepEqual(stub.calls, [], 'there is no session id to address a draft to yet');
  assert.deepEqual(collected.lines, ['the first line', 'the second line'], 'the buffer still fills');
});

test('t465 AT13 — past the interval, one PATCH carries what the injected decode says', async () => {
  const { createSessionCollector } = await loadCollector();
  const stub = harness();

  const collected = createSessionCollector(stub.call, undefined, decode, {
    partialTextIntervalMs: INTERVAL_MS,
    now: stub.now,
  });

  collected.bindSession(77);
  collected.listener.onOutput('a');
  collected.listener.onOutput('b');
  assert.deepEqual(drafts(stub.calls, 77), [], 'the interval has not passed yet');

  stub.advance(INTERVAL_MS);
  collected.listener.onOutput('c');

  assert.deepEqual(
    drafts(stub.calls, 77),
    [decode(['a', 'b', 'c'])],
    'exactly one draft, and it is the SAME decode the final report uses, over the lines so far',
  );
});

test('t465 AT14 — two lines inside one interval cost at most one write', async () => {
  const { createSessionCollector } = await loadCollector();
  const stub = harness();

  const collected = createSessionCollector(stub.call, undefined, decode, {
    partialTextIntervalMs: INTERVAL_MS,
    now: stub.now,
  });

  collected.bindSession(5);
  stub.advance(INTERVAL_MS);
  collected.listener.onOutput('one');
  collected.listener.onOutput('two');
  stub.advance(INTERVAL_MS - 1);
  collected.listener.onOutput('three');

  assert.deepEqual(
    drafts(stub.calls, 5),
    [decode(['one'])],
    "the write rate is the poll's, never the engine's",
  );

  stub.advance(1);
  collected.listener.onOutput('four');
  assert.deepEqual(
    drafts(stub.calls, 5),
    [decode(['one']), decode(['one', 'two', 'three', 'four'])],
    'and the next tick resends the whole, larger buffer',
  );
});

test('t465 AT15 — a refused write never reaches the caller, and never stops the buffer', async () => {
  const { createSessionCollector } = await loadCollector();
  const stub = harness(true);

  const collected = createSessionCollector(stub.call, undefined, decode, {
    partialTextIntervalMs: INTERVAL_MS,
    now: stub.now,
  });

  collected.bindSession(3);
  stub.advance(INTERVAL_MS);
  assert.doesNotThrow(() => {
    collected.listener.onOutput('a line the control plane will refuse');
  });

  stub.advance(INTERVAL_MS);
  collected.listener.onOutput('and the one after it');

  // The rejection settles on its own turn of the loop; nothing here awaited it,
  // which is the property, so the test gives it one turn before judging.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(drafts(stub.calls, 3).length, 2, 'a refusal does not stop the next attempt');
  assert.deepEqual(collected.lines, [
    'a line the control plane will refuse',
    'and the one after it',
  ]);
});
