/**
 * End-to-end acceptance test of N runners against one queue (t164, FR4).
 *
 * Everything this file asserts is already TRUE by construction — `grantLease`
 * decides in a single synchronous transaction, its project count carries no
 * `runner_id` filter, and reclaiming the expired ones is the first step of
 * every grant (`docs/spec/runner-e-controller.md` §3). What did not exist was
 * the proof: every lease-cap test in the repo calls the repository or the route
 * IN PROCESS, one caller at a time. "N runners work" was a property of the code
 * nobody had ever seen happen.
 *
 * So the shape here is deliberate, and it is the one `cross-machine-dispatch`
 * established: the real binary as a child process, bound to `0.0.0.0`, reached
 * at this machine's real IPv4 — never `127.0.0.1` — with two runners that each
 * hold a credential of their own, minted at pairing. Two independent
 * `Controller`s, two `ClienteControle`s, two tokens; the only thing they share
 * is the test process they run in, and the only thing that crosses between them
 * is HTTP. Where the machine has no external interface the file skips instead
 * of failing: what it would be reporting is the absence of a network.
 *
 * ## Why the leases are held for the whole race
 *
 * Exactly-once is a property of the LEASE, not of the queue: `GET /v1/jobs`
 * keeps answering a job after its lease is released — that is what lets the
 * next node's work be dispatched at all — so a runner that grabs a released job
 * a second time is the system working, not a double dispatch. What the race
 * below pins is the thing the lease alone decides: while a job has an owner, no
 * second runner gets it, however many ask at the same instant. Every dispatch
 * therefore holds until the last job is taken, and only then does anybody hand
 * a lease back.
 *
 * ## Why "dead" means "stopped beating"
 *
 * `packages/runner` has no bin to spawn yet (t162), so there is no process to
 * kill. It changes nothing: heartbeat absence is the ONLY way a control plane
 * ever learns a runner died — a `SIGKILL` would arrive here through the exact
 * same silence. Runner-a's client stops answering, its dispatch never returns,
 * and it never releases anything.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { bootCore, type TestHook } from '@cartografo/test-support';

import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The two machines of this fleet, as they pair themselves. */
const RUNNER_A = 'runner-a';
const RUNNER_B = 'runner-b';

/** Project of every seeded job and of every lease requested here. */
const PROJECT_ID = 3;

/** Jobs seeded for the free-for-all race. */
const JOB_COUNT = 8;

/**
 * Dispatch loops each runner keeps in flight.
 *
 * One per job, so that NOTHING in the harness bounds how many of the eight a
 * single runner could take: if the server handed every race to whoever asked
 * first, one runner would end with all eight and the starvation assertion would
 * be the one that caught it.
 */
const LOOPS_PER_RUNNER = JOB_COUNT;

/** Deadline of every wait in this file. Wide slack, on purpose. */
const DEADLINE_MS = 30_000;

/** Gap between two poll attempts of the same wait. */
const POLL_MS = 20;

/** Term of the lease in the reclaim scenario, as in `cross-machine-dispatch`. */
const TTL_SECONDS = 2;

interface LeaseRow {
  id: number;
  runner_id: string;
  job_id: number;
  status: string;
  granted_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  expiration_reason: string | null;
}

/** A runner's health, as `GET /v1/runners` returns it (FR1). */
interface RunnerHealth {
  id: string;
  active_leases: number;
  last_heartbeat: string | null;
  last_expiration: {
    job_id: number;
    expires_at: string;
    expiration_reason: string | null;
  } | null;
}

/** One dispatch, as the shared record of the race keeps it. */
interface Dispatched {
  runnerId: string;
  jobId: number;
}

let clientCache: typeof ClientModule | null = null;
let controllerCache: typeof ControllerModule | null = null;

async function loadClient(): Promise<typeof ClientModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'controller', 'cliente-controle.ts')),
    'artifact does not exist yet: packages/runner/src/controller/cliente-controle.ts',
  );
  clientCache ??= (await import(
    new URL('../../src/controller/cliente-controle.ts', import.meta.url).href
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
 * The address of this machine on the network — not `127.0.0.1`.
 *
 * Same helper, and same reason, as `cross-machine-dispatch.e2e.test.ts`: two
 * clients reaching the control plane through the LAN interface is this repo's
 * established stand-in for two machines, and it is a different network path
 * from loopback.
 *
 * @returns An IPv4 address of a real interface, or `null` when there is none.
 */
function externalAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const candidate of addresses ?? []) {
      if (candidate.family === 'IPv4' && !candidate.internal) return candidate.address;
    }
  }
  return null;
}

/** The control plane, running and listening on every interface. */
interface RunningControlPlane {
  /** Base URL at the machine's real address — what both runners talk to. */
  urlBase: string;
  /** Operator credential announced at boot — used ONLY to pair and to read. */
  bootstrapToken: string;
}

/**
 * Boots the real binary on every interface, addressed the way a peer would.
 *
 * Everything but this file's own two differences is `@cartografo/test-support`'s
 * since t201. The differences: `CARTOGRAFO_HOST=0.0.0.0` plus whatever the
 * scenario adds, merged ON TOP of the shared defaults; and the URL that comes
 * back, which is rebuilt on the machine's REAL address — the readiness line
 * announces the bind address, and `0.0.0.0` is not somewhere a runner can dial.
 *
 * @param t Test context, so the process is shut down at the end.
 * @param address This machine's external IPv4, already resolved by the caller.
 * @param extraEnv Configuration this scenario needs on top of the defaults.
 * @returns The control plane, up.
 */
async function bootControlPlane(
  t: TestHook,
  address: string,
  extraEnv: Record<string, string> = {},
): Promise<RunningControlPlane> {
  const { url, token } = await bootCore(t, {
    env: { CARTOGRAFO_HOST: '0.0.0.0', ...extraEnv },
  });

  const port = Number(new URL(url).port);
  assert.ok(Number.isInteger(port) && port > 0, `unreadable port in "${url}"`);
  return { urlBase: `http://${address}:${port}`, bootstrapToken: token };
}

/** One JSON call, with the credential handed in explicitly. */
async function call<T>(
  cp: RunningControlPlane,
  method: string,
  routePath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${cp.urlBase}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}

/** Pairs a runner and hands back the credential minted for it (t143, FR1). */
async function pair(cp: RunningControlPlane, id: string): Promise<string> {
  const paired = await call<{ token: string | null }>(cp, 'POST', '/v1/runners', cp.bootstrapToken, {
    id,
    name: `máquina ${id}`,
  });
  assert.equal(paired.status, 201, `pairing ${id} over ${cp.urlBase} failed`);
  const token = paired.body.token ?? '';
  assert.match(token, /^[0-9a-f]{64}$/, `pairing ${id} handed back no credential`);
  return token;
}

/** Seeds the queue through the public API, and returns the ids in order. */
async function seedJobs(cp: RunningControlPlane, howMany: number): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < howMany; index += 1) {
    const job = await call<{ id: number }>(cp, 'POST', '/v1/jobs', cp.bootstrapToken, {
      projeto_id: PROJECT_ID,
      titulo: `trabalho disputado #${index + 1}`,
      no_entrada_id: 'implementar',
    });
    assert.equal(job.status, 201);
    ids.push(job.body.id);
  }
  return ids;
}

/** Every lease of the project, read with the operator credential. */
async function leasesOf(cp: RunningControlPlane, query = ''): Promise<LeaseRow[]> {
  const response = await call<{ leases: LeaseRow[] }>(
    cp,
    'GET',
    `/v1/leases?project_id=${PROJECT_ID}${query}`,
    cp.bootstrapToken,
  );
  assert.equal(response.status, 200);
  return response.body.leases;
}

/** The fleet's health, as the operator (and the screen) sees it (FR1). */
async function fleetHealth(cp: RunningControlPlane): Promise<RunnerHealth[]> {
  const response = await call<{ runners: RunnerHealth[] }>(
    cp,
    'GET',
    '/v1/runners',
    cp.bootstrapToken,
  );
  assert.equal(response.status, 200, 'GET /v1/runners is what makes a dead runner observable');
  return response.body.runners;
}

/** Polls until the condition holds, or gives up with the reason it was waiting. */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  complaint: string,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(POLL_MS);
  }
  throw new Error(`${complaint} (waited ${DEADLINE_MS}ms)`);
}

test('t164 AT — two runners racing over the LAN take every job exactly once, and neither starves', async (t) => {
  const address = externalAddress();
  if (address === null) {
    t.skip('this machine has no non-loopback IPv4 interface to reach the control plane through');
    return;
  }

  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  const cp = await bootControlPlane(t, address);
  const tokenA = await pair(cp, RUNNER_A);
  const tokenB = await pair(cp, RUNNER_B);
  const jobIds = await seedJobs(cp, JOB_COUNT);

  const dispatched: Dispatched[] = [];
  let racing = true;
  const deadline = Date.now() + DEADLINE_MS;

  // An assertion that fails mid-race must not leave sixteen loops holding
  // leases until the deadline: the failure is the answer, and it should be the
  // last thing this test spends time on.
  t.after(() => {
    racing = false;
  });

  const dispatchOf =
    (runnerId: string) =>
    async (jobId: number): Promise<void> => {
      // A dispatch that lands after the race was decided is not part of the
      // proof: by then the leases are going back and a free job is a job
      // anybody may legitimately take again.
      if (!racing) return;

      dispatched.push({ runnerId, jobId });
      if (dispatched.length === JOB_COUNT) racing = false;

      // Nobody hands a lease back while the race is on (see the header).
      while (racing && Date.now() < deadline) await delay(POLL_MS);
    };

  const fleet = [
    new Controller({
      client: new ClienteControle({ urlBase: cp.urlBase, token: tokenA }),
      runnerId: RUNNER_A,
      projectId: PROJECT_ID,
      // Both ceilings at the size of the whole queue: the harness bounds
      // nothing, and what the runners bump into is the server's decision.
      runnerCap: JOB_COUNT,
      projectCap: JOB_COUNT,
      ttlSeconds: 30,
      dispatch: dispatchOf(RUNNER_A),
    }),
    new Controller({
      client: new ClienteControle({ urlBase: cp.urlBase, token: tokenB }),
      runnerId: RUNNER_B,
      projectId: PROJECT_ID,
      runnerCap: JOB_COUNT,
      projectCap: JOB_COUNT,
      ttlSeconds: 30,
      dispatch: dispatchOf(RUNNER_B),
    }),
  ];

  const loop = async (controller: ControllerModule.Controller): Promise<void> => {
    try {
      while (racing && Date.now() < deadline) {
        if ((await controller.tick()) === null) await delay(POLL_MS);
      }
    } catch (failure) {
      // Whatever broke, the others must not keep holding leases until the
      // deadline: the error is the answer, and it should arrive now.
      racing = false;
      throw failure;
    }
  };

  // Started interleaved — a, b, a, b — because two machines that come up
  // together do not queue their first request behind eight of a single peer.
  const loops: Promise<void>[] = [];
  for (let index = 0; index < LOOPS_PER_RUNNER; index += 1) {
    for (const controller of fleet) loops.push(loop(controller));
  }
  await Promise.all(loops);

  assert.equal(
    dispatched.length,
    JOB_COUNT,
    `the fleet consumed ${dispatched.length} of ${JOB_COUNT} jobs within ${DEADLINE_MS}ms`,
  );

  const numeric = (one: number, other: number): number => one - other;
  assert.deepEqual(
    dispatched.map((one) => one.jobId).sort(numeric),
    [...jobIds].sort(numeric),
    'every seeded job was dispatched exactly once — no job twice, none left behind',
  );

  assert.deepEqual(
    [...new Set(dispatched.map((one) => one.runnerId))].sort(),
    [RUNNER_A, RUNNER_B],
    'both runners dispatched: whoever won the first races did not monopolize the queue',
  );

  // The server's own account of the same race. Stated as non-overlap rather
  // than as a row count on purpose: once the race is decided the leases go
  // back, and a job picked up again after that is the queue working — what
  // exclusivity forbids is two live leases over the same job AT ONCE.
  const granted = await leasesOf(cp);
  assert.equal(
    new Set(granted.map((lease) => lease.job_id)).size,
    JOB_COUNT,
    'every seeded job got a lease of its own',
  );

  for (const jobId of jobIds) {
    const history = granted
      .filter((lease) => lease.job_id === jobId)
      .sort((one, other) => Date.parse(one.granted_at) - Date.parse(other.granted_at));

    for (const [index, lease] of history.slice(1).entries()) {
      const previous = history[index];
      const ended = previous.released_at ?? previous.expires_at;
      assert.ok(
        Date.parse(ended) <= Date.parse(lease.granted_at),
        `job ${jobId} had two live leases at once: ${previous.id} (${previous.runner_id}) ran to ${ended}, and ${lease.id} (${lease.runner_id}) started at ${lease.granted_at}`,
      );
    }
  }
});

test('t164 AT — the per-project ceiling holds across two runners racing without pause', async (t) => {
  const address = externalAddress();
  if (address === null) {
    t.skip('this machine has no non-loopback IPv4 interface to reach the control plane through');
    return;
  }

  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  /** The ceiling this control plane enforces, whatever the runners declare (t157). */
  const CEILING = 2;
  /** Ceiling both runners ask for — far above it, and it must not matter. */
  const DECLARED = 100;
  /** Jobs in the pool: enough that the ceiling, and not the queue, is the limit. */
  const POOL = 4;
  /** Dispatch loops each runner keeps in flight, with no pause between them. */
  const LOOPS = 2;
  /** How long the two keep racing while the poll watches. */
  const RACE_MS = 1_500;

  const cp = await bootControlPlane(t, address, { CARTOGRAFO_LEASE_CAP_PROJECT: String(CEILING) });
  const tokenA = await pair(cp, RUNNER_A);
  const tokenB = await pair(cp, RUNNER_B);
  await seedJobs(cp, POOL);

  let racing = true;
  let dispatches = 0;

  const controllerOf = (runnerId: string, token: string): ControllerModule.Controller =>
    new Controller({
      client: new ClienteControle({ urlBase: cp.urlBase, token }),
      runnerId,
      projectId: PROJECT_ID,
      runnerCap: DECLARED,
      projectCap: DECLARED,
      // Long enough that nothing expires during the race: an overdue lease that
      // no grant has swept yet still reads `ativa`, and the poll below would
      // count it as a live one.
      ttlSeconds: 30,
      dispatch: async () => {
        dispatches += 1;
        await delay(25);
      },
    });

  const fleet = [controllerOf(RUNNER_A, tokenA), controllerOf(RUNNER_B, tokenB)];

  const loop = async (controller: ControllerModule.Controller): Promise<void> => {
    try {
      // No delay between attempts, on purpose: the widest possible window of
      // two requests in flight at once is exactly what the ceiling has to
      // survive.
      while (racing) await controller.tick();
    } catch (failure) {
      racing = false;
      throw failure;
    }
  };

  const observed: number[] = [];
  const poll = (async () => {
    while (racing) {
      observed.push((await leasesOf(cp, '&status=active')).length);
      await delay(10);
    }
  })();

  const loops: Promise<void>[] = [];
  for (let index = 0; index < LOOPS; index += 1) {
    for (const controller of fleet) loops.push(loop(controller));
  }

  await delay(RACE_MS);
  racing = false;
  await Promise.all([...loops, poll]);

  const most = Math.max(...observed);
  assert.ok(
    most <= CEILING,
    `${most} leases were active at once in project ${PROJECT_ID}, over a ceiling of ${CEILING}: the cap does not sum across runners`,
  );
  assert.ok(
    most >= 1,
    `the poll never saw a single active lease in ${observed.length} samples — the race did not happen`,
  );
  assert.ok(
    dispatches > CEILING * 2,
    `only ${dispatches} dispatches came out of ${RACE_MS}ms of racing: the ceiling held by starving the fleet, not by taking turns`,
  );

  const everGranted = await leasesOf(cp);
  assert.deepEqual(
    [...new Set(everGranted.map((lease) => lease.runner_id))].sort(),
    [RUNNER_A, RUNNER_B],
    'both runners got leases under the ceiling — it is a project ceiling, not a first-runner-wins',
  );
});

test('t164 AT — a runner that stops beating loses the work, and the fleet health says so', async (t) => {
  const address = externalAddress();
  if (address === null) {
    t.skip('this machine has no non-loopback IPv4 interface to reach the control plane through');
    return;
  }

  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  const cp = await bootControlPlane(t, address);
  const tokenA = await pair(cp, RUNNER_A);
  const tokenB = await pair(cp, RUNNER_B);
  const [jobId] = await seedJobs(cp, 1);

  // Runner-a's whole process, modelled by the one thing the control plane can
  // observe: from `alive = false` on, nothing this runner tries reaches the
  // network — no heartbeat, and no release either.
  let alive = true;
  const clientA = new ClienteControle({
    urlBase: cp.urlBase,
    token: tokenA,
    buscar: async (input, init) => {
      if (!alive) throw new Error(`${RUNNER_A} is dead: nothing leaves this process anymore`);
      return await fetch(input, init);
    },
  });

  const controllerA = new Controller({
    client: clientA,
    runnerId: RUNNER_A,
    projectId: PROJECT_ID,
    runnerCap: 1,
    projectCap: 2,
    ttlSeconds: TTL_SECONDS,
    dispatch: async () => {
      // It dies AFTER the server has recorded a heartbeat, so that the lease it
      // leaves behind is the interesting kind — one that was alive and went
      // quiet (`heartbeat_perdido`), not one that never started (`expirou`,
      // already proven by `dispatch-and-lease.e2e.test.ts`).
      await waitFor(async () => {
        const [lease] = await leasesOf(cp, `&runner_id=${RUNNER_A}`);
        return lease !== undefined && Date.parse(lease.heartbeat_at) > Date.parse(lease.granted_at);
      }, `no heartbeat of ${RUNNER_A} reached the control plane`);

      alive = false;
      return await new Promise<void>(() => undefined);
    },
  });

  let inherited: number | null = null;
  let holdingReclaimed = true;
  t.after(() => {
    holdingReclaimed = false;
  });
  const controllerB = new Controller({
    client: new ClienteControle({ urlBase: cp.urlBase, token: tokenB }),
    runnerId: RUNNER_B,
    projectId: PROJECT_ID,
    runnerCap: 1,
    projectCap: 2,
    ttlSeconds: TTL_SECONDS,
    dispatch: async (job) => {
      inherited = job;
      // Holds the reclaimed lease open: "runner-b ended up with a NEW active
      // lease" is only observable while it is still active.
      await waitFor(() => !holdingReclaimed, 'the assertions never released runner-b');
    },
  });

  const tickA = controllerA.tick();
  tickA.catch(() => undefined);

  await waitFor(
    () => !alive,
    `${RUNNER_A} never got the only job in the queue, so there was nothing to lose`,
  );

  const loopB = (async () => {
    while (inherited === null) {
      if ((await controllerB.tick()) === null) await delay(100);
    }
  })();
  loopB.catch(() => undefined);

  await waitFor(
    () => inherited !== null,
    `the work of a dead ${RUNNER_A} did not go back to the queue with a TTL of ${TTL_SECONDS}s`,
  );
  assert.equal(inherited, jobId, 'what runner-b picked up is the work runner-a was holding');

  const leases = await leasesOf(cp);
  const fromA = leases.filter((lease) => lease.runner_id === RUNNER_A);
  const fromB = leases.filter((lease) => lease.runner_id === RUNNER_B);

  assert.equal(fromA.length, 1);
  assert.equal(fromA[0].job_id, jobId);
  assert.equal(fromA[0].status, 'expired', 'the dead runner had its lease claimed');
  assert.equal(
    fromA[0].expiration_reason,
    'heartbeat_lost',
    'it had beaten at least once before going quiet, and the reason records which death it was',
  );

  assert.equal(fromB.length, 1, 'the same work, with a lease of its own');
  assert.equal(fromB[0].job_id, jobId);
  assert.equal(fromB[0].status, 'active', 'runner-b holds it right now');

  // The point of FR1: none of the above is readable from the outside without a
  // query surface, and this is it.
  const health = await fleetHealth(cp);
  const healthOfA = health.find((runner) => runner.id === RUNNER_A);
  const healthOfB = health.find((runner) => runner.id === RUNNER_B);
  assert.ok(healthOfA !== undefined && healthOfB !== undefined, 'both runners are on the fleet page');

  assert.equal(healthOfA.active_leases, 0, 'a dead runner holds nothing');
  assert.ok(
    healthOfA.last_heartbeat !== null,
    'when it was last heard from survives the lease that carried it',
  );
  assert.deepEqual(
    healthOfA.last_expiration,
    {
      job_id: jobId,
      expires_at: fromA[0].expires_at,
      expiration_reason: 'heartbeat_lost',
    },
    'the sweep that reclaimed the work is visible, and says the same as the lease it came from',
  );
  assert.equal(healthOfB.active_leases, 1, 'and the runner that took it over is holding one');

  assert.ok(
    controllerA.lastHeartbeatError !== null,
    'runner-a kept trying to beat and could not — that is what dying looks like from inside',
  );

  holdingReclaimed = false;
  await loopB;
});
