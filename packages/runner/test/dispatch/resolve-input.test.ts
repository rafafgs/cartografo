/**
 * Acceptance test for the merge of the two places an input comes from (t440).
 *
 * `createMergedInputResolver` composes the control plane's projection —
 * everything the server has a log for, `GET /v1/jobs/:id/context` — with what
 * only this machine knows (`resolve-executor-environment.ts`). Until t440 it
 * called the two of them blind and independently, which was right while the
 * machine half read nothing but the `Job` row.
 *
 * The interview broke that symmetry. The fact the executor environment now
 * needs — *what path or URL did the person name for their existing skills* —
 * exists only inside the projection's own `input.interview.skill_source`, put
 * there by a turn that reported it (`docs/spec/interview.md` §2). There were two
 * ways to get at it: fetch the same context route a second time, from inside the
 * environment resolver, or hand over the answer the merge already has. The first
 * reads one fact twice and can race with itself; this file pins the second.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type { ClaudeCodeDispatchOptions, Job } from '../../src/dispatch/options.ts';
import { createMergedInputResolver } from '../../src/dispatch/resolve-input.ts';
import type { ResolvedNode } from '../../src/dispatch/resolve-node.ts';

/** The work and the node, in the slice this merge reads: it passes both through. */
const JOB = Object.freeze({
  id: 440,
  title: 'a map for the work I keep doing by hand',
  body: null,
  current_node_id: 'interview',
  blocked: false,
  execution_id: null,
}) as unknown as Job;

const RESOLVED = Object.freeze({ node: { id: 'interview' }, edges: [] }) as unknown as ResolvedNode;

/** A control plane nothing here talks to: both halves of the merge are supplied. */
const NEVER_CALLED: ControlPlaneCall = () => {
  throw new Error('the projection was supplied: this merge has no route to call');
};

test('t440 AT — the executor environment is handed the projection the merge just read', async () => {
  const projected = {
    job: { id: 440, title: 'a map for the work I keep doing by hand' },
    interview: {
      done: false,
      draft: { graph: { problem_class: 'code-review' }, skills: [] },
      skill_source: { kind: 'path', location: '/Users/rafael/skills' },
    },
  };

  const seen: Record<string, unknown>[] = [];
  let projectionCalls = 0;

  const resolveInput = createMergedInputResolver(
    {
      resolveInput: () => {
        projectionCalls += 1;
        return Promise.resolve(projected);
      },
      executorEnvironment: (
        _job: Job,
        _resolved: ResolvedNode,
        projection: Record<string, unknown>,
      ) => {
        seen.push(projection);
        return Promise.resolve({ environment: { skill_drafts: [{ id: 'code-review' }] } });
      },
    } as unknown as ClaudeCodeDispatchOptions,
    NEVER_CALLED,
  );

  const input = await resolveInput(JOB, RESOLVED);

  assert.equal(seen.length, 1, 'the environment is resolved once per dispatch');
  assert.deepEqual(
    seen[0],
    projected,
    'the machine half is given the projection itself, not a second read of the same route',
  );
  assert.equal(projectionCalls, 1, 'and that projection is fetched exactly once');

  // The merge itself is unchanged: everything the projection carried is there,
  // and the executor's keys go in last and win.
  assert.deepEqual(input.job, projected.job);
  assert.deepEqual(input.interview, projected.interview);
  assert.deepEqual(input.environment, { skill_drafts: [{ id: 'code-review' }] });
});

test('t440 AT — a dispatch with no executor environment still merges the projection', async () => {
  const resolveInput = createMergedInputResolver(
    {
      resolveInput: () => Promise.resolve({ job: { id: 440 }, interview: { done: true } }),
    } as unknown as ClaudeCodeDispatchOptions,
    NEVER_CALLED,
  );

  assert.deepEqual(
    await resolveInput(JOB, RESOLVED),
    { job: { id: 440 }, interview: { done: true } },
    'the default contributes nothing, exactly as it did before this seam grew a parameter',
  );
});
