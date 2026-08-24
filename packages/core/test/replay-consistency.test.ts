/**
 * Proof of consistency between the log and the projection (t102, AT17 / FR19).
 *
 * The quality non-negotiable is replayability by event sourcing: the final state
 * has to come out of the LOG and of nothing else.
 * `reducers/reconstruct-state.mjs` (t98) is the executable reference for that —
 * it was written before the control plane existed, precisely so it would be the
 * contract this ticket's projection tables would have to respect.
 *
 * This test closes the circle: it runs an execution through the API, folds the
 * log with the specification's reducer and demands that the result match, field
 * by field, what the tables answer. If one day the projection knows something
 * the log does not tell, this is where it shows up.
 *
 * Since t196 it covers the reducer's five projections and not three: `leases`
 * and `current_graph_version` used to fold to `{}` no matter what the control
 * plane did, because nobody recorded `lease.*` or `graph_version.*` — an empty
 * comparison that passed and proved nothing. The flow below now also registers a
 * lineage, moves its pointer with a proposal and moves it back, and grants a
 * lease that dies of old age.
 *
 * t245 adds the sixth, `executions`, and the same care: a round that really ENDS
 * (every traveller on a final node of a version that resolves, no lease still
 * holding one) rides beside the round that stays open, so the fold has both a
 * `finished_at` to reproduce and an absence to respect.
 *
 * The reducer's own state keys are English since t300, which translated
 * `especificacoes/**` under D24. They were Portuguese when t127 wrote this file
 * and were left alone then, as outside that ticket's rename scope (t127, FR8).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  T102_ARTIFACTS,
  loadEvents,
  createJob,
  requireArtifacts,
  request,
  resolvePins,
  startControlPlane,
  type TestContext,
  type Event,
  type InputRequest,
  type Session,
  type Job,
} from './support.ts';

/** The reducer lives in the specification, outside the package — it is the reference, not core code. */
const REDUCER = '../../../especificacoes/eventos/reducers/reconstruct-state.mjs';

/** The graph document every flow in this file starts from. */
const MINIMAL_EXAMPLE = path.join(
  PACKAGE_ROOT,
  '..',
  '..',
  'schema',
  'exemplos',
  'graph-valid-minimal.json',
);

interface ReconstructedState {
  jobs: Record<string, { current_node_id: string; blocked: boolean; node_history: string[] }>;
  sessions: Record<string, { status: string; exit_code: number | null }>;
  input_requests: Record<
    string,
    { status: string; answer: string | null; answer_source: string | null }
  >;
  /** t196: the lifecycle of a lease, folded out of `lease.granted`/`lease.expired`. */
  leases: Record<string, { status: string }>;
  /** t196: which version holds per lineage, folded out of `graph_version.applied`/`.reverted`. */
  current_graph_version: Record<string, string>;
  /** t245: which rounds are over, folded out of `execution.finished` (D21). */
  executions: Record<string, { finished_at: string }>;
}

/** A lineage and a version, as `/v1` publishes them — the fields this file reads. */
interface Graph {
  id: string;
  current_version_id: string | null;
}

interface GraphVersion {
  id: string;
}

/** A lease, as `/v1` publishes it — the fields this file reads. */
interface Lease {
  id: number;
  status: string;
}

const EXECUTION = 7;

/**
 * The round that ENDS, beside the one that does not (t245).
 *
 * A second execution and not a third job of the first, because execution 7 is
 * built to stay open: one of its jobs is blocked, the other cites a version
 * nobody can resolve, and a lease is still active over both. What the fold has
 * to reproduce is a `finished_at` that the API also reports — which needs a
 * round where every traveller really arrived, on a version the registration gate
 * really accepted, with no lease left holding it.
 */
const FINISHED_EXECUTION = 8;

/** Node history of a job, derived only from the API (created + transitions). */
async function historyFromApi(ctx: TestContext, jobId: number): Promise<string[]> {
  const response = await request<{ events: Event[] }>(ctx, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);

  const history: string[] = [];
  for (const event of response.body.events) {
    if (event.type === 'job.created') history.push(event.data.entry_node_id as string);
    if (event.type === 'job.transitioned') history.push(event.data.to_node_id as string);
  }
  return history;
}

/**
 * Registers the minimal graph, moves the pointer with a proposal and moves it
 * back (t196, FR8).
 *
 * The three writes are what `graph_version.registered`/`.applied`/`.reverted`
 * exist for, and the round trip ends where it started: what the fold has to
 * reproduce is a pointer that MOVED and came back, which is a strictly harder
 * claim than a pointer that never moved.
 *
 * @param ctx Control plane running.
 * @returns The lineage and the version that holds at the end.
 */
async function graphRoundTrip(
  ctx: TestContext,
): Promise<{ graph: Graph; baseVersion: string }> {
  const document = JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as Record<string, unknown>;
  // A resolvable pin per node, so the version is `checked` and the jobs below
  // may cite it (t283).
  await resolvePins(ctx, document);

  const registered = await request<{ graph: Graph; graph_version: GraphVersion }>(
    ctx,
    'POST',
    '/v1/graphs',
    document,
  );
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const graph = registered.body.graph;
  const baseVersion = registered.body.graph_version.id;

  const proposal = await request<{ proposal: { id: number } }>(ctx, 'POST', '/v1/proposals', {
    graph_id: graph.id,
    target_version: baseVersion,
    operations: [
      {
        type: 'change_node_field',
        node_id: 'revisar',
        field: 'role',
        from: 'revisor',
        to: 'red-team',
        inverse: {
          type: 'change_node_field',
          node_id: 'revisar',
          field: 'role',
          from: 'red-team',
          to: 'revisor',
        },
      },
    ],
    evidence: { fonte: 'telemetria', observacao: 'a revisão passa tudo' },
    expected_metric: { nome: 'reprovacoes', direcao: 'sobe', de: 0, para: 2 },
  });
  assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
  const proposalId = proposal.body.proposal.id;

  const approved = await request(ctx, 'POST', `/v1/proposals/${proposalId}/approve`, {});
  assert.equal(approved.status, 200);
  const applied = await request(ctx, 'POST', `/v1/proposals/${proposalId}/apply`, {});
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const reverted = await request(ctx, 'POST', `/v1/proposals/${proposalId}/revert`, {
    reason: 'o red-team reprovou tudo e a travessia parou',
  });
  assert.equal(reverted.status, 200, JSON.stringify(reverted.body));

  return { graph, baseVersion };
}

/**
 * Grants a lease, lets its deadline pass and asks for a second one (t196, FR8).
 *
 * The real clock, on purpose: this file's whole point is the path production
 * runs, and the second request is the reconciliation D5 puts at the start of
 * every grant — which is what turns the first lease into `lease.expired`.
 *
 * @param ctx Control plane running.
 * @returns The id of the lease that died and the id of the one still holding.
 */
async function leaseRoundTrip(ctx: TestContext): Promise<{ expired: number; granted: number }> {
  const runner = await request(ctx, 'POST', '/v1/runners', { id: 'runner-replay' });
  assert.equal(runner.status, 201, JSON.stringify(runner.body));

  const ask = async (jobId: number): Promise<Lease> => {
    const response = await request<{ lease: Lease | null }>(ctx, 'POST', '/v1/leases', {
      runner_id: 'runner-replay',
      project_id: 1,
      job_id: jobId,
      runner_cap: 8,
      project_cap: 8,
      ttl_seconds: 1,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.ok(response.body.lease !== null);
    return response.body.lease;
  };

  const doomed = await ask(1);
  // The shortest deadline the route accepts is one second, so this is the one
  // wait in the file — and it buys the `expirada` end of the lifecycle, which no
  // API call can produce on its own.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const survivor = await ask(2);

  return { expired: doomed.id, granted: survivor.id };
}

test('AT17 — the specification reducer reproduces the projection tables exactly', async (t) => {
  requireArtifacts(...Object.values(T102_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const { listEvents } = await loadEvents();
  const { reconstructState } = (await import(new URL(REDUCER, import.meta.url).href)) as {
    reconstructState: (events: Event[]) => ReconstructedState;
  };

  // --- the execution, end to end, through the API only ----------------------
  const job = await createJob(ctx, {
    title: 'trabalho que anda',
    entry_node_id: 'entrada',
    execution_id: EXECUTION,
    graph_version_id: 'v1',
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'refinamento',
  });
  await request(ctx, 'POST', `/v1/jobs/${job.id}/transitions`, {
    to_node_id: 'desenvolvimento',
  });
  await request(ctx, 'PATCH', `/v1/jobs/${job.id}`, { title: 'título emendado' });

  const session = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'desenvolvimento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'implemente a ficha',
    timeout_seconds: 5400,
  });
  assert.equal(session.status, 201);

  const inputRequest = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: job.id,
    session_id: session.body.id,
    kind: 'question',
    question: 'renumerar a migração?',
    recommendation: 'manter 0002',
    auto_approvable: true,
  });
  assert.equal(inputRequest.status, 201);

  await request(ctx, 'PATCH', `/v1/input-requests/${inputRequest.body.id}/answer`, {
    answer: 'manter 0002',
    answered_by: 'rafael',
  });
  await request(ctx, 'PATCH', `/v1/sessions/${session.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });

  // A second job, blocked and auto-resolved: it covers the ends the main
  // sequence does not touch (blocked flag, automatic origin).
  const stopped = await createJob(ctx, {
    title: 'trabalho que para',
    entry_node_id: 'entrada',
    execution_id: EXECUTION,
    graph_version_id: 'v2',
  });
  const auto = await request<InputRequest>(ctx, 'POST', '/v1/input-requests', {
    job_id: stopped.id,
    kind: 'approval',
    question: 'aprova o artefato?',
    default_answer: 'aprovar',
    auto_approvable: true,
  });
  assert.equal(auto.status, 201);
  await request(ctx, 'PATCH', `/v1/input-requests/${auto.body.id}/auto-resolution`, {
    answer: 'aprovar',
    based_on: 'default_answer',
  });
  // The manual block comes AFTER the auto-resolution since t106: asking already
  // blocks and answering already unblocks (in the same transaction), so blocking
  // first would leave the job unblocked at the end and the "flag raised" end with
  // no coverage at all. The sequence as it is now exercises both origins of a
  // block — the automatic one from the escalation and the manual one.
  await request(ctx, 'POST', `/v1/jobs/${stopped.id}/blocks`, { reason: 'esperando humano' });
  const otherSession = await request<Session>(ctx, 'POST', '/v1/sessions', {
    execution_id: EXECUTION,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'sessão que fica aberta',
  });
  assert.equal(otherSession.status, 201);

  // The two entities the log was blind to until t196: a lineage that is
  // registered, moved by a proposal and moved back, and a lease that is granted
  // and dies of old age. Both go through the API like everything else here.
  const { graph, baseVersion } = await graphRoundTrip(ctx);

  // A round that really ENDS (t245): one traveller, on the version the gate
  // above accepted, walked to the graph's own final node. It is what puts an
  // `execution.finished` in the log — and the lease round trip below never
  // touches this job, so nothing is still holding it when it arrives.
  const arriving = await createJob(ctx, {
    title: 'nota que chega ao fim',
    entry_node_id: 'redigir',
    execution_id: FINISHED_EXECUTION,
    graph_version_id: baseVersion,
  });
  const arrival = await request(ctx, 'POST', `/v1/jobs/${arriving.id}/transitions`, {
    to_node_id: 'revisar',
  });
  assert.equal(arrival.status, 200, JSON.stringify(arrival.body));

  // ...and then RUNS that final node, because since t262 landing on it is not
  // the end of anything: `revisar` pins a skill, and the round ends on the
  // session that reports it, not on the transition that arrived (FR4). The
  // third session of this log, and the first one outside execution 7 — which
  // is why the projection below stopped slicing sessions by round.
  const closing = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: arriving.id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'revisa e encerra',
  });
  assert.equal(closing.status, 201);
  const closed = await request(ctx, 'PATCH', `/v1/sessions/${closing.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    output: { outcome: 'passou', evidencia: 'a nota responde ao tema' },
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));

  const { granted, expired } = await leaseRoundTrip(ctx);

  // --- the state, rebuilt from the log alone --------------------------------
  const events = listEvents(ctx.db);
  assert.ok(events.length > 0, 'the log cannot be empty');
  const state = reconstructState(events);

  // --- the state, as the projection tables answer it ------------------------
  // Every job, and not only execution 7's, since t245: the fold knows nothing
  // about rounds when it builds `jobs`, so slicing the projection by one
  // execution while the log carries two would compare two different sets.
  const jobs = await request<{ jobs: Job[] }>(ctx, 'GET', '/v1/jobs');
  // Unsliced since t262, for the reason the jobs read above already gives: the
  // round that ENDS now needs a session of its own, so the log carries sessions
  // of two executions and comparing one slice against the whole fold would be
  // comparing two different sets.
  const sessions = await request<{ sessions: Session[] }>(ctx, 'GET', '/v1/sessions');
  const inputRequests = await request<{ input_requests: InputRequest[] }>(
    ctx,
    'GET',
    `/v1/input-requests?execution_id=${EXECUTION}`,
  );

  const projectedJobs: ReconstructedState['jobs'] = {};
  for (const row of jobs.body.jobs) {
    projectedJobs[String(row.id)] = {
      current_node_id: row.current_node_id,
      blocked: row.blocked,
      node_history: await historyFromApi(ctx, row.id),
    };
  }

  const projectedSessions: ReconstructedState['sessions'] = {};
  for (const row of sessions.body.sessions) {
    projectedSessions[String(row.id)] = { status: row.status, exit_code: row.exit_code };
  }

  // No translation layer any more (t227): the reducer's derived `status` and
  // `answer_source` are the same English words the API projection publishes, so
  // the comparison below is about REPLAY again and not about spelling. The last
  // two Portuguese keys of that output shape — `perguntas` and `origem` — went
  // with t300, which had no glossary row to consult and used the wire's own
  // words for the fields they project.
  const projectedInputRequests: ReconstructedState['input_requests'] = {};
  for (const row of inputRequests.body.input_requests) {
    projectedInputRequests[String(row.id)] = {
      status: row.status,
      answer: row.answer,
      answer_source: row.source,
    };
  }

  // The lease projection the reducer folds is `{status}` and nothing else: the
  // log carries the whole lifecycle, and the deadlines it stamps belong to the
  // table, not to the fold.
  const leases = await request<{ leases: Lease[] }>(ctx, 'GET', '/v1/leases');
  assert.equal(leases.status, 200);
  const projectedLeases: ReconstructedState['leases'] = {};
  for (const row of leases.body.leases) {
    projectedLeases[String(row.id)] = { status: row.status };
  }

  const lineage = await request<{ graph: Graph }>(ctx, 'GET', `/v1/graphs/${graph.id}`);
  assert.equal(lineage.status, 200);
  const projectedPointer: ReconstructedState['current_graph_version'] = {
    [lineage.body.graph.id]: lineage.body.graph.current_version_id as string,
  };

  // The end of a round is derived at read time from the log, exactly like the
  // fold derives it — so what the two have to agree on is the INSTANT, and a
  // round that never ended has to be absent from both (t245).
  const finished = await request<{ finished_at: string | null }>(
    ctx,
    'GET',
    `/v1/executions/${FINISHED_EXECUTION}`,
  );
  assert.equal(finished.status, 200);
  const open = await request<{ finished_at: string | null }>(
    ctx,
    'GET',
    `/v1/executions/${EXECUTION}`,
  );
  assert.equal(open.status, 200);
  const projectedExecutions: ReconstructedState['executions'] = {};
  if (finished.body.finished_at !== null) {
    projectedExecutions[String(FINISHED_EXECUTION)] = { finished_at: finished.body.finished_at };
  }

  // --- and the two have to be the same thing --------------------------------
  assert.deepEqual(state.jobs, projectedJobs);
  assert.deepEqual(state.sessions, projectedSessions);
  assert.deepEqual(state.input_requests, projectedInputRequests);
  assert.deepEqual(state.leases, projectedLeases);
  assert.deepEqual(state.current_graph_version, projectedPointer);
  assert.deepEqual(state.executions, projectedExecutions);

  // Guards against an empty pass of the six deepEqual above.
  assert.equal(Object.keys(state.jobs).length, 3);
  assert.ok(
    typeof state.executions[String(FINISHED_EXECUTION)]?.finished_at === 'string',
    'the round that ended has to come out of the log with an instant on it',
  );
  assert.equal(
    open.body.finished_at,
    null,
    'execution 7 has a blocked job, an unresolvable version and a live lease: it never ends',
  );
  assert.equal(state.executions[String(EXECUTION)], undefined);
  // Three since t262: the two of execution 7, plus the one that closes the
  // final node of the round that ends.
  assert.equal(Object.keys(state.sessions).length, 3);
  assert.equal(Object.keys(state.input_requests).length, 2);
  assert.equal(Object.keys(state.leases).length, 2);
  assert.deepEqual(state.leases[String(expired)], { status: 'expired' });
  assert.deepEqual(state.leases[String(granted)], { status: 'active' });
  assert.equal(
    state.current_graph_version[graph.id],
    baseVersion,
    'the revert took the pointer back, and the log alone says so',
  );
  assert.deepEqual(state.jobs[String(job.id)].node_history, [
    'entrada',
    'refinamento',
    'desenvolvimento',
  ]);
  assert.equal(state.jobs[String(stopped.id)].blocked, true);
  assert.equal(state.input_requests[String(auto.body.id)].answer_source, 'auto');
  assert.equal(state.sessions[String(otherSession.body.id)].status, 'open');
});
