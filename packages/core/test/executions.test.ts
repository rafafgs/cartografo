/**
 * Acceptance test of the version × telemetry query (t102, AT15).
 *
 * It is the join the topographer will need after the PoC: D15 makes the graph
 * version the row you cross with telemetry to say whether a mutation improved
 * anything. Without this query, "v2 is better than v1" would be an opinion.
 *
 * `grafo_versao_id` is loose `TEXT` on purpose (the `grafo_versao` table belongs
 * to t101): here it is job input data, not an FK.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  T102_ARTIFACTS,
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type Event,
  type InputRequest,
  type Job,
  type MetricByVersion,
  type Session,
  type TestContext,
  type TestHook,
} from './support.ts';

/**
 * One row of `GET /v1/executions` (t107, FR1), with the end of the round on it
 * (t245, FR6).
 *
 * Hand-written, like the other shapes in this support: it IS the contract the
 * test charges for, and importing it from `src/` would charge nothing.
 */
interface ExecutionSummary {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
  /**
   * When the control plane declared this round over, `null` while it has not
   * (t245).
   *
   * Derived from the `execution.finished` event at read time, never stored —
   * same posture as the job's `completed`.
   */
  finished_at: string | null;
}

test('AT15 — GET /v1/executions/:id/metrics-by-version groups jobs and events by version', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.events,
    T102_ARTIFACTS.jobRepository,
    T102_ARTIFACTS.jobRoutes,
    T102_ARTIFACTS.executionRoutes,
  );
  const ctx = await startControlPlane(t);

  // Execution 7: two jobs on v1, one on v2.
  const v1a = await createJob(ctx, {
    title: 'v1 a',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v1',
  });
  const v1b = await createJob(ctx, {
    title: 'v1 b',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v1',
  });
  const v2 = await createJob(ctx, {
    title: 'v2',
    entry_node_id: 'entrada',
    execution_id: 7,
    graph_version_id: 'v2',
  });

  // Execution 8, same version: must not leak into the report of 7.
  await createJob(ctx, {
    title: 'de outra execução',
    entry_node_id: 'entrada',
    execution_id: 8,
    graph_version_id: 'v1',
  });

  // v1: 2 created + 2 transitions + 1 session = 5 events.
  await request(ctx, 'POST', `/v1/jobs/${v1a.id}/transitions`, { to_node_id: 'implementacao' });
  await request(ctx, 'POST', `/v1/jobs/${v1b.id}/transitions`, { to_node_id: 'implementacao' });
  await request(ctx, 'POST', '/v1/sessions', {
    job_id: v1a.id,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe',
  });

  // v2: 1 created + 1 block = 2 events.
  await request(ctx, 'POST', `/v1/jobs/${v2.id}/blocks`, { reason: 'travou' });

  const response = await request<{ execution_id: number; metrics: MetricByVersion[] }>(
    ctx,
    'GET',
    '/v1/executions/7/metrics-by-version',
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.execution_id, 7);
  assert.deepEqual(response.body.metrics, [
    { graph_version_id: 'v1', jobs: 2, events: 5 },
    { graph_version_id: 'v2', jobs: 1, events: 2 },
  ]);
});

test('AT15 — an execution with no job at all returns an empty list, not 404', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<{ execution_id: number; metrics: MetricByVersion[] }>(
    ctx,
    'GET',
    '/v1/executions/99/metrics-by-version',
  );

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.deepEqual(response.body.metrics, []);
});

test('t107 AT1 — GET /v1/executions groups by execution, counts blocked and pending, null last', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.jobRepository,
    T102_ARTIFACTS.inputRequestRepository,
    T102_ARTIFACTS.executionRoutes,
    T102_ARTIFACTS.inputRequestRoutes,
  );
  const ctx = await startControlPlane(t);

  // Eight is created BEFORE seven on purpose: the response is ordered by
  // `execucao_id`, not by the order the jobs came in.
  await createJob(ctx, { title: 'só da oito', entry_node_id: 'entrada', execution_id: 8 });

  const blocked = await createJob(ctx, {
    title: 'travado',
    entry_node_id: 'entrada',
    execution_id: 7,
  });
  const moving = await createJob(ctx, {
    title: 'andando',
    entry_node_id: 'entrada',
    execution_id: 7,
  });

  // A job with no execution: falls into the `null` group instead of vanishing.
  await createJob(ctx, { title: 'sem rodada', entry_node_id: 'entrada' });

  await request(ctx, 'POST', `/v1/jobs/${blocked.id}/blocks`, { reason: 'esperando gente' });

  const ask = async (jobId: number): Promise<InputRequest> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      job_id: jobId,
      kind: 'question',
      question: 'e agora?',
      auto_approvable: false,
    });
    assert.equal(response.status, 201);
    return response.body;
  };

  const pending = await ask(blocked.id);
  const answered = await ask(moving.id);
  await request(ctx, 'PATCH', `/v1/input-requests/${answered.id}/answer`, {
    answer: 'siga',
    answered_by: 'rafael',
  });
  assert.ok(pending.id !== answered.id);

  const response = await request<{ executions: ExecutionSummary[] }>(ctx, 'GET', '/v1/executions');

  assert.equal(response.status, 200);
  // `finished_at` rides on every row since t245: none of these rounds is over —
  // no job of them is standing on a final node — so all three read `null`.
  assert.deepEqual(response.body.executions, [
    { execution_id: 7, jobs: 2, blocked_jobs: 1, pending_input_requests: 1, finished_at: null },
    { execution_id: 8, jobs: 1, blocked_jobs: 0, pending_input_requests: 0, finished_at: null },
    { execution_id: null, jobs: 1, blocked_jobs: 0, pending_input_requests: 0, finished_at: null },
  ]);
});

test('t107 AT1 — with no job at all, GET /v1/executions returns an empty list', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<{ executions: ExecutionSummary[] }>(ctx, 'GET', '/v1/executions');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.executions, []);
});

/** One row of `input_requests_by_node`, beside `metrics` on the same route (t167). */
interface QuestionsByNode {
  node_id: string | null;
  input_requests: number;
}

test('t167 — the execution report counts the questions each node raised', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.inputRequestRepository,
    T102_ARTIFACTS.inputRequestRoutes,
    T102_ARTIFACTS.executionRoutes,
  );
  const ctx = await startControlPlane(t);

  const ask = async (jobId: number, question: string): Promise<void> => {
    const response = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
      job_id: jobId,
      kind: 'question',
      question: question,
      auto_approvable: false,
    });
    assert.equal(response.status, 201);
  };

  // Two jobs of the same round: one asks twice from `revisar`, the other once
  // from `redigir`. A third node exists in nobody's question at all.
  const twice = await createJob(ctx, {
    title: 'trava duas vezes na revisão',
    entry_node_id: 'revisar',
    execution_id: 1670,
  });
  await ask(twice.id, 'sigo com a nota curta?');
  await request(ctx, 'POST', `/v1/jobs/${twice.id}/unblocks`, {});
  await ask(twice.id, 'e o título, mantenho?');

  const once = await createJob(ctx, {
    title: 'trava uma vez na redação',
    entry_node_id: 'redigir',
    execution_id: 1670,
  });
  await ask(once.id, 'qual fonte vale?');

  // Another round, same nodes: nothing of it may leak into this report.
  const elsewhere = await createJob(ctx, {
    title: 'de outra rodada',
    entry_node_id: 'revisar',
    execution_id: 1671,
  });
  await ask(elsewhere.id, 'pergunta de outra rodada');

  const response = await request<{
    execution_id: number;
    metrics: MetricByVersion[];
    input_requests_by_node: QuestionsByNode[];
  }>(ctx, 'GET', '/v1/executions/1670/metrics-by-version');

  assert.equal(response.status, 200);
  assert.deepEqual(
    response.body.input_requests_by_node,
    [
      { node_id: 'redigir', input_requests: 1 },
      { node_id: 'revisar', input_requests: 2 },
    ],
    'one row per node that asked something; a node with zero questions is simply absent',
  );
  assert.ok(
    Array.isArray(response.body.metrics),
    'it rides beside the metrics that were already there, not instead of them',
  );

  const empty = await request<{ input_requests_by_node: QuestionsByNode[] }>(
    ctx,
    'GET',
    '/v1/executions/99/metrics-by-version',
  );
  assert.deepEqual(empty.body.input_requests_by_node, [], 'a round nobody asked anything in is empty');
});

test('t127 — the old Portuguese execution path no longer exists', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request(ctx, 'GET', '/v1/execucoes/7/metricas-por-versao');
  assert.equal(response.status, 404, 'GET /v1/execucoes/:id/metricas-por-versao should be gone (D18)');
});

/* -------------------------------------------------------------------------- */
/* t110 — the execution-wide event stream the flow surveyor reads              */
/*                                                                            */
/* The route segments are English (D18); the payload keys stay in Portuguese,  */
/* because they mirror the untouched migration columns (t127, FR8).            */
/* -------------------------------------------------------------------------- */

/** What `GET /v1/executions/:id/events` gives back (FR1). */
interface ExecutionLog {
  execution_id: number;
  events: Event[];
}

/**
 * Seeds one execution with all three event-bearing entities.
 *
 * The surveyor's numbers cross `trabalho`, `sessao` and `pergunta` — time in
 * node, time blocked, questions per node — so a log that only proves one of
 * them proves nothing about the query this ticket needs.
 */
async function seedExecution(ctx: TestContext, executionId: number): Promise<Job> {
  const job = await createJob(ctx, {
    title: `travessia da execução ${executionId}`,
    entry_node_id: 'redigir',
    execution_id: executionId,
    graph_version_id: 'sha256:t110',
  });

  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });

  const session = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'revise',
  });
  await request(ctx, 'PATCH', `/v1/sessions/${session.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
  });

  // Asking also blocks the work, in the same transaction (t106) — two more
  // events, both carrying the owner's `execucao_id`.
  await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    session_id: session.body.id,
    kind: 'question',
    question: 'sigo com a nota curta?',
    auto_approvable: true,
  });

  return job;
}

test('t110 — GET /v1/executions/:id/events returns the execution log in ascending id order', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.events,
    T102_ARTIFACTS.executionRoutes,
    T102_ARTIFACTS.sessionRoutes,
    T102_ARTIFACTS.inputRequestRoutes,
  );
  const ctx = await startControlPlane(t);

  await seedExecution(ctx, 11);
  // A second execution, seeded the same way: nothing of it may leak into 11.
  const other = await seedExecution(ctx, 12);

  const response = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/11/events');

  assert.equal(response.status, 200);
  assert.equal(response.body.execution_id, 11);

  const events = response.body.events;
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'job.created',
      'job.transitioned',
      'session.opened',
      'session.finished',
      'input_request.created',
      'job.blocked',
    ],
    'the stream crosses job, session and input request, in the order the log recorded them',
  );

  const ids = events.map((event) => event.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ordered by id, the only total ordering');

  for (const event of events) {
    assert.equal(event.execution_id, 11, 'no event of another execution may leak in');
    assert.notEqual(
      event.entity.id,
      other.id,
      'the other execution has its own work; this one never mentions it',
    );
  }

  // The envelope arrives whole: the surveyor computes intervals from
  // `occurred_at` and attributes them by `data`.
  const opened = events.find((event) => event.type === 'session.opened');
  assert.ok(opened !== undefined);
  assert.equal(opened.data.node_id, 'revisar');
  assert.equal(typeof opened.occurred_at, 'string');

  const fromTheOther = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/12/events');
  assert.equal(fromTheOther.body.events.length, events.length, 'each execution sees only its own');
});

test('t110 — an execution with no events answers 200 with an empty list, never 404', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<ExecutionLog>(ctx, 'GET', '/v1/executions/99/events');

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.equal(response.body.execution_id, 99);
  assert.deepEqual(response.body.events, []);
});

/* -------------------------------------------------------------------------- */
/* t245 — the control plane declares the round over (D21, first of three)      */
/*                                                                            */
/* Until here nothing rolled `Job.completed` up across a whole `execution_id`: */
/* the log could say "this traveller arrived" and never "the round is over".   */
/* D21 makes that a fact the control plane — and only it (D1) — asserts, once, */
/* as `execution.finished`, readable both from the stream and as `finished_at` */
/* on the execution's own GET.                                                */
/* -------------------------------------------------------------------------- */

/**
 * The graph the rounds below run under: `redigir` is the entry, `revisar` is
 * the one final node.
 *
 * The same fixture `jobs.test.ts` and `replay-consistency.test.ts` already
 * register, and for the same reason: "the traveller arrived" is a property of
 * the job's VERSION, so a round can only finish over a version the registration
 * gate really accepted — a hand-made snapshot would prove nothing about it.
 */
const MINIMAL_GRAPH = path.join(
  PACKAGE_ROOT,
  '..',
  '..',
  'schema',
  'exemplos',
  'grafo-valido-minimo.json',
);

/** One execution, as `GET /v1/executions/:id` publishes it (t245, FR7). */
type ExecutionDetail = ExecutionSummary;

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

/** Creates a job of `execution` standing on the entry node of `version`. */
async function travellerOf(
  ctx: TestContext,
  execution: number,
  version: string,
  title: string,
): Promise<Job> {
  return await createJob(ctx, {
    title,
    entry_node_id: 'redigir',
    execution_id: execution,
    graph_version_id: version,
  });
}

/** Moves a job to a node, failing loudly instead of leaving a silent 4xx behind. */
async function moveTo(ctx: TestContext, jobId: number, node: string): Promise<void> {
  const response = await request<Job>(ctx, 'POST', `/v1/jobs/${jobId}/transitions`, {
    to_node_id: node,
  });
  assert.equal(response.status, 200, `transition to ${node} returned ${response.status}`);
}

/** Every `execution.finished` the round's own log carries, in log order. */
async function finishedEvents(ctx: TestContext, execution: number): Promise<Event[]> {
  const response = await request<ExecutionLog>(ctx, 'GET', `/v1/executions/${execution}/events`);
  assert.equal(response.status, 200);
  return response.body.events.filter((event) => event.type === 'execution.finished');
}

test('t245 AT1 — execution.finished fires exactly once, on the last job to arrive', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.events,
    T102_ARTIFACTS.validation,
    T102_ARTIFACTS.jobRepository,
    T102_ARTIFACTS.jobRoutes,
    T102_ARTIFACTS.executionRoutes,
  );
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);

  const first = await travellerOf(ctx, 245, version, 'nota que anda primeiro');
  const second = await travellerOf(ctx, 245, version, 'nota que anda depois');

  await moveTo(ctx, first.id, 'revisar');
  assert.deepEqual(
    await finishedEvents(ctx, 245),
    [],
    'one traveller arrived and the other is still at redigir: the round is not over',
  );

  await moveTo(ctx, second.id, 'revisar');
  const announced = await finishedEvents(ctx, 245);
  assert.equal(announced.length, 1, 'the round ends once, on the transition that completes it');

  const event = announced[0];
  assert.deepEqual(
    event.entity,
    { type: 'execution', id: 245 },
    'the subject is the ROUND, never whichever job happened to trigger the check',
  );
  assert.deepEqual(event.data, {}, 'the envelope already carries everything there is to say');
  assert.deepEqual(
    event.actor,
    { type: 'system', ref: 'control-plane' },
    'the control plane asserts this about itself (D1, D21), never the actor of the job mutation',
  );
  assert.equal(event.execution_id, 245);

  // "Once, ever" and not "once per re-check": the first job leaves the final
  // node and comes back, which makes the condition true a second time.
  await moveTo(ctx, first.id, 'redigir');
  await moveTo(ctx, first.id, 'revisar');
  assert.deepEqual(
    await finishedEvents(ctx, 245),
    announced,
    'the fact is recorded once and the log is not asked to repeat it',
  );
});

test('t245 AT2 — GET /v1/executions and GET /v1/executions/:id report finished_at', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.jobRepository,
    T102_ARTIFACTS.executionRoutes,
  );
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);

  const rowOf = async (execution: number): Promise<ExecutionSummary> => {
    const response = await request<{ executions: ExecutionSummary[] }>(
      ctx,
      'GET',
      '/v1/executions',
    );
    assert.equal(response.status, 200);
    const row = response.body.executions.find((entry) => entry.execution_id === execution);
    assert.ok(row !== undefined, `execution ${execution} is missing from the list`);
    return row;
  };

  const detailOf = async (execution: number): Promise<ExecutionDetail> => {
    const response = await request<ExecutionDetail>(ctx, 'GET', `/v1/executions/${execution}`);
    assert.equal(response.status, 200);
    return response.body;
  };

  const arriving = await travellerOf(ctx, 2450, version, 'nota que chega');
  const alsoArriving = await travellerOf(ctx, 2450, version, 'a outra nota que chega');
  // A second round, still in flight: the end of the first says nothing about it.
  const inFlight = await travellerOf(ctx, 2451, version, 'nota de outra rodada');

  assert.equal((await rowOf(2450)).finished_at, null, 'nobody arrived yet');
  assert.equal((await detailOf(2450)).finished_at, null);

  await moveTo(ctx, arriving.id, 'revisar');
  assert.equal((await rowOf(2450)).finished_at, null, 'half a round is not a round');

  await moveTo(ctx, alsoArriving.id, 'revisar');

  const announced = await finishedEvents(ctx, 2450);
  assert.equal(announced.length, 1);
  const occurredAt = announced[0].occurred_at;

  assert.equal(
    (await rowOf(2450)).finished_at,
    occurredAt,
    'the list reads the instant off the event, and does not store one of its own',
  );
  assert.deepEqual(await detailOf(2450), {
    execution_id: 2450,
    jobs: 2,
    blocked_jobs: 0,
    pending_input_requests: 0,
    finished_at: occurredAt,
  });

  assert.equal((await rowOf(2451)).finished_at, null, 'the other round is untouched');
  assert.equal((await detailOf(2451)).finished_at, null);
  assert.deepEqual(await finishedEvents(ctx, 2451), []);
  assert.equal(inFlight.current_node_id, 'redigir');
});

test('t245 AT3 — an execution with no job at all is never finished', async (t) => {
  requireArtifacts(T102_ARTIFACTS.migration, T102_ARTIFACTS.executionRoutes);
  const ctx = await startControlPlane(t);

  const response = await request<ExecutionDetail>(ctx, 'GET', '/v1/executions/99');

  assert.equal(response.status, 200, 'an execution is an opaque grouper: nothing to exist or not');
  assert.deepEqual(response.body, {
    execution_id: 99,
    jobs: 0,
    blocked_jobs: 0,
    pending_input_requests: 0,
    finished_at: null,
  }, 'zero jobs is never finished: the condition is not vacuously true');
});

/* -------------------------------------------------------------------------- */
/* The stream, read while it is still open (t245, AT4)                        */
/*                                                                            */
/* `request()` from `./support.ts` waits for the body to end and an SSE body   */
/* never ends, so this one test speaks `fetch` directly — the same shape       */
/* `events-stream.test.ts` uses, cut down to the two fields this assertion     */
/* reads. The credential goes in the header of the request that OPENS the      */
/* stream, which is the only place the route looks for it.                    */
/* -------------------------------------------------------------------------- */

/** One SSE message, in the slice this file reads. */
interface StreamMessage {
  event: string | null;
  data: string;
}

/** An open SSE connection, being read in the background. */
interface OpenStream {
  status: number;
  messages: StreamMessage[];
  abort: () => void;
}

/** Parses one `\n\n`-terminated block, ignoring the comment-only ones. */
function absorb(block: string, stream: OpenStream): void {
  const lines = block.split('\n').filter((line) => line !== '');
  if (lines.length === 0 || lines.every((line) => line.startsWith(':'))) return;

  const message: StreamMessage = { event: null, data: '' };
  for (const line of lines) {
    const cut = line.indexOf(':');
    const field = cut === -1 ? line : line.slice(0, cut);
    const value = cut === -1 ? '' : line.slice(cut + 1).replace(/^ /, '');
    if (field === 'event') message.event = value;
    if (field === 'data') message.data = message.data === '' ? value : `${message.data}\n${value}`;
  }
  stream.messages.push(message);
}

/** Opens the stream and starts reading it in the background. */
async function openStream(ctx: TestContext, query: string, t: TestHook): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${ctx.url}/v1/events/stream?${query}`, {
    headers: { authorization: `Bearer ${ctx.token}` },
    signal: controller.signal,
  });

  const stream: OpenStream = {
    status: response.status,
    messages: [],
    abort: () => controller.abort(),
  };
  t.after(() => stream.abort());

  const body = response.body;
  if (body !== null) {
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          absorb(buffer.slice(0, cut), stream);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
    })().catch(() => {
      // The abort of the test itself ends the read; there is nothing to report.
    });
  }

  return stream;
}

/** Waits for a condition, failing with a readable message instead of a timeout. */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Sleeps past a poll tick, for the "and nothing else arrived" assertions. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 800));

test('t245 AT4 — GET /v1/events/stream?type=execution.finished filters to it', async (t) => {
  requireArtifacts(
    T102_ARTIFACTS.migration,
    T102_ARTIFACTS.events,
    T102_ARTIFACTS.validation,
    T102_ARTIFACTS.executionRoutes,
    'src/routes/events.ts',
  );
  const ctx = await startControlPlane(t);
  const version = await registerMinimalGraph(ctx);

  const stream = await openStream(ctx, 'type=execution.finished', t);
  assert.equal(stream.status, 200, 'the type is in the taxonomy, so the filter is accepted');

  const first = await travellerOf(ctx, 2452, version, 'nota que anda primeiro');
  const second = await travellerOf(ctx, 2452, version, 'nota que anda depois');
  await moveTo(ctx, first.id, 'revisar');
  await settle();
  // The length, and not `deepEqual(messages, [])`: node's own types read that
  // second form as an assertion that narrows `messages` to `never[]`, and every
  // read of it after this line stops compiling.
  assert.equal(
    stream.messages.length,
    0,
    'two creations and a transition happened, and none of them is what was asked for',
  );

  await moveTo(ctx, second.id, 'revisar');
  await waitFor(() => stream.messages.length > 0, 'the execution.finished message');
  await settle();

  assert.deepEqual(stream.messages.map((message) => message.event), ['execution.finished']);
  const pushed = JSON.parse(stream.messages[0].data) as Event;
  assert.equal(pushed.type, 'execution.finished');
  assert.deepEqual(pushed.entity, { type: 'execution', id: 2452 });
  assert.deepEqual(pushed.data, {});
});
