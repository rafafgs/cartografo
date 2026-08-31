/**
 * End-to-end acceptance test of a graph with a deterministic node in it (t332).
 *
 * The automated version of the proof `docs/formats/engine-adapter.md` cites for
 * two engines (`scripts/spike-two-engine-traversal.mjs`), asked of the third
 * one: a real control plane as a child process, a real `ControlPlaneClient`, a
 * real `Controller` taking real leases, the real dispatch, the real registry and
 * a real graph version — and, on the entry node, a command instead of a session.
 *
 * What makes it worth a file of its own is what it does NOT contain. There is no
 * agent on the first node and no operator anywhere: the command prints the same
 * fenced ```resultado``` block a session prints, the control plane holds it
 * against the same pinned `output` schema, the same projection carries it into
 * the next node's input, and the same runner posts the same transition. b3-radar
 * runs exactly this shape today from `bin/crossing.sh`, BESIDE the job, "because
 * a graph node cannot run a script" (its own D18); this test is the sentence
 * that stops being true.
 *
 * The second node is an agent node, on the fake engine, and that is deliberate:
 * a traversal with only shell nodes would prove that shell nodes work together,
 * not that a shell node is a node.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import type * as ClientModule from '../../src/controller/control-plane-client.ts';
import type * as ControllerModule from '../../src/controller/controller.ts';
import type * as DispatchModule from '../../src/dispatch/dispatch.ts';
import type * as WorktreeModule from '../../src/dispatch/session-worktree.ts';
import {
  decodeClaudeCodeSessionText,
  decodeShellSessionText,
} from '../../src/dispatch/session-text.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { ShellAdapter } from '../../src/engine/shell-adapter.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES = path.join(PACKAGE_ROOT, 'test', 'fixtures');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const SHELL_NODE = fileURLToPath(new URL('../fixtures/shell-node.mjs', import.meta.url));

/** The execution this traversal's telemetry lands in. */
const EXECUTION_ID = 3320;

/** What the deterministic node reports, and what the next one is told. */
const MEASUREMENT = 'seven recurring kill patterns, none of them new';

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

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Every call THIS TEST makes, so the "no operator" claim can be asserted. */
const testCalls: string[] = [];

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

/** Sorts keys recursively — the canonicalization the manifest hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/**
 * The pin, recomputed here rather than asked for.
 *
 * `command` is inside the subset since t332 (D4's whole point: the executed
 * behaviour of a shell skill IS its argv), so a registration that answers `201`
 * below is itself the proof that the control plane recomputes the same subset.
 */
function manifestContentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(subset)), 'utf8')
    .digest('hex')}`;
}

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as Record<string, unknown>;
}

/**
 * The committed work manifest, turned into a shell skill.
 *
 * Everything but the id, the description and the new `command` block is left
 * alone: the point is that a shell skill is an ordinary manifest with one more
 * field, and that the `output` schema which judges its report is the same one it
 * would have judged a session's by.
 */
function shellSkill(): Record<string, unknown> {
  const skill: Record<string, unknown> = {
    ...fixture('skill-do-crossing.json'),
    id: 'measure-patterns',
    description: 'Counts what the log already says, deterministically and with no model.',
    command: { argv: [process.execPath, SHELL_NODE] },
  };
  skill.hash = manifestContentHash(skill);
  return skill;
}

/** A pin, taken from the manifest itself and never typed by hand. */
function pinOf(manifest: Record<string, unknown>): Record<string, unknown> {
  return { id: manifest.id, version: manifest.version, hash: manifest.hash };
}

/** The smallest graph with a deterministic node inside the trail. */
function shellTraversalGraph(
  shellPin: Record<string, unknown>,
  agentPin: Record<string, unknown>,
): Record<string, unknown> {
  const noteSchema = {
    type: 'object',
    required: ['nota'],
    properties: { nota: { type: 'string', minLength: 1 } },
  };
  const checks = [
    { type: 'deterministic', command: 'true', description: 'The step ran.' },
  ];

  return {
    problem_class: 'shell-node-traversal',
    lineage: { type: 'base' },
    metadata: {
      name: 'A deterministic node inside the trail',
      description:
        'Two nodes on one edge: the first runs a command through the shell engine, the second an ' +
        'agent session. The smallest document that puts a script inside the graph instead of beside it.',
      schema_version: '1.0.0',
      created_at: '2026-08-31',
      source: 't332 fixture',
    },
    nodes: [
      {
        id: 'measure',
        role: 'analyst',
        node_type: 'work',
        engine: 'shell',
        description: 'Runs the arithmetic as a command: no session, no model, no tokens.',
        skill_ref: shellPin,
        contract: {
          input_schema: { type: 'object' },
          output_schema: noteSchema,
          produces: 'measurement',
          checks,
        },
      },
      {
        id: 'record',
        role: 'writer',
        node_type: 'work',
        description: 'Writes down what the measurement said. Declares no engine: the default runs.',
        skill_ref: agentPin,
        contract: {
          input_schema: {
            type: 'object',
            required: ['measurement'],
            properties: { measurement: noteSchema },
          },
          output_schema: noteSchema,
          checks,
        },
      },
    ],
    edges: [
      {
        from: 'measure',
        to: 'record',
        condition: 'sempre',
        description: 'A single exit: what was measured always goes on to be written down.',
      },
    ],
    initial_node: 'measure',
    final_nodes: ['record'],
    custom_fields: [
      {
        name: 'pedido',
        type: 'string',
        required_at: null,
        description: 'What this crossing was asked to do — the scalar both skills read.',
      },
    ],
  };
}

/** A worktree manager that hands out one plain directory per acquisition. */
function directoryWorktrees(root: string): WorktreeModule.WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      serial += 1;
      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/** The lines the fake AGENT session prints on the second node. */
const AGENT_LINES = JSON.stringify([
  { stream: 'stdout', text: 'I read the measurement and wrote it down.' },
  { stream: 'stdout', text: '```resultado' },
  { stream: 'stdout', text: JSON.stringify({ nota: 'recorded' }) },
  { stream: 'stdout', text: '```' },
]);

test('t332 — a job crosses a graph whose entry node is a command, with nobody in the middle', async (t) => {
  const { ControlPlaneClient } = await loadModule<typeof ClientModule>(
    'src/controller/control-plane-client.ts',
  );
  const { Controller } = await loadModule<typeof ControllerModule>('src/controller/controller.ts');
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(
    'src/dispatch/dispatch.ts',
  );

  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t332-worktrees-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // --- the world the traversal needs, all of it through the public API -------
  const shell = shellSkill();
  const agent = fixture('skill-do-crossing.json');
  await api(baseUrl, token, 'POST', '/v1/skills', shell, 201);
  await api(baseUrl, token, 'POST', '/v1/skills', agent, 201);

  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
    baseUrl,
    token,
    'POST',
    '/v1/graphs',
    shellTraversalGraph(pinOf(shell), pinOf(agent)),
    201,
  );

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: 'a crossing whose first step is a command',
      entry_node_id: 'measure',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
      pedido: 'count the recurring patterns',
    },
    201,
  );

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t332', 'the one with a deterministic node in its graph');

  const worktrees = directoryWorktrees(root);
  const controller = new Controller({
    client,
    runnerId: 'runner-t332',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: {
          // The shell route carries no seam at all: what runs is the argv the
          // registered manifest declared, spawned by the real adapter.
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
        // ONE set of overrides for both engines, and the two fixtures read
        // different names out of it: the fake engine its `FAKE_ENGINE_*`, the
        // shell node its `SHELL_NODE_*`. What the shell child sees is exactly
        // this object and nothing else — the skill allowlisted nothing (FR4).
        envOverrides: {
          FAKE_ENGINE_LINES: AGENT_LINES,
          SHELL_NODE_REPORT: JSON.stringify({ nota: MEASUREMENT }),
        },
      })(jobId),
  });

  const jobNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`);

  const sessionsNow = async (): Promise<SessionRecord[]> =>
    (
      await api<{ sessions: SessionRecord[] }>(
        baseUrl,
        token,
        'GET',
        `/v1/sessions?job_id=${job.id}`,
      )
    ).sessions;

  // --- 1. the entry node is a command, and it advances the job ---------------
  assert.ok(await controller.tick(), 'the released job was picked up');

  const afterShell = await jobNow();
  assert.equal(afterShell.blocked, false, afterShell.block_reason ?? '');
  assert.equal(afterShell.current_node_id, 'record', 'the command moved the job, like any node');

  const shellSession = (await sessionsNow()).find((session) => session.node_id === 'measure');
  assert.ok(shellSession !== undefined, 'the deterministic node opened a session row of its own');
  assert.equal(shellSession.engine, 'shell');
  assert.equal(shellSession.status, 'completed');
  assert.equal(shellSession.exit_code, 0);
  assert.deepEqual(
    shellSession.output,
    { nota: MEASUREMENT },
    "the command's own fenced block is what /finish held against the pinned output schema, " +
      'and what it stored — the same route, the same schema, the same storage a session gets',
  );

  // --- 2. ...and the next node reads it through the ordinary projection ------
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.deepEqual(
    input.measurement,
    { nota: MEASUREMENT },
    '`measure` declares contract.produces: "measurement", so that is where its report lands — ' +
      'a command feeding a projection nothing in the control plane knew was a command',
  );

  // --- 3. the agent node runs and the traversal ends ------------------------
  assert.ok(await controller.tick(), 'the final node has to be dispatched, not skipped');

  const finished = await jobNow();
  assert.equal(finished.current_node_id, 'record');
  assert.equal(finished.completed, true, 'the last node reported what its skill declares');

  const engines = (await sessionsNow()).map((session) => `${session.node_id}:${session.engine}`);
  assert.deepEqual(
    engines.sort(),
    ['measure:shell', 'record:claude-code'],
    'one traversal, two engines, and only one of them opened a model session',
  );

  // --- 4. and NOTHING above was moved by hand -------------------------------
  assert.deepEqual(
    testCalls.filter((call) => call.endsWith('/transitions')),
    [],
    'the test — standing in for the operator — posted no transition at all',
  );

  const { events } = await api<{ events: Event[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/executions/${EXECUTION_ID}/events`,
  );
  const moves = events.filter((event) => event.type === 'job.transitioned');
  assert.deepEqual(
    moves.map((event) => String(event.data.to_node_id)),
    ['record'],
    'the log tells the one edge this graph has, and the runner is who took it',
  );
  assert.deepEqual(
    [...new Set(moves.map((event) => `${event.actor.type}:${event.actor.ref}`))],
    ['system:runner'],
  );
});
