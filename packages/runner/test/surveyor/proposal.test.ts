/**
 * Acceptance tests for the surveyor's one agentic step and the proposal it
 * lands in the book (t110, FR5–FR9).
 *
 * This is D16's "beat the flowpilot" milestone exercised end to end: a real
 * control plane over HTTP, a real event log read back through
 * `GET /v1/executions/:id/events`, a real `EngineAdapter` session (the fake
 * engine, for the reason the conformance kit records), and a real
 * `POST /v1/proposals` — with the evidence computed by our own code, never by
 * the agent's recall.
 *
 * Three claims, one per test:
 *
 * 1. a run with a clear bottleneck produces EXACTLY ONE pending proposal whose
 *    `evidence.event_ids` are ids that exist in the seeded log, and never calls
 *    `.../aplicar` — the safety ladder of README principle 5 is the point;
 * 2. a session that returns nothing usable aborts, and posts nothing;
 * 3. a flat run posts nothing AND never opens a session at all.
 *
 * The control-plane boot is the same pattern as
 * `test/dispatch/dispatch.test.ts`: spawn the real binary, wait for
 * the readiness line, never `sleep` and hope. It is duplicated rather than
 * extracted because that file belongs to another ticket's surface.
 *
 * English per D18; route segments and payload keys stay in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type {
  EngineAdapter,
  EngineCapabilities,
  SessionListener,
  SessionSpec,
  SessionStatus,
} from '../../src/engine/types.ts';
import type * as ClientModule from '../../src/controller/control-plane-client.ts';
import type * as ProposalModule from '../../src/surveyor/proposal.ts';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { authorizeGlobalFetch } from '../authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const PROPOSAL_MODULE = 'src/surveyor/proposal.ts';

/** Execution with a bottleneck, and the flat one. */
const EXECUTION_WITH_SIGNAL = 7;
const FLAT_EXECUTION = 8;

/**
 * Slack between two timestamps of the seeded telemetry.
 *
 * `ocorrido_em` has millisecond resolution, so two writes in the same tick
 * would produce a zero interval and a run with no signal — which is the OTHER
 * test's scenario. Small enough not to slow the suite, large enough that the
 * clock cannot collapse it.
 */
const GAP_MS = 25;

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface GraphVersion {
  id: string;
  graph_id: string;
}

interface Work {
  id: number;
}

interface Session {
  id: number;
}

interface Question {
  id: number;
}

interface Event {
  id: number;
  tipo: string;
}

interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  operations: Array<Record<string, unknown>>;
  evidence: Record<string, unknown>;
  expected_metric: Record<string, unknown>;
  status: string;
  applied_version_id: string | null;
}

let clientCache: typeof ClientModule | null = null;
let proposalCache: typeof ProposalModule | null = null;

async function loadClient(): Promise<typeof ClientModule> {
  clientCache ??= (await import(
    new URL('../../src/controller/control-plane-client.ts', import.meta.url).href
  )) as typeof ClientModule;
  return clientCache;
}

async function loadProposal(): Promise<typeof ProposalModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, PROPOSAL_MODULE)),
    `artifact does not exist yet: packages/runner/${PROPOSAL_MODULE}`,
  );
  proposalCache ??= (await import(
    new URL(`../../${PROPOSAL_MODULE}`, import.meta.url).href
  )) as typeof ProposalModule;
  return proposalCache;
}

/**
 * Boots the real control plane and arms its credential on the global `fetch`.
 *
 * The spawn, the readiness wait and the teardown are
 * `@cartografo/test-support`'s since t201. Since t124 the API answers nothing
 * without a credential; the control plane prints the one it minted, and this
 * suite presents it from here on.
 *
 * @param t Test context, so both the process and the patch are undone at the end.
 * @returns The URL the control plane announced.
 */
async function bootControlPlane(t: TestHook): Promise<{ baseUrl: string; token: string }> {
  const { url, token } = await bootCore(t);
  authorizeGlobalFetch(t, { baseUrl: url, token });
  return { baseUrl: url, token };
}

/** Talks JSON with the control plane, asserting the status on the way. */
async function api<T>(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Everything a test needs: a control plane, a seeded graph and a work dir. */
interface Scenario {
  baseUrl: string;
  version: GraphVersion;
  workingDir: string;
  eventIds: number[];
  calls: string[];
  client: ClientModule.ControlPlaneClient;
}

/**
 * Seeds one execution whose `revisar` node is unmistakably the bottleneck:
 * queued, then busy, then blocked on a question, plus the question itself.
 *
 * Every number comes from the real clock of the control plane — this test does
 * not fabricate timestamps, precisely because FR1's stream is what the surveyor
 * will read in production.
 */
async function seedBottleneck(baseUrl: string, versionId: string): Promise<void> {
  const work = await api<Work>(
    baseUrl,
    'POST',
    '/v1/jobs',
    {
      title: 'a crossing with a bottleneck',
      entry_node_id: 'redigir',
      execution_id: EXECUTION_WITH_SIGNAL,
      graph_version_id: versionId,
    },
    201,
  );

  // Lands on `revisar` and waits in the dispatch queue.
  await api(baseUrl, 'POST', `/v1/jobs/${work.id}/transitions`, { to_node_id: 'revisar' });
  await delay(GAP_MS);

  const session = await api<Session>(
    baseUrl,
    'POST',
    '/v1/sessions',
    {
      job_id: work.id,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revise a nota',
    },
    201,
  );

  // Asks, which blocks the work in the same transaction (t106).
  const question = await api<Question>(
    baseUrl,
    'POST',
    '/v1/input-requests',
    {
      job_id: work.id,
      session_id: session.id,
      kind: 'question',
      question: 'a nota responde ao tema?',
      auto_approvable: true,
    },
    201,
  );
  await delay(GAP_MS);

  await api(baseUrl, 'PATCH', `/v1/input-requests/${question.id}/answer`, {
    answer: 'responde, siga',
    answered_by: 'rafael',
  });
  await api(baseUrl, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
  });
}

async function buildScenario(t: TestHook): Promise<Scenario> {
  const { ControlPlaneClient } = await loadClient();
  const { baseUrl, token } = await bootControlPlane(t);

  // A resolvable capability per node, or the version is stored `unchecked` and
  // the travellers this scenario seeds could not be created at all (t283).
  const document = await resolvePins(
    baseUrl,
    token,
    JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>,
  );
  const { graph_version: version } = await api<{ graph_version: GraphVersion }>(
    baseUrl,
    'POST',
    '/v1/graphs',
    document,
    201,
  );

  await seedBottleneck(baseUrl, version.id);

  // The flat execution: a work that was created under the same version and
  // never moved. No session, no block — no signal.
  await api(
    baseUrl,
    'POST',
    '/v1/jobs',
    {
      title: 'a crossing with no signal',
      entry_node_id: 'redigir',
      execution_id: FLAT_EXECUTION,
      graph_version_id: version.id,
    },
    201,
  );

  const workingDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t110-workdir-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const { events } = await api<{ events: Event[] }>(
    baseUrl,
    'GET',
    `/v1/executions/${EXECUTION_WITH_SIGNAL}/events`,
  );
  assert.ok(events.length >= 6, `the seeded log is too short: ${JSON.stringify(events)}`);

  const calls: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return await fetch(input, init);
  };

  return {
    baseUrl,
    version,
    workingDir,
    eventIds: events.map((event) => event.id),
    calls,
    client: new ControlPlaneClient({ urlBase: baseUrl, fetchImpl: doFetch }),
  };
}

/** The `claude` argv, handed whole to the fake engine — only the binary changes. */
function fakeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec: SessionSpec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });
}

/** Counts sessions without changing anything the adapter does. */
class CountingAdapter implements EngineAdapter {
  readonly engineName: string;
  sessions = 0;
  readonly #inner: EngineAdapter;

  constructor(inner: EngineAdapter) {
    this.#inner = inner;
    this.engineName = inner.engineName;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    this.sessions += 1;
    return await this.#inner.startSession(spec, listener);
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return await this.#inner.getStatus(sessionId);
  }

  async cancel(sessionId: string, status?: SessionStatus): Promise<void> {
    await this.#inner.cancel(sessionId, status);
  }

  capabilities(): EngineCapabilities {
    return this.#inner.capabilities();
  }

  async verifyCli(): ReturnType<EngineAdapter['verifyCli']> {
    return await this.#inner.verifyCli();
  }
}

/** A well-formed semantic diff, in the vocabulary of `entities-versioning` §3. */
const VALID_OPERATIONS = [
  {
    type: 'change_node_field',
    node_id: 'revisar',
    field: 'description',
    from: 'Checks the note against the declared topic and closes the crossing.',
    to: 'Checks the note against the declared topic, with a three-item checklist.',
    inverse: {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'description',
      from: 'Checks the note against the declared topic, with a three-item checklist.',
      to: 'Checks the note against the declared topic and closes the crossing.',
    },
  },
];

/** Configures the fake engine to write `conteudo` where the surveyor reads it. */
function engineWriting(file: string, content: string): Record<string, string> {
  return { FAKE_ENGINE_WRITE_FILES: JSON.stringify({ [file]: content }) };
}

const postsToProposals = (calls: readonly string[]): string[] =>
  calls.filter((call) => call === 'POST /v1/proposals');

test('t110 — a run with a bottleneck lands exactly one pending proposal, backed by real event ids', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);
  const adapter = new CountingAdapter(fakeAdapter());

  const result = await proposeFlowImprovement({
    client: scenario.client,
    adapter,
    executionId: EXECUTION_WITH_SIGNAL,
    workingDir: scenario.workingDir,
    timeoutSeconds: 60,
    envOverrides: engineWriting(
      OUTPUT_FILE,
      JSON.stringify({ operations: VALID_OPERATIONS }, null, 2),
    ),
  });

  assert.equal(adapter.sessions, 1, 'exactly one agent session decides the operations');
  assert.equal(result.gargalo?.node_id, 'revisar', 'the seeded bottleneck is the one found');
  assert.ok(result.proposta !== null, 'a bottleneck with a well-formed diff becomes a proposal');

  assert.deepEqual(
    postsToProposals(scenario.calls),
    ['POST /v1/proposals'],
    'exactly one POST /v1/proposals, never two',
  );
  assert.deepEqual(
    scenario.calls.filter((call) => call.includes('/aplicar')),
    [],
    'a surveyor proposal only ever reaches "pending" (README, principle 5)',
  );

  const { proposals } = await api<{ proposals: Proposal[] }>(
    scenario.baseUrl,
    'GET',
    '/v1/proposals',
  );
  assert.equal(proposals.length, 1);
  const proposal = proposals[0];

  assert.equal(proposal.id, result.proposta.id);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.applied_version_id, null, 'nothing was applied');
  assert.equal(proposal.graph_id, scenario.version.graph_id);
  assert.equal(proposal.target_version, scenario.version.id);
  assert.deepEqual(proposal.operations, VALID_OPERATIONS, 'the session chose the operations');

  // The evidence is ours, not the agent's: the four numbers plus the ids of the
  // events they were computed from, every one of them real.
  const evidence = proposal.evidence;
  assert.equal(evidence.node_id, 'revisar');
  assert.equal(evidence.execution_id, EXECUTION_WITH_SIGNAL);
  const ids = evidence.event_ids as number[];
  assert.ok(Array.isArray(ids) && ids.length > 0, 'evidence without ids is a summary, not evidence');
  for (const id of ids) {
    assert.ok(scenario.eventIds.includes(id), `evidence.event_ids cites ${id}, absent from the log`);
  }
  // The lens's own vocabulary is English since t264 (§5.6); `fonte` is the one
  // deliberate exception, and it is a label, not a measure.
  assert.equal(evidence.graph_version_id, scenario.version.id);
  assert.deepEqual(
    Object.keys(evidence).filter((key) => key.startsWith('tempo_') || key === 'por_no'),
    [],
    'no Portuguese measure key survives on the wire the book stores',
  );
  for (const field of ['agent_ms', 'blocked_ms', 'queue_ms', 'input_requests']) {
    assert.equal(typeof evidence[field], 'number', `evidence.${field} must be a number`);
  }

  // The whole ranking rides along, so "why THIS node?" is answerable without a
  // re-run — under the name §5.6 gives it.
  const ranking = evidence.by_node as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(ranking) && ranking.length > 0, 'the ranking travels with the evidence');
  assert.ok(
    ranking.every((row) => typeof row.node_id === 'string' && typeof row.agent_ms === 'number'),
    `every row of by_node is spelled in English: ${JSON.stringify(ranking)}`,
  );
  assert.ok((evidence.total_ms as number) > 0, 'the bottleneck has to have cost something');

  // `metrica_esperada` has the shape t112's verdict can read.
  const metric = proposal.expected_metric;
  assert.equal(typeof metric.nome, 'string');
  assert.ok(['sobe', 'cai'].includes(metric.direcao as string));
  assert.equal(typeof metric.de, 'number');
  assert.equal(typeof metric.para, 'number');
});

test('t110 — a session that returns nothing usable aborts, and posts nothing', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);

  const run = async (envOverrides: Record<string, string>): Promise<void> => {
    await proposeFlowImprovement({
      client: scenario.client,
      adapter: fakeAdapter(),
      executionId: EXECUTION_WITH_SIGNAL,
      workingDir: scenario.workingDir,
      timeoutSeconds: 60,
      envOverrides,
    });
  };

  // 1. An empty diff: a proposal that changes nothing is not a proposal.
  // The pattern is built from a string, not a regex literal, because what it
  // matches is the frozen wire key and not an identifier of ours (D18/FR2).
  await assert.rejects(
    async () => run(engineWriting(OUTPUT_FILE, JSON.stringify({ operations: [] }))),
    new RegExp('operations', 'i'),
  );

  // 2. Structurally malformed: an operation with no inverse, which the server
  // would refuse with 400 — and which never gets that far.
  await assert.rejects(
    async () =>
      run(
        engineWriting(
          OUTPUT_FILE,
          JSON.stringify({ operations: [{ type: 'add_node', node: { id: 'red_team' } }] }),
        ),
      ),
    new RegExp('operation|operations', 'i'),
  );

  // 3. The session wrote nothing at all.
  await assert.rejects(async () => run({ FAKE_ENGINE_LINES: '[]' }));

  // 4. The session died.
  await assert.rejects(async () => run({ FAKE_ENGINE_EXIT_CODE: '3' }));

  assert.deepEqual(postsToProposals(scenario.calls), [], 'no proposal may be posted from a bad run');
  const { proposals } = await api<{ proposals: Proposal[] }>(
    scenario.baseUrl,
    'GET',
    '/v1/proposals',
  );
  assert.deepEqual(proposals, [], 'and nothing landed in the book');
});

test('t228 — the old `operacoes` wrapper and the old operation keys are both refused, before any POST', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE, SurveyorError } = await loadProposal();
  const scenario = await buildScenario(t);

  const run = async (document: unknown): Promise<void> => {
    await proposeFlowImprovement({
      client: scenario.client,
      adapter: fakeAdapter(),
      executionId: EXECUTION_WITH_SIGNAL,
      workingDir: scenario.workingDir,
      timeoutSeconds: 60,
      envOverrides: engineWriting(OUTPUT_FILE, JSON.stringify(document)),
    });
  };

  // The wrapper key moved with the rest of the vocabulary (FR5): a session still
  // writing `operacoes` has written a file with no operations in it, which is
  // the same "nothing to propose" as an empty list — not a second dialect the
  // reader quietly accepts.
  await assert.rejects(
    async () => run({ operacoes: VALID_OPERATIONS }),
    (error: unknown) => error instanceof SurveyorError && error.code === 'missing_operations',
  );

  // And an operation still spelled in Portuguese is caught by the local mirror,
  // which is the whole reason the mirror exists (FR7 of t110): the server would
  // answer 400, and this way nobody spends the write to find out.
  await assert.rejects(
    async () =>
      run({
        operations: [
          {
            tipo: 'alterar_campo_no',
            no_id: 'revisar',
            campo: 'description',
            de: 'before',
            para: 'after',
            inversa: {
              tipo: 'alterar_campo_no',
              no_id: 'revisar',
              campo: 'description',
              de: 'after',
              para: 'before',
            },
          },
        ],
      }),
    (error: unknown) => error instanceof SurveyorError && error.code === 'invalid_operations',
  );

  assert.deepEqual(postsToProposals(scenario.calls), [], 'a bad diff never reaches the control plane');
});

test('t110 — a flat run exits quietly: no session, no proposal', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);
  const adapter = new CountingAdapter(fakeAdapter());

  const result = await proposeFlowImprovement({
    client: scenario.client,
    adapter,
    executionId: FLAT_EXECUTION,
    workingDir: scenario.workingDir,
    timeoutSeconds: 60,
    envOverrides: engineWriting(
      OUTPUT_FILE,
      JSON.stringify({ operations: VALID_OPERATIONS }),
    ),
  });

  assert.equal(result.gargalo, null, 'no signal, nothing to propose');
  assert.equal(result.proposta, null);
  assert.equal(adapter.sessions, 0, 'with nothing to explain, no agent is paid to explain it');
  assert.deepEqual(postsToProposals(scenario.calls), []);
});

/* -------------------------------------------------------------------------- */
/* t247 — `criada` tells a proposal that landed from one that was deduplicated */
/*                                                                            */
/* The flow lens is about to stop being something a person types (D21's third  */
/* child), and an unattended caller has to be able to say which of the two     */
/* happened. Since t246 it cannot read that off the proposal: a deduplicated   */
/* one reads `pendente` exactly like a fresh one, and the only difference is   */
/* the status the control plane answered with.                                 */
/* -------------------------------------------------------------------------- */

test('t247 AT2 — criada is true on the first run and false when t246 deduplicates', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);

  const run = async (): Promise<ProposalModule.SurveyorResult> =>
    await proposeFlowImprovement({
      client: scenario.client,
      adapter: fakeAdapter(),
      executionId: EXECUTION_WITH_SIGNAL,
      workingDir: scenario.workingDir,
      timeoutSeconds: 60,
      envOverrides: engineWriting(
        OUTPUT_FILE,
        JSON.stringify({ operations: VALID_OPERATIONS }, null, 2),
      ),
    });

  const first = await run();
  assert.equal(first.criada, true, 'the first run creates the proposal: 201');
  assert.ok(first.proposta !== null);

  // The same telemetry, the same version, the same operations — which is the
  // triple t246 keys on. Nothing about this second run is different, and that
  // is the point: an unattended trigger firing twice must not clone a proposal.
  const second = await run();
  assert.equal(second.criada, false, 'the repeat matched the pending proposal: 200');
  assert.ok(second.proposta !== null);
  assert.equal(
    second.proposta.id,
    first.proposta.id,
    'and it is the SAME proposal, strengthened, never a second one',
  );

  const { proposals } = await api<{ proposals: Proposal[] }>(
    scenario.baseUrl,
    'GET',
    '/v1/proposals',
  );
  assert.equal(proposals.length, 1, `two runs, one proposal: ${JSON.stringify(proposals)}`);
});

test('t247 AT2 — a run with nothing to propose reports criada as null, not false', async (t) => {
  const { proposeFlowImprovement, OUTPUT_FILE } = await loadProposal();
  const scenario = await buildScenario(t);

  const result = await proposeFlowImprovement({
    client: scenario.client,
    adapter: fakeAdapter(),
    executionId: FLAT_EXECUTION,
    workingDir: scenario.workingDir,
    timeoutSeconds: 60,
    envOverrides: engineWriting(OUTPUT_FILE, JSON.stringify({ operations: VALID_OPERATIONS })),
  });

  assert.equal(result.proposta, null, 'no bottleneck, nothing to propose (unchanged since t110)');
  assert.equal(
    result.criada,
    null,
    '`false` would read as "it was deduplicated"; nothing was posted at all',
  );
});
