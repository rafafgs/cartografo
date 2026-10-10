/**
 * Acceptance tests of the composition surface of the MCP server (t639,
 * AT15-AT18): the relation fields in `jobDigest`, the children of
 * `cartografo_get_job`, and the absence of any cancel tool.
 *
 * A fake `fetch` throughout, the posture of `tools.test.ts`: what is under test
 * is what the catalogue does with the answers, and how many requests it makes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ApiClient } from '../src/client.ts';
import type { Job } from '../src/client.ts';
import { callTool } from '../src/protocol.ts';
import { TOOLS, jobDigest } from '../src/tools.ts';

const TOKEN = 'a-secret-that-must-not-travel';
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A job as the API sends it, with the relation fields; `extra` overrides any of them. */
function job(id: number, extra: Record<string, unknown> = {}): Job {
  return {
    id,
    project_id: 1,
    execution_id: null,
    title: `job ${id}`,
    body: null,
    acceptance_criteria: null,
    fields: null,
    tier: null,
    entry_node_id: 'plan',
    current_node_id: 'plan',
    blocked: false,
    block_reason: null,
    graph_version_id: null,
    completed: false,
    state: 'queued',
    created_at: '2026-10-10T09:00:00.000Z',
    updated_at: '2026-10-10T09:00:00.000Z',
    parent_job_id: null,
    parent_node_id: null,
    sibling_position: null,
    children: [],
    depends_on: [],
    cancelled_at: null,
    dispatch_hold: null,
    ...extra,
  } as Job;
}

/** A client over a fake control plane, recording every request. */
function fakeClient(handler: (path: string) => Response): { client: ApiClient; requests: string[] } {
  const requests: string[] = [];
  const client = new ApiClient({
    baseUrl: 'http://127.0.0.1:4317',
    token: TOKEN,
    doFetch: async (input, init) => {
      const url = new URL(String(input));
      const route = `${decodeURIComponent(url.pathname)}${url.search}`;
      requests.push(`${init?.method ?? 'GET'} ${route}`);
      return handler(route);
    },
  });
  return { client, requests };
}

async function call(client: ApiClient, name: string, args: Record<string, unknown>) {
  const result = (await callTool(client, { name, arguments: args })) as {
    content: { text: string }[];
    isError: boolean;
  };
  return { text: result.content[0].text, isError: result.isError };
}

/** A parent (id 10) with three children (11, 12, 13), the second waiting on a person. */
function family(): Job[] {
  return [
    job(10, { children: [11, 12, 13], dispatch_hold: 'children' }),
    job(11, { parent_job_id: 10, parent_node_id: 'fan-out', sibling_position: 1, state: 'completed', completed: true }),
    job(12, { parent_job_id: 10, parent_node_id: 'fan-out', sibling_position: 2, state: 'awaiting_you' }),
    job(13, {
      parent_job_id: 10,
      parent_node_id: 'fan-out',
      sibling_position: 3,
      depends_on: [12],
      dispatch_hold: 'dependencies',
    }),
  ];
}

test('AT15 — jobDigest passes the relation fields through, and defaults a job without them', () => {
  const related = job(5, {
    parent_job_id: 1,
    parent_node_id: 'fan-out',
    sibling_position: 2,
    children: [6, 7],
    depends_on: [4],
    cancelled_at: '2026-10-10T10:00:00.000Z',
    dispatch_hold: 'cancelled',
  });
  const digest = jobDigest(related);
  assert.equal(digest.parent_job_id, 1);
  assert.equal(digest.parent_node_id, 'fan-out');
  assert.equal(digest.sibling_position, 2);
  assert.deepEqual(digest.children, [6, 7]);
  assert.deepEqual(digest.depends_on, [4]);
  assert.equal(digest.cancelled_at, '2026-10-10T10:00:00.000Z');
  assert.equal(digest.dispatch_hold, 'cancelled');

  const bare = { ...job(8) } as Record<string, unknown>;
  for (const key of [
    'parent_job_id',
    'parent_node_id',
    'sibling_position',
    'children',
    'depends_on',
    'cancelled_at',
    'dispatch_hold',
  ]) {
    delete bare[key];
  }
  const empty = jobDigest(bare as unknown as Job);
  assert.equal(empty.parent_job_id, null);
  assert.equal(empty.parent_node_id, null);
  assert.equal(empty.sibling_position, null);
  assert.deepEqual(empty.children, []);
  assert.deepEqual(empty.depends_on, []);
  assert.equal(empty.cancelled_at, null);
  assert.equal(empty.dispatch_hold, null);
});

test('AT16 — get_job on a parent reads the board once and names the child waiting on a person', async () => {
  const jobs = family();
  const { client, requests } = fakeClient((route) => {
    if (route.startsWith('/v1/jobs/10/events')) return json({ events: [] });
    if (route.startsWith('/v1/jobs/10')) return json(jobs[0]);
    if (route.startsWith('/v1/jobs')) return json({ jobs: [jobs[3], jobs[0], jobs[2], jobs[1]] });
    if (route.startsWith('/v1/sessions')) return json({ sessions: [] });
    if (route.startsWith('/v1/input-requests')) return json({ input_requests: [] });
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_get_job', { job_id: 10 });
  assert.equal(result.isError, false, result.text);
  const body = JSON.parse(result.text) as {
    children: Array<{ id: number; state: string; sibling_position: number }>;
    waiting_on_a_person: number[];
  };
  assert.deepEqual(
    body.children.map((child) => child.id),
    [11, 12, 13],
    'position order, whatever order the board answered in',
  );
  assert.deepEqual(
    body.children.map((child) => child.state),
    ['completed', 'awaiting_you', 'queued'],
  );
  assert.deepEqual(body.waiting_on_a_person, [12]);
  assert.equal(
    requests.filter((entry) => /^GET \/v1\/jobs(\?|$)/.test(entry)).length,
    1,
    `exactly one board read, got: ${requests.join(' | ')}`,
  );

  const loose = fakeClient((route) => {
    if (route.startsWith('/v1/jobs/20/events')) return json({ events: [] });
    if (route.startsWith('/v1/jobs/20')) return json(job(20));
    if (route.startsWith('/v1/sessions')) return json({ sessions: [] });
    if (route.startsWith('/v1/input-requests')) return json({ input_requests: [] });
    return json({}, 404);
  });
  const alone = await call(loose.client, 'cartografo_get_job', { job_id: 20 });
  assert.equal(alone.isError, false, alone.text);
  const aloneBody = JSON.parse(alone.text) as { children: unknown[]; waiting_on_a_person: unknown[] };
  assert.deepEqual(aloneBody.children, []);
  assert.deepEqual(aloneBody.waiting_on_a_person, []);
  assert.equal(
    loose.requests.filter((entry) => /^GET \/v1\/jobs(\?|$)/.test(entry)).length,
    0,
    'no board read for a job without children',
  );
});

test('AT17 — nothing in the catalogue cancels a job, and the spec says why', () => {
  assert.deepEqual(
    TOOLS.filter((tool) => tool.name.includes('cancel')).map((tool) => tool.name),
    [],
  );

  const spec = readFileSync(path.join(REPO_ROOT, 'docs', 'spec', 'mcp-server.md'), 'utf8');
  const lines = spec.split('\n');
  const start = lines.findIndex((line) => line.startsWith('## 2.'));
  assert.notEqual(start, -1, 'mcp-server.md has no §2');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n');
  assert.match(section, /cancel/i);
});

test('AT18 — list_jobs returns the relation fields for a parent and its children', async () => {
  const jobs = family();
  const { client } = fakeClient((route) => (route.startsWith('/v1/jobs') ? json({ jobs }) : json({}, 404)));

  const result = await call(client, 'cartografo_list_jobs', {});
  assert.equal(result.isError, false, result.text);
  const body = JSON.parse(result.text) as { jobs: Array<Record<string, unknown>> };
  const parent = body.jobs.find((entry) => entry.id === 10);
  const second = body.jobs.find((entry) => entry.id === 12);
  const third = body.jobs.find((entry) => entry.id === 13);
  assert.deepEqual(parent?.children, [11, 12, 13]);
  assert.equal(parent?.dispatch_hold, 'children');
  assert.equal(second?.parent_job_id, 10);
  assert.equal(second?.sibling_position, 2);
  assert.deepEqual(third?.depends_on, [12]);
  assert.equal(third?.dispatch_hold, 'dependencies');
});
