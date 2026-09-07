/**
 * The interview, crossed LIVE: four sessions, four turns, one bundle (t360).
 *
 * `factory-graphs/map-design` is the fourth factory bundle, and the only one
 * whose subject is the product itself: a person describes a problem, the map
 * asks them one question at a time, and the last session hands back a draft
 * bundle — a graph plus one manifest per node — for somebody to register. §1.2
 * of the requirements is the whole claim: *the interview is itself a map, not
 * special code*, and this file is what proves the claim mechanically.
 *
 * ## What makes this crossing different from the other three
 *
 * Nothing about the traversal. `interview` has ONE outgoing edge and no
 * self-loop, and that is not an omission: a session that ends with an
 * `input-request` block blocks the job **on its own node**, and answering
 * re-dispatches that same node with the whole exchange already written into the
 * prompt (`docs/spec/human-escalation.md` §5, `prompt.ts`'s
 * `## What you already asked, and what came back`). So four turns of one
 * interview are four dispatches of ONE node, and the graph needs no edge to say
 * so. What this file measures is exactly that: the job does not move for three
 * turns, and each turn's draft differs from the one before it.
 *
 * ## What is scripted, and what is not
 *
 * The four sessions are scripted, like every other factory crossing here: what
 * a model would decide is not what this test is about. Everything else is real
 * — the two committed manifests, the committed graph, a real `Controller`
 * taking real leases, the control plane's own `POST /v1/input-requests` writing
 * the block in the same transaction as the question, and `PATCH /answer`
 * unblocking it.
 *
 * The last turn's draft is then held against `scripts/validate-graph.mjs`, the
 * same validator that guards the bundles committed in this repository — short
 * of the pin check, which needs hashes the register step (t361) computes, and
 * which is why the drafted manifests carry no `hash` at all.
 *
 * **RF-26 is deliberately absent.** The ticket was written expecting t425 to add
 * a per-node "where it runs" field first; t425 was rejected on 2026-09-06
 * because the requirement had been retracted by its own author (requirements
 * v2.8 §10.2: it duplicates `node.engine`). There is no such field in
 * `schema/graph.schema.json`, so no node here carries one.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ControlPlaneClient } from '../../src/controller/control-plane-client.ts';
import { Controller } from '../../src/controller/controller.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import { createExecutorEnvironmentResolver } from '../../src/dispatch/resolve-executor-environment.ts';
import { createSkillSourceResolver } from '../../src/dispatch/resolve-skill-source.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { SAFE_PERMISSIONS } from '../../src/dispatch/skill-draft.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'factory-graphs', 'map-design');
const GRAPH_VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-graph.mjs');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 3600;

/**
 * The folder of skills the person points the interview at (t440).
 *
 * Checked in rather than written at run time: what the crossing proves is that
 * a real `SKILL.md` on disk becomes a real draft in the next turn's input, and
 * a fixture the test wrote itself would be proving the test's own idea of the
 * format. One file, one skill, one draft — `code review` → `code-review`.
 */
const SKILL_SOURCE = path.join(PACKAGE_ROOT, 'test', 'fixtures', 'skill-source');

/** The id the fixture's frontmatter name derives to (`kebabCase`, t439). */
const DERIVED_DRAFT_ID = 'code-review';

/** The two manifests the graph's nodes pin, in document order. */
const MANIFESTS = Object.freeze(['deliver-bundle.json', 'interview.json']);

interface Work {
  id: number;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  completed: boolean;
}

interface SessionRecord {
  id: number;
  node_id: string | null;
  status: string;
  output: Record<string, unknown> | null;
}

interface Question {
  id: number;
  question: string;
  recommendation: string | null;
  options: string[] | null;
  status: string;
}

/**
 * The map as the interview reports it, turn after turn.
 *
 * An index signature and not two fields alone: since t464 the two keys ARE the
 * report's own top level, so a `Draft` is spread straight into what a scripted
 * session prints and has to read as the `Record` that shape is.
 */
interface Draft extends Record<string, unknown> {
  graph: Record<string, unknown>;
  skills: Record<string, unknown>[];
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
  const file = path.join(BUNDLE, ...segments);
  assert.ok(existsSync(file), `artifact does not exist yet: ${path.relative(REPO_ROOT, file)}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * A session that reports its map and asks one question, in that order.
 *
 * `report` is what the turn printed beside `done`: since t464 that is `graph`
 * and, on the turns that settled a manifest, `skills` — two top-level keys and
 * no `draft` wrapper, so the bucket merge carries each of them on its own
 * (`docs/spec/interview.md` §2). `skill_source` rides in the same object for
 * the same reason it always did: the turn that receives the answer reports it
 * ONCE, and no later turn repeats it.
 */
function asksWith(report: Record<string, unknown>, question: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'Here is the map as it stands.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify({ done: false, ...report }) },
    { stream: 'stdout', text: '```' },
    { stream: 'stdout', text: '```input-request' },
    { stream: 'stdout', text: JSON.stringify(question) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** ...and the last session, which reports a finished map and asks nothing. */
function delivers(report: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'The map is complete.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify({ done: true, ...report }) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** One node of the drafted map, contract fields and all. */
function draftedNode(id: string, role: string, produces: string): Record<string, unknown> {
  return {
    id,
    role,
    node_type: 'work',
    description: `The step that ${id.replace('-', ' ')}.`,
    skill_ref: { id: `${id}-step`, version: '1.0.0' },
    contract: {
      input_schema: { type: 'object', required: ['job'], properties: { job: { type: 'object' } } },
      output_schema: {
        type: 'object',
        required: ['note'],
        properties: { note: { type: 'string', minLength: 1 } },
      },
      produces,
      checks: [
        {
          type: 'agentic',
          instruction: `Did ${id} produce what its output schema declares? Quote it.`,
          required_evidence: true,
          description: 'The failure this step keeps having, turned into a check (RF-18).',
        },
      ],
    },
  };
}

/** ...and the manifest that goes with it, deliberately without a `hash`. */
function draftedManifest(id: string): Record<string, unknown> {
  return {
    id: `${id}-step`,
    version: '1.0.0',
    role: 'work',
    description: `What ${id} does, in one line.`,
    input: { type: 'object', required: ['job'], properties: { job: { type: 'object' } } },
    output: {
      type: 'object',
      required: ['note'],
      properties: { note: { type: 'string', minLength: 1 } },
    },
    preconditions: [],
    checks: [
      {
        id: `${id}-produced-what-it-declares`,
        type: 'agentic',
        description: 'The failure this step keeps having, turned into a check (RF-18).',
        instruction: `Did ${id} produce what its output schema declares? Quote it.`,
        required_evidence: ['the quoted output'],
      },
    ],
    permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
    instructions: `# ${id}\n\nDo this step of the map.`,
    origin: { type: 'native' },
  };
}

/**
 * ...and the one manifest this interview did NOT write from nothing (t440).
 *
 * The scripted stand-in for FR8's adaptation: a step whose manifest starts from
 * the draft derived out of the person's own `SKILL.md` and is then answered into
 * a contract — the checks and the schemas are still this interview's, and only
 * `instructions` and `origin` come from the source. What it pins here is the
 * fixture's SHAPE, not a model's judgement: whether a real session adapts rather
 * than copies is what the agentic check `skill-draft-adaptation-not-a-shortcut`
 * is for, and no deterministic test can stand in for it.
 *
 * `permissions` are the derived draft's own, verbatim — which is
 * {@link SAFE_PERMISSIONS}, and never anything wider: a draft that came from
 * outside is read-only and offline until a person widens it at the import gate
 * (D4, `specs/formats/skill-manifest.md`).
 */
function adaptedManifest(id: string): Record<string, unknown> {
  return {
    ...draftedManifest(id),
    permissions: SAFE_PERMISSIONS,
    instructions: `# ${id}\n\nAdapted from the person's own \`${DERIVED_DRAFT_ID}\` skill.`,
    origin: { type: 'imported', repo: SKILL_SOURCE, ref: 'local' },
  };
}

/** The four drafts, each strictly further along than the one before it. */
const DRAFTS: readonly Draft[] = Object.freeze([
  { graph: { problem_class: null }, skills: [] },
  { graph: { problem_class: 'support-escalation', nodes: [] }, skills: [] },
  {
    graph: { problem_class: 'support-escalation', nodes: [draftedNode('triage', 'agent', 'triage')] },
    skills: [adaptedManifest('triage')],
  },
  {
    graph: {
      problem_class: 'support-escalation',
      lineage: { type: 'base' },
      metadata: {
        name: 'Support escalation',
        description: 'What happens to a support ticket nobody on the first line could close.',
        schema_version: '1.0.0',
      },
      nodes: [draftedNode('triage', 'agent', 'triage'), draftedNode('resolve', 'engineer', 'resolution')],
      edges: [
        {
          from: 'triage',
          to: 'resolve',
          condition: 'always',
          description: 'A single way out: a triaged ticket is worked.',
        },
      ],
      initial_node: 'triage',
      final_nodes: ['resolve'],
      custom_fields: [],
    },
    skills: [adaptedManifest('triage'), draftedManifest('resolve')],
  },
]);

/** The three questions the scripted sessions ask, one per turn. */
const QUESTIONS = Object.freeze([
  {
    question: 'What do you call this class of problem?',
    context: 'You described support tickets that the first line could not close.',
    options: ['support-escalation', 'incident-response'],
    recommendation: 'support-escalation',
    default: 'support-escalation',
  },
  {
    question: 'What does the first step need before it can start?',
    context: 'Every step declares what it needs (RF-19).',
    options: ['the ticket alone', 'the ticket and the customer history'],
    recommendation: 'the ticket and the customer history',
    default: 'the ticket and the customer history',
  },
  {
    question: 'What usually goes wrong at `triage`?',
    context: 'Whatever you answer becomes this step`s checks (RF-18).',
    options: ['it triages the wrong ticket', 'it misses the customer history'],
    recommendation: 'it misses the customer history',
    default: 'it misses the customer history',
  },
]);

/** A bare directory per session — an interview has nothing to look for on disk. */
function directoryWorktrees(root: string): WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      serial += 1;
      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `interview-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/** One control plane, one runner and one scripted engine — the whole crossing. */
interface Crossing {
  /** Where the control plane answers. */
  baseUrl: string;
  /** The token every call above carries. */
  token: string;
  /** The controller that takes the leases. */
  controller: Controller;
  /** What each dispatch was told, in order — the projection and the environment. */
  dispatched: { projection: Record<string, unknown>; environment: Record<string, unknown> }[];
  /** One dispatch, with what its session says. */
  run: (lines: string) => Promise<void>;
  /** A temporary directory of this crossing's own, removed with the test. */
  root: string;
}

/**
 * Boots everything a scripted crossing of this bundle needs.
 *
 * Extracted with t464 because a second crossing needs it: the first proves the
 * four turns, and the second proves that a turn which omits `skills` does not
 * cost `deliver` its manifests. What each of them SCRIPTS is the whole
 * difference between them, so the boot is shared and nothing else is.
 *
 * @param t The running test, for the temporary directory's own cleanup.
 * @param runnerId The identity the leases belong to.
 * @returns The control plane's coordinates and the controller over them.
 */
async function startCrossing(t: TestContext, runnerId: string): Promise<Crossing> {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t360-interview-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner(runnerId, 'the one that runs the interview');

  let currentLines = '[]';
  const worktrees = directoryWorktrees(root);

  // --- the machine half of a dispatched input (t270, t360, t440) ------------
  //
  // Wired here for the first time in this crossing, because t440's subject IS
  // this seam: the executor environment reads the projection the merge just
  // fetched, finds the `skill_source` an earlier turn reported into it, and
  // turns it into one derived draft per `SKILL.md` at
  // `input.environment.skill_drafts`. Cloning is switched OFF — the fixture is
  // a folder, and a crossing that reached the network for it would be testing
  // somebody's connectivity.
  const bench = path.join(root, 'bench');
  mkdirSync(bench, { recursive: true });
  for (const args of [
    ['init', '--quiet', '--initial-branch', 'main'],
    ['config', 'user.email', 'fixture@cartografo.local'],
    ['config', 'user.name', 'Fixture t440'],
    ['commit', '--quiet', '--allow-empty', '-m', 'the bench this crossing only reads'],
  ]) {
    execFileSync('git', args, { cwd: bench, stdio: 'pipe' });
  }

  const machineFacts = createExecutorEnvironmentResolver({
    testBenchPath: bench,
    referenceMode: 'ponta_do_principal',
    resolveSkillSource: createSkillSourceResolver({
      allowGitClone: false,
      scratchRoot: path.join(root, '.skill-sources'),
    }),
  });

  const dispatched: { projection: Record<string, unknown>; environment: Record<string, unknown> }[] =
    [];

  const controller = new Controller({
    client,
    runnerId,
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
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
        executorEnvironment: async (jobRow, resolved, projection) => {
          const environment = await machineFacts(jobRow, resolved, projection);
          dispatched.push({
            projection,
            environment: environment.environment as Record<string, unknown>,
          });
          return environment;
        },
        envOverrides: { FAKE_ENGINE_LINES: currentLines },
      })(jobId),
  });

  return {
    baseUrl,
    token,
    controller,
    dispatched,
    root,
    run: async (lines: string): Promise<void> => {
      currentLines = lines;
      assert.ok(await controller.tick(), 'the released job was not picked up');
    },
  };
}

test('t360 — the interview is a traversal: four turns, one node, one bundle at the end', async (t) => {
  assert.ok(existsSync(BUNDLE), 'artifact does not exist yet: factory-graphs/map-design');
  const { baseUrl, token, dispatched, run, root } = await startCrossing(t, 'runner-t360');

  // --- the bundle, verbatim, and NOT registered by this test ----------------
  //
  // `bootCore` runs the real `cartografo` binary, and since t360 that binary
  // imports this bundle on a database that does not have it (FR1). So the
  // class is already there before the first line of this crossing, and
  // registering it again would answer `409 class_already_registered` — which is
  // the sharp form of the claim rather than an inconvenience: the interview has
  // to be in the box, not in the test.
  const { classes } = await api<{ classes: { class: string; current_version_id: string | null }[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/classes',
  );
  const registered = classes.find((entry) => entry.class === 'map-design');
  assert.ok(registered !== undefined, `the startup did not import the interview: ${JSON.stringify(classes)}`);
  assert.ok(registered.current_version_id !== null, 'an imported class has a version to run');

  const { graph_version: version } = await api<{
    graph_version: { id: string; snapshot: Record<string, unknown> };
  }>(baseUrl, token, 'GET', `/v1/graph-versions/${encodeURIComponent(registered.current_version_id)}`);
  assert.deepEqual(
    version.snapshot.nodes,
    bundleFile('graph.json').nodes,
    'what the startup registered is the committed document, node for node',
  );

  // ...and the two manifests it pins are in the registry, at the pinned hash.
  for (const file of MANIFESTS) {
    const manifest = bundleFile('skills', file);
    const skill = await api<{ hash: string }>(
      baseUrl,
      token,
      'GET',
      `/v1/skills/${String(manifest.id)}?version=${String(manifest.version)}`,
    );
    assert.equal(skill.hash, manifest.hash, `${file}: the registered pin is the committed one`);
  }

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: 'a map for support tickets the first line could not close',
      body: 'They pile up, nobody knows who owns them, and the customer asks twice.',
      entry_node_id: 'interview',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
    },
    201,
  );
  assert.equal(job.current_node_id, 'interview', 'an interview opens on the node that asks');


  const jobNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${String(job.id)}`);

  const sessionsNow = async (): Promise<SessionRecord[]> =>
    (
      await api<{ sessions: SessionRecord[] }>(
        baseUrl,
        token,
        'GET',
        `/v1/sessions?job_id=${String(job.id)}`,
      )
    ).sessions;

  const pendingNow = async (): Promise<Question[]> =>
    (
      await api<{ input_requests: Question[] }>(
        baseUrl,
        token,
        'GET',
        `/v1/input-requests?status=pending&job_id=${String(job.id)}`,
      )
    ).input_requests;

  /** Answers the single open question, exactly as a person at the screen would. */
  const answer = async (turn: number): Promise<void> => {
    const pending = await pendingNow();
    assert.equal(pending.length, 1, `turn ${String(turn)}: exactly one question is waiting`);
    assert.equal(pending[0].question, QUESTIONS[turn].question);
    assert.equal(
      pending[0].recommendation,
      QUESTIONS[turn].recommendation,
      'every question carries the value a person can accept in one click (RF-16)',
    );
    await api(baseUrl, token, 'PATCH', `/v1/input-requests/${String(pending[0].id)}/answer`, {
      answer: QUESTIONS[turn].recommendation,
      answered_by: 'rafael',
    });
  };

  // --- AT1. three turns, each one question, each a draft further along -------
  for (const turn of [0, 1, 2]) {
    // The FIRST turn is the one that receives the class name and, with it, the
    // answer to "do you already have skills for this, and where" (t440, FR1/FR2).
    await run(
      asksWith(
        {
          ...DRAFTS[turn],
          ...(turn === 0 ? { skill_source: { kind: 'path', location: SKILL_SOURCE } } : {}),
        },
        QUESTIONS[turn],
      ),
    );

    const asking = await jobNow();
    assert.equal(
      asking.current_node_id,
      'interview',
      `turn ${String(turn)}: a session that asked cannot also have routed`,
    );
    assert.equal(asking.blocked, true, `turn ${String(turn)}: asking blocks the job on its node`);
    assert.equal(asking.completed, false);

    await answer(turn);
    assert.equal((await jobNow()).blocked, false, 'answering unblocks the same node');
  }

  const reported = (await sessionsNow())
    .filter((session) => session.status === 'completed')
    .map((session) => ({ graph: session.output?.graph, skills: session.output?.skills }));
  assert.equal(reported.length, 3, 'three sessions asked, and all three reported');
  assert.deepEqual(reported, [DRAFTS[0], DRAFTS[1], DRAFTS[2]], 'each turn`s map is its own');
  assert.notDeepEqual(reported[0], reported[1], 'a turn that changed nothing asked for nothing');
  assert.notDeepEqual(reported[1], reported[2]);

  // --- t440. the source somebody named survives, and becomes drafts ---------
  //
  // Turn 0 reported `skill_source` once, beside its map. No later turn repeats
  // it — and it is still in the input of every one of them, because the bucket
  // merge is shallow and per key: a key nobody overwrites keeps its value. The
  // same rule `skills` lives under since t464, and `graph` deliberately does
  // not, because a graph is reported whole every turn.
  assert.deepEqual(
    (dispatched[0].projection.interview as Record<string, unknown> | undefined)?.skill_source,
    undefined,
    'nothing was named before the first answer came back',
  );
  for (const turn of [1, 2]) {
    assert.deepEqual(
      (dispatched[turn].projection.interview as Record<string, unknown>).skill_source,
      { kind: 'path', location: SKILL_SOURCE },
      `turn ${String(turn)}: reported once, carried into every dispatch after it`,
    );
  }

  // ...and the turn immediately after the one that named it opened with the
  // draft derived from the fixture's own SKILL.md — the whole wiring, from a
  // file on disk to what a session is told, and not just the domain function.
  assert.deepEqual(dispatched[0].environment.skill_drafts, [], 'nothing named, nothing derived');
  assert.equal(dispatched[0].environment.skill_drafts_error, null);

  const drafts = dispatched[1].environment.skill_drafts as Record<string, unknown>[];
  assert.equal(dispatched[1].environment.skill_drafts_error, null, 'the fixture folder reads');
  assert.deepEqual(
    drafts.map((draft) => draft.id),
    [DERIVED_DRAFT_ID],
    'one SKILL.md in the folder is one draft in the next turn`s input',
  );
  assert.deepEqual(
    (drafts[0].origin as Record<string, unknown>).repo,
    SKILL_SOURCE,
    'the draft says where it came from, which is what a person reviews at the gate (D4)',
  );
  assert.deepEqual(
    drafts[0].permissions,
    SAFE_PERMISSIONS,
    'derived, never widened: read the workspace, write nothing, no network',
  );

  // --- AT6. abandoned here, the interview has registered NOTHING ------------
  const { classes: known } = await api<{ classes: { class: string }[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/classes',
  );
  assert.deepEqual(
    known.map((entry) => entry.class).filter((name) => name === 'support-escalation'),
    [],
    'a draft is not a registration: an interview stopped here leaves no graph row (RF-25 is t361`s)',
  );
  const { skills } = await api<{ skills: { id: string }[] }>(baseUrl, token, 'GET', '/v1/skills');
  assert.deepEqual(
    skills.map((skill) => skill.id).filter((id) => id.endsWith('-step')),
    [],
    'and no skill row either — the drafted manifests exist only inside a session`s report',
  );

  // --- AT1. the last turn asks nothing, and the job moves on ----------------
  await run(delivers(DRAFTS[3]));

  const delivered = await jobNow();
  assert.equal(delivered.blocked, false, delivered.block_reason ?? '');
  assert.equal(
    delivered.current_node_id,
    'deliver',
    'a session that asked nothing routed: the one `always` edge is the whole topology',
  );

  const final = (await sessionsNow()).at(-1)?.output;
  assert.equal(final?.done, true, 'the last turn says the map is finished');
  const draft: Draft = {
    graph: final?.graph as Record<string, unknown>,
    skills: final?.skills as Record<string, unknown>[],
  };
  assert.deepEqual(draft, DRAFTS[3], 'the last turn reported the whole map, key by key (t464)');

  // --- AT1. every node carries the three contract fields D9 demands ---------
  const nodes = draft.graph.nodes as Record<string, unknown>[];
  assert.equal(nodes.length, 2, 'the drafted map has the two steps the interview settled');
  for (const node of nodes) {
    const contract = node.contract as Record<string, unknown>;
    for (const field of ['input_schema', 'output_schema', 'checks']) {
      assert.ok(contract[field] !== undefined, `node "${String(node.id)}" declares no ${field}`);
    }
    assert.ok(
      Array.isArray(contract.checks) && contract.checks.length >= 1,
      `node "${String(node.id)}" has no check: the answer to "what goes wrong here" is (RF-18)`,
    );
  }

  // --- AT1. one manifest per node, and not one of them is pinned -----------
  assert.deepEqual(
    draft.skills.map((manifest) => manifest.id).sort(),
    nodes.map((node) => (node.skill_ref as { id: string }).id).sort(),
    'the interview writes one skill manifest per step, so a new domain has something to pin',
  );
  for (const manifest of draft.skills) {
    assert.equal(
      manifest.hash,
      undefined,
      'the pin is computed by whoever registers (t361), never claimed by the draft',
    );
  }

  // --- t440. the step that reused a derived draft is still read-only --------
  //
  // The scripted session copied the draft's own permissions verbatim, which is
  // what FR8 forbids widening: adapting a skill somebody else wrote is allowed,
  // handing it the network is a decision only a person makes at the import gate.
  const adapted = draft.skills.find((manifest) => manifest.id === 'triage-step');
  assert.ok(adapted !== undefined, 'the adapted step is in the delivered bundle');
  assert.deepEqual(
    adapted.permissions,
    SAFE_PERMISSIONS,
    'no manifest that reuses an imported draft leaves this interview wider than the safe default',
  );
  assert.equal(
    (adapted.origin as Record<string, unknown>).repo,
    SKILL_SOURCE,
    'and it still says which source it was adapted from',
  );

  // --- AT7. and the drafted graph is a graph this repository would accept ---
  //
  // Written out first, exactly as `deliver` writes it: the validator is a CLI
  // over a file, and reading it back is what makes this a check of the DOCUMENT
  // and not of the object that happened to be in memory.
  const { validarGrafo } = (await import(GRAPH_VALIDATOR)) as {
    validarGrafo: (doc: unknown) => {
      valid: boolean;
      structure: { errors: { code: string; message: string }[] };
      soundness: { violations: { rule: string; target: unknown }[] };
    };
  };
  const written = path.join(root, 'draft-graph.json');
  writeFileSync(written, JSON.stringify(draft.graph, null, 2));
  const report = validarGrafo(JSON.parse(readFileSync(written, 'utf8')));

  assert.deepEqual(report.structure.errors, [], 'the drafted document is structurally a graph');

  // The one exception, and it is the one FR1 declares: `node_with_contract`
  // asks each node for a PINNED skill_ref, and a draft cannot have one — the
  // manifests carry no `hash`, because computing the pin is the register step's
  // job (t361, D4). Every other soundness rule holds as it stands.
  assert.deepEqual(
    report.soundness.violations.map((violation) => violation.rule),
    ['node_with_contract', 'node_with_contract'],
    'the only thing missing from the drafted map is the pin nobody has computed yet',
  );

  // ...and that IS the only thing missing: with a stand-in pin on each node —
  // the one thing the register step adds — the same document is sound.
  const pinned = {
    ...draft.graph,
    nodes: nodes.map((node) => ({
      ...node,
      skill_ref: { ...(node.skill_ref as Record<string, unknown>), hash: `sha256:${'0'.repeat(64)}` },
    })),
  };
  assert.deepEqual(
    validarGrafo(pinned).soundness.violations,
    [],
    'reachable, terminating, every edge labelled, every node under a contract',
  );
});

test('t464 AT7 — a turn that omits `skills` still dispatches `deliver` with every manifest', async (t) => {
  assert.ok(existsSync(BUNDLE), 'artifact does not exist yet: factory-graphs/map-design');
  const { baseUrl, token, dispatched, run } = await startCrossing(t, 'runner-t464');

  const { classes } = await api<{ classes: { class: string; current_version_id: string | null }[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/classes',
  );
  const registered = classes.find((entry) => entry.class === 'map-design');
  assert.ok(registered?.current_version_id != null, 'the startup imported the interview');

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: 'a map for support tickets the first line could not close',
      body: 'They pile up, nobody knows who owns them, and the customer asks twice.',
      entry_node_id: 'interview',
      execution_id: EXECUTION_ID,
      graph_version_id: registered.current_version_id,
    },
    201,
  );

  // --- turn 1. the manifests are settled, and reported ----------------------
  await run(asksWith(DRAFTS[2], QUESTIONS[2]));
  const { input_requests: pending } = await api<{ input_requests: Question[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/input-requests?status=pending&job_id=${String(job.id)}`,
  );
  assert.equal(pending.length, 1, 'the turn asked exactly one thing');
  await api(baseUrl, token, 'PATCH', `/v1/input-requests/${String(pending[0].id)}/answer`, {
    answer: QUESTIONS[2].recommendation,
    answered_by: 'rafael',
  });

  // --- turn 2. the last one moved the graph and no manifest -----------------
  //
  // So it reports `graph` alone. Under the whole-draft reprint this was not
  // expressible at all: `draft` was ONE key, and a turn that left half of it
  // out lost the other half at the next merge.
  await run(delivers({ graph: DRAFTS[3].graph }));

  const routed = await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${String(job.id)}`);
  assert.equal(routed.current_node_id, 'deliver', 'a session that asked nothing routed');

  // --- and `deliver` is dispatched with the WHOLE map -----------------------
  await run(
    JSON.stringify([
      { stream: 'stdout', text: '```resultado' },
      {
        stream: 'stdout',
        text: JSON.stringify({
          bundle: { graph: DRAFTS[3].graph, skills: DRAFTS[2].skills },
          checked: { structure: true, soundness: true, problems: [] },
          note: 'the map covers triage and the escalation itself',
        }),
      },
      { stream: 'stdout', text: '```' },
    ]),
  );

  const delivered = dispatched.at(-1);
  assert.ok(delivered !== undefined, 'the deliver node was dispatched');
  const bucket = delivered.projection.interview as Record<string, unknown>;
  assert.deepEqual(
    bucket.graph,
    DRAFTS[3].graph,
    'the graph is the last one reported, because every turn reports it whole',
  );
  assert.deepEqual(
    bucket.skills,
    DRAFTS[2].skills,
    'and the manifests are the ones an EARLIER turn settled: omitting them lost nothing',
  );
});
