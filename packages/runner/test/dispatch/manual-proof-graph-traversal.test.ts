/**
 * Static sweep over the ficha's manual proof (t161, TDD exception).
 *
 * `scripts/spike-graph-traversal.mjs` is the half of this ficha the suite cannot
 * run: it needs an authenticated `claude` binary and spends real quota, which is
 * exactly why it is not a CI test (`docs/formatos/engine-adapter.md`). What a
 * sweep CAN prove is the set of invariants that make it a proof rather than a
 * script — that it exists, that no call in it reaches the control plane
 * anonymously, and that the graph and the skills it registers are the ones
 * committed to this repository instead of copies pasted into the file. A proof
 * that registers its own inline fixture proves the fixture, not the product.
 *
 * The same device `test/surveyor/manual-proof-credentials.test.ts` already uses,
 * pointed at this ficha's script.
 *
 * English per D18; the fixture paths stay as they are on disk.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPIKE_PATH = path.join(PACKAGE_ROOT, 'scripts', 'spike-graph-traversal.mjs');

/**
 * The factory graph the proof crosses, and the directory its skills live in.
 *
 * `grafos-de-fabrica/desenvolvimento-de-software` and not
 * `schema/exemplos/grafo-valido-flowpilot.json`: the two are the same flowpilot
 * port, but only this one can actually be registered end to end — the schema
 * example's `skill_ref.id`s are namespaced (`cartografo/refinar-ticket`) and the
 * skill registry's ids are kebab-case with no slash
 * (`packages/core/src/domain/manifest.ts`, `ID_PATTERN`), so its skills could
 * never enter the registry the pin is checked against.
 */
const GRAPH_PATH = path.join(
  REPO_ROOT,
  'grafos-de-fabrica',
  'desenvolvimento-de-software',
  'grafo.json',
);

function read(file: string): string {
  assert.ok(existsSync(file), `artifact does not exist yet: ${file}`);
  return readFileSync(file, 'utf8');
}

test('AT20 — the manual proof exists and takes the token the control plane printed on boot', () => {
  const source = read(SPIKE_PATH);

  assert.ok(
    source.includes('bootstrapToken'),
    'the proof boots its own control plane, so the only token it can present is the one that ' +
      'startup announced on its readiness line',
  );
});

test('AT21 — no call in the manual proof reaches the control plane anonymously', () => {
  const source = read(SPIKE_PATH);

  // One place in the whole script may call the global `fetch`: the wrapper that
  // arms the request with the token. Any second one is a route that goes out
  // bare.
  const bare = source.match(/(?<![\w.$])fetch\(/g) ?? [];
  assert.equal(
    bare.length,
    1,
    `the script calls the global fetch in ${bare.length} places; exactly one — the wrapper that ` +
      'presents the token — may do so',
  );
  assert.match(source, /authorization/i);

  // The two other doors out: the HTTP client the controller gets, and the
  // dispatch that writes the telemetry of every crossing session.
  assert.match(
    source,
    /new ClienteControle\(\{[^}]*token/s,
    'the controller client is still built with no token',
  );
  assert.match(
    source,
    /createClaudeCodeDispatch\(\{[\s\S]*?token/,
    'the sessions write their telemetry through the dispatch, so it has to carry the token',
  );
});

test('AT22 — the proof registers the committed factory graph and its committed skills', () => {
  const source = read(SPIKE_PATH);

  assert.ok(
    source.includes('grafos-de-fabrica') && source.includes('desenvolvimento-de-software'),
    'the proof has to register the graph this repository ships, not one written inside it',
  );
  assert.ok(
    /readFileSync\(\s*GRAPH_PATH/.test(source) || source.includes('readFileSync(graphPath'),
    'the document comes off disk',
  );
  assert.ok(
    source.includes('skills'),
    'and so do the manifests, which is what makes the pin check mean anything',
  );

  // The proof would be vacuous if the graph it names had no gate to route and
  // no cycle to come back through, so this asserts the fixture itself still has
  // both — the two properties the manual run is supposed to demonstrate.
  const graph = JSON.parse(read(GRAPH_PATH)) as {
    edges: Array<{ from: string; to: string; condition: string }>;
    final_nodes: string[];
  };
  const outgoing = new Map<string, number>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1);
  }
  assert.ok(
    [...outgoing.values()].some((count) => count > 1),
    'the graph the proof crosses has to have at least one node that really routes',
  );
  assert.ok(
    graph.edges.some((edge) => edge.condition === 'retrabalho'),
    'and a rework edge, or the "one forced cycle" the proof claims is unreachable',
  );
});

test('AT23 — the proof never posts a transition of its own', () => {
  const source = read(SPIKE_PATH);

  // The whole claim of the ficha, checked where it is cheapest to check: a
  // manual proof that crosses the graph by calling `/transitions` itself proves
  // the operator, not the runner.
  const posted = source.match(/['"`][^'"`]*\/transitions['"`]/g) ?? [];
  assert.deepEqual(
    posted,
    [],
    `the proof posts a transition itself in ${posted.length} place(s): ${posted.join(', ')}`,
  );
});
