/**
 * Acceptance tests of `cartografo proposals` (t584, D26): the CLI's own
 * read/decide surface over `/v1/proposals*`, closing the one thing the
 * terminal could not do — approve, apply, reject and revert a proposal —
 * now that t583 attributes those decisions to a real actor.
 *
 * Against a REAL control plane, through the real binary (`runCli`,
 * `startControlPlane` from `./cli-support.ts`), seeded through the public API
 * exactly as an operator would — the same posture `cli-reads.test.ts` and
 * `cli-status.test.ts` already take.
 *
 * AT2 needs one thing those suites never needed: a direct read of the event
 * log. The control plane here is a CHILD PROCESS (the CLI contract is exit
 * code + stdout + stderr, which only exists on a real process), so there is no
 * `ctx.db` to hand `loadEvents()` the way `proposal-decision-actor.test.ts`
 * does. What this file opens instead is a second connection to the very same
 * database FILE, whose path it chose when it started the control plane —
 * `getEventsByEntity`/`listEvents` read it the same way, they just get their
 * handle from `openDatabase` here rather than from an in-process `TestContext`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../src/db/connection.ts';
import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type { Operation } from '../src/domain/operations.ts';
import { loadEvents, type Event } from './support.ts';
import {
  REPO_ROOT,
  runCli,
  startControlPlane,
  temporaryArea,
  type RunningControlPlane,
} from './cli-support.ts';

const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

const EVIDENCE = { fonte: 'surveyor', observacao: 'two crossings with rework' };
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

interface Graph {
  id: string;
  current_version_id: string | null;
}

interface Proposal {
  id: number;
  status: string;
  graph_id: string;
  target_version: string;
  applied_version_id: string | null;
}

/** POSTs to the control plane and demands the status it promised. */
async function post<T>(
  plane: RunningControlPlane,
  route: string,
  body: unknown,
  expected = 201,
): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `POST ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** A direct GET of the control plane, for comparison against the CLI's own reads. */
async function get<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

/** A new node, complete enough to pass `node_with_contract` (mirrors t583's own fixture). */
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

/** Inserts a node between redigir and revisar — a sound change that applies cleanly. */
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
async function pendingProposal(plane: RunningControlPlane): Promise<Proposal> {
  const registered = await post<{ graph: Graph; graph_version: { id: string } }>(
    plane,
    '/v1/graphs',
    minimalGraph(),
  );
  const response = await post<{ proposal: Proposal }>(plane, '/v1/proposals', {
    graph_id: registered.graph.id,
    target_version: registered.graph_version.id,
    operations: passingOperations(),
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  return response.proposal;
}

/** A second, independent proposal over the SAME base — never a second `POST /v1/graphs`. */
async function secondProposal(plane: RunningControlPlane, over: Proposal): Promise<Proposal> {
  const response = await post<{ proposal: Proposal }>(plane, '/v1/proposals', {
    graph_id: over.graph_id,
    target_version: over.target_version,
    operations: passingOperations().slice(0, 1),
    evidence: { ...EVIDENCE, observacao: 'a second, different hypothesis' },
    expected_metric: EXPECTED_METRIC,
  });
  return response.proposal;
}

test(
  'AT1 — list, show, approve and apply a pending proposal from the CLI; GET /v1/graphs/:id reports the applied version as current',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t584-flow-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
    const proposal = await pendingProposal(plane);

    const list = await runCli(['proposals', 'list', '--url', plane.url], { token: plane.token });
    assert.equal(list.code, 0, `stderr:\n${list.stderr}`);
    assert.ok(
      list.stdout.includes(`#${proposal.id}  pending  ${proposal.graph_id}`),
      `no line for #${proposal.id} in:\n${list.stdout}`,
    );

    const show = await runCli(['proposals', 'show', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(show.code, 0, `stderr:\n${show.stderr}`);
    assert.match(show.stdout, new RegExp(`#${proposal.id}\\b`));
    assert.match(show.stdout, /\+ node "check_facts"/);

    const approve = await runCli(['proposals', 'approve', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(approve.code, 0, `stderr:\n${approve.stderr}`);

    const apply = await runCli(['proposals', 'apply', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(apply.code, 0, `stderr:\n${apply.stderr}`);

    const afterApply = await get<{ proposal: Proposal }>(plane, `/v1/proposals/${proposal.id}?project_id=1`);
    assert.equal(afterApply.proposal.status, 'applied');
    assert.ok(afterApply.proposal.applied_version_id !== null);

    const graph = await get<{ graph: Graph }>(plane, `/v1/graphs/${proposal.graph_id}?project_id=1`);
    assert.equal(graph.graph.current_version_id, afterApply.proposal.applied_version_id);
  },
);

test(
  'AT2 — approve --by and apply --by attribute the actor on the events they write',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t584-actor-');
    const databasePath = path.join(area, 'cartografo.db');
    const plane = await startControlPlane(t, { databasePath });
    const proposal = await pendingProposal(plane);

    const approve = await runCli(
      ['proposals', 'approve', String(proposal.id), '--by', 'alice', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(approve.code, 0, `stderr:\n${approve.stderr}`);

    const apply = await runCli(
      ['proposals', 'apply', String(proposal.id), '--by', 'alice', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(apply.code, 0, `stderr:\n${apply.stderr}`);

    const afterApply = await get<{ proposal: Proposal }>(plane, `/v1/proposals/${proposal.id}?project_id=1`);
    const version = afterApply.proposal.applied_version_id;
    assert.ok(version !== null);

    const { getEventsByEntity } = await loadEvents();
    const db = openDatabase(databasePath);
    try {
      const approved = (getEventsByEntity(db, 'graph_version', proposal.target_version) as Event[]).filter(
        (event) => event.type === 'graph_version.proposal_approved',
      );
      assert.equal(approved.length, 1, 'approving writes exactly one event');
      assert.deepEqual(approved[0].actor, { type: 'user', ref: 'alice' });

      const applied = (getEventsByEntity(db, 'graph_version', version as string) as Event[]).filter(
        (event) => event.type === 'graph_version.applied',
      );
      assert.equal(applied.length, 1, 'applying writes exactly one graph_version.applied event');
      assert.deepEqual(applied[0].actor, { type: 'user', ref: 'alice' });
    } finally {
      db.close();
    }
  },
);

test(
  'AT3 — reject with no --reason exits 2 and sends no request; apply on a pending proposal exits 1 with proposal_not_approved',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t584-guard-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
    const proposal = await pendingProposal(plane);

    const reject = await runCli(['proposals', 'reject', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(reject.code, 2);

    const stillPending = await get<{ proposal: Proposal }>(plane, `/v1/proposals/${proposal.id}?project_id=1`);
    assert.equal(stillPending.proposal.status, 'pending');

    const apply = await runCli(['proposals', 'apply', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(apply.code, 1);
    assert.match(apply.stderr, /proposal_not_approved/);
  },
);

test(
  'AT4 — revert after apply restores the previous current version; revert on a non-applied proposal exits 1',
  { timeout: 180_000 },
  async (t) => {
    const area = temporaryArea(t, 'cartografo-t584-revert-');
    const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
    const proposal = await pendingProposal(plane);

    const beforeGraph = await get<{ graph: Graph }>(plane, `/v1/graphs/${proposal.graph_id}?project_id=1`);
    const previousVersion = beforeGraph.graph.current_version_id;

    const approve = await runCli(['proposals', 'approve', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(approve.code, 0, `stderr:\n${approve.stderr}`);
    const apply = await runCli(['proposals', 'apply', String(proposal.id), '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(apply.code, 0, `stderr:\n${apply.stderr}`);

    const revert = await runCli(
      ['proposals', 'revert', String(proposal.id), '--reason', 'undoing the crossing', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(revert.code, 0, `stderr:\n${revert.stderr}`);

    const afterGraph = await get<{ graph: Graph }>(plane, `/v1/graphs/${proposal.graph_id}?project_id=1`);
    assert.equal(afterGraph.graph.current_version_id, previousVersion);

    const notApplied = await secondProposal(plane, proposal);
    const badRevert = await runCli(
      ['proposals', 'revert', String(notApplied.id), '--reason', 'no', '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(badRevert.code, 1);
    assert.match(badRevert.stderr, /proposal_not_applied/);
  },
);

test('AT5 — --json of list and show is exactly the wire body', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t584-json-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
  const proposal = await pendingProposal(plane);

  const directList = await get(plane, '/v1/proposals?project_id=1');
  const listJson = await runCli(['proposals', 'list', '--json', '--url', plane.url], { token: plane.token });
  assert.equal(listJson.code, 0, `stderr:\n${listJson.stderr}`);
  assert.deepEqual(JSON.parse(listJson.stdout), directList);

  const directShow = await get(plane, `/v1/proposals/${proposal.id}?project_id=1`);
  const showJson = await runCli(
    ['proposals', 'show', String(proposal.id), '--json', '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(showJson.code, 0, `stderr:\n${showJson.stderr}`);
  assert.deepEqual(JSON.parse(showJson.stdout), directShow);
});

test('AT6 — no verb, an unknown verb, and a flag a verb does not take all exit 2', { timeout: 60_000 }, async () => {
  const noVerb = await runCli(['proposals']);
  assert.equal(noVerb.code, 2);
  assert.match(noVerb.stderr, /needs a verb/);
  assert.match(noVerb.stderr, /run `cartografo --help` for usage/);

  const bogusVerb = await runCli(['proposals', 'bogus-verb', '1']);
  assert.equal(bogusVerb.code, 2);
  assert.match(bogusVerb.stderr, /run `cartografo --help` for usage/);

  const strayReason = await runCli(['proposals', 'approve', '1', '--reason', 'x']);
  assert.equal(strayReason.code, 2);
});
