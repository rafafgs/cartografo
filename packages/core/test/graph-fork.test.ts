/**
 * Fork route acceptance tests (t118, D13).
 *
 * Bifurcating is branch semantics: the variant is born as the base's current
 * snapshot byte for byte, with `lineage` swapped and nothing else — a `git
 * branch` moves no content either. Everything this suite checks hangs off that
 * one sentence: the parent that crosses lineages, the pointer that only moves in
 * the bootstrap, and the refusal when two forks would produce the same document
 * (the version id is a GLOBAL content address, not one scoped per lineage).
 *
 * The last test is the point of the whole ticket: after forking, the ordinary
 * proposal flow evolves the variant with no change at all to
 * `routes/proposals.ts`. If that one needs a special case, the fork was designed
 * wrong.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are English.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  request,
  requireArtifacts,
  startControlPlane,
  type TestContext,
  type TestHook,
} from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

/** Id used by every fork here that is expected to succeed. */
const VARIANT_ID = 'nota-curta-do-projeto';

/** A lineage, as the API returns it. */
interface Graph {
  id: string;
  class: string;
  lineage_type: string;
  base_class: string | null;
  origin_proposal_id: number | null;
  current_version_id: string | null;
  created_at: string;
}

/** A version without the snapshot, as the API returns it. */
interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
}

/** A version with the whole document. */
interface GraphVersionWithSnapshot extends GraphVersion {
  snapshot: Record<string, unknown>;
}

/** A proposal, in the slice these tests read. */
interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  status: string;
  applied_version_id: string | null;
}

/** Body of a successful fork, and of a refused one. */
interface ForkResponse {
  error?: string;
  message?: string;
  graph: Graph;
  graph_version: GraphVersion;
}

function minimalGraph(): Record<string, unknown> {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as Record<string, unknown>;
}

/**
 * Starts the control plane, naming the artifacts this ticket creates.
 *
 * @param t Test context, used to register the shutdown.
 * @returns Open database (read-only for the tests) and base URL.
 */
async function start(t: TestHook): Promise<TestContext> {
  requireArtifacts('src/routes/graphs.ts', 'src/repositories/graphs.ts');
  return startControlPlane(t);
}

/** Registers the minimal base graph and returns the document and what was written. */
async function registerBase(
  ctx: TestContext,
): Promise<{ document: Record<string, unknown>; graph: Graph; version: GraphVersion }> {
  const document = minimalGraph();
  const response = await request<{ graph: Graph; graph_version: GraphVersion }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { document, graph: response.body.graph, version: response.body.graph_version };
}

async function fork(
  ctx: TestContext,
  baseId: string,
  body: unknown,
): Promise<{ status: number; body: ForkResponse }> {
  return request<ForkResponse>(ctx, 'POST', `/v1/graphs/${baseId}/fork`, body);
}

async function readGraph(ctx: TestContext, id: string): Promise<Graph> {
  const response = await request<{ graph: Graph }>(ctx, 'GET', `/v1/graphs/${id}`);
  assert.equal(response.status, 200);
  return response.body.graph;
}

async function readVersion(ctx: TestContext, id: string): Promise<GraphVersionWithSnapshot> {
  const response = await request<{ graph_version: GraphVersionWithSnapshot }>(
    ctx,
    'GET',
    `/v1/graph-versions/${encodeURIComponent(id)}`,
  );
  assert.equal(response.status, 200);
  return response.body.graph_version;
}

/** How many rows the two tables hold — the "nothing was written" assertion. */
function counts(ctx: TestContext): { lineages: number; versions: number } {
  const lineages = ctx.db.prepare('SELECT COUNT(*) AS total FROM grafo').get() as { total: number };
  const versions = ctx.db.prepare('SELECT COUNT(*) AS total FROM grafo_versao').get() as {
    total: number;
  };
  return { lineages: lineages.total, versions: versions.total };
}

/** A new node, complete enough to pass `no_com_contrato` (same one as t101's suite). */
function newNode(): Record<string, unknown> {
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

/** Inserts `checar_fatos` between `redigir` and `revisar`; passes the soundness gate. */
function passingOperations(): unknown[] {
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

const EVIDENCE = { fonte: 'telemetria', observacao: 'divergência sistemática neste projeto' };
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

/** Creates a pending proposal against a lineage — used as the fork's origin, and by AT15. */
async function createProposal(
  ctx: TestContext,
  graphId: string,
  targetVersion: string,
): Promise<Proposal> {
  const response = await request<{ proposal: Proposal }>(ctx, 'POST', '/v1/proposals', {
    graph_id: graphId,
    target_version: targetVersion,
    operations: passingOperations(),
    evidence: EVIDENCE,
    expected_metric: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.proposal;
}

test('t118 AT1 — forking a base with a fresh id creates a variant lineage', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  assert.equal(response.body.graph.id, VARIANT_ID);
  assert.equal(response.body.graph.class, graph.class, 'the variant inherits the class');
  assert.equal(response.body.graph.lineage_type, 'variant');
  assert.equal(response.body.graph.base_class, graph.class);
  assert.equal(response.body.graph.origin_proposal_id, null);
});

test('t118 AT2 — with no origin proposal the version is manual', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  assert.equal(response.body.graph_version.graph_id, VARIANT_ID);
  assert.equal(response.body.graph_version.source, 'manual');
  assert.equal(response.body.graph_version.proposal_id, null);
});

test('t118 AT3 — the forked snapshot is the base one with only `lineage` swapped', async (t) => {
  const ctx = await start(t);
  const { document, graph, version } = await registerBase(ctx);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const baseSnapshot = (await readVersion(ctx, version.id)).snapshot;
  const forked = (await readVersion(ctx, response.body.graph_version.id)).snapshot;

  assert.deepEqual(
    forked.lineage,
    { type: 'variante', base_class: graph.class },
    'with no origin proposal the key is omitted altogether, never null',
  );
  assert.deepEqual(
    { ...forked, lineage: undefined },
    { ...baseSnapshot, lineage: undefined },
    'forking carries no diff: every other key is the base document, untouched',
  );
  assert.deepEqual(baseSnapshot, document, 'and the base snapshot itself did not move');
});

test('t118 AT4 — an origin proposal lands as an integer in the column and a string in the document', async (t) => {
  const ctx = await start(t);
  const { graph, version } = await registerBase(ctx);
  const proposal = await createProposal(ctx, graph.id, version.id);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID, origin_proposal_id: proposal.id });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  assert.equal(response.body.graph.origin_proposal_id, proposal.id);
  assert.equal(response.body.graph_version.source, 'proposal');
  assert.equal(response.body.graph_version.proposal_id, proposal.id);

  const forked = (await readVersion(ctx, response.body.graph_version.id)).snapshot;
  assert.deepEqual(forked.lineage, {
    type: 'variante',
    base_class: graph.class,
    source_proposal_id: String(proposal.id),
  });
});

test('t118 AT5 — the first version of the variant descends from the base current version', async (t) => {
  const ctx = await start(t);
  const { graph, version } = await registerBase(ctx);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  assert.equal(
    response.body.graph_version.parent_version,
    version.id,
    'the parenthood crosses the lineage: the parent belongs to the base',
  );
  assert.equal(
    (await readGraph(ctx, graph.id)).current_version_id,
    version.id,
    'and the base pointer stands still',
  );
});

test('t118 AT6 — the variant is born already pointing at its first version', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  assert.equal(
    (await readGraph(ctx, VARIANT_ID)).current_version_id,
    response.body.graph_version.id,
  );
});

test('t118 AT7 — forking an unknown lineage is a 404 and writes nothing', async (t) => {
  const ctx = await start(t);
  await registerBase(ctx);
  const before = counts(ctx);

  const response = await fork(ctx, 'inexistente', { id: VARIANT_ID });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'unknown_graph');
  assert.deepEqual(counts(ctx), before);
});

test('t118 AT8 — forking a variant is a 400 and writes nothing', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  assert.equal((await fork(ctx, graph.id, { id: VARIANT_ID })).status, 201);
  const before = counts(ctx);

  const response = await fork(ctx, VARIANT_ID, { id: 'nota-curta-de-outro-projeto' });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_base');
  assert.deepEqual(counts(ctx), before);
});

test('t118 AT9 — a body with no id is a 400 and writes nothing', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  const before = counts(ctx);

  for (const body of [{}, { id: '' }, { id: '   ' }, { id: 42 }]) {
    const response = await fork(ctx, graph.id, body);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.error, 'missing_required_field');
  }
  assert.deepEqual(counts(ctx), before);
});

test('t118 AT10 — an id that already exists is a 409 and writes nothing', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  assert.equal((await fork(ctx, graph.id, { id: VARIANT_ID })).status, 201);
  const before = counts(ctx);

  for (const taken of [graph.id, VARIANT_ID]) {
    const response = await fork(ctx, graph.id, { id: taken });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error, 'id_already_registered');
  }
  assert.deepEqual(counts(ctx), before);
});

test('t118 AT11 — an origem_proposta_id that is not a positive integer is a 400 and writes nothing', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  const before = counts(ctx);

  for (const wrong of ['1', 1.5, 0, -3, true, {}]) {
    const response = await fork(ctx, graph.id, { id: VARIANT_ID, origin_proposal_id: wrong });
    assert.equal(response.status, 400, `${JSON.stringify(wrong)}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, 'invalid_origin_proposal_id');
  }
  assert.deepEqual(counts(ctx), before);
});

test('t118 AT12 — an origem_proposta_id nobody proposed is a 400 and writes nothing', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  const before = counts(ctx);

  const response = await fork(ctx, graph.id, { id: VARIANT_ID, origin_proposal_id: 999 });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.error, 'unknown_origin_proposal');
  assert.deepEqual(counts(ctx), before);
});

test('t118 AT13 — the second identical fork is a 409 and writes nothing', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  assert.equal((await fork(ctx, graph.id, { id: VARIANT_ID })).status, 201);

  const listBefore = await request<{ graphs: Graph[] }>(ctx, 'GET', '/v1/graphs');
  const before = counts(ctx);

  // Same base version and no origin proposal on either side: the two documents
  // are identical, and the version id is a GLOBAL content address — one row
  // cannot belong to two lineages at once.
  const response = await fork(ctx, graph.id, { id: 'nota-curta-de-outro-projeto' });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, 'fork_without_effect');

  assert.deepEqual(counts(ctx), before);
  const listAfter = await request<{ graphs: Graph[] }>(ctx, 'GET', '/v1/graphs');
  assert.deepEqual(listAfter.body.graphs, listBefore.body.graphs);
});

test('t118 AT14 — a base with no current version is a 409, not a crash', async (t) => {
  const ctx = await start(t);
  await registerBase(ctx);
  const before = counts(ctx);

  // Impossible through the API — inserted straight into the database on purpose,
  // because the invariant is defensive and has to hold anyway.
  ctx.db
    .prepare(
      `INSERT INTO grafo (id, classe, linhagem_tipo, base_classe, origem_proposta_id,
                          versao_corrente_id, criado_em)
       VALUES ('nota-orfa', 'nota-orfa', 'base', NULL, NULL, NULL, '2026-08-14T00:00:00.000Z')`,
    )
    .run();

  const response = await fork(ctx, 'nota-orfa', { id: VARIANT_ID });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, 'graph_without_current_version');

  const after = counts(ctx);
  assert.equal(after.lineages, before.lineages + 1, 'only the row the test itself inserted');
  assert.equal(after.versions, before.versions);
});

test('t118 AT15 — the ordinary proposal flow evolves the variant, base untouched', async (t) => {
  const ctx = await start(t);
  const { graph, version } = await registerBase(ctx);

  const forked = await fork(ctx, graph.id, { id: VARIANT_ID });
  assert.equal(forked.status, 201, JSON.stringify(forked.body));
  const variantVersion = forked.body.graph_version.id;

  const proposal = await createProposal(ctx, VARIANT_ID, variantVersion);

  // The gate of princípio 5 stands between the two, since t165: `apply` demands
  // `aprovada`, and a variant's proposal is a proposal like any other.
  const approved = await request<{ proposal: Proposal }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/approve`,
    {},
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const applied = await request<{ proposal: Proposal; graph_version: GraphVersion }>(
    ctx,
    'POST',
    `/v1/proposals/${proposal.id}/apply`,
    {},
  );
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.proposal.status, 'applied');
  assert.equal(applied.body.graph_version.graph_id, VARIANT_ID);
  assert.equal(applied.body.graph_version.parent_version, variantVersion);

  assert.equal(
    (await readGraph(ctx, VARIANT_ID)).current_version_id,
    applied.body.graph_version.id,
    'the variant pointer moved',
  );
  assert.equal(
    (await readGraph(ctx, graph.id)).current_version_id,
    version.id,
    'and the base pointer did not: the two lineages evolve apart',
  );
});

test('t180 — the fork guards refuse in English', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);

  const noId = await fork(ctx, graph.id, {});
  assert.equal(noId.status, 400);
  assert.equal((noId.body as { error: string }).error, 'missing_required_field');
  assert.equal(
    (noId.body as { message: string }).message,
    'the fork requires "id": it is the identity of the lineage being born',
  );

  const variant = await fork(ctx, graph.id, { id: 'variante-a' });
  assert.equal(variant.status, 201, JSON.stringify(variant.body));

  const ofVariant = await fork(ctx, 'variante-a', { id: 'variante-b' });
  assert.equal(ofVariant.status, 400);
  assert.equal((ofVariant.body as { error: string }).error, 'invalid_base');
  assert.equal(
    (ofVariant.body as { message: string }).message,
    'only a base lineage can be forked; a variant of a variant is out (D13)',
  );
});
