/**
 * Acceptance tests of the write half of the CLI, plus its two remaining reads
 * (t544, D26): `answer`, `block`, `unblock`, `job create`, `example run`,
 * `examples`, `runners`, `runners recheck` and `settings`.
 *
 * Against a REAL control plane, through the real binary, seeded through the
 * public API exactly as an operator would — the same posture `cli-reads.test.ts`
 * (t542) already takes.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BETS_BUNDLE, firstHash, runCli, startControlPlane, temporaryArea, type RunningControlPlane } from './cli-support.ts';

/** A job, in the fields these tests read. */
interface Job {
  id: number;
  entry_node_id: string;
  current_node_id: string;
  graph_version_id: string | null;
  blocked: boolean;
  block_reason: string | null;
}

/** An input request, in the fields these tests read. */
interface InputRequest {
  id: number;
  status: string;
  answer: string | null;
  answered_by: string | null;
}

/** POSTs to the control plane and demands the status it promised. */
async function post<T>(plane: RunningControlPlane, route: string, body: unknown, expected = 201): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `POST ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** A direct GET of the control plane, for comparison against the CLI's own writes. */
async function get<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Events of one job, in the fields these tests read. */
interface JobEvent {
  type: string;
  actor: { type: string; ref: string };
  data: Record<string, unknown>;
}

/** Writes a temp file and returns its path; removed at the end of the test. */
function tempFile(t: { after: (fn: () => void) => void }, name: string, content: string): string {
  const area = mkdtempSync(path.join(tmpdir(), 'cartografo-t544-'));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const file = path.join(area, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

test(
  'AT1/2/3/4 — answer: a positional argument, --file, blank/missing exits 2, unknown id exits 1',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t544-answer-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

    const jobOne = await post<Job>(plane, '/v1/jobs', { title: 'needs an answer', entry_node_id: 'refine' });
    await post(plane, `/v1/jobs/${jobOne.id}/blocks`, { reason: 'waiting on a question' }, 200);
    const requestOne = await post<InputRequest>(plane, '/v1/input-requests', {
      job_id: jobOne.id,
      kind: 'question',
      question: 'what should it do?',
      auto_approvable: false,
    });

    // AT1 — a positional argument answers and, in the same transaction, unblocks.
    const answered = await runCli(
      ['answer', String(requestOne.id), 'text', '--by', 'test-operator', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(answered.code, 0, `stderr:\n${answered.stderr}`);

    const directRequests = await get<{ input_requests: InputRequest[] }>(
      plane,
      `/v1/input-requests?job_id=${jobOne.id}&status=answered&project_id=1`,
    );
    assert.equal(directRequests.input_requests.length, 1);
    assert.equal(directRequests.input_requests[0].status, 'answered');
    assert.equal(directRequests.input_requests[0].answer, 'text');
    assert.equal(directRequests.input_requests[0].answered_by, 'test-operator');

    const directJobOne = await get<Job>(plane, `/v1/jobs/${jobOne.id}?project_id=1`);
    assert.equal(directJobOne.blocked, false);

    // AT2 — --file reads the answer text from a temp file.
    const jobTwo = await post<Job>(plane, '/v1/jobs', { title: 'needs a file answer', entry_node_id: 'refine' });
    await post(plane, `/v1/jobs/${jobTwo.id}/blocks`, { reason: 'waiting on a second question' }, 200);
    const requestTwo = await post<InputRequest>(plane, '/v1/input-requests', {
      job_id: jobTwo.id,
      kind: 'question',
      question: 'and this one?',
      auto_approvable: false,
    });
    const filePath = tempFile(t, 'answer.txt', 'from a file\n');
    const answeredFromFile = await runCli(
      ['answer', String(requestTwo.id), '--file', filePath, '--by', 'test-operator', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(answeredFromFile.code, 0, `stderr:\n${answeredFromFile.stderr}`);
    const directRequestTwo = await get<{ input_requests: InputRequest[] }>(
      plane,
      `/v1/input-requests?job_id=${jobTwo.id}&status=answered&project_id=1`,
    );
    assert.equal(directRequestTwo.input_requests[0].answer, 'from a file');
    const directJobTwo = await get<Job>(plane, `/v1/jobs/${jobTwo.id}?project_id=1`);
    assert.equal(directJobTwo.blocked, false);

    // AT3 — neither a positional argument nor --file, and blank after trim: both exit 2.
    const jobThree = await post<Job>(plane, '/v1/jobs', { title: 'a third question', entry_node_id: 'refine' });
    const requestThree = await post<InputRequest>(plane, '/v1/input-requests', {
      job_id: jobThree.id,
      kind: 'question',
      question: 'unanswered?',
      auto_approvable: false,
    });
    const neither = await runCli(['answer', String(requestThree.id), '--url', plane.url], { token: plane.token });
    assert.equal(neither.code, 2);
    const blank = await runCli(['answer', String(requestThree.id), '   ', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(blank.code, 2);
    const directRequestThree = await get<{ input_requests: InputRequest[] }>(
      plane,
      `/v1/input-requests?job_id=${jobThree.id}&status=pending&project_id=1`,
    );
    assert.equal(directRequestThree.input_requests[0]?.id, requestThree.id);

    // AT4 — an unknown id exits 1 and says so.
    const unknown = await runCli(['answer', '424242', 'text', '--url', plane.url], { token: plane.token });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /no input request #424242/);
  },
);

test('AT5/6 — block: --reason records the reason and the actor; missing/blank exits 2', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-block-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  const job = await post<Job>(plane, '/v1/jobs', { title: 'a job to hold', entry_node_id: 'refine' });

  // AT5
  const blocked = await runCli(
    ['block', String(job.id), '--reason', 'waiting on legal', '--by', 'alice', '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(blocked.code, 0, `stderr:\n${blocked.stderr}`);

  const directJob = await get<Job>(plane, `/v1/jobs/${job.id}?project_id=1`);
  assert.equal(directJob.blocked, true);
  assert.equal(directJob.block_reason, 'waiting on legal');

  const events = await get<{ events: JobEvent[] }>(plane, `/v1/jobs/${job.id}/events?project_id=1`);
  const blockedEvent = events.events.find((event) => event.type === 'job.blocked');
  assert.ok(blockedEvent, 'no job.blocked event');
  assert.deepEqual(blockedEvent?.actor, { type: 'user', ref: 'alice' });

  // AT6 — no --reason, and --reason "   ": both exit 2, job unchanged.
  const jobTwo = await post<Job>(plane, '/v1/jobs', { title: 'another job', entry_node_id: 'refine' });
  const noReason = await runCli(['block', String(jobTwo.id), '--url', plane.url], { token: plane.token });
  assert.equal(noReason.code, 2);
  const blankReason = await runCli(['block', String(jobTwo.id), '--reason', '   ', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(blankReason.code, 2);
  const directJobTwo = await get<Job>(plane, `/v1/jobs/${jobTwo.id}?project_id=1`);
  assert.equal(directJobTwo.blocked, false);
});

test('AT7/8 — unblock: --note is optional; the event carries what was sent', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-unblock-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  // AT7
  const jobOne = await post<Job>(plane, '/v1/jobs', { title: 'blocked, then released', entry_node_id: 'refine' });
  await post(plane, `/v1/jobs/${jobOne.id}/blocks`, { reason: 'promotion pending' }, 200);
  const unblocked = await runCli(
    ['unblock', String(jobOne.id), '--note', 'promotion released', '--by', 'bob', '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(unblocked.code, 0, `stderr:\n${unblocked.stderr}`);

  const directJobOne = await get<Job>(plane, `/v1/jobs/${jobOne.id}?project_id=1`);
  assert.equal(directJobOne.blocked, false);

  const eventsOne = await get<{ events: JobEvent[] }>(plane, `/v1/jobs/${jobOne.id}/events?project_id=1`);
  const unblockedEventOne = eventsOne.events.find((event) => event.type === 'job.unblocked');
  assert.ok(unblockedEventOne, 'no job.unblocked event');
  assert.deepEqual(unblockedEventOne?.actor, { type: 'user', ref: 'bob' });
  assert.equal(unblockedEventOne?.data.reason, 'promotion released');

  // AT8 — no --note: the event's data.reason is null.
  const jobTwo = await post<Job>(plane, '/v1/jobs', { title: 'blocked, released with no note', entry_node_id: 'refine' });
  await post(plane, `/v1/jobs/${jobTwo.id}/blocks`, { reason: 'something' }, 200);
  const unblockedNoNote = await runCli(['unblock', String(jobTwo.id), '--by', 'bob', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(unblockedNoNote.code, 0, `stderr:\n${unblockedNoNote.stderr}`);

  const eventsTwo = await get<{ events: JobEvent[] }>(plane, `/v1/jobs/${jobTwo.id}/events?project_id=1`);
  const unblockedEventTwo = eventsTwo.events.find((event) => event.type === 'job.unblocked');
  assert.ok(unblockedEventTwo, 'no job.unblocked event');
  assert.equal(unblockedEventTwo?.data.reason, null);
});

test('AT9/10 — job create: a real graph version, and each missing/invalid input exits 2', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-job-create-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  const imported = await runCli(['import', BETS_BUNDLE, '--url', plane.url], { token: plane.token });
  assert.equal(imported.code, 0, `stdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`);
  const versionId = firstHash(imported.stdout);

  // AT9
  const inputFile = tempFile(
    t,
    'job-input.json',
    JSON.stringify({
      title: 'Navelar Logistics — repricing after the sale',
      entry_node_id: 'triage',
      fields: { asset: 'NVLR3', premise_source: 'material fact', intended_size: 1.5 },
    }),
  );
  const created = await runCli(
    ['job', 'create', '--graph', versionId, '--input', inputFile, '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(created.code, 0, `stderr:\n${created.stderr}`);

  const jsonResult = JSON.parse(
    (await runCli(
      ['job', 'create', '--graph', versionId, '--input', inputFile, '--json', '--url', plane.url],
      { token: plane.token },
    )).stdout,
  ) as Job;
  const directJob = await get<Job>(plane, `/v1/jobs/${jsonResult.id}?project_id=1`);
  assert.equal(directJob.entry_node_id, 'triage');
  assert.equal(directJob.graph_version_id, versionId);

  // AT10 — missing --graph, missing --input, and invalid JSON: each exits 2.
  const before = await get<{ jobs: Job[] }>(plane, '/v1/jobs?project_id=1');

  const missingGraph = await runCli(['job', 'create', '--input', inputFile, '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(missingGraph.code, 2);

  const missingInput = await runCli(['job', 'create', '--graph', versionId, '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(missingInput.code, 2);

  const badJsonFile = tempFile(t, 'bad.json', '{not json');
  const invalidJson = await runCli(
    ['job', 'create', '--graph', versionId, '--input', badJsonFile, '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(invalidJson.code, 2);

  const after = await get<{ jobs: Job[] }>(plane, '/v1/jobs?project_id=1');
  assert.equal(after.jobs.length, before.jobs.length);
});

test('AT11/12 — example run registers and opens the demo; examples lists registered before/after', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-examples-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  const before = await runCli(['examples', '--json', '--url', plane.url], { token: plane.token });
  assert.equal(before.code, 0, `stderr:\n${before.stderr}`);
  const beforeParsed = JSON.parse(before.stdout) as { examples: { class: string; registered: boolean }[] };
  const bets = beforeParsed.examples.find((example) => example.class === 'asymmetric-bets');
  assert.ok(bets, 'asymmetric-bets is not in the examples list');
  assert.equal(bets?.registered, false);

  const directBefore = await get(plane, '/v1/examples?project_id=1');
  assert.deepEqual(JSON.parse(before.stdout), directBefore);

  const ran = await runCli(['example', 'run', 'asymmetric-bets', '--url', plane.url], { token: plane.token });
  assert.equal(ran.code, 0, `stderr:\n${ran.stderr}`);
  assert.match(ran.stdout, /execution_id/);

  const ranJson = JSON.parse(
    (await runCli(['example', 'run', 'asymmetric-bets', '--json', '--url', plane.url], {
      token: plane.token,
    })).stdout,
  ) as { job: Job; execution_id: number; registered: boolean };
  const directJob = await get<Job>(plane, `/v1/jobs/${ranJson.job.id}?project_id=1`);
  assert.equal(directJob.entry_node_id, 'triage');

  const after = await runCli(['examples', '--json', '--url', plane.url], { token: plane.token });
  const afterParsed = JSON.parse(after.stdout) as { examples: { class: string; registered: boolean }[] };
  const betsAfter = afterParsed.examples.find((example) => example.class === 'asymmetric-bets');
  assert.equal(betsAfter?.registered, true);
});

test('AT13 — runners prints the exact pairing command when nothing is paired', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-runners-pairing-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  // Project 1 gets `workspace_root`/`worktrees_root` seeded by every startup
  // (`seedDefaultSettings`, `src/index.ts`) — so the pairing command over it
  // exercises the DECISION LOGIC against real, non-placeholder values.
  const settings = await get<{ workspace_root?: string; worktrees_root?: string; engine?: string }>(
    plane,
    '/v1/settings?project_id=1',
  );
  const seeded = await runCli(['runners', '--url', plane.url], { token: plane.token });
  assert.equal(seeded.code, 0, `stderr:\n${seeded.stderr}`);
  assert.match(
    seeded.stdout,
    new RegExp(
      `npx cartografo-runner --project 1 --working-dir ${settings.workspace_root} --worktrees-root ${settings.worktrees_root} --engine ${settings.engine ?? 'claude-code'}`,
    ),
  );

  // A project with no settings recorded at all gets the literal placeholders
  // (AC2) — `pairingCommand`'s wording, byte for byte.
  const project = await post<{ id: number }>(plane, '/v1/projects', { name: 'a project with nothing recorded' });
  const placeholders = await runCli(['runners', '--project', String(project.id), '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(placeholders.code, 0, `stderr:\n${placeholders.stderr}`);
  assert.match(
    placeholders.stdout,
    new RegExp(
      `npx cartografo-runner --project ${project.id} --working-dir <the repository the sessions work in> --worktrees-root <a sibling directory, never inside it> --engine claude-code`,
    ),
  );
});

test('AT14/15 — runners recheck is idempotent while pending; an unknown id exits 1', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-runners-recheck-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  await post(plane, '/v1/runners', { id: 'r1' });

  const first = await runCli(['runners', 'recheck', 'r1', '--url', plane.url], { token: plane.token });
  assert.equal(first.code, 0, `stderr:\n${first.stderr}`);

  const directFirst = await get<{ recheck: { id: number; requested_at: string } | null }>(
    plane,
    '/v1/runners/r1/rechecks',
  );
  assert.ok(directFirst.recheck, 'no pending recheck after the first request');

  const second = await runCli(['runners', 'recheck', 'r1', '--url', plane.url], { token: plane.token });
  assert.equal(second.code, 0, `stderr:\n${second.stderr}`);

  const directSecond = await get<{ recheck: { id: number; requested_at: string } | null }>(
    plane,
    '/v1/runners/r1/rechecks',
  );
  assert.ok(directSecond.recheck, 'no pending recheck after the second request');
  assert.equal(directSecond.recheck?.id, directFirst.recheck?.id);

  // AT15
  const unknown = await runCli(['runners', 'recheck', 'nope', '--url', plane.url], { token: plane.token });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no runner "nope"/);
});

test('AT16/17 — settings set/get round-trip; an unknown key exits 2 before any network call', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t544-settings-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  // AT16
  const set = await runCli(['settings', 'set', 'workspace_root', '/tmp/x', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(set.code, 0, `stderr:\n${set.stderr}`);

  const got = await runCli(['settings', 'get', '--json', '--url', plane.url], { token: plane.token });
  assert.equal(got.code, 0, `stderr:\n${got.stderr}`);
  const gotParsed = JSON.parse(got.stdout) as { workspace_root?: string };
  assert.equal(gotParsed.workspace_root, '/tmp/x');

  const direct = await get<{ workspace_root?: string }>(plane, '/v1/settings?project_id=1');
  assert.equal(direct.workspace_root, '/tmp/x');

  // AT17 — an unknown key refuses before any request goes out at all: same
  // message whether the control plane is reachable or not.
  const withRealServer = await runCli(['settings', 'set', 'bogus-key', 'value', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(withRealServer.code, 2);

  const withNoServer = await runCli(
    ['settings', 'set', 'bogus-key', 'value', '--url', 'http://127.0.0.1:1'],
    { token: plane.token, timeoutMs: 15_000 },
  );
  assert.equal(withNoServer.code, 2);
  assert.equal(withNoServer.stderr, withRealServer.stderr);
});
