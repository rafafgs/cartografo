/**
 * Acceptance tests of the six states of a job (t415, RF-30 — AT1–AT8).
 *
 * The module under test is pure — no `Database`, no clock, no HTTP — in the same
 * spirit as `domain/custom-fields.ts` and `domain/intake.ts`: "what is this job
 * doing right now?" is a question over facts somebody else already read, and
 * answering it here is what lets the board publish a state no column stores
 * without a single extra query per row.
 *
 * The six names are Rafael's, decided on 2026-09-05, and they are born in
 * English: `awaiting_you`, `blocked_unasked`, `running`, `unowned`, `completed`,
 * `queued`.
 *
 * Two ambiguities are named by RF-30 itself and each has a case of its own here:
 * a pending question outranks the blocked flag (AT1), and an open session on a
 * final node is `running` and never `completed` (AT7).
 *
 * Repo convention (the same as `domain-custom-fields.test.ts`): the module is
 * imported on demand, after an explicit `existsSync`, so the initial red says
 * which artifact is missing instead of blowing up with ERR_MODULE_NOT_FOUND.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as JobStateModule from '../src/domain/job-state.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_RELATIVE = 'src/domain/job-state.ts';

let moduleCache: typeof JobStateModule | null = null;

async function loadJobState(): Promise<typeof JobStateModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_RELATIVE)),
    `artifact does not exist yet: packages/core/${MODULE_RELATIVE}`,
  );
  moduleCache ??= (await import(
    new URL(`../${MODULE_RELATIVE}`, import.meta.url).href
  )) as typeof JobStateModule;
  return moduleCache;
}

/** The instant every case below is derived against. */
const NOW = '2026-09-06T12:00:00.000Z';

/** When the job was created — the fallback `state_since` of a job with no log. */
const BORN = '2026-09-06T09:00:00.000Z';

/** The arrival transition of a job that walked once. */
const ARRIVED = '2026-09-06T10:00:00.000Z';

/** The `job.blocked` event of a job somebody stopped. */
const STOPPED = '2026-09-06T10:30:00.000Z';

/** The `finished_at` of a session that reported what its contract declares. */
const REPORTED = '2026-09-06T11:30:00.000Z';

/** When the question was asked. */
const ASKED = '2026-09-06T11:00:00.000Z';

/** When the runner took the job. */
const TAKEN = '2026-09-06T11:45:00.000Z';

/**
 * A job doing nothing at all, as a base for each case to change one fact of.
 *
 * `redigir` is not in `final_nodes`, nothing is pending, nothing is leased and
 * nothing is open: on its own it is the `queued` of AT8.
 */
function facts(overrides: Partial<JobStateModule.JobStateFacts> = {}): JobStateModule.JobStateFacts {
  return {
    blocked: false,
    currentNodeId: 'redigir',
    createdAt: BORN,
    now: NOW,
    pendingQuestion: null,
    blockedAt: null,
    activeLease: null,
    hasOpenSession: false,
    finalNodes: ['revisar'],
    currentNodePinsSkill: false,
    conformingFinishAt: null,
    lastTransitionAt: null,
    ...overrides,
  };
}

test('AT1 — a pending question outranks the blocked flag (ambiguity 1)', async () => {
  const { deriveJobState } = await loadJobState();

  // Both facts at once is the ORDINARY case and not a corner: `POST
  // /v1/input-requests` blocks the owning job in the same transaction that
  // creates the question (t106), so every real escalation is a blocked job with
  // something pending. A board that read the flag first would file all of them
  // under "blocked", and nobody would ever be told a person is what is missing.
  const derived = deriveJobState(
    facts({ blocked: true, blockedAt: STOPPED, pendingQuestion: { created_at: ASKED } }),
  );

  assert.equal(derived.state, 'awaiting_you');
  assert.equal(
    derived.state_since,
    ASKED,
    'the wait started when the question was asked, not when the flag went up',
  );
});

test('AT2 — blocked with nothing pending is blocked_unasked, since the block event', async () => {
  const { deriveJobState } = await loadJobState();

  const derived = deriveJobState(facts({ blocked: true, blockedAt: STOPPED }));

  assert.equal(derived.state, 'blocked_unasked');
  assert.equal(derived.state_since, STOPPED, 'the last `job.blocked` of the log');

  const neverRecorded = deriveJobState(facts({ blocked: true, blockedAt: null }));
  assert.equal(
    neverRecorded.state_since,
    BORN,
    'a flag with no event behind it falls back to the birth of the job, never to `undefined`',
  );
});

test('AT3 — an open session under a live lease is running, since the grant', async () => {
  const { deriveJobState } = await loadJobState();

  const derived = deriveJobState(
    facts({
      hasOpenSession: true,
      activeLease: { granted_at: TAKEN, expires_at: '2026-09-06T12:15:00.000Z' },
    }),
  );

  assert.equal(derived.state, 'running');
  assert.equal(derived.state_since, TAKEN, 'it has been running since the runner took it');
});

test('AT4 — an open session past its lease deadline is unowned, on the deadline alone', async () => {
  const { deriveJobState } = await loadJobState();

  // The lease fact carries `granted_at` and `expires_at` and NOTHING else — no
  // `status` to consult. That is the whole point of `unowned`: no sweep exists
  // to flip the column, so the row still reads `active` while its deadline is
  // an hour behind. A state derived from the column would report `running` for
  // a job whose runner died.
  const derived = deriveJobState(
    facts({
      hasOpenSession: true,
      activeLease: { granted_at: TAKEN, expires_at: '2026-09-06T11:50:00.000Z' },
    }),
  );

  assert.equal(derived.state, 'unowned');
  assert.equal(
    derived.state_since,
    '2026-09-06T11:50:00.000Z',
    'it has been ownerless since the deadline passed, not since the grant',
  );
});

test('AT5 — arriving at a final node that pins nothing is completed, at the arrival', async () => {
  const { deriveJobState } = await loadJobState();

  const derived = deriveJobState(
    facts({ currentNodeId: 'revisar', currentNodePinsSkill: false, lastTransitionAt: ARRIVED }),
  );

  assert.equal(derived.state, 'completed');
  assert.equal(
    derived.state_since,
    ARRIVED,
    'arrival IS the last transition: `current_node_id` is the `to_node_id` of that event',
  );
});

test('AT6 — a final pinned node with a conforming finish is completed, at the finish', async () => {
  const { deriveJobState } = await loadJobState();

  const derived = deriveJobState(
    facts({
      currentNodeId: 'revisar',
      currentNodePinsSkill: true,
      conformingFinishAt: REPORTED,
      lastTransitionAt: ARRIVED,
    }),
  );

  assert.equal(derived.state, 'completed');
  assert.equal(
    derived.state_since,
    REPORTED,
    'the work ended when the pinned skill reported, not when the job landed on the node',
  );
});

test('AT7 — an open leased session on a final pinned node is running, never completed (ambiguity 2)', async () => {
  const { deriveJobState } = await loadJobState();

  const derived = deriveJobState(
    facts({
      currentNodeId: 'revisar',
      currentNodePinsSkill: true,
      conformingFinishAt: null,
      lastTransitionAt: ARRIVED,
      hasOpenSession: true,
      activeLease: { granted_at: TAKEN, expires_at: '2026-09-06T12:15:00.000Z' },
    }),
  );

  assert.equal(
    derived.state,
    'running',
    'the last node is being worked on: a board that called it done would hide the one session that matters',
  );
  assert.equal(derived.state_since, TAKEN);
});

test('AT8 — anything else is queued, since the last transition or since birth', async () => {
  const { deriveJobState } = await loadJobState();

  const walked = deriveJobState(facts({ lastTransitionAt: ARRIVED }));
  assert.equal(walked.state, 'queued');
  assert.equal(walked.state_since, ARRIVED, 'it has been waiting since it arrived where it stands');

  const born = deriveJobState(facts());
  assert.equal(born.state, 'queued');
  assert.equal(born.state_since, BORN, 'a job that never transitioned has waited since it was created');

  // A final pinned node whose skill has not reported and which nobody is
  // running: it arrived, and it is waiting for the dispatch of its last step.
  const arrivedUnworked = deriveJobState(
    facts({ currentNodeId: 'revisar', currentNodePinsSkill: true, lastTransitionAt: ARRIVED }),
  );
  assert.equal(arrivedUnworked.state, 'queued');
  assert.equal(arrivedUnworked.state_since, ARRIVED);

  // A version that no longer resolves is read as no graph at all — the same
  // silence `isAtFinalNode` already keeps for `completed`.
  const noGraph = deriveJobState(
    facts({ currentNodeId: 'revisar', finalNodes: null, lastTransitionAt: ARRIVED }),
  );
  assert.equal(noGraph.state, 'queued', 'no graph to arrive at is not an arrival');

  // An open session with NO lease behind it is not `running`: RF-30 defines
  // both moving states in terms of the lease, and a session nobody holds says
  // nothing about who is working.
  const unleased = deriveJobState(facts({ hasOpenSession: true, lastTransitionAt: ARRIVED }));
  assert.equal(unleased.state, 'queued');

  // And a lease with no open session is not `running` either: the dispatch may
  // have been granted and never started.
  const unopened = deriveJobState(
    facts({
      activeLease: { granted_at: TAKEN, expires_at: '2026-09-06T12:15:00.000Z' },
      lastTransitionAt: ARRIVED,
    }),
  );
  assert.equal(unopened.state, 'queued');
});
