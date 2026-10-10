/**
 * End-to-end acceptance tests of composition over the real CLI (t639,
 * AT19-AT21).
 *
 * The harness is the t638 one (`subgraph-node.e2e.test.ts`): a real control
 * plane, a real `Controller` with the children watcher, a real dispatch and the
 * fake engine. What differs is who looks. Every read and write this file makes
 * about the jobs goes through the `cartografo` binary (`job create`, `jobs`,
 * `job <id>`, `input-requests`, `answer`, `unblock`, `cancel`), and not one of
 * them is a transition: the only thing that moves a job is the runner. The
 * helpers are copied from `subgraph-node.e2e.test.ts` rather than extracted,
 * because that file is not in this ticket's declaration.
 *
 * The one place the test still reads the API itself is the dispatch hook, which
 * has to know which node a job stands on to choose what the fake session
 * prints. That is the engine's script, not an assertion about the jobs.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { ControlPlaneClient } from '../../src/controller/control-plane-client.ts';
import { Controller } from '../../src/controller/controller.ts';
import type * as WatchModule from '../../src/controller/watch-children.ts';
import { createClaudeCodeDispatch, type DispatchOutcome } from '../../src/dispatch/dispatch.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const EXAMPLES = path.resolve(PACKAGE_ROOT, '..', '..', 'schema', 'examples');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const CARTOGRAFO = path.resolve(PACKAGE_ROOT, '..', 'core', 'bin', 'cartografo.mjs');
const ITEMS = ['alpha', 'beta', 'gamma'];

/** A job, in the fields these tests read off `--json`. */
interface Work {
  id: number;
  title: string;
  state: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  completed: boolean;
  children: number[];
  cancelled_at: string | null;
  dispatch_hold: string | null;
}

interface SessionRecord {
  id: number;
  job_id: number | null;
}

type Doc = Record<string, unknown> & {
  problem_class: string;
  nodes: Array<Record<string, unknown> & { id: string }>;
  edges: Array<Record<string, unknown>>;
  final_nodes: string[];
};

/** What one run of the binary left behind. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function loadWatch(): Promise<typeof WatchModule> {
  const relative = 'src/controller/watch-children.ts';
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as typeof WatchModule;
}

function example(name: string): Doc {
  return JSON.parse(readFileSync(path.join(EXAMPLES, name), 'utf8')) as Doc;
}

/** The lines a fake session prints: prose, then the report block. */
function reporting(result: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'I did what the node asked for.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify(result) },
    { stream: 'stdout', text: '```' },
  ]);
}

/** ...and the lines of a session that stops to ask a person. */
const ASKS = JSON.stringify([
  { stream: 'stdout', text: 'One thing is not decided, so I am asking:' },
  { stream: 'stdout', text: '```input-request' },
  {
    stream: 'stdout',
    text: JSON.stringify({
      question: 'Which tone should this note take?',
      context: 'The item names no audience.',
      options: ['Formal', 'Casual'],
      recommendation: 'Formal.',
      default: 'Formal',
    }),
  },
  { stream: 'stdout', text: '```' },
]);

/** Canonical JSON: keys sorted at every depth, the shape a manifest hash is taken over. */
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
 * The manifest the plan step pins, with a REAL output schema.
 *
 * `resolvePins` would register an empty-schema stand-in, and then the contract
 * check at registration cannot see `plan.items` being produced for the fan-out
 * to read. The hash is the pin's own rule: `sha256:` over the canonical JSON of
 * the content fields.
 */
function planSkill(): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    id: 'plan-notes',
    version: '1.0.0',
    hash: '',
    role: 'work',
    description: 'Lists the notes to write, one item each.',
    input: { type: 'object' },
    output: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array' } },
    },
    preconditions: [],
    checks: [
      {
        id: 'plan-exists',
        type: 'deterministic',
        description: 'The plan exists.',
        command: 'true',
      },
    ],
    permissions: { filesystem: { read: [], write: [] }, network: { allowed: false } },
    instructions: 'List the notes to write, one item per note.',
    origin: { type: 'native' },
  };
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
  };
  manifest.hash = `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
  return manifest;
}

/** Directories as worktrees, one per session, so nothing touches a real repository. */
function directoryWorktrees(root: string): WorktreeManager {
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


/** How one child behaves: asks a person once, or fails every time. */
interface Quirk {
  /** Title of the child that stops to ask a person, on its FIRST session only. */
  asksOn?: string;
  /** Title of the child whose sessions exit non-zero, always. */
  failsOn?: string;
}

/** Everything one crossing needs: the binary as the only eye and hand, and the controller. */
async function crossing(t: test.TestContext, quirk: Quirk) {
  const { createChildrenWatcher } = await loadWatch();
  const { url: baseUrl, token } = await bootCore(t);

  /** Runs the binary against this control plane. */
  const cli = (args: string[]): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [CARTOGRAFO, ...args, '--url', baseUrl, '--token', token],
        { timeout: 60_000, env: { ...process.env, CARTOGRAFO_TOKEN: token } },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ code, stdout, stderr });
        },
      );
    });

  const must = async (args: string[]): Promise<CliResult> => {
    const result = await cli(args);
    assert.equal(result.code, 0, `cartografo ${args.join(' ')} exited ${result.code}: ${result.stderr}`);
    return result;
  };

  /** One job, read through `job <id> --json`. */
  const read = async (id: number): Promise<Work> =>
    (JSON.parse((await must(['job', String(id), '--json'])).stdout) as { job: Work }).job;

  /** The board, read through `jobs --json`. */
  const board = async (): Promise<Work[]> =>
    (JSON.parse((await must(['jobs', '--json'])).stdout) as { jobs: Work[] }).jobs;

  /** The cells of a `jobs` row, by job id. */
  const row = (stdout: string, id: number): string[] => {
    const line = stdout.split('\n').find((candidate) => new RegExp(`^${id}\\s`).test(candidate));
    assert.ok(line, `no row for job ${id} in:\n${stdout}`);
    return line.split(/ {2,}/);
  };

  // Setup that is not about the jobs: the graphs and the plan skill the parent pins.
  const api = async <T>(method: string, route: string, body?: unknown, expected = 200): Promise<T> => {
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
  };

  const register = async (document: Doc): Promise<string> => {
    await resolvePins(baseUrl, token, document);
    const body = await api<{ graph_version: { id: string } }>('POST', '/v1/graphs', document, 201);
    return body.graph_version.id;
  };
  await register(example('graph-valid-minimal.json'));
  const skill = planSkill();
  await api('POST', '/v1/skills', skill, 201);
  const parentDocument = example('graph-valid-subgraph-fan-out.json');
  const plan = parentDocument.nodes.find((node) => node.id === 'plan');
  assert.ok(plan !== undefined);
  plan.skill_ref = { id: skill.id, version: skill.version, hash: skill.hash };
  const parentVersion = await register(parentDocument);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t639-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const inputFile = path.join(root, 'parent.json');
  writeFileSync(
    inputFile,
    JSON.stringify({ title: 'three notes, in order', entry_node_id: 'plan' }),
    'utf8',
  );

  // The parent is opened by the binary, like every other thing about a job.
  const created = JSON.parse(
    (await must(['job', 'create', '--graph', parentVersion, '--input', inputFile, '--execution', '639', '--json']))
      .stdout,
  ) as { id: number };
  const parent = created.id;

  const worktrees = directoryWorktrees(root);
  const asked = new Set<number>();

  /** What a fake session prints, chosen by the job and the node it stands on. */
  const linesFor = (work: Work): string => {
    if (work.current_node_id === 'plan') {
      return reporting({ items: ITEMS.map((title) => ({ title })) });
    }
    if (work.current_node_id === 'redigir') {
      if (work.title === quirk.failsOn) return '[]';
      if (work.title === quirk.asksOn && !asked.has(work.id)) {
        asked.add(work.id);
        return ASKS;
      }
      return reporting({ texto: `text of ${work.title}` });
    }
    if (work.current_node_id === 'revisar') {
      return reporting({ outcome: 'passou', evidencia: 'the note reads well' });
    }
    return reporting({ published: true });
  };

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t639', 'the one that calls subgraphs');

  const controller = new Controller({
    client,
    runnerId: 'runner-t639',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    watchChildren: createChildrenWatcher(client, 1),
    dispatch: async (jobId): Promise<DispatchOutcome> => {
      // The engine's script: which node does this job stand on?
      const work = await api<Work>('GET', `/v1/jobs/${jobId}`);
      return createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        projectId: 1,
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
        envOverrides: {
          FAKE_ENGINE_LINES: linesFor(work),
          ...(work.title === quirk.failsOn ? { FAKE_ENGINE_EXIT_CODE: '3' } : {}),
        },
      })(jobId);
    },
  });

  /**
   * One pass of the controller. A session that exits non-zero comes out of
   * `tick()` as a `DispatchError` for the caller to decide about, the way the
   * runner's own loop does; here the only deciding is "keep going".
   */
  const tickOnce = async (): Promise<void> => {
    try {
      await controller.tick();
    } catch (error: unknown) {
      assert.match(String((error as Error).message), /ended as "failed"/, 'only a failed session may escape a tick');
    }
  };

  /** Ticks until `done` holds, failing after a generous bound. */
  const tickUntil = async (done: () => Promise<boolean>, label: string): Promise<void> => {
    for (let tick = 0; tick < 40; tick += 1) {
      if (await done()) return;
      await tickOnce();
    }
    assert.ok(await done(), `${label}: not reached within 40 ticks`);
  };

  /** Every session on the board, read through the binary. */
  const sessionsOf = async (jobId: number): Promise<SessionRecord[]> =>
    (
      JSON.parse((await must(['sessions', '--job', String(jobId), '--json'])).stdout) as {
        sessions: SessionRecord[];
      }
    ).sessions;

  return { cli, must, read, board, row, tickUntil, tickOnce, parent, sessionsOf };
}

/** The lines of the `children:` table of `job <id>`, header excluded, split into cells. */
function childRows(stdout: string): string[][] {
  const lines = stdout.split('\n');
  const start = lines.indexOf('children:');
  assert.ok(start >= 0, `no children: section in:\n${stdout}`);
  const rows: string[][] = [];
  for (let index = start + 2; index < lines.length && lines[index] !== '' && !lines[index].startsWith('waiting'); index += 1) {
    rows.push(lines[index].split(/ {2,}/));
  }
  return rows;
}

test('t639 AT19 — an ordered fan-out is readable as a tree, the waiting child is named, and it finishes', async (t) => {
  const { must, read, board, row, tickUntil, parent } = await crossing(t, { asksOn: 'beta' });

  await tickUntil(async () => (await read(parent)).children.length === 3, 'the children are open');
  const [first, second, third] = (await read(parent)).children;

  // While it runs: the board says who is whose.
  const running = await must(['jobs']);
  assert.equal(row(running.stdout, parent)[5], 'parent of 3');
  assert.equal(row(running.stdout, first)[5], `child 1 of #${parent}`);
  assert.equal(row(running.stdout, second)[5], `child 2 of #${parent}`);
  assert.equal(row(running.stdout, third)[5], `child 3 of #${parent}`);

  // Child 2 asks a person; the watcher blocks the parent on it.
  await tickUntil(async () => (await read(parent)).blocked, 'the parent is blocked');

  const asking = await must(['job', String(parent)]);
  assert.deepEqual(
    childRows(asking.stdout).map((cells) => cells[1]),
    [String(first), String(second), String(third)],
    'the children, in position order',
  );
  assert.match(asking.stdout, new RegExp(`^waiting on a person: #${second} \\(position 2 of 3\\)$`, 'm'));
  const header = asking.stdout.split('\n')[0];
  assert.match(header, / · blocked — /);
  assert.ok(header.includes(`child job ${second}`) && header.includes('2 of 3'), header);

  const awaiting = await board();
  assert.deepEqual(
    awaiting.filter((job) => job.state === 'awaiting_you').map((job) => job.id),
    [second],
  );
  const listed = await must(['jobs', '--state', 'awaiting_you']);
  assert.ok(!new RegExp(`^${parent}\\s`, 'm').test(listed.stdout));
  assert.ok(new RegExp(`^${second}\\s`, 'm').test(listed.stdout));

  // The person answers and releases the parent; the rest runs on its own.
  const questions = JSON.parse((await must(['input-requests', '--json'])).stdout) as {
    input_requests: Array<{ id: number; job_id: number }>;
  };
  const question = questions.input_requests.find((request) => request.job_id === second);
  assert.ok(question, 'child 2 has a pending question');
  await must(['answer', String(question.id), 'Formal', '--by', 'rafael']);
  await must(['unblock', String(parent), '--note', 'answered', '--by', 'rafael']);

  await tickUntil(async () => (await read(parent)).completed, 'the parent completes');

  const done = await must(['job', String(parent)]);
  assert.deepEqual(
    childRows(done.stdout).map((cells) => cells[2]),
    ['completed', 'completed', 'completed'],
  );
  assert.match(done.stdout, /^waiting on a person: \(none\)$/m);
  assert.match(done.stdout.split('\n')[0], / · done$/);
});

test('t639 AT20 — a failing child blocks the parent, and the CLI names it', async (t) => {
  const { must, read, tickUntil, parent, sessionsOf } = await crossing(t, { failsOn: 'beta' });

  await tickUntil(async () => (await read(parent)).blocked, 'the parent is blocked');

  const seen = await must(['job', String(parent)]);
  const [first, second, third] = (await read(parent)).children;
  const rows = childRows(seen.stdout);
  assert.deepEqual(
    rows.map((cells) => cells[1]),
    [String(first), String(second), String(third)],
  );
  assert.equal((await read(second)).blocked, true, 'child 2 is blocked by the control plane');
  assert.ok(rows[1].includes('true'), `child 2's row says blocked: ${rows[1].join(' | ')}`);
  const header = seen.stdout.split('\n')[0];
  assert.match(header, / · blocked — /);
  assert.ok(header.includes(`child job ${second}`) && header.includes('2 of 3'), header);
  assert.equal((await sessionsOf(third)).length, 0, 'child 3 never ran');
});

test('t639 AT21 — cancelling a blocked parent cancels its open children and holds the parent', async (t) => {
  const { cli, must, read, board, row, tickOnce, tickUntil, parent, sessionsOf } = await crossing(t, {
    failsOn: 'beta',
  });

  await tickUntil(async () => (await read(parent)).blocked, 'the parent is blocked');
  const [first, second, third] = (await read(parent)).children;

  const cancelled = await cli(['cancel', String(parent), '--reason', 'dropped', '--by', 'rafael']);
  assert.equal(cancelled.code, 0, cancelled.stderr);

  const hold = await must(['jobs']);
  assert.equal(row(hold.stdout, parent)[6], 'cancelled');
  assert.equal(row(hold.stdout, second)[6], 'cancelled');
  assert.equal(row(hold.stdout, third)[6], 'cancelled');
  assert.notEqual(row(hold.stdout, first)[6], 'cancelled', 'a completed child is left alone');
  assert.equal((await board()).find((job) => job.id === first)?.cancelled_at, null);
  assert.match((await must(['job', String(parent)])).stdout, /^cancelled: \d{4}-/m);

  await tickOnce();
  await tickOnce();
  const after = await read(parent);
  assert.equal(after.current_node_id, 'write-notes', 'the parent never left its subgraph node');
  assert.equal(after.completed, false);
  assert.equal((await sessionsOf(third)).length, 0, 'child 3 still has no session');
});
