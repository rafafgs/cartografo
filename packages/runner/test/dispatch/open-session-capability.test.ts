/**
 * Acceptance test for posting the capability when a session opens (t1282, FR11).
 *
 * The body of `POST /v1/sessions` carries `capability` when the spec asked for
 * one, and has no such key otherwise: an old control plane never sees a field
 * it has not heard of, and a new one reads absence as `null`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import { openSession, type OpeningSpec } from '../../src/dispatch/open-session.ts';

const JOB = { id: 1282, current_node_id: 'draft' };

const SPEC: OpeningSpec = {
  workingDir: '/tmp/worktree',
  prompt: 'write the note',
  timeoutSeconds: 600,
  silenceSeconds: 120,
};

/** Records the body it was given and answers a session row. */
function recorder(): { call: ControlPlaneCall; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const call = (<T>(_route: string, _method: string, body?: unknown): Promise<T> => {
    bodies.push(body as Record<string, unknown>);
    return Promise.resolve({ id: 1 } as T);
  }) as ControlPlaneCall;
  return { call, bodies };
}

test('t1282 AT14 — a spec with a capability posts it; a spec without one posts no such key', async () => {
  const withCapability = recorder();
  await openSession(withCapability.call, JOB, 'claude-code', null, {
    ...SPEC,
    capability: 'advanced',
  } as OpeningSpec);
  assert.equal(withCapability.bodies[0].capability, 'advanced');

  const without = recorder();
  await openSession(without.call, JOB, 'claude-code', null, SPEC);
  assert.equal(Object.hasOwn(without.bodies[0], 'capability'), false, 'no key at all');
  assert.deepEqual(Object.keys(without.bodies[0]).sort(), [
    'engine',
    'engine_session_ref',
    'job_id',
    'node_id',
    'prompt',
    'silence_seconds',
    'timeout_seconds',
    'working_dir',
  ]);
});
