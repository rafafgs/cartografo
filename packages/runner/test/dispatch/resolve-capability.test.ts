/**
 * Acceptance tests for resolving a node's capability at dispatch (t1282, FR4).
 *
 * The graph document may carry a `capability` at the top and on a node. The
 * dispatch reads it the way it reads `model`: off the ONE resolved node, with
 * no fetch of its own. Precedence is node, then graph, then absent, and the
 * dispatch never guesses — a value that is not exactly `general` or `advanced`
 * is absent here, because registration is where such a document is refused.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as engineModule from '../../src/dispatch/resolve-engine.ts';
import { resolveNode, type GraphNode, type ResolvedNode } from '../../src/dispatch/resolve-node.ts';

type Resolve = (resolved: ResolvedNode | null) => string | undefined;

function resolveCapability(resolved: ResolvedNode | null): string | undefined {
  const fn = (engineModule as unknown as { resolveCapability?: Resolve }).resolveCapability;
  assert.equal(typeof fn, 'function', 'resolve-engine.ts does not export resolveCapability yet');
  return (fn as Resolve)(resolved);
}

/** A resolved node, with the two places a capability can come from. */
function resolved(node: Record<string, unknown>, graphCapability?: unknown): ResolvedNode {
  return {
    versionId: 'sha256:cafe',
    node: { id: 'draft', role: 'writer', node_type: 'work', ...node } as GraphNode,
    edges: [],
    ...(graphCapability === undefined ? {} : { graphCapability }),
  } as ResolvedNode;
}

test('t1282 AT7 — the node\'s own capability beats the graph\'s', () => {
  assert.equal(resolveCapability(resolved({ capability: 'advanced' }, 'general')), 'advanced');
});

test('t1282 AT8 — a node with none inherits the graph\'s', () => {
  assert.equal(resolveCapability(resolved({}, 'general')), 'general');
  assert.equal(resolveCapability(resolved({}, 'advanced')), 'advanced');
});

test('t1282 AT9 — absent on both, and no resolved node at all, is undefined', () => {
  assert.equal(resolveCapability(resolved({})), undefined);
  assert.equal(resolveCapability(null), undefined);
});

test('t1282 AT10 — blank, unknown and non-string values are treated as absent', () => {
  for (const bad of ['', '  ', 'turbo', 'General', 7, true, ['general'], {}, null]) {
    assert.equal(resolveCapability(resolved({ capability: bad })), undefined, `node ${JSON.stringify(bad)}`);
    assert.equal(resolveCapability(resolved({}, bad)), undefined, `graph ${JSON.stringify(bad)}`);
  }
  // An unusable node value does not fall through to the graph's: the node
  // spoke, and "the dispatch does not guess" is the whole rule.
  assert.equal(resolveCapability(resolved({ capability: 'turbo' }, 'general')), undefined);
});

test('t1282 AT11 — a shell node resolves to undefined even under a graph capability', () => {
  assert.equal(resolveCapability(resolved({ engine: 'shell' }, 'general')), undefined);
  assert.equal(resolveCapability(resolved({ engine: 'shell', capability: 'advanced' }, 'general')), undefined);
  // ...and any other engine is unaffected.
  assert.equal(resolveCapability(resolved({ engine: 'codex' }, 'general')), 'general');
});

test('t1282 AT12 — resolveNode carries the snapshot\'s top-level capability as graphCapability', async () => {
  const job = { current_node_id: 'draft', graph_version_id: 'sha256:cafe' };
  const nodes = [{ id: 'draft', role: 'writer', node_type: 'work' }];

  const withCapability = await resolveNode(job, () =>
    Promise.resolve({
      graph_version: { id: 'sha256:cafe', snapshot: { nodes, edges: [], capability: 'general' } },
    }),
  );
  assert.equal(withCapability?.graphCapability, 'general');

  const without = await resolveNode(job, () =>
    Promise.resolve({ graph_version: { id: 'sha256:cafe', snapshot: { nodes, edges: [] } } }),
  );
  assert.ok(without !== null);
  assert.equal(Object.hasOwn(without, 'graphCapability'), false, 'absent, not a key holding undefined');
});
