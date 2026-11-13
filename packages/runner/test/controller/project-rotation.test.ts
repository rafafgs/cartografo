/**
 * Acceptance tests of the round-robin across projects (t1112, AT9–AT13).
 *
 * The rotation is the one piece of scheduling a multi-project runner adds on
 * top of `Controller`, which it does not modify: one controller per project,
 * asked in turn. These cases drive it with fake controllers that record every
 * `tick()` and answer what the case scripts, so the order is the whole subject.
 *
 * English only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProjectRotation,
  type RotationMember,
} from '../../src/controller/project-rotation.ts';

/** Every `tick()` the fake controllers received, by project id, in order. */
type Ledger = number[];

/**
 * A fake controller of one project.
 *
 * @param projectId The project it stands for.
 * @param ledger Where each `tick()` is written down.
 * @param answer What a tick answers: `true` dispatches, `false` finds nothing,
 *   an `Error` rejects.
 */
function member(
  projectId: number,
  ledger: Ledger,
  answer: () => boolean | Error,
): RotationMember {
  return {
    projectId,
    controller: {
      tick: async () => {
        ledger.push(projectId);
        const outcome = answer();
        if (outcome instanceof Error) throw outcome;
        return outcome ? { jobId: projectId * 100, leaseId: projectId * 1000 } : null;
      },
    },
  };
}

/** The project id each pass dispatched on, or `null`. */
async function servedBy(
  rotation: ProjectRotation,
  members: readonly RotationMember[],
): Promise<number | null> {
  const outcome = await rotation.pass(members);
  return outcome === null ? null : outcome.projectId;
}

test('AT9 — three projects with work are served 1, 2, 3, 1, 2, 3', async () => {
  const ledger: Ledger = [];
  const members = [1, 2, 3].map((id) => member(id, ledger, () => true));
  const rotation = new ProjectRotation();

  const served: Array<number | null> = [];
  for (let pass = 0; pass < 6; pass += 1) served.push(await servedBy(rotation, members));

  assert.deepEqual(served, [1, 2, 3, 1, 2, 3]);
  assert.deepEqual(ledger, [1, 2, 3, 1, 2, 3], 'nobody was asked who did not serve');
});

test('AT10 — a project with no work is passed over without spending a turn', async () => {
  const ledger: Ledger = [];
  const members = [
    member(1, ledger, () => true),
    member(2, ledger, () => false),
    member(3, ledger, () => true),
  ];
  const rotation = new ProjectRotation();

  const served: Array<number | null> = [];
  const askedPerPass: number[][] = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = ledger.length;
    served.push(await servedBy(rotation, members));
    askedPerPass.push(ledger.slice(before));
  }

  assert.deepEqual(served, [1, 3, 1, 3]);
  for (const asked of askedPerPass) {
    assert.equal(new Set(asked).size, asked.length, `a project was asked twice in one pass: ${asked.join(',')}`);
  }
  assert.deepEqual(askedPerPass, [[1], [2, 3], [1], [2, 3]]);
});

test('AT11 — a project added mid-run is asked from the next pass, in id order', async () => {
  const ledger: Ledger = [];
  const first = [
    member(1, ledger, () => true),
    member(3, ledger, () => true),
    member(5, ledger, () => true),
  ];
  const rotation = new ProjectRotation();

  const served: Array<number | null> = [];
  for (let pass = 0; pass < 3; pass += 1) served.push(await servedBy(rotation, first));
  // Copies, because `deepEqual` narrows what it is handed to the expected type.
  assert.deepEqual([...served], [1, 3, 5]);

  // 4 appears; the cursor sits on 5, so the next pass wraps to 1, then 3, then
  // the newcomer, which an index-kept cursor would have skipped or repeated.
  const grown = [...first.slice(0, 2), member(4, ledger, () => true), first[2]];
  for (let pass = 0; pass < 5; pass += 1) served.push(await servedBy(rotation, grown));
  assert.deepEqual([...served], [1, 3, 5, 1, 3, 4, 5, 1]);

  // The members may arrive in any order: the rotation sorts by id.
  const shuffled = [grown[3], grown[0], grown[2], grown[1]];
  served.length = 0;
  for (let pass = 0; pass < 4; pass += 1) served.push(await servedBy(rotation, shuffled));
  assert.deepEqual(served, [3, 4, 5, 1]);
});

test('AT12 — a rejecting project reaches the caller and still spends its turn', async () => {
  const ledger: Ledger = [];
  const broken = new Error('the session failed');
  const members = [
    member(1, ledger, () => true),
    member(2, ledger, () => broken),
    member(3, ledger, () => true),
  ];
  const rotation = new ProjectRotation();

  assert.equal(await servedBy(rotation, members), 1);
  await assert.rejects(async () => await rotation.pass(members), (error: unknown) => error === broken);
  // The next pass starts AFTER the project that rejected.
  assert.equal(await servedBy(rotation, members), 3);
  assert.deepEqual(ledger, [1, 2, 3]);
});

test('AT13 — no projects, or none with work, gives null with each asked exactly once', async () => {
  const rotation = new ProjectRotation();
  assert.equal(await rotation.pass([]), null);

  const ledger: Ledger = [];
  const members = [1, 2, 3].map((id) => member(id, ledger, () => false));
  assert.equal(await rotation.pass(members), null);
  assert.deepEqual(ledger, [1, 2, 3]);

  ledger.length = 0;
  assert.equal(await rotation.pass(members), null);
  assert.deepEqual(ledger, [1, 2, 3], 'a pass with nothing served leaves the cursor where it was');
});

test('a stop between two projects ends the pass before the next one is asked', async () => {
  const ledger: Ledger = [];
  let stop = false;
  const members = [
    member(1, ledger, () => {
      stop = true;
      return false;
    }),
    member(2, ledger, () => true),
  ];
  const rotation = new ProjectRotation();

  assert.equal(await rotation.pass(members, () => stop), null);
  assert.deepEqual(ledger, [1]);
});
