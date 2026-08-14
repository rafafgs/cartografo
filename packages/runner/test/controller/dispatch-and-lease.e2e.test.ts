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
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BIN_PATH = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');

/** The work both runners will apply for. */
const JOB_ID = 4242;
/** TTL of the lease. One second is the smallest term `ttl_segundos` expresses. */
const TTL_SECONDS = 1;
/** Deadline for the re-queueing wait. Wide slack over the TTL, on purpose. */
const DEADLINE_MS = 30_000;

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface LeaseRow {
  id: number;
  runner_id: string;
  trabalho_id: number;
  status: string;
  motivo_expiracao: string | null;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

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

/** Boots the real control plane and returns the URL it announced. */
async function startControlPlane(t: TestHook): Promise<string> {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t103-e2e-'));
  const child: CommandChild = spawn(process.execPath, [BIN_PATH], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(100);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before it was ready (code ${child.exitCode})\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    const line = out
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) return (JSON.parse(line) as { url: string }).url;
    await delay(50);
  }

  throw new Error(`the control plane was not ready within ${DEADLINE_MS}ms\nstdout:\n${out}`);
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
          trabalhos: [
            {
              id: JOB_ID,
              titulo: 'trabalho disputado',
              no_atual: 'implementar',
              bloqueado: false,
              execucao_id: 1,
              grafo_versao_id: 'sha256:e2e',
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
  const { ClienteControle } = await loadClient();
  const { Controller } = await loadController();

  const urlBase = await startControlPlane(t);
  const doFetch = fetchWithSeededQueue();

  const clientA = new ClienteControle({ urlBase, buscar: doFetch });
  const clientB = new ClienteControle({ urlBase, buscar: doFetch });
  await clientA.registrarRunner('runner-a', 'the one that dies');
  await clientB.registrarRunner('runner-b', 'the one that inherits');

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
      return new Promise<void>(() => undefined);
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

  const response = await fetch(`${urlBase}/v1/leases?projeto_id=3`);
  assert.equal(response.status, 200);
  const all = (await response.json()) as { leases: LeaseRow[] };
  const leases = all.leases.filter((lease) => lease.trabalho_id === JOB_ID);

  const fromRunnerA = leases.filter((lease) => lease.runner_id === 'runner-a');
  assert.equal(fromRunnerA.length, 1);
  assert.equal(fromRunnerA[0].status, 'expirada', 'the lease of the dead runner is claimed');
  assert.equal(
    fromRunnerA[0].motivo_expiracao,
    'expirou',
    'runner-a never renewed: the term simply ran out',
  );

  const fromRunnerB = leases.filter((lease) => lease.runner_id === 'runner-b');
  assert.equal(fromRunnerB.length, 1, 'runner-b took the same work, with a lease of its own');
  assert.equal(fromRunnerB[0].id, inherited.leaseId);
  assert.equal(
    fromRunnerB[0].status,
    'liberada',
    'with the dispatch finished, runner-b gave the capacity back',
  );
});
