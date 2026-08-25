/**
 * Acceptance tests for node resolution (t161, FR1/FR2).
 *
 * One fetch of the graph version per dispatch, and everything the rest of the
 * dispatch needs to know about the node comes out of it: which node the work is
 * standing on, and which edges leave it. Until this ticket the same fetch existed
 * inside `resolveEngine` and read exactly one field off the node — a second
 * consumer would have been a second `GET`, and two reads of the same snapshot in
 * one dispatch is how the engine that ran and the edge that was taken end up
 * coming from different documents.
 *
 * `null` and a rejection are NOT the same answer here, and the difference is the
 * whole reason the module exists: a work with no graph, or a node the snapshot
 * does not carry, is ordinary and resolves to `null`; a `graph_version_id` that
 * is set and does not resolve is a dangling reference, and it propagates.
 *
 * English per D18; route segments and payload keys stay in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ClientModule from '../../src/controller/control-plane-client.ts';
import type * as ResolveModule from '../../src/dispatch/resolve-node.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/resolve-node.ts';
const URL_BASE = 'http://127.0.0.1:4317';

let cache: typeof ResolveModule | null = null;

async function loadModule(): Promise<typeof ResolveModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/resolve-node.ts', import.meta.url).href
  )) as typeof ResolveModule;
  return cache;
}

/** The version id every case below points at. The `:` is why the route encodes. */
const VERSION_ID = 'sha256:d3adb33f';

/** The snapshot the fake control plane serves: two nodes, one gate, three edges. */
function snapshot(): Record<string, unknown> {
  return {
    nodes: [
      { id: 'implementar', role: 'desenvolvedor', node_type: 'work' },
      { id: 'conferir', role: 'tester', node_type: 'gate', engine: 'codex' },
      {
        id: 'publicar',
        role: 'deployer',
        node_type: 'work',
        escalation_policy: 'never',
        escalation_recipient: 'plantao-de-publicacao',
      },
    ],
    edges: [
      { from: 'implementar', to: 'conferir', condition: 'sempre' },
      { from: 'conferir', to: 'publicar', condition: 'aprovado' },
      { from: 'conferir', to: 'implementar', condition: 'retrabalho' },
    ],
    initial_node: 'implementar',
    final_nodes: ['publicar'],
  };
}

/** Everything a request to the fake control plane recorded. */
interface Call {
  url: string;
  method: string;
}

/**
 * A `fetch` that serves the snapshot above, plus the ledger of what it was
 * asked.
 *
 * The spy is on `doFetch` and not on the reader the module is handed, on
 * purpose: what FR1 promises is one HTTP CALL per dispatch, and a reader
 * counted twice while the responses came from a cache would still satisfy a
 * looser assertion.
 */
function fakeFetch(status = 200): { doFetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: 'graph version not found' }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ graph_version: { id: VERSION_ID, snapshot: snapshot() } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { doFetch, calls };
}

/** The reader the dispatch hands in: one `GET`, decoded, throwing on a refusal. */
function reader(doFetch: typeof fetch, ControlPlaneClientError: typeof ClientModule.ControlPlaneClientError) {
  return async (route: string): Promise<ResolveModule.GraphVersionBody> => {
    const response = await doFetch(`${URL_BASE}${route}`, { method: 'GET' });
    const text = await response.text();
    const decoded: unknown = text === '' ? undefined : JSON.parse(text);
    if (!response.ok) {
      throw new ControlPlaneClientError(`GET ${route} answered ${response.status}`, response.status, decoded);
    }
    return decoded as ResolveModule.GraphVersionBody;
  };
}

async function loadClient(): Promise<typeof ClientModule> {
  return (await import(
    new URL('../../src/controller/control-plane-client.ts', import.meta.url).href
  )) as typeof ClientModule;
}

test('AT1 — a resolvable version yields the current node and the edges leaving it', async () => {
  const { resolveNode } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();
  const { doFetch, calls } = fakeFetch();

  const resolved = await resolveNode(
    { current_node_id: 'conferir', graph_version_id: VERSION_ID },
    reader(doFetch, ControlPlaneClientError),
  );

  assert.ok(resolved !== null, 'the node is in the snapshot, so it resolves');
  assert.equal(resolved.versionId, VERSION_ID);
  assert.equal(resolved.node.id, 'conferir');
  assert.equal(resolved.node.engine, 'codex', 'the whole node comes back, not one field of it');

  // Only the edges of THIS node, and in document order: the routing decision is
  // made against them and nothing else.
  assert.deepEqual(
    resolved.edges.map((edge) => `${edge.condition ?? ''}->${edge.to}`),
    ['aprovado->publicar', 'retrabalho->implementar'],
  );

  assert.equal(calls.length, 1, 'exactly one control-plane call resolves a node');
  assert.equal(
    calls[0].url,
    `${URL_BASE}/v1/graph-versions/${encodeURIComponent(VERSION_ID)}`,
    'the version id carries a colon, so the route has to encode it',
  );
});

test('AT2 — a work with no graph version resolves to null, with no call at all', async () => {
  const { resolveNode } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();

  for (const versionId of [null, undefined, '']) {
    const { doFetch, calls } = fakeFetch();
    const resolved = await resolveNode(
      { current_node_id: 'implementar', graph_version_id: versionId },
      reader(doFetch, ControlPlaneClientError),
    );
    assert.equal(resolved, null, `graph_version_id ${JSON.stringify(versionId)} is "no graph"`);
    assert.equal(calls.length, 0, 'there is nothing to ask the control plane about');
  }
});

test('AT3 — a node the snapshot does not carry resolves to null', async () => {
  const { resolveNode } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();
  const { doFetch, calls } = fakeFetch();

  const resolved = await resolveNode(
    { current_node_id: 'um-no-que-ninguem-declarou', graph_version_id: VERSION_ID },
    reader(doFetch, ControlPlaneClientError),
  );

  assert.equal(resolved, null, 'the version resolved; the node in it did not');
  assert.equal(calls.length, 1, 'and it cost exactly the one call it always costs');
});

test('AT4 — a version id that does not resolve propagates, never defaults', async () => {
  const { resolveNode } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();
  const { doFetch } = fakeFetch(404);

  await assert.rejects(
    async () =>
      resolveNode(
        { current_node_id: 'implementar', graph_version_id: VERSION_ID },
        reader(doFetch, ControlPlaneClientError),
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof ControlPlaneClientError,
        `expected the control plane's own refusal, got: ${String(error)}`,
      );
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test('t167 — the declared escalation policy travels with the node', async () => {
  const { resolveNode, resolveEscalationPolicy } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();
  const { doFetch } = fakeFetch();

  const resolved = await resolveNode(
    { current_node_id: 'publicar', graph_version_id: VERSION_ID },
    reader(doFetch, ControlPlaneClientError),
  );

  assert.ok(resolved !== null);
  assert.equal(
    resolved.node.escalation_policy,
    'never',
    'the raw value comes through untouched: the schema enum is what constrains it',
  );
  assert.equal(resolveEscalationPolicy(resolved), 'never');
});

test('t167 — absence and an unrecognized value are both today\'s behaviour', async () => {
  const { resolveNode, resolveEscalationPolicy } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();
  const { doFetch } = fakeFetch();

  // A node that declares nothing: every graph written before this field existed
  // keeps behaving exactly as it did.
  const declaringNothing = await resolveNode(
    { current_node_id: 'implementar', graph_version_id: VERSION_ID },
    reader(doFetch, ControlPlaneClientError),
  );
  assert.ok(declaringNothing !== null);
  assert.equal(declaringNothing.node.escalation_policy, undefined);
  assert.equal(resolveEscalationPolicy(declaringNothing), 'on_uncertainty');

  // And a value outside the three. The schema refuses it on the way in, so this
  // is a snapshot that changed shape underneath us — and the answer is the
  // default, never a guess at which of the three was meant.
  const unrecognized = {
    versionId: VERSION_ID,
    node: { id: 'implementar', escalation_policy: 'maybe' },
    edges: [],
  };
  assert.equal(resolveEscalationPolicy(unrecognized), 'on_uncertainty');

  // A work with no resolvable node at all is the same answer: there is no node
  // to have declared anything.
  assert.equal(resolveEscalationPolicy(null), 'on_uncertainty');
});

test('AT5 — a node with no outgoing edge resolves with an empty edge list', async () => {
  const { resolveNode } = await loadModule();
  const { ControlPlaneClientError } = await loadClient();
  const { doFetch } = fakeFetch();

  const resolved = await resolveNode(
    { current_node_id: 'publicar', graph_version_id: VERSION_ID },
    reader(doFetch, ControlPlaneClientError),
  );

  assert.ok(resolved !== null);
  assert.deepEqual(resolved.edges, [], 'a final node resolves; it just has nowhere to go');
});
