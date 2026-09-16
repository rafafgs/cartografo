/**
 * Acceptance tests of the seven read subcommands (t542, D26): `jobs`,
 * `job <id>`, `executions`, `execution <id>`, `sessions`,
 * `transcript <session-id>` and `input-requests`.
 *
 * Against a REAL control plane, through the real binary, seeded through the
 * public API exactly as an operator would — the same posture
 * `cli-export-history.test.ts` and `cli-status.test.ts` already take.
 *
 * `buildTimeline` and `failedLineIndex` are imported straight from
 * `src/cli/reads.ts` (the copy this ticket makes, FR10) so the timeline and
 * transcript-cut tests can compute the expected answer independently of the
 * command's own text formatting.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { buildTimeline, failedLineIndex } from '../src/cli/reads.ts';
import { runCli, startControlPlane, temporaryArea, type RunningControlPlane } from './cli-support.ts';

/** A job, in the fields these tests read. */
interface Job {
  id: number;
  execution_id: number | null;
  current_node_id: string;
  state: string;
  completed: boolean;
  blocked: boolean;
  title: string;
}

/** A session, in the fields these tests read. */
interface Session {
  id: number;
  job_id: number | null;
}

/** An input request, in the fields these tests read. */
interface InputRequest {
  id: number;
  job_id: number;
}

/** POSTs to the control plane and demands the status it promised. */
async function post<T>(
  plane: RunningControlPlane,
  route: string,
  body: unknown,
  expected = 201,
): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `POST ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Same, for the PATCHes these fixtures need. */
async function patch<T>(plane: RunningControlPlane, route: string, body: unknown): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `PATCH ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** A direct GET of the control plane, for comparison against the CLI's own reads. */
async function get<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

test(
  'AT1/2/3 — jobs lists the board, --state filters client-side, and --json matches a direct GET',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t542-jobs-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

    const queuedAtEntry = await post<Job>(plane, '/v1/jobs', {
      title: 'queued at entry',
      entry_node_id: 'refine',
    });
    const queuedAfterMove = await post<Job>(plane, '/v1/jobs', {
      title: 'queued after a transition',
      entry_node_id: 'refine',
    });
    await post(plane, `/v1/jobs/${queuedAfterMove.id}/transitions`, { to_node_id: 'develop' }, 200);
    const awaiting = await post<Job>(plane, '/v1/jobs', {
      title: 'has a pending question',
      entry_node_id: 'refine',
    });
    await post(plane, '/v1/input-requests', {
      job_id: awaiting.id,
      kind: 'question',
      question: 'what should it do?',
      auto_approvable: false,
    });

    // AT1 — one row per job, naming id, state and current_node_id.
    const table = await runCli(['jobs', '--url', plane.url], { token: plane.token });
    assert.equal(table.code, 0, `stderr:\n${table.stderr}`);
    assert.match(table.stdout, new RegExp(`${queuedAtEntry.id}\\s+queued\\s+refine`));
    assert.match(table.stdout, new RegExp(`${queuedAfterMove.id}\\s+queued\\s+develop`));
    assert.match(table.stdout, new RegExp(`${awaiting.id}\\s+awaiting_you\\s+refine`));

    // AT2 — --state filters client-side; a value RF-30 does not define is a
    // wrong command line, and the value shows up in the message.
    const onlyAwaiting = await runCli(['jobs', '--state', 'awaiting_you', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(onlyAwaiting.code, 0, `stderr:\n${onlyAwaiting.stderr}`);
    assert.match(onlyAwaiting.stdout, new RegExp(String(awaiting.id)));
    assert.doesNotMatch(onlyAwaiting.stdout, new RegExp(String(queuedAtEntry.id)));
    assert.doesNotMatch(onlyAwaiting.stdout, new RegExp(String(queuedAfterMove.id)));

    const bogus = await runCli(['jobs', '--state', 'bogus', '--url', plane.url], { token: plane.token });
    assert.equal(bogus.code, 2);
    assert.match(bogus.stderr, /"bogus"/);

    // AT3 — --json, filtered and unfiltered, deep-equals a direct GET with the
    // same client-side filter applied.
    const direct = await get<{ jobs: Job[] }>(plane, '/v1/jobs?project_id=1');

    const jsonAll = await runCli(['jobs', '--json', '--url', plane.url], { token: plane.token });
    assert.equal(jsonAll.code, 0, `stderr:\n${jsonAll.stderr}`);
    assert.deepEqual(JSON.parse(jsonAll.stdout), direct);

    const jsonFiltered = await runCli(
      ['jobs', '--state', 'queued', '--json', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(jsonFiltered.code, 0, `stderr:\n${jsonFiltered.stderr}`);
    assert.deepEqual(JSON.parse(jsonFiltered.stdout), {
      jobs: direct.jobs.filter((job) => job.state === 'queued'),
    });
  },
);

test(
  'AT4/5/6 — job <id> matches jobPage’s own timeline; --json has six keys; an unknown id exits 1',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t542-job-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

    const job = await post<Job>(plane, '/v1/jobs', { title: 'a whole traversal', entry_node_id: 'refine' });
    const session = await post<Session>(plane, '/v1/sessions', {
      job_id: job.id,
      node_id: 'refine',
      engine: 'shell',
      working_dir: '/tmp/cartografo',
      prompt: 'refine it',
    });
    await patch(plane, `/v1/sessions/${session.id}/finish`, { status: 'completed', exit_code: 0 });
    await post(plane, `/v1/jobs/${job.id}/transitions`, { to_node_id: 'develop' }, 200);
    await post(plane, `/v1/jobs/${job.id}/transitions`, { to_node_id: 'integrate' }, 200);

    const directJob = await get<Job>(plane, `/v1/jobs/${job.id}?project_id=1`);
    const directEvents = await get<{ events: unknown[] }>(plane, `/v1/jobs/${job.id}/events?project_id=1`);
    const directSessions = await get<{ sessions: unknown[] }>(
      plane,
      `/v1/sessions?job_id=${job.id}&project_id=1`,
    );
    const directQuestions = await get<{ input_requests: unknown[] }>(
      plane,
      `/v1/input-requests?job_id=${job.id}&project_id=1`,
    );
    const directArtifacts = await get<{ artifacts: unknown[] }>(
      plane,
      `/v1/jobs/${job.id}/artifacts?project_id=1`,
    );

    const expectedTimeline = buildTimeline({
      events: directEvents.events as Parameters<typeof buildTimeline>[0]['events'],
      sessions: directSessions.sessions as Parameters<typeof buildTimeline>[0]['sessions'],
      questions: directQuestions.input_requests as Parameters<typeof buildTimeline>[0]['questions'],
      completed: directJob.completed,
    });

    // AT4 — the human output's segment count, bucket totals and current-node
    // id match the timeline computed off the same three answers.
    const human = await runCli(['job', String(job.id), '--url', plane.url], { token: plane.token });
    assert.equal(human.code, 0, `stderr:\n${human.stderr}`);

    const segmentCount = (human.stdout.match(/^segment: /gm) ?? []).length;
    assert.equal(segmentCount, expectedTimeline.segments.length);

    const totalsMatch = /^totals: fila=(\d+) agente_trabalhando=(\d+) esperando_humano=(\d+)$/m.exec(
      human.stdout,
    );
    assert.ok(totalsMatch, `no totals line in:\n${human.stdout}`);
    assert.deepEqual(
      {
        fila: Number(totalsMatch[1]),
        agente_trabalhando: Number(totalsMatch[2]),
        esperando_humano: Number(totalsMatch[3]),
      },
      expectedTimeline.totals,
    );

    const nodeMatch = /current node (\S+)/.exec(human.stdout);
    assert.equal(nodeMatch?.[1], 'integrate');

    // AT5 — --json has exactly the six declared keys, and the first five
    // deep-equal the bodies of the direct GETs.
    const jsonResult = await runCli(['job', String(job.id), '--json', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(jsonResult.code, 0, `stderr:\n${jsonResult.stderr}`);
    const parsed = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['artifacts', 'events', 'job', 'questions', 'sessions', 'timeline'].sort(),
    );
    assert.deepEqual(parsed.job, directJob);
    assert.deepEqual(parsed.events, directEvents);
    assert.deepEqual(parsed.sessions, directSessions);
    assert.deepEqual(parsed.questions, directQuestions);
    assert.deepEqual(parsed.artifacts, directArtifacts);
    assert.deepEqual(parsed.timeline, expectedTimeline);

    // AT6 — an id nothing was ever created with exits 1 and says so.
    const missing = await runCli(['job', '424242', '--url', plane.url], { token: plane.token });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no job #424242/);
  },
);

test(
  'AT7 — executions and execution <id> match direct GETs; a round with nothing in it is not a 404',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t542-executions-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

    const roundId = 7;
    await post<Job>(plane, '/v1/jobs', {
      title: 'a job of round 7',
      entry_node_id: 'refine',
      execution_id: roundId,
    });

    const directExecutions = await get(plane, '/v1/executions?project_id=1');
    const executionsJson = await runCli(['executions', '--json', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(executionsJson.code, 0, `stderr:\n${executionsJson.stderr}`);
    assert.deepEqual(JSON.parse(executionsJson.stdout), directExecutions);

    const directJobs = await get(plane, `/v1/jobs?execution_id=${roundId}&project_id=1`);
    const directSessions = await get(plane, `/v1/sessions?execution_id=${roundId}&project_id=1`);
    const directQuestions = await get(
      plane,
      `/v1/input-requests?execution_id=${roundId}&status=pending&project_id=1`,
    );
    const executionJson = await runCli(['execution', String(roundId), '--json', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(executionJson.code, 0, `stderr:\n${executionJson.stderr}`);
    assert.deepEqual(JSON.parse(executionJson.stdout), {
      jobs: directJobs,
      sessions: directSessions,
      questions: directQuestions,
    });

    // An id nothing was ever created with is a round with zero jobs, never a 404.
    const empty = await runCli(['execution', '999999', '--url', plane.url], { token: plane.token });
    assert.equal(empty.code, 0, `stderr:\n${empty.stderr}`);
    const emptyJson = await runCli(['execution', '999999', '--json', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(emptyJson.code, 0);
    assert.deepEqual(JSON.parse(emptyJson.stdout), {
      jobs: { jobs: [] },
      sessions: { sessions: [] },
      questions: { input_requests: [] },
    });
  },
);

test('AT8 — sessions --job and --execution each return only the matching subset', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t542-sessions-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  const jobOne = await post<Job>(plane, '/v1/jobs', {
    title: 'job one',
    entry_node_id: 'refine',
    execution_id: 11,
  });
  const jobTwo = await post<Job>(plane, '/v1/jobs', {
    title: 'job two',
    entry_node_id: 'refine',
    execution_id: 22,
  });
  const sessionOne = await post<Session>(plane, '/v1/sessions', {
    job_id: jobOne.id,
    node_id: 'refine',
    engine: 'shell',
    working_dir: '/tmp/cartografo',
    prompt: 'one',
  });
  const sessionTwo = await post<Session>(plane, '/v1/sessions', {
    job_id: jobTwo.id,
    node_id: 'refine',
    engine: 'shell',
    working_dir: '/tmp/cartografo',
    prompt: 'two',
  });

  const byJob = await runCli(['sessions', '--job', String(jobOne.id), '--json', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(byJob.code, 0, `stderr:\n${byJob.stderr}`);
  const parsedByJob = JSON.parse(byJob.stdout) as { sessions: Session[] };
  assert.deepEqual(parsedByJob.sessions.map((session) => session.id), [sessionOne.id]);

  const byExecution = await runCli(
    ['sessions', '--execution', '22', '--json', '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(byExecution.code, 0, `stderr:\n${byExecution.stderr}`);
  const parsedByExecution = JSON.parse(byExecution.stdout) as { sessions: Session[] };
  assert.deepEqual(parsedByExecution.sessions.map((session) => session.id), [sessionTwo.id]);

  const humanByJob = await runCli(['sessions', '--job', String(jobOne.id), '--url', plane.url], {
    token: plane.token,
  });
  // Anchored on the `id` column itself: a bare id can otherwise appear by
  // accident inside a timestamp column.
  assert.match(humanByJob.stdout, new RegExp(`^${sessionOne.id}\\s`, 'm'));
  assert.doesNotMatch(humanByJob.stdout, new RegExp(`^${sessionTwo.id}\\s`, 'm'));
});

test(
  'AT9/10 — transcript --tail ends on the failed line; --json ignores --tail entirely',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t542-transcript-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

    const job = await post<Job>(plane, '/v1/jobs', { title: 'a failing session', entry_node_id: 'refine' });
    const session = await post<Session>(plane, '/v1/sessions', {
      job_id: job.id,
      node_id: 'refine',
      engine: 'shell',
      working_dir: '/tmp/cartografo',
      prompt: 'run the checks',
    });

    // `shell` decodes as a pure passthrough (`decodeShellSessionText`), which
    // is what makes the text predictable here.
    const transcriptLines = Array.from({ length: 25 }, (_, index) => `line ${index + 1} of output`);
    const transcriptText = transcriptLines.join('\n');
    await patch(plane, `/v1/sessions/${session.id}/finish`, {
      status: 'failed',
      exit_code: 1,
      transcript: transcriptText,
    });

    const expectedFailedIndex = failedLineIndex(transcriptText.split('\n'), 1);
    assert.equal(expectedFailedIndex, transcriptLines.length - 1);

    // AT9
    const tailed = await runCli(
      ['transcript', String(session.id), '--tail', '20', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(tailed.code, 0, `stderr:\n${tailed.stderr}`);
    const printed = tailed.stdout.replace(/\n$/, '').split('\n');
    assert.equal(printed.length, 20);
    assert.equal(printed[printed.length - 1], `>>> ${transcriptLines[transcriptLines.length - 1]}`);

    // AT10
    const directLog = await get(plane, `/v1/sessions/${session.id}/log?project_id=1`);
    const jsonWithTail = await runCli(
      ['transcript', String(session.id), '--tail', '5', '--json', '--url', plane.url],
      { token: plane.token },
    );
    const jsonWithoutTail = await runCli(
      ['transcript', String(session.id), '--json', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(jsonWithTail.code, 0, `stderr:\n${jsonWithTail.stderr}`);
    assert.equal(jsonWithoutTail.code, 0, `stderr:\n${jsonWithoutTail.stderr}`);
    assert.equal(jsonWithTail.stdout, jsonWithoutTail.stdout);
    assert.deepEqual(JSON.parse(jsonWithTail.stdout), directLog);
  },
);

test('AT11 — input-requests defaults to pending; --status answered shows the other', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t542-input-requests-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });

  const jobWithPending = await post<Job>(plane, '/v1/jobs', {
    title: 'still waiting',
    entry_node_id: 'refine',
  });
  const jobWithAnswered = await post<Job>(plane, '/v1/jobs', {
    title: 'already answered',
    entry_node_id: 'refine',
  });
  const pending = await post<InputRequest>(plane, '/v1/input-requests', {
    job_id: jobWithPending.id,
    kind: 'question',
    question: 'still pending?',
    auto_approvable: false,
  });
  const answered = await post<InputRequest>(plane, '/v1/input-requests', {
    job_id: jobWithAnswered.id,
    kind: 'question',
    question: 'already answered?',
    auto_approvable: false,
  });
  await patch(plane, `/v1/input-requests/${answered.id}/answer`, { answer: 'yes', answered_by: 'rafael' });

  const defaultResult = await runCli(['input-requests', '--json', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(defaultResult.code, 0, `stderr:\n${defaultResult.stderr}`);
  const parsedDefault = JSON.parse(defaultResult.stdout) as { input_requests: InputRequest[] };
  assert.deepEqual(parsedDefault.input_requests.map((question) => question.id), [pending.id]);

  const answeredResult = await runCli(
    ['input-requests', '--status', 'answered', '--json', '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(answeredResult.code, 0, `stderr:\n${answeredResult.stderr}`);
  const parsedAnswered = JSON.parse(answeredResult.stdout) as { input_requests: InputRequest[] };
  assert.deepEqual(parsedAnswered.input_requests.map((question) => question.id), [answered.id]);

  const humanDefault = await runCli(['input-requests', '--url', plane.url], { token: plane.token });
  assert.match(humanDefault.stdout, /still pending\?/);
  assert.doesNotMatch(humanDefault.stdout, /already answered\?/);
});

test('AT12/13 — --help lists the seven new subcommands; a wrong command line on each exits 2', { timeout: 60_000 }, async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0, `stderr:\n${help.stderr}`);
  for (const name of ['jobs', 'job', 'executions', 'execution', 'sessions', 'transcript', 'input-requests']) {
    assert.match(help.stdout, new RegExp(`\\n  ${name}\\b`), `"${name}" is missing from --help`);
  }

  const noId = await runCli(['job']);
  assert.equal(noId.code, 2);

  const bogusFlag = await runCli(['jobs', '--bogus-flag']);
  assert.equal(bogusFlag.code, 2);

  const badTranscriptId = await runCli(['transcript', 'abc']);
  assert.equal(badTranscriptId.code, 2);

  const badTail = await runCli(['transcript', '1', '--tail', '0']);
  assert.equal(badTail.code, 2);
});
