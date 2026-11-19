/**
 * Acceptance tests for t1314: a session's transcript is kept even when the
 * artifact upload that follows the engine fails.
 *
 * The transcript travels in exactly one write — the `transcript` field of
 * `PATCH /v1/sessions/:id/finish` — so it is only as safe as the runner's path
 * to that call. The upload of a declared artifact sits on that path, and a throw
 * there used to skip the closure for good: the session stayed `open` with
 * `transcript = NULL`.
 *
 * Real control plane (`bootCore`), the fake engine, and a `doFetch` wrapper that
 * answers `POST /v1/sessions/:id/artifacts` with 500 and delegates everything
 * else to the real `fetch`.
 *
 * The fixtures are reproduced here at the minimum, rather than exported from
 * `dispatch.test.ts`, which belongs to other tickets.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const SKILL_ID = 'artifact-survival';
const ARTIFACT_FILE = 'report.md';
const ARTIFACT_ID = 77;
const MARKER = 'MARKER: the engine ran to the end and said so';

interface Work {
  id: number;
  current_node_id: string;
  blocked: boolean;
}

interface Traced {
  method: string;
  route: string;
  body: unknown;
}

interface ReleaseCall {
  keep: boolean;
}

async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${String(response.status)}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
  }
  return value;
}

/** The registry recomputes this pin at `POST /v1/skills` (D4). */
function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', file), 'utf8')) as Record<string, unknown>;
}

/** `do-crossing`, with one property of its `output` declared as an artifact. */
function artifactSkill(): Record<string, unknown> {
  const skill: Record<string, unknown> = {
    ...fixture('skill-do-crossing.json'),
    id: SKILL_ID,
    description: 'Produces the artifact the step declares, as a file, and names it in the report.',
    output: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['nota', 'relatorio'],
      properties: {
        nota: { type: 'string', minLength: 1 },
        relatorio: { type: 'string', minLength: 1, 'x-artifact': true },
      },
    },
  };
  skill.hash = manifestHash(skill);
  return skill;
}

/** The traversal graph with `implementar` pinned to the artifact skill. */
function artifactGraph(className: string, hash: string): Record<string, unknown> {
  const document = fixture('graph-traversal.json');
  const nodes = (document.nodes as Array<Record<string, unknown>>).map((node) =>
    node.id === 'implementar'
      ? {
          ...node,
          skill_ref: { id: SKILL_ID, version: '1.0.0', hash },
          contract: {
            ...(node.contract as Record<string, unknown>),
            output_schema: {
              type: 'object',
              required: ['nota'],
              properties: {
                nota: { type: 'string', minLength: 1 },
                relatorio: { type: 'string', minLength: 1, 'x-artifact': true },
              },
            },
          },
        }
      : node,
  );
  return { ...document, problem_class: className, nodes };
}

/** What the fake session prints: a marker line, then a report declaring a file. */
function linesDeclaringArtifact(): string {
  return JSON.stringify([
    { stream: 'stdout', text: MARKER },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify({ nota: 'the artifact is ready', relatorio: ARTIFACT_FILE }) },
    { stream: 'stdout', text: '```' },
  ]);
}

function fakeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });
}

interface RecordingWorktrees extends WorktreeManager {
  readonly releases: ReleaseCall[];
}

function recordingWorktrees(dir: string): RecordingWorktrees {
  const releases: ReleaseCall[] = [];
  return {
    releases,
    acquire: (jobId) => {
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: (_worktree, outcome) => {
      releases.push({ keep: outcome.keep });
      return Promise.resolve({ kept: outcome.keep });
    },
  };
}

test('t1314 — a session that ran keeps its transcript when the upload after it fails', async (parent) => {
  const { url: baseUrl, token: bootToken } = await bootCore(parent);
  const token = bootToken ?? '';
  let sequence = 1400;

  const skill = artifactSkill();
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-do-crossing.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-check-crossing.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', skill, 201);

  async function jobOnImplementar(): Promise<Work> {
    sequence += 1;
    const document = artifactGraph(`transcript-survives-${String(sequence)}`, skill.hash as string);
    await resolvePins(baseUrl, token, document);
    const registered = await api<{ graph_version: { id: string } }>(baseUrl, token, 'POST', '/v1/graphs', document, 201);
    return await api<Work>(
      baseUrl,
      token,
      'POST',
      '/v1/jobs',
      {
        title: 'a step that declares an artifact',
        entry_node_id: 'implementar',
        execution_id: sequence,
        graph_version_id: registered.graph_version.id,
      },
      201,
    );
  }

  /** A `fetch` that fails what it is told to fail and delegates the rest. */
  function wrappedFetch(options: { artifactStatus: number; failFinish?: boolean }): {
    doFetch: typeof fetch;
    calls: Traced[];
  } {
    const calls: Traced[] = [];
    const doFetch: typeof fetch = async (input, init) => {
      const route = String(input).slice(baseUrl.length);
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      calls.push({
        method,
        route,
        body:
          typeof raw === 'string'
            ? JSON.parse(raw)
            : raw === undefined || raw === null
              ? undefined
              : Buffer.from(raw as Uint8Array).toString('utf8'),
      });
      if (method === 'POST' && /^\/v1\/sessions\/\d+\/artifacts$/.test(route)) {
        return options.artifactStatus === 201
          ? new Response(JSON.stringify({ id: ARTIFACT_ID, session_id: 1, name: 'relatorio' }), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('the store is down', { status: options.artifactStatus });
      }
      if (options.failFinish === true && method === 'PATCH' && /^\/v1\/sessions\/\d+\/finish$/.test(route)) {
        return new Response('the closure was refused', { status: 500 });
      }
      return await fetch(input, init);
    };
    return { doFetch, calls };
  }

  interface Run {
    job: Work;
    sessionId: number;
    calls: Traced[];
    worktrees: RecordingWorktrees;
    workDir: string;
    outcome: { error: Error } | { resolved: { blocked: boolean } };
  }

  async function run(
    t: { after: (fn: () => void) => void },
    options: { artifactStatus: number; failFinish?: boolean },
  ): Promise<Run> {
    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t1314-'));
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });
    const job = await jobOnImplementar();
    const { doFetch, calls } = wrappedFetch(options);
    const worktrees = recordingWorktrees(workDir);
    const dispatch = createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      doFetch,
      engines: { 'claude-code': { adapter: fakeAdapter(), decodeSessionText: decodeClaudeCodeSessionText } },
      worktrees,
      resolveInput: () => Promise.resolve({ pedido: 'produce the artifact' }),
      timeoutSeconds: 60,
      envOverrides: {
        FAKE_ENGINE_LINES: linesDeclaringArtifact(),
        FAKE_ENGINE_WRITE_FILES: JSON.stringify({ [ARTIFACT_FILE]: 'what the step was asked to produce' }),
      },
    });
    let outcome: Run['outcome'];
    try {
      outcome = { resolved: await dispatch(job.id) };
    } catch (error) {
      outcome = { error: error as Error };
    }
    const { sessions } = await api<{ sessions: Array<{ id: number }> }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions?job_id=${String(job.id)}`,
    );
    assert.equal(sessions.length, 1, 'one dispatch opens one session');
    return { job, sessionId: sessions[0].id, calls, worktrees, workDir, outcome };
  }

  const finishes = (calls: Traced[]): Traced[] =>
    calls.filter((call) => call.method === 'PATCH' && /^\/v1\/sessions\/\d+\/finish$/.test(call.route));
  const uploads = (calls: Traced[]): Traced[] =>
    calls.filter((call) => call.method === 'POST' && call.route.endsWith('/artifacts'));

  await parent.test('AT1 — the dispatch rejects with the upload error, and the transcript is stored', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    assert.ok('error' in ran.outcome, 'the upload failure still surfaces');
    assert.match(ran.outcome.error.message, /500/);

    const stored = await api<{ transcript: string | null }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions/${String(ran.sessionId)}/transcript`,
    );
    assert.ok(typeof stored.transcript === 'string' && stored.transcript !== '', 'the transcript is non-empty');
    assert.ok(stored.transcript.includes(MARKER), 'and it holds what the engine printed');
  });

  await parent.test('AT2 — the session is closed with the engine\'s own outcome and no output', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    const { sessions } = await api<{
      sessions: Array<{ id: number; status: string; finished_at: string | null; output: unknown }>;
    }>(baseUrl, token, 'GET', `/v1/sessions?job_id=${String(ran.job.id)}`);
    assert.equal(sessions[0].status, 'completed');
    assert.notEqual(sessions[0].finished_at, null);
    assert.equal(sessions[0].output, null);
  });

  await parent.test('AT3 — the decoded log is readable', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    const log = await api<{ text: string | null }>(baseUrl, token, 'GET', `/v1/sessions/${String(ran.sessionId)}/log`);
    assert.ok(typeof log.text === 'string' && log.text !== '');
  });

  await parent.test('AT4 — the upload comes first, then exactly one finish, carrying the transcript and no output', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    const relevant = ran.calls.filter(
      (call) => call.route.endsWith('/artifacts') || call.route.endsWith('/finish'),
    );
    assert.deepEqual(
      relevant.map((call) => `${call.method} ${call.route.replace(/\/sessions\/\d+/, '/sessions/N')}`),
      ['POST /v1/sessions/N/artifacts', 'PATCH /v1/sessions/N/finish'],
    );
    const [finish] = finishes(ran.calls);
    const body = finish.body as Record<string, unknown>;
    assert.equal(typeof body.transcript, 'string');
    assert.ok((body.transcript as string).includes(MARKER));
    assert.equal('output' in body, false, 'there is no report to attach');
    const stored = await api<{ transcript: string }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions/${String(ran.sessionId)}/transcript`,
    );
    assert.equal(stored.transcript, body.transcript, 'the whole raw stream, as sent');
  });

  await parent.test('AT5 — nothing past the closure runs', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    const past = ran.calls.filter(
      (call) =>
        call.method === 'POST' &&
        (call.route === `/v1/jobs/${String(ran.job.id)}/blocks` ||
          call.route === `/v1/jobs/${String(ran.job.id)}/transitions` ||
          call.route === '/v1/input-requests'),
    );
    assert.deepEqual(past, []);
    assert.equal(finishes(ran.calls).length, 1, 'the closure itself was still written');
    const after = await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${String(ran.job.id)}`);
    assert.equal(after.current_node_id, 'implementar');
    assert.equal(after.blocked, false);
  });

  await parent.test('AT6 — the worktree is kept and the declared file is still on disk', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    assert.equal(finishes(ran.calls).length, 1, 'the closure itself was still written');
    assert.deepEqual(ran.worktrees.releases, [{ keep: true }]);
    assert.ok(existsSync(path.join(ran.workDir, ARTIFACT_FILE)));
  });

  await parent.test('AT7 — a refused closure after a failed upload still surfaces the upload error', async (t) => {
    const ran = await run(t, { artifactStatus: 500, failFinish: true });
    assert.ok('error' in ran.outcome);
    assert.match(ran.outcome.error.message, /artifacts/);
    assert.doesNotMatch(ran.outcome.error.message, /finish/);
    assert.equal(finishes(ran.calls).length, 1, 'the closure was attempted, and refused');
  });

  await parent.test('AT8 — with the upload answering, the happy path is unchanged', async (t) => {
    const ran = await run(t, { artifactStatus: 201 });
    assert.ok('resolved' in ran.outcome);
    assert.deepEqual(ran.outcome.resolved, { blocked: false });
    assert.equal(uploads(ran.calls).length, 1);
    const [finish] = finishes(ran.calls);
    assert.deepEqual((finish.body as Record<string, unknown>).output, {
      nota: 'the artifact is ready',
      relatorio: String(ARTIFACT_ID),
    });
    const order = ran.calls
      .filter((call) => call.route.endsWith('/artifacts') || call.route.endsWith('/finish') || call.route.endsWith('/transitions'))
      .map((call) => call.route.split('/').pop());
    assert.deepEqual(order, ['artifacts', 'finish', 'transitions']);
  });
});
