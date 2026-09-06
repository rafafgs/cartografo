/**
 * The merge that makes a history file well defined (t372, FR2/FR3).
 *
 * This is the ticket's one real design decision, and it is why the algorithm
 * lives in `domain/history.ts` and not inside the subcommand: which events pass
 * through, which are REPLACED by the projection they opened, and which are
 * DROPPED because that projection already carries their facts. Get that wrong
 * and the file either loses a fact or reports the same fact twice under two
 * different shapes — neither of which a reader can tell from the outside.
 *
 * Pure, with no server and no database, in the spirit of
 * `domain-context.test.ts`: every case here is one a live traversal would take
 * six sessions to reach, and half of them (a round crossing two map versions, a
 * session still open at export time) are cases nobody can produce on demand.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_FORMAT,
  buildHistoryHeader,
  mergeHistoryLines,
  pinnedGraphVersionId,
  type HistoryEvent,
  type HistoryInputRequest,
  type HistorySession,
} from '../src/domain/history.ts';

/** A version id, in the shape `graph_version.id` really has (D15: it is a hash). */
const VERSION_ID = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/** A second one, for the round that crossed two maps. */
const OTHER_VERSION_ID = 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

/**
 * One envelope of the log, with only the fields a case cares about spelled out.
 *
 * The rest of the envelope rides along verbatim, which is exactly what the
 * pass-through case below charges for.
 */
function event(id: number, type: string, extra: Record<string, unknown> = {}): HistoryEvent {
  return {
    id,
    type,
    project_id: 1,
    execution_id: 7,
    entity: { type: type.split('.')[0], id: 1 },
    actor: { type: 'system', ref: 'runner' },
    occurred_at: `2026-09-06T10:0${id}:00.000Z`,
    data: {},
    ...extra,
  };
}

/** A session projection, as `GET /v1/sessions` answers it. */
function session(id: number, overrides: Partial<HistorySession> = {}): HistorySession {
  return {
    id,
    job_id: 4,
    execution_id: 7,
    node_id: 'refine',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/srv/cartografo',
    prompt: 'refine the ticket',
    timeout_seconds: 5400,
    silence_seconds: null,
    status: 'completed',
    exit_code: 0,
    timeout_reason: null,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    models: ['claude-opus-5'],
    transcript: 'everything the agent printed, unredacted',
    transcript_truncated: false,
    transcript_original_size: 41,
    output: { branch: 'ticket-372' },
    opened_at: '2026-09-06T10:03:00.000Z',
    finished_at: '2026-09-06T10:04:00.000Z',
    ...overrides,
  };
}

/** An input-request projection, as `GET /v1/input-requests` answers it. */
function inputRequest(
  id: number,
  overrides: Partial<HistoryInputRequest> = {},
): HistoryInputRequest {
  return {
    id,
    job_id: 4,
    session_id: 11,
    execution_id: 7,
    node_id: 'refine',
    kind: 'question',
    question: 'Renumber the migration?',
    context: 'another ticket owns the same numbering space',
    options: ['Renumber', 'Keep'],
    recommendation: 'Keep',
    default_answer: 'Keep',
    auto_approvable: false,
    status: 'answered',
    answer: 'Keep',
    answered_by: 'rafael',
    source: 'user',
    created_at: '2026-09-06T10:05:00.000Z',
    answered_at: '2026-09-06T10:06:00.000Z',
    ...overrides,
  };
}

test('t372 FR3 — the six events of a job become four lines, in strictly increasing id order', () => {
  const lines = mergeHistoryLines({
    events: [
      event(1, 'job.created', { entity: { type: 'job', id: 4 } }),
      event(2, 'job.transitioned', { entity: { type: 'job', id: 4 } }),
      event(3, 'session.opened', { entity: { type: 'session', id: 11 } }),
      event(4, 'session.finished', { entity: { type: 'session', id: 11 } }),
      event(5, 'input_request.created', { entity: { type: 'input_request', id: 21 } }),
      event(6, 'input_request.answered', { entity: { type: 'input_request', id: 21 } }),
    ],
    sessions: [session(11)],
    input_requests: [inputRequest(21)],
  });

  assert.deepEqual(
    lines.map((line) => [line.id, line.kind]),
    [
      [1, 'event'],
      [2, 'event'],
      [3, 'session'],
      [5, 'input_request'],
    ],
    'the opening is replaced in place; the ending is folded into it and disappears',
  );

  for (let index = 1; index < lines.length; index += 1) {
    assert.ok(lines[index].id > lines[index - 1].id, 'ids are strictly increasing, with no tie');
  }

  const sessionLine = lines[2];
  assert.equal(sessionLine.session_id, 11, 'the session id survives, under a name of its own');
  assert.equal(sessionLine.status, 'completed');
  assert.equal(sessionLine.transcript_truncated, false);
  assert.equal(sessionLine.transcript_original_size, 41);
  assert.deepEqual(sessionLine.output, { branch: 'ticket-372' });
  assert.equal(
    'transcript' in sessionLine,
    false,
    'the raw transcript stays a per-session fetch, and never rides in the file',
  );

  const questionLine = lines[3];
  assert.equal(questionLine.input_request_id, 21);
  assert.equal(
    questionLine.kind,
    'input_request',
    "the line's kind is the line's, and the projection's own kind never wins it",
  );
  assert.equal(questionLine.input_request_kind, 'question', 'which is why it moves, not vanishes');
  assert.equal(questionLine.question, 'Renumber the migration?');
  assert.equal(questionLine.answer, 'Keep');
  assert.equal(questionLine.answered_by, 'rafael');
  assert.equal(questionLine.source, 'user');
});

test('t372 FR3 — input_request.auto_resolved is folded into the same line', () => {
  const lines = mergeHistoryLines({
    events: [
      event(5, 'input_request.created', { entity: { type: 'input_request', id: 21 } }),
      event(6, 'input_request.auto_resolved', { entity: { type: 'input_request', id: 21 } }),
    ],
    sessions: [],
    input_requests: [inputRequest(21, { source: 'auto', answered_by: 'system' })],
  });

  assert.deepEqual(
    lines.map((line) => [line.id, line.kind]),
    [[5, 'input_request']],
  );
  assert.equal(lines[0].source, 'auto');
});

test('t372 FR3 — a session with no ending yet reads open, with no finished_at', () => {
  const lines = mergeHistoryLines({
    events: [event(3, 'session.opened', { entity: { type: 'session', id: 11 } })],
    sessions: [session(11, { status: 'open', exit_code: null, usage: null, finished_at: null })],
    input_requests: [],
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'session');
  assert.equal(lines[0].status, 'open');
  assert.equal(lines[0].finished_at, null);
  assert.equal(lines[0].usage, null, 'nothing reported is null, and never zero');
});

test('t372 FR3 — every other type passes through as the envelope it already was', () => {
  const passing = [
    event(1, 'job.blocked', { entity: { type: 'job', id: 4 } }),
    event(2, 'lease.granted', { entity: { type: 'lease', id: 3 } }),
    event(3, 'graph_version.applied', { entity: { type: 'graph_version', id: VERSION_ID } }),
    event(4, 'session.permission_denied', { entity: { type: 'session', id: 11 } }),
  ];

  const lines = mergeHistoryLines({
    events: passing,
    // The session IS in the scope, and the denial is still not enriched: only
    // the opening is replaced, because only the opening is the fact the
    // projection restates.
    sessions: [session(11)],
    input_requests: [],
  });

  assert.deepEqual(
    lines,
    passing.map((envelope) => ({ kind: 'event', ...envelope })),
    'untranslated means untranslated: the envelope, with one key in front of it',
  );
});

test('t372 FR3 — an ending whose projection is out of scope is kept, never silently lost', () => {
  const ending = event(4, 'session.finished', { entity: { type: 'session', id: 11 } });

  const lines = mergeHistoryLines({ events: [ending], sessions: [], input_requests: [] });

  assert.deepEqual(
    lines,
    [{ kind: 'event', ...ending }],
    'dropping it would delete a fact instead of folding it',
  );
});

test('t372 FR3 — the order is the id, whatever order the reads came back in', () => {
  const lines = mergeHistoryLines({
    events: [event(9, 'job.blocked'), event(2, 'job.created'), event(5, 'job.unblocked')],
    sessions: [],
    input_requests: [],
  });

  assert.deepEqual(
    lines.map((line) => line.id),
    [2, 5, 9],
  );
});

test('t372 FR2 — a job with a version resolves the header map from both reads', () => {
  const header = buildHistoryHeader({
    exported_at: '2026-09-06T12:00:00.000Z',
    project: { id: 1, name: 'default' },
    subject: { kind: 'job', job: { id: 4, title: 'a job', graph_version_id: VERSION_ID } },
    graph: {
      version: {
        id: VERSION_ID,
        parent_version: OTHER_VERSION_ID,
        snapshot: { problem_class: 'software-development', metadata: { name: 'Software delivery' } },
      },
      lineage: { id: 'software-development', class: 'software-development' },
    },
  });

  assert.equal(header.kind, 'header');
  assert.equal(header.format, HISTORY_FORMAT);
  assert.equal(header.exported_at, '2026-09-06T12:00:00.000Z');
  assert.deepEqual(header.project, { id: 1, name: 'default' });
  assert.deepEqual(header.job, { id: 4, title: 'a job', graph_version_id: VERSION_ID });
  assert.equal(header.execution, undefined, 'a job-scoped header names no round');
  assert.deepEqual(header.graph_version, {
    id: VERSION_ID,
    class: 'software-development',
    problem_class: 'software-development',
    parent: OTHER_VERSION_ID,
    metadata: { name: 'Software delivery' },
  });
});

test('t372 FR2 — a job with no version, and a version that no longer resolves, read the same', () => {
  const orphan = buildHistoryHeader({
    exported_at: '2026-09-06T12:00:00.000Z',
    project: { id: 1, name: 'default' },
    subject: { kind: 'job', job: { id: 4, graph_version_id: null } },
    graph: null,
  });
  assert.equal(orphan.graph_version, null);
  assert.equal(pinnedGraphVersionId({ kind: 'job', job: { id: 4, graph_version_id: null } }), null);

  const vanished = buildHistoryHeader({
    exported_at: '2026-09-06T12:00:00.000Z',
    project: { id: 1, name: 'default' },
    subject: { kind: 'job', job: { id: 4, graph_version_id: VERSION_ID } },
    graph: null,
  });
  assert.equal(vanished.graph_version, null, 'no graph at all is the same reading either way');
});

test('t372 FR2 — a round pinned to one version resolves it; one that crossed two does not', () => {
  const oneMap = {
    kind: 'execution' as const,
    execution: { execution_id: 7, jobs: 2 },
    jobs: [
      { id: 4, graph_version_id: VERSION_ID },
      { id: 5, graph_version_id: VERSION_ID },
    ],
  };
  assert.equal(pinnedGraphVersionId(oneMap), VERSION_ID);

  const header = buildHistoryHeader({
    exported_at: '2026-09-06T12:00:00.000Z',
    project: { id: 1, name: 'default' },
    subject: oneMap,
    graph: {
      version: { id: VERSION_ID, parent_version: null, snapshot: { problem_class: 'bets' } },
      lineage: { id: 'asymmetric-bets', class: 'asymmetric-bets' },
    },
  });
  assert.deepEqual(header.execution, { execution_id: 7, jobs: 2 });
  assert.equal(header.job, undefined);
  assert.deepEqual(header.graph_version, {
    id: VERSION_ID,
    class: 'asymmetric-bets',
    problem_class: 'bets',
    parent: null,
    metadata: null,
  });

  const twoMaps = {
    kind: 'execution' as const,
    execution: { execution_id: 7 },
    jobs: [
      { id: 4, graph_version_id: VERSION_ID },
      { id: 5, graph_version_id: OTHER_VERSION_ID },
    ],
  };
  assert.equal(
    pinnedGraphVersionId(twoMaps),
    null,
    'a single map cannot honestly stand in for a round that crossed two',
  );

  const crossed = buildHistoryHeader({
    exported_at: '2026-09-06T12:00:00.000Z',
    project: { id: 1, name: 'default' },
    subject: twoMaps,
    graph: {
      version: { id: VERSION_ID, parent_version: null, snapshot: { problem_class: 'bets' } },
      lineage: { id: 'asymmetric-bets', class: 'asymmetric-bets' },
    },
  });
  assert.equal(crossed.graph_version, null, 'the pin decides, never what happened to be fetched');
});

test('t372 FR2 — a round with no job at all, and one where only some jobs are pinned', () => {
  assert.equal(
    pinnedGraphVersionId({ kind: 'execution', execution: { execution_id: 7 }, jobs: [] }),
    null,
  );
  assert.equal(
    pinnedGraphVersionId({
      kind: 'execution',
      execution: { execution_id: 7 },
      jobs: [{ id: 4, graph_version_id: VERSION_ID }, { id: 5, graph_version_id: null }],
    }),
    null,
    'a job with no map is a version the round does not share',
  );
});
