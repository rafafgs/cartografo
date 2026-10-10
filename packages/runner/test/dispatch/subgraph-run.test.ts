/**
 * Acceptance tests of the subgraph node's dispatch (t638, AT16–AT25).
 *
 * A job standing on a `subgraph` node opens no model session. The dispatch
 * reconciles against what the control plane already holds — the children of
 * this node, in position order — and does exactly one of three things: create
 * the missing children, do nothing while they run, or resume with one
 * `completed` session on the pseudo-engine `subgraph` carrying the assembled
 * output, then take the node's single edge.
 *
 * Driven through `createClaudeCodeDispatch` itself, against a fake control
 * plane that records every request: that is what lets these tests also say
 * what did NOT happen — no worktree acquired, no engine adapter called. The
 * real control plane is the e2e's (`subgraph-node.e2e.test.ts`).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { EngineAdapter } from '../../src/engine/types.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The red phase reads as "the module is missing", never as a resolution trace. */
function requireModule(): void {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src/dispatch/subgraph-run.ts')),
    'artifact does not exist yet: packages/runner/src/dispatch/subgraph-run.ts',
  );
}

const PARENT_VERSION = 'sha256:parent';
const CHILD_VERSION = 'sha256:child';
const PARENT_ID = 1;
const EXECUTION_ID = 50;

/** One request the fake control plane received. */
interface Received {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | undefined;
}

/** A job as the fake holds it — the projection, in the part the dispatch reads. */
interface FakeJob {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  completed: boolean;
  execution_id: number | null;
  graph_version_id: string | null;
  parent_job_id: number | null;
  parent_node_id: string | null;
  sibling_position: number | null;
  children: number[];
  cancelled_at: string | null;
  block_reason: string | null;
}

/** The call a parent node makes, overridable per test. */
interface Call {
  class: string;
  input_map: Record<string, unknown>;
  output_map: Record<string, unknown>;
  fan_out?: { over: string; ordered?: boolean };
}

interface FakeOptions {
  call?: Partial<Call>;
  /** Drop `fan_out` entirely. */
  single?: boolean;
  /** The subgraph node is final: no edge leaves it. */
  final?: boolean;
  items?: unknown;
  nodesVisited?: string[];
  classes?: Array<{ class: string; current_version_id: string | null }>;
  /** Children already present, as `[node, completed, input]`. */
  existing?: Array<[string, boolean, Record<string, unknown>]>;
  sessions?: Array<Record<string, unknown>>;
  finishAnswer?: Record<string, unknown>;
  /** Answer `POST /v1/jobs` with this status and body instead of creating. */
  refuseCreate?: { status: number; body: Record<string, unknown> };
  /** Answer `GET /v1/classes` with a 503. */
  classesUnavailable?: boolean;
}

/** The fake control plane: state, the recorded requests, and its `fetch`. */
function fakeControlPlane(options: FakeOptions = {}) {
  const received: Received[] = [];
  const jobs = new Map<number, FakeJob>();
  const contexts = new Map<number, Record<string, unknown>>();
  let nextId = 100;
  let nextSession = 500;

  const call: Call = {
    class: 'nota-curta',
    input_map: { title: 'Note {{item.title}}' },
    output_map: { texts: '{{child.texto}}' },
    ...(options.single ? {} : { fan_out: { over: 'plan.items', ordered: true } }),
    ...options.call,
  };

  const parentSnapshot = {
    nodes: [
      { id: 'plan', node_type: 'work' },
      {
        id: 'write-notes',
        role: 'caller',
        node_type: 'subgraph',
        subgraph: call,
        contract: { output_schema: {}, produces: 'notes' },
      },
      { id: 'publish', node_type: 'work' },
    ],
    edges: [
      { from: 'plan', to: 'write-notes', condition: 'always' },
      ...(options.final ? [] : [{ from: 'write-notes', to: 'publish', condition: 'always' }]),
    ],
    initial_node: 'plan',
    final_nodes: options.final ? ['write-notes'] : ['publish'],
  };
  const childSnapshot = {
    nodes: [{ id: 'redigir', node_type: 'work' }],
    edges: [],
    initial_node: 'redigir',
    final_nodes: ['redigir'],
  };

  const blank = (id: number, extra: Partial<FakeJob>): FakeJob => ({
    id,
    title: `job ${id}`,
    current_node_id: 'redigir',
    blocked: false,
    completed: false,
    execution_id: EXECUTION_ID,
    graph_version_id: CHILD_VERSION,
    parent_job_id: null,
    parent_node_id: null,
    sibling_position: null,
    children: [],
    cancelled_at: null,
    block_reason: null,
    ...extra,
  });

  const parent = blank(PARENT_ID, {
    title: 'Weekly digest',
    current_node_id: 'write-notes',
    graph_version_id: PARENT_VERSION,
  });
  jobs.set(PARENT_ID, parent);
  contexts.set(PARENT_ID, {
    job: { id: PARENT_ID, title: 'Weekly digest', body: null },
    plan: { items: options.items ?? [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
    traversal: { nodes_visited: options.nodesVisited ?? ['plan'], entered_at: 'x' },
  });

  let position = 0;
  for (const [node, completed, input] of options.existing ?? []) {
    position += 1;
    const id = nextId++;
    jobs.set(
      id,
      blank(id, {
        parent_job_id: PARENT_ID,
        parent_node_id: node,
        sibling_position: position,
        completed,
      }),
    );
    contexts.set(id, input);
    parent.children.push(id);
  }

  const answer = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const doFetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    received.push({ method, path: parsed.pathname, query: parsed.search, body });
    const route = `${method} ${parsed.pathname}`;

    let match: RegExpMatchArray | null;
    if ((match = /^GET \/v1\/jobs\/(\d+)$/.exec(route)) !== null) {
      const job = jobs.get(Number(match[1]));
      return job === undefined ? answer(404, { error: 'not_found' }) : answer(200, job);
    }
    if ((match = /^GET \/v1\/jobs\/(\d+)\/context$/.exec(route)) !== null) {
      return answer(200, { input: contexts.get(Number(match[1])) ?? {} });
    }
    if (route === 'GET /v1/input-requests') return answer(200, { input_requests: [] });
    if ((match = /^GET \/v1\/graph-versions\/(.+)$/.exec(route)) !== null) {
      const id = decodeURIComponent(match[1]);
      const snapshot = id === PARENT_VERSION ? parentSnapshot : id === CHILD_VERSION ? childSnapshot : null;
      return snapshot === null
        ? answer(404, { error: 'not_found' })
        : answer(200, { graph_version: { id, snapshot } });
    }
    if (route === 'GET /v1/classes') {
      if (options.classesUnavailable) return answer(503, { error: 'unavailable' });
      return answer(200, {
        classes: options.classes ?? [{ class: 'nota-curta', current_version_id: CHILD_VERSION }],
      });
    }
    if (route === 'GET /v1/sessions') return answer(200, { sessions: options.sessions ?? [] });
    if (route === 'POST /v1/jobs') {
      if (options.refuseCreate !== undefined) {
        return answer(options.refuseCreate.status, options.refuseCreate.body);
      }
      const id = nextId++;
      parent.children.push(id);
      const created = blank(id, {
        title: String(body?.title),
        parent_job_id: PARENT_ID,
        parent_node_id: String(body?.parent_node_id),
        sibling_position: parent.children.length,
      });
      jobs.set(id, created);
      return answer(201, created);
    }
    if (route === 'POST /v1/sessions') return answer(201, { id: nextSession++ });
    if (/^PATCH \/v1\/sessions\/\d+\/finish$/.test(route)) {
      return answer(200, options.finishAnswer ?? { output_accepted: true });
    }
    if (/^POST \/v1\/jobs\/\d+\/(transitions|blocks)$/.test(route)) return answer(200, parent);
    return answer(500, { error: `the fake has no route for ${route}` });
  }) as typeof fetch;

  return { received, jobs, doFetch };
}

/** What the dispatch must never touch on this path, armed to say so. */
function untouchables(): {
  worktrees: WorktreeManager;
  adapter: EngineAdapter;
  touched: string[];
} {
  const touched: string[] = [];
  const worktrees: WorktreeManager = {
    acquire: (jobId) => {
      touched.push(`worktree ${jobId}`);
      return Promise.reject(new Error('a subgraph node acquired a worktree'));
    },
    release: () => Promise.resolve({ kept: true }),
  };
  const adapter = {
    engineName: 'claude-code',
    startSession: () => {
      touched.push('adapter');
      return Promise.reject(new Error('a subgraph node started an engine session'));
    },
    cancel: () => Promise.resolve(),
  } as unknown as EngineAdapter;
  return { worktrees, adapter, touched };
}

/** A dispatch wired to the fake, with a pre-session ceiling of two. */
function dispatchOver(options: FakeOptions = {}) {
  const plane = fakeControlPlane(options);
  const guard = untouchables();
  const dispatch = createClaudeCodeDispatch({
    urlBase: 'http://control-plane.test',
    token: 'test-token',
    projectId: 1,
    engines: { 'claude-code': { adapter: guard.adapter, decodeSessionText: (lines) => lines.join('\n') } },
    worktrees: guard.worktrees,
    doFetch: plane.doFetch,
    maxConsecutivePreSessionFailures: 2,
  });
  return { ...plane, ...guard, dispatch };
}

function writes(received: readonly Received[]): Received[] {
  return received.filter((entry) => entry.method !== 'GET');
}

function only(received: readonly Received[], method: string, pattern: RegExp): Received[] {
  return received.filter((entry) => entry.method === method && pattern.test(entry.path));
}

/** The one block posted, asserting there was exactly one. */
function blockReason(received: readonly Received[]): string {
  const blocks = only(received, 'POST', /^\/v1\/jobs\/1\/blocks$/);
  assert.equal(blocks.length, 1, `exactly one block: ${JSON.stringify(writes(received))}`);
  return String(blocks[0].body?.reason);
}

test('t638 AT16 — an ordered fan-out of 3 opens three chained children and nothing else', async () => {
  requireModule();
  const { dispatch, received, touched } = dispatchOver();

  const outcome = await dispatch(PARENT_ID);
  assert.deepEqual(outcome, { blocked: false });

  const created = only(received, 'POST', /^\/v1\/jobs$/);
  assert.equal(created.length, 3);
  assert.deepEqual(
    created.map((entry) => entry.body?.title),
    ['Note a', 'Note b', 'Note c'],
  );
  for (const entry of created) {
    assert.equal(entry.body?.parent_job_id, PARENT_ID);
    assert.equal(entry.body?.parent_node_id, 'write-notes');
    assert.equal(entry.body?.graph_version_id, CHILD_VERSION);
    assert.equal(entry.body?.entry_node_id, 'redigir');
    assert.equal(entry.body?.execution_id, EXECUTION_ID);
    assert.equal(entry.body?.project_id, 1);
    assert.deepEqual(entry.body?.actor, { type: 'system', ref: 'runner' });
  }
  assert.equal(created[0].body?.depends_on, undefined, 'the first child waits for nobody');
  assert.deepEqual(created[1].body?.depends_on, [100]);
  assert.deepEqual(created[2].body?.depends_on, [101]);

  assert.equal(only(received, 'POST', /^\/v1\/sessions$/).length, 0, 'no session is opened');
  assert.equal(only(received, 'POST', /transitions$/).length, 0, 'no transition is made');
  assert.equal(only(received, 'POST', /blocks$/).length, 0);
  assert.deepEqual(touched, []);
});

test('t638 AT17 — an unordered fan-out opens three children with no dependency', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({
    call: { fan_out: { over: 'plan.items' } },
  });

  assert.deepEqual(await dispatch(PARENT_ID), { blocked: false });
  const created = only(received, 'POST', /^\/v1\/jobs$/);
  assert.equal(created.length, 3);
  for (const entry of created) assert.equal(entry.body?.depends_on, undefined);
});

test('t638 AT18 — the dispatch reconciles: only the missing children are opened', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({
    existing: [
      ['some-other-node', false, {}],
      ['write-notes', false, {}],
    ],
  });

  assert.deepEqual(await dispatch(PARENT_ID), { blocked: false });
  const created = only(received, 'POST', /^\/v1\/jobs$/);
  assert.deepEqual(
    created.map((entry) => entry.body?.title),
    ['Note b', 'Note c'],
    'the existing child of this node is item 1; a child of another node does not count',
  );
  assert.deepEqual(created[0].body?.depends_on, [101], 'the chain continues from the existing child');
  assert.deepEqual(created[1].body?.depends_on, [102]);

  // All three present, none completed: there is nothing to do.
  const waiting = dispatchOver({
    existing: [
      ['write-notes', true, { texto: 'A' }],
      ['write-notes', false, {}],
      ['write-notes', false, {}],
    ],
  });
  assert.deepEqual(await waiting.dispatch(PARENT_ID), { blocked: false });
  assert.deepEqual(writes(waiting.received), [], 'a dispatch with children still running writes nothing');
});

test('t638 AT19 — an empty list opens nothing and resumes at once with empty arrays', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({ items: [] });

  assert.deepEqual(await dispatch(PARENT_ID), { blocked: false });
  assert.equal(only(received, 'POST', /^\/v1\/jobs$/).length, 0);
  const finish = only(received, 'PATCH', /\/finish$/);
  assert.equal(finish.length, 1);
  assert.deepEqual(finish[0].body?.output, { texts: [] });
  assert.equal(only(received, 'POST', /transitions$/).length, 1);
});

test('t638 AT20 — all children completed: one subgraph session, its finish, then the edge', async () => {
  requireModule();
  const { dispatch, received, touched } = dispatchOver({
    existing: [
      ['write-notes', true, { texto: 'A' }],
      ['write-notes', true, { texto: 'B' }],
      ['write-notes', true, { texto: 'C' }],
    ],
  });

  assert.deepEqual(await dispatch(PARENT_ID), { blocked: false });

  const sequence = writes(received).map((entry) => `${entry.method} ${entry.path}`);
  assert.deepEqual(sequence, [
    'POST /v1/sessions',
    'PATCH /v1/sessions/500/finish',
    'POST /v1/jobs/1/transitions',
  ]);

  const [opened, finished, moved] = writes(received);
  assert.equal(opened.body?.engine, 'subgraph');
  assert.equal(opened.body?.job_id, PARENT_ID);
  assert.equal(opened.body?.node_id, 'write-notes');
  assert.equal(opened.body?.working_dir, '(none)');
  const prompt = String(opened.body?.prompt);
  for (const part of ['write-notes', 'nota-curta', '100', '101', '102']) {
    assert.ok(prompt.includes(part), `the prompt names ${part}: ${prompt}`);
  }
  assert.ok(!prompt.includes('\n'), 'the prompt is one line');

  assert.equal(finished.body?.status, 'completed');
  assert.deepEqual(finished.body?.output, { texts: ['A', 'B', 'C'] });
  assert.equal(finished.body?.usage, undefined, 'no token was spent and none is claimed');
  const transcript = String(finished.body?.transcript);
  for (const line of ['1/3 job 100', '2/3 job 101', '3/3 job 102']) {
    assert.ok(transcript.includes(line), `the transcript lists ${line}: ${transcript}`);
  }

  assert.equal(moved.body?.to_node_id, 'publish');
  assert.deepEqual(touched, [], 'no worktree was acquired and no adapter was called');
});

test('t638 AT21 — a final subgraph node finishes its session and makes no transition', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({
    final: true,
    existing: [
      ['write-notes', true, { texto: 'A' }],
      ['write-notes', true, { texto: 'B' }],
      ['write-notes', true, { texto: 'C' }],
    ],
  });

  assert.deepEqual(await dispatch(PARENT_ID), { blocked: false });
  assert.equal(only(received, 'PATCH', /\/finish$/).length, 1);
  assert.equal(only(received, 'POST', /transitions$/).length, 0);
});

test('t638 AT22 — a report the control plane refuses blocks the parent and does not move it', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({
    existing: [
      ['write-notes', true, { texto: 'A' }],
      ['write-notes', true, { texto: 'B' }],
      ['write-notes', true, { texto: 'C' }],
    ],
    finishAnswer: { output_accepted: false, output_schema_error: ['/texts must be string'] },
  });

  const outcome = await dispatch(PARENT_ID);
  assert.equal(outcome.blocked, true);
  assert.ok(blockReason(received).includes('/texts must be string'));
  assert.equal(only(received, 'POST', /transitions$/).length, 0);
});

test('t638 AT23 — a resume already recorded opens no second session and only transitions', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({
    existing: [
      ['write-notes', true, { texto: 'A' }],
      ['write-notes', true, { texto: 'B' }],
      ['write-notes', true, { texto: 'C' }],
    ],
    sessions: [
      {
        id: 9,
        job_id: PARENT_ID,
        node_id: 'write-notes',
        engine: 'subgraph',
        status: 'completed',
        output: { texts: ['A', 'B', 'C'] },
      },
    ],
  });

  assert.deepEqual(await dispatch(PARENT_ID), { blocked: false });
  assert.deepEqual(
    writes(received).map((entry) => `${entry.method} ${entry.path}`),
    ['POST /v1/jobs/1/transitions'],
  );
});

test('t638 AT24 — a subgraph node reached a second time is blocked and opens nothing', async () => {
  requireModule();
  const { dispatch, received } = dispatchOver({ nodesVisited: ['plan', 'write-notes', 'plan'] });

  const outcome = await dispatch(PARENT_ID);
  assert.equal(outcome.blocked, true);
  const reason = blockReason(received);
  assert.ok(reason.includes('write-notes'), reason);
  assert.ok(/not supported/i.test(reason), reason);
  assert.equal(only(received, 'POST', /^\/v1\/jobs$/).length, 0);
});

test('t638 AT25 — every runtime refusal blocks with a readable reason; a 503 is bounded', async () => {
  requireModule();

  const cases: Array<[string, FakeOptions, string]> = [
    ['an unregistered class', { classes: [] }, 'nota-curta'],
    [
      'a class with no current version',
      { classes: [{ class: 'nota-curta', current_version_id: null }] },
      'nota-curta',
    ],
    [
      'a 409 on child creation',
      {
        refuseCreate: {
          status: 409,
          body: { error: 'graph_version_not_ready', message: 'the version is not checked yet' },
        },
      },
      'the version is not checked yet',
    ],
    [
      'an unresolved placeholder',
      { call: { input_map: { title: '{{input.job.nope}}' } } },
      'input.job.nope',
    ],
    [
      'more children than expected',
      {
        existing: [
          ['write-notes', false, {}],
          ['write-notes', false, {}],
          ['write-notes', false, {}],
          ['write-notes', false, {}],
        ],
      },
      '4',
    ],
    ['a fan_out.over that is not a list', { items: 'a string' }, 'plan.items'],
  ];

  for (const [name, options, quoted] of cases) {
    const { dispatch, received } = dispatchOver(options);
    const outcome = await dispatch(PARENT_ID);
    assert.equal(outcome.blocked, true, `${name}: blocked`);
    const reason = blockReason(received);
    assert.ok(reason.includes(quoted), `${name}: the reason quotes ${quoted}: ${reason}`);
    assert.ok(reason.includes('write-notes'), `${name}: the reason names the node: ${reason}`);
    if (outcome.blocked) assert.equal(outcome.reason, reason, `${name}: one story for both`);
  }

  // A 503 heals itself: it throws, and only at the ceiling is the work stopped.
  const { dispatch, received } = dispatchOver({ classesUnavailable: true });
  await assert.rejects(dispatch(PARENT_ID), /503/);
  assert.equal(only(received, 'POST', /blocks$/).length, 0, 'the first 503 is retried, not blocked');
  const second = await dispatch(PARENT_ID);
  assert.equal(second.blocked, true);
  assert.ok(blockReason(received).includes('2 times'), 'the block carries the count');
});
