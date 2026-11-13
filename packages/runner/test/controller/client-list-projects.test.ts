/**
 * Acceptance test of `ControlPlaneClient.listProjects()` (t1112, AT8).
 *
 * The one read a runner serving `--all-projects` needs that the client did not
 * have. Pinned against an injected `fetch`, the same pattern
 * `control-plane-client.test.ts` uses for every other method.
 *
 * English only.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ControlPlaneClient,
  ControlPlaneClientError,
} from '../../src/controller/control-plane-client.ts';

const BASE_URL = 'http://127.0.0.1:4317';

interface SeenCall {
  url: string;
  method: string;
  authorization: string | null;
}

/** A `fetch` that records each call and answers with the given status and body. */
function fakeFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: SeenCall[] } {
  const calls: SeenCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

test('AT8 — listProjects issues GET /v1/projects with the bearer token and returns the array', async () => {
  const projects = [
    { id: 1, name: 'default', created_at: '2026-11-13T10:00:00.000Z' },
    { id: 4, name: 'factory', created_at: '2026-11-13T11:00:00.000Z' },
  ];
  const { fetchImpl, calls } = fakeFetch(200, { projects });
  const client = new ControlPlaneClient({ urlBase: BASE_URL, token: 'secret', fetchImpl });

  const listed = await client.listProjects();

  assert.deepEqual(listed, projects);
  assert.deepEqual(calls, [
    { url: `${BASE_URL}/v1/projects`, method: 'GET', authorization: 'Bearer secret' },
  ]);

  const refused = fakeFetch(403, { error: 'out_of_scope' });
  const runnerOnly = new ControlPlaneClient({
    urlBase: BASE_URL,
    token: 'runner-token',
    fetchImpl: refused.fetchImpl,
  });
  await assert.rejects(
    async () => await runnerOnly.listProjects(),
    (error: unknown) => {
      assert.ok(error instanceof ControlPlaneClientError, String(error));
      assert.equal(error.status, 403);
      return true;
    },
  );
});
