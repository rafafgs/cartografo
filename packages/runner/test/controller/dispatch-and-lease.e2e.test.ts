/**
 * End-to-end acceptance test of the lease cycle (t103, AT17) — D5's central
 * scenario: "dispatched work carries a lease; a dead runner expires and the
 * work goes back to the queue".
 *
 * There is no injected clock here and no repository called by hand: the real
 * control plane comes up as a child process (same pattern as
 * `packages/core/test/startup.test.ts`), and two `Controller`s compete for the
 * same work over HTTP. Time is real time, and every wait has a deadline of its
 * own with an explicit message — no `sleep` hoping for the best, on the same
 * discipline as `packages/runner/src/engine/conformance-kit.ts`.
 *
 * The runner imports NOTHING from the core: the control plane is a process, and
 * the only surface between the two is the HTTP door. It is D1 being exercised,
 * not just declared — and it is what lets this file pass the AT19 gate.
 *
 * `GET /v1/jobs` is t102's and did not exist yet: ONLY that one is simulated,
 * by a `fetch` that intercepts the path and delegates everything else to the
 * real control plane. The whole lease path — grant, expire, claim, re-grant —
 * is real HTTP against the real server.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { bootCore } from '@cartografo/test-support';

import type * as ClientModule from '../../src/controller/control-plane-client.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The work both runners will apply for. */
const JOB_ID = 4242;
/** TTL of the lease. One second is the smallest term `ttl_segundos` expresses. */
const TTL_SECONDS = 1;
/** Deadline for the re-queueing wait. Wide slack over the TTL, on purpose. */
const DEADLINE_MS = 30_000;

interface LeaseRow {
  id: number;
  runner_id: string;
  job_id: number;
  status: string;
  expiration_reason: string | null;
}

let clientCache: typeof ClientModule | null = null;
let controllerCache: typeof ControllerModule | null = null;

async function loadClient(): Promise<typeof ClientModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'controller', 'control-plane-client.ts')),
    'artifact does not exist yet: packages/runner/src/controller/control-plane-client.ts',
  );
  clientCache ??= (await import(
    new URL('../../src/controller/control-plane-client.ts', import.meta.url).href
  )) as typeof ClientModule;
  return clientCache;
}

async function loadController(): Promise<typeof ControllerModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'controller', 'controller.ts')),
    'artifact does not exist yet: packages/runner/src/controller/controller.ts',
  );
  controllerCache ??= (await import(
    new URL('../../src/controller/controller.ts', import.meta.url).href
  )) as typeof ControllerModule;
  return controllerCache;
}

/**
 * A `fetch` that answers `GET /v1/jobs` with a fixed queue and delegates ALL
 * the rest to the real control plane.
 *
 * The route has really existed since t102 merged, but stays simulated on
 * purpose: what AT17 proves is the lease cycle under real time, and seeding the
 * queue over HTTP would make the test fail on a t102 contract change rather
 * than on a lease regression. Whoever wires the cycle end to end (t106/t109) is
 * who swaps this simulation for the real queue.
 */
function fetchWithSeededQueue(): typeof fetch {
  return async (input, init) => {
    if (String(input).endsWith('/v1/jobs')) {
      return new Response(
        JSON.stringify({
          jobs: [
            {
              id: JOB_ID,
              title: 'trabalho disputado',
              current_node_id: 'implementar',
              blocked: false,
              // Derived by the control plane and read by the client since t161:
              // a work standing on a final node stops being a candidate. The
              // real route has always answered it; this simulation has to as
              // well, or the queue it seeds is one the client throws away.
              completed: false,
              execution_id: 1,
              graph_version_id: 'sha256:e2e',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return fetch(input, init);
  };
}

test('AT17 — a runner dies, the lease expires and the other runner takes the same work', async (t) => {
  const { ControlPlaneClient } = await loadClient();
  const { Controller } = await loadController();

  const { url: urlBase, token } = await bootCore(t);
  const doFetch = fetchWithSeededQueue();

  // The token is the bootstrap credential, not a runner-scoped one, and stays
  // that way on purpose: what this test needs is the minimum to keep speaking
  // to an API that no longer answers anonymously, and the scenario below is
  // about a lease outliving its owner — not about who authenticated. The
  // runner credential that t143 mints at pairing is exercised end to end in
  // `cross-machine-dispatch.e2e.test.ts`.
  const clientA = new ControlPlaneClient({ urlBase, fetchImpl: doFetch, token });
  const clientB = new ControlPlaneClient({ urlBase, fetchImpl: doFetch, token });
  await clientA.registerRunner('runner-a', 'the one that dies');
  await clientB.registerRunner('runner-b', 'the one that inherits');

  let announceDispatched: () => void = () => undefined;
  const dispatchedA = new Promise<void>((resolve) => {
    announceDispatched = resolve;
  });

  const controllerA = new Controller({
    client: clientA,
    runnerId: 'runner-a',
    projectId: 3,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: TTL_SECONDS,
    // Much larger than the TTL: it simulates runner-a's process dying right
    // after dispatching — its timers stop, no heartbeat goes out.
    heartbeatIntervalMs: 60_000,
    dispatch: async () => {
      announceDispatched();
      return new Promise<ControllerModule.DispatchAttempt>(() => undefined);
    },
  });

  const dispatched: number[] = [];
  const controllerB = new Controller({
    client: clientB,
    runnerId: 'runner-b',
    projectId: 3,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: TTL_SECONDS,
    dispatch: async (jobId) => {
      dispatched.push(jobId);
      return { blocked: false };
    },
  });

  const tickA = controllerA.tick();
  tickA.catch(() => undefined);
  await dispatchedA;

  // With the lease alive, runner-b has nothing to take: the work has an owner.
  assert.equal(
    await controllerB.tick(),
    null,
    'while runner-a holds the lease, the work is not a candidate for anybody else',
  );

  // From here on it is just real time passing: with no heartbeat, runner-a's
  // lease falls due and runner-b's own request claims the expired one.
  const deadline = Date.now() + DEADLINE_MS;
  let inherited: { jobId: number; leaseId: number } | null = null;
  while (Date.now() < deadline && inherited === null) {
    inherited = await controllerB.tick();
    if (inherited === null) await delay(100);
  }

  assert.ok(
    inherited !== null,
    `the work did not go back to the queue within ${DEADLINE_MS}ms with a TTL of ${TTL_SECONDS}s`,
  );
  assert.equal(inherited.jobId, JOB_ID);
  assert.deepEqual(dispatched, [JOB_ID], 'runner-b dispatched the re-queued work');

  const response = await fetch(`${urlBase}/v1/leases?project_id=3`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const all = (await response.json()) as { leases: LeaseRow[] };
  const leases = all.leases.filter((lease) => lease.job_id === JOB_ID);

  const fromRunnerA = leases.filter((lease) => lease.runner_id === 'runner-a');
  assert.equal(fromRunnerA.length, 1);
  assert.equal(fromRunnerA[0].status, 'expired', 'the lease of the dead runner is claimed');
  assert.equal(
    fromRunnerA[0].expiration_reason,
    'ttl_elapsed',
    'runner-a never renewed: the term simply ran out',
  );

  const fromRunnerB = leases.filter((lease) => lease.runner_id === 'runner-b');
  assert.equal(fromRunnerB.length, 1, 'runner-b took the same work, with a lease of its own');
  assert.equal(fromRunnerB[0].id, inherited.leaseId);
  assert.equal(
    fromRunnerB[0].status,
    'released',
    'with the dispatch finished, runner-b gave the capacity back',
  );
});
