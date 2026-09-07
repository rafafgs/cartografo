/**
 * Acceptance test for the seventh write that stops a work (t423, FR3).
 *
 * `blocks.ts` has had no test file of its own: the six functions that were
 * there arrived as a split out of `report.ts` and kept their tests where they
 * were, in `report.test.ts`, reached through that module's re-exports. The
 * seventh gets a file instead of a thirteenth case over there, on purpose —
 * `report.ts` is the surface a sibling ficha (t424) is expected to edit, and
 * two tickets writing into one test file is exactly the conflict this project
 * schedules around.
 *
 * Same harness as `report.test.ts`'s block cases: the function takes its client
 * as a parameter, so a fake `call` that records what it was handed is the whole
 * rig.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type * as BlocksModule from '../../src/dispatch/blocks.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/blocks.ts';

let cache: typeof BlocksModule | null = null;

/** Imports the module under test, failing with its path while it does not exist. */
async function loadBlocks(): Promise<typeof BlocksModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/blocks.ts', import.meta.url).href
  )) as typeof BlocksModule;
  return cache;
}

/** One call the fake client was handed. */
interface Sent {
  route: string;
  method: string;
  body: unknown;
}

/** A fake `call` that records every request and never refuses. */
function recorder(): { sent: Sent[]; call: ControlPlaneCall } {
  const sent: Sent[] = [];
  const call = <T>(route: string, method: string, body?: unknown): Promise<T> => {
    sent.push({ route, method, body });
    return Promise.resolve(undefined as T);
  };
  return { sent, call };
}

/** The work every case below is about. */
const JOB = { id: 7, current_node_id: 'implementar' };

test('t423 AT — `blockForArtifactRefusal` names the node, the session and every problem', async () => {
  const { blockForArtifactRefusal } = await loadBlocks();
  const { sent, call } = recorder();
  const problems = [
    '`relatorio`: `../../etc/passwd` resolves outside the session worktree',
    '`evidencia`: `never-written.txt` does not exist in the session worktree',
  ];

  const reason = await blockForArtifactRefusal(call, JOB, 41, problems);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');

  const posted = sent[0].body as { reason: string; actor: unknown };
  assert.equal(
    posted.reason,
    reason,
    'the runner may not tell the API one story and its caller another',
  );
  assert.ok(
    posted.reason.includes(JOB.current_node_id),
    `the node is missing from: ${posted.reason}`,
  );
  assert.ok(
    posted.reason.includes('41'),
    `the session is what a reader opens next: ${posted.reason}`,
  );
  for (const problem of problems) {
    assert.ok(posted.reason.includes(problem), `missing "${problem}" from: ${posted.reason}`);
  }
  assert.deepEqual(posted.actor, { type: 'system', ref: 'runner' });
});

test('t423 AT — a refusal with no detail still posts a reason somebody can act on', async () => {
  const { blockForArtifactRefusal } = await loadBlocks();
  const { sent, call } = recorder();

  const reason = await blockForArtifactRefusal(call, JOB, 41, []);

  assert.equal(sent.length, 1);
  assert.ok(reason.length > 0, 'an empty block reason is a work stopped for no stated cause');
  assert.ok(reason.includes('implementar'), reason);
});
