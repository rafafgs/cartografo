/**
 * End-to-end acceptance test of dispatch across the network (t143, FR5).
 *
 * Two things had never been exercised together anywhere in the repo, and both
 * are the point of this file:
 *
 * - **The control plane bound to something other than loopback.**
 *   `CARTOGRAFO_HOST` became configurable in t124, on the argument that `/v1`
 *   stopped answering anonymously — but no test had ever bound it to `0.0.0.0`
 *   and reached it at the machine's real address. A configuration option nobody
 *   ever exercises is a claim, not a feature.
 * - **A runner holding a credential of its OWN.** Every other end-to-end test
 *   authenticates with the operator's bootstrap token, which is exactly what
 *   this ticket exists to stop being the only option: the token below is minted
 *   at pairing (FR1), scoped to the runner surface (FR2) and to this runner's
 *   identity within it (FR3), and the bootstrap token never touches the client.
 *
 * The whole lease cycle — grant, heartbeat, release — runs over that path, at
 * real time, against the real binary as a child process. As in
 * `dispatch-and-lease.e2e.test.ts`, the runner imports NOTHING from the core:
 * the HTTP door is the only surface between the two (D1).
 *
 * `GET /v1/jobs` is NOT simulated here — unlike AT17, which seeds the queue in
 * a fake `fetch`. The queue is seeded through the API, because reading it with
 * the runner credential is part of what FR2 has to prove.
 *
 * When the machine running the suite has no non-loopback IPv4 address (a
 * network-less container, for instance) the test skips instead of failing: what
 * it would be reporting is the absence of a network, not a regression.
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

/** Identity this runner declares at pairing. */
const RUNNER_ID = 'runner-lan';
/** Project of the seeded work. */
const PROJECT_ID = 3;
/** Term of the lease. Three heartbeats fit in it before it falls due. */
const TTL_SECONDS = 2;
/** Deadline of every wait in this file. Wide slack, on purpose. */
const DEADLINE_MS = 30_000;

interface LeaseRow {
  id: number;
  runner_id: string;
  job_id: number;
  status: string;
  granted_at: string;
  heartbeat_at: string;
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
 * It is what turns "it listens on 0.0.0.0" into a proven fact: reaching the
 * server through the LAN interface is a different path from loopback, and the
 * only one a runner on another machine will ever have.
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
  /** Port it actually bound (the test asks for 0 and reads back the real one). */
  port: number;
  /** Operator credential announced on the readiness line — used ONLY to pair. */
  bootstrapToken: string;
}

/**
 * Boots the real binary listening on every interface, and reads its port back.
 *
 * Everything but the one environment variable under test is
 * `@cartografo/test-support`'s since t201: `CARTOGRAFO_HOST` is merged ON TOP of
 * the defaults, so this file says only what makes it different from the other
 * ten suites that boot the same binary.
 *
 * @param t Test context, so the process is shut down at the end.
 * @returns The port it really bound, and the credential it announced.
 */
async function bootControlPlane(t: TestHook): Promise<RunningControlPlane> {
  // The line under test: every interface, not just loopback.
  const { url, token } = await bootCore(t, { env: { CARTOGRAFO_HOST: '0.0.0.0' } });

  const port = Number(new URL(url).port);
  assert.ok(Number.isInteger(port) && port > 0, `unreadable port in "${url}"`);
  return { port, bootstrapToken: token };
}

/** One JSON call, with the credential handed in explicitly. */
async function call<T>(
  urlBase: string,
  method: string,
  routePath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${urlBase}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}

/** Every lease the presented credential is allowed to see. */
async function leasesOf(urlBase: string, token: string): Promise<LeaseRow[]> {
  const response = await call<{ leases: LeaseRow[] }>(urlBase, 'GET', '/v1/leases', token);
  assert.equal(response.status, 200);
  return response.body.leases;
}

test('t143 AT — a runner reaches the control plane off loopback and runs a whole lease cycle with its own credential', async (t) => {
  const address = externalAddress();
  if (address === null) {
    t.skip('this machine has no non-loopback IPv4 interface to reach the control plane through');
    return;
  }

  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  const { port, bootstrapToken } = await bootControlPlane(t);
  const urlBase = `http://${address}:${port}`;

  // Pairing is the operator's act, and the only place the bootstrap token is
  // used in this file: from here on the runner speaks for itself.
  const paired = await call<{ token: string | null }>(urlBase, 'POST', '/v1/runners', bootstrapToken, {
    id: RUNNER_ID,
    name: 'runner reached over the LAN',
  });
  assert.equal(paired.status, 201, `pairing over ${urlBase} is the first proof the bind took`);
  const token = paired.body.token ?? '';
  assert.match(token, /^[0-9a-f]{64}$/, 'pairing hands back the runner credential (FR1)');

  const job = await call<{ id: number }>(urlBase, 'POST', '/v1/jobs', bootstrapToken, {
    projeto_id: PROJECT_ID,
    titulo: 'trabalho despachado de outra máquina',
    no_entrada_id: 'implementar',
  });
  assert.equal(job.status, 201);

  // The credential is scoped, and this is the cheapest possible proof of it on
  // the very connection the cycle is about to run over.
  const refused = await call<{ error?: string }>(urlBase, 'POST', '/v1/jobs', token, {
    titulo: 'trabalho que um runner não cria',
    no_entrada_id: 'implementar',
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'out_of_scope_credential');

  const client = new ClienteControle({ urlBase, token });

  // The dispatch holds the lease open until a heartbeat has really landed:
  // "grant, heartbeat, release" is only proven if the middle one is observed,
  // and the server's own `heartbeat_em` is the observation.
  const dispatched: number[] = [];
  const controller = new Controller({
    client,
    runnerId: RUNNER_ID,
    projectId: PROJECT_ID,
    runnerCap: 1,
    projectCap: 1,
    ttlSeconds: TTL_SECONDS,
    dispatch: async (jobId) => {
      dispatched.push(jobId);

      const deadline = Date.now() + DEADLINE_MS;
      while (Date.now() < deadline) {
        const [lease] = await leasesOf(urlBase, token);
        assert.ok(lease !== undefined, 'the lease being dispatched under has to be visible');
        if (Date.parse(lease.heartbeat_at) > Date.parse(lease.granted_at)) return;
        await delay(100);
      }
      throw new Error(`no heartbeat reached the control plane within ${DEADLINE_MS}ms`);
    },
  });

  const result = await controller.tick();

  assert.ok(result !== null, 'the runner won the lease of the only released work');
  assert.equal(result.jobId, job.body.id);
  assert.deepEqual(dispatched, [job.body.id], 'the work dispatched is the work that was queued');

  // Closing state, read with the runner's own credential — which, per FR3, is
  // also what makes this list its own leases and nobody else's.
  const leases = await leasesOf(urlBase, token);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].id, result.leaseId);
  assert.equal(leases[0].runner_id, RUNNER_ID);
  assert.equal(leases[0].job_id, job.body.id);
  assert.equal(leases[0].status, 'released', 'the cycle closed: the capacity went back');
  assert.ok(
    Date.parse(leases[0].heartbeat_at) > Date.parse(leases[0].granted_at),
    'the lease was renewed at least once while the dispatch ran',
  );
});
