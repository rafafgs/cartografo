/**
 * Acceptance tests for the bounded retry of a pre-session failure (t272, FR2/FR3/FR4).
 *
 * t252 closed the loop for the failures it could PROVE deterministic, and left
 * everything else retrying — correctly, because a 5xx heals itself. The t109
 * game run found the hole in that: a failure nobody can classify retries just as
 * forever as an unclassified deterministic one, and forever is the bug either
 * way. 38 leases in two minutes, no session, no cap, nothing in the inbox.
 *
 * So the answer here is deliberately WEAKER than a classification: a failure the
 * classifier does not recognize is still retried, just not endlessly. The
 * counter says nothing about the cause — only that the same job has failed
 * before opening a session N times in a row, which is enough to stop paying for
 * the next attempt and cheap enough to be wrong about (a person unblocks, and
 * whatever healed itself in the meantime is dispatched again).
 *
 * No server and no engine: `call` is a fake that records what was posted, which
 * is the same discipline `pre-session-failure.test.ts` runs under — the decision
 * is testable without anything HTTP in the way.
 *
 * English per D18; the reasons are Portuguese, because a person reads them in
 * the inbox.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { UnknownEngineError } from '../../src/dispatch/resolve-engine.ts';
import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type * as OptionsModule from '../../src/dispatch/options.ts';
import type * as RetryModule from '../../src/dispatch/pre-session-retry.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/pre-session-retry.ts';

let cache: typeof RetryModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom of this directory: in the red phase the failure has to read as "the
 * implementation is missing", never as a module resolution stack trace.
 */
async function loadModule(): Promise<typeof RetryModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/pre-session-retry.ts', import.meta.url).href
  )) as typeof RetryModule;
  return cache;
}

/**
 * The default ceiling, read from where it is DECLARED (`options.ts`).
 *
 * Dynamically, and not with a static import at the top: the whole file would
 * fail to parse while the constant does not exist yet, and a red phase that
 * reads as a `SyntaxError` hides which of the two artifacts is actually missing.
 */
async function defaultCeiling(): Promise<number> {
  const options = (await import(
    new URL('../../src/dispatch/options.ts', import.meta.url).href
  )) as typeof OptionsModule;
  const declared = options.DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES;
  assert.equal(
    typeof declared,
    'number',
    'options.ts has to declare DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES, next to the ' +
      'option it is the fallback for',
  );
  return declared;
}

/** The work being dispatched, in the part this decision reads. */
const JOB = Object.freeze({
  id: 272,
  current_node_id: 'testar-alpha',
  graph_version_id: 'sha256:0123456789abcdef',
});

/** One write the decision made, as the fake client saw it. */
interface Posted {
  route: string;
  method: string;
  body: unknown;
}

/** A `ControlPlaneCall` that records instead of calling, and answers nothing. */
function fakeCall(): { call: ControlPlaneCall; posted: Posted[] } {
  const posted: Posted[] = [];
  const call = (<T>(route: string, method: string, body?: unknown): Promise<T> => {
    posted.push({ route, method, body });
    return Promise.resolve(undefined as T);
  }) as ControlPlaneCall;
  return { call, posted };
}

/** The blocks in a ledger, which is the only route this module ever calls. */
function blocks(posted: readonly Posted[]): Posted[] {
  return posted.filter(
    (entry) => entry.method === 'POST' && entry.route === `/v1/jobs/${String(JOB.id)}/blocks`,
  );
}

/** The `reason` of a posted block. */
function reasonOf(entry: Posted): string {
  return (entry.body as { reason: string }).reason;
}

test('AT1 — the tracker counts per job id, independently, and starts over after a reset', async () => {
  const { PreSessionFailureTracker } = await loadModule();

  const tracker = new PreSessionFailureTracker();

  assert.equal(tracker.recordFailure(1), 1);
  assert.equal(tracker.recordFailure(1), 2);
  assert.equal(tracker.recordFailure(1), 3);

  // A second job is a second streak: one job failing five times may not stop a
  // job that failed once, and a single shared counter would do exactly that.
  assert.equal(tracker.recordFailure(2), 1);
  assert.equal(tracker.recordFailure(2), 2);
  assert.equal(tracker.recordFailure(1), 4);

  tracker.reset(1);
  assert.equal(tracker.recordFailure(1), 1, 'a reset streak starts over at one');
  assert.equal(tracker.recordFailure(2), 3, 'and it resets ONLY the job it was given');

  // Resetting a job that never failed is ordinary: every dispatch that opens a
  // session calls it, and most of them have nothing to clear.
  tracker.reset(9_999);
  assert.equal(tracker.recordFailure(9_999), 1);
});

test('AT2 — a classifiable failure blocks on the very first call, whatever the count says', async () => {
  const { PreSessionFailureTracker, handlePreSessionFailure } = await loadModule();

  const tracker = new PreSessionFailureTracker();
  const { call, posted } = fakeCall();

  const error = new UnknownEngineError('gemini', 'testar-alpha', ['claude-code', 'codex']);
  const reason = await handlePreSessionFailure(error, JOB, call, tracker, 5);

  assert.ok(reason !== null, 'a cause the classifier recognizes never waits for a streak');
  assert.equal(blocks(posted).length, 1, 'exactly one block, posted by the runner itself');
  assert.equal(reasonOf(blocks(posted)[0]), reason, 'what was posted is what was handed back');
  assert.ok(
    reason.includes('gemini'),
    `the classifier's own reason has to survive: ${reason}`,
  );

  // And the streak is cleared: the work is stopped now, and a count left behind
  // would carry into whatever a person unblocks it into.
  assert.equal(tracker.recordFailure(JOB.id), 1);
});

test('AT3 — an unclassifiable failure retries below the ceiling and blocks at it', async () => {
  const { PreSessionFailureTracker, handlePreSessionFailure } = await loadModule();

  const tracker = new PreSessionFailureTracker();
  const { call, posted } = fakeCall();
  const error = new Error('could not start "claude": spawn claude ENOENT');

  for (const attempt of [1, 2, 3, 4]) {
    assert.equal(
      await handlePreSessionFailure(error, JOB, call, tracker, 5),
      null,
      `attempt ${String(attempt)} is below the ceiling: null means "rethrow and retry"`,
    );
    assert.deepEqual(blocks(posted), [], 'nothing may be blocked while retrying is still the answer');
  }

  const reason = await handlePreSessionFailure(error, JOB, call, tracker, 5);

  assert.ok(reason !== null, 'the fifth consecutive failure is where "forever" stops');
  assert.equal(blocks(posted).length, 1, 'exactly one block, on the attempt that reached the ceiling');
  assert.equal(reasonOf(blocks(posted)[0]), reason);
  assert.ok(
    reason.includes('5'),
    `the reason has to say how many attempts it took: ${reason}`,
  );
  assert.ok(
    reason.includes('spawn claude ENOENT'),
    `...and carry the error's own message, which is the only clue there is: ${reason}`,
  );
  assert.ok(
    reason.includes(JOB.current_node_id),
    `...and name the node the work is standing on: ${reason}`,
  );

  // Reset afterwards, exactly as the classified path resets: the work is
  // stopped, and the next dispatch of it starts a streak of its own.
  assert.equal(tracker.recordFailure(JOB.id), 1);
});

test('AT4 — a non-integer, zero or negative ceiling falls back to the default', async () => {
  const { resolvePreSessionFailureCeiling } = await loadModule();
  const fallback = await defaultCeiling();

  for (const declared of [undefined, 0, -1, -10, 2.5, Number.NaN]) {
    assert.equal(
      resolvePreSessionFailureCeiling(declared),
      fallback,
      `a ceiling of ${String(declared)} is not a ceiling: 0 would block every job on its ` +
        'first hiccup, and NaN would never block anything',
    );
  }

  assert.equal(resolvePreSessionFailureCeiling(1), 1, 'one attempt is a legitimate choice');
  assert.equal(resolvePreSessionFailureCeiling(12), 12);
});
