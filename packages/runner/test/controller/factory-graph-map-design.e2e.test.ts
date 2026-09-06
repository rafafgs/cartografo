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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
const BUNDLE = path.join(REPO_ROOT, 'factory-graphs', 'map-design');
const GRAPH_VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-graph.mjs');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 3600;

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

/** The draft as the interview reports it, turn after turn. */
interface Draft {
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

/** A session that reports its draft and asks one question, in that order. */
function asksWith(draft: Draft, question: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'Here is the map as it stands.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify({ done: false, draft }) },
    { stream: 'stdout', text: '```' },
    { stream: 'stdout', text: '```input-request' },
    { stream: 'stdout', text: JSON.stringify(question) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** ...and the last session, which reports a finished map and asks nothing. */
function delivers(draft: Draft): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'The map is complete.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify({ done: true, draft }) },
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

/** The four drafts, each strictly further along than the one before it. */
const DRAFTS: readonly Draft[] = Object.freeze([
  { graph: { problem_class: null }, skills: [] },
  { graph: { problem_class: 'support-escalation', nodes: [] }, skills: [] },
  {
    graph: { problem_class: 'support-escalation', nodes: [draftedNode('triage', 'agent', 'triage')] },
    skills: [draftedManifest('triage')],
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
    skills: [draftedManifest('triage'), draftedManifest('resolve')],
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

test('t360 — the interview is a traversal: four turns, one node, one bundle at the end', async (t) => {
  assert.ok(existsSync(BUNDLE), 'artifact does not exist yet: factory-graphs/map-design');
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t360-interview-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- the bundle, verbatim -------------------------------------------------
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
      title: 'a map for support tickets the first line could not close',
      body: 'They pile up, nobody knows who owns them, and the customer asks twice.',
      entry_node_id: 'interview',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
    },
    201,
  );
  assert.equal(job.current_node_id, 'interview', 'an interview opens on the node that asks');

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t360', 'the one that runs the interview');

  let currentLines = '[]';
  const worktrees = directoryWorktrees(root);
  const controller = new Controller({
    client,
    runnerId: 'runner-t360',
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
        envOverrides: { FAKE_ENGINE_LINES: currentLines },
      })(jobId),
  });

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

  /** One dispatch, with what its session says. */
  const run = async (lines: string): Promise<void> => {
    currentLines = lines;
    assert.ok(await controller.tick(), 'the released interview was not picked up');
  };

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
    await run(asksWith(DRAFTS[turn], QUESTIONS[turn]));

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
    .map((session) => session.output?.draft);
  assert.equal(reported.length, 3, 'three sessions asked, and all three reported');
  assert.deepEqual(reported, [DRAFTS[0], DRAFTS[1], DRAFTS[2]], 'each turn`s draft is its own');
  assert.notDeepEqual(reported[0], reported[1], 'a turn that changed nothing asked for nothing');
  assert.notDeepEqual(reported[1], reported[2]);

  // --- AT6. abandoned here, the interview has registered NOTHING ------------
  const { classes } = await api<{ classes: { class: string }[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/classes',
  );
  assert.deepEqual(
    classes.map((entry) => entry.class).filter((name) => name === 'support-escalation'),
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
  const draft = final?.draft as Draft;

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

  // --- AT7. and the drafted graph is a graph this repository would accept ---
  const { validarGrafo } = (await import(GRAPH_VALIDATOR)) as {
    validarGrafo: (doc: unknown) => {
      valid: boolean;
      structure: { errors: { code: string; message: string }[] };
      soundness: { violations: { rule: string }[] };
    };
  };
  const written = path.join(root, 'draft-graph.json');
  writeFileSync(written, JSON.stringify(draft.graph, null, 2));
  const report = validarGrafo(JSON.parse(readFileSync(written, 'utf8')));
  assert.deepEqual(report.structure.errors, [], 'the drafted document is structurally a graph');
  assert.deepEqual(report.soundness.violations, [], 'and its topology is a sound workflow net');
});
