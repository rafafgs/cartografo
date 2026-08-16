/**
 * Acceptance tests of `status` (t108, FR5; counts made real by t199, FR1).
 *
 * The shape of `--json` is pinned byte for byte against an empty control plane,
 * for the same reason `health.test.ts` pins the `/health` body: it is machine
 * output, and a field that silently appears or disappears breaks its consumers.
 * What the pin protects now is that `jobs`/`pendingInputRequests` are NUMBERS —
 * `0` against an empty control plane, not the `null` of a field nobody counts.
 * `trabalho` and `pergunta` have existed since migration `0003`, and
 * `GET /v1/jobs` and `GET /v1/input-requests?status=pendente` answer both fields
 * for real; `null` survives only for the report that could not be queried at all.
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

/** A job, in the only part these tests read of it. */
interface CreatedJob {
  id: number;
}

/**
 * Seeds the control plane through the PUBLIC API, as a person would.
 *
 * `startControlPlane` authorizes the global `fetch` against the control plane it
 * started, so these two calls carry the operator credential without saying so.
 *
 * @param url Base URL of the control plane.
 * @returns The job that now waits on a pending question.
 */
async function seedOneJobAndOnePendingQuestion(url: string): Promise<CreatedJob> {
  const jobResponse = await fetch(`${url}/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ titulo: 'trabalho que o status conta', no_entrada_id: 'refinar' }),
  });
  assert.equal(jobResponse.status, 201, `POST /v1/jobs returned ${jobResponse.status}`);
  const job = (await jobResponse.json()) as CreatedJob;

  const questionResponse = await fetch(`${url}/v1/input-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      trabalho_id: job.id,
      tipo: 'pergunta',
      pergunta: 'Conta como pendente?',
      auto_aprovavel: false,
    }),
  });
  assert.equal(
    questionResponse.status,
    201,
    `POST /v1/input-requests returned ${questionResponse.status}`,
  );

  return job;
}

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
    '{"server":"ok","projects":[],"jobs":0,"pendingInputRequests":0}',
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

  await seedOneJobAndOnePendingQuestion(controlPlane.url);

  const result = await runCli(['status', '--json', '--url', controlPlane.url], {
    token: controlPlane.token,
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

  const report = JSON.parse(result.stdout) as {
    server: string;
    projects: { classe: string; versao_corrente_id: string }[];
    jobs: number | null;
    pendingInputRequests: number | null;
  };
  assert.equal(report.server, 'ok');
  assert.deepEqual(report.projects, [{ classe: FACTORY_CLASS, versao_corrente_id: version }]);
  assert.equal(report.jobs, 1, 'the job created through the API is counted');
  assert.equal(report.pendingInputRequests, 1, 'the pending question is counted');

  const table = await runCli(['status', '--url', controlPlane.url], {
    token: controlPlane.token,
  });
  assert.equal(table.code, 0, `stderr:\n${table.stderr}`);
  assert.match(table.stdout, /server: ok/);
  assert.match(table.stdout, new RegExp(FACTORY_CLASS));
  assert.match(table.stdout, new RegExp(version));
  assert.match(table.stdout, /^jobs: 1$/m);
  assert.match(table.stdout, /^pendingInputRequests: 1$/m);
  assert.doesNotMatch(
    table.stdout,
    /not tracked yet|later ticket/,
    'the two counts are tracked now, and the table no longer says otherwise',
  );
});

test('AT10 — status against an unreachable server says `server: unavailable` and exits non-zero', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const result = await runCli(['status', '--url', `http://127.0.0.1:${port}`]);

  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /server: unavailable/);
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
});

test('AT10 — an unreachable server keeps both counts null, never zero', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const result = await runCli(['status', '--json', '--url', `http://127.0.0.1:${port}`]);

  assert.notEqual(result.code, 0);
  assert.equal(
    result.stdout.trim(),
    '{"server":"unavailable","projects":null,"jobs":null,"pendingInputRequests":null}',
    '`null` is "could not be queried"; `0` would claim an empty queue nobody looked at',
  );
});
