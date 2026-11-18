/**
 * Acceptance tests for classifying the capability refusal (t1282, FR9).
 *
 * An unmapped level is a fact about the runner's environment, and it is the
 * same on every retry until somebody maps it: retrying up to the pre-session
 * ceiling would spend attempts on a cause that cannot change on its own. So it
 * classifies permanent, on the message prefix, like the permission refusal —
 * and a `SessionStartError` WITHOUT the prefix is classified exactly as before.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import { classifyPreSessionFailure } from '../../src/dispatch/pre-session-failure.ts';
import {
  PreSessionFailureTracker,
  handlePreSessionFailure,
} from '../../src/dispatch/pre-session-retry.ts';
import { SessionStartError } from '../../src/engine/types.ts';

const JOB = { id: 1282, current_node_id: 'draft', graph_version_id: 'sha256:cafe' };

const REFUSAL = new SessionStartError(
  'capability unmapped: codex advanced (set CODEX_MODEL_ADVANCED)',
);

test('t1282 AT24 — the reason names the node, the engine, the level and the variable', () => {
  const reason = classifyPreSessionFailure(REFUSAL, JOB);

  assert.ok(reason !== null, 'a permanent failure has a reason');
  for (const fact of ['draft', 'codex', 'advanced', 'CODEX_MODEL_ADVANCED']) {
    assert.ok(reason.includes(fact), `names ${fact}: ${reason}`);
  }
  assert.match(reason, /No session was opened/);
  assert.match(reason, /unblock/);
});

test('t1282 AT24 — a SessionStartError without the prefix classifies as before', () => {
  for (const message of [
    'could not start "claude": spawn claude ENOENT',
    'could not open a session',
    'the word capability unmapped: appears but not at the start',
  ]) {
    assert.equal(classifyPreSessionFailure(new SessionStartError(message), JOB), null, message);
  }
});

test('t1282 AT24 — at handler level the work is blocked on the first occurrence, with no retry count', async () => {
  const posted: Array<{ route: string; method: string; body: unknown }> = [];
  const call = (<T>(route: string, method: string, body?: unknown): Promise<T> => {
    posted.push({ route, method, body });
    return Promise.resolve(undefined as T);
  }) as ControlPlaneCall;
  const tracker = new PreSessionFailureTracker();

  const reason = await handlePreSessionFailure(REFUSAL, JOB, call, tracker, 5);

  assert.ok(reason !== null, 'the handler returns the reason it blocked with');
  const blocks = posted.filter((entry) => entry.route === `/v1/jobs/${String(JOB.id)}/blocks`);
  assert.equal(blocks.length, 1, 'blocked right away, on attempt one of five');
  assert.equal((blocks[0].body as { reason: string }).reason, reason);
  assert.equal(tracker.recordFailure(JOB.id), 1, 'and no streak was left behind');
});
