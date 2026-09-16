/**
 * t583 — a proposal decision is attributed to whoever made it.
 *
 * Approve, reject, apply and revert are the human gate of principle 5, and until
 * this ticket none of them said WHICH human: approve and reject wrote no event at
 * all, and apply and revert recorded the control plane's own `API_ACTOR` whatever
 * the caller was. The four routes now accept an optional `actor` in the body,
 * resolved the way `repositories/job.ts` resolves one, and refuse an `agent`
 * outright — a decision the learning loop depends on cannot be a model's.
 *
 * AT5 is the screen's parity: a body with no `actor` answers exactly what it
 * answered before, and the event it now writes carries `API_ACTOR`.
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

const API_ACTOR = { type: 'system', ref: 'control-plane' };
const AGENT = { type: 'agent', ref: 'topografo' };

interface Graph {
  id: string;
  current_version_id: string | null;
}

interface GraphVersion {
  id: string;
}

interface Proposal {
  id: number;
  status: string;
  graph_id: string;
  target_version: string;
  applied_version_id: string | null;
}

const EVIDENCE = { fonte: 'telemetry', observacao: 'two crossings with rework' };
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

/** A new node, complete enough to pass `node_with_contract`. */
function newNode(): GraphNode {
  return {
    id: 'check_facts',
    role: 'reviewer',
    node_type: 'work',
    description: 'Checks each claim of the note against the cited source.',
    skill_ref: {
      id: 'cartografo/check-facts',
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
          command: 'test -s check.md',
          description: 'The check report exists and is not empty.',
        },
      ],
    },
  };
}

/** Inserts a node between redigir and revisar — a sound change that applies. */
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

/** Registers the base graph and opens one pending proposal over it. */
async function pendingProposal(ctx: TestContext): Promise<Proposal> {
  const registered = await request<{ graph: Graph; graph_version: GraphVersion }>(
    ctx,
    'POST',
    '/v1/graphs',
    minimalGraph(),
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const response = await request<{ proposal: Proposal }>(ctx, 'POST', '/v1/proposals', {
    graph_id: registered.body.graph.id,
    target_version: registered.body.graph_version.id,
    operations: passingOperations(),
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.proposal;
}

async function decide(
  ctx: TestContext,
  proposalId: number,
  verb: 'approve' | 'reject' | 'apply' | 'revert',
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await request<Record<string, unknown>>(
    ctx,
    'POST',
    `/v1/proposals/${proposalId}/${verb}`,
    body,
  );
}

/** A pending proposal walked to `approved`, with no actor. */
async function approvedProposal(ctx: TestContext): Promise<Proposal> {
  const proposal = await pendingProposal(ctx);
  const response = await decide(ctx, proposal.id, 'approve', {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return proposal;
}

/** An approved proposal walked to `applied`, with no actor; returns the new version id. */
async function appliedProposal(ctx: TestContext): Promise<{ proposal: Proposal; version: string }> {
  const proposal = await approvedProposal(ctx);
  const response = await decide(ctx, proposal.id, 'apply', {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { proposal, version: (response.body.graph_version as GraphVersion).id };
}

async function eventsOf(ctx: TestContext, versionId: string): Promise<Event[]> {
  const { getEventsByEntity } = await loadEvents();
  return getEventsByEntity(ctx.db, 'graph_version', versionId);
}

async function versionEvents(ctx: TestContext): Promise<Event[]> {
  const { listEvents } = await loadEvents();
  return listEvents(ctx.db).filter((event) => event.type.startsWith('graph_version.'));
}

async function statusOf(ctx: TestContext, proposalId: number): Promise<string> {
  const response = await request<{ proposal: Proposal }>(
    ctx,
    'GET',
    `/v1/proposals/${proposalId}`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.proposal.status;
}

test('t583 AT1 — approving records graph_version.proposal_approved with the actor', async (t) => {
  const ctx = await startControlPlane(t);
  const proposal = await pendingProposal(ctx);

  const response = await decide(ctx, proposal.id, 'approve', {
    actor: { type: 'user', ref: 'alice' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const approved = (await eventsOf(ctx, proposal.target_version)).filter(
    (event) => event.type === 'graph_version.proposal_approved',
  );
  assert.equal(approved.length, 1, 'approving writes exactly one event');
  assert.deepEqual(approved[0].actor, { type: 'user', ref: 'alice' });
  assert.deepEqual(approved[0].data, {
    graph_id: proposal.graph_id,
    proposal_id: proposal.id,
  });
});

test('t583 AT2 — rejecting records graph_version.proposal_rejected with the actor and reason', async (t) => {
  const ctx = await startControlPlane(t);
  const proposal = await pendingProposal(ctx);

  const response = await decide(ctx, proposal.id, 'reject', {
    reason: 'not worth it',
    actor: { type: 'user', ref: 'bob' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const rejected = (await eventsOf(ctx, proposal.target_version)).filter(
    (event) => event.type === 'graph_version.proposal_rejected',
  );
  assert.equal(rejected.length, 1, 'rejecting writes exactly one event');
  assert.deepEqual(rejected[0].actor, { type: 'user', ref: 'bob' });
  assert.equal(rejected[0].data.reason, 'not worth it');
  assert.deepEqual(rejected[0].data, {
    graph_id: proposal.graph_id,
    proposal_id: proposal.id,
    reason: 'not worth it',
  });
});

test('t583 AT3 — applying carries the supplied actor on registered and applied', async (t) => {
  const ctx = await startControlPlane(t);
  const proposal = await approvedProposal(ctx);

  const response = await decide(ctx, proposal.id, 'apply', {
    actor: { type: 'user', ref: 'carol' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const version = (response.body.graph_version as GraphVersion).id;

  const events = await eventsOf(ctx, version);
  assert.deepEqual(
    events.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
  );
  for (const event of events) {
    assert.deepEqual(event.actor, { type: 'user', ref: 'carol' }, event.type);
  }
});

test('t583 AT4 — reverting carries the supplied actor', async (t) => {
  const ctx = await startControlPlane(t);
  const { proposal, version } = await appliedProposal(ctx);

  const response = await decide(ctx, proposal.id, 'revert', {
    reason: 'the fact check doubled the crossing time',
    actor: { type: 'user', ref: 'dave' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const reverted = (await eventsOf(ctx, version)).filter(
    (event) => event.type === 'graph_version.reverted',
  );
  assert.equal(reverted.length, 1);
  assert.deepEqual(reverted[0].actor, { type: 'user', ref: 'dave' });
});

test('t583 AT5 — with no actor, all four routes answer as before and record API_ACTOR', async (t) => {
  const ctx = await startControlPlane(t);

  // approve
  const pending = await pendingProposal(ctx);
  const approved = await decide(ctx, pending.id, 'approve', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(Object.keys(approved.body).sort(), ['proposal']);
  assert.equal((approved.body.proposal as Proposal).status, 'approved');
  const approvedEvents = (await eventsOf(ctx, pending.target_version)).filter(
    (event) => event.type === 'graph_version.proposal_approved',
  );
  assert.equal(approvedEvents.length, 1);
  assert.deepEqual(approvedEvents[0].actor, API_ACTOR);

  // apply
  const applied = await decide(ctx, pending.id, 'apply', {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual(Object.keys(applied.body).sort(), ['graph', 'graph_version', 'proposal']);
  const version = (applied.body.graph_version as GraphVersion).id;
  const birth = await eventsOf(ctx, version);
  assert.deepEqual(
    birth.map((event) => event.type),
    ['graph_version.registered', 'graph_version.applied'],
  );
  for (const event of birth) assert.deepEqual(event.actor, API_ACTOR, event.type);

  // revert
  const reverted = await decide(ctx, pending.id, 'revert', { reason: 'rolled back' });
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
  assert.deepEqual(Object.keys(reverted.body).sort(), ['graph', 'proposal']);
  assert.equal((reverted.body.proposal as Proposal).status, 'reverted');
  const revertEvents = (await eventsOf(ctx, version)).filter(
    (event) => event.type === 'graph_version.reverted',
  );
  assert.equal(revertEvents.length, 1);
  assert.deepEqual(revertEvents[0].actor, API_ACTOR);

  // reject, on a second proposal over the same base
  const second = await request<{ proposal: Proposal }>(ctx, 'POST', '/v1/proposals', {
    graph_id: pending.graph_id,
    target_version: pending.target_version,
    operations: passingOperations().slice(0, 1),
    evidence: { ...EVIDENCE, observacao: 'a second, different hypothesis' },
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const rejected = await decide(ctx, second.body.proposal.id, 'reject', { reason: 'no' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.deepEqual(Object.keys(rejected.body).sort(), ['proposal']);
  assert.equal((rejected.body.proposal as Proposal).status, 'rejected');
  const rejectEvents = (await eventsOf(ctx, pending.target_version)).filter(
    (event) => event.type === 'graph_version.proposal_rejected',
  );
  assert.equal(rejectEvents.length, 1);
  assert.deepEqual(rejectEvents[0].actor, API_ACTOR);
  assert.equal(rejectEvents[0].data.proposal_id, second.body.proposal.id);
});

/** Asserts the refusal, the untouched status and the untouched graph_version log. */
async function assertAgentRefused(
  ctx: TestContext,
  proposalId: number,
  verb: 'approve' | 'reject' | 'apply' | 'revert',
  body: Record<string, unknown>,
): Promise<void> {
  const statusBefore = await statusOf(ctx, proposalId);
  const eventsBefore = await versionEvents(ctx);

  const response = await decide(ctx, proposalId, verb, { ...body, actor: AGENT });
  assert.equal(response.status, 400, `${verb}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error, 'agent_actor_not_allowed', verb);

  assert.equal(await statusOf(ctx, proposalId), statusBefore, `${verb} moved the status`);
  const eventsAfter = await versionEvents(ctx);
  assert.equal(eventsAfter.length, eventsBefore.length, `${verb} wrote an event`);
  assert.equal(eventsAfter.at(-1)?.id, eventsBefore.at(-1)?.id, `${verb} wrote an event`);
}

test('t583 AT6 — an agent actor is refused on all four routes, and nothing is written', async (t) => {
  const ctx = await startControlPlane(t);

  const pending = await pendingProposal(ctx);
  await assertAgentRefused(ctx, pending.id, 'approve', {});
  await assertAgentRefused(ctx, pending.id, 'reject', { reason: 'not worth it' });

  const approved = await decide(ctx, pending.id, 'approve', {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await assertAgentRefused(ctx, pending.id, 'apply', {});

  const applied = await decide(ctx, pending.id, 'apply', {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  await assertAgentRefused(ctx, pending.id, 'revert', { reason: 'rolled back' });
});

test('t583 — a bodyless POST to approve and apply still answers 200, as it did before', async (t) => {
  // Not only the screen calls these routes: the surveyor's e2e (t285) posts
  // approve with no body and no content-type at all. Declaring a body schema
  // would turn that into `400 invalid_body`.
  const ctx = await startControlPlane(t);
  const proposal = await pendingProposal(ctx);

  const approved = await request<{ proposal: Proposal }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/approve`,
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const applied = await request<{ proposal: Proposal }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/apply`,
  );
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.proposal.status, 'applied');
});
