/**
 * The asymmetric-bets factory bundle, crossed LIVE (t260).
 *
 * `factory-graphs/asymmetric-bets` has been contract-proven since t116 —
 * the graph is sound, every one of the seven manifests validates, every pin
 * closes, and `tests/factory-graph-2.test.mjs`'s AT11 walks a real thesis from
 * `triage` to `decide` payload by payload. None of that ever opened a session.
 *
 * t259 found and fixed the same class of bug one bundle over: the manifests
 * named an input vocabulary nobody assembles. The bets bundle was left alone on
 * the premise that its nodes already agree at the top level, which is true from
 * `collect-fundamentals` onward — every later manifest reads
 * `{{input.triaged_thesis.*}}`, and `triage`'s report merges at the top level
 * because no node of this graph declares `contract.produces`. It was false for
 * the entry node itself: `triar-tese` (`triage-thesis` since t293) read
 * `{{input.tese.titulo}}`, `{{input.tese.ativo}}`, `{{input.tese.hipotese}}` and
 * `{{input.criterios_de_triagem}}`, and the projection
 * (`packages/core/src/domain/context.ts`) publishes none of them — `input.job`
 * carries the work's identity, `input.project` the class's static config, and a
 * class field is a flat scalar at the top level. So the first node of this graph
 * could not dispatch at all: `UnresolvedPlaceholderError` before a session ever
 * existed.
 *
 * What this test asserts is the repair, with nothing faked but the engine:
 * `triage` → `collect-fundamentals` crosses on its own, the entry prompt carries
 * the job's own title and body, the asset the class field declares and the
 * criteria the graph's `project` publishes, and the thesis the gate triaged
 * reaches the researcher's prompt where `{{input.triaged_thesis.*}}` used to be.
 *
 * English per D18, and since t293 the bundle's own vocabulary too: node ids,
 * edge labels, skill ids and payload keys are all English here. What is still
 * Portuguese is the thesis itself — title, hypothesis, objections, notes — which
 * is the language this worked example was written in, plus the projection root
 * `perguntas_respondidas` and the reserved routing key `resultado`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ControlPlaneClient } from '../../src/controller/control-plane-client.ts';
import { Controller } from '../../src/controller/controller.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'factory-graphs', 'asymmetric-bets');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 2601;

/** The seven manifests the graph's nodes pin, in document order. */
const MANIFESTS = Object.freeze([
  'triage-thesis.json',
  'collect-fundamentals.json',
  'analyze-asymmetry.json',
  'red-team-thesis.json',
  'size-risk.json',
  'escalate-decision.json',
  'record-crossing.json',
]);

interface Work {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  /** The traveller arrived: its node is a final node of the version (t152, t262). */
  completed: boolean;
}

/** The sidecar the fake engine writes with everything the process received. */
interface FakeRecord {
  argv: string[];
}

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

/** One directory per session, the isolation every e2e in this package uses. */
function directoryWorktrees(root: string): WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      serial += 1;
      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `thesis-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/**
 * The lines a fake session prints to report the object its node's
 * `output_schema` declares.
 *
 * One block and nothing else, which is what the rendered instructions ask for
 * (t259, FR3). The payloads below are the REAL schemas of the real manifests: a
 * report the skill's `output` refuses is stored as `null`
 * (`packages/core/src/repositories/session.ts`), and the node after it would
 * find nothing to resolve against.
 */
function reports(payload: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'I did what the node asked for.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify(payload) },
    { stream: 'stdout', text: '```' },
  ]);
}

/**
 * The class's static config, read off the graph itself.
 *
 * Read and never retyped: `input.project` IS this object, and a copy in the
 * test would keep passing the day the bundle's own config moved.
 */
const PROJECT = bundleFile('graph.json').project as Record<string, unknown>;

/** The asset, which is a class field of this graph and not part of the job. */
const ASSET = 'NVLR3';

/** ...and where the central premise came from, the field `triage` demands. */
const PREMISE_SOURCE = 'fato relevante de 2026-07-30, arquivado no regulador';

/** ...and how big a position is being asked for, the third field it demands (t263). */
const INTENDED_SIZE = 1.5;

const TITLE = 'Navelar Logistics (NVLR3) — repricing after the sale of the road haulage arm';
const BODY =
  'The market still prices Navelar as a low-margin road haulier. With the road ' +
  'haulage arm sold, what is left is a port operation with a long-term contract and ' +
  'net cash; the discount tends to disappear once the first pro-forma quarter is reported.';

/** What the fake `triage` session hands back — `triage-thesis`'s `output`. */
const TRIAGED_THESIS = {
  id: 'thesis-1',
  title: TITLE,
  asset: ASSET,
  hypothesis: BODY,
  research_scope: [
    'terms of the road haulage sale: price, form of payment and the liabilities that stay',
    'port contract: term, price-revision clause and customer concentration',
    'pro-forma cash and debt after the sale',
  ],
};
const TRIAGED = {
  // The routing label rides INSIDE the report, which is the one block a session
  // prints (t259) — `triage` has two ways out, `advance` and `discard`.
  resultado: 'advance',
  outcome: 'pass',
  triaged_thesis: TRIAGED_THESIS,
  evaluated_criteria: [
    {
      criterion: 'the downside is bounded by net cash or a real asset, not by a narrative',
      verdict: 'meets',
      evidence: 'The sale is fixed at BRL 1.2bn in cash against a market value of BRL 2.1bn.',
    },
  ],
  rationale: 'The idea has a contracted floor and a dated event: it deserves a research round.',
  note: 'Scope held to three fronts so the collection does not turn into endless reading.',
};

/** ...and the fake `collect-fundamentals` session — `collect-fundamentals`'s. */
const COLLECTED = {
  fundamentals: {
    summary: 'What is left is a port terminal with a take-or-pay contract to 2032 and net cash.',
    figures: [
      {
        metric: 'pro-forma net cash',
        value: 'BRL 0.9bn',
        period: 'pro-forma Q2 2026',
        source: 'Q2 2026 release, note 14',
      },
    ],
    known_risks: ['71% of revenue concentrated in a single shipper'],
  },
  assumptions: [
    {
      assumption: 'the take-or-pay contract is honoured through 2032',
      source: 'contract annex of the 2026 reference form',
      confidence: 'high',
    },
  ],
  gaps: ['no public document carries the contract price per tonne'],
  note: 'One assumption with a primary source; the price gap is recorded.',
};

test('t260 — triage → collect-fundamentals crosses the real bets bundle', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t260-factory-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

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

  // `fields` is the class's own vocabulary (t168): `asset`, `premise_source`
  // and `intended_size` are all demanded at `triage`, and the projection
  // spreads them at the TOP level of `input` — beside `input.job`, never inside
  // it.
  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: TITLE,
      body: BODY,
      entry_node_id: 'triage',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        intended_size: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t260-factory', 'the one that crosses the bets bundle');

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(TRIAGED);
  // One sidecar per node: the rendered instructions travel on the ARGV, not in
  // the session's `prompt` column (`session-spec.ts`). What the model was TOLD
  // is the argv.
  let currentRecord = path.join(root, 'triage.json');
  const controller = new Controller({
    client,
    runnerId: 'runner-t260-factory',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput`: the production default is what this crossing proves.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: {
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
        envOverrides: { FAKE_ENGINE_LINES: currentLines, FAKE_ENGINE_RECORD: currentRecord },
      })(jobId),
  });

  const jobNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`);

  /**
   * Everything the fake session of one node was told, as it received it.
   *
   * Whole, and not cut at the contract the way the software bundle's crossing
   * has to be: no document of THIS bundle carries a `{{input.…}}` token outside
   * a manifest body, so the "not one placeholder survives" claim can be made
   * over the entire text the session got.
   */
  const toldTo = (nodeId: string): string =>
    (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
      '\n',
    );

  // --- 1. `triage` dispatches at all, which is the whole of the repair -----
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterTriage = await jobNow();
  assert.equal(afterTriage.blocked, false, afterTriage.block_reason ?? '');
  assert.equal(afterTriage.current_node_id, 'collect-fundamentals');

  const triage = toldTo('triage');
  assert.ok(triage.includes(TITLE), 'the thesis title comes from `input.job.title`');
  assert.ok(triage.includes(BODY), 'and the hypothesis from `input.job.body`');
  assert.ok(triage.includes(ASSET), 'and the asset from the class field at the top level');
  assert.ok(
    triage.includes(JSON.stringify(PROJECT.triage_criteria)),
    "and the investor's criteria from `input.project`",
  );
  assert.ok(!triage.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 2. what `triage` triaged is what `collect-fundamentals` reads ---------
  currentLines = reports(COLLECTED);
  currentRecord = path.join(root, 'collect-fundamentals.json');
  assert.ok(await controller.tick());
  const afterCollect = await jobNow();
  assert.equal(afterCollect.blocked, false, afterCollect.block_reason ?? '');
  assert.equal(afterCollect.current_node_id, 'analyze-asymmetry');

  const collect = toldTo('collect-fundamentals');
  assert.ok(
    collect.includes(TRIAGED_THESIS.hypothesis),
    'the thesis the gate triaged is what `{{input.triaged_thesis.hypothesis}}` resolves to',
  );
  assert.ok(
    collect.includes(JSON.stringify(TRIAGED_THESIS.research_scope)),
    '...and the research scope it defined is what the researcher is pointed at',
  );
  assert.ok(!collect.includes('{{input.'));

  // --- 3. the projection carries the report at the TOP level ---------------
  // No node of this graph declares `contract.produces`, so every report merges
  // where the next node's manifest expects to find it.
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.deepEqual(input.triaged_thesis, TRIAGED_THESIS);
  assert.equal(input.asset, ASSET, 'the class field sits beside `input.job`, not inside it');
  assert.deepEqual(input.project, PROJECT);
});

/* -------------------------------------------------------------------------- */
/* t270 Half A — the shortest crossing of this bundle, end to end.             */
/*                                                                            */
/* `triage` has two ways out and `discard` is the cheap one: it goes          */
/* straight to `record-monitoring`, which is the only final node of the   */
/* graph and the one node that reads the traversal itself. Before this ticket   */
/* that node could not open a session at all — `registrar-travessia` named     */
/* `{{input.nos_executados}}` and `{{input.data_de_registro}}`, nothing        */
/* produced either, and `UnresolvedPlaceholderError` stopped the dispatch      */
/* before a worktree existed. The second real bets crossing was unblocked by a */
/* person patching both into the job's `fields` by hand                        */
/* (`notes/2026-08-17-second-bets-run.md`, gap 5).                       */
/*                                                                            */
/* So the claim here is the repair AND the absence of the workaround: no       */
/* `PATCH /v1/jobs/:id`, no `POST /v1/jobs/:id/unblocks`, anywhere in the      */
/* body of this test.                                                         */
/* -------------------------------------------------------------------------- */

/** The execution the short crossing's telemetry lands in. */
const DISCARD_EXECUTION_ID = 2701;

/** What the fake `triage` session hands back when the idea does not pass. */
const DISCARDED = {
  resultado: 'discard',
  outcome: 'fail',
  triaged_thesis: { ...TRIAGED_THESIS, research_scope: [] },
  evaluated_criteria: [
    {
      criterion: 'the downside is bounded by net cash or a real asset, not by a narrative',
      verdict: 'does_not_meet',
      evidence: 'The claimed floor is a multiple projection, not a contracted asset.',
    },
  ],
  rationale: 'With no observable floor, the idea does not deserve a research round.',
  note: 'Discarded at the first filter; the crossing still produces a metric.',
};

/** ...and what `record-monitoring` reports — `record-crossing`'s `output`. */
const RECORDED = {
  process_metrics: {
    red_team_ran: false,
    sourced_assumptions_fraction: 0,
    human_decision_id: null,
    final_outcome: 'archived',
    nodes_executed: ['triage'],
  },
  record: {
    thesis_id: TRIAGED_THESIS.id,
    summary: 'The thesis was discarded at triage for having no observable floor.',
    monitoring: [],
  },
  note: 'Crossing closed by the shortest path through the graph.',
};

test('t270 — triage → record-monitoring closes the bets traversal on its own', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t270-factory-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

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

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: TITLE,
      body: BODY,
      entry_node_id: 'triage',
      execution_id: DISCARD_EXECUTION_ID,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        intended_size: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t270-factory', 'the one that closes the short bets crossing');

  /**
   * Every call the dispatch made, so the claim "no operator touched this" is
   * checked instead of merely intended.
   *
   * The two verbs that unstuck this crossing by hand are the two this records:
   * `PATCH /v1/jobs/:id` (the `fields` amendment that carried `nos_executados`)
   * and `POST /v1/jobs/:id/unblocks`.
   */
  const calls: string[] = [];
  const doFetch: typeof fetch = async (target, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(target).slice(baseUrl.length)}`);
    return await fetch(target, init);
  };

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(DISCARDED);
  let currentRecord = path.join(root, 'triage.json');
  const controller = new Controller({
    client,
    runnerId: 'runner-t270-factory',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput`, and no executor environment either: this bundle needs
    // neither, and the production default is what the crossing proves.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: {
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
        envOverrides: { FAKE_ENGINE_LINES: currentLines, FAKE_ENGINE_RECORD: currentRecord },
      })(jobId),
  });

  const jobNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`);

  const toldTo = (nodeId: string): string =>
    (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
      '\n',
    );

  // --- 1. the gate discards, and the job lands on the final node -----------
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterTriage = await jobNow();
  assert.equal(afterTriage.blocked, false, afterTriage.block_reason ?? '');
  assert.equal(afterTriage.current_node_id, 'record-monitoring');

  // --- 2. ...and the final node OPENS, which is the whole of the repair -----
  currentLines = reports(RECORDED);
  currentRecord = path.join(root, 'record-monitoring.json');
  assert.ok(await controller.tick(), 'the final node was picked up too');

  const closed = await jobNow();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.completed, true, 'the traversal is over: the report of the final node landed');

  const told = toldTo('record-monitoring');
  assert.ok(
    told.includes(JSON.stringify(['triage'])),
    '`{{input.traversal.nodes_visited}}` resolves to the one node this crossing executed — ' +
      'and NOT to `record-monitoring`, which is where the job is standing',
  );
  assert.ok(!told.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 3. and the projection says the same thing over the API --------------
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  const traversal = input.traversal as Record<string, unknown>;
  assert.deepEqual(traversal.nodes_visited, ['triage']);
  assert.equal(
    typeof traversal.entered_at,
    'string',
    'the date the session registers is a slice of this instant, never a guess',
  );

  // --- 4. and nobody had to touch it by hand ------------------------------
  assert.deepEqual(
    calls.filter((call) => call.endsWith('/unblocks') || /^PATCH \/v1\/jobs\/\d+$/.test(call)),
    [],
    'the crossing that was unblocked by a `PATCH /jobs/1` needs neither verb now',
  );
});

/* -------------------------------------------------------------------------- */
/* t276 — the LONG way across, through the two gates nothing had ever crossed. */
/*                                                                            */
/* `triage` learned in t260 that the routing label rides INSIDE the one block */
/* a session prints (t161, t259), and that a closed `output` which does not    */
/* declare `resultado` therefore refuses the WHOLE report — `PATCH /finish`    */
/* stores `null` and, since t268, the runner blocks the work on its node       */
/* instead of routing it. `red-team-thesis` and `escalate-decision` were left      */
/* exactly as they were, and no test of this repository had ever opened either */
/* node: the crossing above stops at `collect-fundamentals`, and the one after   */
/* it takes the `discard` shortcut. Both gates were broken in the same way    */
/* and nothing could see it.                                                   */
/*                                                                            */
/* So this is the whole graph, node by node: `advance` → the red team the     */
/* thesis survives → the sizing → the human gate, which pauses for a person    */
/* and resumes with the answer → the final node. The two workaround verbs stay */
/* out of it, the same way t270 keeps them out — answering the allocation      */
/* question is the DESIGN of `decide` (D14: the human gate is mandatory,      */
/* always), not an operator unsticking a traversal by hand.                    */
/* -------------------------------------------------------------------------- */

/** The execution the long crossing's telemetry lands in. */
const LONG_EXECUTION_ID = 2760;

/** ...and the one the red team's kill lands in. */
const KILL_EXECUTION_ID = 2761;

/** What the fake `analyze-asymmetry` session hands back. */
const MEASURED = {
  asymmetry: {
    downside_max_pct: 18,
    upside_target_pct: 95,
    asymmetry_ratio: 5.3,
    scenarios: [
      {
        name: 'the pro-forma comes out and the classification discount disappears',
        probability: 0.6,
        return_pct: 95,
        key_assumptions: ['the take-or-pay contract is honoured through 2032'],
      },
      {
        name: 'the shipper renegotiates the minimum volume and the floor shrinks',
        probability: 0.4,
        return_pct: -18,
        key_assumptions: ['the take-or-pay contract is honoured through 2032'],
      },
    ],
  },
  note: 'The floor comes from pro-forma net cash, not from the repricing narrative.',
};

/** ...and the fake `red-team` session, when the thesis answers the objection. */
const SURVIVED = {
  // Same protocol as `triage`: the label of the edge INSIDE the one block the
  // session prints. `red-team` has two ways out, `survives` and `dead`.
  resultado: 'survives',
  outcome: 'pass',
  objections: [
    {
      objection:
        'With 71% of revenue in a single shipper, the take-or-pay becomes counterparty risk: if it renegotiates, the contractual floor is no floor.',
      severity: 'high',
      thesis_answer:
        'The contract carries a bank guarantee of 18 months of revenue — clause 11 of the contract annex of the 2026 reference form.',
    },
    {
      objection:
        'The trigger date is the agent\'s choice: nothing forces the repricing to happen at the Q1 2027 release.',
      severity: 'low',
      thesis_answer: null,
    },
  ],
  researched_counter_evidence: [
    {
      claim_attacked: 'the take-or-pay contract is honoured through 2032',
      source: 'arbitragem 0021xxx, noticiada em 2025-11-04',
      finding:
        'The same shipper arbitrated a take-or-pay with another terminal in 2025 and got a 12% cut in the minimum volume.',
    },
  ],
  note: 'The high objection has a documented answer; the low one does not move the floor.',
};

/** ...and the same session when the thesis has no answer to give. */
const KILLED = {
  resultado: 'dead',
  outcome: 'fail',
  objections: [
    {
      objection:
        'Both previous sales had the cash reinvested outside the core within three quarters: the net cash may never reach the shareholder.',
      severity: 'high',
      thesis_answer: null,
    },
  ],
  researched_counter_evidence: [
    {
      claim_attacked: 'the net cash stays on the balance sheet through the Q1 2027 release',
      source: 'atas de assembleia de 2023 e 2024',
      finding: 'The parent company\'s historical pattern contradicts the assumption, twice in a row.',
    },
  ],
  note: 'A high objection with no answer: the thesis dies here, which is the cheapest death in the graph.',
};

/** ...and the fake `size-risk` session. */
const SIZED = {
  sizing: {
    position_size_pct: 1.2,
    max_accepted_loss_pct: 0.22,
    exit_trigger: 'full exit if the port contract renewal does not come through by Q3 2027',
    horizon: '18 months, to the Q1 2027 release',
    portfolio_correlation: 'low: no other position in a port terminal',
  },
  note: 'They asked for 1.5%; the surviving high objection pulled the size down to 1.2%.',
};

/** The allocation question the `decide` session ends its first turn with. */
const ALLOCATION_QUESTION = {
  question:
    'Allocate 1.2% of capital to NVLR3 at up to BRL 18.00, with an exit if the port contract is not renewed by Q3 2027?',
  context:
    'Floor at pro-forma net cash of BRL 0.9bn; asymmetry of 5.3x; one high objection answered by an 18-month bank guarantee and one low objection unanswered; one assumption, with a primary source.',
  options: ['Approve as proposed', 'Refuse'],
  recommendation: 'Approve 1.2% of capital in NVLR3, with entry capped at BRL 18.00.',
  default: 'Approve as proposed',
};

/** ...and what the founder answers, which is the only thing that authorizes an edge. */
const FOUNDER_ANSWER =
  'Approved: allocate 1.2% of capital, entry capped at BRL 18.00, and a full exit if the port contract renewal does not come through by Q3 2027.';

/** The lines of a session that pauses for a person instead of deciding. */
const ASKS = JSON.stringify([
  { stream: 'stdout', text: 'There is no decision on record for this thesis, so I am asking:' },
  { stream: 'stdout', text: '```input-request' },
  { stream: 'stdout', text: JSON.stringify(ALLOCATION_QUESTION) },
  { stream: 'stdout', text: '```' },
]);

/** ...and what the session that RESUMES reports — a transcription, never a judgement. */
const transcribed = (questionId: string): Record<string, unknown> => ({
  resultado: 'approved',
  outcome: 'pass',
  human_decision: { question_id: questionId, literal_answer: FOUNDER_ANSWER },
  note: 'The size that counts is the one in the answer (1.2%), and it matches the proposal.',
});

/** One crossing of the real bundle, driven node by node with the fake engine. */
interface Crossing {
  /** The control plane this crossing booted, for the calls the TEST makes. */
  baseUrl: string;
  token: string;
  /** Dispatches whatever node the job is standing on, with the lines it prints. */
  run: (nodeId: string, lines: string) => Promise<void>;
  /** The job as the control plane sees it right now. */
  job: () => Promise<Work>;
  /** Everything the fake session of one node was told, as it received it. */
  toldTo: (nodeId: string) => string;
  /** The `input` the projection publishes for where the job is standing. */
  context: () => Promise<Record<string, unknown>>;
  /** Every call the DISPATCH made — never the ones this test makes itself. */
  calls: string[];
}

/**
 * Boots a control plane, registers the real bundle and opens a thesis on it.
 *
 * The same wiring the two crossings above do inline, in one place because these
 * two walk six and four nodes: what the file already proves is that the
 * production defaults carry a bets job, and repeating fifty lines of setup twice
 * more would bury the only thing that differs — what each session says.
 */
async function startCrossing(
  t: TestContext,
  executionId: number,
  runnerId: string,
): Promise<Crossing> {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t276-factory-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

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

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: TITLE,
      body: BODY,
      entry_node_id: 'triage',
      execution_id: executionId,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        intended_size: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner(runnerId, 'the one that crosses the whole bets bundle');

  const calls: string[] = [];
  const doFetch: typeof fetch = async (target, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(target).slice(baseUrl.length)}`);
    return await fetch(target, init);
  };

  const worktrees = directoryWorktrees(root);
  let currentLines = '[]';
  let currentRecord = path.join(root, 'unused.json');
  const controller = new Controller({
    client,
    runnerId,
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
        doFetch,
        engines: {
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
        envOverrides: { FAKE_ENGINE_LINES: currentLines, FAKE_ENGINE_RECORD: currentRecord },
      })(jobId),
  });

  return {
    baseUrl,
    token,
    calls,
    run: async (nodeId, lines) => {
      currentLines = lines;
      currentRecord = path.join(root, `${nodeId}.json`);
      assert.ok(await controller.tick(), `"${nodeId}" was not picked up by the runner`);
    },
    job: async () => await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`),
    toldTo: (nodeId) =>
      (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
        '\n',
      ),
    context: async () => {
      const { input } = await api<{ input: Record<string, unknown> }>(
        baseUrl,
        token,
        'GET',
        `/v1/jobs/${job.id}/context`,
      );
      return input;
    },
  };
}

test('t276 — the thesis crosses red-team and the human gate, all seven nodes', async (t) => {
  const crossing = await startCrossing(t, LONG_EXECUTION_ID, 'runner-t276-long');
  const { baseUrl, token } = crossing;

  // --- 1. the three nodes the file already covers, in one breath ------------
  await crossing.run('triage', reports(TRIAGED));
  await crossing.run('collect-fundamentals', reports(COLLECTED));
  await crossing.run('analyze-asymmetry', reports(MEASURED));
  assert.equal((await crossing.job()).current_node_id, 'red-team');

  // --- 2. the red team routes on its own, which no test had ever asked -----
  await crossing.run('red-team', reports(SURVIVED));
  const afterRedTeam = await crossing.job();
  assert.equal(
    afterRedTeam.blocked,
    false,
    `the red team's report was refused: ${afterRedTeam.block_reason ?? ''}`,
  );
  assert.equal(afterRedTeam.current_node_id, 'size-risk');
  assert.deepEqual(
    (await crossing.context()).objections,
    SURVIVED.objections,
    'the objections survived the schema whole — a refused report would be `null` here',
  );

  const redTeam = crossing.toldTo('red-team');
  assert.ok(redTeam.includes(TRIAGED_THESIS.hypothesis), 'the red team is pointed at the real thesis');
  assert.ok(!redTeam.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 3. the sizing feeds the dossier the human gate reads ----------------
  await crossing.run('size-risk', reports(SIZED));
  assert.equal((await crossing.job()).current_node_id, 'decide');

  // --- 4. `decide` pauses for a person instead of deciding ----------------
  await crossing.run('decide', ASKS);
  const asked = await crossing.job();
  assert.equal(asked.current_node_id, 'decide', 'a session that asked cannot also have routed');
  assert.equal(asked.blocked, true, 'the mandatory human gate stops the traversal (D14)');

  const firstTurn = crossing.toldTo('decide');
  assert.ok(
    firstTurn.includes(String(SIZED.sizing.position_size_pct)),
    'the proposed size reaches the gate from `{{input.sizing.position_size_pct}}`',
  );
  assert.ok(firstTurn.includes('[]'), 'and the question queue arrives empty, which is legal');
  assert.ok(!firstTurn.includes('{{input.'));

  const { input_requests: pending } = await api<{ input_requests: { id: number }[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/input-requests?status=pending',
  );
  assert.equal(pending.length, 1, 'exactly one allocation question is waiting on the founder');

  await api(baseUrl, token, 'PATCH', `/v1/input-requests/${pending[0].id}/answer`, {
    answer: FOUNDER_ANSWER,
    answered_by: 'rafael',
  });
  assert.equal((await crossing.job()).blocked, false, 'answering unblocked it');

  // --- 5. ...and the answer is what authorizes the edge --------------------
  const questionId = String(pending[0].id);
  await crossing.run('decide', reports(transcribed(questionId)));
  const decided = await crossing.job();
  assert.equal(
    decided.blocked,
    false,
    `the decision's report was refused: ${decided.block_reason ?? ''}`,
  );
  assert.equal(decided.current_node_id, 'record-monitoring');

  const secondTurn = crossing.toldTo('decide');
  assert.ok(
    secondTurn.includes(FOUNDER_ANSWER),
    'the resumed session reads the founder’s words through `{{input.perguntas_respondidas}}`',
  );

  const beforeTheFinalNode = await crossing.context();
  assert.deepEqual(beforeTheFinalNode.human_decision, transcribed(questionId).human_decision);
  assert.deepEqual(beforeTheFinalNode.sizing, SIZED.sizing);

  // --- 6. the final node runs, and the traversal is over -------------------
  const executed = [
    'triage',
    'collect-fundamentals',
    'analyze-asymmetry',
    'red-team',
    'size-risk',
    'decide',
  ];
  await crossing.run(
    'record-monitoring',
    reports({
      process_metrics: {
        red_team_ran: true,
        sourced_assumptions_fraction: 1,
        human_decision_id: questionId,
        final_outcome: 'monitoring',
        unanswered_high_objections: 0,
        nodes_executed: executed,
      },
      record: {
        thesis_id: TRIAGED_THESIS.id,
        summary:
          'Thesis triaged, researched, measured, red-teamed, sized at 1.2% and approved by the founder.',
        monitoring: [
          { trigger: 'port contract renewal', deadline: 'Q3 2027' },
          { trigger: 'Q1 2027 pro-forma release', deadline: 'Q1 2027' },
        ],
      },
      note: 'A long crossing closed: all seven nodes of the graph ran.',
    }),
  );

  const closed = await crossing.job();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.completed, true, 'the traversal is over: the final node reported');

  const finalPrompt = crossing.toldTo('record-monitoring');
  assert.ok(
    finalPrompt.includes(JSON.stringify(executed)),
    '`{{input.traversal.nodes_visited}}` names the six nodes this crossing executed',
  );
  assert.ok(!finalPrompt.includes('{{input.'));

  // --- 7. and the only human in it answered a question, by design ---------
  assert.deepEqual(
    crossing.calls.filter((call) => call.endsWith('/unblocks') || /^PATCH \/v1\/jobs\/\d+$/.test(call)),
    [],
    'no `PATCH /jobs/:id` and no unblock: the gate paused by design and resumed on an answer',
  );
});

test('t276 — the red team kills the thesis, and the `dead` edge closes the traversal', async (t) => {
  const crossing = await startCrossing(t, KILL_EXECUTION_ID, 'runner-t276-kill');

  await crossing.run('triage', reports(TRIAGED));
  await crossing.run('collect-fundamentals', reports(COLLECTED));
  await crossing.run('analyze-asymmetry', reports(MEASURED));

  await crossing.run('red-team', reports(KILLED));
  const killed = await crossing.job();
  assert.equal(
    killed.blocked,
    false,
    `the kill report was refused: ${killed.block_reason ?? ''}`,
  );
  assert.equal(
    killed.current_node_id,
    'record-monitoring',
    'an unanswered high objection takes the "dead" edge straight to the register',
  );
  assert.deepEqual(
    (await crossing.context()).objections,
    KILLED.objections,
    'and the objections that killed it are what the register gets to read',
  );

  await crossing.run(
    'record-monitoring',
    reports({
      process_metrics: {
        red_team_ran: true,
        sourced_assumptions_fraction: 1,
        human_decision_id: null,
        final_outcome: 'archived',
        unanswered_high_objections: 1,
        nodes_executed: ['triage', 'collect-fundamentals', 'analyze-asymmetry', 'red-team'],
      },
      record: {
        thesis_id: TRIAGED_THESIS.id,
        summary: 'The thesis died in the red team: the net cash has no history of reaching the shareholder.',
        monitoring: [],
      },
      note: 'Crossing closed without reaching the human gate — outcome archived.',
    }),
  );

  const closed = await crossing.job();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.completed, true, 'the death path ends on the same final node as every other');
});
