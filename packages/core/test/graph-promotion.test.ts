/**
 * Promotion and offer route acceptance tests (t140, FR7-FR9, D13).
 *
 * D13 fixes the shape of both flows in one sentence: the diff of a variant that
 * beats the base becomes a promotion proposal FOR the base, and an improvement in
 * the base is OFFERED to the variants, never forced on them. The two routes here
 * are that sentence with a direction each — and neither of them applies anything.
 * What they produce is a PENDING proposal, subject to the same human gate as any
 * other (README, principle 5).
 *
 * The whole point is that nothing downstream needed a special case: the
 * proposals returned here go through `POST /v1/proposals/:id/apply` unmodified,
 * which is what AT13 and AT15 prove. If applying a promotion needed its own
 * branch, the diff engine would be wrong.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are English.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalize } from '../src/domain/hash.ts';
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

/** Id of the variant every test here forks. */
const VARIANT_ID = 'nota-curta-do-projeto';

/** A lineage, as the API returns it. */
interface GraphRow {
  id: string;
  classe: string;
  linhagem_tipo: string;
  base_classe: string | null;
  versao_corrente_id: string | null;
}

/** A version without the snapshot, as the API returns it. */
interface VersionRow {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
}

/** A version with the whole document. */
interface VersionWithSnapshot extends VersionRow {
  snapshot: Record<string, unknown>;
}

/** A proposal, in the slice these tests read. */
interface ProposalRow {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: Array<Record<string, unknown>>;
  status: string;
  versao_aplicada_id: string | null;
}

/** Body of a successful promotion/offer, and of a refused one. */
interface ProposalResponse {
  erro?: string;
  mensagem?: string;
  proposta: ProposalRow;
}

function minimalGraph(): Record<string, unknown> {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as Record<string, unknown>;
}

async function start(t: TestHook): Promise<TestContext> {
  requireArtifacts('src/routes/graphs.ts', 'src/domain/diff.ts');
  return startControlPlane(t);
}

/** Registers a base graph of the given class and returns what was written. */
async function registerBase(
  ctx: TestContext,
  className?: string,
): Promise<{ graph: GraphRow; version: VersionRow }> {
  const document = minimalGraph();
  if (className !== undefined) document.classe = className;

  const response = await request<{ grafo: GraphRow; grafo_versao: VersionRow }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { graph: response.body.grafo, version: response.body.grafo_versao };
}

async function fork(ctx: TestContext, baseId: string, id: string): Promise<VersionRow> {
  const response = await request<{ grafo: GraphRow; grafo_versao: VersionRow }>(
    ctx,
    'POST',
    `/v1/graphs/${baseId}/fork`,
    { id },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.grafo_versao;
}

async function readGraph(ctx: TestContext, id: string): Promise<GraphRow> {
  const response = await request<{ grafo: GraphRow }>(ctx, 'GET', `/v1/graphs/${id}`);
  assert.equal(response.status, 200);
  return response.body.grafo;
}

async function readVersion(ctx: TestContext, id: string): Promise<VersionWithSnapshot> {
  const response = await request<{ grafo_versao: VersionWithSnapshot }>(
    ctx,
    'GET',
    `/v1/graph-versions/${encodeURIComponent(id)}`,
  );
  assert.equal(response.status, 200);
  return response.body.grafo_versao;
}

/** Current snapshot of a lineage, the document as it holds today. */
async function currentSnapshot(ctx: TestContext, id: string): Promise<Record<string, unknown>> {
  const graph = await readGraph(ctx, id);
  assert.ok(graph.versao_corrente_id !== null, `lineage "${id}" has no current version`);
  return (await readVersion(ctx, graph.versao_corrente_id)).snapshot;
}

/** How many proposals exist — the "nothing was written" assertion. */
function proposalCount(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM proposta').get() as { total: number };
  return row.total;
}

/** A new node, complete enough to pass `no_com_contrato` (same one as t101's suite). */
function newNode(): Record<string, unknown> {
  return {
    id: 'checar_fatos',
    papel: 'revisor',
    tipo_no: 'trabalho',
    descricao: 'Confere cada afirmação da nota contra a fonte citada.',
    skill_ref: {
      id: 'cartografo/checar-fatos',
      versao: '1.0.0',
      hash: `sha256:${'0'.repeat(64)}`,
    },
    contrato: {
      entrada_schema: {
        type: 'object',
        required: ['texto'],
        properties: { texto: { type: 'string', minLength: 1 } },
      },
      saida_schema: {
        type: 'object',
        required: ['aprovado'],
        properties: { aprovado: { type: 'boolean' } },
      },
      verificacoes: [
        {
          tipo: 'deterministico',
          comando: 'test -s checagem.md',
          descricao: 'O relatório de checagem existe e não está vazio.',
        },
      ],
    },
  };
}

/**
 * Inserts `checar_fatos` between `redigir` and `revisar`; passes the soundness gate.
 *
 * The node cannot arrive alone: an isolated node breaks `alcançável` and
 * `termina` at once, so the gate would refuse the version. That is why the diff
 * these tests promote is a node plus the two edges that make it reachable, and
 * not a lone `adicionar_no`.
 */
function passingOperations(): unknown[] {
  const node = newNode();
  return [
    { tipo: 'adicionar_no', no: node, inversa: { tipo: 'remover_no', no_id: node.id } },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: 'redigir', para: node.id, condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: node.id } },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: node.id, para: 'revisar', condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: node.id, para: 'revisar' } },
    },
  ];
}

/** What the diff of that evolution looks like, in the engine's emission order. */
function expectedOperations(): unknown[] {
  const node = newNode();
  return [
    { tipo: 'adicionar_no', no: node, inversa: { tipo: 'remover_no', no_id: 'checar_fatos' } },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: 'redigir', para: 'checar_fatos', condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: 'checar_fatos' } },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: 'checar_fatos', para: 'revisar', condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: 'checar_fatos', para: 'revisar' } },
    },
  ];
}

const EVIDENCE = { fonte: 'telemetria', observacao: 'divergência sistemática neste projeto' };
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

/** Evolves a lineage through the ordinary proposal flow: create, then apply. */
async function evolve(ctx: TestContext, graphId: string): Promise<VersionRow> {
  const graph = await readGraph(ctx, graphId);
  const created = await request<{ proposta: ProposalRow }>(ctx, 'POST', '/v1/proposals', {
    grafo_id: graphId,
    versao_alvo: graph.versao_corrente_id,
    operacoes: passingOperations(),
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  await approve(ctx, created.body.proposta.id);
  const applied = await request<{ grafo_versao: VersionRow }>(
    ctx,
    'POST',
    `/v1/proposals/${created.body.proposta.id}/apply`,
    {},
  );
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return applied.body.grafo_versao;
}

async function promote(
  ctx: TestContext,
  variantId: string,
  body: unknown,
): Promise<{ status: number; body: ProposalResponse }> {
  return request<ProposalResponse>(ctx, 'POST', `/v1/graphs/${variantId}/promote`, body);
}

async function offer(
  ctx: TestContext,
  baseId: string,
  body: unknown,
): Promise<{ status: number; body: ProposalResponse }> {
  return request<ProposalResponse>(ctx, 'POST', `/v1/graphs/${baseId}/offer`, body);
}

/**
 * Walks a proposal through the human gate (t165, FR2/FR4).
 *
 * A promotion/offer is a proposal like any other — including in this: since
 * t165 `apply` demands `aprovada`, and nothing about carrying a diff between
 * lineages skips the gate of princípio 5.
 */
async function approve(ctx: TestContext, id: number): Promise<void> {
  const response = await request<{ proposta: ProposalRow }>(
    ctx,
    'POST',
    `/v1/proposals/${id}/approve`,
    {},
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.proposta.status, 'aprovada');
}

/** Approves and applies a proposal by id, and returns the version it wrote. */
async function apply(ctx: TestContext, id: number): Promise<VersionRow> {
  await approve(ctx, id);
  const response = await request<{ proposta: ProposalRow; grafo_versao: VersionRow }>(
    ctx,
    'POST',
    `/v1/proposals/${id}/apply`,
    {},
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.proposta.status, 'aplicada');
  return response.body.grafo_versao;
}

test('t140 AT12 — promoting a variant that gained a node opens a pending proposal on the base', async (t) => {
  const ctx = await start(t);
  const { graph, version } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, VARIANT_ID);

  const response = await promote(ctx, VARIANT_ID, {
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const proposal = response.body.proposta;
  assert.equal(proposal.status, 'pendente');
  assert.equal(proposal.grafo_id, graph.id, 'the promotion targets the BASE');
  assert.equal(proposal.versao_alvo, version.id, "and the base's current version");
  assert.deepEqual(proposal.operacoes, expectedOperations());
});

test('t140 AT13 — applying the promotion carries the diff to the base and keeps its identity', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, VARIANT_ID);

  const response = await promote(ctx, VARIANT_ID, {
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const written = await apply(ctx, response.body.proposta.id);
  assert.equal(written.grafo_id, graph.id);

  const base = await currentSnapshot(ctx, graph.id);
  const variant = await currentSnapshot(ctx, VARIANT_ID);
  assert.deepEqual(canonicalize(base.nos), canonicalize(variant.nos));
  assert.deepEqual(canonicalize(base.arestas), canonicalize(variant.arestas));

  assert.equal(base.classe, graph.classe);
  assert.deepEqual(base.linhagem, { tipo: 'base' }, 'the base stays a base');
});

test('t140 AT14 — offering the base improvement opens a pending proposal on the named variant', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  const forked = await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, graph.id);

  const response = await offer(ctx, graph.id, {
    variante_id: VARIANT_ID,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const proposal = response.body.proposta;
  assert.equal(proposal.status, 'pendente');
  assert.equal(proposal.grafo_id, VARIANT_ID, 'the offer targets the VARIANT');
  assert.equal(proposal.versao_alvo, forked.id, "and the variant's current version");
  assert.deepEqual(proposal.operacoes, expectedOperations());
});

test('t140 AT15 — applying the offer carries the diff to the variant and keeps its lineage', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, graph.id);

  const response = await offer(ctx, graph.id, {
    variante_id: VARIANT_ID,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const written = await apply(ctx, response.body.proposta.id);
  assert.equal(written.grafo_id, VARIANT_ID);

  const base = await currentSnapshot(ctx, graph.id);
  const variant = await currentSnapshot(ctx, VARIANT_ID);
  assert.deepEqual(canonicalize(variant.nos), canonicalize(base.nos));
  assert.deepEqual(canonicalize(variant.arestas), canonicalize(base.arestas));

  assert.deepEqual(
    variant.linhagem,
    { tipo: 'variante', base_classe: graph.classe },
    'an offer is not a merge of identities: the variant stays a variant',
  );
  assert.equal((await readGraph(ctx, VARIANT_ID)).linhagem_tipo, 'variante');
});

test('t140 AT16 — promoting a base is a 400 and writes no proposal', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  const before = proposalCount(ctx);

  const response = await promote(ctx, graph.id, {
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.erro, 'variante_invalida');
  assert.equal(proposalCount(ctx), before);
});

test('t140 AT17 — offering from a variant is a 400 and writes no proposal', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  const before = proposalCount(ctx);

  const response = await offer(ctx, VARIANT_ID, {
    variante_id: VARIANT_ID,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.erro, 'base_invalida');
  assert.equal(proposalCount(ctx), before);
});

test('t140 AT18 — offering to an unknown variant is a 404 and writes no proposal', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, graph.id);
  const before = proposalCount(ctx);

  const response = await offer(ctx, graph.id, {
    variante_id: 'nunca-bifurcada',
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 404, JSON.stringify(response.body));
  assert.equal(response.body.erro, 'grafo_desconhecido');
  assert.equal(proposalCount(ctx), before);
});

test('t140 AT18 — offering with no variante_id is a 400 and writes no proposal', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, graph.id);
  const before = proposalCount(ctx);

  for (const body of [{}, { variante_id: '' }, { variante_id: 42 }]) {
    const response = await offer(ctx, graph.id, {
      ...body,
      evidencia: EVIDENCE,
      metrica_esperada: EXPECTED_METRIC,
    });
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.erro, 'campo_obrigatorio_ausente');
  }
  assert.equal(proposalCount(ctx), before);
});

test('t140 AT19 — offering to a variant of another class is a 400 and writes no proposal', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  const other = await registerBase(ctx, 'nota-longa');
  await fork(ctx, other.graph.id, 'nota-longa-do-projeto');
  await evolve(ctx, graph.id);
  const before = proposalCount(ctx);

  const response = await offer(ctx, graph.id, {
    variante_id: 'nota-longa-do-projeto',
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.erro, 'variante_invalida');
  assert.equal(proposalCount(ctx), before);
});

test('t140 AT20 — promoting or offering before either side diverges is a 422', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  const before = proposalCount(ctx);

  const promoted = await promote(ctx, VARIANT_ID, {
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(promoted.status, 422, JSON.stringify(promoted.body));
  assert.equal(promoted.body.erro, 'diff_sem_efeito');

  const offered = await offer(ctx, graph.id, {
    variante_id: VARIANT_ID,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(offered.status, 422, JSON.stringify(offered.body));
  assert.equal(offered.body.erro, 'diff_sem_efeito');

  assert.equal(proposalCount(ctx), before);
});

test('t140 AT21 — promoting without the hypothesis fields is a 400 and writes no proposal', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  await evolve(ctx, VARIANT_ID);
  const before = proposalCount(ctx);

  for (const body of [
    { metrica_esperada: EXPECTED_METRIC },
    { evidencia: EVIDENCE },
    {},
  ]) {
    const response = await promote(ctx, VARIANT_ID, body);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.equal(response.body.erro, 'campo_obrigatorio_ausente');
  }

  const offered = await offer(ctx, graph.id, { variante_id: VARIANT_ID });
  assert.equal(offered.status, 400, JSON.stringify(offered.body));
  assert.equal(offered.body.erro, 'campo_obrigatorio_ausente');

  assert.equal(proposalCount(ctx), before);
});

test('t140 AT22 — promoting or offering on an unknown lineage is a 404', async (t) => {
  const ctx = await start(t);
  await registerBase(ctx);
  const before = proposalCount(ctx);

  const promoted = await promote(ctx, 'inexistente', {
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(promoted.status, 404, JSON.stringify(promoted.body));
  assert.equal(promoted.body.erro, 'grafo_desconhecido');

  const offered = await offer(ctx, 'inexistente', {
    variante_id: VARIANT_ID,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(offered.status, 404, JSON.stringify(offered.body));
  assert.equal(offered.body.erro, 'grafo_desconhecido');

  assert.equal(proposalCount(ctx), before);
});

test('t140 FR9 — a lineage with no current version is a 409, not a crash', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, VARIANT_ID);
  const before = proposalCount(ctx);

  // Impossible through the API — written straight into the database on purpose,
  // because the invariant is defensive and has to hold anyway.
  ctx.db.prepare('UPDATE grafo SET versao_corrente_id = NULL WHERE id = ?').run(VARIANT_ID);

  const promoted = await promote(ctx, VARIANT_ID, {
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(promoted.status, 409, JSON.stringify(promoted.body));
  assert.equal(promoted.body.erro, 'grafo_sem_versao_corrente');

  const offered = await offer(ctx, graph.id, {
    variante_id: VARIANT_ID,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(offered.status, 409, JSON.stringify(offered.body));
  assert.equal(offered.body.erro, 'grafo_sem_versao_corrente');

  assert.equal(proposalCount(ctx), before);
});

test('t180 — the promote and offer guards refuse in English', async (t) => {
  const ctx = await start(t);
  const { graph } = await registerBase(ctx);
  await fork(ctx, graph.id, 'variante-a');

  const hypothesis = { evidencia: EVIDENCE, metrica_esperada: EXPECTED_METRIC };

  const basePromoting = await promote(ctx, graph.id, hypothesis);
  assert.equal(basePromoting.status, 400);
  assert.equal((basePromoting.body as { erro: string }).erro, 'variante_invalida');
  assert.equal(
    (basePromoting.body as { mensagem: string }).mensagem,
    'only a variant has something to promote; a base does not promote to itself (D13)',
  );

  const variantOffering = await offer(ctx, 'variante-a', {
    ...hypothesis,
    variante_id: 'variante-a',
  });
  assert.equal(variantOffering.status, 400);
  assert.equal((variantOffering.body as { erro: string }).erro, 'base_invalida');
  assert.equal(
    (variantOffering.body as { mensagem: string }).mensagem,
    'only a base lineage offers an improvement to its variants (D13)',
  );
});
