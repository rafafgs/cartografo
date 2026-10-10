/**
 * End-to-end acceptance tests of the subgraph node (t638, AT31–AT33).
 *
 * A real control plane, a real `Controller` with the children watcher wired, a
 * real dispatch, and the fake engine for every node that does run a session —
 * the pattern of `graph-traversal.e2e.test.ts`. The parent graph is the shipped
 * fan-out example (`schema/examples/graph-valid-subgraph-fan-out.json`): a plan
 * step lists three items, and the subgraph node opens one `nota-curta` child per
 * item, in order, and collects their texts.
 *
 * The test never moves a job itself: no `POST /v1/jobs/:id/transitions` is made
 * by this file, and that is part of what AT31 asserts.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { ControlPlaneClient } from '../../src/controller/control-plane-client.ts';
import { Controller } from '../../src/controller/controller.ts';
import type * as WatchModule from '../../src/controller/watch-children.ts';
import { createClaudeCodeDispatch, type DispatchOutcome } from '../../src/dispatch/dispatch.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLES = path.resolve(PACKAGE_ROOT, '..', '..', 'schema', 'examples');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const ITEMS = ['alpha', 'beta', 'gamma'];

interface Work {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  completed: boolean;
  children: number[];
  cancelled_at: string | null;
}

interface SessionRecord {
  id: number;
  job_id: number | null;
  node_id: string | null;
  engine: string;
  status: string;
  output: Record<string, unknown> | null;
}

type Doc = Record<string, unknown> & {
  problem_class: string;
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown>>;
  final_nodes: string[];
};

async function loadWatch(): Promise<typeof WatchModule> {
  const relative = 'src/controller/watch-children.ts';
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as typeof WatchModule;
}

function example(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8')) as Doc;
}

/** The lines a fake session prints: prose, then the report block. */
function reporting(result: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'I did what the node asked for.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify(result) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** ...and the lines of a session that stops to ask a person. */
const ASKS = JSON.stringify([
  { stream: 'stdout', text: 'One thing is not decided, so I am asking:' },
  { stream: 'stdout', text: '```input-request' },
  {
    stream: 'stdout',
    text: JSON.stringify({
      question: 'Which tone should this note take?',
      context: 'The item names no audience.',
      options: ['Formal', 'Casual'],
      recommendation: 'Formal.',
      default: 'Formal',
    }),
  },
  { stream: 'stdout', text: '```' },
]);

/** Directories as worktrees, one per session, so nothing touches a real repository. */
function directoryWorktrees(root: string): WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      serial += 1;
      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/** Everything one crossing needs: the API, the controller, and what the test itself called. */
async function crossing(
  t: test.TestContext,
  parentDocument: Doc,
  asksOn: string | null = null,
) {
  const { createChildrenWatcher } = await loadWatch();
  const { url: baseUrl, token } = await bootCore(t);
  const testCalls: string[] = [];

  const api = async <T>(method: string, route: string, body?: unknown, expected = 200): Promise<T> => {
    testCalls.push(`${method} ${route}`);
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
    return (text === '' ? undefined : JSON.parse(text)) as T;
  };

  const register = async (document: Doc): Promise<string> => {
    await resolvePins(baseUrl, token, document);
    const body = await api<{ graph_version: { id: string } }>('POST', '/v1/graphs', document, 201);
    return body.graph_version.id;
  };
  await register(example('graph-valid-minimal.json'));
  const parentVersion = await register(parentDocument);

  const parent = await api<Work>(
    'POST',
    '/v1/jobs',
    {
      title: 'three notes, in order',
      entry_node_id: 'plan',
      execution_id: 638,
      graph_version_id: parentVersion,
    },
    201,
  );

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t638-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const worktrees = directoryWorktrees(root);

  /** What a fake session prints, chosen by the job and the node it stands on. */
  const linesFor = (work: Work): string => {
    if (work.current_node_id === 'plan') {
      return reporting({ items: ITEMS.map((title) => ({ title })) });
    }
    if (work.current_node_id === 'redigir') {
      return work.title === asksOn ? ASKS : reporting({ texto: `text of ${work.title}` });
    }
    if (work.current_node_id === 'revisar') {
      return reporting({ outcome: 'passou', evidencia: 'the note reads well' });
    }
    return reporting({ published: true });
  };

  const read = async (id: number): Promise<Work> => api<Work>('GET', `/v1/jobs/${id}`);

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t638', 'the one that calls subgraphs');

  const controller = new Controller({
    client,
    runnerId: 'runner-t638',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    watchChildren: createChildrenWatcher(client, 1),
    dispatch: async (jobId): Promise<DispatchOutcome> => {
      const work = await read(jobId);
      return createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        projectId: 1,
        engines: {
          'claude-code': {
            adapter: new ClaudeCodeAdapter({
              commandBuilder: (spec) => ({
                command: process.execPath,
                args: [FAKE_ENGINE, ...buildCommand(spec).args],
              }),
              graceMs: 300,
            }),
            decodeSessionText: decodeClaudeCodeSessionText,
          },
        },
        worktrees,
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesFor(work) },
      })(jobId);
    },
  });

  const sessions = async (): Promise<SessionRecord[]> =>
    (await api<{ sessions: SessionRecord[] }>('GET', '/v1/sessions')).sessions;

  /** Ticks until `done` holds, failing after a generous bound. */
  const tickUntil = async (done: () => Promise<boolean>, label: string): Promise<void> => {
    for (let tick = 0; tick < 30; tick += 1) {
      if (await done()) return;
      await controller.tick();
    }
    assert.ok(await done(), `${label}: not reached within 30 ticks`);
  };

  return { api, read, sessions, tickUntil, controller, parent, testCalls };
}

/** The parent graph with the subgraph node NOT final: a publish step follows it. */
function withPublishStep(): Doc {
  const document = example('graph-valid-subgraph-fan-out.json');
  document.problem_class = 'batch-note-pipeline-published';
  const publish = structuredClone(document.nodes[0]);
  publish.id = 'publish';
  publish.description = 'Publishes the collected notes.';
  publish.contract = {
    input_schema: { type: 'object', required: ['job'], properties: { job: { type: 'object' } } },
    output_schema: { type: 'object' },
    produces: 'published',
    checks: [
      { type: 'deterministic', command: 'true', description: 'Nothing to check in a fixture.' },
    ],
  };
  document.nodes.push(publish);
  document.edges.push({
    from: 'write-notes',
    to: 'publish',
    condition: 'sempre',
    description: 'The collected notes always go on to be published.',
  });
  document.final_nodes = ['publish'];
  return document;
}

test('t638 AT31 — a final subgraph node runs its children in order and resumes exactly once', async (t) => {
  const { read, sessions, tickUntil, parent, testCalls } = await crossing(
    t,
    example('graph-valid-subgraph-fan-out.json'),
  );

  await tickUntil(async () => (await read(parent.id)).completed, 'the parent completes');

  const done = await read(parent.id);
  assert.equal(done.current_node_id, 'write-notes');
  assert.equal(done.children.length, 3);

  const all = await sessions();
  const firstSessionOf = done.children.map((child) => {
    const own = all.filter((session) => session.job_id === child);
    assert.ok(own.length > 0, `child ${child} ran`);
    return Math.min(...own.map((session) => session.id));
  });
  assert.deepEqual(
    firstSessionOf,
    [...firstSessionOf].sort((a, b) => a - b),
    'each child opened its first session after the previous child',
  );
  for (const [index, child] of done.children.entries()) {
    assert.equal((await read(child)).title, ITEMS[index]);
    assert.equal((await read(child)).completed, true);
  }

  const onCall = all.filter(
    (session) => session.job_id === parent.id && session.node_id === 'write-notes',
  );
  assert.equal(onCall.length, 1, 'the parent resumed exactly once');
  assert.equal(onCall[0].engine, 'subgraph');
  assert.equal(onCall[0].status, 'completed');
  assert.deepEqual(onCall[0].output, { texts: ITEMS.map((item) => `text of ${item}`) });
  assert.equal(
    all.filter((session) => session.job_id === parent.id && session.status === 'failed').length,
    0,
    'the wait produced no failed session',
  );

  assert.equal(
    testCalls.filter((entry) => entry.includes('/transitions')).length,
    0,
    'nothing in this test moved a job',
  );
});

test('t638 AT32 — the node that follows reads the assembled output in the produced bucket', async (t) => {
  const { api, read, tickUntil, parent } = await crossing(t, withPublishStep());

  await tickUntil(
    async () => (await read(parent.id)).current_node_id === 'publish',
    'the parent reaches publish',
  );
  const { input } = await api<{ input: Record<string, unknown> }>(
    'GET',
    `/v1/jobs/${parent.id}/context`,
  );
  assert.deepEqual(input.notes, { texts: ITEMS.map((item) => `text of ${item}`) });

  await tickUntil(async () => (await read(parent.id)).completed, 'the parent completes');
});

test('t638 AT33 — a blocked child blocks the parent; cancelling the parent cancels the open children', async (t) => {
  const { api, read, sessions, tickUntil, controller, parent } = await crossing(
    t,
    example('graph-valid-subgraph-fan-out.json'),
    'beta',
  );

  await tickUntil(async () => (await read(parent.id)).blocked, 'the parent is blocked');

  const blocked = await read(parent.id);
  const [first, second, third] = blocked.children;
  assert.equal((await read(second)).blocked, true, 'child 2 is waiting on a person');
  const reason = String(blocked.block_reason);
  assert.ok(reason.includes(`child job ${second}`), reason);
  assert.ok(reason.includes('2 of 3'), reason);
  assert.equal(
    (await sessions()).filter((session) => session.job_id === third).length,
    0,
    'child 3 never ran',
  );

  await api('POST', `/v1/jobs/${parent.id}/cancellations`, {});
  assert.equal((await read(first)).cancelled_at, null, 'a completed child is left alone');
  assert.notEqual((await read(second)).cancelled_at, null);
  assert.notEqual((await read(third)).cancelled_at, null);

  await controller.tick();
  await controller.tick();
  const after = await read(parent.id);
  assert.equal(after.current_node_id, 'write-notes', 'the parent never left the node');
  assert.equal(after.completed, false);
});
