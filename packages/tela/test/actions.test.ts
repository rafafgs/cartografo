/**
 * Acceptance tests for the proposal state machine (AT8–AT12).
 *
 * `resolveActionsForStatus` is the single place that decides which buttons a
 * proposal row offers. It is a pure function on purpose: the browser has no
 * test harness here, so the rule that must never be wrong — never offer an
 * action the API would refuse with `409` — is the one piece that runs in Node.
 *
 * The unknown-status case (AT12) is the load-bearing one: the core owns the
 * status vocabulary and will grow it (`t112` writes `resultado`), so the screen
 * has to degrade to read-only instead of throwing in the middle of a render.
 *
 * Status names stay in Portuguese because they are DB enum values the API
 * publishes verbatim (t127, FR8). Action names, on the other hand, ARE the route:
 * `approve` here is literally the path of `POST /v1/proposals/:id/approve`, so
 * they were renamed with the rest of the `/v1` surface (t127, FR3/FR4).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ActionsModule from '../src/public/actions.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const ACTIONS_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'actions.js');

let cache: typeof ActionsModule | null = null;

async function loadActions(): Promise<typeof ActionsModule> {
  assert.ok(existsSync(ACTIONS_PATH), 'artifact does not exist yet: packages/tela/src/public/actions.js');
  cache ??= (await import(
    new URL('../src/public/actions.js', import.meta.url).href
  )) as typeof ActionsModule;
  return cache;
}

test('AT8 — a pending proposal offers approve and reject, in that order', async () => {
  const { resolveActionsForStatus } = await loadActions();
  assert.deepEqual(resolveActionsForStatus('pendente'), ['approve', 'reject']);
});

test('AT9 — an approved proposal offers only apply', async () => {
  const { resolveActionsForStatus } = await loadActions();
  assert.deepEqual(resolveActionsForStatus('aprovada'), ['apply']);
});

test('AT10 — an applied proposal offers only revert', async () => {
  const { resolveActionsForStatus } = await loadActions();
  assert.deepEqual(resolveActionsForStatus('aplicada'), ['revert']);
});

test('AT11 — reverted and rejected proposals are read-only', async () => {
  const { resolveActionsForStatus } = await loadActions();
  assert.deepEqual(resolveActionsForStatus('revertida'), []);
  assert.deepEqual(resolveActionsForStatus('rejeitada'), []);
});

test('AT12 — an unknown status fails safe: no actions, no throw', async () => {
  const { resolveActionsForStatus } = await loadActions();

  assert.deepEqual(resolveActionsForStatus('status-desconhecido'), []);
  // The core may grow the vocabulary at any time; a row must still render.
  for (const input of ['', 'PENDENTE', undefined, null, 42, {}]) {
    assert.deepEqual(
      resolveActionsForStatus(input as string),
      [],
      `status ${JSON.stringify(input)} should degrade to read-only, not throw`,
    );
  }
});

test('AT12 — every offered action carries the label and route its row needs', async () => {
  const { ACTIONS, resolveActionsForStatus } = await loadActions();

  const offered = new Set([
    ...resolveActionsForStatus('pendente'),
    ...resolveActionsForStatus('aprovada'),
    ...resolveActionsForStatus('aplicada'),
  ]);

  for (const action of offered) {
    const descriptor = ACTIONS[action];
    assert.ok(descriptor !== undefined, `action "${action}" has no descriptor in ACTIONS`);
    assert.equal(descriptor.route, action, 'the core route is POST /v1/proposals/:id/<action>');
    assert.ok(descriptor.label.length > 0, `action "${action}" has no visible label`);
  }

  // FR7: reject and revert take a mandatory reason; approve and apply do not.
  assert.equal(ACTIONS.reject.requiresReason, true);
  assert.equal(ACTIONS.revert.requiresReason, true);
  assert.equal(ACTIONS.approve.requiresReason, false);
  assert.equal(ACTIONS.apply.requiresReason, false);
});
