/**
 * Intake acceptance tests (t122, AT7–AT16).
 *
 * Intake is the second of D3's two acts: synthesizing topology produces NODES
 * (once per class), breaking work down produces TICKETS (every execution). This
 * file exercises the second one end to end — draft, amend, discard, and the
 * human confirmation gate that is the only path from "a proposed breakdown" to
 * `trabalho` rows on the graph.
 *
 * The batch runs against the class registered from factory bundle 1
 * (`grafos-de-fabrica/desenvolvimento-de-software/grafo.json`), with no editing:
 * a synthetic graph would not prove that the jobs are born on the entry node of
 * the version that really holds today.
 *
 * AT16 is the ticket's original acceptance criterion and the one that guards
 * D3's "the path stays frozen": confirming a draft creates travellers and NEVER
 * a new `grafo_versao`, in any class.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are English.
 *
 * The t139 block at the bottom adds what the alpha round caught: the confirmation
 * gate is the only intake route that can raise a `ValidationError` — it is the
 * only one that writes an EVENT — and it was answering one with a raw 500 that
 * leaked the domain validator's message. A caller that can fix its own body
 * deserves the 400 every other route of this API gives it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  countEvents,
  requireArtifacts,
  request,
  startControlPlane,
  type Event,
  type Job,
  type TestContext,
} from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const FACTORY_GRAPH = path.join(
  REPO_ROOT,
  'grafos-de-fabrica',
  'desenvolvimento-de-software',
  'grafo.json',
);

/** Artifacts this ticket creates; every test requires them by name. */
const ARTIFACTS = [
  'migrations/0006_intake.sql',
  'src/domain/intake.ts',
  'src/repositories/intake.ts',
  'src/routes/intake.ts',
];

/** An item of a draft, as the API stores and returns it. */
interface DraftItem {
  ref: string;
  titulo: string;
  corpo: string | null;
  criterios_de_aceite: string[] | null;
  /** The class's declared fields, filled in at intake (t168). */
  campos: Record<string, string | number | boolean> | null;
  depende_de: string[];
}

/** Draft projection, as the API returns it. */
interface Draft {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  classe: string;
  pedido: string;
  itens: DraftItem[];
  status: string;
  trabalhos_criados: Record<string, number> | null;
  criado_em: string;
  atualizado_em: string;
}

/** The job projection with the two columns this ticket adds. */
interface JobWithContent extends Job {
  corpo: string | null;
  criterios_de_aceite: string[] | null;
  campos: Record<string, string | number | boolean> | null;
}

interface DraftResponse {
  rascunho: Draft;
}

interface ConfirmationResponse {
  rascunho: Draft;
  trabalhos: JobWithContent[];
}

interface ErrorResponse {
  erro: string;
  problemas?: Array<{ codigo: string; mensagem: string; alvo: unknown }>;
}

interface VersionRow {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
}

/** The class of factory bundle 1 — the one every test here breaks work down for. */
const CLASS = 'desenvolvimento-de-software';

/** Entry node of that graph. Read from the document, never hardcoded twice. */
function entryNode(): string {
  const document = JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')) as { initial_node: string };
  return document.initial_node;
}

/** Registers factory bundle 1 as it is on disk and returns the current version. */
async function registerFactoryGraph(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')) as Record<string, unknown>;
  const response = await request<{ grafo_versao: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  return response.body.grafo_versao.id;
}

/** How many drafts exist in the table — the "nothing was written" probe. */
function countDrafts(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM intake_rascunho').get() as {
    total: number;
  };
  return row.total;
}

/** How many jobs exist in the table. */
function countJobs(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM trabalho').get() as { total: number };
  return row.total;
}

/** The declared dependency edges, as rows. */
function dependencyRows(
  ctx: TestContext,
): Array<{ trabalho_id: number; depende_de_trabalho_id: number }> {
  return ctx.db
    .prepare(
      'SELECT trabalho_id, depende_de_trabalho_id FROM trabalho_dependencia ORDER BY id',
    )
    .all() as Array<{ trabalho_id: number; depende_de_trabalho_id: number }>;
}

/** The version chain of a lineage, straight from the API. */
async function versions(ctx: TestContext, graphId: string): Promise<VersionRow[]> {
  const response = await request<{ versoes: VersionRow[] }>(
    ctx,
    'GET',
    `/v1/graphs/${graphId}/versions`,
  );
  assert.equal(response.status, 200);
  return response.body.versoes;
}

/** Shortcut: opens a pending draft over the factory class. */
async function createDraft(
  ctx: TestContext,
  body: Record<string, unknown>,
): Promise<Draft> {
  const response = await request<DraftResponse>(ctx, 'POST', '/v1/intake', {
    classe: CLASS,
    pedido: 'quebrar o pedido em fichas',
    ...body,
  });
  assert.equal(response.status, 201, `POST /v1/intake returned ${response.status}`);
  return response.body.rascunho;
}

test('AT7 — a class with no registered base graph is 404 and writes nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    classe: 'classe-que-ninguem-registrou',
    pedido: 'um pedido qualquer',
    itens: [{ ref: 'a', titulo: 'uma ficha' }],
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.erro, 'grafo_desconhecido');
  assert.equal(countDrafts(ctx), 0, 'a draft over a class that does not exist is never written');
});

test('AT8 — POST /v1/intake with 2 independent items opens a pending draft', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const response = await request<DraftResponse>(ctx, 'POST', '/v1/intake', {
    classe: CLASS,
    pedido: 'dar ao intake uma API de duas fases',
    execucao_id: 7,
    itens: [
      {
        ref: 'migracao',
        titulo: 'Migração 0005',
        corpo: 'Colunas novas em trabalho e as duas tabelas do intake.',
        criterios_de_aceite: ['a migração roda do zero'],
      },
      { ref: 'rotas', titulo: 'Rotas de rascunho e confirmação' },
    ],
  });

  assert.equal(response.status, 201);
  const draft = response.body.rascunho;
  assert.ok(Number.isInteger(draft.id) && draft.id >= 1, 'id assigned by the server');
  assert.equal(draft.status, 'pendente');
  assert.equal(draft.classe, CLASS);
  assert.equal(draft.execucao_id, 7);
  assert.ok(Number.isInteger(draft.projeto_id));
  assert.equal(draft.trabalhos_criados, null, 'nothing is created until somebody confirms');
  assert.deepEqual(
    draft.itens.map((item) => item.ref),
    ['migracao', 'rotas'],
  );
  assert.deepEqual(draft.itens[0].criterios_de_aceite, ['a migração roda do zero']);
  assert.equal(draft.itens[1].corpo, null);
  assert.deepEqual(draft.itens[1].depende_de, []);

  assert.equal(countJobs(ctx), 0, 'a draft is a proposal, not a job');

  const stored = await request<DraftResponse>(ctx, 'GET', `/v1/intake/${draft.id}`);
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.body.rascunho, draft, 'what comes back is what was stored');
});

test('AT9 — a malformed item is 400 with the WHOLE list of problems and writes nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    classe: CLASS,
    pedido: 'um lote torto',
    itens: [
      { ref: 'a', titulo: '' },
      { ref: 'a', titulo: 'ref repetido' },
      { ref: 'c', titulo: 'depende do nada', depende_de: ['fantasma'] },
    ],
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.erro, 'itens_invalidos');
  const problems = response.body.problemas ?? [];
  assert.deepEqual(
    problems.map((problem) => problem.codigo).sort(),
    ['campo_obrigatorio_ausente', 'dependencia_desconhecida', 'ref_duplicado'],
    'three problems in, three problems out — never only the first',
  );
  for (const problem of problems) {
    assert.ok(problem.mensagem.length > 0, 'every problem explains itself');
  }
  assert.equal(countDrafts(ctx), 0);
});

test('AT9 — classe and pedido are required', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  for (const body of [
    { pedido: 'sem classe', itens: [{ ref: 'a', titulo: 'x' }] },
    { classe: CLASS, itens: [{ ref: 'a', titulo: 'x' }] },
    { classe: CLASS, pedido: '   ', itens: [{ ref: 'a', titulo: 'x' }] },
  ]) {
    const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.erro, 'campo_obrigatorio_ausente');
  }

  const withoutItems = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    classe: CLASS,
    pedido: 'sem itens',
  });
  assert.equal(withoutItems.status, 400);
  assert.equal(withoutItems.body.erro, 'itens_invalidos');

  assert.equal(countDrafts(ctx), 0);
});

test('AT10 — PATCH replaces itens while pending, and is 409 once the draft is closed', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, { itens: [{ ref: 'a', titulo: 'primeira ideia' }] });

  const amended = await request<DraftResponse>(ctx, 'PATCH', `/v1/intake/${draft.id}`, {
    itens: [
      { ref: 'a', titulo: 'ideia melhor' },
      { ref: 'b', titulo: 'e mais uma', depende_de: ['a'] },
    ],
  });
  assert.equal(amended.status, 200);
  assert.equal(amended.body.rascunho.status, 'pendente');
  assert.deepEqual(
    amended.body.rascunho.itens.map((item) => item.titulo),
    ['ideia melhor', 'e mais uma'],
    'the list is REPLACED, not merged',
  );
  assert.deepEqual(amended.body.rascunho.itens[1].depende_de, ['a']);
  assert.ok(
    amended.body.rascunho.atualizado_em >= draft.atualizado_em,
    'amending stamps atualizado_em',
  );

  const broken = await request<ErrorResponse>(ctx, 'PATCH', `/v1/intake/${draft.id}`, {
    itens: [{ ref: 'a', titulo: 'a', depende_de: ['a'] }],
  });
  assert.equal(broken.status, 400, 'the amendment suffers the same validation as the creation');
  assert.equal(broken.body.erro, 'itens_invalidos');

  const confirmed = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(confirmed.status, 201);

  const late = await request<ErrorResponse>(ctx, 'PATCH', `/v1/intake/${draft.id}`, {
    itens: [{ ref: 'a', titulo: 'tarde demais' }],
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.erro, 'rascunho_nao_pendente');

  const discarded = await createDraft(ctx, { itens: [{ ref: 'a', titulo: 'descartável' }] });
  assert.equal(
    (await request(ctx, 'POST', `/v1/intake/${discarded.id}/discards`, {})).status,
    200,
  );
  const overDiscarded = await request<ErrorResponse>(ctx, 'PATCH', `/v1/intake/${discarded.id}`, {
    itens: [{ ref: 'a', titulo: 'também tarde' }],
  });
  assert.equal(overDiscarded.status, 409);
  assert.equal(overDiscarded.body.erro, 'rascunho_nao_pendente');
});

test('AT11 — discarding closes the draft, twice is 409, and no job is ever created', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    itens: [
      { ref: 'a', titulo: 'ficha que não vai existir' },
      { ref: 'b', titulo: 'nem esta', depende_de: ['a'] },
    ],
  });

  const first = await request<DraftResponse>(ctx, 'POST', `/v1/intake/${draft.id}/discards`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.rascunho.status, 'descartado');
  assert.equal(first.body.rascunho.trabalhos_criados, null);

  const second = await request<ErrorResponse>(ctx, 'POST', `/v1/intake/${draft.id}/discards`, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.erro, 'rascunho_nao_pendente');

  const afterwards = await request<ErrorResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(afterwards.status, 409, 'a discarded draft can never be confirmed');

  assert.equal(countJobs(ctx), 0, 'no trabalho is created for a discarded draft');
  assert.equal(dependencyRows(ctx).length, 0);
});

test('AT12 — confirming creates one job per item, on the current entry node', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const versionId = await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    execucao_id: 9,
    itens: [
      {
        ref: 'a',
        titulo: 'Primeira ficha',
        corpo: 'O corpo preliminar da primeira.',
        criterios_de_aceite: ['npm test passa', 'npm run lint passa'],
      },
      { ref: 'b', titulo: 'Segunda ficha' },
    ],
  });

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { ator: { tipo: 'usuario', ref: 'rafael' } },
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.rascunho.status, 'confirmado');
  assert.ok(
    response.body.rascunho.atualizado_em >= draft.atualizado_em,
    'confirming stamps atualizado_em',
  );

  const jobs = response.body.trabalhos;
  assert.equal(jobs.length, 2, 'one trabalho per item, all of them in the answer');
  assert.deepEqual(
    response.body.rascunho.trabalhos_criados,
    { a: jobs[0].id, b: jobs[1].id },
    'trabalhos_criados maps every ref to the real id',
  );

  const start = entryNode();
  for (const job of jobs) {
    assert.equal(job.no_atual, start, 'every traveller is born on the entry node in force');
    assert.equal(job.no_entrada_id, start);
    assert.equal(job.grafo_versao_id, versionId, 'frozen on the version that holds today');
    assert.equal(job.execucao_id, 9, 'the whole batch shares the draft execution');
    assert.equal(job.bloqueado, false, 'declaring a dependency does not block anybody (FR14)');
  }

  assert.equal(jobs[0].titulo, 'Primeira ficha');
  assert.equal(jobs[0].corpo, 'O corpo preliminar da primeira.');
  assert.deepEqual(jobs[0].criterios_de_aceite, ['npm test passa', 'npm run lint passa']);
  assert.equal(jobs[1].corpo, null, 'an item with no body stores null, not an empty string');
  assert.equal(jobs[1].criterios_de_aceite, null);

  const board = await request<{ trabalhos: JobWithContent[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(board.status, 200);
  assert.equal(board.body.trabalhos.length, 2, 'the projection has the same two');
  assert.equal(board.body.trabalhos[0].corpo, 'O corpo preliminar da primeira.');
  assert.deepEqual(dependencyRows(ctx), [], 'no dependency was declared in this batch');
});

test('AT13 — a declared dependency becomes one row and one event, resolved to real ids', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    itens: [
      { ref: 'a', titulo: 'depende', depende_de: ['b'] },
      { ref: 'b', titulo: 'é dependido' },
    ],
  });

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(response.status, 201);

  const map = response.body.rascunho.trabalhos_criados ?? {};
  const dependent = map.a;
  const dependedOn = map.b;
  assert.ok(Number.isInteger(dependent) && Number.isInteger(dependedOn));

  assert.deepEqual(
    dependencyRows(ctx),
    [{ trabalho_id: dependent, depende_de_trabalho_id: dependedOn }],
    'the row points from the dependent to the one it depends on',
  );

  const timeline = await request<{ eventos: Event[] }>(
    ctx,
    'GET',
    `/v1/jobs/${dependent}/events`,
  );
  assert.equal(timeline.status, 200);
  const declared = timeline.body.eventos.filter(
    (event) => event.tipo === 'trabalho.dependencia_declarada',
  );
  assert.equal(declared.length, 1);
  assert.deepEqual(
    declared[0].entidade,
    { tipo: 'trabalho', id: dependent },
    'the subject of the event is the DEPENDENT job',
  );
  assert.deepEqual(declared[0].dados, { depende_de_trabalho_id: dependedOn });

  const other = await request<{ eventos: Event[] }>(
    ctx,
    'GET',
    `/v1/jobs/${dependedOn}/events`,
  );
  assert.deepEqual(
    other.body.eventos.map((event) => event.tipo),
    ['trabalho.criado'],
    'the job that is depended on has no event of its own about it',
  );
});

test('AT14 — confirming twice is 409 and does not duplicate anything', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    itens: [
      { ref: 'a', titulo: 'uma só vez', depende_de: ['b'] },
      { ref: 'b', titulo: 'a outra' },
    ],
  });

  const first = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(first.status, 201);
  assert.equal(countJobs(ctx), 2);

  const second = await request<ErrorResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.erro, 'rascunho_nao_pendente');

  assert.equal(countJobs(ctx), 2, 'the second confirmation created nothing');
  assert.equal(dependencyRows(ctx).length, 1);
  assert.deepEqual(
    (await request<DraftResponse>(ctx, 'GET', `/v1/intake/${draft.id}`)).body.rascunho
      .trabalhos_criados,
    first.body.rascunho.trabalhos_criados,
    'the map of the first confirmation is the one that stands',
  );
});

test('AT15 — trabalho.criado of a confirmed job carries corpo and criterios_de_aceite', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    itens: [
      {
        ref: 'a',
        titulo: 'Ficha com conteúdo',
        corpo: 'O que ela pede, em prosa.',
        criterios_de_aceite: ['o teste de aceite existe'],
      },
    ],
  });

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(response.status, 201);
  const jobId = response.body.trabalhos[0].id;

  const timeline = await request<{ eventos: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(timeline.status, 200);
  const created = timeline.body.eventos.find((event) => event.tipo === 'trabalho.criado');
  assert.ok(created !== undefined, 'the creation is in the log');
  assert.deepEqual(created.dados, {
    titulo: 'Ficha com conteúdo',
    no_entrada_id: entryNode(),
    corpo: 'O que ela pede, em prosa.',
    criterios_de_aceite: ['o teste de aceite existe'],
    campos: null,
  });
});

/**
 * t168 — the class's declared fields cross the confirmation gate.
 *
 * The interesting half is the LOG: the projection carrying `campos` and the
 * `trabalho.criado` carrying the same map is what makes the value replayable,
 * and a field that only reached the table would be state the log cannot explain.
 */
test('t168 — confirming a draft carries each item\'s campos into the job and into the log', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const filled = { premise_source: 'relatório trimestral 2026Q2', downside: -12.5, upside: 40 };
  const draft = await createDraft(ctx, {
    itens: [
      { ref: 'a', titulo: 'A tese do cobre', campos: filled },
      { ref: 'b', titulo: 'Sem campo nenhum' },
    ],
  });
  assert.deepEqual(draft.itens[0].campos, filled, 'the draft already stores them');
  assert.equal(draft.itens[1].campos, null);

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(response.status, 201);

  const [withFields, without] = response.body.trabalhos;
  assert.deepEqual(withFields.campos, filled);
  assert.equal(without.campos, null, 'an item with no field creates a job with null, never {}');

  const timeline = await request<{ eventos: Event[] }>(
    ctx,
    'GET',
    `/v1/jobs/${withFields.id}/events`,
  );
  assert.equal(timeline.status, 200);
  const created = timeline.body.eventos.find((event) => event.tipo === 'trabalho.criado');
  assert.ok(created !== undefined, 'the creation is in the log');
  assert.deepEqual(created.dados.campos, filled);
});

test('AT16 — confirming a draft creates no grafo_versao and moves no pointer', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const before = await versions(ctx, CLASS);
  assert.equal(before.length, 1, 'the class starts with exactly the version it was registered on');
  const pointerBefore = (
    await request<{ grafo: { versao_corrente_id: string } }>(ctx, 'GET', `/v1/graphs/${CLASS}`)
  ).body.grafo.versao_corrente_id;

  const draft = await createDraft(ctx, {
    pedido: 'o pedido inteiro, em linguagem natural',
    itens: [
      { ref: 'a', titulo: 'Primeira', depende_de: ['b'] },
      { ref: 'b', titulo: 'Segunda' },
      { ref: 'c', titulo: 'Terceira', depende_de: ['a'] },
    ],
  });

  const confirmed = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.trabalhos.length, 3);

  const after = await versions(ctx, CLASS);
  assert.deepEqual(after, before, 'the version chain is the same list, byte for byte (D3)');
  assert.equal(
    (await request<{ grafo: { versao_corrente_id: string } }>(ctx, 'GET', `/v1/graphs/${CLASS}`))
      .body.grafo.versao_corrente_id,
    pointerBefore,
    'the pointer did not move',
  );

  const everyVersion = ctx.db.prepare('SELECT COUNT(*) AS total FROM grafo_versao').get() as {
    total: number;
  };
  assert.equal(everyVersion.total, 1, 'no version in ANY lineage, not just in this one');
});

test('FR6 — GET /v1/intake lists drafts, with filters, and 404s on a stranger', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const pending = await createDraft(ctx, { itens: [{ ref: 'a', titulo: 'pendente' }] });
  const discarded = await createDraft(ctx, { itens: [{ ref: 'a', titulo: 'descartado' }] });
  await request(ctx, 'POST', `/v1/intake/${discarded.id}/discards`, {});

  const all = await request<{ rascunhos: Draft[] }>(ctx, 'GET', '/v1/intake');
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.rascunhos.map((row) => row.id),
    [pending.id, discarded.id],
  );

  const onlyPending = await request<{ rascunhos: Draft[] }>(
    ctx,
    'GET',
    '/v1/intake?status=pendente',
  );
  assert.deepEqual(
    onlyPending.body.rascunhos.map((row) => row.id),
    [pending.id],
  );

  const byClass = await request<{ rascunhos: Draft[] }>(
    ctx,
    'GET',
    '/v1/intake?classe=classe-que-ninguem-registrou',
  );
  assert.deepEqual(byClass.body.rascunhos, []);

  const byProject = await request<{ rascunhos: Draft[] }>(
    ctx,
    'GET',
    `/v1/intake?projeto_id=${pending.projeto_id}`,
  );
  assert.equal(byProject.body.rascunhos.length, 2);

  const stranger = await request<ErrorResponse>(ctx, 'GET', `/v1/intake/${pending.id + 999}`);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.erro, 'rascunho_desconhecido');

  for (const [method, routePath] of [
    ['PATCH', `/v1/intake/${pending.id + 999}`],
    ['POST', `/v1/intake/${pending.id + 999}/discards`],
    ['POST', `/v1/intake/${pending.id + 999}/confirmations`],
  ] as const) {
    const response = await request<ErrorResponse>(ctx, method, routePath, {
      itens: [{ ref: 'a', titulo: 'x' }],
    });
    assert.equal(response.status, 404, `${method} ${routePath} should be 404`);
    assert.equal(response.body.erro, 'rascunho_desconhecido');
  }
});

/* ---------------------------------------------------------------------------
 * t139 — the confirmation gate answers a bad envelope like the rest of the API.
 * ------------------------------------------------------------------------ */

/**
 * The validation envelope of [`routes/common.ts`](../src/routes/common.ts) —
 * English keys, unlike the intake's own `erro` bodies.
 *
 * The two shapes live side by side on purpose and this file asserts both: the
 * intake's OWN refusals (an unknown class, a malformed item, a draft that is no
 * longer pending) are its Portuguese wire vocabulary, while a broken EVENT
 * envelope is refused by the same `validateEvent` that serves every other route,
 * and so has to come back in the same words it comes back for them (t127, FR7).
 */
interface ValidationFailure {
  error: string;
  details?: string[];
}

/** A malformed `ator`: a bare string where the envelope demands `{tipo, ref}`. */
const MALFORMED_ACTOR = 'tester';

/** The one message `validateActor` produces for it. */
const MALFORMED_ACTOR_DETAIL = 'ator has to be an object {tipo, ref}';

test('t139 — a malformed ator on the confirmation is 400 validation_failed, not 500', async (t) => {
  requireArtifacts(...ARTIFACTS, 'src/routes/common.ts');
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    itens: [
      { ref: 'a', titulo: 'a primeira', depende_de: ['b'] },
      { ref: 'b', titulo: 'a segunda' },
    ],
  });

  const eventsBefore = countEvents(ctx);

  const response = await request<ValidationFailure>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { ator: MALFORMED_ACTOR },
  );

  assert.equal(
    response.status,
    400,
    'a body the caller can fix is a 400, never a 500 leaking the domain validator',
  );
  assert.equal(response.body.error, 'validation_failed');
  assert.deepEqual(response.body.details, [MALFORMED_ACTOR_DETAIL]);

  // The gate refused; nothing on the other side of it exists.
  assert.equal(countJobs(ctx), 0, 'a refused confirmation creates no traveller');
  assert.equal(dependencyRows(ctx).length, 0);
  assert.equal(countEvents(ctx), eventsBefore, 'and writes no line to the log');

  const stored = await request<DraftResponse>(ctx, 'GET', `/v1/intake/${draft.id}`);
  assert.equal(stored.body.rascunho.status, 'pendente', 'the draft is still open');
  assert.equal(stored.body.rascunho.trabalhos_criados, null);

  // ...and still confirmable, which is what makes the 400 honest: whoever sends
  // the envelope right the second time gets the batch they asked for.
  const retry = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { ator: { tipo: 'usuario', ref: 'rafael' } },
  );
  assert.equal(retry.status, 201);
  assert.equal(retry.body.trabalhos.length, 2);
});

test('t139 — the confirmation and POST /v1/jobs refuse the same ator in the same words', async (t) => {
  requireArtifacts(...ARTIFACTS, 'src/routes/common.ts');
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, { itens: [{ ref: 'a', titulo: 'uma ficha' }] });

  const confirmation = await request<ValidationFailure>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { ator: MALFORMED_ACTOR },
  );
  const job = await request<ValidationFailure>(ctx, 'POST', '/v1/jobs', {
    titulo: 'uma ficha à mão',
    no_entrada_id: entryNode(),
    ator: MALFORMED_ACTOR,
  });

  assert.equal(job.status, 400, 'the reference behaviour this ticket converges on');
  assert.equal(confirmation.status, job.status);
  assert.deepEqual(
    confirmation.body,
    job.body,
    'the same broken envelope, refused by the same validator, in the same body',
  );
});

test('t180 — the intake refusals are English prose around Portuguese wire keys', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const missing = await request<{ erro: string; mensagem: string }>(ctx, 'POST', '/v1/intake', {
    itens: [{ ref: 'a', titulo: 'uma ficha' }],
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.erro, 'campo_obrigatorio_ausente', 'the code is frozen (FR2)');
  assert.equal(missing.body.mensagem, '"classe" and "pedido" are required texts');

  const cycle = await request<{ problemas: { codigo: string; mensagem: string }[] }>(
    ctx,
    'POST',
    '/v1/intake',
    {
      classe: CLASS,
      pedido: 'quebrar o pedido em fichas',
      itens: [
        { ref: 'a', titulo: 'a', depende_de: ['b'] },
        { ref: 'b', titulo: 'b', depende_de: ['a'] },
      ],
    },
  );
  assert.equal(cycle.status, 400);
  assert.equal(
    cycle.body.problemas.find((problem) => problem.codigo === 'ciclo_de_dependencia')?.mensagem,
    'the dependencies close a cycle: a → b → a',
  );
});
