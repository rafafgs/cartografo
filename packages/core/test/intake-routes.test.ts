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
 * (`factory-graphs/software-development/grafo.json`), with no editing:
 * a synthetic graph would not prove that the jobs are born on the entry node of
 * the version that really holds today.
 *
 * AT16 is the ticket's original acceptance criterion and the one that guards
 * D3's "the path stays frozen": confirming a draft creates travellers and NEVER
 * a new `grafo_versao`, in any class.
 *
 * The JSON field names are English: the envelope converged with t226 and the
 * item's own keys with t255, which is D20 read as written — the fields of the
 * API's JSON travel in English, and `DraftItem` travels in the body of
 * `POST /v1/intake`.
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
  resolvePins,
  startControlPlane,
  type Event,
  type Job,
  type TestContext,
} from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const FACTORY_GRAPH = path.join(
  REPO_ROOT,
  'factory-graphs',
  'software-development',
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
  title: string;
  body: string | null;
  acceptance_criteria: string[] | null;
  /** The class's declared fields, filled in at intake (t168). */
  fields: Record<string, string | number | boolean> | null;
  /** The triage tier the session proposed (t175); `null` when nobody classified it. */
  tier: 'trivial' | 'standard' | null;
  depends_on: string[];
}

/** Draft projection, as the API returns it. */
interface Draft {
  id: number;
  project_id: number;
  execution_id: number | null;
  class: string;
  request: string;
  /**
   * The proposed breakdown.
   *
   * `DraftItem`'s own keys are English since t255. They are fields of the API's
   * JSON — D20's own words — and the glossary maps them in §1.7; the envelope
   * around them had already moved with t226 (FR1).
   */
  items: DraftItem[];
  status: string;
  created_jobs: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

/** The job projection with the two columns this ticket adds. */
interface JobWithContent extends Job {
  body: string | null;
  acceptance_criteria: string[] | null;
  fields: Record<string, string | number | boolean> | null;
  /** The triage tier carried over from the item (t175). */
  tier: 'trivial' | 'standard' | null;
}

interface DraftResponse {
  draft: Draft;
}

interface ConfirmationResponse {
  draft: Draft;
  jobs: JobWithContent[];
}

interface ErrorResponse {
  error: string;
  problems?: Array<{ code: string; message: string; target: unknown }>;
}

interface VersionRow {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
}

/** The class of factory bundle 1 — the one every test here breaks work down for. */
const CLASS = 'software-development';

/** Entry node of that graph. Read from the document, never hardcoded twice. */
function entryNode(): string {
  const document = JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')) as { initial_node: string };
  return document.initial_node;
}

/** Registers factory bundle 1 as it is on disk and returns the current version. */
async function registerFactoryGraph(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')) as Record<string, unknown>;
  // The bundle's five manifests are not registered here (this suite is about the
  // intake, not about `cartografo import`), so without this the version would be
  // `unchecked` and the jobs the intake creates would be refused (t283).
  await resolvePins(ctx, document);

  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  return response.body.graph_version.id;
}

/** How many drafts exist in the table — the "nothing was written" probe. */
function countDrafts(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM intake_draft').get() as {
    total: number;
  };
  return row.total;
}

/** How many jobs exist in the table. */
function countJobs(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM job').get() as { total: number };
  return row.total;
}

/** The declared dependency edges, as rows. */
function dependencyRows(
  ctx: TestContext,
): Array<{ job_id: number; depends_on_job_id: number }> {
  return ctx.db
    .prepare('SELECT job_id, depends_on_job_id FROM job_dependency ORDER BY id')
    .all() as Array<{ job_id: number; depends_on_job_id: number }>;
}

/** The version chain of a lineage, straight from the API. */
async function versions(ctx: TestContext, graphId: string): Promise<VersionRow[]> {
  const response = await request<{ versions: VersionRow[] }>(
    ctx,
    'GET',
    `/v1/graphs/${graphId}/versions`,
  );
  assert.equal(response.status, 200);
  return response.body.versions;
}

/** Shortcut: opens a pending draft over the factory class. */
async function createDraft(
  ctx: TestContext,
  body: Record<string, unknown>,
): Promise<Draft> {
  const response = await request<DraftResponse>(ctx, 'POST', '/v1/intake', {
    class: CLASS,
    request: 'quebrar o pedido em fichas',
    ...body,
  });
  assert.equal(response.status, 201, `POST /v1/intake returned ${response.status}`);
  return response.body.draft;
}

test('AT7 — a class with no registered base graph is 404 and writes nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    class: 'classe-que-ninguem-registrou',
    request: 'um pedido qualquer',
    items: [{ ref: 'a', title: 'uma ficha' }],
  });

  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'unknown_graph');
  assert.equal(countDrafts(ctx), 0, 'a draft over a class that does not exist is never written');
});

test('AT8 — POST /v1/intake with 2 independent items opens a pending draft', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const response = await request<DraftResponse>(ctx, 'POST', '/v1/intake', {
    class: CLASS,
    request: 'dar ao intake uma API de duas fases',
    execution_id: 7,
    items: [
      {
        ref: 'migracao',
        title: 'Migração 0005',
        body: 'Colunas novas em trabalho e as duas tabelas do intake.',
        acceptance_criteria: ['a migração roda do zero'],
      },
      { ref: 'rotas', title: 'Rotas de rascunho e confirmação' },
    ],
  });

  assert.equal(response.status, 201);
  const draft = response.body.draft;
  assert.ok(Number.isInteger(draft.id) && draft.id >= 1, 'id assigned by the server');
  assert.equal(draft.status, 'pending');
  assert.equal(draft.class, CLASS);
  assert.equal(draft.execution_id, 7);
  assert.ok(Number.isInteger(draft.project_id));
  assert.equal(draft.created_jobs, null, 'nothing is created until somebody confirms');
  assert.deepEqual(
    draft.items.map((item) => item.ref),
    ['migracao', 'rotas'],
  );
  assert.deepEqual(draft.items[0].acceptance_criteria, ['a migração roda do zero']);
  assert.equal(draft.items[1].body, null);
  assert.deepEqual(draft.items[1].depends_on, []);

  assert.equal(countJobs(ctx), 0, 'a draft is a proposal, not a job');

  const stored = await request<DraftResponse>(ctx, 'GET', `/v1/intake/${draft.id}`);
  assert.equal(stored.status, 200);
  assert.deepEqual(stored.body.draft, draft, 'what comes back is what was stored');
});

test('AT9 — a malformed item is 400 with the WHOLE list of problems and writes nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    class: CLASS,
    request: 'um lote torto',
    items: [
      { ref: 'a', title: '' },
      { ref: 'a', title: 'ref repetido' },
      { ref: 'c', title: 'depende do nada', depends_on: ['fantasma'] },
    ],
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_items');
  const problems = response.body.problems ?? [];
  assert.deepEqual(
    problems.map((problem) => problem.code).sort(),
    ['duplicate_ref', 'missing_required_field', 'unknown_dependency'],
    'three problems in, three problems out — never only the first',
  );
  for (const problem of problems) {
    assert.ok(problem.message.length > 0, 'every problem explains itself');
    // t255 — the report inside the 400 is the API's JSON, so its own keys are
    // the English of `glossario-wire.md` §1.4, like the graph report's since t230.
    assert.deepEqual(Object.keys(problem).sort(), ['code', 'message', 'target']);
  }
  assert.equal(countDrafts(ctx), 0);
});

test('t255 — an item sent with the retired Portuguese keys is refused, never half-read', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    class: CLASS,
    request: 'um lote na grafia antiga',
    items: [{ ref: 'migracao', titulo: 'Migração 0005', corpo: 'as duas tabelas' }],
  });

  assert.equal(response.status, 400, 'the old spelling is not a synonym of the new one');
  assert.equal(response.body.error, 'invalid_items');
  assert.deepEqual(
    (response.body.problems ?? []).map((problem) => problem.code),
    ['missing_required_field'],
  );
  assert.equal(countDrafts(ctx), 0, 'nothing is written out of a batch nobody can read');
});

test('AT9 — class and request are required', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  for (const body of [
    { request: 'sem classe', items: [{ ref: 'a', title: 'x' }] },
    { class: CLASS, items: [{ ref: 'a', title: 'x' }] },
    { class: CLASS, request: '   ', items: [{ ref: 'a', title: 'x' }] },
  ]) {
    const response = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error, 'missing_required_field');
  }

  const withoutItems = await request<ErrorResponse>(ctx, 'POST', '/v1/intake', {
    class: CLASS,
    request: 'sem itens',
  });
  assert.equal(withoutItems.status, 400);
  assert.equal(withoutItems.body.error, 'invalid_items');

  assert.equal(countDrafts(ctx), 0);
});

test('AT10 — PATCH replaces items while pending, and is 409 once the draft is closed', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, { items: [{ ref: 'a', title: 'primeira ideia' }] });

  const amended = await request<DraftResponse>(ctx, 'PATCH', `/v1/intake/${draft.id}`, {
    items: [
      { ref: 'a', title: 'ideia melhor' },
      { ref: 'b', title: 'e mais uma', depends_on: ['a'] },
    ],
  });
  assert.equal(amended.status, 200);
  assert.equal(amended.body.draft.status, 'pending');
  assert.deepEqual(
    amended.body.draft.items.map((item) => item.title),
    ['ideia melhor', 'e mais uma'],
    'the list is REPLACED, not merged',
  );
  assert.deepEqual(amended.body.draft.items[1].depends_on, ['a']);
  assert.ok(
    amended.body.draft.updated_at >= draft.updated_at,
    'amending stamps atualizado_em',
  );

  const broken = await request<ErrorResponse>(ctx, 'PATCH', `/v1/intake/${draft.id}`, {
    items: [{ ref: 'a', title: 'a', depends_on: ['a'] }],
  });
  assert.equal(broken.status, 400, 'the amendment suffers the same validation as the creation');
  assert.equal(broken.body.error, 'invalid_items');

  const confirmed = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(confirmed.status, 201);

  const late = await request<ErrorResponse>(ctx, 'PATCH', `/v1/intake/${draft.id}`, {
    items: [{ ref: 'a', title: 'tarde demais' }],
  });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, 'draft_not_pending');

  const discarded = await createDraft(ctx, { items: [{ ref: 'a', title: 'descartável' }] });
  assert.equal(
    (await request(ctx, 'POST', `/v1/intake/${discarded.id}/discards`, {})).status,
    200,
  );
  const overDiscarded = await request<ErrorResponse>(ctx, 'PATCH', `/v1/intake/${discarded.id}`, {
    items: [{ ref: 'a', title: 'também tarde' }],
  });
  assert.equal(overDiscarded.status, 409);
  assert.equal(overDiscarded.body.error, 'draft_not_pending');
});

test('AT11 — discarding closes the draft, twice is 409, and no job is ever created', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    items: [
      { ref: 'a', title: 'ficha que não vai existir' },
      { ref: 'b', title: 'nem esta', depends_on: ['a'] },
    ],
  });

  const first = await request<DraftResponse>(ctx, 'POST', `/v1/intake/${draft.id}/discards`, {});
  assert.equal(first.status, 200);
  assert.equal(first.body.draft.status, 'discarded');
  assert.equal(first.body.draft.created_jobs, null);

  const second = await request<ErrorResponse>(ctx, 'POST', `/v1/intake/${draft.id}/discards`, {});
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'draft_not_pending');

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
    execution_id: 9,
    items: [
      {
        ref: 'a',
        title: 'Primeira ficha',
        body: 'O corpo preliminar da primeira.',
        acceptance_criteria: ['npm test passa', 'npm run lint passa'],
      },
      { ref: 'b', title: 'Segunda ficha' },
    ],
  });

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { actor: { type: 'user', ref: 'rafael' } },
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.draft.status, 'confirmed');
  assert.ok(
    response.body.draft.updated_at >= draft.updated_at,
    'confirming stamps atualizado_em',
  );

  const jobs = response.body.jobs;
  assert.equal(jobs.length, 2, 'one trabalho per item, all of them in the answer');
  assert.deepEqual(
    response.body.draft.created_jobs,
    { a: jobs[0].id, b: jobs[1].id },
    'trabalhos_criados maps every ref to the real id',
  );

  const start = entryNode();
  for (const job of jobs) {
    assert.equal(job.current_node_id, start, 'every traveller is born on the entry node in force');
    assert.equal(job.entry_node_id, start);
    assert.equal(job.graph_version_id, versionId, 'frozen on the version that holds today');
    assert.equal(job.execution_id, 9, 'the whole batch shares the draft execution');
    assert.equal(job.blocked, false, 'declaring a dependency does not block anybody (FR14)');
  }

  assert.equal(jobs[0].title, 'Primeira ficha');
  assert.equal(jobs[0].body, 'O corpo preliminar da primeira.');
  assert.deepEqual(jobs[0].acceptance_criteria, ['npm test passa', 'npm run lint passa']);
  assert.equal(jobs[1].body, null, 'an item with no body stores null, not an empty string');
  assert.equal(jobs[1].acceptance_criteria, null);

  const board = await request<{ jobs: JobWithContent[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(board.status, 200);
  assert.equal(board.body.jobs.length, 2, 'the projection has the same two');
  assert.equal(board.body.jobs[0].body, 'O corpo preliminar da primeira.');
  assert.deepEqual(dependencyRows(ctx), [], 'no dependency was declared in this batch');
});

/**
 * t175 — a mixed-tier batch produces jobs carrying the matching tier each.
 *
 * The batch is the interesting case, not the single item: the tier is chosen
 * per ITEM by the one intake session that already runs, so what has to hold is
 * that `confirmDraft` carries each item's own classification onto its own job
 * instead of collapsing the batch onto one value. The third item pins the rule
 * that makes the whole thing safe to ship — an item nobody triaged becomes a
 * job with `tier: null`, and nothing about pre-existing job creation changes.
 */
test('t175 — confirming a mixed-tier batch carries each item tier onto its own job', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    items: [
      { ref: 'renomear', title: 'Renomear a coluna', tier: 'trivial' },
      { ref: 'feature', title: 'A feature inteira', tier: 'standard' },
      { ref: 'sem-triagem', title: 'Ninguém triou esta' },
    ],
  });

  assert.deepEqual(
    draft.items.map((item) => item.tier),
    ['trivial', 'standard', null],
    'the draft itself keeps the classification the session proposed',
  );

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );

  assert.equal(response.status, 201);
  assert.deepEqual(
    response.body.jobs.map((job) => job.tier),
    ['trivial', 'standard', null],
    'each job carries the tier of the item it was born from',
  );

  const board = await request<{ jobs: JobWithContent[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(board.status, 200);
  assert.deepEqual(
    board.body.jobs.map((job) => job.tier),
    ['trivial', 'standard', null],
    'and the projection the runner reads shows the same three',
  );
});

test('AT13 — a declared dependency becomes one row and one event, resolved to real ids', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    items: [
      { ref: 'a', title: 'depende', depends_on: ['b'] },
      { ref: 'b', title: 'é dependido' },
    ],
  });

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(response.status, 201);

  const map = response.body.draft.created_jobs ?? {};
  const dependent = map.a;
  const dependedOn = map.b;
  assert.ok(Number.isInteger(dependent) && Number.isInteger(dependedOn));

  assert.deepEqual(
    dependencyRows(ctx),
    [{ job_id: dependent, depends_on_job_id: dependedOn }],
    'the row points from the dependent to the one it depends on',
  );

  const timeline = await request<{ events: Event[] }>(
    ctx,
    'GET',
    `/v1/jobs/${dependent}/events`,
  );
  assert.equal(timeline.status, 200);
  const declared = timeline.body.events.filter(
    (event) => event.type === 'job.dependency_declared',
  );
  assert.equal(declared.length, 1);
  assert.deepEqual(
    declared[0].entity,
    { type: 'job', id: dependent },
    'the subject of the event is the DEPENDENT job',
  );
  assert.deepEqual(declared[0].data, { depends_on_job_id: dependedOn });

  const other = await request<{ events: Event[] }>(
    ctx,
    'GET',
    `/v1/jobs/${dependedOn}/events`,
  );
  assert.deepEqual(
    other.body.events.map((event) => event.type),
    ['job.created'],
    'the job that is depended on has no event of its own about it',
  );
});

test('AT14 — confirming twice is 409 and does not duplicate anything', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    items: [
      { ref: 'a', title: 'uma só vez', depends_on: ['b'] },
      { ref: 'b', title: 'a outra' },
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
  assert.equal(second.body.error, 'draft_not_pending');

  assert.equal(countJobs(ctx), 2, 'the second confirmation created nothing');
  assert.equal(dependencyRows(ctx).length, 1);
  assert.deepEqual(
    (await request<DraftResponse>(ctx, 'GET', `/v1/intake/${draft.id}`)).body.draft
      .created_jobs,
    first.body.draft.created_jobs,
    'the map of the first confirmation is the one that stands',
  );
});

test('AT15 — job.created of a confirmed job carries body and acceptance_criteria', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    items: [
      {
        ref: 'a',
        title: 'Ficha com conteúdo',
        body: 'O que ela pede, em prosa.',
        acceptance_criteria: ['o teste de aceite existe'],
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
  const jobId = response.body.jobs[0].id;

  const timeline = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(timeline.status, 200);
  const created = timeline.body.events.find((event) => event.type === 'job.created');
  assert.ok(created !== undefined, 'the creation is in the log');
  assert.deepEqual(created.data, {
    title: 'Ficha com conteúdo',
    entry_node_id: entryNode(),
    body: 'O que ela pede, em prosa.',
    acceptance_criteria: ['o teste de aceite existe'],
    fields: null,
    // The batch this test confirms declared no tier (t175), and an item nobody
    // triaged reaches the log as an explicit `null` — the same normalization
    // the three fields above already get.
    tier: null,
  });
});

/**
 * t168 — the class's declared fields cross the confirmation gate.
 *
 * The interesting half is the LOG: the projection carrying `fields` and the
 * `job.created` carrying the same map is what makes the value replayable,
 * and a field that only reached the table would be state the log cannot explain.
 */
test('t168 — confirming a draft carries each item\'s fields into the job and into the log', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const filled = { premise_source: 'relatório trimestral 2026Q2', downside: -12.5, upside: 40 };
  const draft = await createDraft(ctx, {
    items: [
      { ref: 'a', title: 'A tese do cobre', fields: filled },
      { ref: 'b', title: 'Sem campo nenhum' },
    ],
  });
  assert.deepEqual(draft.items[0].fields, filled, 'the draft already stores them');
  assert.equal(draft.items[1].fields, null);

  const response = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(response.status, 201);

  const [withFields, without] = response.body.jobs;
  assert.deepEqual(withFields.fields, filled);
  assert.equal(without.fields, null, 'an item with no field creates a job with null, never {}');

  const timeline = await request<{ events: Event[] }>(
    ctx,
    'GET',
    `/v1/jobs/${withFields.id}/events`,
  );
  assert.equal(timeline.status, 200);
  const created = timeline.body.events.find((event) => event.type === 'job.created');
  assert.ok(created !== undefined, 'the creation is in the log');
  assert.deepEqual(created.data.fields, filled);
});

test('AT16 — confirming a draft creates no graph version and moves no pointer', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const before = await versions(ctx, CLASS);
  assert.equal(before.length, 1, 'the class starts with exactly the version it was registered on');
  const pointerBefore = (
    await request<{ graph: { current_version_id: string } }>(ctx, 'GET', `/v1/graphs/${CLASS}`)
  ).body.graph.current_version_id;

  const draft = await createDraft(ctx, {
    request: 'o pedido inteiro, em linguagem natural',
    items: [
      { ref: 'a', title: 'Primeira', depends_on: ['b'] },
      { ref: 'b', title: 'Segunda' },
      { ref: 'c', title: 'Terceira', depends_on: ['a'] },
    ],
  });

  const confirmed = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
  );
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.jobs.length, 3);

  const after = await versions(ctx, CLASS);
  assert.deepEqual(after, before, 'the version chain is the same list, byte for byte (D3)');
  assert.equal(
    (await request<{ graph: { current_version_id: string } }>(ctx, 'GET', `/v1/graphs/${CLASS}`))
      .body.graph.current_version_id,
    pointerBefore,
    'the pointer did not move',
  );

  const everyVersion = ctx.db.prepare('SELECT COUNT(*) AS total FROM graph_version').get() as {
    total: number;
  };
  assert.equal(everyVersion.total, 1, 'no version in ANY lineage, not just in this one');
});

test('FR6 — GET /v1/intake lists drafts, with filters, and 404s on a stranger', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const pending = await createDraft(ctx, { items: [{ ref: 'a', title: 'pendente' }] });
  const discarded = await createDraft(ctx, { items: [{ ref: 'a', title: 'descartado' }] });
  await request(ctx, 'POST', `/v1/intake/${discarded.id}/discards`, {});

  const all = await request<{ drafts: Draft[] }>(ctx, 'GET', '/v1/intake');
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.drafts.map((row) => row.id),
    [pending.id, discarded.id],
  );

  const onlyPending = await request<{ drafts: Draft[] }>(
    ctx,
    'GET',
    '/v1/intake?status=pending',
  );
  assert.deepEqual(
    onlyPending.body.drafts.map((row) => row.id),
    [pending.id],
  );

  const byClass = await request<{ drafts: Draft[] }>(
    ctx,
    'GET',
    '/v1/intake?class=classe-que-ninguem-registrou',
  );
  assert.deepEqual(byClass.body.drafts, []);

  const byProject = await request<{ drafts: Draft[] }>(
    ctx,
    'GET',
    `/v1/intake?project_id=${pending.project_id}`,
  );
  assert.equal(byProject.body.drafts.length, 2);

  const stranger = await request<ErrorResponse>(ctx, 'GET', `/v1/intake/${pending.id + 999}`);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.error, 'unknown_draft');

  for (const [method, routePath] of [
    ['PATCH', `/v1/intake/${pending.id + 999}`],
    ['POST', `/v1/intake/${pending.id + 999}/discards`],
    ['POST', `/v1/intake/${pending.id + 999}/confirmations`],
  ] as const) {
    const response = await request<ErrorResponse>(ctx, method, routePath, {
      items: [{ ref: 'a', title: 'x' }],
    });
    assert.equal(response.status, 404, `${method} ${routePath} should be 404`);
    assert.equal(response.body.error, 'unknown_draft');
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
 * longer pending) are its own report vocabulary, while a broken EVENT
 * envelope is refused by the same `validateEvent` that serves every other route,
 * and so has to come back in the same words it comes back for them (t127, FR7).
 */
interface ValidationFailure {
  error: string;
  details?: string[];
}

/** A malformed `actor`: a bare string where the envelope demands `{type, ref}`. */
const MALFORMED_ACTOR = 'tester';

/** The one message `validateActor` produces for it. */
const MALFORMED_ACTOR_DETAIL = 'actor has to be an object {type, ref}';

test('t139 — a malformed actor on the confirmation is 400 validation_failed, not 500', async (t) => {
  requireArtifacts(...ARTIFACTS, 'src/routes/common.ts');
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, {
    items: [
      { ref: 'a', title: 'a primeira', depends_on: ['b'] },
      { ref: 'b', title: 'a segunda' },
    ],
  });

  const eventsBefore = countEvents(ctx);

  const response = await request<ValidationFailure>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { actor: MALFORMED_ACTOR },
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
  assert.equal(stored.body.draft.status, 'pending', 'the draft is still open');
  assert.equal(stored.body.draft.created_jobs, null);

  // ...and still confirmable, which is what makes the 400 honest: whoever sends
  // the envelope right the second time gets the batch they asked for.
  const retry = await request<ConfirmationResponse>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { actor: { type: 'user', ref: 'rafael' } },
  );
  assert.equal(retry.status, 201);
  assert.equal(retry.body.jobs.length, 2);
});

test('t139 — the confirmation and POST /v1/jobs refuse the same actor in the same words', async (t) => {
  requireArtifacts(...ARTIFACTS, 'src/routes/common.ts');
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const draft = await createDraft(ctx, { items: [{ ref: 'a', title: 'uma ficha' }] });

  const confirmation = await request<ValidationFailure>(
    ctx,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    { actor: MALFORMED_ACTOR },
  );
  const job = await request<ValidationFailure>(ctx, 'POST', '/v1/jobs', {
    title: 'uma ficha à mão',
    entry_node_id: entryNode(),
    actor: MALFORMED_ACTOR,
  });

  assert.equal(job.status, 400, 'the reference behaviour this ticket converges on');
  assert.equal(confirmation.status, job.status);
  assert.deepEqual(
    confirmation.body,
    job.body,
    'the same broken envelope, refused by the same validator, in the same body',
  );
});

test('t180 — the intake refusals are English prose in the one envelope', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await registerFactoryGraph(ctx);

  const missing = await request<{ error: string; message: string }>(ctx, 'POST', '/v1/intake', {
    items: [{ ref: 'a', title: 'uma ficha' }],
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'missing_required_field', 'the code is frozen (FR2)');
  assert.equal(missing.body.message, '"class" and "request" are required texts');

  const cycle = await request<{ problems: { code: string; message: string }[] }>(
    ctx,
    'POST',
    '/v1/intake',
    {
      class: CLASS,
      request: 'quebrar o pedido em fichas',
      items: [
        { ref: 'a', title: 'a', depends_on: ['b'] },
        { ref: 'b', title: 'b', depends_on: ['a'] },
      ],
    },
  );
  assert.equal(cycle.status, 400);
  assert.equal(
    cycle.body.problems.find((problem) => problem.code === 'dependency_cycle')?.message,
    'the dependencies close a cycle: a → b → a',
  );
});
