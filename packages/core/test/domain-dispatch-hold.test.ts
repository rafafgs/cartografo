/**
 * Acceptance tests of the dispatch hold (t636, AT1–AT3).
 *
 * The hold is the answer to "may this job be handed to a runner right now?",
 * and like the six states of `domain/job-state.ts` it is derived, never stored:
 * a pure function over facts somebody else read in one batch. These cases state
 * its priority order and the one rule that is easy to get wrong — only a
 * related job that COMPLETED releases a hold; a cancelled one does not (FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as JobStateModule from '../src/domain/job-state.ts';

/** The function under test, loaded on demand so the red names what is missing. */
async function loadDerive(): Promise<typeof JobStateModule.deriveDispatchHold> {
  const loaded = (await import(
    new URL('../src/domain/job-state.ts', import.meta.url).href
  )) as Partial<typeof JobStateModule>;
  assert.equal(
    typeof loaded.deriveDispatchHold,
    'function',
    'artifact does not exist yet: deriveDispatchHold in packages/core/src/domain/job-state.ts',
  );
  return loaded.deriveDispatchHold as typeof JobStateModule.deriveDispatchHold;
}

const OPEN = { completed: false, cancelled: false };
const DONE = { completed: true, cancelled: false };
const CANCELLED = { completed: false, cancelled: true };

test('t636 AT1 — cancelled outranks dependencies, which outrank children', async () => {
  const derive = await loadDerive();

  assert.equal(
    derive({ cancelled: true, dependencies: [OPEN], children: [OPEN] }),
    'cancelled',
  );
  assert.equal(
    derive({ cancelled: false, dependencies: [OPEN, DONE], children: [OPEN] }),
    'dependencies',
  );
  assert.equal(
    derive({ cancelled: false, dependencies: [DONE], children: [DONE, OPEN] }),
    'children',
  );
  assert.equal(derive({ cancelled: false, dependencies: [DONE], children: [DONE] }), null);
});

test('t636 AT2 — a cancelled dependency or child still holds: only completed releases', async () => {
  const derive = await loadDerive();

  assert.equal(
    derive({ cancelled: false, dependencies: [CANCELLED], children: [] }),
    'dependencies',
    'a dependency that was abandoned never did the work the dependent waits for',
  );
  assert.equal(
    derive({ cancelled: false, dependencies: [], children: [DONE, CANCELLED] }),
    'children',
    'a cancelled child keeps its parent held until somebody decides what the parent does',
  );
});

test('t636 AT3 — a job with no relations and no cancellation has no hold', async () => {
  const derive = await loadDerive();
  assert.equal(derive({ cancelled: false, dependencies: [], children: [] }), null);
});
