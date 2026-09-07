/**
 * Acceptance tests of the job page's two new sections (t368, RF-39).
 *
 * `GET /jobs/:id` gains an Artifacts table (what the traversal produced, and a
 * link to open each one) and a Sessions table (the job's own sessions, each
 * reaching its decoded log at `/sessions/:id/log`) — the raw ticket's Context
 * misread the second as already existing; it did not, and without it the log
 * view has no entry point (the ticket's own Refinement Log).
 *
 * The control plane is a STUB, the same choice `examples-page.test.ts` makes
 * for the same reason: what this file pins is what the job page PUTS ON THE
 * WIRE and what it draws out of the answer, and the real routes (`GET /v1/
 * jobs/:id/artifacts`, the sessions listing) are proven end to end against a
 * real control plane in `packages/core/test/jobs.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as RouterModule from '../src/router.ts';
import { T107_ARTIFACTS, requireArtifacts, type TestHooks } from './support.ts';

const JOB = Object.freeze({
  id: 42,
  execution_id: null,
  title: 'A note about the Q3 numbers',
  entry_node_id: 'redigir',
  current_node_id: 'revisar',
  blocked: false,
  block_reason: null,
  graph_version_id: null,
  completed: false,
  state: 'running',
  state_since: '2026-09-01T00:00:00.000Z',
  fields: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
});

const SESSIONS = Object.freeze([
  Object.freeze({
    id: 501,
    job_id: 42,
    execution_id: null,
    node_id: 'redigir',
    engine: 'claude-code',
    status: 'completed',
    exit_code: 0,
    usage: null,
    opened_at: '2026-09-01T00:00:00.000Z',
    finished_at: '2026-09-01T00:05:00.000Z',
  }),
  Object.freeze({
    id: 502,
    job_id: 42,
    execution_id: null,
    node_id: 'revisar',
    engine: 'claude-code',
    status: 'failed',
    exit_code: 1,
    usage: null,
    opened_at: '2026-09-01T00:06:00.000Z',
    finished_at: null,
  }),
]);

const ARTIFACTS = Object.freeze([
  Object.freeze({
    id: 9001,
    session_id: 501,
    node_id: 'redigir',
    name: 'draft.md',
    media_type: 'text/markdown',
    size: 1234,
    created_at: '2026-09-01T00:03:00.000Z',
  }),
  Object.freeze({
    id: 9002,
    session_id: 502,
    node_id: 'revisar',
    name: 'review.md',
    media_type: 'text/markdown',
    size: 512,
    created_at: '2026-09-01T00:07:00.000Z',
  }),
  Object.freeze({
    id: 9003,
    session_id: 502,
    node_id: 'revisar',
    name: 'screenshot.png',
    media_type: 'image/png',
    size: 20480,
    created_at: '2026-09-01T00:08:00.000Z',
  }),
]);

/** Canned bodies, by path, for a job that has produced sessions and artifacts. */
function cannedResponses(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '/v1/projects': { projects: [] },
    '/v1/jobs/42': JOB,
    '/v1/jobs/42/events': { events: [] },
    '/v1/sessions': { sessions: SESSIONS },
    '/v1/input-requests': { input_requests: [] },
    '/v1/jobs/42/artifacts': { artifacts: ARTIFACTS },
    ...overrides,
  };
}

/** The screen, up, over a stub control plane that answers the given bodies. */
async function startScreenOverStub(
  t: TestHooks,
  canned: Record<string, unknown>,
): Promise<{ url: string }> {
  requireArtifacts(T107_ARTIFACTS.router, T107_ARTIFACTS.pages, T107_ARTIFACTS.client);
  const { startScreenRouter } = (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;

  const doFetch: typeof fetch = async (input) => {
    const target = new URL(typeof input === 'string' ? input : String(input));
    return new Response(JSON.stringify(canned[target.pathname] ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const screen = await startScreenRouter({
    controlPlaneUrl: 'http://127.0.0.1:4317',
    port: 0,
    doFetch,
  });
  t.after(async () => {
    await screen.close();
  });

  return { url: screen.url };
}

/** The excerpt of one `data-<marker>="<value>"` row, sliced out of the HTML. */
function rowsMarked(html: string, marker: string): string[] {
  const pattern = new RegExp(`<tr data-${marker}="([^"]*)"[^]*?</tr>`, 'g');
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

test('t368 AT — the job page renders one row per artifact, newest first, with the right node', async (t) => {
  const screen = await startScreenOverStub(t, cannedResponses());

  const response = await fetch(`${screen.url}/jobs/42`);
  assert.equal(response.status, 200);
  const html = await response.text();

  const rows = rowsMarked(html, 'artifact');
  assert.equal(rows.length, 3, `expected 3 artifact rows, got ${rows.length}:\n${html}`);

  for (const artifact of ARTIFACTS) {
    const row = rows.find((candidate) => candidate.includes(`data-artifact="${artifact.id}"`));
    assert.ok(row !== undefined, `no row for artifact #${artifact.id}`);
    assert.ok(row.includes(artifact.name), `row for #${artifact.id} is missing its name`);
    assert.ok(row.includes(artifact.node_id), `row for #${artifact.id} is missing its node`);
    assert.ok(
      row.includes(`/v1/artifacts/${artifact.id}/content`),
      `row for #${artifact.id} has no open link`,
    );
  }
});

test('t368 AT — the job page renders one session row per session, each linking to its log', async (t) => {
  const screen = await startScreenOverStub(t, cannedResponses());

  const response = await fetch(`${screen.url}/jobs/42`);
  assert.equal(response.status, 200);
  const html = await response.text();

  const rows = rowsMarked(html, 'sessao');
  assert.equal(rows.length, 2, `expected 2 session rows, got ${rows.length}:\n${html}`);

  for (const session of SESSIONS) {
    const row = rows.find((candidate) => candidate.includes(`data-sessao="${session.id}"`));
    assert.ok(row !== undefined, `no row for session #${session.id}`);
    assert.ok(
      row.includes(`href="/sessions/${session.id}/log"`),
      `session #${session.id} has no link to its decoded log`,
    );
    assert.ok(
      row.includes(`data-transcricao="${session.id}"`) &&
        row.includes(`/v1/sessions/${session.id}/transcript`),
      `session #${session.id} lost its raw transcript link`,
    );
  }
});

test('t368 AT — a job with no artifacts renders the exact empty-state line', async (t) => {
  const screen = await startScreenOverStub(t, cannedResponses({ '/v1/jobs/42/artifacts': { artifacts: [] } }));

  const response = await fetch(`${screen.url}/jobs/42`);
  const html = await response.text();

  assert.ok(
    html.includes('<p class="vazio">this traversal produced no artifacts yet</p>'),
    `the empty-state line is missing:\n${html}`,
  );
  assert.equal(rowsMarked(html, 'artifact').length, 0);
});

test('t368 AT — a job with no sessions renders the sessions section\'s own empty state', async (t) => {
  const screen = await startScreenOverStub(t, cannedResponses({ '/v1/sessions': { sessions: [] } }));

  const response = await fetch(`${screen.url}/jobs/42`);
  const html = await response.text();

  assert.equal(rowsMarked(html, 'sessao').length, 0);
  assert.match(html, /<p class="vazio">[^<]*sessions[^<]*<\/p>/i, `no empty state for sessions:\n${html}`);
});
