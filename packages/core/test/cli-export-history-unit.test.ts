/**
 * The failure branches of `cartografo export-history`, in process (t372, FR1).
 *
 * `cli-export-history.test.ts` walks the real thing against a real control
 * plane, which is what proves the file a person actually gets. What it cannot
 * walk is the command line nobody should be able to type — no scope, two scopes,
 * a job id that is a word — nor a control plane that answers something other
 * than a healthy `200`, because producing those against a real server means
 * breaking it on purpose.
 *
 * Same rule `cli-export-unit.test.ts` keeps for `export`, and it matters more
 * here: this command exists so a history can leave the machine, and a file that
 * exists but is half written is worse than no file at all. So a refused export
 * writes NOTHING, and a wrong command line costs the server not one request.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runExportHistory } from '../src/cli/export-history.ts';
import { UsageError } from '../src/cli/url.ts';
import { temporaryArea } from './cli-support.ts';
import { capture, startFakeControlPlane, type FakeAnswer } from './cli-unit-support.ts';

const VERSION_ID = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** The job the healthy fixture serves, exactly as `GET /v1/jobs/:id` answers it. */
const JOB = {
  id: 4,
  project_id: 1,
  execution_id: 7,
  title: 'a job with a history',
  entry_node_id: 'refine',
  current_node_id: 'develop',
  blocked: false,
  block_reason: null,
  graph_version_id: VERSION_ID,
  created_at: '2026-09-06T10:00:00.000Z',
  updated_at: '2026-09-06T10:06:00.000Z',
};

/** One envelope, in the part these fixtures care about. */
function event(id: number, type: string, entityId: number | string): Record<string, unknown> {
  return {
    id,
    type,
    project_id: 1,
    execution_id: 7,
    entity: { type: type.split('.')[0], id: entityId },
    actor: { type: 'system', ref: 'runner' },
    occurred_at: `2026-09-06T10:0${id}:00.000Z`,
    data: {},
  };
}

const EVENTS = [
  event(1, 'job.created', 4),
  event(2, 'job.transitioned', 4),
  event(3, 'session.opened', 11),
  event(5, 'input_request.created', 21),
];

const SESSIONS = [
  {
    id: 11,
    job_id: 4,
    execution_id: 7,
    node_id: 'refine',
    engine: 'claude-code',
    status: 'completed',
    usage: null,
    models: null,
    transcript: 'unredacted output nobody wants in an export',
    transcript_truncated: false,
    transcript_original_size: 12,
    output: null,
    opened_at: '2026-09-06T10:03:00.000Z',
    finished_at: '2026-09-06T10:04:00.000Z',
  },
];

const INPUT_REQUESTS = [
  {
    id: 21,
    job_id: 4,
    session_id: 11,
    execution_id: 7,
    node_id: 'refine',
    kind: 'question',
    question: 'Renumber the migration?',
    options: null,
    recommendation: null,
    default_answer: null,
    auto_approvable: false,
    status: 'answered',
    answer: 'Keep',
    answered_by: 'rafael',
    source: 'user',
    created_at: '2026-09-06T10:05:00.000Z',
    answered_at: '2026-09-06T10:06:00.000Z',
  },
];

/** Every read a healthy job export makes, and the answer to each one. */
function healthy(overrides: Record<string, FakeAnswer> = {}) {
  return (request: { route: string }): FakeAnswer => {
    const override = overrides[request.route];
    if (override !== undefined) return override;

    switch (request.route) {
      case '/v1/projects':
        return { status: 200, body: { projects: [{ id: 1, name: 'default' }] } };
      case '/v1/jobs/4':
        return { status: 200, body: JOB };
      case '/v1/jobs/4/events':
        return { status: 200, body: { events: EVENTS } };
      case '/v1/sessions':
        return { status: 200, body: { sessions: SESSIONS } };
      case '/v1/input-requests':
        return { status: 200, body: { input_requests: INPUT_REQUESTS } };
      case `/v1/graph-versions/${VERSION_ID}`:
        return {
          status: 200,
          body: {
            graph_version: {
              id: VERSION_ID,
              graph_id: 'software-development',
              parent_version: null,
              snapshot: { problem_class: 'software-development', metadata: { name: 'Delivery' } },
            },
          },
        };
      case '/v1/graphs/software-development':
        return { status: 200, body: { graph: { id: 'software-development', class: 'software-development' } } };
      case '/v1/executions/7':
        return { status: 200, body: { execution_id: 7, jobs: 1, blocked_jobs: 0, pending_input_requests: 0, finished_at: null } };
      case '/v1/jobs':
        return { status: 200, body: { jobs: [JOB] } };
      case '/v1/executions/7/events':
        return { status: 200, body: { execution_id: 7, events: EVENTS } };
      default:
        return { status: 404, body: { error: 'not_in_this_fixture', route: request.route } };
    }
  };
}

/** The lines of a produced file, already parsed. */
function readLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('t372 FR1 — no scope at all never becomes a request', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());

  await assert.rejects(capture(() => runExportHistory({ url: plane.url })), UsageError);
  assert.deepEqual(plane.requests, [], 'a wrong command line costs the server nothing');
});

test('t372 FR1 — both scopes together never become a request either', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());

  await assert.rejects(
    capture(() => runExportHistory({ job: '4', execution: '7', url: plane.url })),
    UsageError,
  );
  assert.deepEqual(plane.requests, []);
});

test('t372 FR1 — an id that is not an integer is a wrong command line', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());

  for (const scope of [{ job: 'quatro' }, { job: '4.5' }, { execution: '' }, { execution: 'sete' }]) {
    await assert.rejects(
      capture(() => runExportHistory({ ...scope, url: plane.url })),
      UsageError,
      `refused: ${JSON.stringify(scope)}`,
    );
  }
  assert.deepEqual(plane.requests, []);
});

test('t372 FR1 — a job the control plane does not know is unknown_job, and writes no file', async (t) => {
  const plane = await startFakeControlPlane(t, healthy({ '/v1/jobs/4': { status: 404, body: { error: 'unknown_job' } } }));
  const area = temporaryArea(t, 'cartografo-t372-');
  const output = path.join(area, 'history.jsonl');

  const run = await capture(() => runExportHistory({ job: '4', url: plane.url, output }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown_job/);
  assert.equal(existsSync(output), false, 'a failed export writes no file');
});

test('t372 FR1 — a project nobody declared is unknown_project, and writes no file', async (t) => {
  const plane = await startFakeControlPlane(
    t,
    healthy({ '/v1/jobs/4': { status: 404, body: { error: 'unknown_project', project_id: 99 } } }),
  );
  const area = temporaryArea(t, 'cartografo-t372-');
  const output = path.join(area, 'history.jsonl');

  const run = await capture(() =>
    runExportHistory({ job: '4', url: plane.url, output, projectId: 99 }),
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown_project/);
  assert.equal(existsSync(output), false);
});

test('t372 FR1 — any other status is reported with its number, and nothing is written', async (t) => {
  const plane = await startFakeControlPlane(t, healthy({ '/v1/jobs/4/events': { status: 503 } }));
  const area = temporaryArea(t, 'cartografo-t372-');
  const output = path.join(area, 'history.jsonl');

  const run = await capture(() => runExportHistory({ job: '4', url: plane.url, output }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /HTTP 503/);
  assert.equal(existsSync(output), false);
});

test('t372 FR1 — with no --out the file is named after the job, where the command was run', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());
  const area = temporaryArea(t, 'cartografo-t372-');

  const previous = process.cwd();
  process.chdir(area);
  t.after(() => process.chdir(previous));

  const run = await capture(() => runExportHistory({ job: '4', url: plane.url }));

  assert.equal(run.code, 0, run.stderr);
  const produced = path.join(area, 'job-4.history.jsonl');
  assert.equal(existsSync(produced), true);

  const lines = readLines(produced);
  assert.equal(lines[0].kind, 'header');
  assert.equal(lines[0].format, 'cartografo-history/1');
  assert.deepEqual(lines[0].project, { id: 1, name: 'default' });
  assert.deepEqual(lines[0].job, JOB);
  assert.deepEqual(
    lines.slice(1).map((line) => [line.id, line.kind]),
    [
      [1, 'event'],
      [2, 'event'],
      [3, 'session'],
      [5, 'input_request'],
    ],
  );
  assert.equal('transcript' in lines[3], false, 'the raw transcript never rides in the file');
  assert.match(run.stdout, /history exported/);
});

test('t372 FR1 — with no --out an execution names its own file, and reads the round routes', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());
  const area = temporaryArea(t, 'cartografo-t372-');

  const previous = process.cwd();
  process.chdir(area);
  t.after(() => process.chdir(previous));

  const run = await capture(() => runExportHistory({ execution: '7', url: plane.url }));

  assert.equal(run.code, 0, run.stderr);
  const produced = path.join(area, 'execution-7.history.jsonl');
  assert.equal(existsSync(produced), true);

  const lines = readLines(produced);
  assert.equal(lines[0].kind, 'header');
  assert.equal(lines[0].job, undefined);
  assert.deepEqual(lines[0].execution, {
    execution_id: 7,
    jobs: 1,
    blocked_jobs: 0,
    pending_input_requests: 0,
    finished_at: null,
  });

  const routes = plane.requests.map((request) => request.route);
  assert.ok(routes.includes('/v1/executions/7'), `round summary read: ${routes.join(', ')}`);
  assert.ok(routes.includes('/v1/executions/7/events'));
  assert.ok(routes.includes('/v1/jobs'), 'the jobs of the round decide the header map');
  assert.deepEqual(
    plane.requests
      .filter((request) => request.route === '/v1/sessions' || request.route === '/v1/input-requests')
      .map((request) => request.path.includes('execution_id=7')),
    [true, true],
    'the two side reads are scoped to the round, never to a job',
  );
});

test('t372 FR1 — the parent directory of --out is created, like export already does', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());
  const area = temporaryArea(t, 'cartografo-t372-');
  const output = path.join(area, 'folder', 'new', 'history.jsonl');

  const run = await capture(() => runExportHistory({ job: '4', url: plane.url, output }));

  assert.equal(run.code, 0, run.stderr);
  assert.equal(existsSync(output), true);
});

test('t372 FR2 — a job whose version no longer resolves still exports, with no map', async (t) => {
  const plane = await startFakeControlPlane(
    t,
    healthy({ [`/v1/graph-versions/${VERSION_ID}`]: { status: 404, body: { error: 'unknown_graph_version' } } }),
  );
  const area = temporaryArea(t, 'cartografo-t372-');
  const output = path.join(area, 'history.jsonl');

  const run = await capture(() => runExportHistory({ job: '4', url: plane.url, output }));

  assert.equal(run.code, 0, run.stderr);
  assert.equal(readLines(output)[0].graph_version, null, 'no graph at all, not a failed export');
});
