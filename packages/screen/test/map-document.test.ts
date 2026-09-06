/**
 * Acceptance tests for the map document renderer (t431, RF-22, RF-23).
 *
 * `renderMapDocument()` is the one shared way to turn a graph document into
 * the vertical procedure document §3.4 of the requirements describes: one
 * block per step, the three contract fields always shown (needs, produces,
 * verified by — never hidden, never collapsed), a gate's exits, and nothing to
 * open, expand or drag.
 *
 * Two real documents drive these tests instead of ad hoc literals wherever
 * possible: `factory-graphs/software-development/graph.json` (the one graph
 * this repository already registers, read the same way `test/support.ts`
 * reads it) for the happy path and for RF-20's external-I/O line, and the new
 * `fixtures/map-design-draft-partial.json` for what an interview mid-flight
 * actually looks like — an empty-but-present contract, a missing one
 * altogether, and a gate with a declared exit.
 *
 * `contract.produces` (the bucket name) is deliberately never asserted here:
 * it is a different concept from the "produces" this document renders (Out of
 * Scope), and `software-development/graph.json` happens to declare it on
 * every node, which would make a careless assertion pass for the wrong
 * reason.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as MapDocumentModule from '../src/map-document.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MODULE_PATH = path.join(PACKAGE_ROOT, 'src', 'map-document.ts');
const GRAPH_PATH = path.join(REPO_ROOT, 'factory-graphs', 'software-development', 'graph.json');
const DRAFT_FIXTURE_PATH = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'map-design-draft-partial.json');

async function loadMapDocument(): Promise<typeof MapDocumentModule> {
  assert.ok(existsSync(MODULE_PATH), 'artifact does not exist yet: packages/screen/src/map-document.ts');
  return (await import(new URL('../src/map-document.ts', import.meta.url).href)) as typeof MapDocumentModule;
}

function readGraph(filePath: string): MapDocumentModule.MapDocumentGraph {
  assert.ok(existsSync(filePath), `fixture does not exist: ${filePath}`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as MapDocumentModule.MapDocumentGraph;
}

/** Every `data-field="needs"`/`"produces"`/`"verified_by"` block for one `data-step`, unparsed. */
function stepBlock(html: string, stepId: string): string {
  const marker = `data-step="${stepId}"`;
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `no block found for data-step="${stepId}" in:\n${html}`);
  const nextStart = html.indexOf('data-step="', start + marker.length);
  return nextStart === -1 ? html.slice(start) : html.slice(start, nextStart);
}

function fieldBlock(blockHtml: string, field: string): string {
  const marker = `data-field="${field}"`;
  const start = blockHtml.indexOf(marker);
  assert.ok(start >= 0, `no data-field="${field}" found in block:\n${blockHtml}`);
  // A field's own div closes before the next data-field or data-step marker;
  // slicing to the next marker (or the block's end) is precise enough for
  // these fragments, which never nest a field inside another one.
  const rest = blockHtml.slice(start + marker.length);
  const nextMarker = rest.search(/data-(field|step)="/);
  return nextMarker === -1 ? rest : rest.slice(0, nextMarker);
}

test('AT1 — every node of the real software-development graph gets a data-step block, with needs/produces/exits', async () => {
  const { renderMapDocument } = await loadMapDocument();
  const graph = readGraph(GRAPH_PATH);

  const html = renderMapDocument(graph);

  for (const node of graph.nodes) {
    assert.ok(html.includes(`data-step="${node.id}"`), `missing block for node "${node.id}"`);
  }

  const refineNeeds = fieldBlock(stepBlock(html, 'refine'), 'needs');
  assert.ok(refineNeeds.includes('ticket_id'), `refine's needs does not name ticket_id:\n${refineNeeds}`);
  assert.ok(refineNeeds.includes('request'), `refine's needs does not name request:\n${refineNeeds}`);
  assert.match(refineNeeds, /ticket_id[^<]*<\/li>/, 'ticket_id has no rendered list item');
  assert.ok(
    (refineNeeds.match(/required/g) ?? []).length >= 2,
    `refine's needs does not mark both ticket_id and request as required:\n${refineNeeds}`,
  );
  assert.ok(!refineNeeds.includes('to be defined'), 'a complete input_schema must not read "to be defined"');

  const refineProduces = fieldBlock(stepBlock(html, 'refine'), 'produces');
  assert.ok(!refineProduces.includes('to be defined'), 'a complete output_schema must not read "to be defined"');
  assert.ok(refineProduces.includes('specification'), `refine's produces does not name specification:\n${refineProduces}`);

  const testExits = fieldBlock(stepBlock(html, 'test'), 'exits');
  assert.ok(testExits.includes('approved') && testExits.includes('deploy'), `missing "approved → deploy" exit:\n${testExits}`);
  assert.ok(testExits.includes('rework') && testExits.includes('develop'), `missing "rework → develop" exit:\n${testExits}`);

  assert.ok(!html.includes('data-field="network"'), 'no manifests were passed in: no node may render an external-I/O line');
});

test('AT2 — with a matching manifest, only that one node renders the external-I/O line', async () => {
  const { renderMapDocument } = await loadMapDocument();
  const graph = readGraph(GRAPH_PATH);
  const developNode = graph.nodes.find((node) => node.id === 'develop');
  assert.ok(developNode?.skill_ref, 'fixture assumption broke: "develop" has no skill_ref anymore');

  const manifests: MapDocumentModule.MapDocumentManifest[] = [
    {
      id: developNode.skill_ref.id,
      version: developNode.skill_ref.version,
      hash: developNode.skill_ref.hash,
      permissions: {
        network: { allowed: true, domains: ['registry.example.dev'] },
      },
    },
  ];

  const html = renderMapDocument(graph, manifests);

  const developBlock = stepBlock(html, 'develop');
  assert.ok(developBlock.includes('data-field="network"'), 'develop should render the network line');
  assert.ok(developBlock.includes('registry.example.dev'), 'the declared domain must be named');

  for (const node of graph.nodes) {
    if (node.id === 'develop') continue;
    const block = stepBlock(html, node.id);
    assert.ok(!block.includes('data-field="network"'), `node "${node.id}" must not render a network line`);
  }
});

test('AT3 — the in-progress draft: empty and missing contracts read "to be defined", a gate exit and a work node with none', async () => {
  const { renderMapDocument } = await loadMapDocument();
  const graph = readGraph(DRAFT_FIXTURE_PATH);

  const html = renderMapDocument(graph);

  for (const stepId of ['draft-steps', 'name-gates']) {
    const block = stepBlock(html, stepId);
    for (const field of ['needs', 'produces', 'verified_by']) {
      const fieldHtml = fieldBlock(block, field);
      assert.ok(
        fieldHtml.includes('to be defined'),
        `node "${stepId}" field "${field}" should read "to be defined":\n${fieldHtml}`,
      );
    }
  }

  const gateBlock = stepBlock(html, 'review-soundness');
  const exits = fieldBlock(gateBlock, 'exits');
  assert.ok(exits.includes('needs_rework'), `gate exit is missing its condition:\n${exits}`);
  assert.ok(exits.includes('draft-steps'), `gate exit is missing its destination:\n${exits}`);

  const workBlock = stepBlock(html, 'collect-context');
  assert.ok(!workBlock.includes('data-field="exits"'), 'a work node must render no exits section at all');
});

test('AT4 — deterministic and agentic checks render escaped, never raw', async () => {
  const { renderMapDocument } = await loadMapDocument();

  const dangerousCommand = 'echo "<hi>" && curl';
  const dangerousInstruction = 'Check <all> the & "evidence"';
  const graph: MapDocumentModule.MapDocumentGraph = {
    nodes: [
      {
        id: 'mixed-checks',
        node_type: 'work',
        contract: {
          input_schema: {},
          output_schema: {},
          checks: [
            { type: 'deterministic', command: dangerousCommand, description: 'runs the & suite' },
            { type: 'agentic', instruction: dangerousInstruction },
          ],
        },
      },
    ],
  };

  const html = renderMapDocument(graph);

  assert.ok(!html.includes(dangerousCommand), 'raw command leaked unescaped into the HTML');
  assert.ok(!html.includes(dangerousInstruction), 'raw instruction leaked unescaped into the HTML');
  assert.ok(html.includes('echo &quot;&lt;hi&gt;&quot; &amp;&amp; curl'), 'command was not escaped as expected');
  assert.ok(html.includes('Check &lt;all&gt; the &amp; &quot;evidence&quot;'), 'instruction was not escaped as expected');
  assert.ok(html.includes('runs the &amp; suite'), 'deterministic check description was not escaped');
});

test('AT5 — a graph with no edges at all does not throw, and a gate reports no declared exit', async () => {
  const { renderMapDocument } = await loadMapDocument();

  const graph: MapDocumentModule.MapDocumentGraph = {
    nodes: [{ id: 'only-node', node_type: 'gate' }],
  };

  const html = renderMapDocument(graph);

  const exits = fieldBlock(stepBlock(html, 'only-node'), 'exits');
  assert.ok(exits.includes('no exit declared yet'), `expected the no-exit placeholder:\n${exits}`);
});

test('a node with neither role nor description renders its bare id as the heading', async () => {
  const { renderMapDocument } = await loadMapDocument();

  const graph: MapDocumentModule.MapDocumentGraph = {
    nodes: [{ id: 'bare-node', node_type: 'work' }],
  };

  const html = renderMapDocument(graph);

  assert.ok(stepBlock(html, 'bare-node').includes('bare-node'));
});

test('the returned fragment is an ordered list, with no <html>/<head> wrapper', async () => {
  const { renderMapDocument } = await loadMapDocument();

  const html = renderMapDocument({ nodes: [{ id: 'solo', node_type: 'work' }] });

  assert.match(html, /^<ol[ >]/);
  assert.ok(!/<html[ >]/i.test(html));
  assert.ok(!/<head[ >]/i.test(html));
});
