/**
 * Acceptance tests for the capability reaching the `SessionSpec` (t1282, FR5).
 *
 * `buildSessionSpec` adds one more conditional spread. The point of a spread
 * and not an assignment is the same as for `model`: an absent capability is an
 * absent KEY, because the adapters read absence, and a `capability: undefined`
 * that survived into the spec is a different object from the one built before
 * this field existed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type { Job } from '../../src/dispatch/options.ts';
import type { GraphNode, ResolvedNode } from '../../src/dispatch/resolve-node.ts';
import { buildSessionSpec } from '../../src/dispatch/session-spec.ts';

const JOB: Job = {
  id: 1282,
  title: 'write the note',
  current_node_id: 'draft',
  blocked: false,
  execution_id: 5,
};

const CONFIG = {
  workingDir: '/tmp/worktree',
  instructions: 'Write the note.',
  timeoutSeconds: 600,
  silenceSeconds: 120,
};

/** Answers the two reads the builder makes with empty lists. */
const call = (<T>(route: string): Promise<T> =>
  Promise.resolve(
    (route.includes('/events') ? { events: [] } : { input_requests: [] }) as T,
  )) as ControlPlaneCall;

function resolved(node: Record<string, unknown>, graphCapability?: unknown): ResolvedNode {
  return {
    versionId: 'sha256:cafe',
    node: { id: 'draft', role: 'writer', node_type: 'work', ...node } as GraphNode,
    edges: [],
    ...(graphCapability === undefined ? {} : { graphCapability }),
  } as ResolvedNode;
}

test('t1282 AT13 — the spec carries the resolved capability, and has no key when there is none', async () => {
  const asked = await buildSessionSpec(call, JOB, resolved({ capability: 'advanced' }), CONFIG);
  assert.equal(asked.capability, 'advanced');

  const inherited = await buildSessionSpec(call, JOB, resolved({}, 'general'), CONFIG);
  assert.equal(inherited.capability, 'general', 'the graph-level one reaches the spec too');

  const none = await buildSessionSpec(call, JOB, resolved({}), CONFIG);
  assert.equal(Object.hasOwn(none, 'capability'), false, 'no capability: no key');

  // The whole spec, as built before this change for the same inputs.
  assert.deepEqual(none, {
    workingDir: '/tmp/worktree',
    instructions: 'Write the note.',
    prompt: none.prompt,
    timeoutSeconds: 600,
    silenceSeconds: 120,
  });
  const noGraph = await buildSessionSpec(call, JOB, null, CONFIG);
  assert.equal(Object.hasOwn(noGraph, 'capability'), false, 'a work with no graph: no key');

  const shell = await buildSessionSpec(call, JOB, resolved({ engine: 'shell' }, 'general'), CONFIG);
  assert.equal(Object.hasOwn(shell, 'capability'), false, 'a shell node never gets one');
});
