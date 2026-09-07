/**
 * Acceptance tests of `cartografo export-history` (t372, FR1–FR4).
 *
 * Against a REAL control plane, through the real binary, because what this
 * command promises is a file on somebody's disk: an id sequence that is really
 * ascending, a session line that really carries the usage the engine reported
 * and really does not carry the transcript, and a file that is still readable
 * when it was cut in half by a full disk or a Ctrl-C.
 *
 * The scripted-server twin (`cli-export-history-unit.test.ts`) covers what a
 * real server cannot be made to answer. Here everything is real, including the
 * map: the factory bundle is imported first, so the header's `graph_version`
 * comes out of a version that exists rather than out of a fixture.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  FACTORY_BUNDLE,
  firstHash,
  looksLikeStackTrace,
  runCli,
  startControlPlane,
  temporaryArea,
  type RunningControlPlane,
} from './cli-support.ts';

/** A job, in the part these tests read. */
interface Job {
  id: number;
  execution_id: number | null;
}

/** A session, in the part these tests read. */
interface Session {
  id: number;
}

/** An input request, in the part these tests read. */
interface InputRequest {
  id: number;
}

/**
 * The reader `docs/spec/history-export.md` publishes, written out here.
 *
 * Deliberately not imported from `src/`: it IS the contract this file charges
 * for — "for each complete line, JSON.parse" — and a reader that shared code
 * with the writer would agree with it even when both are wrong. The last
 * element of the split is dropped when it is not empty, which is precisely the
 * incomplete line a truncated file ends with.
 */
function readCompleteLines(text: string): Record<string, unknown>[] {
  const lines = text.split('\n');
  const complete = lines.slice(0, -1);
  return complete.map((line) => JSON.parse(line) as Record<string, unknown>);
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

/** Same, for the two PATCHes this round needs. */
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

test('t372 — a job with two sessions and an answered question exports as JSON Lines', { timeout: 300_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t372-');
  const plane = await startControlPlane(t, {
    databasePath: path.join(area, 'server', 'cartografo.db'),
  });

  const imported = await runCli(['import', FACTORY_BUNDLE, '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(imported.code, 0, `stdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`);
  const versionId = firstHash(imported.stdout);

  const job = await post<Job>(plane, '/v1/jobs', {
    title: 'a job with a history',
    entry_node_id: 'refine',
    execution_id: 41,
    graph_version_id: versionId,
  });

  // The first session ends; the second is still running when the export happens.
  const finished = await post<Session>(plane, '/v1/sessions', {
    job_id: job.id,
    node_id: 'refine',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine the ticket',
  });
  await patch(plane, `/v1/sessions/${finished.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    transcript: 'everything the agent printed, unredacted',
  });

  const question = await post<InputRequest>(plane, '/v1/input-requests', {
    job_id: job.id,
    kind: 'question',
    question: 'Renumber the migration?',
    options: ['Renumber', 'Keep'],
    default_answer: 'Keep',
    auto_approvable: false,
  });
  await patch(plane, `/v1/input-requests/${question.id}/answer`, {
    answer: 'Keep',
    answered_by: 'rafael',
  });

  const open = await post<Session>(plane, '/v1/sessions', {
    job_id: job.id,
    node_id: 'develop',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'build it',
  });

  const output = path.join(area, 'out', 'history.jsonl');
  const run = await runCli(
    ['export-history', '--job', String(job.id), '--url', plane.url, '--out', output],
    { token: plane.token },
  );
  assert.equal(run.code, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(looksLikeStackTrace(run.stderr), false, `a stack trace leaked:\n${run.stderr}`);

  const text = readFileSync(output, 'utf8');
  assert.ok(text.endsWith('\n'), 'every line is terminated, the last one included');
  const lines = readCompleteLines(text);

  const header = lines[0];
  assert.equal(header.kind, 'header');
  assert.equal(header.format, 'cartografo-history/1');
  assert.ok(!Number.isNaN(Date.parse(String(header.exported_at))));
  assert.deepEqual(header.project, { id: 1, name: 'default' });
  assert.equal((header.job as Job).id, job.id);
  assert.deepEqual(header.graph_version, {
    id: versionId,
    class: 'software-development',
    problem_class: 'software-development',
    parent: null,
    metadata: JSON.parse(readFileSync(path.join(FACTORY_BUNDLE, 'graph.json'), 'utf8')).metadata,
  });

  const body = lines.slice(1);
  for (let index = 1; index < body.length; index += 1) {
    assert.ok(
      (body[index].id as number) > (body[index - 1].id as number),
      `line ${index} does not advance the id: ${JSON.stringify(body.map((line) => line.id))}`,
    );
  }

  const sessionLines = body.filter((line) => line.kind === 'session');
  assert.deepEqual(
    sessionLines.map((line) => line.session_id),
    [finished.id, open.id],
    'both sessions of the job are in the file, in the order they opened',
  );
  assert.equal(sessionLines[0].status, 'completed');
  assert.deepEqual(sessionLines[0].usage, {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  assert.equal(sessionLines[0].transcript_truncated, false);
  assert.equal(sessionLines[0].transcript_original_size, 'everything the agent printed, unredacted'.length);
  assert.equal(sessionLines[1].status, 'open');
  assert.equal(sessionLines[1].finished_at, null);
  for (const line of sessionLines) {
    assert.equal('transcript' in line, false, 'the raw transcript is a per-session fetch');
  }

  const questionLines = body.filter((line) => line.kind === 'input_request');
  assert.equal(questionLines.length, 1);
  assert.equal(questionLines[0].input_request_id, question.id);
  assert.equal(questionLines[0].answer, 'Keep');
  assert.equal(questionLines[0].answered_by, 'rafael');

  assert.equal(
    body.some((line) => line.type === 'session.finished' || line.type === 'input_request.answered'),
    false,
    'an ending folded into its line never also rides as a raw event',
  );

  await t.test('a file cut in the middle stays readable to the last complete line', () => {
    const cut = path.join(area, 'out', 'cut.jsonl');
    // Half of the last line, exactly the way a full disk or a Ctrl-C leaves it.
    const truncated = text.slice(0, text.length - Math.floor(text.split('\n').at(-2)!.length / 2));
    writeFileSync(cut, truncated, 'utf8');

    const recovered = readCompleteLines(readFileSync(cut, 'utf8'));
    assert.equal(recovered.length, lines.length - 1, 'every complete line survives, and only those');
    assert.deepEqual(recovered, lines.slice(0, -1));
  });
});

test('t372 — --execution exports the whole round in one ascending sequence', { timeout: 300_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t372-round-');
  const plane = await startControlPlane(t, {
    databasePath: path.join(area, 'server', 'cartografo.db'),
  });

  const execution = 55;
  const sessions: number[] = [];
  const questions: number[] = [];

  for (const name of ['first', 'second', 'third']) {
    const job = await post<Job>(plane, '/v1/jobs', {
      title: `${name} job of the round`,
      entry_node_id: 'refine',
      execution_id: execution,
    });

    const session = await post<Session>(plane, '/v1/sessions', {
      job_id: job.id,
      node_id: 'refine',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: `work on ${name}`,
    });
    await patch(plane, `/v1/sessions/${session.id}/finish`, { status: 'completed', exit_code: 0 });
    sessions.push(session.id);

    const question = await post<InputRequest>(plane, '/v1/input-requests', {
      job_id: job.id,
      kind: 'question',
      question: `is ${name} done?`,
      auto_approvable: false,
    });
    await patch(plane, `/v1/input-requests/${question.id}/answer`, {
      answer: 'yes',
      answered_by: 'rafael',
    });
    questions.push(question.id);
  }

  const output = path.join(area, 'round.jsonl');
  const run = await runCli(
    ['export-history', '--execution', String(execution), '--url', plane.url, '--out', output],
    { token: plane.token },
  );
  assert.equal(run.code, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

  const lines = readCompleteLines(readFileSync(output, 'utf8'));
  const header = lines[0];
  assert.equal(header.kind, 'header');
  assert.equal((header.execution as { execution_id: number }).execution_id, execution);
  assert.equal(header.job, undefined);
  assert.equal(header.graph_version, null, 'no job of this round is pinned to a map');

  const body = lines.slice(1);
  for (let index = 1; index < body.length; index += 1) {
    assert.ok((body[index].id as number) > (body[index - 1].id as number), 'one ascending sequence');
  }

  assert.deepEqual(
    body.filter((line) => line.kind === 'session').map((line) => line.session_id),
    sessions,
    "all three jobs' sessions are in the file",
  );
  assert.deepEqual(
    body.filter((line) => line.kind === 'input_request').map((line) => line.input_request_id),
    questions,
  );
  assert.equal(
    body.some((line) => line.type === 'session.finished' || line.type === 'input_request.answered'),
    false,
    'the round stream carries both raw endings; neither of them reaches the file',
  );
});
