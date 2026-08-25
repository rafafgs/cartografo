/**
 * `close-surveyor-outcome.mjs` against a real control plane (t285, AT-a/AT-b).
 *
 * The script's own header draws the line this file exists to hold: the pure half
 * is `src/surveyor/outcome.ts`, "what lives here is the network and the exit
 * code". `test/surveyor/outcome.test.ts` covers the pure half and covered it all
 * along — and the network half still shipped six stale wire reads, because
 * nothing in CI ever ran a line of the `.mjs`. The first of them,
 * `proposal.status !== 'aplicada'` against a wire that answers `'applied'`,
 * killed EVERY real run on the third statement, with the ironic message `only an
 * applied proposal has an experiment to close; this one is "applied"`.
 *
 * So the fake is removed the same way `proposal.e2e.test.ts` removes it: a real
 * control plane on a throwaway database, a real proposal taken through
 * create → approve → apply, real telemetry, and the command spawned as a CHILD
 * PROCESS. Nothing in this process can reach into it — the credential travels on
 * the command line, because a child cannot inherit a patched `globalThis.fetch`,
 * and that is exactly what makes the assertion honest.
 *
 * Two scenarios, which are the two halves of the same gate:
 *
 * - **AT-a** — a round that really ran under the applied version closes: exit 0,
 *   the report naming the `applied_version_id`, and an outcome the control plane
 *   computed. The proposal is read back afterwards, because a report is a claim
 *   and the book is the fact.
 * - **AT-b** — a round that ran under some OTHER version does not: the join that
 *   proves "this is the next round" fires in the script, by name, instead of
 *   arriving as a `422` from the route or — as it did before t285 — silently
 *   comparing `undefined < 1` on a field the wire never carried.
 *
 * Each scenario boots its own control plane. Applying a proposal moves the
 * graph's current version, so a second proposal over the same graph would be
 * `stale_proposal`: sharing one database between the two would mean ordering
 * them, and an ordering dependency between acceptance tests is a fixture nobody
 * can read.
 *
 * English per D18; the graph fixture's node ids, the frozen hypothesis body
 * (`execucao_id`, `depois`) and the metric's own keys (`nome`, `direcao`, `de`,
 * `para`) stay Portuguese — see `no-portuguese-wire.test.ts`'s header for which
 * decision freezes each.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { bootCore, resolvePins } from '@cartografo/test-support';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SCRIPT_PATH = path.join(PACKAGE_ROOT, 'scripts', 'close-surveyor-outcome.mjs');
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

/** The round the hypothesis is closed against. */
const EXECUTION_ID = 2850;

/**
 * Slack between two timestamps of the seeded telemetry.
 *
 * `occurred_at` has millisecond resolution, so two writes in the same tick
 * produce a zero interval — a number, and the wrong one to prove a measurement
 * with. Same device, and the same reason, as `proposal.e2e.test.ts`.
 */
const GAP_MS = 25;

/**
 * The node the hypothesis names, and the measure it names on it.
 *
 * `revisar` is the gate of `graph-valid-minimal.json`, which is where the seed
 * below puts the session — so `measureForExpectedMetric` resolves this name to a
 * real interval rather than to the `0` of a node that never ran.
 */
const METRIC_NAME = 'total_ms:revisar';

/** A control plane of this test's own, and the credential it minted. */
interface ControlPlane {
  baseUrl: string;
  token: string;
}

interface GraphVersion {
  id: string;
  graph_id: string;
}

interface Job {
  id: number;
}

interface Session {
  id: number;
}

/** A proposal, in the shape `toProposal` publishes (`routes/proposals.ts`). */
interface Proposal {
  id: number;
  graph_id: string;
  status: string;
  applied_version_id: string | null;
  result: unknown;
}

/** Talks JSON with the control plane, presenting the credential and asserting the status. */
async function api<T>(
  plane: ControlPlane,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${plane.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${plane.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** A well-formed semantic diff over the minimal graph, with its own inverse. */
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

/** The base graph, plus the proposal that was written, approved and applied over it. */
interface AppliedFixture {
  /** The version the graph was born on — the one the proposal targets. */
  targetVersion: GraphVersion;
  /** The version applying the proposal produced: the graph of the NEXT round. */
  appliedVersionId: string;
  proposalId: number;
}

/**
 * Takes one proposal all the way through the human gate, on a fresh graph.
 *
 * Three calls and not one, deliberately: approving and applying are two separate
 * acts (README, principle 5), and a fixture that collapsed them would be proving
 * the cycle against a shortcut the API does not have.
 *
 * @param plane Where to write it.
 * @returns The two versions and the applied proposal's id.
 */
async function applyOneProposal(plane: ControlPlane): Promise<AppliedFixture> {
  // A resolvable capability per node, or the version is stored `unchecked` and
  // `seedRound` below could not create a single job against it (t283). Same call,
  // over this same fixture, as `proposal.e2e.test.ts`.
  const document = await resolvePins(
    plane.baseUrl,
    plane.token,
    JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>,
  );
  const { graph_version: targetVersion } = await api<{ graph_version: GraphVersion }>(
    plane,
    'POST',
    '/v1/graphs',
    document,
    201,
  );

  const created = await api<{ proposal: Proposal }>(
    plane,
    'POST',
    '/v1/proposals',
    {
      graph_id: targetVersion.graph_id,
      target_version: targetVersion.id,
      operations: VALID_OPERATIONS,
      evidence: { lens: 'fluxo', execution_id: EXECUTION_ID, event_ids: [] },
      // The frozen hypothesis vocabulary, which D20 leaves alone: the KEY is
      // `expected_metric`, what is inside it is `domain/hypothesis.ts`'s.
      expected_metric: { nome: METRIC_NAME, direcao: 'cai', de: 1000, para: 500 },
    },
    201,
  );

  await api(plane, 'POST', `/v1/proposals/${created.proposal.id}/approve`);
  const applied = await api<{ proposal: Proposal }>(
    plane,
    'POST',
    `/v1/proposals/${created.proposal.id}/apply`,
  );

  assert.equal(applied.proposal.status, 'applied', 'the fixture has to reach applied to be closable');
  const appliedVersionId = applied.proposal.applied_version_id;
  assert.equal(typeof appliedVersionId, 'string', 'applying writes the version it produced');
  assert.notEqual(appliedVersionId, targetVersion.id, 'and it is a NEW version, not the target');

  return { targetVersion, appliedVersionId: appliedVersionId as string, proposalId: created.proposal.id };
}

/**
 * Seeds one round of telemetry under a given version.
 *
 * A job that crosses to `revisar` and a session that runs there, so the fold of
 * `calculateFlowMetrics` finds a real interval on the node {@link METRIC_NAME}
 * names. Every timestamp comes from the control plane's own clock.
 *
 * @param plane Where to write it.
 * @param versionId The graph version the round declares — the whole point of the
 *   join this ticket is about.
 */
async function seedRound(plane: ControlPlane, versionId: string): Promise<void> {
  const job = await api<Job>(
    plane,
    'POST',
    '/v1/jobs',
    {
      title: 'the round after the proposal',
      entry_node_id: 'redigir',
      execution_id: EXECUTION_ID,
      graph_version_id: versionId,
    },
    201,
  );

  await api(plane, 'POST', `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' });
  await delay(GAP_MS);

  const session = await api<Session>(
    plane,
    'POST',
    '/v1/sessions',
    {
      job_id: job.id,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revise a nota',
    },
    201,
  );
  await delay(GAP_MS);

  await api(plane, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
  });
}

/** Runs the real script and gives back what a shell would see. */
function runCloseOutcome(
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  assert.ok(
    existsSync(SCRIPT_PATH),
    'artifact does not exist yet: packages/runner/scripts/close-surveyor-outcome.mjs',
  );

  const result = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    // A credential exported by whoever runs the suite must not decide the
    // outcome of a test about what this command presents.
    env: { ...process.env, CARTOGRAFO_TOKEN: '' },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('t285 AT-a — a round that ran under the applied version closes the experiment', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);
  const plane: ControlPlane = { baseUrl, token };

  const { appliedVersionId, proposalId } = await applyOneProposal(plane);
  await seedRound(plane, appliedVersionId);

  const result = runCloseOutcome([
    String(proposalId),
    String(EXECUTION_ID),
    plane.baseUrl,
    '--token',
    plane.token,
  ]);

  assert.equal(
    result.status,
    0,
    `a genuine next round closes with a 0:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  // Asserted over the REPORT BLOCK and not over the whole of stdout: the log
  // lines above it name the applied version too, so a search of the whole
  // output would find the id whether or not the line meant to print it does.
  const marker = '===== outcome =====';
  const start = result.stdout.indexOf(marker);
  assert.notEqual(start, -1, `the command printed no report at all:\n${result.stdout}`);
  const report = result.stdout.slice(start, result.stdout.indexOf('===================', start + 1));

  assert.ok(
    report.includes(appliedVersionId),
    `the report has to name the applied_version_id it closed against:\n${report}`,
  );
  const outcomeLine = report.split('\n').find((line) => line.startsWith('outcome:'));
  assert.ok(outcomeLine !== undefined, `the report has to carry an outcome line:\n${report}`);
  assert.ok(
    !/^outcome:\s*(null|undefined)\s*$/.test(outcomeLine),
    `the outcome the control plane computed is not null:\n${report}`,
  );
  assert.ok(
    !result.stdout.includes('undefined'),
    `a field the answer does not carry reads as "undefined":\n${result.stdout}`,
  );

  // The report is a claim; the book is the fact.
  const { proposal } = await api<{ proposal: Proposal }>(plane, 'GET', `/v1/proposals/${proposalId}`);
  assert.notEqual(proposal.result, null, 'the control plane recorded a verdict for this hypothesis');
  assert.equal(proposal.applied_version_id, appliedVersionId);
});

test('t285 AT-b — a round under another version is refused, by name, before the route sees it', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);
  const plane: ControlPlane = { baseUrl, token };

  const { targetVersion, appliedVersionId, proposalId } = await applyOneProposal(plane);
  // The round runs under the version the proposal REPLACED: telemetry exists,
  // and none of it belongs to the change being measured.
  await seedRound(plane, targetVersion.id);

  const result = runCloseOutcome([
    String(proposalId),
    String(EXECUTION_ID),
    plane.baseUrl,
    '--token',
    plane.token,
  ]);

  assert.notEqual(
    result.status,
    0,
    `closing against the wrong round is a failure:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(
    result.stderr.includes('not the round that follows the proposal'),
    `the gate has to name what is wrong:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  // ...and it fired BEFORE the write: nothing was closed.
  const { proposal } = await api<{ proposal: Proposal }>(plane, 'GET', `/v1/proposals/${proposalId}`);
  assert.equal(proposal.result, null, 'a refused close leaves the hypothesis open');
  assert.equal(proposal.applied_version_id, appliedVersionId);
});

/** The refusal `POST /v1/jobs` answers for a version nobody contract-checked (t283). */
interface JobRefusal {
  error: string;
  graph_version_id?: string;
  contracts?: { state: string; problems: Array<{ code: string; node_id: string }> };
}

/** A registered version, read for the contract state the route stamped on it. */
interface CheckedVersion extends GraphVersion {
  contracts: { state: string };
}

test('t288 — the raw fixture is stored unchecked, and every job named on it is refused', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);
  const plane: ControlPlane = { baseUrl, token };

  // Deliberately WITHOUT `resolvePins`: this is exactly the shape
  // `applyOneProposal` had until t288, and the two assertions below are the whole
  // of what it cost — AT-a and AT-b red on `main` for six days, over a 409 raised
  // three calls away from the line that caused it.
  //
  // The pins of `graph-valid-minimal.json` are namespaced (`cartografo/…`) and
  // the registry's `id` is kebab-case, so they can never resolve on their own:
  // registering this document raw is not a mistake the fixture can outgrow, it
  // is the fixture's permanent state. Which is why the guard lives HERE, in the
  // file a future editor of that setup has open, and not in `test-support` or
  // `packages/core` — dropping the call again trips this, by name, first.
  const raw: unknown = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8'));
  const { graph_version: version } = await api<{ graph_version: CheckedVersion }>(
    plane,
    'POST',
    '/v1/graphs',
    raw,
    201,
  );
  assert.equal(
    version.contracts.state,
    'unchecked',
    'nothing the raw fixture pins resolves, so the contract check stands aside',
  );

  const refusal = await api<JobRefusal>(
    plane,
    'POST',
    '/v1/jobs',
    {
      title: 'a round against a graph nobody checked',
      entry_node_id: 'redigir',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
    },
    409,
  );

  assert.equal(refusal.error, 'graph_version_unchecked');
  assert.equal(refusal.graph_version_id, version.id, 'the refusal names the version it is about');
  assert.deepEqual(
    (refusal.contracts?.problems ?? [])
      .filter((problem) => problem.code === 'skill_ref_unresolved')
      .map((problem) => problem.node_id),
    ['redigir', 'revisar'],
    'and the pins to register — which is the sentence this test exists to hand the next reader',
  );
});
