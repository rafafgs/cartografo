/**
 * Acceptance tests for the editor's operation diff (t170, FR4).
 *
 * The screen never invents a way to change a graph: D15 says a graph moves by
 * PROPOSAL, and a proposal is a list of typed semantic operations, each one
 * carrying its own inverse. So what this page really produces is not a new
 * document — it is the diff between the snapshot it loaded and the state the
 * person left on screen, expressed in the five operations
 * `packages/core/src/domain/operations.ts` already accepts.
 *
 * That diff is a pure function for the same reason `actions.js` and `diff.js`
 * are: it runs in the browser and is tested in Node, with no DOM in the way.
 * It is also the piece that decides whether the editor is a client of the API
 * or a shortcut around it — every assertion below is about the shape the public
 * route takes, inverse included.
 *
 * The operation keys (`type`, `node`, `node_id`, `edge`, `field`, `from`, `to`,
 * `inverse`) are the wire format the core owns, and they speak
 * `docs/spec/glossary-wire.md` §3 since D20's third child (t228). This page
 * mirrors that vocabulary exactly: what it builds goes to `POST /v1/proposals`
 * untouched, so a mirror one word out of step is a browser that posts 400s.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'graph-operations.js');

/** One semantic operation, as loose here as it is on the wire. */
type SemanticOperation = Record<string, unknown>;

/** Anything with `nodes` and `edges` — the only two keys the diff reads. */
type Document = Record<string, unknown>;

type DiffGraphs = (loaded: Document, edited: Document) => SemanticOperation[];

async function loadDiff(): Promise<DiffGraphs> {
  assert.ok(
    existsSync(MODULE_PATH),
    'artifact does not exist yet: packages/screen/src/public/graph-operations.js',
  );
  const module = (await import(
    new URL('../src/public/graph-operations.js', import.meta.url).href
  )) as { diffGraphs: DiffGraphs };
  return module.diffGraphs;
}

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function contractFor(what: string): Record<string, unknown> {
  return {
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    checks: [{ type: 'deterministic', command: `test -s ${what}.md` }],
  };
}

/**
 * A whole graph document, fresh on every call.
 *
 * Fresh and not shared: every test below mutates its own copy, and a shared
 * fixture would make the order the tests run in part of the result.
 */
function baseDocument(): Document {
  return {
    problem_class: 'nota-curta',
    lineage: { type: 'base' },
    metadata: { name: 'Nota curta', schema_version: '1.0.0' },
    nodes: [
      {
        id: 'redigir',
        role: 'redator',
        node_type: 'work',
        description: 'Writes the note from the declared topic.',
        skill_ref: { id: 'cartografo/redigir-nota', version: '1.0.0', hash: HASH_A },
        contract: contractFor('nota'),
      },
      {
        id: 'revisar',
        role: 'revisor',
        node_type: 'gate',
        skill_ref: { id: 'cartografo/revisar-nota', version: '1.0.0', hash: HASH_B },
        contract: contractFor('revisao'),
      },
    ],
    edges: [{ from: 'redigir', to: 'revisar', condition: 'sempre' }],
    initial_node: 'redigir',
    final_nodes: ['revisar'],
    custom_fields: [],
  };
}

/** The nodes of a document, as a list this file may mutate. */
function nodesOf(document: Document): Record<string, unknown>[] {
  return document.nodes as Record<string, unknown>[];
}

/** The edges of a document, as a list this file may mutate. */
function edgesOf(document: Document): Record<string, unknown>[] {
  return document.edges as Record<string, unknown>[];
}

test('AT1 — a new node becomes one `add_node` whose inverse removes that id', async () => {
  const diffGraphs = await loadDiff();

  const loaded = baseDocument();
  const edited = baseDocument();
  const fresh = {
    id: 'aprovar',
    role: 'aprovador',
    node_type: 'gate',
    description: 'Checks and closes.',
    skill_ref: { id: 'cartografo/aprovar-nota', version: '2.0.0', hash: HASH_C },
    contract: contractFor('aprovacao'),
  };
  nodesOf(edited).push(fresh);

  assert.deepEqual(diffGraphs(loaded, edited), [
    { type: 'add_node', node: fresh, inverse: { type: 'remove_node', node_id: 'aprovar' } },
  ]);
});

test('AT2 — a removed node becomes one `remove_node` whose inverse carries it back whole', async () => {
  const diffGraphs = await loadDiff();

  const loaded = baseDocument();
  const edited = baseDocument();
  const gone = nodesOf(edited).splice(1, 1)[0];

  assert.deepEqual(diffGraphs(loaded, edited), [
    {
      type: 'remove_node',
      node_id: 'revisar',
      // The whole original node, and not just its id: it is the only thing that
      // can put the node back, and D15 demands the way back exist at the moment
      // the operation is written.
      inverse: { type: 'add_node', node: gone },
    },
  ]);
});

test('AT3 — one `change_node_field` per changed field, with `from`/`to` and inverse', async () => {
  const diffGraphs = await loadDiff();

  const loaded = baseDocument();
  const edited = baseDocument();
  const target = nodesOf(edited)[0];
  const newSkill = { id: 'cartografo/redigir-nota', version: '2.0.0', hash: HASH_C };
  const newContract = contractFor('outra-nota');

  target.role = 'escritor';
  target.description = 'Another sentence.';
  target.skill_ref = newSkill;
  target.contract = newContract;

  assert.deepEqual(diffGraphs(loaded, edited), [
    {
      type: 'change_node_field',
      node_id: 'redigir',
      field: 'role',
      from: 'redator',
      to: 'escritor',
      inverse: {
        type: 'change_node_field',
        node_id: 'redigir',
        field: 'role',
        from: 'escritor',
        to: 'redator',
      },
    },
    {
      type: 'change_node_field',
      node_id: 'redigir',
      field: 'description',
      from: 'Writes the note from the declared topic.',
      to: 'Another sentence.',
      inverse: {
        type: 'change_node_field',
        node_id: 'redigir',
        field: 'description',
        from: 'Another sentence.',
        to: 'Writes the note from the declared topic.',
      },
    },
    {
      type: 'change_node_field',
      node_id: 'redigir',
      field: 'skill_ref',
      from: { id: 'cartografo/redigir-nota', version: '1.0.0', hash: HASH_A },
      to: newSkill,
      inverse: {
        type: 'change_node_field',
        node_id: 'redigir',
        field: 'skill_ref',
        from: newSkill,
        to: { id: 'cartografo/redigir-nota', version: '1.0.0', hash: HASH_A },
      },
    },
    {
      type: 'change_node_field',
      node_id: 'redigir',
      field: 'contract',
      from: contractFor('nota'),
      to: newContract,
      inverse: {
        type: 'change_node_field',
        node_id: 'redigir',
        field: 'contract',
        from: newContract,
        to: contractFor('nota'),
      },
    },
  ]);
});

test('AT4 — an added and a removed edge become their two operations, each with its inverse', async () => {
  const diffGraphs = await loadDiff();

  const loaded = baseDocument();
  const edited = baseDocument();
  edgesOf(edited).splice(0, 1);
  const added = {
    from: 'revisar',
    to: 'redigir',
    condition: 'retrabalho',
    description: 'The review hands the note back.',
  };
  edgesOf(edited).push(added);

  assert.deepEqual(diffGraphs(loaded, edited), [
    // Removals first: it is the order that keeps the sequence applicable when a
    // node leaves together with the edges that touched it.
    //
    // The target carries `condition` since t205: two edges between the same two
    // nodes are two edges, and a removal that names only the ends cannot say
    // which one it meant. The core takes it as optional, so the ends alone
    // still work for every operation written before this.
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 'sempre' },
      inverse: {
        type: 'add_edge',
        edge: { from: 'redigir', to: 'revisar', condition: 'sempre' },
      },
    },
    {
      type: 'add_edge',
      edge: added,
      inverse: {
        type: 'remove_edge',
        edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
      },
    },
  ]);
});

test('AT5 — an untouched document produces no operation at all', async () => {
  const diffGraphs = await loadDiff();

  assert.deepEqual(diffGraphs(baseDocument(), baseDocument()), []);
});

/* -------------------------------------------------------------------------- */
/* t205 — two parallel edges are two edges.                                    */
/*                                                                            */
/* Nothing in the format, the schema or this page ever forbade two edges       */
/* between the same pair of nodes with different `condition`s — the page draws */
/* one card each and lets both be edited. What used to collapse them was this  */
/* diff, keying its before/after maps by the two ends alone: the second edge   */
/* overwrote the first, so removing one of a pair produced no operation at all */
/* and adding a third became a no-op. Identity here is `from + to + condition`.*/
/* -------------------------------------------------------------------------- */

/** Two edges between the same pair of nodes, told apart only by `condition`. */
function parallelDocument(): Document {
  const document = baseDocument();
  document.edges = [
    { from: 'redigir', to: 'revisar', condition: 'aprovado' },
    { from: 'redigir', to: 'revisar', condition: 'reprovado' },
  ];
  return document;
}

test('t205 AT — a third parallel edge is one `add_edge`, and the two that stayed are silent', async () => {
  const diffGraphs = await loadDiff();

  const loaded = parallelDocument();
  const edited = parallelDocument();
  const added = { from: 'redigir', to: 'revisar', condition: 'escala' };
  edgesOf(edited).push(added);

  assert.deepEqual(diffGraphs(loaded, edited), [
    {
      type: 'add_edge',
      edge: added,
      // The inverse names the edge it has to take back out, `condition` and
      // all — otherwise undoing this addition could remove a sibling.
      inverse: { type: 'remove_edge', edge: added },
    },
  ]);
});

test('t205 AT — removing one of a parallel pair is one `remove_edge` pinned to its condition', async () => {
  const diffGraphs = await loadDiff();

  const loaded = parallelDocument();
  const edited = parallelDocument();
  const gone = edgesOf(edited).splice(1, 1)[0];

  assert.deepEqual(diffGraphs(loaded, edited), [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 'reprovado' },
      inverse: { type: 'add_edge', edge: gone },
    },
  ]);
});

test('t205 AT — retyping one condition of a parallel pair moves that edge and no other', async () => {
  const diffGraphs = await loadDiff();

  const loaded = parallelDocument();
  const edited = parallelDocument();
  edgesOf(edited)[1].condition = 'escala';

  // There is no operation that changes an edge, so this is a removal pinned to
  // the OLD condition followed by an addition carrying the new one.
  assert.deepEqual(diffGraphs(loaded, edited), [
    {
      type: 'remove_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 'reprovado' },
      inverse: {
        type: 'add_edge',
        edge: { from: 'redigir', to: 'revisar', condition: 'reprovado' },
      },
    },
    {
      type: 'add_edge',
      edge: { from: 'redigir', to: 'revisar', condition: 'escala' },
      inverse: {
        type: 'remove_edge',
        edge: { from: 'redigir', to: 'revisar', condition: 'escala' },
      },
    },
  ]);
});
