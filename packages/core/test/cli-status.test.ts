/**
 * Acceptance tests of `status` (t108, FR5).
 *
 * The shape of `--json` is pinned byte for byte against an empty control plane,
 * for the same reason `health.test.ts` pins the `/health` body: it is machine
 * output, and a field that silently appears or disappears breaks its consumers.
 * What the pin protects most is `jobs`/`pendingInputRequests` being `null` — the
 * `sessao`/`input_request` tables do not exist (`migrations/0001_init.sql`), and
 * a `0` there would assert "empty queue" when the honest answer is "not tracked
 * yet".
 *
 * The keys are English since t127 (FR6): this is a bespoke CLI shape, like the
 * readiness line, and no other package parses it.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  FACTORY_BUNDLE,
  temporaryArea,
  looksLikeStackTrace,
  freePort,
  firstHash,
  runCli,
  startControlPlane,
} from './cli-support.ts';

const FACTORY_CLASS = 'desenvolvimento-de-software';

test('AT8 — status --json against an empty control plane has a pinned shape', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'cartografo.db'),
  });

  const result = await runCli(['status', '--json'], {
    token: controlPlane.token,
    env: { CARTOGRAFO_URL: controlPlane.url },
  });

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.equal(
    result.stdout.trim(),
    '{"server":"ok","projects":[],"jobs":null,"pendingInputRequests":null}',
  );
});

test('AT9 — after importing, status --json lists the class with its current version', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'cartografo.db'),
  });

  const importResult = await runCli(['import', FACTORY_BUNDLE, '--url', controlPlane.url], {
    token: controlPlane.token,
  });
  assert.equal(importResult.code, 0, `stderr:\n${importResult.stderr}`);
  const version = firstHash(importResult.stdout);

  const result = await runCli(['status', '--json', '--url', controlPlane.url], {
    token: controlPlane.token,
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

  const report = JSON.parse(result.stdout) as {
    server: string;
    projects: { classe: string; versao_corrente_id: string }[];
    jobs: null;
    pendingInputRequests: null;
  };
  assert.equal(report.server, 'ok');
  assert.deepEqual(report.projects, [{ classe: FACTORY_CLASS, versao_corrente_id: version }]);
  assert.equal(report.jobs, null);
  assert.equal(report.pendingInputRequests, null);

  const table = await runCli(['status', '--url', controlPlane.url], {
    token: controlPlane.token,
  });
  assert.equal(table.code, 0, `stderr:\n${table.stderr}`);
  assert.match(table.stdout, /server: ok/);
  assert.match(table.stdout, new RegExp(FACTORY_CLASS));
  assert.match(table.stdout, new RegExp(version));
});

test('AT10 — status against an unreachable server says `server: unavailable` and exits non-zero', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const result = await runCli(['status', '--url', `http://127.0.0.1:${port}`]);

  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /server: unavailable/);
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
});
