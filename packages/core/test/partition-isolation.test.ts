/**
 * Cross-entity isolation of D25's project partition (t414, FR8/FR9).
 *
 * `test/partition-guard.test.ts` is the STRUCTURAL half of this ticket: it
 * sweeps `packages/core/src` as text and proves every statement against a
 * partitioned table carries a project predicate or an argued reason. What it
 * cannot see is a scoped repository nobody hands the scope to — a route that
 * accepts `?project_id=` and never passes it on reads exactly as clean.
 *
 * This file is the other half, and it is behavioural: two projects, one
 * database, one row of each noun per project, and the API asked whether project
 * A can see project B. Seven nouns, one test each — jobs, events, sessions,
 * questions, proposals, subscriptions and deliveries — because a partition that
 * holds for six of them holds for nothing.
 *
 * ## Two fixtures go in under the API, and only two
 *
 * Everything here is written through `/v1` except where the API has no door yet:
 *
 * - a **proposal in a second project** cannot be posted, because
 *   `routes/proposals.ts` resolves its graph, its version and its own row in the
 *   default project whatever scope the caller declares — that is ticket-412's
 *   declared surface. So the row goes in through `repositories/proposals.ts`,
 *   the same module the route writes through (D1 is intact: the server is still
 *   the writer);
 * - a **delivery** has no listing route at all, so its case runs against a bare
 *   app carrying the webhook routes and the dispatcher with an injected
 *   transport — `test/webhooks-dispatch.test.ts`'s harness, for its reasons:
 *   the whole control plane wires a dispatcher of its own, with the production
 *   interval and the real `fetch`, and two dispatchers over one database would
 *   race for the same rows and reach for the network.
 *
 * ## One case was a `todo`, until its ticket landed
 *
 * `GET /v1/proposals` had no project filter when this file was written:
 * `ProposalFilter` carried `status` and `veredito` and nothing else. That was
 * ticket-412's to fix ("proposal, lease and webhook reads filter by project"),
 * it was written and unmerged at the time, and t414's Definition of Done said
 * the case is left failing rather than skipped or weakened — so the assertion
 * was the real one all along, carried as a `todo` that RAN it and REPORTED the
 * failure without turning the suite red for a gap this ticket is out of scope
 * for. ticket-412 has since merged into this branch and the marker is gone: the
 * case below is an ordinary green assertion, and it is green because the leak
 * is closed and not because anything about it was relaxed.
 *
 * What made that merge notice was not this comment: `partition-guard.test.ts`'s
 * allowlist carried six entries marked "delete on merge", and its dead-entry
 * rule went red the moment the merge made them unnecessary.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext as NodeTestContext } from 'node:test';

import Fastify from 'fastify';

import { applyPragmas, openDatabase } from '../src/db/connection.ts';
import { recordEvent } from '../src/db/events.ts';
import { migrate } from '../src/db/migrate.ts';
import { createProposal } from '../src/repositories/proposals.ts';
import { registerProjects } from '../src/routes/projects.ts';
import { registerWebhooks } from '../src/routes/webhooks.ts';
import { registerWebhookDispatcher } from '../src/webhooks/dispatcher.ts';
import {
  MIGRATIONS_DIR,
  PACKAGE_ROOT,
  createJob,
  resolvePinsOver,
  request,
  requireArtifacts,
  startControlPlane,
  type Event,
  type InputRequest,
  type Job,
  type Session,
  type TestContext,
  type TestHook,
} from './support.ts';

/** Artifacts every case here exercises. */
const T414_ARTIFACTS = Object.freeze({
  projectRoutes: 'src/routes/projects.ts',
  eventRoutes: 'src/routes/events.ts',
  executionRoutes: 'src/routes/executions.ts',
  events: 'src/db/events.ts',
});

/** Two declared partitions over one database. */
interface TwoProjects {
  /** The project every assertion reads FROM. */
  alpha: number;
  /** The project nothing read from alpha may ever contain. */
  beta: number;
}

/** Declares a project and returns the id it was minted with (t354, FR1). */
async function declareProject(ctx: TestContext, name: string): Promise<number> {
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/projects', { name });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.id;
}

/**
 * The control plane, with two projects declared on it.
 *
 * Neither of them is project `1`: the default partition is where everything
 * that predates D25 already lives, and a case that used it would be asserting
 * over a partition it does not fully own.
 */
async function twoProjects(t: TestHook): Promise<{ ctx: TestContext; projects: TwoProjects }> {
  requireArtifacts(...Object.values(T414_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const alpha = await declareProject(ctx, 'alpha');
  const beta = await declareProject(ctx, 'beta');
  assert.notEqual(alpha, beta);
  return { ctx, projects: { alpha, beta } };
}

/** Opens a session on a job, through the route the runner uses. */
async function openSessionOn(ctx: TestContext, jobId: number): Promise<Session> {
  const response = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: jobId,
    node_id: 'refinamento',
    engine: 'claude-code',
    working_dir: '/srv/cartografo',
    prompt: `work job ${jobId} and report what happened`,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/** Raises a question on a job, through the route an agent session uses. */
async function askOn(ctx: TestContext, jobId: number): Promise<InputRequest> {
  const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: jobId,
    kind: 'question',
    question: `which way for job ${jobId}?`,
    context: 'the isolation fixture asks the same thing in both projects',
    options: ['left', 'right'],
    recommendation: 'left',
    default_answer: 'left',
    auto_approvable: false,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/**
 * The minimal example graph: entry node `redigir`, single final node `revisar`.
 *
 * The real document, and not a snapshot written here, for the reason
 * `test/jobs.test.ts` gives: what the registration gate checks is a document
 * that went through it, and a hand-made one proves nothing about it.
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
 * Registers the minimal graph INSIDE one project, pins and all.
 *
 * The same helper `test/jobs.test.ts` carries, for the same reason: the registry
 * is per project since t354, so a version born in project beta needs ITS
 * manifests registered in beta, not in the default one.
 *
 * @param ctx Control plane running.
 * @param projectId Project the lineage and its manifests are written in.
 * @returns The lineage id and the id of the version born with it.
 */
async function registerMinimalGraphIn(
  ctx: TestContext,
  projectId: number,
): Promise<{ graphId: string; versionId: string }> {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>;
  // The document is content-addressed, so two projects registering the SAME
  // bytes land on the same version hash. The class is renamed per project to
  // keep the two lineages apart, which is what these proposals are about.
  document.class = `isolation-${projectId}`;
  await resolvePinsOver(document, {
    // The path already carries a `?version=`, so the scope joins it with `&`.
    get: (routePath) => request(ctx, 'GET', `${routePath}&project_id=${projectId}`),
    post: (routePath, body) =>
      request(ctx, 'POST', routePath, {
        ...(body as Record<string, unknown>),
        project_id: projectId,
      }),
  });

  const response = await request<{ graph: { id: string }; graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    { ...document, project_id: projectId },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { graphId: response.body.graph.id, versionId: response.body.graph_version.id };
}

/** A subscription, as `GET /v1/webhooks` returns it. */
interface Subscription {
  id: number;
  project_id: number;
  url: string;
  filter_types: string[] | null;
  deactivated_at: string | null;
}

/** A proposal, in the slice these cases assert on. */
interface Proposal {
  id: number;
  project_id: number;
}

/* -------------------------------------------------------------------------- */
/* 1. Jobs                                                                    */
/* -------------------------------------------------------------------------- */

test('t414 — a job listing never carries another project’s job', async (t) => {
  const { ctx, projects } = await twoProjects(t);

  const mine = await createJob(ctx, {
    title: 'alpha job',
    entry_node_id: 'entrada',
    project_id: projects.alpha,
  });
  const theirs = await createJob(ctx, {
    title: 'beta job',
    entry_node_id: 'entrada',
    project_id: projects.beta,
  });

  // Re-asserted here, even though t410 already tests it in `test/jobs.test.ts`:
  // this file is the whole isolation story in one place, and a story with a
  // hole in the first line is not evidence of anything.
  const alpha = await request<{ jobs: Job[] }>(ctx, 'GET', `/v1/jobs?project_id=${projects.alpha}`);
  const beta = await request<{ jobs: Job[] }>(ctx, 'GET', `/v1/jobs?project_id=${projects.beta}`);

  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 200);
  assert.deepEqual(
    alpha.body.jobs.map((job) => job.id),
    [mine.id],
  );
  assert.deepEqual(
    beta.body.jobs.map((job) => job.id),
    [theirs.id],
  );
});

/* -------------------------------------------------------------------------- */
/* 2. Events                                                                  */
/* -------------------------------------------------------------------------- */

test('t414 — two projects numbering the same round read two different logs', async (t) => {
  const { ctx, projects } = await twoProjects(t);

  // The SAME number, on purpose. `execution_id` is an opaque grouper an operator
  // chooses (`routes/executions.ts`), so two projects numbering their rounds
  // independently land on the same one as a matter of course — which is exactly
  // where an unscoped log read stops being theoretical.
  const round = 77;
  const mine = await createJob(ctx, {
    title: 'alpha, round 77',
    entry_node_id: 'entrada',
    execution_id: round,
    project_id: projects.alpha,
  });
  const theirs = await createJob(ctx, {
    title: 'beta, round 77',
    entry_node_id: 'entrada',
    execution_id: round,
    project_id: projects.beta,
  });

  const alpha = await request<{ events: Event[] }>(
    ctx,
    'GET',
    `/v1/executions/${round}/events?project_id=${projects.alpha}`,
  );
  const beta = await request<{ events: Event[] }>(
    ctx,
    'GET',
    `/v1/executions/${round}/events?project_id=${projects.beta}`,
  );

  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 200);
  assert.deepEqual(
    alpha.body.events.map((event) => event.entity.id),
    [mine.id],
  );
  assert.deepEqual(
    beta.body.events.map((event) => event.entity.id),
    [theirs.id],
  );
  assert.deepEqual(
    [...new Set(alpha.body.events.map((event) => event.project_id))],
    [projects.alpha],
  );
});

/* -------------------------------------------------------------------------- */
/* 3. Sessions                                                                */
/* -------------------------------------------------------------------------- */

test('t414 — a session listing never carries another project’s session', async (t) => {
  const { ctx, projects } = await twoProjects(t);

  const mineJob = await createJob(ctx, {
    title: 'alpha job',
    entry_node_id: 'entrada',
    project_id: projects.alpha,
  });
  const theirJob = await createJob(ctx, {
    title: 'beta job',
    entry_node_id: 'entrada',
    project_id: projects.beta,
  });
  const mine = await openSessionOn(ctx, mineJob.id);
  await openSessionOn(ctx, theirJob.id);

  const listed = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?project_id=${projects.alpha}`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.sessions.map((session) => session.id),
    [mine.id],
  );

  // The sharper half: `session` carries no `project_id` of its own and inherits
  // the partition through its job (D25's rule), so asking about the OTHER
  // project's job from inside this one has to come back empty rather than
  // reaching across the boundary through the filter.
  const reached = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?job_id=${theirJob.id}&project_id=${projects.alpha}`,
  );
  assert.equal(reached.status, 200);
  assert.deepEqual(reached.body.sessions, []);
});

/* -------------------------------------------------------------------------- */
/* 4. Questions                                                               */
/* -------------------------------------------------------------------------- */

test('t414 — an input-request listing never carries another project’s question', async (t) => {
  const { ctx, projects } = await twoProjects(t);

  const mineJob = await createJob(ctx, {
    title: 'alpha job',
    entry_node_id: 'entrada',
    project_id: projects.alpha,
  });
  const theirJob = await createJob(ctx, {
    title: 'beta job',
    entry_node_id: 'entrada',
    project_id: projects.beta,
  });
  const mine = await askOn(ctx, mineJob.id);
  await askOn(ctx, theirJob.id);

  const listed = await request<{ input_requests: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?project_id=${projects.alpha}`,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.input_requests.map((question) => question.id),
    [mine.id],
  );

  const reached = await request<{ input_requests: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?job_id=${theirJob.id}&project_id=${projects.alpha}`,
  );
  assert.equal(reached.status, 200);
  assert.deepEqual(reached.body.input_requests, []);
});

/* -------------------------------------------------------------------------- */
/* 5. Proposals — green since ticket-412 merged (see the header)              */
/* -------------------------------------------------------------------------- */

test('t414 — a proposal listing never carries another project’s proposal', async (t) => {
  const { ctx, projects } = await twoProjects(t);

  // The subject of each proposal is a REAL lineage registered in its own
  // project: `proposal.graph_id` has a foreign key, so a made-up id would fail
  // on the constraint and prove nothing about scoping.
  const mineSubject = await registerMinimalGraphIn(ctx, projects.alpha);
  const theirSubject = await registerMinimalGraphIn(ctx, projects.beta);

  // Straight through the repository the route writes through, and still so
  // after ticket-412 opened the API door (`POST /v1/proposals` now resolves its
  // graph, its version and its own row inside the declared scope): what this
  // case asserts is the LISTING, and going in through the route would make the
  // fixture carry a full valid `operations` payload that the assertion below
  // never looks at. D1 is intact either way — the server is still the writer.
  const mine = createProposal(ctx.db, {
    project_id: projects.alpha,
    graph_id: mineSubject.graphId,
    target_version: mineSubject.versionId,
    operations: [],
    evidence: { lens: 'flow' },
    expected_metric: { nome: 'ciclo', direcao: 'menor', de: 2, para: 1 },
  });
  createProposal(ctx.db, {
    project_id: projects.beta,
    graph_id: theirSubject.graphId,
    target_version: theirSubject.versionId,
    operations: [],
    evidence: { lens: 'flow' },
    expected_metric: { nome: 'ciclo', direcao: 'menor', de: 2, para: 1 },
  });

  const listed = await request<{ proposals: Proposal[] }>(
    ctx,
    'GET',
    `/v1/proposals?project_id=${projects.alpha}`,
  );

  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.proposals.map((proposal) => proposal.id),
    [mine.id],
    'a proposal of another project must not appear in this project’s inbox',
  );
});

/* -------------------------------------------------------------------------- */
/* 6. Subscriptions                                                           */
/* -------------------------------------------------------------------------- */

test('t414 — a webhook listing never carries another project’s subscription', async (t) => {
  const { ctx, projects } = await twoProjects(t);

  // Unroutable on purpose: the control plane runs its own dispatcher on the
  // production clock, and a URL that resolves would turn this case into an
  // outbound request. Nothing here waits for a delivery — that is case 7.
  const subscribe = async (projectId: number, url: string): Promise<Subscription> => {
    const response = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
      project_id: projectId,
      url,
      secret: 'the-consumer-supplies-its-own-secret',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };

  const mine = await subscribe(projects.alpha, 'http://127.0.0.1:1/alpha');
  const theirs = await subscribe(projects.beta, 'http://127.0.0.1:1/beta');

  const alpha = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    `/v1/webhooks?project_id=${projects.alpha}`,
  );
  assert.equal(alpha.status, 200);
  assert.deepEqual(
    alpha.body.webhooks.map((subscription) => subscription.id),
    [mine.id],
  );

  const beta = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    `/v1/webhooks?project_id=${projects.beta}`,
  );
  assert.equal(beta.status, 200);
  assert.deepEqual(
    beta.body.webhooks.map((subscription) => subscription.id),
    [theirs.id],
  );
});

/* -------------------------------------------------------------------------- */
/* 7. Deliveries                                                              */
/* -------------------------------------------------------------------------- */

/** One attempt the injected transport recorded. */
interface DeliveryCall {
  url: string;
  body: string;
}

test('t414 — the delivery sweep hands each subscriber only its own project’s events', async (t: NodeTestContext) => {
  requireArtifacts(
    'src/repositories/webhooks.ts',
    'src/webhooks/dispatcher.ts',
    'src/routes/webhooks.ts',
  );

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t414-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const calls: DeliveryCall[] = [];

  // Before `listen()`, which is where the dispatcher's `onReady` arms its one
  // `setInterval`: from here on nothing ticks by itself and the test fires
  // every tick by hand.
  t.mock.timers.enable({ apis: ['setInterval'] });

  const app = Fastify({ logger: false });
  app.register(
    async (scope) => {
      registerProjects(scope, db);
      registerWebhooks(scope, db);
    },
    { prefix: '/v1' },
  );
  registerWebhookDispatcher(app, db, {
    tickIntervalMs: 10,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      return { status: 200 };
    },
  });

  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  const declare = async (name: string): Promise<number> => {
    const response = await fetch(`${url}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: number }).id;
  };
  const subscribe = async (projectId: number, target: string): Promise<number> => {
    const response = await fetch(`${url}/v1/webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, url: target, secret: 'shared-secret' }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as { id: number }).id;
  };

  const alpha = await declare('alpha');
  const beta = await declare('beta');
  await subscribe(alpha, 'https://alpha.example/hook');
  await subscribe(beta, 'https://beta.example/hook');

  const record = (projectId: number, jobId: number, title: string): Event =>
    recordEvent(db, {
      type: 'job.created',
      project_id: projectId,
      execution_id: null,
      entity: { type: 'job', id: jobId },
      actor: { type: 'system', ref: 'control-plane' },
      occurred_at: new Date().toISOString(),
      data: { title, entry_node_id: 'entrada' },
    }) as Event;

  const mine = record(alpha, 1, 'a fact of alpha');
  const theirs = record(beta, 2, 'a fact of beta');

  // Two ticks: the first fans the log out into delivery rows, the second
  // attempts them. The sweep the second one runs — `dueDeliveries` — carries no
  // project filter at all, and `partition-guard.test.ts` argues that is right
  // (`GLOBAL_BY_DESIGN`: each row copied its own url and secret at enqueue
  // time). This case is what makes that argument checkable rather than asserted.
  t.mock.timers.tick(10);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10);
  await new Promise((resolve) => setImmediate(resolve));

  const delivered = new Map<string, number[]>();
  for (const call of calls) {
    const event = JSON.parse(call.body) as Event;
    delivered.set(call.url, [...(delivered.get(call.url) ?? []), event.id]);
  }

  assert.deepEqual(delivered.get('https://alpha.example/hook'), [mine.id]);
  assert.deepEqual(delivered.get('https://beta.example/hook'), [theirs.id]);
});
