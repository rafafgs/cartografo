/**
 * Acceptance tests of `status` (t108, FR5; counts made real by t199, FR1).
 *
 * Since t354 the field that holds the graph CLASSES is called `classes`, and
 * `projects` holds the real projects D25 introduced (`GET /v1/projects`). The
 * old name meant the classes, which was merely loose while no project existed
 * and became a collision the moment one did — so the rename lands in the same
 * delivery that creates the collision, and these pins move with it.
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
  SHIPPED_CLASS,
  startControlPlane,
} from './cli-support.ts';

const FACTORY_CLASS = 'software-development';

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
    body: JSON.stringify({ title: 'a job the status counts', entry_node_id: 'refinar' }),
  });
  assert.equal(jobResponse.status, 201, `POST /v1/jobs returned ${jobResponse.status}`);
  const job = (await jobResponse.json()) as CreatedJob;

  const questionResponse = await fetch(`${url}/v1/input-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: job.id,
      kind: 'question',
      question: 'Does it count as pending?',
      auto_approvable: false,
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

  // "Empty" is one class short of empty since t360: `up` registers the
  // interview before it announces itself, so a control plane nobody has
  // imported anything into still knows `map-design`. What this case pins is the
  // SHAPE — five keys, both counts `0` rather than `null` — so the class list is
  // read for the one entry that is there rather than for being absent.
  const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(report), [
    'server',
    'classes',
    'projects',
    'jobs',
    'pendingInputRequests',
  ]);
  assert.equal(report.server, 'ok');
  assert.deepEqual(
    (report.classes as { class: string }[]).map((entry) => entry.class),
    [SHIPPED_CLASS],
    'the interview that ships in the box, and nothing anybody imported',
  );
  assert.deepEqual(report.projects, [{ id: 1, name: 'default' }]);
  assert.equal(report.jobs, 0, '`0` is "queried, and empty"; `null` would be "not queried"');
  assert.equal(report.pendingInputRequests, 0);
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
    classes: { class: string; current_version_id: string }[];
    projects: { id: number; name: string }[];
    jobs: number | null;
    pendingInputRequests: number | null;
  };
  assert.equal(report.server, 'ok');
  assert.deepEqual(
    report.classes.filter((entry) => entry.class !== SHIPPED_CLASS),
    [{ class: FACTORY_CLASS, current_version_id: version }],
    'beside the interview `up` registered on its own (t360)',
  );
  assert.deepEqual(report.projects, [{ id: 1, name: 'default' }]);
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
    '{"server":"unavailable","classes":null,"projects":null,"jobs":null,"pendingInputRequests":null}',
    '`null` is "could not be queried"; `0` would claim an empty queue nobody looked at',
  );
});
