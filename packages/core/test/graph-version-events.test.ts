/**
 * The graph half of t196: a version write and a pointer move leave a fact in the log.
 *
 * `specs/events/schemas/` declared `graph_version.registered`,
 * `.applied` and `.reverted` since t98, and until this ticket nobody called
 * `recordEvent` for any of the three — so the log, which is D15's join surface
 * between telemetry and the evolution of the graph, knew about jobs, sessions
 * and questions and about no graph mutation at all.
 *
 * What the four flows below pin is the PAIRING, which is the part a literal
 * reading of the taxonomy gets wrong. "Registering does not move the pointer"
 * (`specs/events/taxonomy.md`) is a statement about the two facts
 * being different, not about them never happening together: `registerBaseGraph`,
 * `forkVariant` and `applyProposal` each write a version AND move the pointer in
 * one transaction, so each of them owes the log both events. Reverting owes it
 * exactly one, because no version is written.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type { Operation } from '../src/domain/operations.ts';
import {
  PACKAGE_ROOT,
  loadEvents,
  request,
  startControlPlane,
  type Event,
  type TestContext,
} from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

/** A lineage, as `/v1` publishes it — only the fields these tests read. */
interface Graph {
  id: string;
  class: string;
  current_version_id: string | null;
}

/** A version, as `/v1` publishes it. */
interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
}

/** A proposal, as `/v1` publishes it — only the fields these tests read. */
interface Proposal {
  id: number;
  status: string;
  applied_version_id: string | null;
}

const EVIDENCE = { fonte: 'telemetry', observacao: 'two crossings with rework' };
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

/** Every `graph_version.*` event in the log, in the log's own order. */
async function versionEvents(ctx: TestContext): Promise<Event[]> {
  const { listEvents } = await loadEvents();
  return listEvents(ctx.db).filter((event) => event.type.startsWith('graph_version.'));
}

/** The events of one version, by entity — the join D15 promises. */
async function eventsOf(ctx: TestContext, versionId: string): Promise<Event[]> {
  const { getEventsByEntity } = await loadEvents();
  return getEventsByEntity(ctx.db, 'graph_version', versionId);
}

/** Registers the minimal base graph and returns the lineage and its first version. */
async function registerBase(ctx: TestContext): Promise<{ graph: Graph; version: GraphVersion }> {
  const response = await request<{ graph: Graph; graph_version: GraphVersion }>(
    ctx,
    'POST',
    '/v1/graphs',
    minimalGraph(),
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { graph: response.body.graph, version: response.body.graph_version };
}

/** Forks a variant out of a base lineage (D13). */
async function fork(
  ctx: TestContext,
  baseId: string,
  body: Record<string, unknown>,
): Promise<{ graph: Graph; version: GraphVersion }> {
  const response = await request<{ graph: Graph; graph_version: GraphVersion }>(
    ctx,
    'POST',
    `/v1/graphs/${baseId}/fork`,
    body,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { graph: response.body.graph, version: response.body.graph_version };
}

/** Opens a pending proposal over a version that exists. */
async function openProposal(
  ctx: TestContext,
  graphId: string,
  targetVersion: string,
  operations: Operation[],
): Promise<Proposal> {
  const response = await request<{ proposal: Proposal }>(ctx, 'POST', '/v1/proposals', {
    graph_id: graphId,
    target_version: targetVersion,
    operations,
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.proposal;
}

/** Walks a proposal through the human gate (t165): only an approved one applies. */
async function approve(ctx: TestContext, proposalId: number): Promise<void> {
  const response = await request<{ proposal: Proposal }>(
    ctx,
    'POST',
    `/v1/proposals/${proposalId}/approve`,
    {},
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

/** A new node, complete enough to pass `node_with_contract`. */
function newNode(): GraphNode {
  return {
    id: 'checar_fatos',
    role: 'revisor',
    node_type: 'work',
      description: 'Checks each claim of the note against the cited source.',
    skill_ref: {
      id: 'cartografo/checar-fatos',
      version: '1.0.0',
      hash: `sha256:${'0'.repeat(64)}`,
    },
    contract: {
      input_schema: {
        type: 'object',
        required: ['texto'],
        properties: { texto: { type: 'string', minLength: 1 } },
      },
      output_schema: {
        type: 'object',
        required: ['aprovado'],
        properties: { aprovado: { type: 'boolean' } },
      },
      checks: [
        {
          type: 'deterministic',
          command: 'test -s checagem.md',
          description: 'The check report exists and is not empty.',
        },
      ],
    },
  };
}

/**
 * Inserts `checar_fatos` BETWEEN redigir and revisar: one incoming edge (so it is
 * reachable) and one outgoing edge (so it terminates) — the two conditions
 * soundness demands of any new node.
 */
function passingOperations(): Operation[] {
  const node = newNode();
  return [
    { type: 'add_node', node, inverse: { type: 'remove_node', node_id: node.id } },
    {
      type: 'add_edge',
      edge: { from: 'redigir', to: node.id, condition: 'sempre' },
      inverse: { type: 'remove_edge', edge: { from: 'redigir', to: node.id } },
    },
    {
      type: 'add_edge',
      edge: { from: node.id, to: 'revisar', condition: 'sempre' },
      inverse: { type: 'remove_edge', edge: { from: node.id, to: 'revisar' } },
    },
  ];
}

test('t196 AT1 — registering a base graph records registered and then applied', async (t) => {
  const ctx = await startControlPlane(t);
  const { graph, version } = await registerBase(ctx);

  const events = await versionEvents(ctx);
  assert.deepEqual(
    events.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
    'the lineage\'s first version is written AND starts to hold, in one transaction',
  );

  for (const event of events) {
    assert.deepEqual(
      event.entity,
      { type: 'graph_version', id: version.id },
      'the subject of both events is the version hash (D15)',
    );
    assert.equal(event.actor.type, 'system');
    assert.equal(event.project_id, 1);
  }

  assert.deepEqual(events[0].data, {
    graph_id: graph.id,
    parent_version: null,
    source: 'manual',
    proposal_id: null,
  });
  assert.deepEqual(events[1].data, { graph_id: graph.id, proposal_id: null });
  assert.ok(events[0].id < events[1].id, 'registering is recorded before applying');
});

test('t196 AT2 — forking records the same pair, and the origin proposal rides in it', async (t) => {
  const ctx = await startControlPlane(t);
  const { graph, version } = await registerBase(ctx);

  const plain = await fork(ctx, graph.id, { id: 'nota-curta-time-a' });
  const plainEvents = await eventsOf(ctx, plain.version.id);
  assert.deepEqual(
    plainEvents.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
  );
  assert.deepEqual(plainEvents[0].data, {
    graph_id: plain.graph.id,
    parent_version: version.id,
    source: 'manual',
    proposal_id: null,
  });
  assert.deepEqual(plainEvents[1].data, { graph_id: plain.graph.id, proposal_id: null });

  // With an origin proposal the variant's first version comes FROM it, exactly
  // as `forkVariant` already derives the column pair it writes.
  const proposal = await openProposal(ctx, graph.id, version.id, passingOperations());
  const derived = await fork(ctx, graph.id, {
    id: 'nota-curta-time-b',
    origin_proposal_id: proposal.id,
  });
  const derivedEvents = await eventsOf(ctx, derived.version.id);
  assert.deepEqual(
    derivedEvents.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
  );
  assert.deepEqual(derivedEvents[0].data, {
    graph_id: derived.graph.id,
    parent_version: version.id,
    source: 'proposal',
    proposal_id: proposal.id,
  });
  assert.deepEqual(derivedEvents[1].data, {
    graph_id: derived.graph.id,
    proposal_id: proposal.id,
  });
});

test('t196 AT3 — applying a proposal records registered and applied for the new version', async (t) => {
  const ctx = await startControlPlane(t);
  const { graph, version } = await registerBase(ctx);
  const proposal = await openProposal(ctx, graph.id, version.id, passingOperations());
  await approve(ctx, proposal.id);

  const response = await request<{ graph_version: GraphVersion }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/apply`,
    {},
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const written = response.body.graph_version;

  const events = await eventsOf(ctx, written.id);
  assert.deepEqual(
    events.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
  );
  assert.deepEqual(events[0].data, {
    graph_id: graph.id,
    parent_version: version.id,
    source: 'proposal',
    proposal_id: proposal.id,
  });
  assert.deepEqual(events[1].data, { graph_id: graph.id, proposal_id: proposal.id });

  // The version that used to hold is not re-narrated: what changed is the
  // pointer, and the fact of it belongs to the version that took over.
  const before = await eventsOf(ctx, version.id);
  assert.deepEqual(
    before.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
    'applying on top of a version adds nothing to that version\'s own timeline',
  );
});

test('t196 AT4 — reverting records exactly one reverted, and no version is registered', async (t) => {
  const ctx = await startControlPlane(t);
  const { graph, version } = await registerBase(ctx);
  const proposal = await openProposal(ctx, graph.id, version.id, passingOperations());
  await approve(ctx, proposal.id);

  const applied = await request<{ graph_version: GraphVersion }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/apply`,
    {},
  );
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const abandoned = applied.body.graph_version.id;
  const before = (await versionEvents(ctx)).length;

  const reason = 'the fact check doubled the crossing time';
  const reverted = await request<{ proposal: Proposal }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/revert`,
    { reason },
  );
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body));

  const events = await versionEvents(ctx);
  assert.equal(events.length, before + 1, 'reverting writes no version, so it records one event');

  const last = events[events.length - 1];
  assert.equal(last.type, 'graph_version.reverted');
  assert.deepEqual(
    last.entity,
    { type: 'graph_version', id: abandoned },
    'the subject is the ABANDONED version — the one whose telemetry is now evidence',
  );
  assert.deepEqual(last.data, {
    graph_id: graph.id,
    target_version: version.id,
    reason,
  });
});

test('t196 AT5 — an apply refused at the gate records no graph_version event', async (t) => {
  const ctx = await startControlPlane(t);
  const { graph, version } = await registerBase(ctx);

  // Well formed enough to be created, and naming an edge the snapshot never
  // had: the refusal happens before any version is written.
  const proposal = await openProposal(ctx, graph.id, version.id, [
    {
      type: 'remove_edge',
      edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
      inverse: {
        type: 'add_edge',
        edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
      },
    },
  ]);
  await approve(ctx, proposal.id);
  const before = await versionEvents(ctx);

  const response = await request<{ error: string }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/apply`,
    {},
  );
  assert.equal(response.status, 422, JSON.stringify(response.body));
  assert.equal(response.body.error, 'inapplicable_operation');

  const after = await versionEvents(ctx);
  assert.deepEqual(
    after.map((event) => `${event.type}:${String(event.entity.id)}`),
    before.map((event) => `${event.type}:${String(event.entity.id)}`),
    'a rejected proposal leaves the graph timeline exactly as it was',
  );
  const graphAfter = await request<{ graph: Graph }>(ctx, 'GET', `/v1/graphs/${graph.id}`);
  assert.equal(graphAfter.body.graph.current_version_id, version.id);
});
