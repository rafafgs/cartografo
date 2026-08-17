/**
 * Acceptance tests for the controller's dispatch loop (t103, FR11/AT14–AT16).
 *
 * The controller owns the lease's lifecycle on the runner side: it picks up
 * released work, competes for the lease, keeps the heartbeat going while the
 * session runs, and gives the capacity back when it ends — including when the
 * work blows up. A lease stuck by a dispatch error is capacity leaking until
 * the TTL expires, which is the worst of both worlds: nobody works and the cap
 * stays occupied.
 *
 * Time here is fake (`t.mock.timers`): what is under test is the behaviour of
 * the controller's clock, not the suite's patience. The real-time path is in
 * `dispatch-and-lease.e2e.test.ts` (AT17).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_URL = 'http://127.0.0.1:4317';

interface HttpCall {
  url: string;
  method: string;
  body: unknown;
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

/** Yields the real event loop: `setImmediate` is not mocked in these tests. */
const yieldEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const LEASE = {
  id: 12,
  runner_id: 'runner-a',
  job_id: 1,
  project_id: 3,
  status: 'active',
  ttl_seconds: 6,
  granted_at: '2026-08-14T12:00:00.000Z',
  heartbeat_at: '2026-08-14T12:00:00.000Z',
  expires_at: '2026-08-14T12:00:06.000Z',
  released_at: null,
  expiration_reason: null,
};

/** Knobs of the fake control plane. Everything answers the happy path by default. */
interface EnvironmentOptions {
  /**
   * Status of `POST /v1/leases/:id/releases`. Default: 200.
   *
   * Anything outside 2xx makes `client.liberar` throw `ErroDoControlPlane` —
   * the transient failure of the control plane while the lease is being given
   * back (t158).
   */
  releaseStatus?: number;
}

/**
 * A client pointed at a fake control plane that answers the minimum of the
 * contract and keeps everything it received.
 */
async function environment(options: EnvironmentOptions = {}): Promise<{
  client: ClientModule.ClienteControle;
  calls: HttpCall[];
  heartbeats: () => number;
  releases: () => number;
}> {
  const { ClienteControle } = await loadClient();
  const releaseStatus = options.releaseStatus ?? 200;
  const calls: HttpCall[] = [];

  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const doFetch: typeof fetch = async (input, init) => {
    const rawBody = init?.body;
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    });

    if (url.endsWith('/v1/jobs')) {
      return respond(200, {
        jobs: [
          {
            id: 1,
            title: 'implementar t103',
            current_node_id: 'implementar',
            blocked: false,
            // Derived by the control plane and read by the client since t161: a
            // work standing on a final node stops being a candidate. The real
            // route has always answered it; this simulation has to as well, or
            // the queue it seeds is one the client throws away.
            completed: false,
            execution_id: 9,
            graph_version_id: 'sha256:abc',
          },
        ],
      });
    }
    if (url.endsWith('/v1/leases')) return respond(201, { lease: LEASE });
    if (url.endsWith('/heartbeats')) return respond(200, { lease: LEASE });
    if (url.endsWith('/releases')) {
      if (releaseStatus < 200 || releaseStatus > 299) {
        return respond(releaseStatus, { erro: 'control plane out of order' });
      }
      return respond(releaseStatus, { lease: { ...LEASE, status: 'released' } });
    }
    throw new Error(`unexpected call: ${url}`);
  };

  return {
    client: new ClienteControle({ urlBase: BASE_URL, buscar: doFetch }),
    calls,
    heartbeats: () => calls.filter((call) => call.url.endsWith('/heartbeats')).length,
    releases: () => calls.filter((call) => call.url.endsWith('/releases')).length,
  };
}

const BASE_OPTIONS = {
  runnerId: 'runner-a',
  projectId: 3,
  runnerCap: 1,
  projectCap: 4,
  ttlSeconds: 6,
};

test('AT14 — with the dispatch in flight, the heartbeat beats at an interval shorter than the TTL', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { client, calls, heartbeats } = await environment();
  const { Controller } = await loadController();

  let announceDispatched: () => void = () => undefined;
  const dispatched = new Promise<void>((resolve) => {
    announceDispatched = resolve;
  });

  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    // Never resolves: it is the session still running.
    dispatch: async () => {
      announceDispatched();
      return new Promise<ControllerModule.DispatchAttempt>(() => undefined);
    },
  });

  const inFlight = controller.tick();
  inFlight.catch(() => undefined);

  await dispatched;
  await yieldEventLoop();

  assert.equal(heartbeats(), 0, 'no heartbeat before the clock moves');

  // A whole TTL window minus 1ms: if the interval were >= the TTL, the lease
  // would have expired on the server without a single beat.
  //
  // Advanced in slices, with the event loop yielded between them, and since
  // t193 that is not decoration: a beat that has not answered yet is skipped
  // rather than overlapped, and a single synchronous jump of a whole TTL is a
  // clock no runner ever meets — it fires every window before the first beat's
  // promise has had a turn to settle. The window under test is unchanged.
  const window = BASE_OPTIONS.ttlSeconds * 1000 - 1;
  for (let elapsed = 0; elapsed < window; elapsed += 1000) {
    t.mock.timers.tick(Math.min(1000, window - elapsed));
    await yieldEventLoop();
  }

  assert.ok(
    heartbeats() >= 2,
    `the heartbeat has to beat more than once within the TTL; it beat ${heartbeats()}`,
  );
  assert.ok(
    calls.some((call) => call.url.endsWith(`/v1/leases/${LEASE.id}/heartbeats`)),
    'the heartbeat is for the lease that was granted',
  );
});

test('AT15 — a finished dispatch releases the lease and stops the heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { client, calls, heartbeats, releases } = await environment();
  const { Controller } = await loadController();

  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    dispatch: async () => ({ blocked: false }),
  });

  const result = await controller.tick();
  assert.deepEqual(result, { jobId: 1, leaseId: LEASE.id });

  assert.equal(releases(), 1, 'finished work gives the lease back');
  const beatsUntilRelease = heartbeats();

  const releaseIndex = calls.findIndex((call) => call.url.endsWith('/releases'));
  assert.ok(
    !calls.slice(releaseIndex + 1).some((call) => call.url.endsWith('/heartbeats')),
    'no heartbeat after the release',
  );

  t.mock.timers.tick(60_000);
  await yieldEventLoop();
  assert.equal(
    heartbeats(),
    beatsUntilRelease,
    'the heartbeat clock is disarmed together with the release',
  );
});

test('AT16 — a dispatch that blows up STILL releases the lease', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { client, heartbeats, releases } = await environment();
  const { Controller } = await loadController();

  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    dispatch: async () => {
      throw new Error('the session died halfway');
    },
  });

  await assert.rejects(
    async () => controller.tick(),
    /the session died halfway/,
    'the error of the work must not be swallowed by the controller',
  );

  assert.equal(
    releases(),
    1,
    'a lease stuck by a dispatch error is capacity leaking until the TTL expires',
  );

  const beats = heartbeats();
  t.mock.timers.tick(60_000);
  await yieldEventLoop();
  assert.equal(heartbeats(), beats, 'the heartbeat stops too, even on the error path');
});

test('AT16 — with no released work, the tick asks for no lease at all', async () => {
  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  const calls: string[] = [];
  const doFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ jobs: [{ id: 1, blocked: true }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const controller = new Controller({
    ...BASE_OPTIONS,
    client: new ClienteControle({ urlBase: BASE_URL, buscar: doFetch }),
    dispatch: async () => {
      throw new Error('it should not dispatch without released work');
    },
  });

  assert.equal(await controller.tick(), null);
  assert.deepEqual(calls, [`${BASE_URL}/v1/jobs`]);
});

test('t158 — a release that also fails does not take the place of the dispatch error', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { ErroDoControlPlane } = await loadClient();
  const { Controller } = await loadController();

  const broken = await environment({ releaseStatus: 503 });
  const controller = new Controller({
    ...BASE_OPTIONS,
    client: broken.client,
    dispatch: async () => {
      throw new Error('the session died halfway');
    },
  });

  await assert.rejects(
    async () => controller.tick(),
    /the session died halfway/,
    'whoever calls the loop has to learn why the session died, not why the release failed',
  );

  assert.equal(broken.releases(), 1, 'the lease is still asked back on the way out');

  const releaseError: unknown = controller.lastReleaseError;
  assert.ok(
    releaseError instanceof ErroDoControlPlane,
    'the release failure does not disappear: it stays observable on the controller',
  );
  assert.equal(releaseError.status, 503);

  // The other half of the same rule: with nothing wrong in the dispatch, a
  // release that fails does not invent an error either.
  const quiet = await environment({ releaseStatus: 503 });
  const happy = new Controller({
    ...BASE_OPTIONS,
    client: quiet.client,
    dispatch: async () => ({ blocked: false }),
  });

  assert.deepEqual(
    await happy.tick(),
    { jobId: 1, leaseId: LEASE.id },
    'work that ended well ended well, whatever the control plane answered afterwards',
  );
  assert.ok(happy.lastReleaseError instanceof ErroDoControlPlane);
});

/* -------------------------------------------------------------------------- */
/* t193 — what the controller promises about a control plane that goes quiet.  */
/* -------------------------------------------------------------------------- */

/** A `fetch` that connects and never answers: the server that is there and silent. */
const NEVER_ANSWERS: typeof fetch = () => new Promise<Response>(() => undefined);

/** Deadline of the case below: what "not never" means. Well above its own. */
const NEVER_MS = 5_000;

test('t193 — a tick against a control plane that never answers rejects instead of hanging', async () => {
  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  // The contract pinned here is the CONTROLLER'S, and it is deliberately taken
  // against a real client: whoever calls `tick()` — the loop in `cli/run.ts` —
  // has no other way of learning that a pass failed, and a `tick()` that never
  // settles is a runner that stops working and cannot even be asked to stop.
  const controller = new Controller({
    ...BASE_OPTIONS,
    client: new ClienteControle({
      urlBase: BASE_URL,
      buscar: NEVER_ANSWERS,
      requestTimeoutMs: 150,
    }),
    dispatch: async () => {
      throw new Error('it should never get as far as dispatching');
    },
  });

  const started = Date.now();
  // Cleared right after the race: a case that settles in 150ms must not keep
  // the suite's event loop alive for the five seconds it was allowed and did
  // not need — and while the race is running the timer stays ref'd, so a real
  // hang is reported as this assertion instead of as a suite that stops.
  let guard: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    controller.tick().then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    ),
    new Promise<'hung'>((resolve) => {
      guard = setTimeout(() => resolve('hung'), NEVER_MS);
    }),
  ]);
  clearTimeout(guard);

  assert.equal(
    outcome,
    'rejected',
    `the pass has to end for the loop to turn again (it ${outcome} after ${Date.now() - started}ms)`,
  );
});

test('t193 — a heartbeat still in flight is skipped, never overlapped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { Controller } = await loadController();

  const beats: Array<(lease: unknown) => void> = [];
  let announceDispatched: () => void = () => undefined;
  const dispatched = new Promise<void>((resolve) => {
    announceDispatched = resolve;
  });

  // A hand-built client and not {@link environment}'s: what this case is about
  // is a beat that has not come back yet, and a `fetch` fake answers too
  // quickly to ever describe one.
  const client = {
    listarTrabalhosLiberados: async () => [
      { id: 1, title: 'implementar t193', current_node_id: 'implementar', blocked: false, completed: false, execution_id: 9, graph_version_id: null },
    ],
    pedirLease: async () => ({ lease: LEASE }),
    heartbeat: async () =>
      await new Promise((resolve) => {
        beats.push(resolve);
      }),
    liberar: async () => LEASE,
  } as unknown as ClientModule.ClienteControle;

  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    heartbeatIntervalMs: 1_000,
    dispatch: async () => {
      announceDispatched();
      return new Promise<ControllerModule.DispatchAttempt>(() => undefined);
    },
  });

  const inFlight = controller.tick();
  inFlight.catch(() => undefined);

  await dispatched;
  await yieldEventLoop();

  t.mock.timers.tick(1_000);
  await yieldEventLoop();
  assert.equal(beats.length, 1, 'the first window beats');

  // The window the ficha is about: the beat armed above has not come back, and
  // the next one is already due. Piling a second call on top of it is how a
  // stalled control plane collects one in-flight request per interval, forever.
  t.mock.timers.tick(1_000);
  await yieldEventLoop();
  t.mock.timers.tick(1_000);
  await yieldEventLoop();
  assert.equal(
    beats.length,
    1,
    `a beat that has not answered yet is skipped, not overlapped: ${beats.length} calls were in flight at once`,
  );

  // ...and the clock is not disarmed by the skip: once the beat comes back, the
  // next window beats again.
  beats[0](LEASE);
  await yieldEventLoop();
  t.mock.timers.tick(1_000);
  await yieldEventLoop();
  assert.equal(beats.length, 2, 'skipping a beat may not stop the heartbeat for good');
});

/* -------------------------------------------------------------------------- */
/* t208 — a ceiling refusal ends the tick; a per-job refusal only skips a job. */
/* -------------------------------------------------------------------------- */

/** A candidate as `GET /v1/jobs` describes one, for the fakes below. */
const candidate = (id: number): ClientModule.Trabalho => ({
  id,
  title: `implementar t208 #${id}`,
  current_node_id: 'implementar',
  blocked: false,
  completed: false,
  execution_id: 9,
  graph_version_id: null,
});

/**
 * A client with a queue of candidates and a scripted answer per lease request.
 *
 * Hand-built and not {@link environment}'s: what these cases are about is WHICH
 * refusal came back, and a `fetch` fake that answers the happy path has no way
 * of saying that.
 */
function refusingClient(
  candidates: number[],
  answers: Array<{ lease: typeof LEASE | null; reason?: ClientModule.MotivoDeRecusa }>,
): { client: ClientModule.ClienteControle; asked: () => number[] } {
  const asked: number[] = [];

  const client = {
    listarTrabalhosLiberados: async () => candidates.map(candidate),
    pedirLease: async (request: ClientModule.PedidoDeLease) => {
      asked.push(request.job_id);
      return answers[asked.length - 1] ?? { lease: null };
    },
    heartbeat: async () => LEASE,
    liberar: async () => LEASE,
  } as unknown as ClientModule.ClienteControle;

  return { client, asked: () => asked };
}

for (const motivo of ['runner_cap', 'project_cap'] as const) {
  test(`t208 — tick() stops asking after a \`${motivo}\` refusal, even with candidates left`, async () => {
    const { Controller } = await loadController();

    // Three released candidates and a ceiling that is already full: every one of
    // them would come back with this same answer, so the two POSTs after the
    // first are round trips spent learning something the first one said.
    const { client, asked } = refusingClient([1, 2, 3], [{ lease: null, reason: motivo }]);

    const controller = new Controller({
      ...BASE_OPTIONS,
      client,
      dispatch: async () => {
        throw new Error('a refused lease may never dispatch');
      },
    });

    assert.equal(await controller.tick(), null, 'a tick that won nothing won nothing');
    assert.deepEqual(
      asked(),
      [1],
      `"${motivo}" is about this runner's or this project's capacity, not about job 1: ` +
        'the tick has nothing left to ask for',
    );
  });
}

test('t208 — tick() still tries the next candidate after `trabalho_ja_leased`', async () => {
  const { Controller } = await loadController();

  // The regression guard of the case above: this refusal says another runner got
  // to THAT job first, which is the healthy pool's common answer and says
  // nothing at all about the next candidate.
  const { client, asked } = refusingClient(
    [1, 2],
    [{ lease: null, reason: 'job_already_leased' }, { lease: LEASE }],
  );

  const dispatched: number[] = [];
  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    dispatch: async (jobId: number) => {
      dispatched.push(jobId);
      return { blocked: false };
    },
  });

  assert.deepEqual(await controller.tick(), { jobId: 2, leaseId: LEASE.id });
  assert.deepEqual(asked(), [1, 2], 'a job with an owner is one job, never the whole queue');
  assert.deepEqual(dispatched, [2], 'and the one dispatched is the one that yielded a lease');
});

/* -------------------------------------------------------------------------- */
/* t252 — a dispatch that blocked the job does not end the pass.               */
/* -------------------------------------------------------------------------- */

test('t252 — a blocked candidate is skipped and the NEXT one runs in the same tick', async () => {
  const { Controller } = await loadController();

  // Both candidates yield a lease: what decides the pass here is not the
  // server's answer to the lease request, it is what the dispatch reported
  // back. Job 1 blocked itself before opening a session — an engine with no
  // route, a placeholder that does not resolve — and that is a job which will
  // never be a candidate again until a human unblocks it. Ending the pass on it
  // would leave every other released job of the project waiting behind a queue
  // head that is already dead.
  const { client, asked } = refusingClient([1, 2], [{ lease: LEASE }, { lease: LEASE }]);

  const dispatched: number[] = [];
  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    dispatch: async (jobId: number) => {
      dispatched.push(jobId);
      return jobId === 1
        ? { blocked: true, reason: 'o nó pede um engine que este runner não tem' }
        : { blocked: false };
    },
  });

  assert.deepEqual(
    await controller.tick(),
    { jobId: 2, leaseId: LEASE.id },
    'the tick reports the work it actually dispatched, not the one it blocked',
  );
  assert.deepEqual(
    asked(),
    [1, 2],
    'the second candidate was leased in the SAME pass, not two seconds later',
  );
  assert.deepEqual(
    dispatched,
    [1, 2],
    'and it was dispatched in the same pass too: one blocked job may not cost a whole tick',
  );
});

test('t252 — a tick whose only candidate blocks itself returns null', async () => {
  const { Controller } = await loadController();

  const { client, asked } = refusingClient([1], [{ lease: LEASE }]);

  const controller = new Controller({
    ...BASE_OPTIONS,
    client,
    dispatch: async () => ({ blocked: true, reason: 'a skill fixada não está no registro' }),
  });

  // Same answer as "no candidate yielded a lease": the pass won nothing. What
  // it must NOT do is report the blocked job as dispatched work — the loop in
  // `cli/run.ts` reads that as a session having run.
  assert.equal(await controller.tick(), null, 'a tick that blocked its only candidate won nothing');
  assert.deepEqual(asked(), [1]);
});
