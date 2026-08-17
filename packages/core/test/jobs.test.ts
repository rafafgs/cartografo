/**
 * Job acceptance tests (t102, AT1–AT7).
 *
 * The job is the "traveller" of the graph: it is born on an entry node, walks
 * through transitions, raises and lowers the blocked flag, and has its content
 * amended. Each of those facts is an event in the log (t98) — and it is the log,
 * not the table row, that these tests treat as the source of truth.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are in
 * English.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  T102_ARTIFACTS,
  countEvents,
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type Event,
  type Job,
  type TestContext,
} from './support.ts';

const ARTIFACTS = [
  T102_ARTIFACTS.migration,
  T102_ARTIFACTS.events,
  T102_ARTIFACTS.validation,
  T102_ARTIFACTS.jobRepository,
  T102_ARTIFACTS.jobRoutes,
];

/** The route that turns a graph document into a version with a snapshot. */
const GRAPH_ROUTES = 'src/routes/graphs.ts';

/**
 * The job projection with the column t175 adds.
 *
 * Local to this file, like `JobWithContent` in `intake-routes.test.ts`: the
 * shared `Job` of `support.ts` carries the columns every ficha shares, and
 * whoever adds one declares it where they assert on it.
 */
interface JobWithTier extends Job {
  tier: 'trivial' | 'standard' | null;
}

/**
 * The minimal example graph: entry node `redigir`, single final node `revisar`.
 *
 * The real document, not a fixture written here, for the same reason AT6 of
 * `graph-routes.test.ts` feeds the factory bundle in raw: what the derivation
 * below reads is the `final_nodes` of a snapshot that went through the
 * registration gate, and a hand-made snapshot would prove nothing about it.
 */
const MINIMAL_GRAPH = path.join(
  PACKAGE_ROOT,
  '..',
  '..',
  'schema',
  'exemplos',
  'grafo-valido-minimo.json',
);

/**
 * The job projection with the terminal flag this ticket adds (t152).
 *
 * Declared here and not in `support.ts` for the same reason the interfaces over
 * there are hand-written: this is the contract THIS file demands of the API.
 */
type JobProjection = Job & {
  completed: boolean;
  /** The class's declared fields, as this ticket filled them (t168). */
  fields: Record<string, string | number | boolean> | null;
};

/**
 * Registers the minimal example graph.
 *
 * @param ctx Control plane running.
 * @returns Id of the version born with the lineage — the one a job cites.
 */
async function registerMinimalGraph(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as unknown;
  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  return response.body.graph_version.id;
}

/**
 * Registers a variant of the minimal graph that demands one field at `redigir`
 * (t168).
 *
 * Its own `problem_class`, because the lineage is keyed by it and the class
 * `nota-curta` is already taken by the fixture above. `downside` rides along
 * declared but demanded by nobody: a definition with no `required_at` must not
 * block anything, and a gate that only ever saw demanding fields would never
 * prove it.
 */
async function registerGraphDemandingField(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  document.problem_class = 'nota-curta-com-campo';
  document.custom_fields = [
    { name: 'premise_source', type: 'string', required_at: 'redigir' },
    { name: 'downside', type: 'number', required_at: null },
  ];

  const response = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, `POST /v1/graphs returned ${response.status}`);
  return response.body.graph_version.id;
}

/** Reads one job's projection off the API. */
async function readJob(ctx: TestContext, id: number): Promise<JobProjection> {
  const response = await request<JobProjection>(ctx, 'GET', `/v1/jobs/${id}`);
  assert.equal(response.status, 200);
  return response.body;
}

/** Events of a job, in log order. */
async function timeline(ctx: TestContext, jobId: number): Promise<Event[]> {
  const response = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);
  return response.body.events;
}

test('AT1 — POST /v1/jobs creates the job and records trabalho.criado', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<Job>(ctx, 'POST', '/v1/jobs', {
    titulo: 'Entidades e API: trabalho, sessão, evento e pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  assert.equal(response.status, 201);
  const job = response.body;
  assert.ok(Number.isInteger(job.id) && job.id >= 1, 'id assigned by the server');
  assert.equal(job.current_node_id, 'entrada', 'current_node_id is born equal to entry_node_id');
  assert.equal(job.entry_node_id, 'entrada');
  assert.equal(job.blocked, false);
  assert.equal(job.block_reason, null);
  assert.equal(job.execution_id, 7);

  const events = await timeline(ctx, job.id);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.tipo, 'trabalho.criado');
  assert.ok(Number.isInteger(event.id) && event.id >= 1, 'the event id comes from the server');
  assert.deepEqual(event.entidade, { tipo: 'trabalho', id: job.id });
  assert.equal(event.execucao_id, 7);
  assert.ok(Number.isInteger(event.projeto_id));
  assert.ok(typeof event.ator.ref === 'string' && event.ator.ref.length > 0);
  assert.ok(['usuario', 'agente', 'sistema'].includes(event.ator.tipo));
  assert.ok(!Number.isNaN(Date.parse(event.ocorrido_em)), 'ocorrido_em is ISO 8601');
  assert.deepEqual(event.dados, {
    titulo: 'Entidades e API: trabalho, sessão, evento e pergunta',
    no_entrada_id: 'entrada',
    // The intake (t122) added two optional fields to the type's contract. A job
    // created by hand declares neither, and the payload normalizes them to an
    // explicit `null` — the taxonomy's rule for every optional field, the same
    // one `sessao.aberta` has always followed.
    corpo: null,
    criterios_de_aceite: null,
    // And a third since t168, by the same rule: the class's declared fields,
    // which a job created by hand did not fill either.
    campos: null,
    // And a fourth since t175: the triage tier. `null` is "nobody classified
    // this", and reading it as `trivial` would put every unclassified job on a
    // cheaper model than anyone chose.
    tier: null,
  });
});

/**
 * t175 — the triage tier travels with the job, in the projection AND in the fact.
 *
 * `tier` is part of `trabalho.criado` for the same reason `corpo` and
 * `criterios_de_aceite` are: a job that is born classified has that
 * classification as part of the fact, and a consumer replaying the log has to
 * reach the same tier the projection shows. No new route: the field rides the
 * projection `GET /v1/jobs` and `GET /v1/jobs/:id` already return, which is
 * what makes it joinable against `GET /v1/sessions` by `trabalho_id` (FR8) the
 * same way `packages/topografo-custo` already joins for `grafo_versao_id`.
 */
test('t175 — POST /v1/jobs round-trips tier through the projection and the fact', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<JobWithTier>(ctx, 'POST', '/v1/jobs', {
    titulo: 'Renomear uma variável',
    no_entrada_id: 'entrada',
    tier: 'trivial',
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.tier, 'trivial', 'the tier is on the projection the write answers');

  const read = await request<JobWithTier>(ctx, 'GET', `/v1/jobs/${response.body.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.tier, 'trivial', 'and survives the round trip through the column');

  const [event] = await timeline(ctx, response.body.id);
  assert.equal(event.tipo, 'trabalho.criado');
  assert.equal(event.dados.tier, 'trivial', 'the fact carries it too, not only the projection');

  const board = await request<{ jobs: JobWithTier[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(board.status, 200);
  assert.deepEqual(
    board.body.jobs.map((job) => job.tier),
    ['trivial'],
    'the list projection carries it as well — the join surface FR8 asks for',
  );
});

test('t175 — a tier outside the two declared values is refused before any write', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await request<{ erro: string }>(ctx, 'POST', '/v1/jobs', {
    titulo: 'urgência não é tier',
    no_entrada_id: 'entrada',
    tier: 'urgent',
  });

  assert.equal(refused.status, 400);

  const board = await request<{ jobs: JobWithTier[] }>(ctx, 'GET', '/v1/jobs');
  assert.deepEqual(board.body.jobs, [], 'a refused creation consumes no id and writes nothing');
});

test('AT2 — POST /v1/jobs/:id/transitions walks the graph and records trabalho.transicao', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'andar', no_entrada_id: 'entrada' });

  const first = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'implementacao',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.current_node_id, 'implementacao');

  const second = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'revisao',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.current_node_id, 'revisao');

  const transitions = (await timeline(ctx, job.id)).filter(
    (event) => event.tipo === 'trabalho.transicao',
  );
  assert.equal(transitions.length, 2);
  assert.deepEqual(
    transitions[0].dados,
    { de_no_id: null, para_no_id: 'implementacao' },
    'on the first transition the job leaves the entry node: de_no_id is null',
  );
  assert.deepEqual(transitions[1].dados, { de_no_id: 'implementacao', para_no_id: 'revisao' });
});

test('AT3 — block and unblock move the flag and record both events', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'parar', no_entrada_id: 'entrada' });

  const blocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    motivo: 'esperando resposta do humano',
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.blocked, true);
  assert.equal(blocked.body.block_reason, 'esperando resposta do humano');
  assert.equal(blocked.body.current_node_id, 'entrada', 'blocking does not move the job across nodes');

  const unblocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/unblocks`, {});
  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.body.blocked, false);
  assert.equal(unblocked.body.block_reason, null);

  const events = await timeline(ctx, job.id);
  const flags = events.filter((event) =>
    ['trabalho.bloqueado', 'trabalho.desbloqueado'].includes(event.tipo),
  );
  assert.deepEqual(
    flags.map((event) => event.tipo),
    ['trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  assert.deepEqual(flags[0].dados, { motivo: 'esperando resposta do humano' });
  assert.deepEqual(flags[1].dados, {}, 'the fact is the fall of the flag itself: no payload');
});

test('AT4 — PATCH /v1/jobs/:id amends the title and records only the field NAME', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'título velho', no_entrada_id: 'entrada' });

  const response = await request<Job>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    titulo: 'título novo, com segredo dentro',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'título novo, com segredo dentro');

  const amendments = (await timeline(ctx, job.id)).filter(
    (event) => event.tipo === 'trabalho.emendado',
  );
  assert.equal(amendments.length, 1);
  assert.deepEqual(amendments[0].dados, { campos_alterados: ['titulo'] });
  assert.ok(
    !JSON.stringify(amendments[0].dados).includes('segredo'),
    'the log says what was touched, never the new content (taxonomy: audit record)',
  );
});

test('t157 — PATCH /v1/jobs/:id without a usable titulo is 422, never a 500', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'título velho', no_entrada_id: 'entrada' });
  const before = countEvents(ctx);

  // `campos_alterados: ['titulo']` is well-formed whatever comes in the body, so
  // until t157 the payload validation passed and the UPDATE bound `undefined` —
  // the driver threw and Fastify answered 500. What is written is what has to be
  // validated.
  for (const body of [{}, { titulo: null }, { titulo: '' }, { titulo: 7 }] as const) {
    const response = await request<{ error: string; details: string[] }>(
      ctx,
      'PATCH',
      `/v1/jobs/${job.id}`,
      body,
    );
    assert.equal(response.status, 422, `PATCH with ${JSON.stringify(body)} should be a 422`);
    assert.equal(response.body.error, 'validation_failed');
    assert.ok(
      response.body.details.some((detail) => detail.includes('titulo')),
      `the 422 has to name the offending field: ${JSON.stringify(response.body.details)}`,
    );
  }

  const literalNull = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/jobs/${job.id}`,
    null,
  );
  assert.equal(literalNull.status, 422, 'a body that IS null is a refusal, not a crash');
  assert.ok(literalNull.body.details.some((detail) => detail.includes('titulo')));

  assert.equal(countEvents(ctx), before, 'a refused amendment records no trabalho.emendado');
  assert.equal(
    (await readJob(ctx, job.id)).title,
    'título velho',
    'and it does not touch the row either',
  );
});

test('AT5 — GET /v1/jobs returns the current board, with a per-execution filter', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const one = await createJob(ctx, {
    titulo: 'na execução 7, versão v1',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/transitions`, { para_no_id: 'implementacao' });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/blocks`, { motivo: 'travou' });

  const two = await createJob(ctx, {
    titulo: 'na execução 8',
    no_entrada_id: 'entrada',
    execucao_id: 8,
  });

  const all = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(all.status, 200);
  assert.equal(all.body.jobs.length, 2, 'one job per row');

  const board = all.body.jobs.find((row) => row.id === one.id);
  assert.ok(board !== undefined);
  assert.equal(board.current_node_id, 'implementacao');
  assert.equal(board.blocked, true);
  assert.equal(board.execution_id, 7);
  assert.equal(board.graph_version_id, 'v1');

  const filtered = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs?execution_id=8');
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filtered.body.jobs.map((row) => row.id),
    [two.id],
  );
});

test('AT6 — GET /v1/jobs/:id/events is the timeline, in id order', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.sessionRoutes, T102_ARTIFACTS.inputRequestRoutes);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, {
    titulo: 'com sessão e pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const neighbour = await createJob(ctx, {
    titulo: 'o do lado, que não pode vazar',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'refinamento' });

  const session = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    trabalho_id: job.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine o trabalho',
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    trabalho_id: job.id,
    sessao_id: session.body.id,
    tipo: 'pergunta',
    pergunta: 'renumerar a migração?',
    auto_aprovavel: false,
  });
  assert.equal(inputRequest.status, 201);

  // Neighbour noise: same execution, same event type, another job.
  await request(ctx, 'POST', '/v1/sessions', {
    trabalho_id: neighbour.id,
    engine: 'claude-code',
    working_dir: '/tmp/vizinho',
    prompt: 'outra coisa',
  });

  const events = await timeline(ctx, job.id);
  assert.deepEqual(
    events.map((event) => event.tipo),
    [
      'trabalho.criado',
      'trabalho.transicao',
      'sessao.aberta',
      'pergunta.criada',
      // Creating the input request blocks the job in the same transaction since
      // t106; the flag shows up here because `trabalho.bloqueado` is an event OF
      // the job.
      'trabalho.bloqueado',
    ],
    'the job ones plus the session/input-request ones that cite it via dados.trabalho_id',
  );
  assert.deepEqual(
    [...events].sort((a, b) => a.id - b.id).map((event) => event.id),
    events.map((event) => event.id),
    'the order is the one of the event id',
  );
  assert.equal(
    events[2].entidade.id,
    session.body.id,
    'entidade.id is the session one, not the job one',
  );
  assert.equal(events[3].entidade.id, inputRequest.body.id);
});

test('AT7 — transition/block against a nonexistent job is 404 and records no event', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'o único', no_entrada_id: 'entrada' });
  const before = countEvents(ctx);

  const missing = job.id + 999;
  for (const [routePath, body] of [
    [`/v1/jobs/${missing}/transitions`, { para_no_id: 'implementacao' }],
    [`/v1/jobs/${missing}/blocks`, { motivo: 'travou' }],
    [`/v1/jobs/${missing}/unblocks`, {}],
  ] as const) {
    const response = await request(ctx, 'POST', routePath, body);
    assert.equal(response.status, 404, `${routePath} should have been 404`);
  }

  const patch = await request(ctx, 'PATCH', `/v1/jobs/${missing}`, { titulo: 'x' });
  assert.equal(patch.status, 404);

  assert.equal(countEvents(ctx), before, 'no event recorded for a job that does not exist');
});

test('FR3 — a body without a required field answers 400 and records no event', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const before = countEvents(ctx);

  const withoutEntryNode = await request(ctx, 'POST', '/v1/jobs', { titulo: 'sem nó de entrada' });
  assert.equal(withoutEntryNode.status, 400);

  const withoutTitle = await request(ctx, 'POST', '/v1/jobs', { no_entrada_id: 'entrada' });
  assert.equal(withoutTitle.status, 400);

  const job = await createJob(ctx, { titulo: 'válido', no_entrada_id: 'entrada' });
  const afterValid = countEvents(ctx);

  const withoutTarget = await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {});
  assert.equal(withoutTarget.status, 400);

  const withoutReason = await request(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {});
  assert.equal(withoutReason.status, 400);

  assert.equal(countEvents(ctx), afterValid, 'an invalid request leaves no trace in the log');
  assert.equal(afterValid, before + 1, 'only the valid job recorded an event');
});

test('t152 — a job with no graph version is never reported as concluído', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'recém-nascido', no_entrada_id: 'redigir' });
  const projection = await readJob(ctx, job.id);

  assert.equal(projection.graph_version_id, null);
  assert.equal(
    projection.completed,
    false,
    'with no graph attached there is no final_nodes to derive a terminal state from',
  );
});

test('t152 — concluído is "the current node is a final node of the job\'s graph version"', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    titulo: 'a nota curta',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });

  const atEntry = await readJob(ctx, job.id);
  assert.equal(atEntry.current_node_id, 'redigir');
  assert.equal(
    atEntry.completed,
    false,
    'the entry node is not in final_nodes: the traveller has not arrived',
  );

  const moved = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'revisar',
  });
  assert.equal(moved.status, 200);

  const atFinal = await readJob(ctx, job.id);
  assert.equal(atFinal.current_node_id, 'revisar');
  assert.equal(
    atFinal.completed,
    true,
    '`revisar` is the only node in the version\'s final_nodes: the walk is over',
  );
});

test('t152 — a blocked job is not concluído, even parked on a final node', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    titulo: 'a nota que travou no fim',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'revisar' });
  assert.equal((await readJob(ctx, job.id)).completed, true, 'it got there before blocking');

  const blocked = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    motivo: 'a revisão parou esperando alguém',
  });
  assert.equal(blocked.status, 200);

  const projection = await readJob(ctx, job.id);
  assert.equal(projection.blocked, true);
  assert.equal(
    projection.completed,
    false,
    'a block always stops "done" from being reported, wherever the job is standing',
  );
});

test('t152 — GET /v1/jobs reports the same concluído as GET /v1/jobs/:id', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const arrived = await createJob(ctx, {
    titulo: 'chegou ao fim',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${arrived.id}/transitions`, { para_no_id: 'revisar' });

  const walking = await createJob(ctx, {
    titulo: 'ainda no meio',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });

  const list = await request<{ jobs: JobProjection[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(list.status, 200);

  for (const id of [arrived.id, walking.id]) {
    const row = list.body.jobs.find((candidate) => candidate.id === id);
    assert.ok(row !== undefined, `job #${id} is missing from the board`);
    assert.equal(
      row.completed,
      (await readJob(ctx, id)).completed,
      'one projection, two routes: the board cannot disagree with the job page',
    );
  }

  assert.deepEqual(
    list.body.jobs.map((row) => [row.id, row.completed]),
    [
      [arrived.id, true],
      [walking.id, false],
    ],
    'and the value is the derived one, not a constant',
  );
});

/*
 * t168 — the fields a problem class declares on its own tickets.
 *
 * The gate is on `POST /v1/jobs/:id/transitions` and nowhere else, because that
 * route is the ONE place a job's position in the graph changes — mirrored by
 * nothing. That makes "a mandatory field blocks the crossing" a deterministic
 * check (D9) instead of an instruction injected into a session, which is what
 * the interpolation engine this repo does not have yet would have cost.
 */
test('t168 — POST /v1/jobs stores and returns campos; omitted, it comes back null', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const filled = { premise_source: 'relatório trimestral 2026Q2', downside: -12.5, upside: 40 };
  const response = await request<JobProjection>(ctx, 'POST', '/v1/jobs', {
    titulo: 'a tese do cobre',
    no_entrada_id: 'triagem',
    campos: filled,
  });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body.fields, filled);
  assert.deepEqual(
    (await readJob(ctx, response.body.id)).fields,
    filled,
    'the projection persists what the creation carried, not only the answer body',
  );

  const events = await timeline(ctx, response.body.id);
  assert.deepEqual(
    events[0].dados.campos,
    filled,
    'a job born with content has that content as part of the fact (t122 discipline)',
  );

  const bare = await createJob(ctx, { titulo: 'sem campo', no_entrada_id: 'triagem' });
  assert.equal(
    (await readJob(ctx, bare.id)).fields,
    null,
    'no declared field is null, never an empty map',
  );
});

test('t168 — leaving a node that demands a field is refused while it is empty', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphDemandingField(ctx);

  const job = await createJob(ctx, {
    titulo: 'a tese sem fonte',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });
  const before = countEvents(ctx);

  const refused = await request<{ error: string; details: string[] }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/transitions`,
    { para_no_id: 'revisar' },
  );

  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'validation_failed');
  assert.ok(
    refused.body.details.some((detail) => detail.includes('premise_source')),
    `the refusal has to name the missing field: ${JSON.stringify(refused.body.details)}`,
  );
  assert.ok(
    !refused.body.details.some((detail) => detail.includes('downside')),
    'a field declared with no required_at is never demanded',
  );

  assert.equal(countEvents(ctx), before, 'a refused transition records no event');
  assert.equal(
    (await readJob(ctx, job.id)).current_node_id,
    'redigir',
    'and it does not move the job either',
  );
});

test('t168 — the same transition goes through once PATCH fills the field', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphDemandingField(ctx);

  const job = await createJob(ctx, {
    titulo: 'a tese que ganhou fonte',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });
  assert.equal(
    (await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { para_no_id: 'revisar' })).status,
    400,
    'it starts refused, so the green below is the amendment and not a permissive gate',
  );

  const amended = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    campos: { premise_source: 'relatório trimestral 2026Q2, página 12' },
  });
  assert.equal(amended.status, 200);

  const moved = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    para_no_id: 'revisar',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.current_node_id, 'revisar');

  const transitions = (await timeline(ctx, job.id)).filter(
    (event) => event.tipo === 'trabalho.transicao',
  );
  assert.equal(transitions.length, 1, 'only the transition that really happened is in the log');
});

test('t168 — PATCH /v1/jobs/:id amends campos, and an empty body is still a 422', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'a tese', no_entrada_id: 'triagem' });

  const empty = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/jobs/${job.id}`,
    {},
  );
  assert.equal(empty.status, 422, 'a body that changes nothing is unusable, not a no-op');
  assert.equal(empty.body.error, 'validation_failed');

  const broken = await request<{ error: string }>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    campos: { downside: { valor: 12 } },
  });
  assert.equal(broken.status, 422, 'a campos that is not a map of scalars is refused too');

  const response = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    campos: { premise_source: 'relatório trimestral', downside: -12.5 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.fields, {
    premise_source: 'relatório trimestral',
    downside: -12.5,
  });
  assert.equal(response.body.title, 'a tese', 'amending one field does not touch the other');

  const amendments = (await timeline(ctx, job.id)).filter(
    (event) => event.tipo === 'trabalho.emendado',
  );
  assert.equal(amendments.length, 1);
  assert.deepEqual(
    amendments[0].dados,
    { campos_alterados: ['campos'] },
    'the log names what was touched, never the new content',
  );
  assert.ok(
    !JSON.stringify(amendments[0].dados).includes('trimestral'),
    'and the values the person typed stay out of the audit record',
  );

  const both = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    titulo: 'a tese, revisada',
    campos: { premise_source: 'outra fonte' },
  });
  assert.equal(both.status, 200);
  const last = (await timeline(ctx, job.id))
    .filter((event) => event.tipo === 'trabalho.emendado')
    .at(-1);
  assert.deepEqual(last?.dados, { campos_alterados: ['titulo', 'campos'] });
});

test('t127 — the old Portuguese job paths no longer exist', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { titulo: 'renomeado', no_entrada_id: 'entrada' });

  for (const [method, routePath] of [
    ['POST', '/v1/trabalhos'],
    ['GET', '/v1/trabalhos'],
    ['GET', `/v1/trabalhos/${job.id}`],
    ['GET', `/v1/trabalhos/${job.id}/eventos`],
    ['POST', `/v1/trabalhos/${job.id}/transicoes`],
    ['POST', `/v1/trabalhos/${job.id}/bloqueios`],
    ['POST', `/v1/trabalhos/${job.id}/desbloqueios`],
    ['PATCH', `/v1/trabalhos/${job.id}`],
  ] as const) {
    const response = await request(ctx, method, routePath, method === 'GET' ? undefined : {});
    assert.equal(response.status, 404, `${method} ${routePath} should be gone (D18)`);
  }
});
