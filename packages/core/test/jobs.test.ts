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
import { grantLease } from '../src/repositories/leases.ts';
import {
  PACKAGE_ROOT,
  T102_ARTIFACTS,
  countEvents,
  createJob,
  requireArtifacts,
  request,
  resolvePins,
  resolvePinsOver,
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
 * shared `Job` of `support.ts` carries the columns every ticket shares, and
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
/* Until this ticket `concluido` was `final_nodes.includes(no_atual)` and       */
/* nothing else, so the traveller was declared finished the instant it LANDED   */
/* on the last node — and the skill that node pins never got a session, because */
/* the controller's candidate list drops a `completed` job before the runner    */
/* sees it (`packages/runner/src/controller/cliente-controle.ts`). t198's first */
/* real crossing of the bets bundle found it on `registro-monitoramento`.       */
/*                                                                             */
/* The rule below keys on `skill_ref` PRESENCE and never on `node_type`:        */
/* `docs/spec/graph.md` §2 says a gate is "a node like any other", and this     */
/* fixture's own final node is a gate that pins a real skill.                   */
/* -------------------------------------------------------------------------- */

/**
 * The `output` schema the final node's registered skill declares.
 *
 * A gate's outcome vocabulary is not this file's to choose: the registry
 * demands exactly `pass`/`fail`/`escalate_human`
 * (`src/repositories/skill.ts`, `checkGateOutcome`), so the executor can route.
 * `evidence` rides along because an agentic gate verifies with evidence of its
 * own (D9) — and because a report that omits it is what AT-3 needs refused.
 */
const REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'evidence'],
  additionalProperties: false,
  properties: {
    outcome: { enum: ['pass', 'fail', 'escalate_human'] },
    evidence: { type: 'string', minLength: 1 },
  },
};

/** A report the schema above accepts, whole. */
const CONFORMING_REPORT = {
  outcome: 'pass',
  evidence: 'the note answers the stated theme, in the second paragraph',
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
    description: 'Checks the note against the stated theme and closes the crossing.',
    input: { type: 'object', properties: { theme: { type: 'string' } } },
    output: REVIEW_OUTPUT_SCHEMA,
    preconditions: [],
    checks: [
      {
        id: 'nota-existe',
        type: 'deterministic',
        description: 'The note exists and is not empty.',
        command: 'test -s nota.md',
      },
    ],
    permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
    instructions: '# Review the note\n\nCheck the note against the theme.',
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
    title: 'Entities and API: job, session, event and input request',
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
    title: 'Entities and API: job, session, event and input request',
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
    title: 'Rename a variable',
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
    title: 'urgency is not a tier',
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

  const job = await createJob(ctx, { title: 'walk', entry_node_id: 'entrada' });

  const first = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'implementar',
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.current_node_id, 'implementar');

  const second = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.current_node_id, 'revisar');

  const transitions = (await timeline(ctx, job.id)).filter(
    (event) => event.type === 'job.transitioned',
  );
  assert.equal(transitions.length, 2);
  assert.deepEqual(
    transitions[0].data,
    { from_node_id: null, to_node_id: 'implementar' },
    'on the first transition the job leaves the entry node: de_no_id is null',
  );
  assert.deepEqual(transitions[1].data, { from_node_id: 'implementar', to_node_id: 'revisar' });
});

test('AT3 — block and unblock move the flag and record both events', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'stop', entry_node_id: 'entrada' });

  const blocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'waiting for the human to answer',
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.blocked, true);
  assert.equal(blocked.body.block_reason, 'waiting for the human to answer');
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
    reason: 'waiting for the human to answer',
    consecutive_failures: null,
  });
  // t339: `reason` is optional on `job.unblocked`, and an unblock that states
  // none records the explicit `null` `validateData` normalizes it to — the same
  // shape `consecutive_failures` carries on the block above.
  assert.deepEqual(flags[1].data, { reason: null }, 'the fall of the flag, with nobody stating why');
});

test('t339 — POST /v1/jobs/:id/unblocks records the reason a person stated', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'held', entry_node_id: 'entrada' });
  await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'promotion proposed' });

  const unblocked = await request<Job>(ctx, 'POST', `/v1/jobs/${job.id}/unblocks`, {
    reason: 'the rule matched three weeks of real trades; releasing it',
    actor: { type: 'user', ref: 'rafael' },
  });
  assert.equal(unblocked.status, 200);
  assert.equal(unblocked.body.blocked, false);
  assert.equal(unblocked.body.block_reason, null);

  const unblocks = (await timeline(ctx, job.id)).filter((event) => event.type === 'job.unblocked');
  assert.equal(unblocks.length, 1);
  assert.deepEqual(unblocks[0].data, {
    reason: 'the rule matched three weeks of real trades; releasing it',
  });
  assert.equal(unblocks[0].actor.type, 'user', 'a person released it, and the audit says so');
  assert.equal(unblocks[0].actor.ref, 'rafael');
});

test('AT4 — PATCH /v1/jobs/:id amends the title and records only the field NAME', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'old title', entry_node_id: 'entrada' });

  const response = await request<Job>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    title: 'new title, with a secret inside',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'new title, with a secret inside');

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

  const job = await createJob(ctx, { title: 'old title', entry_node_id: 'entrada' });
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
    'old title',
    'and it does not touch the row either',
  );
});

test('AT5 — GET /v1/jobs returns the current board, with a per-execution filter', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const one = await createJob(ctx, {
    title: 'in execution 7, version v1',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/transitions`, { to_node_id: 'implementar' });
  await request(ctx, 'POST', `/v1/jobs/${one.id}/blocks`, { reason: 'jammed' });

  const two = await createJob(ctx, {
    title: 'in execution 8',
    entry_node_id: 'entrada',
    execution_id: 8,
  });

  const all = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(all.status, 200);
  assert.equal(all.body.jobs.length, 2, 'one job per row');

  const board = all.body.jobs.find((row) => row.id === one.id);
  assert.ok(board !== undefined);
  assert.equal(board.current_node_id, 'implementar');
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
    title: 'with a session and an input request',
    entry_node_id: 'entrada',
    execution_id: 7,
  });
  const neighbour = await createJob(ctx, {
    title: 'the neighbour, which may not leak',
    entry_node_id: 'entrada',
    execution_id: 7,
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'refinar' });

  const session = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'refinar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine the job',
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    session_id: session.body.id,
    kind: 'question',
    question: 'renumber the migration?',
    auto_approvable: false,
  });
  assert.equal(inputRequest.status, 201);

  // Neighbour noise: same execution, same event type, another job.
  await request(ctx, 'POST', '/v1/sessions', {
    job_id: neighbour.id,
    engine: 'claude-code',
    working_dir: '/tmp/neighbour',
    prompt: 'something else',
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

  const job = await createJob(ctx, { title: 'the only one', entry_node_id: 'entrada' });
  const before = countEvents(ctx);

  const missing = job.id + 999;
  for (const [routePath, body] of [
    [`/v1/jobs/${missing}/transitions`, { to_node_id: 'implementar' }],
    [`/v1/jobs/${missing}/blocks`, { reason: 'jammed' }],
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

  const withoutEntryNode = await request(ctx, 'POST', '/v1/jobs', { title: 'no entry node' });
  assert.equal(withoutEntryNode.status, 400);

  const withoutTitle = await request(ctx, 'POST', '/v1/jobs', { entry_node_id: 'entrada' });
  assert.equal(withoutTitle.status, 400);

  const job = await createJob(ctx, { title: 'valid', entry_node_id: 'entrada' });
  const afterValid = countEvents(ctx);

  const withoutTarget = await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {});
  assert.equal(withoutTarget.status, 400);

  const withoutReason = await request(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {});
  assert.equal(withoutReason.status, 400);

  assert.equal(countEvents(ctx), afterValid, 'an invalid request leaves no trace in the log');
  assert.equal(afterValid, before + 1, 'only the valid job recorded an event');
});

test('t152 — a job with no graph version is never reported as completed', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'newborn', entry_node_id: 'redigir' });
  const projection = await readJob(ctx, job.id);

  assert.equal(projection.graph_version_id, null);
  assert.equal(
    projection.completed,
    false,
    'with no graph attached there is no final_nodes to derive a terminal state from',
  );
});

test('t262 AT-1 — arriving at a final node that pins a skill is not enough to be completed', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    title: 'the short note',
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
    title: 'the note that really was reviewed',
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
    title: 'the review that reported crooked',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${refused.id}/transitions`, { to_node_id: 'revisar' });
  // `escala` is the graph fixture's own vocabulary, not the registry's, and
  // `evidence` is missing: the registered schema refuses it, `finishSession`
  // stores `output: null` and records the reason in the event (t253).
  await runSessionOn(ctx, refused.id, 'revisar', { outcome: 'escala' });

  const afterRefusal = await readJob(ctx, refused.id);
  assert.equal(afterRefusal.completed, false, 'a refused report is not a report');
  assert.equal(
    afterRefusal.blocked,
    false,
    'and it does not block either: capping repeated failed attempts is t265, not this ticket',
  );

  const silent = await createJob(ctx, {
    title: 'the review that reported nothing',
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

test('t262 AT-4 — a blocked job is not completed, even parked on a finished final node', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const job = await createJob(ctx, {
    title: 'the note that jammed at the end',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });
  await runSessionOn(ctx, job.id, 'revisar', CONFORMING_REPORT);
  assert.equal((await readJob(ctx, job.id)).completed, true, 'it finished before blocking');

  const blocked = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'the review stopped waiting for someone',
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

test('t262 AT-4 — GET /v1/jobs reports the same completed as GET /v1/jobs/:id', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);

  const arrived = await createJob(ctx, {
    title: 'arrived at the end',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${arrived.id}/transitions`, { to_node_id: 'revisar' });
  await runSessionOn(ctx, arrived.id, 'revisar', CONFORMING_REPORT);

  const standing = await createJob(ctx, {
    title: 'parked on the final node, never having run',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${standing.id}/transitions`, { to_node_id: 'revisar' });

  const walking = await createJob(ctx, {
    title: 'still in the middle',
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

test('t262 AT-5 — a final node with no skill_ref at all is completed on arrival, as before', async (t) => {
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
    title: 'the note of a snapshot with no pin on the final node',
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
    title: 'the only job of the round',
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
      'completed, and it has to announce the round like the other two do (FR4)',
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

  const filled = { premise_source: 'quarterly report 2026Q2', downside: -12.5, upside: 40 };
  const response = await request<JobProjection>(ctx, 'POST', '/v1/jobs', {
    title: 'the copper thesis',
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

  const bare = await createJob(ctx, { title: 'no field', entry_node_id: 'triagem' });
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
    title: 'the thesis with no source',
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
    title: 'the thesis that gained a source',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  assert.equal(
    (await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' })).status,
    400,
    'it starts refused, so the green below is the amendment and not a permissive gate',
  );

  const amended = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    fields: { premise_source: 'quarterly report 2026Q2, page 12' },
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

  const job = await createJob(ctx, { title: 'the thesis', entry_node_id: 'triagem' });

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
    fields: { premise_source: 'quarterly report', downside: -12.5 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.fields, {
    premise_source: 'quarterly report',
    downside: -12.5,
  });
  assert.equal(response.body.title, 'the thesis', 'amending one field does not touch the other');

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
    !JSON.stringify(amendments[0].data).includes('quarterly'),
    'and the values the person typed stay out of the audit record',
  );

  const both = await request<JobProjection>(ctx, 'PATCH', `/v1/jobs/${job.id}`, {
    title: 'the thesis, revised',
    fields: { premise_source: 'another source' },
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
    repo: 'git@github.com:octo-org/cartografo.git',
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
    description: 'The approved note goes on to publication.',
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
    title: 'A note about the context projection',
    body: 'the raw request',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
    execution_id: 7,
  });

  await runNode(ctx, job.id, 'redigir', 'completed', { branch: 'nota-1', texto: 'first cut' });
  await runNode(ctx, job.id, 'revisar', 'completed', { outcome: 'pass', evidence: 'checks out' });
  await runNode(ctx, job.id, 'publicar', 'completed', { url: 'https://example/nota-1' });
  // Neither of these two is a fact about the graph: one failed, and one is still
  // running. Their reports must not reach the projection.
  await runNode(ctx, job.id, 'redigir', 'failed', { branch: 'nao-conta' });
  const opened = await request<SessionRef>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'redigir',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'still running',
  });
  assert.equal(opened.status, 201);

  const asked = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    kind: 'question',
    question: 'Publish today?',
    auto_approvable: false,
  });
  assert.equal(asked.status, 201);
  const answered = await request<unknown>(
    ctx,
    'PATCH',
    `/v1/input-requests/${asked.body.id}/answer`,
    { answer: 'Publish tomorrow.', answered_by: 'rafael' },
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
    title: 'A note about the context projection',
    body: 'the raw request',
  });
  assert.deepEqual(input.project, {
    repo: 'git@github.com:octo-org/cartografo.git',
    comando_testes: 'npm test',
  });
  assert.deepEqual(
    input.artefato,
    { branch: 'nota-1', texto: 'first cut', url: 'https://example/nota-1' },
    'the bucket accumulates across the gate that declares none',
  );
  assert.equal(input.outcome, 'pass', 'the gate merged at the top level');
  assert.equal(input.evidence, 'checks out');
  assert.deepEqual(input.perguntas_respondidas, [
    { id: String(asked.body.id), pergunta: 'Publish today?', resposta: 'Publish tomorrow.' },
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
    title: 'Short note',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
    fields: { premise_source: 'note from 2026-08-17' },
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
    job: { id: job.id, title: 'Short note', body: null, fields: { premise_source: 'note from 2026-08-17' } },
    snapshot: {
      nodes: [
        { id: 'redigir', contract: { produces: 'artefato' } },
        { id: 'revisar', contract: {} },
        { id: 'publicar', contract: { produces: 'artefato' } },
      ],
      project: {
        repo: 'git@github.com:octo-org/cartografo.git',
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
/* (D1). Until this ticket nothing published it: `registrar-travessia`, the     */
/* last node of the bets bundle, names `{{input.nos_executados}}` and           */
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
    title: 'parked on the entry node',
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
    title: 'a crossing of three nodes',
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
    title: 'rework on the same node',
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
    prompt: 'Draft the note.',
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
    title: 'the note whose sessions never stop failing',
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
    title: 'the note that failed, worked and failed again',
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
    title: 'the note of a class that gives no second chance',
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
    title: 'the note already parked for another reason',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const halted = await request<JobProjection>(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'this node has nobody to ask, and the session jammed',
  });
  assert.equal(halted.status, 200);

  await endSessionWith(ctx, job.id, 'redigir', 'failed');

  const stopped = await readJob(ctx, job.id);
  assert.equal(stopped.blocked, true);
  assert.equal(
    stopped.block_reason,
    'this node has nobody to ask, and the session jammed',
    'the reason a person is already reading may not be overwritten by a second owner',
  );
  assert.equal((await blocks(ctx, job.id)).length, 1, 'one flag, one owner, one event');
});

test('t265 AT5 — a refused session is not counted by the cap: it blocks on its own', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphWithFailureCap(ctx, 1);

  const job = await createJob(ctx, {
    title: 'the note whose session the engine refused',
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
 * (`notes/2026-08-18-n3-round.md`, hole 1): three sessions failed in twenty
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
    title: 'the note whose sessions hit the account limit',
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
    title: 'the note whose sessions really do fail',
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
    title: 'a note against a graph nobody checked',
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
    title: 'a note against a refused graph',
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
    title: 'loose text, as it always was',
    entry_node_id: 'redigir',
    graph_version_id: `sha256:${'a'.repeat(64)}`,
  });
  assert.equal(job.graph_version_id, `sha256:${'a'.repeat(64)}`);

  const withNone = await createJob(ctx, { title: 'no graph at all', entry_node_id: 'redigir' });
  assert.equal(withNone.graph_version_id, null);
});

/* -------------------------------------------------------------------------- */
/* t410 — a job read takes the project as a parameter (D25).                   */
/*                                                                            */
/* `job` has carried `project_id` since migration 0003, and nothing ever read  */
/* it back: every read below used to answer with whatever row the id names,    */
/* whichever project wrote it. These cases charge for the same scope           */
/* `routes/graphs.ts` and `routes/skills.ts` already resolve — including the   */
/* non-leaking convention, where a job of another project is exactly as absent */
/* as one that was never created.                                             */
/* -------------------------------------------------------------------------- */

/** The refusal envelope, in the slice the scoped reads assert on. */
interface ScopeRefusal {
  error: string;
  message?: string;
  project_id?: number;
  graph_version_id?: string;
}

/** Declares a project and returns its id (t354, FR1). */
async function declareProject(ctx: TestContext, name: string): Promise<number> {
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/projects', { name });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.id;
}

/**
 * Registers the minimal example graph INSIDE one project, with its pins
 * resolvable there.
 *
 * The registry is per project since t354, so `resolvePins` — which asks and
 * writes in the default project — cannot make a version born in project 2
 * `checked`. `resolvePinsOver` exists for exactly this: the two calls come in
 * as a parameter, and here they carry the scope.
 *
 * @param ctx Control plane running.
 * @param projectId Project the lineage and its manifests are written in.
 * @returns Id of the version born with the lineage — the one a job would cite.
 */
async function registerMinimalGraphIn(ctx: TestContext, projectId: number): Promise<string> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  await resolvePinsOver(document, {
    // The path already carries a `?version=`, so the scope joins it with `&`.
    get: (routePath) => request(ctx, 'GET', `${routePath}&project_id=${projectId}`),
    post: (routePath, body) =>
      request(ctx, 'POST', routePath, {
        ...(body as Record<string, unknown>),
        project_id: projectId,
      }),
  });

  const response = await request<{ graph_version: { id: string; contracts: { state: string } } }>(
    ctx,
    'POST',
    '/v1/graphs',
    { ...document, project_id: projectId },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(
    response.body.graph_version.contracts.state,
    'checked',
    'the pins were registered in this same project, so the check ran and passed',
  );
  return response.body.graph_version.id;
}

/** How many `job.created` facts the log carries — the write AT6 charges for. */
function createdJobs(ctx: TestContext): number {
  const row = ctx.db
    .prepare("SELECT COUNT(*) AS total FROM event WHERE type = 'job.created'")
    .get() as { total: number };
  return row.total;
}

test('t410 AT1 — GET /v1/jobs/:id answers 404 for a job of another project', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const mine = await createJob(ctx, { title: 'born in project one', entry_node_id: 'redigir' });
  const theirs = await createJob(ctx, {
    title: 'born in project two',
    entry_node_id: 'redigir',
    project_id: 2,
  });

  // The same refusal a nonexistent id gets, and deliberately so: from inside
  // project 1 the other project's job is not a job that exists.
  const crossed = await request<ScopeRefusal>(ctx, 'GET', `/v1/jobs/${theirs.id}`);
  assert.equal(crossed.status, 404, JSON.stringify(crossed.body));
  assert.equal(crossed.body.error, 'not_found');

  const scoped = await request<JobProjection>(ctx, 'GET', `/v1/jobs/${theirs.id}?project_id=2`);
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.id, theirs.id);

  // And the traffic in the other direction is refused too: a scope is a filter,
  // not a permission level.
  const backwards = await request<ScopeRefusal>(ctx, 'GET', `/v1/jobs/${mine.id}?project_id=2`);
  assert.equal(backwards.status, 404, JSON.stringify(backwards.body));

  const own = await request<JobProjection>(ctx, 'GET', `/v1/jobs/${mine.id}`);
  assert.equal(own.status, 200, 'the default project keeps reading its own job unchanged');
});

test('t410 AT2 — GET /v1/jobs lists one project, and the default stays project 1', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const mine = await createJob(ctx, {
    title: 'round 5 of project one',
    entry_node_id: 'redigir',
    execution_id: 5,
  });
  // The SAME execution number in the other project: a round is a grouper per
  // project, so two of them may legitimately carry the number 5.
  const theirs = await createJob(ctx, {
    title: 'round 5 of project two',
    entry_node_id: 'redigir',
    execution_id: 5,
    project_id: 2,
  });

  const titlesOf = async (query: string): Promise<string[]> => {
    const response = await request<{ jobs: Job[] }>(ctx, 'GET', `/v1/jobs${query}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.jobs.map((job) => job.title);
  };

  assert.deepEqual(await titlesOf(''), ['round 5 of project one']);
  assert.deepEqual(await titlesOf('?project_id=1'), ['round 5 of project one']);
  assert.deepEqual(await titlesOf('?project_id=2'), ['round 5 of project two']);

  // The execution filter narrows WITHIN the scope; it never widens it.
  assert.deepEqual(await titlesOf('?execution_id=5'), ['round 5 of project one']);
  assert.deepEqual(await titlesOf('?execution_id=5&project_id=2'), ['round 5 of project two']);
  assert.ok(mine.id !== theirs.id);
});

test('t410 AT3 — /events and /context answer 404 for a job of another project', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const theirs = await createJob(ctx, {
    title: 'born in project two',
    entry_node_id: 'redigir',
    project_id: 2,
  });

  for (const suffix of ['events', 'context']) {
    const crossed = await request<ScopeRefusal>(ctx, 'GET', `/v1/jobs/${theirs.id}/${suffix}`);
    assert.equal(crossed.status, 404, `${suffix}: ${JSON.stringify(crossed.body)}`);
    assert.equal(crossed.body.error, 'not_found');

    const scoped = await request<Record<string, unknown>>(
      ctx,
      'GET',
      `/v1/jobs/${theirs.id}/${suffix}?project_id=2`,
    );
    assert.equal(scoped.status, 200, `${suffix}: ${JSON.stringify(scoped.body)}`);
  }
});

test('t410 AT4 — the four reads answer 404 unknown_project for a project nobody declared', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'the only job there is', entry_node_id: 'redigir' });

  const routes = [
    '/v1/jobs?project_id=99',
    `/v1/jobs/${job.id}?project_id=99`,
    `/v1/jobs/${job.id}/context?project_id=99`,
    `/v1/jobs/${job.id}/events?project_id=99`,
  ];

  for (const routePath of routes) {
    const refused = await request<ScopeRefusal>(ctx, 'GET', routePath);
    // "There is nothing here" and "there is no here" are different answers, and
    // an empty list for the second turns a typo into a wrong conclusion.
    assert.equal(refused.status, 404, `${routePath}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, 'unknown_project', routePath);
    assert.equal(refused.body.project_id, 99, routePath);
  }
});

test('t410 AT5 — a job never derives `completed` from another project\'s version', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  // Registered, checked and carrying `revisar` as its final node — in project 1
  // and nowhere else.
  const versionId = await registerMinimalGraph(ctx);

  // The control: in the project that OWNS the version, the same walk really
  // does end in `completed: true`. Without it this case would pass on a
  // version nobody could have arrived under.
  const native = await createJob(ctx, {
    title: 'arrives inside its own project',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  const moved = await request(ctx, 'POST', `/v1/jobs/${native.id}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(moved.status, 200);
  await runSessionOn(ctx, native.id, 'revisar', CONFORMING_REPORT);
  assert.equal((await readJob(ctx, native.id)).completed, true, 'the walk itself is sound');

  // The row is written straight to the table: `POST /v1/jobs` refuses this
  // state since this ticket, and the point of the case is what a job in it
  // READS — an import, a restored dump, a row from before the partition.
  const timestamp = new Date().toISOString();
  const inserted = ctx.db
    .prepare(
      `INSERT INTO job (project_id, execution_id, title, corpo, criterios_de_aceite, fields,
                        tier, entry_node_id, current_node_id, blocked, block_reason,
                        graph_version_id, created_at, updated_at)
       VALUES (2, NULL, ?, NULL, NULL, NULL, NULL, 'redigir', 'revisar', 0, NULL, ?, ?, ?)`,
    )
    .run('borrows a hash from project one', versionId, timestamp, timestamp);
  const borrowerId = Number(inserted.lastInsertRowid);

  // Same shape of ending as the control's: a completed session with a report on
  // the final node. Everything `isAtFinalNode` asks for is true — except that
  // the version resolves in the OTHER project.
  await runSessionOn(ctx, borrowerId, 'revisar', CONFORMING_REPORT);

  const borrower = await request<JobProjection>(ctx, 'GET', `/v1/jobs/${borrowerId}?project_id=2`);
  assert.equal(borrower.status, 200, JSON.stringify(borrower.body));
  assert.equal(borrower.body.graph_version_id, versionId);
  assert.equal(
    borrower.body.completed,
    false,
    'the hash is content, and the same content may exist once per project (D25): a job of ' +
      'project 2 has no graph at all here, and never borrows project 1\'s snapshot',
  );
});

test('t410 AT6 — POST /v1/jobs refuses a graph version of another project', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  // Registered and `checked` in project 2, and registered nowhere else.
  const versionId = await registerMinimalGraphIn(ctx, 2);
  const before = createdJobs(ctx);

  const refused = await request<ScopeRefusal>(ctx, 'POST', '/v1/jobs', {
    title: 'a job of project one, against project two\'s version',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(
    refused.body.error,
    'cross_project_reference',
    'a version that resolves SOMEWHERE ELSE is a conflict, never a silent accept: it is a ' +
      'reference crossing a partition, not a hash this database never saw',
  );
  assert.equal(refused.body.graph_version_id, versionId, 'the context rides as a sibling field');
  assert.equal(refused.body.project_id, 1, 'and so does the project the job would have been in');

  assert.equal(createdJobs(ctx), before, 'a refused job records no `job.created`');
  const mine = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs');
  assert.deepEqual(mine.body.jobs, [], 'and it is not a row either');
  const theirs = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs?project_id=2');
  assert.deepEqual(theirs.body.jobs, [], 'nor did it land in the project that owns the version');

  // The job the refusal was pointing at: inside project 2, the same version
  // carries work exactly as it always did.
  const accepted = await createJob(ctx, {
    title: 'the same job, in the project that owns the version',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
    project_id: 2,
  });
  assert.equal(accepted.graph_version_id, versionId);
});

/* -------------------------------------------------------------------------- */
/* t370 — the record of a call to an external MCP server (AT23–AT28).          */
/*                                                                            */
/* RF-37's input half: every call the runner makes to an MCP server on a       */
/* node's behalf leaves a row — which server, when, with what arguments, with  */
/* what summarised result. Two phases and ONE row: an intent written before    */
/* the call, completed after it, the same posture `lease` already takes for    */
/* "append-only" meaning never deleted rather than never updated.              */
/*                                                                            */
/* The crash-safety property is the reason the phases are separate at all: a   */
/* runner that dies mid-call leaves `finished_at` and `outcome` NULL, and      */
/* "unknown" is what a READER concludes from that. Nothing ever writes the     */
/* string.                                                                     */
/* -------------------------------------------------------------------------- */

/** The artifacts this ticket's own cases need on disk. */
const T370_ARTIFACTS = Object.freeze({
  migration: 'migrations/0033_external_calls.sql',
  repository: 'src/repositories/external-calls.ts',
  routes: 'src/routes/jobs.ts',
  auth: 'src/auth.ts',
});

/** One row of `external_call`, as `/v1` publishes it. */
interface ExternalCall {
  id: number;
  job_id: number;
  node_id: string;
  direction: 'input' | 'output';
  name: string;
  server: string;
  tool: string;
  arguments_sha256: string;
  arguments_summary: string;
  started_at: string;
  finished_at: string | null;
  outcome: 'ok' | 'error' | null;
  result_summary: string | null;
}

/** The body an intent is written with, minus whatever a case overrides. */
function intentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: 'collect-fundamentals',
    direction: 'input',
    name: 'report',
    server: 'reports',
    tool: 'read_file',
    arguments_sha256: 'f'.repeat(64),
    arguments_summary: '{"path":"notes/report.md"}',
    started_at: '2026-09-06T12:00:00.000Z',
    ...overrides,
  };
}

/** Creates a job with no graph behind it — every case below only needs an id. */
async function jobForCalls(ctx: TestContext, title: string): Promise<Job> {
  return await createJob(ctx, { title, entry_node_id: 'collect-fundamentals' });
}

test('t370 AT23 — an intent body answers 201 with the outcome still open', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job whose node calls an MCP server');

  const created = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    intentBody(),
  );

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const call = created.body.external_call;
  assert.equal(call.job_id, job.id);
  assert.equal(call.node_id, 'collect-fundamentals');
  assert.equal(call.direction, 'input');
  assert.equal(call.server, 'reports');
  assert.equal(call.tool, 'read_file');
  assert.equal(call.started_at, '2026-09-06T12:00:00.000Z');
  assert.equal(call.outcome, null, 'an intent has no outcome yet, and says so with null');
  assert.equal(call.finished_at, null);
  assert.equal(call.result_summary, null);
  assert.ok(Number.isInteger(call.id), 'and it has an id, which is what completes it');
});

test('t370 AT23 — a body missing a field is a 400 that names it', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job with a malformed record');

  for (const field of ['node_id', 'name', 'server', 'tool', 'arguments_sha256', 'started_at']) {
    const body = intentBody();
    delete body[field];

    const refused = await request<{ error: string; field?: string }>(
      ctx,
      'POST',
      `/v1/jobs/${job.id}/external-calls`,
      body,
    );
    assert.equal(refused.status, 400, `${field}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, 'invalid_body', field);
    assert.equal(refused.body.field, field, 'the refusal names the field, not just the fact');
  }

  const unknownJob = await request<{ error: string }>(
    ctx,
    'POST',
    '/v1/jobs/9999/external-calls',
    intentBody(),
  );
  assert.equal(unknownJob.status, 404);
  assert.equal(unknownJob.body.error, 'not_found');
});

test('t370 AT24 — completing answers 200; completing twice is a 409', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job whose call completes');

  const created = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    intentBody(),
  );
  assert.equal(created.status, 201);
  const callId = created.body.external_call.id;

  const completion = {
    call_id: callId,
    finished_at: '2026-09-06T12:00:01.000Z',
    outcome: 'ok',
    result_summary: 'text/plain, 1 240 bytes, sha256 a1b2',
  };

  const completed = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    completion,
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.external_call.id, callId, 'one row, updated — never a second row');
  assert.equal(completed.body.external_call.outcome, 'ok');
  assert.equal(completed.body.external_call.finished_at, '2026-09-06T12:00:01.000Z');
  assert.equal(
    completed.body.external_call.result_summary,
    'text/plain, 1 240 bytes, sha256 a1b2',
  );

  const again = await request<{ error: string }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    completion,
  );
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(
    again.body.error,
    'external_call_already_completed',
    'completing twice is a conflict, never an overwrite of the first answer',
  );

  const listed = await request<{ external_calls: ExternalCall[] }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/external-calls`,
  );
  assert.equal(listed.body.external_calls.length, 1, 'and the refusal wrote nothing');
});

test('t370 AT25 — an error outcome is stored, and both summaries are capped at 1 KiB', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job whose call failed, verbosely');

  const created = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    intentBody({ arguments_summary: 'a'.repeat(5_000) }),
  );
  assert.equal(created.status, 201);
  assert.equal(
    created.body.external_call.arguments_summary.length,
    1_024,
    'the cap is the server\'s, never the caller\'s promise that it already capped',
  );

  const completed = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    {
      call_id: created.body.external_call.id,
      finished_at: '2026-09-06T12:00:02.000Z',
      outcome: 'error',
      result_summary: 'b'.repeat(5_000),
    },
  );
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.external_call.outcome, 'error');
  assert.equal(completed.body.external_call.result_summary?.length, 1_024);

  // What was STORED, read back through the listing rather than echoed: a route
  // that truncated only on the way out would still be keeping the whole payload.
  const listed = await request<{ external_calls: ExternalCall[] }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/external-calls`,
  );
  assert.equal(listed.body.external_calls[0]?.arguments_summary.length, 1_024);
  assert.equal(listed.body.external_calls[0]?.result_summary?.length, 1_024);

  const refused = await request<{ error: string; field?: string }>(
    ctx,
    'POST',
    `/v1/jobs/${job.id}/external-calls`,
    { call_id: created.body.external_call.id, finished_at: 'x', outcome: 'maybe' },
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.field, 'outcome', 'a third outcome is not a vocabulary this has');
});

test('t370 AT26 — an intent nobody completed reads as NULL, never as "unknown"', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job whose runner died mid-call');

  // The crash, simulated as what a crash actually leaves behind: the intent was
  // written and the completion never arrived.
  await request(ctx, 'POST', `/v1/jobs/${job.id}/external-calls`, intentBody());

  const listed = await request<{ external_calls: ExternalCall[] }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/external-calls`,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.external_calls.length, 1);
  assert.equal(listed.body.external_calls[0]?.outcome, null);
  assert.equal(listed.body.external_calls[0]?.finished_at, null);

  const stored = ctx.db.prepare('SELECT * FROM external_call').all() as Record<string, unknown>[];
  assert.equal(
    JSON.stringify(stored).includes('unknown'),
    false,
    '"unknown" is a reading of two NULLs, and this system never writes it down',
  );
});

test('t370 AT27 — a call_id of another job is the same 404 an unknown id gets', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const mine = await jobForCalls(ctx, 'the job that made the call');
  const theirs = await jobForCalls(ctx, 'a different job entirely');

  const created = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${mine.id}/external-calls`,
    intentBody(),
  );
  assert.equal(created.status, 201);

  const completion = {
    finished_at: '2026-09-06T12:00:03.000Z',
    outcome: 'ok',
    result_summary: 'text/plain',
  };

  const crossJob = await request<{ error: string }>(
    ctx,
    'POST',
    `/v1/jobs/${theirs.id}/external-calls`,
    { ...completion, call_id: created.body.external_call.id },
  );
  assert.equal(crossJob.status, 404, JSON.stringify(crossJob.body));
  assert.equal(crossJob.body.error, 'not_found');

  const unknownId = await request<{ error: string }>(
    ctx,
    'POST',
    `/v1/jobs/${mine.id}/external-calls`,
    { ...completion, call_id: 987_654 },
  );
  assert.equal(unknownId.status, 404, 'a boundary a client can tell apart is a boundary it maps');
  assert.equal(unknownId.body.error, 'not_found');

  // And nothing changed on the row the cross-job attempt was pointing at.
  const listed = await request<{ external_calls: ExternalCall[] }>(
    ctx,
    'GET',
    `/v1/jobs/${mine.id}/external-calls`,
  );
  assert.equal(listed.body.external_calls[0]?.outcome, null);
  assert.deepEqual(
    (
      await request<{ external_calls: ExternalCall[] }>(
        ctx,
        'GET',
        `/v1/jobs/${theirs.id}/external-calls`,
      )
    ).body.external_calls,
    [],
    'the listing is scoped through the job, so the other one shows nothing',
  );
});

test('t370 AT28 — the runner writes the record and may not read the history back', async (t) => {
  requireArtifacts(...Object.values(T370_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job a runner reports a call for');

  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', {
    id: 'runner-t370',
  });
  assert.equal(paired.status, 201);
  const runnerToken = paired.body.token ?? '';
  assert.notEqual(runnerToken, '', 'pairing is where a runner credential comes from');

  const asRunner = async (
    method: string,
    routePath: string,
    body?: unknown,
  ): Promise<{ status: number; body: { error?: string } }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${runnerToken}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${ctx.url}${routePath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as { error?: string } };
  };

  // Writing the record IS what a runner is for on this route: it is the only
  // side that knows a call happened.
  const written = await asRunner('POST', `/v1/jobs/${job.id}/external-calls`, intentBody());
  assert.equal(written.status, 201, JSON.stringify(written.body));

  // Reading the history back is the operator's, by omission — this dispatch
  // never reads its own calls, and a route enters `RUNNER_SURFACE` the day
  // something really calls it, one route at a time.
  const denied = await asRunner('GET', `/v1/jobs/${job.id}/external-calls`);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(denied.body.error, 'out_of_scope_credential');
});

/* -------------------------------------------------------------------------- */
/* t415 — the six states of a job, derived from the log (RF-30, AT9–AT17).     */
/*                                                                             */
/* No column stores any of them: `state` and `state_since` are computed at read */
/* time off facts the control plane already has — the pending question, the     */
/* blocked flag, the active lease and its deadline, the open session, the       */
/* version's `final_nodes` and the log's own `job.blocked`/`job.transitioned`.  */
/* The priority order is RF-30's, and the two ambiguities it names have a case  */
/* each here: AT9 (a question outranks the flag) and AT14 (an open session on a */
/* final node is `running`, never `completed`).                                 */
/*                                                                             */
/* What AT17 guards is the SHAPE of the read: the board resolves every job in a */
/* bounded number of statements, so a state per row never becomes a query per   */
/* row — the same discipline `listRunnersWithHealth` already writes for the     */
/* fleet page.                                                                  */
/* -------------------------------------------------------------------------- */

/** The projection with the two fields this ticket adds. */
type JobWithState = JobProjection & { state: string; state_since: string };

/** Reads one job's projection, asserting on the state fields. */
async function readState(ctx: TestContext, id: number): Promise<JobWithState> {
  const response = await request<JobWithState>(ctx, 'GET', `/v1/jobs/${id}`);
  assert.equal(response.status, 200);
  return response.body;
}

/** The whole board, keyed by job id. */
async function readBoard(ctx: TestContext): Promise<Map<number, JobWithState>> {
  const response = await request<{ jobs: JobWithState[] }>(ctx, 'GET', '/v1/jobs');
  assert.equal(response.status, 200);
  return new Map(response.body.jobs.map((job) => [job.id, job]));
}

/** Opens a session and leaves it open — the runner mid-dispatch. */
async function openSessionOn(ctx: TestContext, jobId: number, nodeId: string): Promise<number> {
  const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'Write the note.',
  });
  assert.equal(opened.status, 201, `POST /v1/sessions returned ${opened.status}`);
  return opened.body.id;
}

/** Pairs a runner, so the lease below has an identity to belong to. */
async function pairRunner(ctx: TestContext, id: string): Promise<void> {
  const response = await request(ctx, 'POST', '/v1/runners', { id, name: id });
  assert.ok(
    response.status === 201 || response.status === 200,
    `POST /v1/runners returned ${response.status}`,
  );
}

/** Grants a live lease over a job, through the real route. */
async function leaseJob(
  ctx: TestContext,
  runnerId: string,
  jobId: number,
): Promise<{ granted_at: string; expires_at: string }> {
  const response = await request<{ lease: { granted_at: string; expires_at: string } }>(
    ctx,
    'POST',
    '/v1/leases',
    {
      runner_id: runnerId,
      project_id: 1,
      job_id: jobId,
      runner_cap: 10,
      project_cap: 10,
      ttl_seconds: 600,
    },
  );
  assert.equal(response.status, 201, `POST /v1/leases returned ${response.status}`);
  return response.body.lease;
}

/**
 * Grants a lease whose deadline is already behind us, and leaves it `active`.
 *
 * Through the repository with an injected clock, and never through the route:
 * the three read-or-act lease verbs open with `claimExpired` (t256), so asking
 * the API for an overdue lease is asking it to reconcile the very row this case
 * needs untouched. `unowned` exists because NOTHING sweeps — the column still
 * says `active` while the deadline is an hour gone — and a fixture that let the
 * sweep run would be testing the state that does not exist.
 */
function leaseInThePast(ctx: TestContext, runnerId: string, jobId: number): { expires_at: string } {
  const granted = grantLease(
    ctx.db,
    {
      runner_id: runnerId,
      project_id: 1,
      job_id: jobId,
      runner_cap: 10,
      project_cap: 10,
      ttl_seconds: 60,
    },
    { now: () => new Date(Date.now() - 3600_000).toISOString() },
  );
  assert.ok(granted.lease !== null, 'the lease of the past was refused');
  return { expires_at: granted.lease.expires_at };
}

/**
 * Registers a version whose final node pins nothing, so arriving IS finishing.
 *
 * Hand-inserted for the reason t262's AT-5 already gives: `graph.schema.json`
 * makes `skill_ref` mandatory, so no document that passes the registration gate
 * can reach this branch.
 */
function insertUnpinnedVersion(ctx: TestContext, graphId: string, versionId: string): string {
  const snapshot = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as GraphDocument;
  delete (snapshot.nodes[1] as Record<string, unknown>).skill_ref;
  insertVersion(ctx.db, {
    id: versionId,
    graph_id: graphId,
    parent_version: null,
    snapshot,
    source: 'manual',
    proposal_id: null,
    created_at: new Date().toISOString(),
    contracts: { state: 'checked', problems: [] },
  });
  return versionId;
}

/** The lineage a registered version belongs to — what an inserted one hangs off. */
function graphIdOf(ctx: TestContext, versionId: string): string {
  return (
    ctx.db.prepare('SELECT graph_id FROM graph_version WHERE id = ?').get(versionId) as {
      graph_id: string;
    }
  ).graph_id;
}

/** The `occurred_at` of the last event of a type, off the job's own timeline. */
async function lastEventAt(ctx: TestContext, jobId: number, type: string): Promise<string> {
  const events = await timeline(ctx, jobId);
  const matching = events.filter((event) => event.type === type);
  assert.ok(matching.length > 0, `the job has no ${type} in its timeline`);
  return matching[matching.length - 1].occurred_at;
}

test('t415 AT9 — a pending question is awaiting_you, since the question was asked', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'the one that asks', entry_node_id: 'entrada' });
  const asked = await request<{ created_at: string }>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    kind: 'question',
    question: 'Which of the two numberings stays?',
    auto_approvable: false,
  });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));

  const seen = await readState(ctx, job.id);
  assert.equal(
    seen.blocked,
    true,
    'the escalation blocked the job too (t106) — which is exactly why this case is ambiguity 1',
  );
  assert.equal(seen.state, 'awaiting_you', 'a person is what is missing, and that outranks the flag');
  assert.equal(seen.state_since, asked.body.created_at, 'the wait started at the question');
});

test('t415 AT10 — blocked with nothing pending is blocked_unasked, since the block', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, { title: 'the stopped one', entry_node_id: 'entrada' });
  const blocked = await request(ctx, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'the premise stopped holding',
  });
  assert.equal(blocked.status, 200);

  const seen = await readState(ctx, job.id);
  assert.equal(seen.state, 'blocked_unasked', 'stopped, and nobody was even asked anything');
  assert.equal(seen.state_since, await lastEventAt(ctx, job.id, 'job.blocked'));
});

test('t415 AT11 — an open session under a live lease is running, since the grant', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await pairRunner(ctx, 'runner-a');

  const job = await createJob(ctx, { title: 'the one being worked', entry_node_id: 'entrada' });
  const lease = await leaseJob(ctx, 'runner-a', job.id);
  await openSessionOn(ctx, job.id, 'entrada');

  const seen = await readState(ctx, job.id);
  assert.equal(seen.state, 'running');
  assert.equal(seen.state_since, lease.granted_at);
});

test('t415 AT12 — an open session past its lease deadline is unowned, and the row stays active', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  await pairRunner(ctx, 'runner-a');

  const job = await createJob(ctx, { title: 'the one nobody holds', entry_node_id: 'entrada' });
  const lease = leaseInThePast(ctx, 'runner-a', job.id);
  await openSessionOn(ctx, job.id, 'entrada');

  const seen = await readState(ctx, job.id);
  assert.equal(seen.state, 'unowned', 'the deadline passed and no sweep exists to notice');
  assert.equal(seen.state_since, lease.expires_at, 'ownerless since the deadline, not since the grant');

  const row = ctx.db.prepare('SELECT status FROM lease WHERE job_id = ?').get(job.id) as {
    status: string;
  };
  assert.equal(
    row.status,
    'active',
    'nothing reconciled the lease: the state is derived from the DEADLINE, never from the column',
  );
});

test('t415 AT13 — arriving at a final node that pins nothing is completed, at the arrival', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);

  const registered = await registerMinimalGraph(ctx);
  const versionId = insertUnpinnedVersion(
    ctx,
    graphIdOf(ctx, registered),
    'sha256:' + 'a'.repeat(64),
  );

  const job = await createJob(ctx, {
    title: 'the note of a graph with nothing pinned at the end',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });

  const seen = await readState(ctx, job.id);
  assert.equal(seen.completed, true);
  assert.equal(seen.state, 'completed');
  assert.equal(seen.state_since, await lastEventAt(ctx, job.id, 'job.transitioned'));
});

test('t415 AT14 — a conforming finish is completed; the job still being worked is running', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerGraphPinningReviewSkill(ctx);
  await pairRunner(ctx, 'runner-a');

  const finished = await createJob(ctx, {
    title: 'the note that really was reviewed',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${finished.id}/transitions`, { to_node_id: 'revisar' });
  const sessionId = await runSessionOn(ctx, finished.id, 'revisar', CONFORMING_REPORT);
  const finishedAt = (
    ctx.db.prepare('SELECT finished_at FROM session WHERE id = ?').get(sessionId) as {
      finished_at: string;
    }
  ).finished_at;

  const done = await readState(ctx, finished.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.state_since, finishedAt, 'it ended when the pinned skill reported');

  // The second traveller, on the SAME final node of the SAME version: it is
  // being reviewed right now. `running` is a lease plus an open session — the
  // pair RF-30 defines both moving states in terms of — and it is checked
  // BEFORE the final-node rule, which is ambiguity 2.
  const working = await createJob(ctx, {
    title: 'the note still under review',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
  await request(ctx, 'POST', `/v1/jobs/${working.id}/transitions`, { to_node_id: 'revisar' });
  await leaseJob(ctx, 'runner-a', working.id);
  await openSessionOn(ctx, working.id, 'revisar');

  const inFlight = await readState(ctx, working.id);
  assert.equal(inFlight.completed, false, 'the pinned skill has not reported yet');
  assert.equal(
    inFlight.state,
    'running',
    'an open session on the last node is work in progress, never an arrival',
  );
});

test('t415 AT15 — a fresh job on a non-final node is queued, since it was created', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);

  const job = await createJob(ctx, {
    title: 'the note nobody picked up',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const seen = await readState(ctx, job.id);
  assert.equal(seen.state, 'queued');
  assert.equal(seen.state_since, job.created_at, 'it never transitioned: the wait is its whole life');
});

test('t415 AT16 — GET /v1/jobs reports the six states in one request, across two versions', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);
  const ctx = await startControlPlane(t);
  await pairRunner(ctx, 'runner-a');
  await pairRunner(ctx, 'runner-b');

  const pinned = await registerGraphPinningReviewSkill(ctx);
  const unpinned = insertUnpinnedVersion(
    ctx,
    graphIdOf(ctx, pinned),
    'sha256:' + 'b'.repeat(64),
  );

  const born = async (title: string, versionId: string): Promise<number> =>
    (
      await createJob(ctx, { title, entry_node_id: 'redigir', graph_version_id: versionId })
    ).id;

  const asking = await born('asking', pinned);
  await request(ctx, 'POST', '/v1/input-requests', {
    job_id: asking,
    kind: 'question',
    question: 'Does the second paragraph answer the theme?',
    auto_approvable: false,
  });

  const stopped = await born('stopped', pinned);
  await request(ctx, 'POST', `/v1/jobs/${stopped}/blocks`, { reason: 'the theme moved' });

  const working = await born('working', pinned);
  await leaseJob(ctx, 'runner-a', working);
  await openSessionOn(ctx, working, 'redigir');

  const abandoned = await born('abandoned', pinned);
  leaseInThePast(ctx, 'runner-b', abandoned);
  await openSessionOn(ctx, abandoned, 'redigir');

  const done = await born('done', unpinned);
  await request(ctx, 'POST', `/v1/jobs/${done}/transitions`, { to_node_id: 'revisar' });

  const waiting = await born('waiting', unpinned);

  const board = await readBoard(ctx);
  assert.equal(board.size, 6, 'the whole board came back in one request');
  assert.equal(board.get(asking)?.state, 'awaiting_you');
  assert.equal(board.get(stopped)?.state, 'blocked_unasked');
  assert.equal(board.get(working)?.state, 'running');
  assert.equal(board.get(abandoned)?.state, 'unowned');
  assert.equal(board.get(done)?.state, 'completed');
  assert.equal(board.get(waiting)?.state, 'queued');

  for (const [id, job] of board) {
    assert.ok(
      typeof job.state_since === 'string' && job.state_since.length > 0,
      `job ${id} came back with no state_since`,
    );
    assert.equal(
      job.state,
      (await readState(ctx, id)).state,
      `the board and the job page disagree about job ${id}`,
    );
  }
});

test('t415 AT17 — the board costs the same number of statements whatever the job count', async (t) => {
  requireArtifacts(...ARTIFACTS, GRAPH_ROUTES);

  /** Counts every statement the handle prepares while the board is read. */
  const preparesForTheBoard = async (ctx: TestContext): Promise<number> => {
    const handle = ctx.db as unknown as { prepare: (sql: string) => unknown };
    const original = handle.prepare.bind(ctx.db);
    let prepared = 0;
    handle.prepare = (sql: string): unknown => {
      prepared += 1;
      return original(sql);
    };
    try {
      const response = await request<{ jobs: JobWithState[] }>(ctx, 'GET', '/v1/jobs');
      assert.equal(response.status, 200);
    } finally {
      handle.prepare = original;
    }
    return prepared;
  };

  // One job, one version, one state.
  const small = await startControlPlane(t);
  const smallVersion = await registerMinimalGraph(small);
  await createJob(small, {
    title: 'the only one',
    entry_node_id: 'redigir',
    graph_version_id: smallVersion,
  });

  // Five jobs, two versions, five states.
  const large = await startControlPlane(t);
  await pairRunner(large, 'runner-a');
  await pairRunner(large, 'runner-b');
  const pinned = await registerGraphPinningReviewSkill(large);
  const unpinned = insertUnpinnedVersion(
    large,
    graphIdOf(large, pinned),
    'sha256:' + 'c'.repeat(64),
  );

  const jobs: number[] = [];
  for (const [title, versionId] of [
    ['asking', pinned],
    ['stopped', pinned],
    ['working', pinned],
    ['abandoned', pinned],
    ['done', unpinned],
  ] as const) {
    jobs.push(
      (await createJob(large, { title, entry_node_id: 'redigir', graph_version_id: versionId })).id,
    );
  }
  await request(large, 'POST', '/v1/input-requests', {
    job_id: jobs[0],
    kind: 'question',
    question: 'Is the theme still the theme?',
    auto_approvable: false,
  });
  await request(large, 'POST', `/v1/jobs/${jobs[1]}/blocks`, { reason: 'the theme moved' });
  await leaseJob(large, 'runner-a', jobs[2]);
  await openSessionOn(large, jobs[2], 'redigir');
  leaseInThePast(large, 'runner-b', jobs[3]);
  await openSessionOn(large, jobs[3], 'redigir');
  await request(large, 'POST', `/v1/jobs/${jobs[4]}/transitions`, { to_node_id: 'revisar' });

  const board = await readBoard(large);
  assert.equal(
    new Set([...board.values()].map((job) => job.state)).size,
    5,
    'the large board has to span several states, or the guard proves nothing',
  );

  const forOne = await preparesForTheBoard(small);
  const forFive = await preparesForTheBoard(large);

  assert.equal(
    forFive,
    forOne,
    `the board prepared ${forFive} statements for five jobs and ${forOne} for one: ` +
      'the read has to be bounded, or a state per row is a query per row',
  );
});

/* -------------------------------------------------------------------------- */
/* t417 — the write side of the same partition (D25).                         */
/*                                                                            */
/* t410 gave `GET /v1/jobs*` a `404 unknown_project` and left `POST /v1/jobs`  */
/* taking `project_id` as a bare integer, by its own Out of Scope. The pair    */
/* wrote rows nothing could read back: created under a project nobody had      */
/* declared, refused by every read of the same scope. These cases charge for   */
/* the write refusing what the read already refuses, in the same words.        */
/* -------------------------------------------------------------------------- */

test('t417 AT1 — POST /v1/jobs refuses a project nobody declared, and writes nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const before = createdJobs(ctx);

  const refused = await request<ScopeRefusal>(ctx, 'POST', '/v1/jobs', {
    title: 'a job of a project that does not exist',
    entry_node_id: 'redigir',
    project_id: 99,
  });

  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(
    refused.body.error,
    'unknown_project',
    'the same code GET /v1/jobs?project_id=99 already answers (t410): a write that lands where ' +
      'no read can reach is the defect this closes',
  );
  assert.equal(
    refused.body.message,
    'no project answers to this scope',
    'and the same message, byte for byte — one scope refusal, not two dialects of it',
  );
  assert.equal(refused.body.project_id, 99, 'the scope rides as a SIBLING field, never in details');

  assert.equal(createdJobs(ctx), before, 'a refused job records no `job.created`');
  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM job').get() as { total: number };
  assert.equal(rows.total, 0, 'and it is not a row either — not even an id from the sequence');
});

test('t417 AT2 — a declared project, and the default, still create a job unchanged', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const implicit = await createJob(ctx, {
    title: 'no project_id at all, which is project 1',
    entry_node_id: 'redigir',
  });
  const explicit = await createJob(ctx, {
    title: 'a project that really was declared',
    entry_node_id: 'redigir',
    project_id: 2,
  });

  assert.ok(implicit.id > 0 && explicit.id > 0);

  // And both are readable in their own scope, which is the whole point of the
  // refusal above: a created job is a job that can be read back.
  const mine = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs');
  assert.deepEqual(mine.body.jobs.map((job) => job.id), [implicit.id]);
  const theirs = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs?project_id=2');
  assert.deepEqual(theirs.body.jobs.map((job) => job.id), [explicit.id]);
});

/* -------------------------------------------------------------------------- */
/* The conversation projection (t360, FR5 / AT2)                              */
/* -------------------------------------------------------------------------- */

/** One answered turn, as `GET /v1/jobs/:id/conversation` publishes it. */
interface ConversationTurn {
  question: string;
  answer: string;
  answered_by: string | null;
  at: string | null;
}

/**
 * The question still waiting, in the vocabulary the fenced block uses.
 *
 * `default` and not `default_answer`: the projection speaks the grammar the
 * session itself writes (`ESCALATION_PROTOCOL`), and the rename is local to
 * this route — `GET /v1/input-requests` keeps its own spelling.
 */
interface PendingQuestion {
  id: number;
  question: string;
  context: string | null;
  recommendation: string | null;
  options: string[] | null;
  default: string | null;
}

/** The whole projection the chat page reads. */
interface Conversation {
  turns: ConversationTurn[];
  pending: PendingQuestion | null;
  thinking: boolean;
  draft: Record<string, unknown> | null;
  done: boolean;
}

/** The module this family of assertions is about. */
const CONVERSATION_ARTIFACTS = ['src/domain/conversation.ts', T102_ARTIFACTS.jobRoutes];
/**
 * One turn of an interview, in the order the dispatch really writes it.
 *
 * The session closes with its report FIRST and the question is posted after it
 * (`dispatch.ts`: `finishSession` then `postSessionQuestion`), which is what
 * makes the map of a turn readable while its question is still open.
 *
 * `report` is the turn's own report BESIDE `done` — since t464 that is `graph`
 * and, when the turn changed one, `skills`: two independent top-level keys and
 * no `draft` wrapper (`docs/spec/interview.md` §2). A turn is free to omit
 * `skills`, which is exactly what the accumulation below has to survive.
 *
 * @param ctx Control plane running.
 * @param jobId The interview.
 * @param question What this turn asks.
 * @param report What this turn reported beside `done`.
 * @returns Id of the input request that is now pending.
 */
async function interviewTurn(
  ctx: TestContext,
  jobId: number,
  question: string,
  report: Record<string, unknown>,
): Promise<number> {
  const sessionId = await openSessionOn(ctx, jobId, 'redigir');
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${sessionId}/finish`, {
    status: 'completed',
    exit_code: 0,
    output: { done: false, ...report },
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);

  const asked = await request<{ id: number }>(ctx, 'POST', '/v1/input-requests', {
    job_id: jobId,
    session_id: sessionId,
    kind: 'question',
    question,
    context: 'The interview needs one decision before it can go on.',
    options: ['yes', 'no'],
    recommendation: 'yes',
    default_answer: 'yes',
    auto_approvable: false,
  });
  assert.equal(asked.status, 201, `POST /v1/input-requests returned ${asked.status}`);
  return asked.body.id;
}

/** Reads the conversation projection off the API. */
async function conversation(ctx: TestContext, jobId: number): Promise<Conversation> {
  const response = await request<Conversation>(ctx, 'GET', `/v1/jobs/${jobId}/conversation`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('t360 AT2 — the conversation lists the answered turns and the question still open', async (t) => {
  requireArtifacts(...ARTIFACTS, ...CONVERSATION_ARTIFACTS);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);
  const job = await createJob(ctx, {
    title: 'design a map for handling support escalations',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const firstDraft = { graph: { problem_class: null, nodes: [] }, skills: [] };
  const first = await interviewTurn(ctx, job.id, 'What is this class called?', firstDraft);

  // While the question is open the job is blocked and nothing is thinking: what
  // the page shows is the question, not a spinner.
  const asking = await conversation(ctx, job.id);
  assert.deepEqual(asking.turns, [], 'a question nobody answered yet is not a turn');
  assert.equal(asking.thinking, false, 'a job waiting on a person is not working');
  assert.ok(asking.pending !== null, 'the open question is what the page has to render');
  assert.equal(asking.pending.question, 'What is this class called?');
  assert.equal(asking.pending.recommendation, 'yes', 'the one-click value rides with it (RF-16)');
  assert.deepEqual(asking.pending.options, ['yes', 'no']);
  assert.equal(
    asking.pending.default,
    'yes',
    'the wire key is `default`, the word the fenced block itself uses',
  );
  assert.deepEqual(
    asking.draft,
    firstDraft,
    'the map is `graph` and `skills` accumulated over every completed session (t464)',
  );
  assert.equal(asking.done, false);

  await request(ctx, 'PATCH', `/v1/input-requests/${first}/answer`, {
    answer: 'support-escalation',
    answered_by: 'rafael',
  });

  const secondDraft = {
    graph: { problem_class: 'support-escalation', nodes: [{ id: 'triage' }] },
    skills: [],
  };
  const second = await interviewTurn(ctx, job.id, 'What does `triage` need to start?', secondDraft);
  await request(ctx, 'PATCH', `/v1/input-requests/${second}/answer`, {
    answer: 'the ticket and the customer history',
    answered_by: 'rafael',
  });

  const thirdDraft = {
    graph: {
      problem_class: 'support-escalation',
      nodes: [{ id: 'triage', contract: { input_schema: { required: ['ticket'] } } }],
    },
    skills: [{ id: 'triage-ticket', version: '1.0.0' }],
  };
  const third = await interviewTurn(ctx, job.id, 'What usually goes wrong at `triage`?', thirdDraft);

  const after = await conversation(ctx, job.id);
  assert.equal(after.turns.length, 2, 'two questions were answered, and the third is still open');
  assert.deepEqual(
    after.turns.map((turn) => turn.question),
    ['What is this class called?', 'What does `triage` need to start?'],
    'the ORDER comes from the log, which is the only total ordering there is',
  );
  assert.deepEqual(
    after.turns.map((turn) => turn.answer),
    ['support-escalation', 'the ticket and the customer history'],
  );
  for (const turn of after.turns) {
    assert.equal(turn.answered_by, 'rafael');
    assert.equal(typeof turn.at, 'string', 'a turn says when it was closed');
  }

  assert.ok(after.pending !== null, 'the third question is waiting');
  assert.equal(after.pending.question, 'What usually goes wrong at `triage`?');
  assert.deepEqual(
    after.draft,
    thirdDraft,
    'every key the walk ever set, with the LATEST value each one was given (t464)',
  );
  assert.equal(after.done, false, 'an interview that has not delivered is not done');

  // --- t464 AT1. a turn that changed no manifest reports no `skills` --------
  //
  // The whole point of the flattening: `graph` and `skills` are two independent
  // merge keys, so a turn that only moved the graph forward keeps the manifests
  // the turn before it settled, instead of erasing them by omission.
  await request(ctx, 'PATCH', `/v1/input-requests/${third}/answer`, {
    answer: 'it misses the customer history',
    answered_by: 'rafael',
  });

  const fourthGraph = {
    problem_class: 'support-escalation',
    nodes: [
      {
        id: 'triage',
        contract: { input_schema: { required: ['ticket'] }, checks: [{ id: 'the-history' }] },
      },
    ],
  };
  await interviewTurn(ctx, job.id, 'Which step finishes the work?', { graph: fourthGraph });

  const accumulated = await conversation(ctx, job.id);
  assert.deepEqual(
    accumulated.draft,
    { graph: fourthGraph, skills: thirdDraft.skills },
    'a turn that omitted `skills` kept the manifests an earlier turn settled (t464 FR9)',
  );
});

test('t464 AT2/AT3 — the map accumulates per key, and a report with neither key is inert', async (t) => {
  requireArtifacts(...ARTIFACTS, ...CONVERSATION_ARTIFACTS);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);
  const job = await createJob(ctx, {
    title: 'design a map for handling widget returns',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  // AT2. Nothing completed is no map — never an empty one, and never a `{}`
  // conjured out of an accumulator that started as an object.
  const untouched = await conversation(ctx, job.id);
  assert.equal(untouched.draft, null, 'no completed session is no map at all');

  const graph = { problem_class: 'widget-return', nodes: [{ id: 'inspect' }] };
  const skills = [{ id: 'inspect-widget', version: '1.0.0' }];
  const asked = await interviewTurn(ctx, job.id, 'What does `inspect` need?', { graph, skills });
  await request(ctx, 'PATCH', `/v1/input-requests/${asked}/answer`, {
    answer: 'the widget and the order',
    answered_by: 'rafael',
  });

  const settled = await conversation(ctx, job.id);
  assert.deepEqual(settled.draft, { graph, skills }, 'one turn set both keys');

  // AT3. The delivering node's own report shares the job and shares nothing
  // else: it names neither key, so it moves neither.
  const delivering = await openSessionOn(ctx, job.id, 'revisar');
  const finished = await request(ctx, 'PATCH', `/v1/sessions/${delivering}/finish`, {
    status: 'completed',
    exit_code: 0,
    output: {
      bundle: { graph, skills },
      checked: { structure: true, soundness: true, problems: [] },
      note: 'the map covers inspection and the return itself',
    },
  });
  assert.equal(finished.status, 200, `PATCH /finish returned ${finished.status}`);

  const afterDelivery = await conversation(ctx, job.id);
  assert.deepEqual(
    afterDelivery.draft,
    { graph, skills },
    'a completed session naming neither key changes neither (t464 FR9)',
  );
});

test('t492 AT6 — a turn reporting the RETIRED nested `draft` accumulates the same map', async (t) => {
  requireArtifacts(...ARTIFACTS, ...CONVERSATION_ARTIFACTS);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);
  const job = await createJob(ctx, {
    title: 'design a map for handling widget returns, before t464 landed',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  // Exactly what job 5 — the only interview this project has ever run — has
  // sitting in its `session.output` rows: the map one level under `draft`,
  // because the skill its frozen graph_version pins declared it that way.
  const graph = { problem_class: 'widget-return', nodes: [{ id: 'inspect' }] };
  const skills = [{ id: 'inspect-widget', version: '1.0.0' }];
  const asked = await interviewTurn(ctx, job.id, 'What does `inspect` need?', {
    draft: { graph, skills },
  });
  await request(ctx, 'PATCH', `/v1/input-requests/${asked}/answer`, {
    answer: 'the widget and the order',
    answered_by: 'rafael',
  });

  const settled = await conversation(ctx, job.id);
  assert.deepEqual(
    settled.draft,
    { graph, skills },
    'the nested shape accumulates the map the flat shape accumulates (t492 FR1/FR5)',
  );

  // And it accumulates PER KEY across the two turns, the same way the flat
  // shape does: this one moves only the graph forward.
  const secondGraph = {
    problem_class: 'widget-return',
    nodes: [{ id: 'inspect' }, { id: 'decide' }],
  };
  await interviewTurn(ctx, job.id, 'Which step closes the return?', {
    draft: { graph: secondGraph },
  });

  const accumulated = await conversation(ctx, job.id);
  assert.deepEqual(
    accumulated.draft,
    { graph: secondGraph, skills },
    'a nested turn that omitted `skills` kept the manifests the turn before settled',
  );
});

test('t360 AT2 — while a session is running the projection reports thinking, with nothing pending', async (t) => {
  requireArtifacts(...ARTIFACTS, ...CONVERSATION_ARTIFACTS);
  const ctx = await startControlPlane(t);
  const versionId = await registerMinimalGraph(ctx);
  const job = await createJob(ctx, {
    title: 'design a map for onboarding a new client',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const quiet = await conversation(ctx, job.id);
  assert.equal(quiet.thinking, false, 'a job nobody has dispatched yet is not thinking');
  assert.equal(quiet.pending, null);
  assert.equal(quiet.draft, null, 'no completed session is no draft, never an empty one');

  await openSessionOn(ctx, job.id, 'redigir');

  const running = await conversation(ctx, job.id);
  assert.equal(running.thinking, true, 'a session is open, and the page says so');
  assert.equal(running.pending, null, 'and there is nothing for a person to answer while it runs');
  assert.deepEqual(running.turns, []);
  assert.equal(running.done, false);
});

test('t360 AT2 — the conversation is scoped by project, and an unknown job is the same 404', async (t) => {
  requireArtifacts(...ARTIFACTS, ...CONVERSATION_ARTIFACTS);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const versionId = await registerMinimalGraph(ctx);
  const job = await createJob(ctx, {
    title: 'an interview of project one',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });

  const missing = await request<ScopeRefusal>(ctx, 'GET', '/v1/jobs/999360/conversation');
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.error, 'not_found');

  const elsewhere = await request<ScopeRefusal>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/conversation?project_id=2`,
  );
  assert.equal(
    elsewhere.status,
    404,
    'a job of another project answers the same 404 an unknown id gets (t410)',
  );
});

/* -------------------------------------------------------------------------- */
/* t368 — every artifact of every session of a job, newest first (RF-39).      */
/* -------------------------------------------------------------------------- */

/** A raw-body upload: the one route in the app that is not JSON (t422). */
async function uploadArtifact(
  ctx: TestContext,
  sessionId: number,
  name: string,
  content: Buffer,
): Promise<{ id: number }> {
  const response = await fetch(`${ctx.url}/v1/sessions/${sessionId}/artifacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token}`,
      'content-type': 'text/plain',
      'x-artifact-name': name,
    },
    body: new Uint8Array(content),
  });
  const body = (await response.json()) as { id: number };
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

test('t368 AT1 — GET /v1/jobs/:id/artifacts lists every artifact of every session, newest first', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createJob(ctx, {
    title: 'a traversal that leaves evidence behind',
    entry_node_id: 'redigir',
  });
  const first = await openSessionOn(ctx, job.id, 'redigir');
  const second = await openSessionOn(ctx, job.id, 'revisar');

  const a = await uploadArtifact(ctx, first, 'draft.md', Buffer.from('the first cut'));
  const b = await uploadArtifact(ctx, second, 'review.md', Buffer.from('the review notes'));
  const c = await uploadArtifact(ctx, second, 'screenshot.png', Buffer.from('binary-ish content'));

  const response = await request<{ artifacts: Array<Record<string, unknown>> }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/artifacts`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const ids = response.body.artifacts.map((artifact) => artifact.id);
  assert.deepEqual(ids, [c.id, b.id, a.id], 'newest first');

  const byId = new Map(response.body.artifacts.map((artifact) => [artifact.id, artifact]));
  assert.equal(byId.get(a.id)?.session_id, first);
  assert.equal(byId.get(a.id)?.node_id, 'redigir');
  assert.equal(byId.get(b.id)?.session_id, second);
  assert.equal(byId.get(b.id)?.node_id, 'revisar');
  assert.equal(byId.get(c.id)?.session_id, second);
  assert.equal(byId.get(c.id)?.node_id, 'revisar');
});

test('t368 AT1 — a job with no artifacts answers an empty list, not a 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const job = await createJob(ctx, {
    title: 'nothing produced yet',
    entry_node_id: 'redigir',
  });

  const response = await request<{ artifacts: unknown[] }>(
    ctx,
    'GET',
    `/v1/jobs/${job.id}/artifacts`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.artifacts, []);
});

test('t368 AT1 — a job of another project, and an unknown job id, both answer 404', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const theirs = await createJob(ctx, {
    title: 'born in project two',
    entry_node_id: 'redigir',
    project_id: 2,
  });

  const crossed = await request<ScopeRefusal>(ctx, 'GET', `/v1/jobs/${theirs.id}/artifacts`);
  assert.equal(crossed.status, 404, JSON.stringify(crossed.body));
  assert.equal(crossed.body.error, 'not_found');

  const scoped = await request<{ artifacts: unknown[] }>(
    ctx,
    'GET',
    `/v1/jobs/${theirs.id}/artifacts?project_id=2`,
  );
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));

  const missing = await request<ScopeRefusal>(ctx, 'GET', '/v1/jobs/987654/artifacts');
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.error, 'not_found');
});
