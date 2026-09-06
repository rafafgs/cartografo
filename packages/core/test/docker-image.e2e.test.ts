/**
 * Acceptance test of the real image (t250, FR1-FR6; D23).
 *
 * `docker-artifacts.test.ts` next door reads the files. This one builds them:
 * `docker build`, two containers from the resulting image, and the one property
 * that cannot be read off a `Dockerfile` at all — that the DATA outlives the
 * container. A `VOLUME` line and a `-v` flag both look right in a diff while the
 * database quietly lives on the writable layer, and the only way to know is to
 * stop a container and ask a second one what it can still see.
 *
 * The proof is deliberately a real write through the public API: `PATCH
 * /v1/settings` sets `engine`, the container is stopped (not removed — removing
 * it would leave "the volume survived" and "the container was still there"
 * indistinguishable), a second container starts against the same directory, and
 * `GET /v1/settings` has to answer with what the FIRST one wrote. The same
 * bootstrap token works for both, which is a second thing this case pins: a
 * startup against a database that already holds a live operator credential
 * mints no new one (`packages/core/src/index.ts:283-287`), so the token an
 * operator wrote down on day one is still the token on day two.
 *
 * Skipped where Docker is not installed or its daemon is not up, following the
 * convention of `packages/runner/test/controller/multi-runner-fleet.e2e.test.ts:304`:
 * missing infrastructure is a skip, never a red. This is by far the slowest case
 * in the suite — the build resolves the whole monorepo's dependency tree and
 * then installs the packed tarball's — so the deadlines below are minutes.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** Tag the case builds and tears down; local to this suite. */
const IMAGE = 'cartografo-docker-test';

/** Names of the two containers, so the teardown can find them whatever happened. */
const FIRST = 'cartografo-docker-test-1';
const SECOND = 'cartografo-docker-test-2';

/** `npm ci` plus a native rebuild is minutes, and the first build is the slow one. */
const BUILD_DEADLINE_MS = 1_800_000;

/** A container that has to migrate a database and pass three health probes. */
const HEALTHY_DEADLINE_MS = 180_000;

/** Everything else — `docker port`, `docker logs`, `docker stop`. */
const DOCKER_DEADLINE_MS = 60_000;

const POLL_MS = 500;

/** The value written through the first container and read back through the second. */
const WITNESS = 'docker-persistence-check';

/**
 * Whether this machine can run the case at all.
 *
 * Both halves matter: `docker --version` answers on a machine whose daemon is
 * not running, and a build against a dead daemon is a failure that says nothing
 * about this repository.
 */
function dockerIsAvailable(): boolean {
  for (const args of [['--version'], ['info']]) {
    const probe = spawnSync('docker', args, { stdio: 'ignore', timeout: DOCKER_DEADLINE_MS });
    if (probe.error !== undefined || probe.status !== 0) return false;
  }
  return true;
}

/** Runs a docker command, handing back its stdout. */
function docker(args: string[], timeout = DOCKER_DEADLINE_MS): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout });
}

/**
 * Starts a container from the built image as the control plane.
 *
 * The host port is left to Docker (`-p 127.0.0.1::4317`) and read back
 * afterwards: this suite runs on the machine of whoever typed `npm test`, and
 * picking 4317 would collide with the control plane they may well have running.
 * Loopback on the host side for the same reason the image refuses to bake
 * `CARTOGRAFO_HOST` — a test must not open a port on somebody's network.
 *
 * @param name Container name.
 * @param dataDir Host directory bind-mounted at `/data`.
 * @returns The base URL the host reaches this container's control plane on.
 */
function startControlPlane(name: string, dataDir: string): string {
  docker([
    'run',
    '--detach',
    '--name',
    name,
    '--env',
    'CARTOGRAFO_HOST=0.0.0.0',
    '--publish',
    '127.0.0.1::4317',
    '--volume',
    `${dataDir}:/data`,
    IMAGE,
  ]);

  const mapping = docker(['port', name, '4317/tcp']).trim().split('\n')[0] ?? '';
  const port = mapping.slice(mapping.lastIndexOf(':') + 1);
  assert.match(port, /^\d+$/, `docker did not report a mapped host port for ${name}: "${mapping}"`);
  return `http://127.0.0.1:${port}`;
}

/**
 * Waits for the image's own `HEALTHCHECK` to report the container healthy.
 *
 * Reading `.State.Health.Status` and not just polling the port is the point:
 * this is what asserts the `HEALTHCHECK` instruction works, which is the only
 * thing an orchestrator will ever look at.
 *
 * @param name Container name.
 */
async function waitUntilHealthy(name: string): Promise<void> {
  const deadline = Date.now() + HEALTHY_DEADLINE_MS;
  let status = '';
  while (Date.now() < deadline) {
    status = docker(['inspect', '--format', '{{.State.Health.Status}}', name]).trim();
    if (status === 'healthy') return;
    assert.notEqual(
      status,
      'unhealthy',
      `${name} reported unhealthy\n${docker(['logs', '--tail', '50', name])}`,
    );
    await delay(POLL_MS);
  }
  throw new Error(
    `${name} never became healthy within ${HEALTHY_DEADLINE_MS}ms (last status: "${status}")\n` +
      docker(['logs', '--tail', '50', name]),
  );
}

/** The `bootstrapToken` off the container's first readiness line. */
function bootstrapTokenOf(name: string): string {
  const logs = docker(['logs', name]);
  const line = logs.split('\n').find((entry) => entry.includes('"event":"cartografo.ready"'));
  assert.notEqual(line, undefined, `${name} never printed a readiness line\n${logs}`);

  const ready = JSON.parse(line as string) as { bootstrapToken: string | null };
  assert.notEqual(
    ready.bootstrapToken,
    null,
    'the first startup against an empty volume mints the operator credential and prints it once',
  );
  return ready.bootstrapToken as string;
}

test('t250 AT — the image builds, answers /health, and keeps its database on the volume', async (parent) => {
  if (!dockerIsAvailable()) {
    parent.skip('docker is not available on this machine');
    return;
  }

  // `realpathSync`: on macOS `tmpdir()` is a symlink into `/private/var`, and
  // Docker Desktop shares the resolved path, not the link.
  const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cartografo-t250-docker-')));

  parent.after(() => {
    for (const name of [FIRST, SECOND]) {
      spawnSync('docker', ['rm', '--force', '--volumes', name], {
        stdio: 'ignore',
        timeout: DOCKER_DEADLINE_MS,
      });
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  let token = '';

  await parent.test('AT — `docker build` succeeds from the repository root', () => {
    execFileSync('docker', ['build', '--tag', IMAGE, '.'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: BUILD_DEADLINE_MS,
    });
  });

  await parent.test('AT — the container reports healthy and /health answers the wire contract', async () => {
    const base = startControlPlane(FIRST, dataDir);
    await waitUntilHealthy(FIRST);

    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      { status: 'ok', db: 'ok' },
      'the container answers exactly what `packages/core/src/routes/health.ts:52-56` returns',
    );
  });

  await parent.test('AT — the bootstrap token off the readiness line writes a setting', async () => {
    token = bootstrapTokenOf(FIRST);
    const base = `http://127.0.0.1:${docker(['port', FIRST, '4317/tcp']).trim().split(':').pop() as string}`;

    const response = await fetch(`${base}/v1/settings`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ engine: WITNESS }),
    });

    // Read once, assert after: `assert.equal`'s message argument is evaluated
    // whether or not it is needed, and a body consumed there is a body gone.
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text) as { engine?: string };
    assert.equal(body.engine, WITNESS, 'the control plane echoes back the setting it wrote');
  });

  await parent.test('AT — a second container on the same volume still sees the write', async () => {
    assert.notEqual(token, '', 'the write case has to have run first');

    docker(['stop', FIRST]);

    const base = startControlPlane(SECOND, dataDir);
    await waitUntilHealthy(SECOND);

    const response = await fetch(`${base}/v1/settings`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const text = await response.text();
    assert.equal(
      response.status,
      200,
      `the same token has to work: a second startup mints no new one\n${text}`,
    );
    const body = JSON.parse(text) as { engine?: string };
    assert.equal(
      body.engine,
      WITNESS,
      'the volume, and not the first container\'s writable layer, is what holds the database',
    );
  });
});
