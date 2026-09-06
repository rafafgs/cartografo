/**
 * The B3 flow radar factory bundle, crossed LIVE (t407).
 *
 * `factory-graphs/b3-flow-radar` (RF-13, t406) has been contract-proven since
 * the day it shipped — the graph is sound, all seven manifests validate, every
 * pin closes, and `tests/factory-graph-3.test.mjs`'s AT13 walks the real
 * payloads of `tests/fixtures/b3-flow-radar-crossing.fixture.json` against each
 * other's schemas. None of that ever opened a control plane. This file is the
 * same follow-up bundles 1 and 2 got in `factory-graph-software.e2e.test.ts`
 * (t259, t270, t273) and `factory-graph-bets.e2e.test.ts` (t260, t276): the
 * seven documents registered VERBATIM, a real `Controller` taking real leases,
 * and one tick per node from `check-intake` to `scorecard` with nothing faked
 * but the agent engine.
 *
 * ## What makes this bundle's crossing different from the other two
 *
 * Its `initial_node` is not a session. `check-intake` declares
 * `"engine": "shell"` and its pinned skill carries a `command` block, so what
 * runs on the first node is `factory-graphs/b3-flow-radar/scripts/check-intake.mjs`
 * itself — no model, no tokens, no prompt. t332 already proved a `shell` node
 * can open, run and route inside a real traversal
 * (`shell-node-traversal.e2e.test.ts`), but it proved it with a THROWAWAY skill
 * whose `command.argv` was rewritten to an absolute path into this package's own
 * fixtures. A registration that rewrote anything would not be this bundle
 * crossing; it would be a copy of it crossing.
 *
 * So the argv here is the shipped one, relative and untouched:
 *
 * ```
 * node factory-graphs/b3-flow-radar/scripts/check-intake.mjs \
 *   {{input.trading_day}} {{input.project.expected_row_counts}}
 * ```
 *
 * A relative argv only resolves against the session's working directory, and
 * `ShellAdapter` spawns with `cwd: spec.workingDir` and enforces nothing else
 * about what that directory holds (its own invariant 7). The bundle's README
 * says out loud what that implies for this class — "a job of this class has the
 * cartografo checkout as its working directory, because that is where the data
 * is" (recorded divergences #1 and #4) — and no other e2e in this package has
 * ever pointed a spawned child at the live tree it is running inside, for the
 * same reason `benchRepository()` builds a disposable real git checkout in the
 * software crossing rather than borrowing one.
 *
 * `test/fixtures/b3-flow-radar-check-intake.mjs` is that disposable checkout for
 * this one node: a real, detached worktree of this repository, released in
 * `t.after`. The real script therefore reads the real
 * `factory-graphs/b3-flow-radar/fixtures/day-1/*.json` — real rows, real counts
 * — and the live working tree stays out of reach of a process this test spawned.
 * The other six nodes get the bare per-session directory every sibling e2e hands
 * out, because a session that only reads its prompt has no repository to be in.
 *
 * ## What is scripted, and what is not
 *
 * Nothing about `check-intake` is scripted: its report is whatever the command
 * printed, and the assertion holds it against the crossing fixture's own
 * `check-intake.output`. The one thing that CANNOT match byte for byte is
 * `fixture.paths` — the fixture records them relative, because a committed
 * document cannot know where a checkout will be, and the script resolves them
 * absolute against its working directory. Rebasing the fixture's four relative
 * paths onto the disposable checkout is therefore not a weakening of the claim
 * but the sharp form of it: it is what proves the relative argv resolved
 * against THAT directory and read THOSE files.
 *
 * The six agent nodes reply with their own payload from the same crossing
 * fixture, plus the routing label the fixture keeps separately in
 * `expected_edges` (`advance` at `triage`, `survives` at `red-team`) because the
 * label rides inside the one block a session prints (t161, t259) and the fixture
 * frames the contracts rather than the protocol. `scorecard` is the single
 * exception: the crossing fixture stops at `compose-brief` and carries no
 * payload for the final node, so its report is composed here — derived from what
 * the earlier nodes really reported, never typed as a constant.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ControlPlaneClient } from '../../src/controller/control-plane-client.ts';
import { Controller } from '../../src/controller/controller.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import {
  decodeClaudeCodeSessionText,
  decodeShellSessionText,
} from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { ShellAdapter } from '../../src/engine/shell-adapter.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'factory-graphs', 'b3-flow-radar');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/**
 * The helper that lends `check-intake` a real, disposable checkout.
 *
 * A program and not an imported module, which is the convention every `.mjs`
 * under `test/fixtures/` already follows (`fake-engine.mjs`, `shell-node.mjs`)
 * and which this package's `tsc --noEmit` gate also requires: `allowJs` is off,
 * so an untyped `.mjs` on an `import` line is a typecheck error, while a
 * subprocess with a two-verb CLI is exactly what the siblings are.
 */
const CHECKOUT_FIXTURE = fileURLToPath(
  new URL('../fixtures/b3-flow-radar-check-intake.mjs', import.meta.url),
);

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 4070;

/** The seven manifests the graph's nodes pin, in document order. */
const MANIFESTS = Object.freeze([
  'check-flow-intake.json',
  'triage-flow-signals.json',
  'contextualize-flow-signals.json',
  'hypothesize-flow-driver.json',
  'red-team-flow-hypothesis.json',
  'compose-flow-brief.json',
  'record-flow-scorecard.json',
]);

/** The one path through the graph this crossing takes, in order. */
const CHAIN = Object.freeze([
  'check-intake',
  'triage',
  'contextualize',
  'hypothesize',
  'red-team',
  'compose-brief',
  'scorecard',
]);

/** The four fixture files of a day, in the spelling the report keys them by. */
const FIXTURE_FILE_KEYS = Object.freeze(['daily_figures', 'broker_flow', 'signals', 'facts']);

interface Work {
  id: number;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  /** The traveller arrived: its node is a final node of the version (t152, t262). */
  completed: boolean;
}

interface SessionRecord {
  node_id: string | null;
  engine: string;
  status: string;
  exit_code: number | null;
  output: Record<string, unknown> | null;
}

interface Event {
  type: string;
  actor: { type: string; ref: string };
  data: Record<string, unknown>;
}

/** One node's leg of the offline contract proof. */
interface CrossingStep {
  node: string;
  output: Record<string, unknown>;
}

/** `tests/fixtures/b3-flow-radar-crossing.fixture.json`, in the two keys read here. */
interface CrossingFixture {
  expected_edges: Record<string, string>;
  crossing: CrossingStep[];
}

/** Every call THIS TEST makes, so the "no operator" claim can be asserted (FR10). */
const testCalls: string[] = [];

/** Talks JSON with the control plane, asserting the status on the way. */
async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  testCalls.push(`${method} ${route}`);
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Reads one committed file of the bundle. */
function bundleFile(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(BUNDLE, ...segments), 'utf8')) as Record<
    string,
    unknown
  >;
}

/**
 * The offline contract proof's own payloads, read and never retyped.
 *
 * The same discipline the bets crossing takes with `graph.json`'s `project`: a
 * copy here would keep passing the day the fixture that AT13 walks changed
 * underneath it, and the whole point of this file is that the two proofs are
 * about the same crossing.
 */
const CROSSING = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'b3-flow-radar-crossing.fixture.json'), 'utf8'),
) as CrossingFixture;

/** What the offline proof records one node reporting. */
function reportOf(nodeId: string): Record<string, unknown> {
  const step = CROSSING.crossing.find((entry) => entry.node === nodeId);
  assert.ok(step !== undefined, `the crossing fixture carries no leg for "${nodeId}"`);
  return step.output;
}

/**
 * ...and what its SESSION says, which is the report plus the edge it took.
 *
 * The fixture keeps the routing label out of the payloads on purpose — it
 * proves contracts, and the label is the protocol's — while a live session
 * carries it INSIDE the one block it prints (t161, t259). The two gates on this
 * path are the two entries `expected_edges` has for them, so the label is read
 * from the fixture rather than chosen here.
 */
function scriptedReport(nodeId: string): Record<string, unknown> {
  const edge = CROSSING.expected_edges[nodeId];
  return edge === undefined ? reportOf(nodeId) : { ...reportOf(nodeId), resultado: edge };
}

/** The lines a fake session prints to report the object its node declares. */
function reports(payload: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'I did what the node asked for.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify(payload) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** A list of objects, counted — the two metrics `scorecard` recomputes. */
function count(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  assert.ok(Array.isArray(value), `"${key}" is not a list in the crossing fixture`);
  return value.length;
}

/**
 * What the final node reports, derived from what the crossing really produced.
 *
 * The one payload the offline fixture does not carry: its `crossing` array stops
 * at `compose-brief`, because the four ways this graph can end are proven by
 * AT5/AT14 against the graph document rather than walked. Everything numeric
 * below is read back off the earlier legs, so a fixture that changed its triage
 * would change this too instead of leaving a stale constant behind.
 */
function scorecardReport(): Record<string, unknown> {
  return {
    process_metrics: {
      intake_passed: true,
      signals_triaged_count: count(reportOf('triage'), 'triaged_signals'),
      red_team_ran: true,
      final_outcome: 'published',
      unanswered_high_objections: 0,
      hypotheses_count: count(reportOf('hypothesize'), 'hypotheses'),
      nodes_executed: CHAIN.slice(0, -1),
    },
    record: {
      trading_day: 'day-1',
      summary:
        'The day passed the intake, one signal of eighteen cleared the triage, was contextualized, ' +
        'explained, attacked and published with the objection it did not close.',
      what_to_watch: ['whether the index-portfolio turn absorbs the volume the next session'],
    },
    note: 'A published crossing: all seven nodes of the graph ran, the first of them as a command.',
  };
}

/**
 * A disposable, real checkout of this repository, for `check-intake` alone.
 *
 * @param t The test, so the checkout is released whatever happens.
 * @returns The absolute path of the checkout, symlinks already resolved.
 */
function checkIntakeCheckout(t: { after: (fn: () => void) => void }): string {
  assert.ok(
    existsSync(CHECKOUT_FIXTURE),
    'artifact does not exist yet: packages/runner/test/fixtures/b3-flow-radar-check-intake.mjs',
  );
  const prepared = execFileSync(process.execPath, [CHECKOUT_FIXTURE, 'prepare'], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  const { path: checkout } = JSON.parse(prepared) as { path: string };

  t.after(() => {
    execFileSync(process.execPath, [CHECKOUT_FIXTURE, 'release', checkout], { stdio: 'pipe' });
  });
  return checkout;
}

/**
 * Where each session works.
 *
 * `check-intake` gets the real checkout, because its pinned argv is relative and
 * has a real script to find; every other node gets the bare per-session
 * directory the sibling e2e tests hand out, because a session that only reads
 * its prompt has nothing to look for on disk. `acquire` is told which node by
 * the crossing itself — the manager's own signature carries only the job id.
 */
function worktreesFor(root: string, checkout: string, nodeNow: () => string): WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      if (nodeNow() === 'check-intake') {
        return Promise.resolve({ path: checkout, branch: 'b3-flow-radar-check-intake' });
      }
      serial += 1;
      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `crossing-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

test('t407 — the B3 flow radar bundle crosses all seven nodes, the first of them a command', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t407-factory-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const checkout = checkIntakeCheckout(t);

  // --- AT1. the seven real manifests and the real graph, verbatim -----------
  for (const file of MANIFESTS) {
    await api(baseUrl, token, 'POST', '/v1/skills', bundleFile('skills', file), 201);
  }

  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
    baseUrl,
    token,
    'POST',
    '/v1/graphs',
    bundleFile('graph.json'),
    201,
  );

  // --- AT2. the job the bundle's own demo describes -------------------------
  const demo = bundleFile('demo', 'job.json');
  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: demo.title,
      body: demo.body,
      entry_node_id: demo.entry_node_id,
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
      fields: demo.fields,
    },
    201,
  );
  assert.equal(job.current_node_id, 'check-intake', 'the demo job opens on the graph`s entry node');

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t407-factory', 'the one that crosses the flow radar bundle');

  let currentNode = CHAIN[0];
  let currentLines = '[]';
  const worktrees = worktreesFor(root, checkout, () => currentNode);
  const controller = new Controller({
    client,
    runnerId: 'runner-t407-factory',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput` and no executor environment: this bundle needs neither,
    // and the production default is what the crossing proves.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: {
          // No seam at all on this route: what runs is the argv the registered
          // manifest declared, spawned by the real adapter in the checkout.
          shell: {
            adapter: new ShellAdapter({ graceMs: 300 }),
            decodeSessionText: decodeShellSessionText,
          },
          'claude-code': {
            adapter: new ClaudeCodeAdapter({
              commandBuilder: (spec) => ({
                command: process.execPath,
                args: [FAKE_ENGINE, ...buildCommand(spec).args],
              }),
              graceMs: 300,
            }),
            decodeSessionText: decodeClaudeCodeSessionText,
          },
        },
        worktrees,
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: currentLines },
      })(jobId),
  });

  const jobNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${String(job.id)}`);

  const contextNow = async (): Promise<Record<string, unknown>> =>
    (
      await api<{ input: Record<string, unknown> }>(
        baseUrl,
        token,
        'GET',
        `/v1/jobs/${String(job.id)}/context`,
      )
    ).input;

  const sessionsNow = async (): Promise<SessionRecord[]> =>
    (
      await api<{ sessions: SessionRecord[] }>(
        baseUrl,
        token,
        'GET',
        `/v1/sessions?job_id=${String(job.id)}`,
      )
    ).sessions;

  /** Dispatches the node the job is standing on, with what its session says. */
  const run = async (nodeId: string, lines: string): Promise<void> => {
    currentNode = nodeId;
    currentLines = lines;
    assert.ok(await controller.tick(), `"${nodeId}" was not picked up by the runner`);
  };

  /** The job after a tick, asserted to be moving rather than stuck. */
  const advanced = async (to: string): Promise<Work> => {
    const now = await jobNow();
    assert.equal(now.blocked, false, `the crossing blocked before "${to}": ${now.block_reason ?? ''}`);
    assert.equal(now.current_node_id, to);
    return now;
  };

  // --- AT3. the entry node is a command, and it moves the job ---------------
  await run('check-intake', '[]');
  await advanced('triage');

  // The four paths the fixture records relative — a committed document cannot
  // know where a checkout will be — rebased onto the one the command really ran
  // in. Everything else, `row_counts` and the `note` included, is the fixture's
  // own text: what the real script printed against the real day-1 files.
  const intake = reportOf('check-intake');
  const declared = (intake.fixture as { paths: Record<string, string> }).paths;
  const expectedIntake = {
    ...intake,
    fixture: {
      ...(intake.fixture as Record<string, unknown>),
      paths: Object.fromEntries(
        FIXTURE_FILE_KEYS.map((key) => [key, path.join(checkout, declared[key] ?? '')]),
      ),
    },
  };

  const intakeSession = (await sessionsNow()).find((session) => session.node_id === 'check-intake');
  assert.ok(intakeSession !== undefined, 'the deterministic node opened a session row of its own');
  assert.equal(intakeSession.engine, 'shell');
  assert.equal(intakeSession.status, 'completed');
  assert.equal(intakeSession.exit_code, 0);
  assert.deepEqual(
    intakeSession.output,
    expectedIntake,
    'the pinned skill`s own relative argv resolved against the checkout and read the real day-1 ' +
      'files: what /finish held against the pinned output schema is the script`s real report',
  );

  // --- AT4. ...and the projection carries it to every node after it ---------
  assert.deepEqual((await contextNow()).fixture, expectedIntake.fixture);

  // --- AT5. the six agent nodes, one tick each ------------------------------
  await run('triage', reports(scriptedReport('triage')));
  await advanced('contextualize');
  assert.deepEqual(
    (await contextNow()).triaged_signals,
    reportOf('triage').triaged_signals,
    'a report the pinned `output` refused would be `null` here, and `contextualize` requires it',
  );

  await run('contextualize', reports(scriptedReport('contextualize')));
  await advanced('hypothesize');
  assert.deepEqual((await contextNow()).context, reportOf('contextualize').context);

  await run('hypothesize', reports(scriptedReport('hypothesize')));
  await advanced('red-team');
  assert.deepEqual((await contextNow()).hypotheses, reportOf('hypothesize').hypotheses);

  await run('red-team', reports(scriptedReport('red-team')));
  await advanced('compose-brief');
  const beforeTheBrief = await contextNow();
  assert.deepEqual(beforeTheBrief.objections, reportOf('red-team').objections);
  assert.deepEqual(beforeTheBrief.counter_evidence, reportOf('red-team').counter_evidence);

  await run('compose-brief', reports(scriptedReport('compose-brief')));
  await advanced('scorecard');
  const beforeTheScorecard = await contextNow();
  assert.deepEqual(beforeTheScorecard.brief, reportOf('compose-brief').brief);
  assert.deepEqual(
    beforeTheScorecard.fixture,
    expectedIntake.fixture,
    'the fixture the FIRST node established is still what the LAST one reads, six nodes later',
  );

  // --- AT6. the last node reports, and the traversal is over ----------------
  await run('scorecard', reports(scorecardReport()));
  const closed = await jobNow();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.current_node_id, 'scorecard');
  assert.equal(closed.completed, true, 'the traversal is over: the final node reported');

  // --- AT7. one crossing, two engines, six model sessions -------------------
  const engines = (await sessionsNow()).map((session) => `${session.node_id ?? ''}:${session.engine}`);
  assert.deepEqual(
    engines.slice().sort(),
    [
      'check-intake:shell',
      'compose-brief:claude-code',
      'contextualize:claude-code',
      'hypothesize:claude-code',
      'red-team:claude-code',
      'scorecard:claude-code',
      'triage:claude-code',
    ],
    'seven sessions, and the one node that counts rows in four files spent no model at all',
  );

  // --- AT8. and NOTHING above was moved by hand -----------------------------
  assert.deepEqual(
    testCalls.filter(
      (call) =>
        call.endsWith('/transitions') ||
        call.endsWith('/unblocks') ||
        /^PATCH \/v1\/jobs\/\d+$/.test(call),
    ),
    [],
    'the test — standing in for the operator — posted no transition, patched no job and unblocked nothing',
  );

  // --- AT9. the log tells the six edges, and the runner is who took them ----
  const { events } = await api<{ events: Event[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/executions/${String(EXECUTION_ID)}/events`,
  );
  const moves = events.filter((event) => event.type === 'job.transitioned');
  assert.deepEqual(moves.map((event) => String(event.data.to_node_id)), CHAIN.slice(1));
  assert.deepEqual(
    [...new Set(moves.map((event) => `${event.actor.type}:${event.actor.ref}`))],
    ['system:runner'],
  );
});
