/**
 * Proposal route acceptance tests (t101, FR7/FR8/FR9).
 *
 * This is where the whole D15 cycle is proven — apply ops → validate soundness
 * on the result → write the new version → move the pointer, and rollback moving
 * the pointer back without erasing anything. The four rejection cases (AT14–AT17)
 * reproduce, through semantic operations, exactly the four counterexamples of
 * t96: the soundness gate has to reject the proposal BEFORE the new version
 * exists.
 *
 * Since t226 the JSON is English (`docs/spec/glossario-wire.md` §1) — with ONE
 * island that is deliberately not, and this file is where it is pinned. The
 * hypothesis vocabulary of `domain/hypothesis.ts` does not move: the outcome
 * route still takes `{execucao_id, depois}`, `?veredito=` still filters on
 * `confirmada`/`sem_efeito`/`piorou`, and what is inside `expected_metric` and
 * `result` is still `{nome, direcao, de, para}` and `{veredito, antes, depois,
 * execucao_id, avaliado_em}`. t226 renames the KEYS that carry those blobs and
 * not a byte of the blobs (FR5), because that format is out of D20's scope —
 * the glossary maps none of it, and `hypothesis.ts` documents the exemption.
 * The last test of this file asserts exactly that, so a later rename that reaches
 * in there has to break something on the way.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type * as HashModule from '../src/domain/hash.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as OperationsModule from '../src/domain/operations.ts';
import type * as ServerModule from '../src/server.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Graph {
  id: string;
  class: string;
  current_version_id: string | null;
}

interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
}

interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  operations: unknown[];
  evidence: unknown;
  /** The KEY is English; what is inside stays `{nome, direcao, de, para}` (FR5). */
  expected_metric: unknown;
  status: string;
  applied_version_id: string | null;
  revert_reason: string | null;
  rejection_reason: string | null;
  /** Same story: the key translates, the verdict shape inside does not (FR5). */
  result: unknown;
}

interface ApplyResponse {
  error?: string;
  proposal: Proposal;
  graph?: Graph;
  graph_version?: GraphVersion;
  soundness?: { valido: boolean; violacoes: Array<{ regra: string; alvo: unknown }> };
  estrutura?: { valido: boolean; erros: Array<{ codigo: string; alvo: unknown }> };
}

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;
let hashCache: typeof HashModule | null = null;
let operationsCache: typeof OperationsModule | null = null;

async function loadConnection(): Promise<typeof ConnectionModule> {
  connectionCache ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  return connectionCache;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  migrateCache ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  return migrateCache;
}

async function loadServer(): Promise<typeof ServerModule> {
  serverCache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ServerModule;
  return serverCache;
}

async function loadHash(): Promise<typeof HashModule> {
  hashCache ??= (await import(
    new URL('../src/domain/hash.ts', import.meta.url).href
  )) as typeof HashModule;
  return hashCache;
}

async function loadOperations(): Promise<typeof OperationsModule> {
  operationsCache ??= (await import(
    new URL('../src/domain/operations.ts', import.meta.url).href
  )) as typeof OperationsModule;
  return operationsCache;
}

async function startApp(t: TestHook): Promise<string> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'routes', 'proposals.ts')),
    'artifact does not exist yet: packages/core/src/routes/proposals.ts',
  );
  assert.ok(
    existsSync(path.join(MIGRATIONS_DIR, '0002_grafo_versao_proposta.sql')),
    'artifact does not exist yet: packages/core/migrations/0002_grafo_versao_proposta.sql',
  );

  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp } = await loadServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t101-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  // Every `/v1` route demands a credential since t124; this suite is about
  // the routes, so the harness issues one and presents it on every call.
  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
  const { token } = issueCredential(db, { tipo: 'user' });

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

async function post(address: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${address}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

function requireNode(doc: GraphDocument, id: string): GraphNode {
  const node = doc.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`the fixture changed: node "${id}" is gone`);
  return node;
}

/** Registers the minimal base graph and returns the freshly created lineage. */
async function registerBase(
  address: string,
): Promise<{ document: GraphDocument; graph: Graph; version: GraphVersion }> {
  const document = minimalGraph();
  const response = await post(address, '/v1/graphs', document);
  const body = await jsonBody<{ graph: Graph; graph_version: GraphVersion }>(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  return { document, graph: body.graph, version: body.graph_version };
}

async function getGraph(address: string, id: string): Promise<Graph> {
  const response = await fetch(`${address}/v1/graphs/${id}`);
  assert.equal(response.status, 200);
  return (await jsonBody<{ graph: Graph }>(response)).graph;
}

const EVIDENCE = {
  fonte: 'telemetria',
  observacao: 'duas travessias com retrabalho depois da revisão',
};
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

async function createProposal(
  address: string,
  graphId: string,
  targetVersion: string,
  operations: OperationsModule.Operation[],
  expectedMetric: unknown = EXPECTED_METRIC,
): Promise<Proposal> {
  const response = await post(address, '/v1/proposals', {
    graph_id: graphId,
    target_version: targetVersion,
    operations,
    evidence: EVIDENCE,
    expected_metric: expectedMetric,
  });
  const body = await jsonBody<{ proposal: Proposal }>(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.proposal;
}

/**
 * Walks a proposal through the human gate (t165, FR2/FR4).
 *
 * Every apply in this file goes through here now: since t165 the guard of
 * `apply` is `aprovada`, not `pendente`, so a test that applied a freshly
 * created proposal would be exercising a precondition the route no longer has.
 */
async function approve(address: string, proposalId: number): Promise<Proposal> {
  const response = await post(address, `/v1/proposals/${proposalId}/approve`, {});
  const body = await jsonBody<{ proposal: Proposal }>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.proposal.status, 'approved');
  return body.proposal;
}

/** Reads one proposal by id (t165, FR5). */
async function getProposal(address: string, id: number): Promise<Proposal> {
  const response = await fetch(`${address}/v1/proposals/${id}`);
  const body = await jsonBody<{ proposal: Proposal }>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.proposal;
}

/** A new node, complete enough to pass `no_com_contrato`. */
function newNode(): GraphNode {
  return {
    id: 'checar_fatos',
    role: 'revisor',
    node_type: 'trabalho',
    description: 'Confere cada afirmação da nota contra a fonte citada.',
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
          description: 'O relatório de checagem existe e não está vazio.',
        },
      ],
    },
  };
}

/**
 * Inserts `checar_fatos` BETWEEN redigir and revisar: one incoming edge (so it is
 * reachable) and one outgoing edge (so it terminates). Those are the two
 * conditions soundness demands of any new node — hence the two edges.
 */
function passingOperations(): OperationsModule.Operation[] {
  const node = newNode();
  return [
    {
      type: 'add_node',
      node,
      inverse: { type: 'remove_node', node_id: node.id },
    },
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

test('AT11 — applying a proposal creates a new version with the right parent and hash, and moves the pointer', async (t) => {
  const address = await startApp(t);
  const { hashSnapshot } = await loadHash();
  const { applyOperations } = await loadOperations();

  const { document, graph, version } = await registerBase(address);
  const operations = passingOperations();
  const proposal = await createProposal(address, graph.id, version.id, operations);
  assert.equal(proposal.status, 'pending', 'every proposal is born pending');
  await approve(address, proposal.id);

  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));

  const expected = hashSnapshot(applyOperations(document, operations));
  assert.ok(body.graph_version !== undefined);
  assert.equal(body.graph_version.id, expected, 'the version id is the hash of the resulting document');
  assert.equal(body.graph_version.parent_version, version.id, 'the new version points at the previous one');
  assert.equal(body.graph_version.source, 'proposal');
  assert.equal(body.graph_version.proposal_id, proposal.id);

  assert.equal(body.proposal.status, 'applied');
  assert.equal(body.proposal.applied_version_id, expected);

  const after = await getGraph(address, graph.id);
  assert.equal(after.current_version_id, expected, 'the pointer has to have moved');

  // The new snapshot is the document with the operations applied — not a diff.
  const newVersion = await fetch(`${address}/v1/graph-versions/${encodeURIComponent(expected)}`);
  const versionBody = await jsonBody<{ graph_version: { snapshot: GraphDocument } }>(newVersion);
  assert.deepEqual(versionBody.graph_version.snapshot, applyOperations(document, operations));
});

test('t167 — changing a node escalation_policy is a proposal, and it produces a version', async (t) => {
  const address = await startApp(t);

  const { document, graph, version } = await registerBase(address);
  assert.ok(
    !Object.hasOwn(requireNode(document, 'revisar'), 'escalation_policy'),
    'the base fixture declares nothing: absent is the default this ficha keeps',
  );

  const proposal = await createProposal(address, graph.id, version.id, [
    {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'escalation_policy',
      from: null,
      to: 'never',
      inverse: {
        type: 'change_node_field',
        node_id: 'revisar',
        field: 'escalation_policy',
        from: 'never',
        to: null,
      },
    },
  ]);
  await approve(address, proposal.id);

  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.graph_version !== undefined);
  assert.notEqual(
    body.graph_version.id,
    version.id,
    'changing a node policy is a new version, like any other node field',
  );
  assert.equal(body.graph_version.parent_version, version.id);

  const changed = await jsonBody<{ graph_version: { snapshot: GraphDocument } }>(
    await fetch(`${address}/v1/graph-versions/${encodeURIComponent(body.graph_version.id)}`),
  );
  assert.equal(
    (requireNode(changed.graph_version.snapshot, 'revisar') as unknown as Record<string, unknown>)
      .escalation_policy,
    'never',
    'the new snapshot carries the declared policy',
  );

  // Append-only: the version somebody already ran under does not learn the new
  // policy retroactively (D15).
  const parent = await jsonBody<{ graph_version: { snapshot: GraphDocument } }>(
    await fetch(`${address}/v1/graph-versions/${encodeURIComponent(version.id)}`),
  );
  assert.deepEqual(
    parent.graph_version.snapshot,
    document,
    'the parent version has to be byte-for-byte what it always was',
  );
});

test('AT12 — reverting restores the pointer and the history stays whole', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());
  await approve(address, proposal.id);

  const application = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  assert.equal(application.status, 200);
  const newVersion = (await jsonBody<ApplyResponse>(application)).graph_version;
  assert.ok(newVersion !== undefined);

  const reversion = await post(address, `/v1/proposals/${proposal.id}/revert`, {
    reason: 'o nó novo dobrou o tempo de travessia sem mexer no retrabalho',
  });
  const body = await jsonBody<ApplyResponse>(reversion);
  assert.equal(reversion.status, 200, JSON.stringify(body));
  assert.equal(body.proposal.status, 'reverted');
  assert.equal(
    body.proposal.revert_reason,
    'o nó novo dobrou o tempo de travessia sem mexer no retrabalho',
  );

  const after = await getGraph(address, graph.id);
  assert.equal(after.current_version_id, version.id, 'the pointer goes back to the target version');

  const versions = await jsonBody<{ versions: GraphVersion[] }>(
    await fetch(`${address}/v1/graphs/${graph.id}/versions`),
  );
  assert.deepEqual(
    versions.versions.map((row) => row.id).sort(),
    [version.id, newVersion.id].sort(),
    'append-only: the abandoned version stays in the history',
  );

  // And it stays recoverable in full, not merely listed.
  const abandoned = await fetch(`${address}/v1/graph-versions/${encodeURIComponent(newVersion.id)}`);
  assert.equal(abandoned.status, 200);
});

test('AT13 — reverting without a reason returns 400; reverting a pending proposal returns 409', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const withoutReason = await post(address, `/v1/proposals/${proposal.id}/revert`, {});
  assert.equal(withoutReason.status, 400);
  assert.equal((await jsonBody<{ error: string }>(withoutReason)).error, 'reason_required');

  const blankReason = await post(address, `/v1/proposals/${proposal.id}/revert`, {
    reason: '   ',
  });
  assert.equal(blankReason.status, 400, 'a blank reason is not evidence');

  const pending = await post(address, `/v1/proposals/${proposal.id}/revert`, {
    reason: 'mudei de ideia',
  });
  assert.equal(pending.status, 409);
  assert.equal((await jsonBody<{ error: string }>(pending)).error, 'proposal_not_applied');

  const graphAfter = await getGraph(address, graph.id);
  assert.equal(graphAfter.current_version_id, version.id);
});

/**
 * AT14–AT17: one case per soundness rule, each reproducing through semantic
 * operations the counterexample of the same name in `schema/exemplos/` (t96).
 */
const REJECTION_CASES: Array<{
  at: string;
  counterexample: string;
  violations: Array<{ regra: string; alvo: unknown }>;
  operations: (document: GraphDocument) => OperationsModule.Operation[];
}> = [
  {
    at: 'AT14',
    counterexample: 'grafo-invalido-no-inalcancavel.json',
    violations: [{ regra: 'alcançável', alvo: 'checar_fatos' }],
    operations: () => {
      const node = newNode();
      // Only the OUTGOING edge: the node terminates, but nobody reaches it.
      return [
        { type: 'add_node', node, inverse: { type: 'remove_node', node_id: node.id } },
        {
          type: 'add_edge',
          edge: { from: node.id, to: 'revisar', condition: 'sempre' },
          inverse: { type: 'remove_edge', edge: { from: node.id, to: 'revisar' } },
        },
      ];
    },
  },
  {
    at: 'AT15',
    counterexample: 'grafo-invalido-sem-terminacao.json',
    violations: [{ regra: 'termina', alvo: 'checar_fatos' }],
    operations: () => {
      const node = newNode();
      // Only the INCOMING edge: the node is reached, but there is no way out.
      return [
        { type: 'add_node', node, inverse: { type: 'remove_node', node_id: node.id } },
        {
          type: 'add_edge',
          edge: { from: 'redigir', to: node.id, condition: 'sempre' },
          inverse: { type: 'remove_edge', edge: { from: 'redigir', to: node.id } },
        },
      ];
    },
  },
  {
    at: 'AT16',
    counterexample: 'grafo-invalido-aresta-sem-condicao.json',
    // The report's `alvo` keeps the frozen `de`/`para` pair even now that the
    // document says `from`/`to`: the 422 wire format did not move (t178).
    violations: [{ regra: 'aresta_com_condicao', alvo: { de: 'revisar', para: 'redigir' } }],
    // A legitimate rework cycle, but with no label on the transition.
    operations: () => [
      {
        type: 'add_edge',
        edge: { from: 'revisar', to: 'redigir', condition: '' },
        inverse: { type: 'remove_edge', edge: { from: 'revisar', to: 'redigir' } },
      },
    ],
  },
  {
    at: 'AT17',
    counterexample: 'grafo-invalido-no-sem-contrato.json',
    violations: [{ regra: 'no_com_contrato', alvo: 'revisar' }],
    // An emptied contract: with no checks, the gate verifies nothing.
    operations: (document) => [
      {
        type: 'change_node_field',
        node_id: 'revisar',
        field: 'contract',
        from: structuredClone(requireNode(document, 'revisar').contract),
        to: {},
        inverse: {
          type: 'change_node_field',
          node_id: 'revisar',
          field: 'contract',
          from: {},
          to: structuredClone(requireNode(document, 'revisar').contract),
        },
      },
    ],
  },
];

for (const rejectionCase of REJECTION_CASES) {
  test(`${rejectionCase.at} — a proposal reproducing ${rejectionCase.counterexample} is rejected with 422`, async (t) => {
    const address = await startApp(t);

    const { document, graph, version } = await registerBase(address);
    const proposal = await createProposal(
      address,
      graph.id,
      version.id,
      rejectionCase.operations(document),
    );
    await approve(address, proposal.id);

    const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
    const body = await jsonBody<ApplyResponse>(response);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.error, 'invalid_graph');
    assert.deepEqual(body.soundness?.violacoes, rejectionCase.violations);
    assert.equal(body.proposal.status, 'rejected');
    assert.deepEqual(
      (body.proposal.result as { soundness?: { violacoes: unknown } } | null)?.soundness
        ?.violacoes,
      rejectionCase.violations,
      'the report stays recorded in the proposal result',
    );

    const after = await getGraph(address, graph.id);
    assert.equal(after.current_version_id, version.id, 'the pointer must not have moved');

    const versions = await jsonBody<{ versions: GraphVersion[] }>(
      await fetch(`${address}/v1/graphs/${graph.id}/versions`),
    );
    assert.equal(versions.versions.length, 1, 'no new version can have been written');
  });
}

test('AT18 — a proposal whose target version stopped being the current one returns 409', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const first = await createProposal(address, graph.id, version.id, passingOperations());
  const second = await createProposal(address, graph.id, version.id, [
    {
      type: 'change_node_field',
      node_id: 'redigir',
      field: 'role',
      from: 'redator',
      to: 'red-team',
      inverse: {
        type: 'change_node_field',
        node_id: 'redigir',
        field: 'role',
        from: 'red-team',
        to: 'redator',
      },
    },
  ]);

  await approve(address, first.id);
  await approve(address, second.id);
  assert.equal((await post(address, `/v1/proposals/${first.id}/apply`, {})).status, 200);

  const outdated = await post(address, `/v1/proposals/${second.id}/apply`, {});
  assert.equal(outdated.status, 409);
  assert.equal(
    (await jsonBody<{ error: string }>(outdated)).error,
    'stale_proposal',
    'the base moved under the proposal; solving that belongs to the topographer (t118)',
  );
});

test('AT19 — applying the same proposal twice returns 409 on the second', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());
  await approve(address, proposal.id);

  assert.equal((await post(address, `/v1/proposals/${proposal.id}/apply`, {})).status, 200);

  const second = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  assert.equal(second.status, 409);
  assert.equal(
    (await jsonBody<{ error: string }>(second)).error,
    'proposal_not_approved',
    'since t165 the precondition of apply is `aprovada`, and the refusal says so',
  );
});

test('FR7 — a target version foreign to the graph and a malformed operation return 400', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);

  const missingTarget = await post(address, '/v1/proposals', {
    graph_id: graph.id,
    target_version: `sha256:${'1'.repeat(64)}`,
    operations: passingOperations(),
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(missingTarget.status, 400);
  assert.equal((await jsonBody<{ error: string }>(missingTarget)).error, 'unknown_target_version');

  const withoutInverse = await post(address, '/v1/proposals', {
    graph_id: graph.id,
    target_version: version.id,
    operations: [{ type: 'add_node', node: newNode() }],
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(withoutInverse.status, 400);
  assert.equal((await jsonBody<{ error: string }>(withoutInverse)).error, 'invalid_operations');

  const unknownType = await post(address, '/v1/proposals', {
    graph_id: graph.id,
    target_version: version.id,
    operations: [{ type: 'rename_node', node_id: 'redigir', inverse: { type: 'rename_node' } }],
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(unknownType.status, 400);

  const unknownGraph = await post(address, '/v1/proposals', {
    graph_id: 'nao-existe',
    target_version: version.id,
    operations: passingOperations(),
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(unknownGraph.status, 400);

  assert.equal((await post(address, '/v1/proposals/999/apply', {})).status, 404);
  assert.equal((await post(address, '/v1/proposals/999/revert', { reason: 'x' })).status, 404);
});

/* -------------------------------------------------------------------------- */
/* t228 — the operation vocabulary crosses the route in English (D20, §3).     */
/* -------------------------------------------------------------------------- */

test('t228 AT — POST /proposals takes English-keyed operations and refuses Portuguese-keyed ones', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);

  // The accepted half is the whole existing suite; what this pins is that the
  // OLD spelling stops working at the door. Stored proposals are not migrated
  // (D20: dev databases are recreated), so there is no dialect to fall back to.
  const node = newNode();
  const portuguese = await post(address, '/v1/proposals', {
    graph_id: graph.id,
    target_version: version.id,
    operations: [
      { tipo: 'adicionar_no', no: node, inversa: { tipo: 'remover_no', no_id: node.id } },
    ],
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(portuguese.status, 400);
  assert.equal((await jsonBody<{ error: string }>(portuguese)).error, 'invalid_operations');

  const english = await createProposal(address, graph.id, version.id, passingOperations());
  assert.equal(english.status, 'pending');
});

test('t228 AT — applying a remove_edge the snapshot does not have answers unknown_edge with English ends', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);

  // The operation is well formed (it passes `POST /proposals`) and simply names
  // an edge the target snapshot never had: that is the ApplicationError path,
  // and its `target` payload is the one §3 renames from `{de, para, condicao}`.
  const proposal = await createProposal(address, graph.id, version.id, [
    {
      type: 'remove_edge',
      edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
      inverse: {
        type: 'add_edge',
        edge: { from: 'revisar', to: 'redigir', condition: 'retrabalho' },
      },
    },
  ]);
  await approve(address, proposal.id);

  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<{ error: string; code: string; target: unknown }>(response);
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.equal(body.error, 'inapplicable_operation');
  assert.equal(body.code, 'unknown_edge');
  assert.deepEqual(body.target, { from: 'revisar', to: 'redigir', condition: 'retrabalho' });
});

test('t127 — the old Portuguese proposal paths no longer exist', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  assert.equal(
    (
      await post(address, '/v1/propostas', {
        graph_id: graph.id,
        target_version: version.id,
        operations: passingOperations(),
        evidence: EVIDENCE,
        expected_metric: EXPECTED_METRIC,
      })
    ).status,
    404,
  );
  assert.equal((await post(address, `/v1/propostas/${proposal.id}/aplicar`, {})).status, 404);
  assert.equal(
    (await post(address, `/v1/proposals/${proposal.id}/reverter`, { reason: 'x' })).status,
    404,
  );
});

/* -------------------------------------------------------------------------- */
/* t112 — hypothesis outcome: the next run closes the proposal                 */
/*                                                                            */
/* The route segments came in from main in Portuguese and were renamed with    */
/* the rest of the surface (t127, FR3); the JSON payload keys stay in          */
/* Portuguese, mirroring the untouched migration column (FR8).                 */
/* -------------------------------------------------------------------------- */

/** The shape `proposal.result` takes once the experiment is closed (FR5). */
interface HypothesisOutcome {
  veredito: string;
  antes: number;
  depois: number;
  execucao_id: number;
  avaliado_em: string;
}

/** Changes a node's `role`, so each proposal produces a distinct snapshot. */
function roleChange(role: string): OperationsModule.Operation[] {
  return [
    {
      type: 'change_node_field',
      node_id: 'redigir',
      field: 'role',
      from: 'redator',
      to: role,
      inverse: {
        type: 'change_node_field',
        node_id: 'redigir',
        field: 'role',
        from: role,
        to: 'redator',
      },
    },
  ];
}

/**
 * Registers real telemetry under a version, inside an execution.
 *
 * This is the evidence FR3 demands: `metrics-by-version` (t102, FR17) only sees
 * a version that actually ran because some job declared it.
 */
async function recordWorkUnderVersion(
  address: string,
  executionId: number,
  versionId: string,
): Promise<void> {
  const response = await post(address, '/v1/jobs', {
    title: 'travessia da rodada seguinte',
    entry_node_id: 'redigir',
    execution_id: executionId,
    graph_version_id: versionId,
  });
  assert.equal(response.status, 201, 'the next round telemetry has to exist for real');
}

/** Approves and applies a proposal, and returns the version it wrote. */
async function applyProposal(address: string, proposalId: number): Promise<string> {
  await approve(address, proposalId);
  const response = await post(address, `/v1/proposals/${proposalId}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.proposal.applied_version_id !== null);
  return body.proposal.applied_version_id;
}

/** The whole prelude of the outcome route: base, applied proposal, telemetry. */
async function appliedProposalWithTelemetry(
  t: TestHook,
  options: { executionId?: number; expectedMetric?: unknown } = {},
): Promise<{
  address: string;
  graph: Graph;
  targetVersion: string;
  proposal: Proposal;
  appliedVersion: string;
  executionId: number;
}> {
  const address = await startApp(t);
  const executionId = options.executionId ?? 1;

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(
    address,
    graph.id,
    version.id,
    passingOperations(),
    options.expectedMetric ?? EXPECTED_METRIC,
  );
  const appliedVersion = await applyProposal(address, proposal.id);
  await recordWorkUnderVersion(address, executionId, appliedVersion);

  return { address, graph, targetVersion: version.id, proposal, appliedVersion, executionId };
}

/** Reads the listing route, with the querystring already assembled. */
async function listProposals(address: string, query = ''): Promise<Proposal[]> {
  const response = await fetch(`${address}/v1/proposals${query}`);
  const body = await jsonBody<{ proposals: Proposal[] }>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.proposals;
}

test('AT20 — a metric that moved in the declared direction closes the hypothesis as confirmada', async (t) => {
  const scenario = await appliedProposalWithTelemetry(t);

  const response = await post(
    scenario.address,
    `/v1/proposals/${scenario.proposal.id}/outcome`,
    { execucao_id: scenario.executionId, depois: 0.1 },
  );
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));

  const outcome = body.proposal.result as HypothesisOutcome;
  assert.equal(outcome.veredito, 'confirmada');
  assert.equal(outcome.antes, 0.4, 'the "antes" is the `de` the proposal declared');
  assert.equal(outcome.depois, 0.1);
  assert.equal(outcome.execucao_id, scenario.executionId);
  assert.equal(typeof outcome.avaliado_em, 'string');

  assert.equal(body.proposal.status, 'applied', 'closing the experiment does not change the state');
  assert.equal(body.proposal.applied_version_id, scenario.appliedVersion);
});

test('AT21 — a metric that did not move is sem_efeito', async (t) => {
  const scenario = await appliedProposalWithTelemetry(t);

  const response = await post(
    scenario.address,
    `/v1/proposals/${scenario.proposal.id}/outcome`,
    { execucao_id: scenario.executionId, depois: 0.4 },
  );
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal((body.proposal.result as HypothesisOutcome).veredito, 'sem_efeito');
  assert.equal(body.proposal.status, 'applied');
});

test('AT22 — a metric that moved the wrong way is piorou, and nothing is reverted', async (t) => {
  const scenario = await appliedProposalWithTelemetry(t);

  const response = await post(
    scenario.address,
    `/v1/proposals/${scenario.proposal.id}/outcome`,
    { execucao_id: scenario.executionId, depois: 0.9 },
  );
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal((body.proposal.result as HypothesisOutcome).veredito, 'piorou');

  // "piorou" is data, never an action: reverting stays a human decision.
  assert.equal(body.proposal.status, 'applied');
  assert.equal(body.proposal.applied_version_id, scenario.appliedVersion);
  const graph = await getGraph(scenario.address, scenario.graph.id);
  assert.equal(
    graph.current_version_id,
    scenario.appliedVersion,
    'the pointer cannot have moved back',
  );
});

test('AT23 — only the first outcome counts; the second call is 409 and changes nothing', async (t) => {
  const scenario = await appliedProposalWithTelemetry(t);
  const route = `/v1/proposals/${scenario.proposal.id}/outcome`;

  const first = await post(scenario.address, route, {
    execucao_id: scenario.executionId,
    depois: 0.1,
  });
  assert.equal(first.status, 200);
  const written = (await jsonBody<ApplyResponse>(first)).proposal.result as HypothesisOutcome;

  const second = await post(scenario.address, route, {
    execucao_id: scenario.executionId,
    depois: 0.9,
  });
  assert.equal(second.status, 409);
  assert.equal((await jsonBody<{ error: string }>(second)).error, 'proposal_already_reviewed');

  const [stored] = await listProposals(scenario.address);
  assert.deepEqual(
    stored.result,
    written,
    'the second call cannot rewrite the first round outcome',
  );
});

test('AT24 — a proposal that is not aplicada cannot have an outcome', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const pending = await createProposal(address, graph.id, version.id, passingOperations());

  const response = await post(address, `/v1/proposals/${pending.id}/outcome`, {
    execucao_id: 1,
    depois: 0.1,
  });
  assert.equal(response.status, 409);
  assert.equal((await jsonBody<{ error: string }>(response)).error, 'proposal_not_applied');

  assert.equal(
    (await post(address, '/v1/proposals/999/outcome', { execucao_id: 1, depois: 0.1 })).status,
    404,
  );
});

test('AT25 — an execution with no telemetry under the applied version is refused', async (t) => {
  const scenario = await appliedProposalWithTelemetry(t, { executionId: 1 });
  const route = `/v1/proposals/${scenario.proposal.id}/outcome`;

  const noJob = await post(scenario.address, route, { execucao_id: 99, depois: 0.1 });
  assert.equal(noJob.status, 422);
  assert.equal((await jsonBody<{ error: string }>(noJob)).error, 'execution_without_evidence');

  // An execution that ran, but under the PREVIOUS version, is not evidence for
  // this proposal either: the join is by version, not by execution.
  await recordWorkUnderVersion(scenario.address, 2, scenario.targetVersion);
  const otherVersion = await post(scenario.address, route, { execucao_id: 2, depois: 0.1 });
  assert.equal(otherVersion.status, 422);
  assert.equal((await jsonBody<{ error: string }>(otherVersion)).error, 'execution_without_evidence');

  const [proposal] = await listProposals(scenario.address);
  assert.equal(proposal.result, null, 'nothing can have been written');
});

test('AT26 — a proposal whose expected_metric has no shape gets no verdict', async (t) => {
  const scenario = await appliedProposalWithTelemetry(t, {
    expectedMetric: { nome: 'retrabalho_por_travessia', de: 0.4, para: 0.1 },
  });

  const response = await post(
    scenario.address,
    `/v1/proposals/${scenario.proposal.id}/outcome`,
    { execucao_id: scenario.executionId, depois: 0.1 },
  );
  assert.equal(response.status, 422);
  assert.equal((await jsonBody<{ error: string }>(response)).error, 'invalid_expected_metric');

  const [proposal] = await listProposals(scenario.address);
  assert.equal(proposal.result, null, 'a verdict over incomplete data is not written');
});

test('AT27 — the reversal-suggestion queue is a filtered read over the proposals', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);

  // A: applied and piorou — the reversal-suggestion queue is exactly this one.
  const a = await createProposal(address, graph.id, version.id, passingOperations());
  const versionA = await applyProposal(address, a.id);
  await recordWorkUnderVersion(address, 1, versionA);
  assert.equal(
    (await post(address, `/v1/proposals/${a.id}/outcome`, { execucao_id: 1, depois: 0.9 })).status,
    200,
  );

  // B: piorou as well, but already reverted by a human decision — out of the queue.
  const b = await createProposal(address, graph.id, versionA, roleChange('red-team'));
  const versionB = await applyProposal(address, b.id);
  await recordWorkUnderVersion(address, 2, versionB);
  assert.equal(
    (await post(address, `/v1/proposals/${b.id}/outcome`, { execucao_id: 2, depois: 0.9 })).status,
    200,
  );
  assert.equal(
    (await post(address, `/v1/proposals/${b.id}/revert`, { reason: 'piorou de verdade' })).status,
    200,
  );

  // C: applied, but confirmada — a hypothesis that worked suggests nothing.
  const c = await createProposal(address, graph.id, versionA, roleChange('copidesque'));
  const versionC = await applyProposal(address, c.id);
  await recordWorkUnderVersion(address, 3, versionC);
  assert.equal(
    (await post(address, `/v1/proposals/${c.id}/outcome`, { execucao_id: 3, depois: 0.1 })).status,
    200,
  );

  // D: pending, with no outcome at all.
  const d = await createProposal(address, graph.id, versionC, roleChange('editor'));

  const queue = await listProposals(address, '?status=applied&veredito=piorou');
  assert.deepEqual(
    queue.map((proposal) => proposal.id),
    [a.id],
    'only the proposal that got worse AND is still applied',
  );

  const all = await listProposals(address);
  assert.deepEqual(
    all.map((proposal) => proposal.id),
    [a.id, b.id, c.id, d.id],
    'with no filter, every proposal in id order',
  );
  assert.deepEqual(
    all.map((proposal) => proposal.status),
    ['applied', 'reverted', 'applied', 'pending'],
  );

  assert.deepEqual(
    (await listProposals(address, '?veredito=confirmada')).map((proposal) => proposal.id),
    [c.id],
  );
  assert.deepEqual(
    (await listProposals(address, '?status=pending')).map((proposal) => proposal.id),
    [d.id],
  );
});

/* -------------------------------------------------------------------------- */
/* t165 — the human gate: pendente → aprovada → aplicada                       */
/*                                                                            */
/* The tela has offered `Aprovar`/`Rejeitar` since t111 against routes that    */
/* did not exist (`packages/tela/src/public/actions.js`), and `aprovada` — the */
/* only status from which it offers `Aplicar` — was not even in the            */
/* migration's CHECK. These are the two ends of that contract meeting.         */
/* -------------------------------------------------------------------------- */

test('t165 AT1 — approving a pending proposal moves it to approved', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const response = await post(address, `/v1/proposals/${proposal.id}/approve`, {});
  const body = await jsonBody<{ proposal: Proposal }>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.proposal.status, 'approved');
  assert.equal(body.proposal.applied_version_id, null, 'approving applies nothing by itself');
  assert.equal(body.proposal.result, null);

  // The pointer is where it was: the gate is a decision, not the application.
  assert.equal((await getGraph(address, graph.id)).current_version_id, version.id);
  assert.equal((await getProposal(address, proposal.id)).status, 'approved', 'and it is persisted');
});

test('t165 AT2 — approving anything that is not pending returns 409 proposal_not_pending', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());
  await approve(address, proposal.id);

  // Already approved.
  const twice = await post(address, `/v1/proposals/${proposal.id}/approve`, {});
  assert.equal(twice.status, 409);
  assert.equal((await jsonBody<{ error: string }>(twice)).error, 'proposal_not_pending');

  // Applied.
  assert.equal((await post(address, `/v1/proposals/${proposal.id}/apply`, {})).status, 200);
  const applied = await post(address, `/v1/proposals/${proposal.id}/approve`, {});
  assert.equal(applied.status, 409);
  assert.equal((await jsonBody<{ error: string }>(applied)).error, 'proposal_not_pending');
  assert.equal((await getProposal(address, proposal.id)).status, 'applied', 'nothing regressed');

  assert.equal((await post(address, '/v1/proposals/999/approve', {})).status, 404);
});

test('t165 AT3 — rejecting without a reason returns 400 and changes nothing', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const missing = await post(address, `/v1/proposals/${proposal.id}/reject`, {});
  assert.equal(missing.status, 400);
  assert.equal((await jsonBody<{ error: string }>(missing)).error, 'reason_required');

  const blank = await post(address, `/v1/proposals/${proposal.id}/reject`, { reason: '   ' });
  assert.equal(blank.status, 400, 'a blank reason is not a reason');
  assert.equal((await jsonBody<{ error: string }>(blank)).error, 'reason_required');

  const untouched = await getProposal(address, proposal.id);
  assert.equal(untouched.status, 'pending');
  assert.equal(untouched.rejection_reason, null);

  assert.equal((await post(address, '/v1/proposals/999/reject', { reason: 'x' })).status, 404);
});

test('t165 AT4 — rejecting with a reason writes rejection_reason and leaves result alone', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const reason = 'o nó novo repete a checagem que o portão de teste já faz';
  const response = await post(address, `/v1/proposals/${proposal.id}/reject`, { reason });
  const body = await jsonBody<{ proposal: Proposal }>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.proposal.status, 'rejected');
  assert.equal(body.proposal.rejection_reason, reason);
  assert.equal(
    body.proposal.result,
    null,
    'resultado stays reserved for the gate report and the hypothesis verdict',
  );

  // Rejected is terminal for the gate: neither approving nor applying it after.
  const late = await post(address, `/v1/proposals/${proposal.id}/approve`, {});
  assert.equal(late.status, 409);
  assert.equal((await jsonBody<{ error: string }>(late)).error, 'proposal_not_pending');

  const apply = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  assert.equal(apply.status, 409);
  assert.equal((await jsonBody<{ error: string }>(apply)).error, 'proposal_not_approved');

  const twice = await post(address, `/v1/proposals/${proposal.id}/reject`, { reason: 'de novo' });
  assert.equal(twice.status, 409);
  assert.equal((await jsonBody<{ error: string }>(twice)).error, 'proposal_not_pending');
  assert.equal(
    (await getProposal(address, proposal.id)).rejection_reason,
    reason,
    'the first reason stands',
  );
});

test('t165 AT5 — apply demands approved: a merely pending proposal is 409 proposal_not_approved', async (t) => {
  const address = await startApp(t);
  const { hashSnapshot } = await loadHash();
  const { applyOperations } = await loadOperations();

  const { document, graph, version } = await registerBase(address);
  const operations = passingOperations();
  const proposal = await createProposal(address, graph.id, version.id, operations);

  const early = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  assert.equal(early.status, 409);
  assert.equal(
    (await jsonBody<{ error: string }>(early)).error,
    'proposal_not_approved',
    'skipping the gate has to fail loudly, with a code that names the missing precondition',
  );

  // Nothing happened: no version, pointer where it was, proposal still pending.
  const versions = await jsonBody<{ versions: GraphVersion[] }>(
    await fetch(`${address}/v1/graphs/${graph.id}/versions`),
  );
  assert.equal(versions.versions.length, 1, 'a refused apply writes no version');
  assert.equal((await getGraph(address, graph.id)).current_version_id, version.id);
  assert.equal((await getProposal(address, proposal.id)).status, 'pending');

  // And once approved, the happy path is the one AT11 already pinned.
  await approve(address, proposal.id);
  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));

  const expected = hashSnapshot(applyOperations(document, operations));
  assert.equal(body.graph_version?.id, expected);
  assert.equal(body.graph_version?.parent_version, version.id);
  assert.equal(body.proposal.status, 'applied');
  assert.equal(body.proposal.applied_version_id, expected);
  assert.equal((await getGraph(address, graph.id)).current_version_id, expected);
});

test('t165 AT6 — the read routes expose rejection_reason', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const reason = 'a evidência é de uma execução única, sem base de comparação';
  assert.equal((await post(address, `/v1/proposals/${proposal.id}/reject`, { reason })).status, 200);

  assert.equal(
    (await getProposal(address, proposal.id)).rejection_reason,
    reason,
    'GET /v1/proposals/:id carries the reason the tela already reads (inbox.js:197)',
  );

  const [listed] = await listProposals(address);
  assert.equal(listed.rejection_reason, reason, 'and so does the listing');

  // A proposal nobody rejected reads null, never an empty string.
  const other = await createProposal(address, graph.id, version.id, roleChange('copidesque'));
  assert.equal((await getProposal(address, other.id)).rejection_reason, null);

  assert.equal((await fetch(`${address}/v1/proposals/999`)).status, 404);
  assert.equal((await fetch(`${address}/v1/proposals/nao-numerico`)).status, 404);
});

test('t180 — the human gate refuses in English, with the frozen status quoted', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const noReason = await post(address, `/v1/proposals/${proposal.id}/reject`, {});
  assert.equal(noReason.status, 400);
  const refused = await jsonBody<{ error: string; message: string }>(noReason);
  assert.equal(refused.error, 'reason_required', 'the code is frozen (FR2)');
  assert.equal(
    refused.message,
    'rejecting requires a reason: a rejected proposal is negative knowledge for the surveyor, and without the why it is not',
  );

  await approve(address, proposal.id);
  const twice = await post(address, `/v1/proposals/${proposal.id}/approve`, {});
  assert.equal(twice.status, 409);
  const conflict = await jsonBody<{ error: string; message: string; status: string }>(twice);
  assert.equal(conflict.error, 'proposal_not_pending');
  assert.equal(conflict.status, 'approved', 'the wire quotes the wire value, never the column (t226, FR1)');
  assert.equal(conflict.message, 'only a pending proposal can be approved; this one is "approved"');
});

/* -------------------------------------------------------------------------- */
/* t166 — changing a node's engine/model is a versioned graph mutation (D15).  */
/*                                                                            */
/* No new machinery is proven here, and that IS the claim: `change_node_field`  */
/* over the two new fields rides the pipeline the rest of this file already    */
/* exercises — apply, soundness, new `grafo_versao`, pointer moved — and the   */
/* previous version stays readable, because nothing is ever deleted (D15).     */
/* -------------------------------------------------------------------------- */

/** Swaps one field of the `revisar` node, with its inverse. */
function swapNodeField(field: string, from: unknown, to: unknown): OperationsModule.Operation {
  return {
    type: 'change_node_field',
    node_id: 'revisar',
    field,
    from,
    to,
    inverse: { type: 'change_node_field', node_id: 'revisar', field, from: to, to: from },
  } as OperationsModule.Operation;
}

/** The snapshot of one version, as `GET /v1/graph-versions/:id` returns it. */
async function readSnapshot(address: string, versionId: string): Promise<GraphDocument> {
  const response = await fetch(`${address}/v1/graph-versions/${encodeURIComponent(versionId)}`);
  const body = await jsonBody<{ graph_version: { snapshot: GraphDocument } }>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.graph_version.snapshot;
}

test('t166 AT — applying a model change writes a new version and moves the pointer', async (t) => {
  const address = await startApp(t);
  const { hashSnapshot } = await loadHash();
  const { applyOperations } = await loadOperations();

  const { document, graph, version } = await registerBase(address);
  assert.equal(requireNode(document, 'revisar').model, undefined, 'the fixture declares no model');

  // `null` and not `undefined` for the before-value: JSON has no `undefined`,
  // so a proposal that says "this node declared nothing" has to say it in a
  // word the wire can carry — and `change_node_field` demands `from` be present.
  const operations = [swapNodeField('model', null, 'claude-haiku-4-5')];
  const proposal = await createProposal(address, graph.id, version.id, operations);
  await approve(address, proposal.id);

  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));

  const expected = hashSnapshot(applyOperations(document, operations));
  assert.ok(body.graph_version !== undefined);
  assert.equal(body.graph_version.id, expected, 'the new version is the hash of the resulting document');
  assert.notEqual(body.graph_version.id, version.id, 'a field swap is a NEW version, never an edit');
  assert.equal(body.graph_version.parent_version, version.id);

  assert.equal(
    (await getGraph(address, graph.id)).current_version_id,
    expected,
    'the pointer has to have moved',
  );

  // The new snapshot carries the model...
  assert.equal(requireNode(await readSnapshot(address, expected), 'revisar').model, 'claude-haiku-4-5');
  // ...and the previous one is still readable, still without it (D15).
  assert.equal(requireNode(await readSnapshot(address, version.id), 'revisar').model, undefined);
});

test('t166 AT — applying an engine change writes a new version and moves the pointer', async (t) => {
  const address = await startApp(t);

  const { document, graph, version } = await registerBase(address);
  assert.equal(requireNode(document, 'revisar').engine, undefined, 'the fixture declares no engine');

  const proposal = await createProposal(address, graph.id, version.id, [
    swapNodeField('engine', null, 'codex'),
  ]);
  await approve(address, proposal.id);

  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.graph_version !== undefined);

  const current = (await getGraph(address, graph.id)).current_version_id;
  assert.equal(current, body.graph_version.id);
  assert.ok(current !== null);
  assert.equal(requireNode(await readSnapshot(address, current), 'revisar').engine, 'codex');
  assert.equal(requireNode(await readSnapshot(address, version.id), 'revisar').engine, undefined);
});
