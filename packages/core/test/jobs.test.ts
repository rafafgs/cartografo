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

import type { GraphDocument } from '../src/domain/graph.ts';
import { manifestHash } from '../src/domain/manifest.ts';
import { insertVersion } from '../src/repositories/graphs.ts';
import {
  PACKAGE_ROOT,
  T102_ARTIFACTS,
  countEvents,
  createJob,
  requireArtifacts,
  request,
  resolvePins,
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
  'examples',
  'graph-valid-minimal.json',
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
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  // The pins have to resolve or the version is born `unchecked`, and since t283
  // no job may cite one of those. The fixture's own ids carry a slash the
  // registry can never accept, so standing a capability in for each of them is
  // the only way this document can be run against at all — see `resolvePins`.
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

/* -------------------------------------------------------------------------- */
/* t262 — a final node that pins a skill is not done just for being arrived at. */
/*                                                                             */
/* Until this ficha `concluido` was `final_nodes.includes(no_atual)` and        */
/* nothing else, so the traveller was declared finished the instant it LANDED   */
/* on the last node — and the skill that node pins never got a session, because */
/* the controller's candidate list drops a `completed` job before the runner    */
/* sees it (`packages/runner/src/controller/cliente-controle.ts`). t198's first */
/* real crossing of the bets bundle found it on `registro-monitoramento`.       */
/*                                                                             */
/* The rule below keys on `skill_ref` PRESENCE and never on `node_type`:        */
/* `docs/spec/graph.md` §2 says a portão is "nó como qualquer outro", and this  */
/* fixture's own final node is a gate that pins a real skill.                   */
/* -------------------------------------------------------------------------- */

/**
 * The `output` schema the final node's registered skill declares.
 *
 * A gate's outcome vocabulary is not this file's to choose: the registry
 * demands exactly `pass`/`fail`/`escalate_human`
 * (`src/repositories/skill.ts`, `checkGateOutcome`), so the executor can route.
 * `evidencia` rides along because an agentic gate verifies with evidence of its
 * own (D9) — and because a report that omits it is what AT-3 needs refused.
 */
const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'evidencia'],
  additionalProperties: false,
  properties: {
    outcome: { enum: ['pass', 'fail', 'escalate_human'] },
    evidencia: { type: 'string', minLength: 1 },
  },
};

/** A report the schema above accepts, whole. */
const CONFORMING_REPORT = {
  outcome: 'pass',
  evidencia: 'a nota responde ao tema declarado, no segundo parágrafo',
};

/**
 * Registers the skill the final node pins, and returns the pin.
 *
 * `revisar-nota` and not `cartografo/revisar-nota`: the committed fixture's own
 * pin carries a slash and the registry's ids are kebab-case, so the pin as
 * written could never be registered at all — the same swap `sessions.test.ts`
 * makes for the same reason. Which is exactly why the rule under test may not
 * be keyed on a REGISTERED skill: it is keyed on the node declaring one.
 */
async function registerReviewSkill(
  ctx: TestContext,
): Promise<{ id: string; version: string; hash: string }> {
  const manifest: Record<string, unknown> = {
    id: 'revisar-nota',
    version: '1.0.0',
    hash: '',
    role: 'gate',
    description: 'Confere a nota contra o tema declarado e encerra a travessia.',
    input: { type: 'object', properties: { tema: { type: 'string' } } },
    output: REVIEW_OUTPUT_SCHEMA,
    preconditions: [],
    checks: [
      {
        id: 'nota-existe',
        type: 'deterministic',
        description: 'A nota existe e não está vazia.',
        command: 'test -s nota.md',
      },
    ],
    permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
    instructions: '# Revisar nota\n\nConfira a nota contra o tema.',
    origin: { type: 'native' },
  };
  manifest.hash = manifestHash(manifest);

  const response = await request<{ id: string; version: string; hash: string }>(
    ctx,
    'POST',
    '/v1/skills',
    manifest,
  );
  assert.equal(response.status, 201, `POST /v1/skills returned ${response.status}`);
  return { id: manifest.id as string, version: '1.0.0', hash: manifest.hash as string };
}

/**
 * The minimal graph with its final node pinning a skill the registry carries.
 *
 * Patched, never hand-written, for the reason `registerMinimalGraph` above
 * already gives: what these tests read is the snapshot of a version that went
 * through the registration gate. The one edit is the pin, because the report
 * has to be judged against a REGISTERED `output` schema for the refusal in AT-3
 * to mean anything.
 */
async function registerGraphPinningReviewSkill(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  document.problem_class = 'nota-curta-com-revisao-registrada';
  const nodes = document.nodes as Array<Record<string, unknown>>;
  nodes[1].skill_ref = await registerReviewSkill(ctx);
  // `revisar` now pins a manifest that IS registered, so `resolvePins` leaves it
  // alone and only stands a capability in for `redigir` — which is what the
  // version needs to be `checked` and therefore runnable (t283).
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

/**
 * Opens a session on a node of the job and closes it, exactly as the runner does.
 *
 * @param ctx Control plane running.
 * @param jobId The traveller.
 * @param nodeId Where the session runs.
 * @param output What the session reports; omitted means it reported nothing
 *   structured at all, which is a different fact from a report that was refused.
 * @returns The id of the session that was closed.
 */
async function runSessionOn(
  ctx: TestContext,
  jobId: number,
  nodeId: string,
  output?: Record<string, unknown>,
): Promise<number> {
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'Revise a nota.',
  });
  assert.equal(opened.status, 201, `POST /v1/sessions returned ${opened.status}`);

  const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    ...(output === undefined ? {} : { output }),
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);
  return opened.body.id;
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

test('AT1 — POST /v1/jobs creates the job and records job.created', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<Job>(ctx, 'POST', '/v1/jobs', {
    title: 'Entidades e API: trabalho, sessão, evento e pergunta',
    entry_node_id: 'entrada',
    execution_id: 7,
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
  assert.equal(event.type, 'job.created');
  assert.ok(Number.isInteger(event.id) && event.id >= 1, 'the event id comes from the server');
  assert.deepEqual(event.entity, { type: 'job', id: job.id });
  assert.equal(event.execution_id, 7);
  assert.ok(Number.isInteger(event.project_id));
  assert.ok(typeof event.actor.ref === 'string' && event.actor.ref.length > 0);
  assert.ok(['user', 'agent', 'system'].includes(event.actor.type));
  assert.ok(!Number.isNaN(Date.parse(event.occurred_at)), 'occurred_at is ISO 8601');
  assert.deepEqual(event.data, {
    title: 'Entidades e API: trabalho, sessão, evento e pergunta',
    entry_node_id: 'entrada',
    // The intake (t122) added two optional fields to the type's contract. A job
    // created by hand declares neither, and the payload normalizes them to an
    // explicit `null` — the taxonomy's rule for every optional field, the same
    // one `session.opened` has always followed.
    body: null,
    acceptance_criteria: null,
    // And a third since t168, by the same rule: the class's declared fields,
    // which a job created by hand did not fill either.
    fields: null,
    // And a fourth since t175: the triage tier. `null` is "nobody classified
    // this", and reading it as `trivial` would put every unclassified job on a
    // cheaper model than anyone chose.
    tier: null,
  });
});

/**
 * t175 — the triage tier travels with the job, in the projection AND in the fact.
 *
 * `tier` is part of `job.created` for the same reason `body` and
 * `acceptance_criteria` are: a job that is born classified has that
 * classification as part of the fact, and a consumer replaying the log has to
 * reach the same tier the projection shows. No new route: the field rides the
 * projection `GET /v1/jobs` and `GET /v1/jobs/:id` already return, which is
 * what makes it joinable against `GET /v1/sessions` by `job_id` (FR8) the
 * same way `packages/cost-surveyor` already joins for `grafo_versao_id`.
 */
test('t175 — POST /v1/jobs round-trips tier through the projection and the fact', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<JobWithTier>(ctx, 'POST', '/v1/jobs', {
    title: 'Renomear uma variável',
    entry_node_id: 'entrada',
    tier: 'trivial',
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.tier, 'trivial', 'the tier is on the projection the write answers');

  const read = await request<JobWithTier>(ctx, 'GET', `/v1/jobs/${response.body.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.tier, 'trivial', 'and survives the round trip through the column');

  const [event] = await timeline(ctx, response.body.id);
  assert.equal(event.type, 'job.created');
  assert.equal(event.data.tier, 'trivial', 'the fact carries it too, not only the projection');

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
    title: 'urgência não é tier',
    entry_node_id: 'entrada',
    tier: 'urgent',
  });

  assert.equal(refused.status, 400);

  const board = await request<{ jobs: JobWithTier[] }>(ctx, 'GET', '/v1/jobs');
  assert.deepEqual(board.body.jobs, [], 'a refused creation consumes no id and writes nothing');
});

test('AT2 — POST /v1/jobs/:id/transitions walks the graph and records job.transitioned', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'andar', entry_node_id: 'entrada' });

  const first = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'implementacao',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.current_node_id, 'implementacao');

  const second = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'revisao',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.current_node_id, 'revisao');

  const transitions = (await timeline(ctx, job.id)).filter(
    (event) => event.type === 'job.transitioned',
  );
  assert.equal(transitions.length, 2);
  assert.deepEqual(
    transitions[0].data,
    { from_node_id: null, to_node_id: 'implementacao' },
    'on the first transition the job leaves the entry node: de_no_id is null',
  );
  assert.deepEqual(transitions[1].data, { from_node_id: 'implementacao', to_node_id: 'revisao' });
});

test('AT3 — block and unblock move the flag and record both events', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'parar', entry_node_id: 'entrada' });

  const blocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'esperando resposta do humano',
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
    ['job.blocked', 'job.unblocked'].includes(event.type),
  );
  assert.deepEqual(
    flags.map((event) => event.type),
    ['job.blocked', 'job.unblocked'],
  );
  // `consecutive_failures` is null for every block but the one the failure cap
  // itself raises (t265): a block somebody asked for has no streak behind it.
  assert.deepEqual(flags[0].data, {
    reason: 'esperando resposta do humano',
    consecutive_failures: null,
  });
  assert.deepEqual(flags[1].data, {}, 'the fact is the fall of the flag itself: no payload');
});

test('AT4 — PATCH /v1/jobs/:id amends the title and records only the field NAME', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'título velho', entry_node_id: 'entrada' });

  const response = await request<Job>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    title: 'título novo, com segredo dentro',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'título novo, com segredo dentro');

  const amendments = (await timeline(ctx, job.id)).filter(
    (event) => event.type === 'job.amended',
  );
  assert.equal(amendments.length, 1);
  assert.deepEqual(amendments[0].data, { changed_fields: ['title'] });
  assert.ok(
    !JSON.stringify(amendments[0].data).includes('segredo'),
    'the log says what was touched, never the new content (taxonomy: audit record)',
  );
});

test('t157 — PATCH /v1/jobs/:id without a usable title is 422, never a 500', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'título velho', entry_node_id: 'entrada' });
  const before = countEvents(ctx);

  // `changed_fields: ['title']` is well-formed whatever comes in the body, so
  // until t157 the payload validation passed and the UPDATE bound `undefined` —
  // the driver threw and Fastify answered 500. What is written is what has to be
  // validated.
  for (const body of [{}, { title: null }, { title: '' }, { title: 7 }] as const) {
    const response = await request<{ error: string; details: string[] }>(
      ctx,
      'PATCH',
      `/v1/jobs/${job.id}`,
      body,
    );
    assert.equal(response.status, 422, `PATCH with ${JSON.stringify(body)} should be a 422`);
    assert.equal(response.body.error, 'validation_failed');
    assert.ok(
      response.body.details.some((detail) => detail.includes('title')),
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
  assert.ok(literalNull.body.details.some((detail) => detail.includes('title')));

  assert.equal(countEvents(ctx), before, 'a refused amendment records no job.amended');
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
    title: 'na execução 7, versão v1',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/transitions`, { to_node_id: 'implementacao' });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/blocks`, { reason: 'travou' });

  const two = await createJob(ctx, {
    title: 'na execução 8',
    entry_node_id: 'entrada',
    execution_id: 8,
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
    title: 'com sessão e pergunta',
    entry_node_id: 'entrada',
    execution_id: 7,
  });
  const neighbour = await createJob(ctx, {
    title: 'o do lado, que não pode vazar',
    entry_node_id: 'entrada',
    execution_id: 7,
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'refinamento' });

  const session = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'refinamento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine o trabalho',
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    session_id: session.body.id,
    kind: 'question',
    question: 'renumerar a migração?',
    auto_approvable: false,
  });
  assert.equal(inputRequest.status, 201);

  // Neighbour noise: same execution, same event type, another job.
  await request(ctx, 'POST', '/v1/sessions', {
    job_id: neighbour.id,
    engine: 'claude-code',
    working_dir: '/tmp/vizinho',
    prompt: 'outra coisa',
  });

  const events = await timeline(ctx, job.id);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'job.created',
      'job.transitioned',
      'session.opened',
      'input_request.created',
      // Creating the input request blocks the job in the same transaction since
      // t106; the flag shows up here because `job.blocked` is an event OF
      // the job.
      'job.blocked',
    ],
    'the job ones plus the session/input-request ones that cite it via dados.trabalho_id',
  );
  assert.deepEqual(
    [...events].sort((a, b) => a.id - b.id).map((event) => event.id),
    events.map((event) => event.id),
    'the order is the one of the event id',
  );
  assert.equal(
    events[2].entity.id,
    session.body.id,
    'entidade.id is the session one, not the job one',
  );
  assert.equal(events[3].entity.id, inputRequest.body.id);
});

test('AT7 — transition/block against a nonexistent job is 404 and records no event', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'o único', entry_node_id: 'entrada' });
  const before = countEvents(ctx);

  const missing = job.id + 999;
  for (const [routePath, body] of [
    [`/v1/jobs/${missing}/transitions`, { to_node_id: 'implementacao' }],
    [`/v1/jobs/${missing}/blocks`, { reason: 'travou' }],
    [`/v1/jobs/${missing}/unblocks`, {}],
  ] as const) {
    const response = await request(ctx, 'POST', routePath, body);
    assert.equal(response.status, 404, `${routePath} should have been 404`);
  }

  const patch = await request(ctx, 'PATCH', `/v1/jobs/${missing}`, { title: 'x' });
  assert.equal(patch.status, 404);

  assert.equal(countEvents(ctx), before, 'no event recorded for a job that does not exist');
});

test('FR3 — a body without a required field answers 400 and records no event', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const before = countEvents(ctx);

  const withoutEntryNode = await request(ctx, 'POST', '/v1/jobs', { title: 'sem nó de entrada' });
  assert.equal(withoutEntryNode.status, 400);

  const withoutTitle = await request(ctx, 'POST', '/v1/jobs', { entry_node_id: 'entrada' });
  assert.equal(withoutTitle.status, 400);

  const job = await createJob(ctx, { title: 'válido', entry_node_id: 'entrada' });
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

  const job = await createJob(ctx, { title: 'recém-nascido', entry_node_id: 'redigir' });
  const projection = await readJob(ctx, job.id);

  assert.equal(projection.graph_version_id, null);
  assert.equal(
    projection.completed,
    false,
    'with no graph attached there is no final_nodes to derive a terminal state from',
  );
});

test('t262 AT-1 — arriving at a final node that pins a skill is not enough to be concluído', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    title: 'a nota curta',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const atEntry = await readJob(ctx, job.id);
  assert.equal(atEntry.current_node_id, 'redigir');
  assert.equal(
    atEntry.completed,
    false,
    'the entry node is not in final_nodes: the traveller has not arrived',
  );

  const moved = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(moved.status, 200);

  const atFinal = await readJob(ctx, job.id);
  assert.equal(atFinal.current_node_id, 'revisar');
  assert.equal(
    atFinal.completed,
    false,
    '`revisar` pins a skill that never ran: the traveller is standing on the last ' +
      'node, which is not the same as having finished it (t262)',
  );
  assert.equal(atFinal.blocked, false, 'and it is an ordinary candidate, not a stuck job');
});

test('t262 AT-2 — a conforming report on the final node completes the job, on both routes', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const job = await createJob(ctx, {
    title: 'a nota que foi revisada de verdade',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });
  assert.equal((await readJob(ctx, job.id)).completed, false, 'nothing ran yet');

  await runSessionOn(ctx, job.id, 'revisar', CONFORMING_REPORT);

  assert.equal(
    (await readJob(ctx, job.id)).completed,
    true,
    'the pinned skill ran and reported what its `output` schema declares: now it is over',
  );

  const list = await request<{ jobs: JobProjection[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(list.status, 200);
  const row = list.body.jobs.find((candidate) => candidate.id === job.id);
  assert.ok(row !== undefined, 'the job is missing from the board');
  assert.equal(row.completed, true, 'the board cannot disagree with the job page');
});

test('t262 AT-3 — a report the schema refuses leaves the job an ordinary candidate', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const refused = await createJob(ctx, {
    title: 'a revisão que reportou torto',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${refused.id}/transitions`, { to_node_id: 'revisar' });
  // `escala` is the graph fixture's own vocabulary, not the registry's, and
  // `evidencia` is missing: the registered schema refuses it, `finishSession`
  // stores `output: null` and records the reason in the event (t253).
  await runSessionOn(ctx, refused.id, 'revisar', { outcome: 'escala' });

  const afterRefusal = await readJob(ctx, refused.id);
  assert.equal(afterRefusal.completed, false, 'a refused report is not a report');
  assert.equal(
    afterRefusal.blocked,
    false,
    'and it does not block either: capping repeated failed attempts is t265, not this ficha',
  );

  const silent = await createJob(ctx, {
    title: 'a revisão que não reportou nada',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${silent.id}/transitions`, { to_node_id: 'revisar' });
  await runSessionOn(ctx, silent.id, 'revisar');

  const afterSilence = await readJob(ctx, silent.id);
  assert.equal(
    afterSilence.completed,
    false,
    'a session that reported nothing structured left nothing to verify the arrival with',
  );
  assert.equal(afterSilence.blocked, false);
});

test('t262 AT-4 — a blocked job is not concluído, even parked on a finished final node', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const job = await createJob(ctx, {
    title: 'a nota que travou no fim',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });
  await runSessionOn(ctx, job.id, 'revisar', CONFORMING_REPORT);
  assert.equal((await readJob(ctx, job.id)).completed, true, 'it finished before blocking');

  const blocked = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'a revisão parou esperando alguém',
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

test('t262 AT-4 — GET /v1/jobs reports the same concluído as GET /v1/jobs/:id', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const arrived = await createJob(ctx, {
    title: 'chegou ao fim',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${arrived.id}/transitions`, { to_node_id: 'revisar' });
  await runSessionOn(ctx, arrived.id, 'revisar', CONFORMING_REPORT);

  const standing = await createJob(ctx, {
    title: 'parado no nó final, sem ter rodado',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${standing.id}/transitions`, { to_node_id: 'revisar' });

  const walking = await createJob(ctx, {
    title: 'ainda no meio',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const list = await request<{ jobs: JobProjection[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(list.status, 200);

  for (const id of [arrived.id, standing.id, walking.id]) {
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
      [standing.id, false],
      [walking.id, false],
    ],
    'and the value is the derived one, not a constant — two of these three are on the final node',
  );
});

test('t262 AT-5 — a final node with no skill_ref at all is concluído on arrival, as before', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);

  // The registered version exists only to give the lineage a `graph` row to
  // hang off; what the job cites is the hand-inserted one below.
  const registered = await registerMinimalGraph(ctx);
  const graphId = (
    ctx.db.prepare('SELECT graph_id FROM graph_version WHERE id = ?').get(registered) as {
      graph_id: string;
    }
  ).graph_id;

  // Inserted through the repository, bypassing `POST /v1/graphs` on purpose:
  // `schema/graph.schema.json` makes `skill_ref` mandatory on every node, so no
  // document that passes the registration gate can ever reach this branch. It
  // exists for the malformed or pre-existing snapshot, the same way
  // `resolveOutputSchema` and the runner's `resolveNode` already degrade instead
  // of throwing — the deliberately-not-sound-fixture posture of
  // `domain-operations.test.ts`.
  const snapshot = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as GraphDocument;
  delete (snapshot.nodes[1] as Record<string, unknown>).skill_ref;
  const versionId = 'sha256:' + 'e'.repeat(64);
  insertVersion(ctx.db, {
    id: versionId,
    graph_id: graphId,
    parent_version: null,
    snapshot,
    source: 'manual',
    proposal_id: null,
    created_at: new Date().toISOString(),
    // `checked`, because this case is about a node with no pin and not about
    // the contract gate: an `unchecked` version would be refused by `createJob`
    // (t283) and the traversal below would never happen.
    contracts: { state: 'checked', problems: [] },
  });

  const job = await createJob(ctx, {
    title: 'a nota de um snapshot sem pino no nó final',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });

  assert.equal(
    (await readJob(ctx, job.id)).completed,
    true,
    'a final node with nothing pinned has nothing left to run: arrival is the whole of it',
  );
});

test('t262 AT-6 — the round finishes on the final node\'s session, not only on a transition', async (t) => {
  requireArtifacts(...ARTIFACTS, T102_ARTIFACTS.executionRoutes, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const job = await createJob(ctx, {
    title: 'o único trabalho da rodada',
    entry_node_id: 'redigir',
    execution_id: 2620,
    graph_version_id: versionId,
  });

  const finishedAt = async (): Promise<string | null> => {
    const response = await request<{ finished_at: string | null }>(
      ctx,
      'GET',
      '/v1/executions/2620',
    );
    assert.equal(response.status, 200);
    return response.body.finished_at;
  };

  assert.equal(await finishedAt(), null, 'the traveller has not even left the entry node');

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });
  assert.equal(
    await finishedAt(),
    null,
    'and landing on the final node is no longer the end of the round either (t262)',
  );

  await runSessionOn(ctx, job.id, 'revisar', CONFORMING_REPORT);

  const announced = await finishedAt();
  assert.ok(
    announced !== null,
    'PATCH /v1/sessions/:id/finish is now the THIRD moment a job can become ' +
      'concluído, and it has to announce the round like the other two do (FR4)',
  );

  const events = await request<{ events: Event[] }>(ctx, 'GET', '/v1/executions/2620/events');
  assert.equal(events.status, 200);
  assert.deepEqual(
    events.body.events.filter((event) => event.type === 'execution.finished').length,
    1,
    'once, ever — the guard `announceFinishedExecution` already carries',
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
test('t168 — POST /v1/jobs stores and returns fields; omitted, it comes back null', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const filled = { premise_source: 'relatório trimestral 2026Q2', downside: -12.5, upside: 40 };
  const response = await request<JobProjection>(ctx, 'POST', '/v1/jobs', {
    title: 'a tese do cobre',
    entry_node_id: 'triagem',
    fields: filled,
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
    events[0].data.fields,
    filled,
    'a job born with content has that content as part of the fact (t122 discipline)',
  );

  const bare = await createJob(ctx, { title: 'sem campo', entry_node_id: 'triagem' });
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
    title: 'a tese sem fonte',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  const before = countEvents(ctx);

  const refused = await request<{ error: string; details: string[] }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/transitions`,
    { to_node_id: 'revisar' },
  );

  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'validation_failed');
  assert.ok(
    refused.body.details.some((detail) => detail.includes('premise_source')),
    `the refusal has to name the missing field: ${JSON.stringify(refused.body.details)}`,
  );
  // t255 — and it names it under the key the CALLER sends. The message said
  // `campos.premise_source` for two tickets after `fields` became the wire key
  // (t168), which sends whoever reads it looking for a field nothing accepts.
  assert.ok(
    refused.body.details.some((detail) => detail.startsWith('fields.premise_source')),
    `the refusal has to name the wire key, not the column: ${JSON.stringify(refused.body.details)}`,
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
    title: 'a tese que ganhou fonte',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  assert.equal(
    (await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' })).status,
    400,
    'it starts refused, so the green below is the amendment and not a permissive gate',
  );

  const amended = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    fields: { premise_source: 'relatório trimestral 2026Q2, página 12' },
  });
  assert.equal(amended.status, 200);

  const moved = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.current_node_id, 'revisar');

  const transitions = (await timeline(ctx, job.id)).filter(
    (event) => event.type === 'job.transitioned',
  );
  assert.equal(transitions.length, 1, 'only the transition that really happened is in the log');
});

test('t168 — PATCH /v1/jobs/:id amends fields, and an empty body is still a 422', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'a tese', entry_node_id: 'triagem' });

  const empty = await request<{ error: string; details: string[] }>(
    ctx,
    'PATCH',
    `/v1/jobs/${job.id}`,
    {},
  );
  assert.equal(empty.status, 422, 'a body that changes nothing is unusable, not a no-op');
  assert.equal(empty.body.error, 'validation_failed');

  const broken = await request<{ error: string }>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    fields: { downside: { valor: 12 } },
  });
  assert.equal(broken.status, 422, 'a fields that is not a map of scalars is refused too');

  const response = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    fields: { premise_source: 'relatório trimestral', downside: -12.5 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.fields, {
    premise_source: 'relatório trimestral',
    downside: -12.5,
  });
  assert.equal(response.body.title, 'a tese', 'amending one field does not touch the other');

  const amendments = (await timeline(ctx, job.id)).filter(
    (event) => event.type === 'job.amended',
  );
  assert.equal(amendments.length, 1);
  assert.deepEqual(
    amendments[0].data,
    { changed_fields: ['fields'] },
    'the log names what was touched, never the new content',
  );
  assert.ok(
    !JSON.stringify(amendments[0].data).includes('trimestral'),
    'and the values the person typed stay out of the audit record',
  );

  const both = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    title: 'a tese, revisada',
    fields: { premise_source: 'outra fonte' },
  });
  assert.equal(both.status, 200);
  const last = (await timeline(ctx, job.id))
    .filter((event) => event.type === 'job.amended')
    .at(-1);
  assert.deepEqual(last?.data, { changed_fields: ['title', 'fields'] });
});

test('t127 — the old Portuguese job paths no longer exist', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'renomeado', entry_node_id: 'entrada' });

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

/* -------------------------------------------------------------------------- */
/* t253 — GET /v1/jobs/:id/context: the `input` a node's skill reads.           */
/*                                                                             */
/* The merge algorithm itself is proved pure in `domain-context.test.ts`. What  */
/* is proved here is the OTHER half: that the four reads the route performs —   */
/* the job, the version's snapshot, the completed sessions and the answered     */
/* escalations — feed that algorithm the real rows, over a real server.         */
/* -------------------------------------------------------------------------- */

/** The migration that gives a session somewhere to keep its output (t253, FR2). */
const T253_MIGRATION = 'migrations/0020_sessao_saida.sql';

/** The pure module the route is a thin read over. */
const T253_ARTIFACTS = ['src/domain/context.ts'];

/** A session, in the slice these cases assert on. */
interface SessionRef {
  id: number;
  status: string;
  output: Record<string, unknown> | null;
}

/**
 * A three-node graph that declares a `project` object and two `produces`
 * buckets, patched onto the example document.
 *
 * `revisar` is the gate in the middle and declares no bucket: it is what proves
 * the bucket survives a step that produces no artifact of its own.
 */
async function registerGraphWithBuckets(ctx: TestContext): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  document.problem_class = 'nota-curta-com-baldes';
  document.project = {
    repo: 'git@github.com:rafaelgomes/cartografo.git',
    comando_testes: 'npm test',
  };

  const nodes = document.nodes as Array<Record<string, unknown>>;
  (nodes[0].contract as Record<string, unknown>).produces = 'artefato';
  // A third node after the gate, sharing the first one's bucket. The example
  // document ends at `revisar`, so the edge and the final node move with it.
  nodes.push({
    ...JSON.parse(JSON.stringify(nodes[0])) as Record<string, unknown>,
    id: 'publicar',
    description: 'Publica a nota revisada.',
  });
  (document.edges as unknown[]).push({
    from: 'revisar',
    to: 'publicar',
    condition: 'aprovado',
    description: 'A nota aprovada segue para publicação.',
  });
  document.final_nodes = ['publicar'];
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

/** Opens a session on `nodeId` and closes it with the given status and output. */
async function runNode(
  ctx: TestContext,
  jobId: number,
  nodeId: string,
  status: string,
  output: Record<string, unknown> | null,
): Promise<SessionRef> {
  const opened = await request<SessionRef>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: `Rode ${nodeId}.`,
  });
  assert.equal(opened.status, 201);

  const finished = await request<SessionRef>(
    ctx,
    'PATCH',
    `/v1/sessions/${opened.body.id}/finish`,
    { status, exit_code: 0, output },
  );
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);
  return finished.body;
}

test('t253 AT4 — GET /v1/jobs/:id/context is a 404 for a job that does not exist', async (t) => {
  requireArtifacts(...ARTIFACTS, T253_MIGRATION, ...T253_ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<{ error: string }>(ctx, 'GET', '/v1/jobs/98765/context');
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'not_found');
});

test('t253 AT4 — the route assembles the input from job, project, buckets and answers', async (t) => {
  requireArtifacts(...ARTIFACTS, T253_MIGRATION, ...T253_ARTIFACTS);
  const ctx = await startControlPlane(t);

  const versionId = await registerGraphWithBuckets(ctx);
  const job = await createJob(ctx, {
    title: 'Nota sobre a projeção de contexto',
    body: 'o pedido bruto',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
    execution_id: 7,
  });

  await runNode(ctx, job.id, 'redigir', 'completed', { branch: 'nota-1', texto: 'primeiro corte' });
  await runNode(ctx, job.id, 'revisar', 'completed', { outcome: 'pass', evidencia: 'confere' });
  await runNode(ctx, job.id, 'publicar', 'completed', { url: 'https://exemplo/nota-1' });
  // Neither of these two is a fact about the graph: one failed, and one is still
  // running. Their reports must not reach the projection.
  await runNode(ctx, job.id, 'redigir', 'failed', { branch: 'nao-conta' });
  const opened = await request<SessionRef>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'redigir',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'ainda rodando',
  });
  assert.equal(opened.status, 201);

  const asked = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    kind: 'question',
    question: 'Publicar hoje?',
    auto_approvable: false,
  });
  assert.equal(asked.status, 201);
  const answered = await request<unknown>(
    ctx,
    'PATCH',
    `/v1/input-requests/${asked.body.id}/answer`,
    { answer: 'Publique amanhã.', answered_by: 'rafael' },
  );
  assert.equal(answered.status, 200);

  const response = await request<{ input: Record<string, unknown> }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.equal(response.status, 200);
  const { input } = response.body;

  assert.deepEqual(input.job, {
    id: job.id,
    title: 'Nota sobre a projeção de contexto',
    body: 'o pedido bruto',
  });
  assert.deepEqual(input.project, {
    repo: 'git@github.com:rafaelgomes/cartografo.git',
    comando_testes: 'npm test',
  });
  assert.deepEqual(
    input.artefato,
    { branch: 'nota-1', texto: 'primeiro corte', url: 'https://exemplo/nota-1' },
    'the bucket accumulates across the gate that declares none',
  );
  assert.equal(input.outcome, 'pass', 'the gate merged at the top level');
  assert.equal(input.evidencia, 'confere');
  assert.deepEqual(input.perguntas_respondidas, [
    { id: String(asked.body.id), pergunta: 'Publicar hoje?', resposta: 'Publique amanhã.' },
  ]);
  assert.equal(
    JSON.stringify(input).includes('nao-conta'),
    false,
    'only a completed session reports a fact about the graph',
  );
});

test('t253 AT4 — the route answers exactly what the pure module builds', async (t) => {
  requireArtifacts(...ARTIFACTS, T253_MIGRATION, ...T253_ARTIFACTS);
  const ctx = await startControlPlane(t);
  const { buildNodeInput } = await import('../src/domain/context.ts');

  const versionId = await registerGraphWithBuckets(ctx);
  const job = await createJob(ctx, {
    title: 'Nota curta',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
    fields: { premise_source: 'nota de 2026-08-17' },
  });

  const first = await runNode(ctx, job.id, 'redigir', 'completed', { branch: 'nota-2' });
  const second = await runNode(ctx, job.id, 'revisar', 'completed', { outcome: 'pass' });

  const response = await request<{ input: Record<string, unknown> }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.equal(response.status, 200);

  const sessions = await request<{ sessions: Array<SessionRef & { node_id: string | null; finished_at: string | null }> }>(
    ctx,
    'GET',
    `/v1/sessions?job_id=${job.id}`,
  );
  assert.equal(sessions.status, 200);
  assert.deepEqual(
    sessions.body.sessions.map((session) => session.id),
    [first.id, second.id],
  );

  const expected = buildNodeInput({
    job: { id: job.id, title: 'Nota curta', body: null, fields: { premise_source: 'nota de 2026-08-17' } },
    snapshot: {
      nodes: [
        { id: 'redigir', contract: { produces: 'artefato' } },
        { id: 'revisar', contract: {} },
        { id: 'publicar', contract: { produces: 'artefato' } },
      ],
      project: {
        repo: 'git@github.com:rafaelgomes/cartografo.git',
        comando_testes: 'npm test',
      },
    },
    outputs: sessions.body.sessions.map((session) => ({
      node_id: session.node_id,
      output: session.output,
      finished_at: session.finished_at,
      session_id: session.id,
    })),
    answered: [],
    // The job never transitioned, so it is still standing on its entry node
    // (t270): nothing executed, and the moment it got there is its creation.
    traversal: { nodes_visited: [], entered_at: job.created_at },
  });

  assert.deepEqual(response.body.input, expected);
});

/* -------------------------------------------------------------------------- */
/* t270 Half A — the route projects the job's own walk at `input.traversal`.    */
/*                                                                             */
/* The walk is a fact about the LOG, and only the control plane owns the log    */
/* (D1). Until this ficha nothing published it: `registrar-travessia`, the last */
/* node of the bets bundle, names `{{input.nos_executados}}` and                */
/* `{{input.data_de_registro}}`, both failed closed, and the second real bets   */
/* crossing was unblocked by a person patching scalars into `fields` by hand.   */
/*                                                                             */
/* The derivation rule is the one thing worth a case each: the last transition  */
/* names the node the job is standing on, and a node it is ABOUT to run has not */
/* executed.                                                                    */
/* -------------------------------------------------------------------------- */

/** Moves a job one node along, asserting the write took. */
async function transitionTo(
  ctx: TestContext,
  jobId: number,
  nodeId: string,
): Promise<JobProjection> {
  const response = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${jobId}/transitions`, {
    to_node_id: nodeId,
  });
  assert.equal(response.status, 200, `POST /transitions returned ${response.status}`);
  return response.body;
}

/** The `input.traversal` object of a job, as the route projects it. */
async function traversalOf(ctx: TestContext, jobId: number): Promise<Record<string, unknown>> {
  const response = await request<{ input: { traversal: Record<string, unknown> } }>(
    ctx,
    'GET',
    `/v1/jobs/${jobId}/context`,
  );
  assert.equal(response.status, 200);
  return response.body.input.traversal;
}

test('t270 AT — a job that never transitioned has visited nothing yet', async (t) => {
  requireArtifacts(...ARTIFACTS, T253_MIGRATION, ...T253_ARTIFACTS);
  const ctx = await startControlPlane(t);

  const versionId = await registerGraphWithBuckets(ctx);
  const job = await createJob(ctx, {
    title: 'parada no nó de entrada',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const traversal = await traversalOf(ctx, job.id);
  assert.deepEqual(
    traversal.nodes_visited,
    [],
    'the entry node is where the job IS standing, and it has not run yet',
  );
  assert.equal(
    traversal.entered_at,
    job.created_at,
    'with no transition to read, the moment it arrived is the moment it was created',
  );
});

test('t270 AT — the walk is the entry node plus every node it left behind', async (t) => {
  requireArtifacts(...ARTIFACTS, T253_MIGRATION, ...T253_ARTIFACTS);
  const ctx = await startControlPlane(t);

  const versionId = await registerGraphWithBuckets(ctx);
  const job = await createJob(ctx, {
    title: 'travessia de três nós',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  await transitionTo(ctx, job.id, 'revisar');
  const arrived = await transitionTo(ctx, job.id, 'publicar');
  assert.equal(arrived.current_node_id, 'publicar');

  const traversal = await traversalOf(ctx, job.id);
  assert.deepEqual(
    traversal.nodes_visited,
    ['redigir', 'revisar'],
    'in walk order, and WITHOUT `publicar`: the node the job is about to run has not executed',
  );

  const events = await timeline(ctx, job.id);
  const lastTransition = events.filter((event) => event.type === 'job.transitioned').at(-1);
  assert.equal(
    traversal.entered_at,
    lastTransition?.occurred_at,
    'and it arrived where it stands when the last transition was recorded',
  );
});

test('t270 AT — two sessions on one node are two entries, in closing order', async (t) => {
  requireArtifacts(...ARTIFACTS, T253_MIGRATION, ...T253_ARTIFACTS);
  const ctx = await startControlPlane(t);

  const versionId = await registerGraphWithBuckets(ctx);
  const job = await createJob(ctx, {
    title: 'retrabalho no mesmo nó',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const first = await runNode(ctx, job.id, 'redigir', 'completed', { branch: 'primeiro-corte' });
  const second = await runNode(ctx, job.id, 'redigir', 'completed', { branch: 'segundo-corte' });
  const gate = await runNode(ctx, job.id, 'revisar', 'completed', { outcome: 'pass' });
  // Neither of these is a fact about the graph, and neither may show up: one
  // failed, and the projection only ever sees completed sessions.
  await runNode(ctx, job.id, 'redigir', 'failed', { branch: 'nao-conta' });

  const traversal = await traversalOf(ctx, job.id);
  assert.deepEqual(traversal.sessions_by_node, {
    redigir: [first.id, second.id],
    revisar: [gate.id],
  });
});

/* -------------------------------------------------------------------------- */
/* t265 — a job whose sessions keep failing stops being re-leased.              */
/*                                                                             */
/* The cap lives in core and not in the runner because only the control plane   */
/* holds the session history across leases and runner processes (D1): a runner  */
/* that died mid-round knows nothing about the three sessions that came before  */
/* it. It runs inside `finishSession`'s own transaction, next to                */
/* `announceFinishedExecution` — the projection and the fact that produced it   */
/* land together, or neither does.                                             */
/*                                                                             */
/* The streak is TRAILING, counted most-recent-first and stopped at the first   */
/* session that did not fail: a node that failed twice, worked, and failed once */
/* more is a node with one failure behind it, not three.                       */
/* -------------------------------------------------------------------------- */

/** How many consecutive failures block a job when the graph declares nothing. */
const T265_DEFAULT_CAP = 3;

/**
 * Registers the minimal graph with a cap of its own.
 *
 * Patched, never hand-written, for the reason `registerMinimalGraph` gives: what
 * the repository reads is the snapshot of a version that went through the
 * registration gate, and a hand-made snapshot would prove nothing about it.
 *
 * @param ctx Control plane running.
 * @param cap What the document declares in `max_consecutive_failures`.
 * @returns Id of the registered version.
 */
async function registerGraphWithFailureCap(ctx: TestContext, cap: number): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  document.problem_class = `nota-curta-com-teto-${String(cap)}`;
  document.max_consecutive_failures = cap;
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

/**
 * Opens a session on a node and closes it with the given status, as the runner
 * does.
 *
 * Deliberately NOT {@link runSessionOn}: that one always completes, and what
 * these cases are about is the session that did not.
 *
 * @param ctx Control plane running.
 * @param jobId The job the session belongs to.
 * @param nodeId Where it runs.
 * @param status How it ends, in the taxonomy's vocabulary.
 * @param extra Anything else the closure carries — `failure_kind` for a refusal.
 */
async function endSessionWith(
  ctx: TestContext,
  jobId: number,
  nodeId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'Redija a nota.',
  });
  assert.equal(opened.status, 201, `POST /v1/sessions returned ${opened.status}`);

  const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status,
    exit_code: status === 'completed' ? 0 : 1,
    ...extra,
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);
}

/** Every `job.blocked` of a job, in log order. */
async function blocks(ctx: TestContext, jobId: number): Promise<Event[]> {
  return (await timeline(ctx, jobId)).filter((event) => event.type === 'job.blocked');
}

test('t265 AT5 — three failed sessions on the same node block the job, with the count', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    title: 'a nota cujas sessões não param de falhar',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  await endSessionWith(ctx, job.id, 'redigir', 'failed');
  assert.equal((await readJob(ctx, job.id)).blocked, false, 'one failure is not a pattern');
  await endSessionWith(ctx, job.id, 'redigir', 'failed');
  assert.equal((await readJob(ctx, job.id)).blocked, false, 'and neither is two');

  await endSessionWith(ctx, job.id, 'redigir', 'failed');

  const stopped = await readJob(ctx, job.id);
  assert.equal(stopped.blocked, true, 'the third one in a row stops the job');
  const reason = stopped.block_reason ?? '';
  assert.ok(reason.includes('redigir'), `the reason has to name the node: ${reason}`);
  assert.ok(
    reason.includes(String(T265_DEFAULT_CAP)),
    `the reason has to carry the count: ${reason}`,
  );

  const recorded = await blocks(ctx, job.id);
  assert.equal(recorded.length, 1, 'one block, one event');
  assert.equal(recorded[0].data.consecutive_failures, T265_DEFAULT_CAP);
  assert.equal(recorded[0].data.reason, stopped.block_reason);
});

test('t265 AT5 — a session that worked resets the streak', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    title: 'a nota que falhou, funcionou e falhou de novo',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  await endSessionWith(ctx, job.id, 'redigir', 'failed');
  await endSessionWith(ctx, job.id, 'redigir', 'failed');
  await endSessionWith(ctx, job.id, 'redigir', 'completed');

  assert.equal((await readJob(ctx, job.id)).blocked, false);
  assert.deepEqual(await blocks(ctx, job.id), [], 'nothing was blocked, so nothing was recorded');

  // ...and the streak really starts over: this is the THIRD failed session of
  // the node, and only the first one of the current run.
  await endSessionWith(ctx, job.id, 'redigir', 'failed');

  assert.equal(
    (await readJob(ctx, job.id)).blocked,
    false,
    'the count is trailing: three failures with a success among them are not three in a row',
  );
});

test('t265 AT5 — a graph that declares max_consecutive_failures: 1 blocks on the first failure', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphWithFailureCap(ctx, 1);

  const job = await createJob(ctx, {
    title: 'a nota de uma classe que não dá segunda chance',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  await endSessionWith(ctx, job.id, 'redigir', 'failed');

  const stopped = await readJob(ctx, job.id);
  assert.equal(stopped.blocked, true, 'the document declared one, and one is what it took');
  assert.ok((stopped.block_reason ?? '').includes('redigir'));

  const recorded = await blocks(ctx, job.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].data.consecutive_failures, 1);
});

test('t265 AT5 — a job already blocked does not get a second block', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphWithFailureCap(ctx, 1);

  const job = await createJob(ctx, {
    title: 'a nota que já estava parada por outro motivo',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const halted = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'este nó não tem a quem perguntar, e a sessão travou',
  });
  assert.equal(halted.status, 200);

  await endSessionWith(ctx, job.id, 'redigir', 'failed');

  const stopped = await readJob(ctx, job.id);
  assert.equal(stopped.blocked, true);
  assert.equal(
    stopped.block_reason,
    'este nó não tem a quem perguntar, e a sessão travou',
    'the reason a person is already reading may not be overwritten by a second owner',
  );
  assert.equal((await blocks(ctx, job.id)).length, 1, 'one flag, one owner, one event');
});

test('t265 AT5 — a refused session is not counted by the cap: it blocks on its own', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphWithFailureCap(ctx, 1);

  const job = await createJob(ctx, {
    title: 'a nota cuja sessão o engine recusou',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  // The runner blocks a refusal itself, on its first occurrence, with a reason
  // that names the category (`report.ts`). Counting it here as well would put
  // two owners on one flag — which is how a job ends up blocked with nothing
  // pending.
  await endSessionWith(ctx, job.id, 'redigir', 'failed', {
    failure_kind: 'engine_refusal',
    refusal_category: 'reasoning_extraction',
  });

  assert.equal((await readJob(ctx, job.id)).blocked, false);
  assert.deepEqual(await blocks(ctx, job.id), []);
});

/**
 * A quota refusal is not counted by the cap either — and nothing blocks (t296, AT2).
 *
 * The sibling case above and this one are the same guard read from two sides.
 * A refusal is not counted because the RUNNER blocks it, on the first
 * occurrence, and two owners for one flag is how a job ends up blocked with
 * nothing pending. A quota is not counted because nobody blocks it at all: the
 * account will answer again by itself, so the work has to be waiting — the
 * runner holds it back for a cooldown of its own (`dispatch/quota-retry.ts`)
 * and the job stays a candidate the whole time.
 *
 * That is the fact this case pins, and it is the one the incident was about
 * (`notas/2026-08-18-n3-round.md`, hole 1): three sessions failed in twenty
 * seconds, the cap fired, the job read "blocked — consecutive failures", and a
 * person had to unblock it by hand — twice, because after the unblock the next
 * attempt hit the same limit. A stranger cloning this repository and hitting
 * their own account's limit would read that as "broken" rather than as "come
 * back after the reset".
 *
 * Both halves in one test on purpose: "the cap does not fire" only means
 * something next to the proof that the SAME sessions, with nothing but the kind
 * removed, do fire it. Two jobs against one registered version, because the
 * streak is counted per job and per node.
 */
test('t296 AT2 — quota sessions leave the job unblocked; plain failures still block it', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const cap = 2;
  const versionId = await registerGraphWithFailureCap(ctx, cap);

  const throttled = await createJob(ctx, {
    title: 'a nota cujas sessões bateram no limite da conta',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  for (let attempt = 0; attempt < cap; attempt += 1) {
    await endSessionWith(ctx, throttled.id, 'redigir', 'failed', { failure_kind: 'quota' });
  }

  assert.equal(
    (await readJob(ctx, throttled.id)).blocked,
    false,
    'an account that hit its own limit is not a job that is broken',
  );
  assert.deepEqual(
    await blocks(ctx, throttled.id),
    [],
    'and nothing was recorded against it either: there is no flag for a person to clear',
  );

  const broken = await createJob(ctx, {
    title: 'a nota cujas sessões falham de verdade',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  for (let attempt = 0; attempt < cap; attempt += 1) {
    await endSessionWith(ctx, broken.id, 'redigir', 'failed');
  }

  assert.equal(
    (await readJob(ctx, broken.id)).blocked,
    true,
    'the same sessions, with the kind removed, are the streak the cap exists for',
  );
  assert.equal((await blocks(ctx, broken.id)).length, 1, 'one block, one event');
});

/* -------------------------------------------------------------------------- */
/* t283 — no job runs against a version whose contracts were never checked.    */
/*                                                                             */
/* Registering a graph and running work against it stopped being the same      */
/* guarantee. `POST /v1/graphs` stays permissive — a document whose skills      */
/* arrive later is the ordinary case for the editor and for a forked example — */
/* and the promise that a contract is CHECKED and not merely declared (D9,     */
/* README principle 3) is kept here, at the one door work comes through.       */
/* -------------------------------------------------------------------------- */

/** Registers the minimal graph with its pins left unresolved: an `unchecked` version. */
async function registerUncheckedGraph(ctx: TestContext, className: string): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  document.problem_class = className;

  const response = await request<{ graph_version: { id: string; contracts: { state: string } } }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(
    response.body.graph_version.contracts.state,
    'unchecked',
    'the committed fixture pins ids the registry can never carry, so nothing resolves',
  );
  return response.body.graph_version.id;
}

/** The refusal body of `POST /v1/jobs`, in the slice these cases read. */
interface JobRefusal {
  error: string;
  message?: string;
  graph_version_id?: string;
  contracts?: { state: string; problems: Array<{ code: string; node_id: string }> };
}

test('t283 — a job named on an unchecked version is refused with 409, and nothing is written', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerUncheckedGraph(ctx, 'nota-curta-sem-conferir');
  const before = countEvents(ctx);

  const response = await request<JobRefusal>(ctx, 'POST', '/v1/jobs', {
    title: 'uma nota contra um grafo que ninguém conferiu',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, 'graph_version_unchecked');
  assert.equal(response.body.graph_version_id, versionId);
  assert.equal(response.body.contracts?.state, 'unchecked');
  assert.deepEqual(
    (response.body.contracts?.problems ?? [])
      .filter((problem) => problem.code === 'skill_ref_unresolved')
      .map((problem) => problem.node_id),
    ['redigir', 'revisar'],
    'the refusal names the pins to register — that is the actionable half of it',
  );

  assert.equal(countEvents(ctx), before, 'a refused job records no `job.created`');
  const jobs = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs');
  assert.deepEqual(jobs.body.jobs, [], 'and it is not a row either');
});

test('t283 — a job named on a failed version is refused with its own code', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);

  // The lineage comes from the route so the `graph` row exists; the `failed`
  // version is written through the repository, which is the only way to get one
  // here — `POST /v1/graphs` answers 422 for a document that fails the gate, and
  // `failed` is a state a version only ever reaches later.
  const registered = await registerUncheckedGraph(ctx, 'nota-curta-reprovada');
  const graphId = (
    ctx.db.prepare('SELECT graph_id FROM graph_version WHERE id = ?').get(registered) as {
      graph_id: string;
    }
  ).graph_id;

  const snapshot = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as GraphDocument;
  const versionId = `sha256:${'d'.repeat(64)}`;
  insertVersion(ctx.db, {
    id: versionId,
    graph_id: graphId,
    parent_version: null,
    snapshot,
    source: 'manual',
    proposal_id: null,
    created_at: new Date().toISOString(),
    contracts: {
      state: 'failed',
      problems: [
        {
          code: 'unproduced_input',
          node_id: 'revisar',
          key: 'texto',
          message: 'node "revisar" requires the input path "texto", which nothing supplies',
          produced_elsewhere_by: [],
        },
      ],
    },
  });

  const response = await request<JobRefusal>(ctx, 'POST', '/v1/jobs', {
    title: 'uma nota contra um grafo reprovado',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(
    response.body.error,
    'graph_version_contracts_failed',
    'a check that RAN and refused is a different fact from one that never ran, and the way out ' +
      'of each is different: register the manifests, or write a new version',
  );
  assert.equal(response.body.contracts?.state, 'failed');
  assert.deepEqual(
    (response.body.contracts?.problems ?? []).map((problem) => problem.code),
    ['unproduced_input'],
  );
});

test('t283 — a checked version carries a job exactly as it always did', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);

  // `registerMinimalGraph` registers the pinned manifests first, so the version
  // is born `checked` — which is the whole of what the gate asks for.
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    title: 'a nota de sempre',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  assert.equal(job.graph_version_id, versionId);
});

test('t283 — a graph_version_id that resolves to nothing is still ungated', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  // Unchanged behaviour, and deliberately so: a job may cite a version this
  // database never saw (an import, a hand-written row, a runner pointing at
  // another control plane), and the gate has nothing to read. Refusing here
  // would be inventing a verdict out of an absence.
  const job = await createJob(ctx, {
    title: 'texto solto, como sempre foi',
    entry_node_id: 'redigir',
    graph_version_id: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(job.graph_version_id, `sha256:${'a'.repeat(64)}`);

  const withNone = await createJob(ctx, { title: 'sem grafo nenhum', entry_node_id: 'redigir' });
  assert.equal(withNone.graph_version_id, null);
});
