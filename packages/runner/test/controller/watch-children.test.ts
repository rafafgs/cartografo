/**
 * Acceptance tests of the children watcher (t638, AT26–AT28, AT30).
 *
 * A parent held by its children is never leased, so nothing in the dispatch
 * ever looks at it while it waits. A child that is blocked or cancelled never
 * reaches a final node, and the parent's hold never clears — the parent would
 * sit there, silently, forever. The watcher is the one place that notices: once
 * per tick it blocks such a parent with a reason naming the child. It never
 * advances, unblocks or cancels anything.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { GraphVersion, Job } from '../../src/controller/control-plane-client.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';
import type * as WatchModule from '../../src/controller/watch-children.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/controller/watch-children.ts';

async function loadWatch(): Promise<typeof WatchModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(new URL(`../../${MODULE_PATH}`, import.meta.url).href)) as typeof WatchModule;
}

const PARENT_VERSION = 'sha256:caller';
const PLAIN_VERSION = 'sha256:plain';

/** A job of the board, with the relation fields the watcher reads. */
function job(id: number, extra: Partial<Job> = {}): Job {
  return {
    id,
    title: `job ${id}`,
    current_node_id: 'redigir',
    blocked: false,
    completed: false,
    execution_id: 1,
    graph_version_id: 'sha256:child',
    dispatch_hold: null,
    children: [],
    parent_job_id: null,
    parent_node_id: null,
    cancelled_at: null,
    block_reason: null,
    ...extra,
  };
}

/** A parent on `write-notes` with three children; the child at `problem` (1-based) is overridden. */
function board(problem: number | null, childExtra: Partial<Job> = {}, parentExtra: Partial<Job> = {}) {
  const children = [11, 12, 13].map((id, index) =>
    job(id, {
      parent_job_id: 1,
      parent_node_id: 'write-notes',
      completed: index === 0,
      ...(problem === index + 1 ? childExtra : {}),
    }),
  );
  const parent = job(1, {
    current_node_id: 'write-notes',
    graph_version_id: PARENT_VERSION,
    dispatch_hold: 'children',
    children: [11, 12, 13],
    ...parentExtra,
  });
  return [parent, ...children];
}

function snapshot(id: string, nodeType: string): GraphVersion {
  return {
    id,
    graph_id: 'g',
    parent_version: null,
    source: 'test',
    proposal_id: null,
    created_at: 'x',
    snapshot: {
      nodes: [
        { id: 'write-notes', node_type: nodeType },
        { id: 'redigir', node_type: 'work' },
      ],
      edges: [],
    },
  };
}

/** A fake client for the watcher: the board is mutable, every block is recorded. */
function fakeClient(jobs: Job[]) {
  const blocks: Array<{ id: number; reason: string }> = [];
  const versionReads: string[] = [];
  const client = {
    listJobs: async () => jobs,
    getGraphVersion: async (id: string) => {
      versionReads.push(id);
      return snapshot(id, id === PARENT_VERSION ? 'subgraph' : 'work');
    },
    blockJob: async (id: number, reason: string) => {
      blocks.push({ id, reason });
      const target = jobs.find((candidate) => candidate.id === id);
      if (target !== undefined) {
        target.blocked = true;
        target.block_reason = reason;
      }
    },
  };
  return { client, blocks, versionReads };
}

test('t638 AT26 — a blocked child blocks its held parent once, with a reason naming it', async () => {
  const { createChildrenWatcher } = await loadWatch();
  const jobs = board(2, { blocked: true, block_reason: 'the skill is not in the registry' });
  const { client, blocks } = fakeClient(jobs);
  const watch = createChildrenWatcher(client, 1);

  await watch();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].id, 1);
  const reason = blocks[0].reason;
  for (const part of ['write-notes', '12', '2 of 3', 'the skill is not in the registry']) {
    assert.ok(reason.includes(part), `the reason names ${part}: ${reason}`);
  }

  await watch();
  assert.equal(blocks.length, 1, 'a parent already blocked is not blocked again');
});

test('t638 AT27 — a cancelled child blocks the parent with a reason saying so', async () => {
  const { createChildrenWatcher } = await loadWatch();
  const { client, blocks } = fakeClient(board(3, { cancelled_at: '2026-10-10T08:00:00.000Z' }));

  await createChildrenWatcher(client, 1)();
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].reason.includes('13'), blocks[0].reason);
  assert.ok(blocks[0].reason.includes('3 of 3'), blocks[0].reason);
  assert.ok(/cancelled/.test(blocks[0].reason), blocks[0].reason);
});

test('t638 AT28 — no problem child, or a parent on a non-subgraph node, means no write', async () => {
  const { createChildrenWatcher } = await loadWatch();

  const quiet = fakeClient(board(null));
  await createChildrenWatcher(quiet.client, 1)();
  assert.deepEqual(quiet.blocks, []);

  // A manual parent link elsewhere: the job waits on children, one of them is
  // stuck, and the node it stands on is not a call. It is not the watcher's.
  const manual = fakeClient(
    board(2, { blocked: true, block_reason: 'stuck' }, { graph_version_id: PLAIN_VERSION }),
  );
  await createChildrenWatcher(manual.client, 1)();
  assert.deepEqual(manual.blocks, []);
  assert.deepEqual(manual.versionReads, [PLAIN_VERSION]);

  // Neither a blocked nor a cancelled parent is touched, whatever its children do.
  for (const parentExtra of [{ blocked: true }, { cancelled_at: 'x', dispatch_hold: 'cancelled' }]) {
    const settled = fakeClient(board(2, { blocked: true, block_reason: 'stuck' }, parentExtra));
    await createChildrenWatcher(settled.client, 1)();
    assert.deepEqual(settled.blocks, []);
  }
});

test('t638 AT30 — a watcher that throws is recorded and the tick still dispatches', async () => {
  const controllerModule = (await import(
    new URL('../../src/controller/controller.ts', import.meta.url).href
  )) as typeof ControllerModule;

  const lease = { id: 7, job_id: 2 };
  const client = {
    listReleasedJobs: async () => [job(2)],
    requestLease: async () => ({ lease }),
    heartbeat: async () => lease,
    release: async () => lease,
  } as unknown as ControllerModule.ControllerOptions['client'];

  const failure = new Error('GET /v1/jobs answered 503');
  let watched = 0;
  const dispatched: number[] = [];
  const controller = new controllerModule.Controller({
    client,
    runnerId: 'runner-a',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 6,
    watchChildren: async () => {
      watched += 1;
      throw failure;
    },
    dispatch: async (jobId: number) => {
      dispatched.push(jobId);
      return { blocked: false };
    },
  });

  assert.deepEqual(await controller.tick(), { jobId: 2, leaseId: 7 });
  assert.equal(watched, 1, 'the watcher runs at the start of the tick');
  assert.equal(controller.lastWatchError, failure);
  assert.deepEqual(dispatched, [2]);
});
