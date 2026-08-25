/**
 * Acceptance tests for the per-job quota cooldown (t296, AC3/FR6/FR7).
 *
 * The incident this closes is one line of arithmetic
 * (`notes/2026-08-18-n3-round.md`, hole 1): the engine account answered `429`,
 * the adapter reported a session that "failed", and the runner re-leased the
 * job on the very next tick — three attempts in twenty seconds, US$9.3 spent,
 * and then a job flagged "blocked: consecutive failures" for a fact that was
 * never the job's fault and that heals itself at a KNOWN instant.
 *
 * So the answer is neither a block nor a throw: it is a WAIT. The job stays a
 * candidate on the server — nothing is posted, nothing is flagged, the board
 * still shows it in progress — and this one runner simply stops offering it
 * until either the reset instant the engine named or, when it named none, the
 * next rung of a backoff ladder.
 *
 * **The counter lives in the runner process**, which is `PreSessionFailure-
 * Tracker`'s tradeoff (t272) taken again for the same reason, and the tests
 * below are written against exactly that: no server, no engine, no clock. Time
 * is a parameter of every method, because a cooldown tested against
 * `Date.now()` is a cooldown tested against how fast the machine ran.
 *
 * English per the repository's language rule.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as OptionsModule from '../../src/dispatch/options.ts';
import type * as QuotaModule from '../../src/dispatch/quota-retry.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/quota-retry.ts';

let cache: typeof QuotaModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom of this directory (`pre-session-retry.test.ts`): in the red phase
 * the failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadModule(): Promise<typeof QuotaModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/quota-retry.ts', import.meta.url).href
  )) as typeof QuotaModule;
  return cache;
}

/**
 * The default ladder, read from where it is DECLARED (`options.ts`).
 *
 * Dynamically, and not with a static import at the top, for the reason
 * `pre-session-retry.test.ts` gives for its own ceiling: the whole file would
 * fail to parse while the constant does not exist, and a red phase that reads
 * as a `SyntaxError` hides which of the two artifacts is missing.
 */
async function defaultLadder(): Promise<readonly number[]> {
  const options = (await import(
    new URL('../../src/dispatch/options.ts', import.meta.url).href
  )) as typeof OptionsModule;
  const declared = options.DEFAULT_QUOTA_BACKOFF_MS;
  assert.ok(
    Array.isArray(declared) && declared.length > 0,
    'options.ts has to declare DEFAULT_QUOTA_BACKOFF_MS, next to the option it is the ' +
      'fallback for',
  );
  return declared;
}

/** An arbitrary instant to measure from; every case is relative to it. */
const NOW = 1_760_000_000_000;

/** The job under test. One number, because the tracker reads nothing else. */
const JOB_ID = 296;

test('t296 AC3 — with no reset instant, the cooldown is the first rung of the ladder', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const ladder = await defaultLadder();
  const tracker = new QuotaCooldownTracker();

  assert.equal(
    tracker.isCoolingDown(JOB_ID, NOW),
    false,
    'a job nobody recorded anything about is not cooling down',
  );

  tracker.recordQuotaFailure(JOB_ID, undefined, NOW);

  assert.equal(tracker.isCoolingDown(JOB_ID, NOW), true);
  assert.equal(
    tracker.isCoolingDown(JOB_ID, NOW + ladder[0] - 1),
    true,
    'one millisecond before the rung is still inside it',
  );
  assert.equal(
    tracker.isCoolingDown(JOB_ID, NOW + ladder[0]),
    false,
    'and the rung itself is over: the job is offered again on the next tick',
  );
});

test('t296 AC3 — a repeated refusal climbs the ladder and stops at its last rung', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const ladder = await defaultLadder();
  const tracker = new QuotaCooldownTracker();

  // One failure per rung, each recorded the instant the previous one expired:
  // the streak is what grows, and what it buys is a wait that grows with it.
  let at = NOW;
  for (const rung of ladder) {
    tracker.recordQuotaFailure(JOB_ID, undefined, at);
    assert.equal(
      tracker.isCoolingDown(JOB_ID, at + rung - 1),
      true,
      `the wait after ${String(rung)}ms has to be that rung, not the one before it`,
    );
    assert.equal(tracker.isCoolingDown(JOB_ID, at + rung), false);
    at += rung;
  }

  const last = ladder[ladder.length - 1];
  tracker.recordQuotaFailure(JOB_ID, undefined, at);
  assert.equal(
    tracker.isCoolingDown(JOB_ID, at + last),
    false,
    'past the end of the ladder the wait stays at the last rung — it is a cap, not a ramp',
  );
  assert.equal(tracker.isCoolingDown(JOB_ID, at + last - 1), true);
});

test('t296 AC3 — a reset instant the engine named wins over the ladder', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const tracker = new QuotaCooldownTracker();

  const resetMs = NOW + 45 * 60 * 1_000;
  tracker.recordQuotaFailure(JOB_ID, new Date(resetMs).toISOString(), NOW);

  assert.equal(
    tracker.isCoolingDown(JOB_ID, NOW + 60 * 60 * 1_000),
    false,
    'an hour later the account has reset: the engine said so',
  );
  assert.equal(
    tracker.isCoolingDown(JOB_ID, resetMs - 1),
    true,
    'until exactly that instant there is nothing to buy but the same refusal',
  );
  assert.equal(tracker.isCoolingDown(JOB_ID, resetMs), false, 'and at it, the wait is over');
});

test('t296 AC3 — a reset instant that is missing, unparseable or past falls back to the ladder', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const ladder = await defaultLadder();

  for (const [label, resetAt] of [
    ['the engine named none', undefined],
    ['the text did not parse', 'resets 4:40pm Europe/Lisbon'],
    ['it is an empty string', ''],
    ['it is already behind us', new Date(NOW - 1_000).toISOString()],
  ] as const) {
    const tracker = new QuotaCooldownTracker();
    tracker.recordQuotaFailure(JOB_ID, resetAt, NOW);

    assert.equal(
      tracker.isCoolingDown(JOB_ID, NOW + ladder[0] - 1),
      true,
      `${label}: the ladder is what is left, and it may never be zero`,
    );
    assert.equal(tracker.isCoolingDown(JOB_ID, NOW + ladder[0]), false, label);
  }
});

test('t296 AC3 — `reset` clears the wait and the streak behind it', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const ladder = await defaultLadder();
  const tracker = new QuotaCooldownTracker();

  tracker.recordQuotaFailure(JOB_ID, undefined, NOW);
  tracker.recordQuotaFailure(JOB_ID, undefined, NOW);
  tracker.reset(JOB_ID);

  assert.equal(
    tracker.isCoolingDown(JOB_ID, NOW),
    false,
    'a session that completed is the proof the account is answering again',
  );

  tracker.recordQuotaFailure(JOB_ID, undefined, NOW);
  assert.equal(
    tracker.isCoolingDown(JOB_ID, NOW + ladder[0]),
    false,
    'and the next refusal starts at the first rung: the streak went with it',
  );

  tracker.reset(JOB_ID + 1);
});

test('t296 AC3 — one job cooling down says nothing about the next one', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const tracker = new QuotaCooldownTracker();

  tracker.recordQuotaFailure(JOB_ID, undefined, NOW);

  assert.equal(tracker.isCoolingDown(JOB_ID, NOW), true);
  assert.equal(
    tracker.isCoolingDown(JOB_ID + 1, NOW),
    false,
    'the account is shared, but what is measured here is one job at a time — and holding ' +
      'the whole queue back on one job is a decision nobody took',
  );
});

test('t296 FR7 — a declared ladder overrides the default, and a nonsense one does not', async () => {
  const { QuotaCooldownTracker } = await loadModule();
  const ladder = await defaultLadder();

  const declared = new QuotaCooldownTracker([5_000]);
  declared.recordQuotaFailure(JOB_ID, undefined, NOW);
  assert.equal(declared.isCoolingDown(JOB_ID, NOW + 5_000), false, 'the override is honoured');

  // The same posture `resolvePreSessionFailureCeiling` has: what is not a usable
  // policy is "no override", never "no wait at all". An empty ladder read
  // literally would re-lease immediately, which is the loop this ticket closes.
  for (const nonsense of [[], [0], [-1], [Number.NaN]] as const) {
    const tracker = new QuotaCooldownTracker(nonsense);
    tracker.recordQuotaFailure(JOB_ID, undefined, NOW);
    assert.equal(
      tracker.isCoolingDown(JOB_ID, NOW + ladder[0] - 1),
      true,
      `${JSON.stringify(nonsense)} is not a policy: the default is what applies`,
    );
  }
});
