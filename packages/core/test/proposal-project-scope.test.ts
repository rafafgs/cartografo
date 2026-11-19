/**
 * Acceptance tests of the project scope of apply, revert and outcome (t1331, #5).
 *
 * t412 made every proposal route resolve a project and fixed `create()`, but
 * what `apply`, `revert` and `outcome` do AFTER the proposal is loaded kept
 * reading the graph lineage, the versions, the skill registry and the execution
 * metrics in the default project. So a proposal that lives in project 2 could be
 * created and approved, and then answered `stale_proposal` (a graph both
 * projects hold, at different versions) or `unknown_graph` (a graph only
 * project 2 holds).
 *
 * Every fixture here is built so that the unscoped read gives a DIFFERENT answer
 * from the scoped one — a different base, a missing graph, an identical
 * snapshot, a skill registered on one side only — which is what makes each case
 * a real red before the fix and not a coincidence of both projects looking the
 * same.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as OperationsModule from '../src/domain/operations.ts';
import type * as ServerModule from '../src/server.ts';
import { manifestHash } from '../src/domain/manifest.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';
import { resolvePinsOver } from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Graph {
  id: string;
  current_version_id: string | null;
}

interface GraphVersion {
  id: string;
  project_id?: number;
}

interface Proposal {
  id: number;
  project_id: number;
  status: string;
  applied_version_id: string | null;
}

interface Answer {
  status: number;
  body: Record<string, unknown> & {
    error?: string;
    code?: string;
    proposal?: Proposal;
    graph?: Graph;
    graph_version?: GraphVersion;
  };
}

/* ------------------------------------------------------------------ harness */

async function startApp(t: TestHook): Promise<string> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'routes', 'proposals.ts')),
    'artifact does not exist yet: packages/core/src/routes/proposals.ts',
  );

  const { openDatabase, applyPragmas } = (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  const { migrate } = (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  const { createApp } = (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ServerModule;
  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1331-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);
  const { token } = issueCredential(db, { type: 'user' });

  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  authorizeGlobalFetch(t, { baseUrl: address, token });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
  return address;
}

async function send(
  address: string,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${address}${route}`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Answer['body'] };
}

const post = (address: string, route: string, body?: unknown): Promise<Answer> =>
  send(address, 'POST', route, body);
const get = (address: string, route: string): Promise<Answer> => send(address, 'GET', route);

/** `?project_id=N`, or nothing for the unscoped call. */
function scope(projectId: number | undefined): string {
  return projectId === undefined ? '' : `?project_id=${projectId}`;
}

async function declareProject(address: string, name: string): Promise<number> {
  const answer = await post(address, '/v1/projects', { name });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return answer.body.id as number;
}

/* ----------------------------------------------------------------- fixtures */

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

/** A registrable manifest with a pin computed over what it carries. */
function manifest(id: string, version: string, instructions: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id,
    version,
    hash: '',
    role: 'work',
    description: `fixture skill "${id}" of the t1331 cases`,
    input: { type: 'object' },
    output: { type: 'object' },
    preconditions: [],
    checks: [
      {
        id: 'fixture-check',
        type: 'deterministic',
        description: 'The note exists and is not empty.',
        command: 'test -s nota.md',
      },
    ],
    permissions: { filesystem: { read: [], write: [] }, network: { allowed: false } },
    instructions,
    origin: { type: 'native' },
  };
  body.hash = manifestHash(body);
  return body;
}

const ADDED_NODE_SKILL = manifest('checar-fatos', '1.0.0', 'The skill of the node the proposals add.');

function pinOf(skill: Record<string, unknown>): { id: string; version: string; hash: string } {
  return {
    id: skill.id as string,
    version: skill.version as string,
    hash: skill.hash as string,
  };
}

/** Registers one manifest in one project, through the public route. */
async function registerSkill(
  address: string,
  projectId: number,
  skill: Record<string, unknown>,
): Promise<{ id: string; version: string; hash: string }> {
  const answer = await post(address, `/v1/skills${scope(projectId)}`, skill);
  assert.ok(answer.status === 201 || answer.status === 200, JSON.stringify(answer.body));
  return pinOf(skill);
}

/**
 * Registers a graph in one project, with every pin it carries — and the pin of
 * the node the proposals add — resolvable in THAT project's registry.
 */
async function registerGraph(
  address: string,
  projectId: number,
  edit: (document: GraphDocument) => void = () => undefined,
): Promise<{ document: GraphDocument; graph: Graph; version: GraphVersion }> {
  const document = minimalGraph();
  edit(document);
  await resolvePinsOver(document as unknown as Record<string, unknown>, {
    get: async (routePath) => ({
      status: (await get(address, `${routePath}&project_id=${projectId}`)).status,
    }),
    post: async (routePath, body) => ({
      status: (await post(address, `${routePath}${scope(projectId)}`, body)).status,
    }),
  });
  await registerSkill(address, projectId, ADDED_NODE_SKILL);

  const answer = await post(address, `/v1/graphs${scope(projectId)}`, document);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return {
    document,
    graph: answer.body.graph as Graph,
    version: answer.body.graph_version as GraphVersion,
  };
}

/** The node the proposals add, between `redigir` and `revisar`. */
function newNode(): GraphNode {
  return {
    id: 'checar_fatos',
    role: 'revisor',
    node_type: 'work',
    description: 'Checks each claim of the note against the cited source.',
    skill_ref: pinOf(ADDED_NODE_SKILL),
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

function addNodeOperations(): OperationsModule.Operation[] {
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

/** Moves the skill pin of `revisar`, the node every fixture has. */
function movePin(from: unknown, to: unknown): OperationsModule.Operation {
  return {
    type: 'change_node_field',
    node_id: 'revisar',
    field: 'skill_ref',
    from,
    to,
    inverse: { type: 'change_node_field', node_id: 'revisar', field: 'skill_ref', from: to, to: from },
  } as OperationsModule.Operation;
}

function pinOfRevisar(document: GraphDocument): unknown {
  const node = document.nodes.find((candidate) => candidate.id === 'revisar');
  assert.ok(node !== undefined, 'the fixture changed: node "revisar" is gone');
  return node.skill_ref;
}

const EVIDENCE = { fonte: 'telemetry', observacao: 'two crossings with rework after the review' };
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

async function createProposal(
  address: string,
  projectId: number | undefined,
  graphId: string,
  targetVersion: string,
  operations: OperationsModule.Operation[],
): Promise<Proposal> {
  const answer = await post(address, `/v1/proposals${scope(projectId)}`, {
    graph_id: graphId,
    target_version: targetVersion,
    operations,
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return answer.body.proposal as Proposal;
}

async function approve(address: string, projectId: number | undefined, id: number): Promise<void> {
  const answer = await post(address, `/v1/proposals/${id}/approve${scope(projectId)}`, {});
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
}

/** Approves and applies, handing back the apply answer for the caller to judge. */
async function applyIn(
  address: string,
  projectId: number | undefined,
  id: number,
): Promise<Answer> {
  await approve(address, projectId, id);
  return await post(address, `/v1/proposals/${id}/apply${scope(projectId)}`, {});
}

/** Creates, approves and applies; the apply has to be a 200. */
async function applied(
  address: string,
  projectId: number | undefined,
  graphId: string,
  targetVersion: string,
  operations: OperationsModule.Operation[],
): Promise<{ proposal: Proposal; version: string }> {
  const proposal = await createProposal(address, projectId, graphId, targetVersion, operations);
  const answer = await applyIn(address, projectId, proposal.id);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const written = answer.body.proposal;
  assert.ok(written?.applied_version_id, JSON.stringify(answer.body));
  return { proposal: written, version: written.applied_version_id };
}

async function graphOf(address: string, projectId: number, id: string): Promise<Graph> {
  const answer = await get(address, `/v1/graphs/${encodeURIComponent(id)}${scope(projectId)}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body.graph as Graph;
}

async function versionIds(address: string, projectId: number, id: string): Promise<string[]> {
  const answer = await get(address, `/v1/graphs/${encodeURIComponent(id)}/versions${scope(projectId)}`);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return (answer.body.versions as GraphVersion[]).map((version) => version.id);
}

/** Two projects holding the SAME graph at the SAME version, skills included. */
async function twins(
  t: TestHook,
): Promise<{ address: string; graph: Graph; base: string; document: GraphDocument }> {
  const address = await startApp(t);
  assert.equal(await declareProject(address, 'second'), 2);
  const first = await registerGraph(address, 1);
  const second = await registerGraph(address, 2);
  assert.equal(second.version.id, first.version.id, 'the hash is the content, so it is the same');
  return { address, graph: first.graph, base: first.version.id, document: first.document };
}

/** Work recorded under a version, in one project: what the outcome route demands. */
async function recordWork(
  address: string,
  projectId: number,
  executionId: number,
  versionId: string,
): Promise<void> {
  const answer = await post(address, '/v1/jobs', {
    title: 'crossing of the next round',
    entry_node_id: 'redigir',
    execution_id: executionId,
    graph_version_id: versionId,
    project_id: projectId,
  });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
}

/** A description edit: the same graph, a different version hash. */
function describedDifferently(document: GraphDocument): void {
  document.nodes[0].description = 'A different description, so a different snapshot hash.';
}

/* ------------------------------------------------------------------- apply */

test('AT1 — a project-2 proposal applies against project 2’s base, not project 1’s', async (t) => {
  const address = await startApp(t);
  assert.equal(await declareProject(address, 'second'), 2);
  const first = await registerGraph(address, 1);
  const second = await registerGraph(address, 2, describedDifferently);
  assert.notEqual(second.version.id, first.version.id, 'the two projects hold different versions');

  const proposal = await createProposal(
    address,
    2,
    second.graph.id,
    second.version.id,
    addNodeOperations(),
  );
  const answer = await applyIn(address, 2, proposal.id);

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.notEqual(answer.body.error, 'stale_proposal');
  const written = answer.body.graph_version;
  assert.ok(written !== undefined);
  assert.equal(answer.body.graph?.current_version_id, written.id);
  assert.equal((await graphOf(address, 2, second.graph.id)).current_version_id, written.id);

  const read = await get(address, `/v1/graph-versions/${encodeURIComponent(written.id)}?project_id=2`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(
    (read.body.graph_version as GraphVersion).project_id,
    2,
    'the version was written into the proposal’s own project',
  );

  await t.test('AT2 — project 1 is untouched', async () => {
    const mine = await graphOf(address, 1, first.graph.id);
    assert.equal(mine.current_version_id, first.version.id);
    assert.deepEqual(await versionIds(address, 1, first.graph.id), [first.version.id]);
  });
});

test('AT3 — a graph only project 2 holds is not an unknown graph', async (t) => {
  const address = await startApp(t);
  assert.equal(await declareProject(address, 'second'), 2);
  const second = await registerGraph(address, 2);
  assert.equal((await get(address, `/v1/graphs/${second.graph.id}?project_id=1`)).status, 404);

  const proposal = await createProposal(
    address,
    2,
    second.graph.id,
    second.version.id,
    addNodeOperations(),
  );
  const answer = await applyIn(address, 2, proposal.id);

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.proposal?.status, 'applied');
  assert.equal((await get(address, `/v1/graphs/${second.graph.id}?project_id=1`)).status, 404);
});

test('AT4 — the no-effect check looks at the proposal’s own project', async (t) => {
  const { address, graph, base } = await twins(t);

  // Project 1 comes to hold the version the operations produce, and then moves
  // back to the base: the version is in its lineage, but not its current one.
  const inFirst = await applied(address, 1, graph.id, base, addNodeOperations());
  const reverted = await post(address, `/v1/proposals/${inFirst.proposal.id}/revert?project_id=1`, {
    reason: 'set up the fixture',
  });
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
  assert.equal((await graphOf(address, 1, graph.id)).current_version_id, base);

  // Project 2 never held it, so for project 2 this is a new version.
  const proposal = await createProposal(address, 2, graph.id, base, addNodeOperations());
  const answer = await applyIn(address, 2, proposal.id);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.notEqual(answer.body.error, 'version_without_effect');
  assert.equal(answer.body.graph_version?.id, inFirst.version);

  // And in project 1 the very same operations ARE a proposal with no effect.
  const again = await createProposal(address, 1, graph.id, base, addNodeOperations());
  const refused = await applyIn(address, 1, again.id);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'version_without_effect');
});

test('AT5 — a skill pin is judged in the registry of the proposal’s project', async (t) => {
  const { address, graph, base, document } = await twins(t);
  const pinned = pinOfRevisar(document);

  await t.test('a pin registered only in project 2 applies in project 2', async () => {
    const only2 = await registerSkill(address, 2, manifest('revisar-nota', '2.0.0', 'Only in two.'));
    const proposal = await createProposal(address, 2, graph.id, base, [movePin(pinned, only2)]);
    const answer = await applyIn(address, 2, proposal.id);

    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.proposal?.status, 'applied');
  });

  await t.test('a pin registered only in project 1 is refused in project 2', async () => {
    // Project 2 moved on, so this proposal is written against its new version.
    const current = (await graphOf(address, 2, graph.id)).current_version_id;
    assert.ok(current !== null);
    const only1 = await registerSkill(address, 1, manifest('revisar-nota', '3.0.0', 'Only in one.'));
    const from = pinOfRevisar(
      (
        (await get(address, `/v1/graph-versions/${encodeURIComponent(current)}?project_id=2`)).body
          .graph_version as { snapshot: GraphDocument }
      ).snapshot,
    );
    const proposal = await createProposal(address, 2, graph.id, current, [movePin(from, only1)]);
    const answer = await applyIn(address, 2, proposal.id);

    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.equal(answer.body.error, 'unregistered_skill_pin');
    assert.equal(answer.body.code, 'skill_version_not_registered');
    assert.equal((await graphOf(address, 2, graph.id)).current_version_id, current);
  });
});

/* ------------------------------------------------------------ revert, outcome */

test('AT6 — revert moves project 2’s pointer and leaves project 1 alone', async (t) => {
  const { address, graph, base } = await twins(t);
  const { proposal, version } = await applied(address, 2, graph.id, base, addNodeOperations());
  assert.equal((await graphOf(address, 2, graph.id)).current_version_id, version);

  const answer = await post(address, `/v1/proposals/${proposal.id}/revert?project_id=2`, {
    reason: 'the experiment did not pan out',
  });

  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.proposal?.status, 'reverted');
  assert.equal(answer.body.graph?.current_version_id, base, 'the previous project-2 version');
  assert.equal((await graphOf(address, 2, graph.id)).current_version_id, base);
  assert.equal((await graphOf(address, 1, graph.id)).current_version_id, base);
  assert.deepEqual(await versionIds(address, 1, graph.id), [base]);
});

test('AT7 — the outcome counts only the work of the proposal’s own project', async (t) => {
  await t.test('work under the version in project 2 closes the experiment', async (inner) => {
    const { address, graph, base } = await twins(inner);
    const { proposal, version } = await applied(address, 2, graph.id, base, addNodeOperations());
    await recordWork(address, 2, 7, version);

    const answer = await post(address, `/v1/proposals/${proposal.id}/outcome?project_id=2`, {
      execucao_id: 7,
      depois: 0.1,
    });

    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.ok(answer.body.proposal?.status === 'applied');
  });

  await t.test('work only in project 1 is no evidence for a project-2 proposal', async (inner) => {
    const { address, graph, base } = await twins(inner);
    const { proposal, version } = await applied(address, 2, graph.id, base, addNodeOperations());

    // Project 1 ends up holding the very same version (same content, same
    // hash) and the only job under it, in the very same execution.
    const mine = await applied(address, 1, graph.id, base, addNodeOperations());
    assert.equal(mine.version, version);
    await recordWork(address, 1, 7, version);

    const answer = await post(address, `/v1/proposals/${proposal.id}/outcome?project_id=2`, {
      execucao_id: 7,
      depois: 0.1,
    });

    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.equal(answer.body.error, 'execution_without_evidence');
  });
});

/* ------------------------------------------------------------ project 1 flow */

/** The whole project-1 lifecycle, with the project spelled the way the caller likes. */
async function lifecycle(
  t: TestHook,
  projectId: number | undefined,
): Promise<Array<{ step: string; status: number; body: unknown }>> {
  const address = await startApp(t);
  const { graph, version } = await registerGraph(address, 1);
  const seen: Array<{ step: string; status: number; body: unknown }> = [];
  const note = (step: string, answer: Answer): void => {
    seen.push({ step, status: answer.status, body: withoutTimestamps(answer.body) });
  };

  const proposal = await createProposal(address, projectId, graph.id, version.id, addNodeOperations());
  await approve(address, projectId, proposal.id);
  const done = await post(address, `/v1/proposals/${proposal.id}/apply${scope(projectId)}`, {});
  note('apply', done);
  const appliedVersion = done.body.proposal?.applied_version_id;
  assert.ok(typeof appliedVersion === 'string');

  await recordWork(address, 1, 3, appliedVersion);
  note(
    'outcome',
    await post(address, `/v1/proposals/${proposal.id}/outcome${scope(projectId)}`, {
      execucao_id: 3,
      depois: 0.1,
    }),
  );
  note(
    'revert',
    await post(address, `/v1/proposals/${proposal.id}/revert${scope(projectId)}`, { reason: 'checking' }),
  );
  note(
    'revert again',
    await post(address, `/v1/proposals/${proposal.id}/revert${scope(projectId)}`, { reason: 'twice' }),
  );
  return seen;
}

/** Drops every timestamp (`*_at`, and the verdict's `avaliado_em`): all two runs of one flow do not share. */
function withoutTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTimestamps);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.endsWith('_at') && key !== 'avaliado_em')
      .map(([key, inner]) => [key, withoutTimestamps(inner)]),
  );
}

test('AT8 — project 1 behaves the same with no project_id and with ?project_id=1', async (t) => {
  const unscoped = await lifecycle(t, undefined);
  const scoped = await lifecycle(t, 1);

  assert.deepEqual(
    unscoped.map(({ step, status }) => `${step}: ${status}`),
    ['apply: 200', 'outcome: 200', 'revert: 200', 'revert again: 409'],
  );
  assert.deepEqual(scoped, unscoped);
});
