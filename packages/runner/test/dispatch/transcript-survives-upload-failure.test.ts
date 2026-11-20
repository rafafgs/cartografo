/**
 * Acceptance tests for t1314, rewritten by t1340: a session's transcript is
 * kept when the artifact upload that follows the engine fails, and since t1340
 * the session itself is kept too.
 *
 * The transcript travels in exactly one write — the `transcript` field of
 * `PATCH /v1/sessions/:id/finish` — so it is only as safe as the runner's path
 * to that call. The upload of a declared artifact sits on that path. Until
 * t1340 a store failure there closed the session `failed` through t1313's
 * compensating closure and the node ran again. Now the session closes
 * `completed` with its report as reported, the name it could not upload is
 * declared pending, the file waits in the runner's spool, and only the upload
 * is retried (`pending-uploads.ts`). AT1–AT7 pin that; AT8 is the happy path,
 * unchanged.
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

import type * as SpoolModule from '../../src/dispatch/artifact-spool.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';

const SPOOL_MODULE = path.resolve(import.meta.dirname, '..', '..', 'src', 'dispatch', 'artifact-spool.ts');

/** A reader of the spool on disk, loaded only once the module exists. */
async function spoolAt(root: string, now?: () => number): Promise<SpoolModule.ArtifactSpool> {
  assert.ok(existsSync(SPOOL_MODULE), 'artifact does not exist yet: packages/runner/src/dispatch/artifact-spool.ts');
  const { ArtifactSpool } = (await import(SPOOL_MODULE)) as typeof SpoolModule;
  return new ArtifactSpool({ root, ...(now === undefined ? {} : { now }) });
}

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
    spoolRoot: string;
    outcome: { error: Error } | { resolved: { blocked: boolean; reason?: string } };
    /** One more dispatch of the same job, on the same spool, at `now`. */
    again: (options: { artifactStatus: number }, now: number) => Promise<{ blocked: boolean }>;
  }

  async function run(
    t: { after: (fn: () => void) => void },
    options: { artifactStatus: number; failFinish?: boolean },
  ): Promise<Run> {
    const workDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t1314-'));
    // The spool beside the tree and never inside it, as `cli/run.ts` wires it.
    const spoolRoot = `${workDir}-spool`;
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(spoolRoot, { recursive: true, force: true });
    });
    const job = await jobOnImplementar();
    const { doFetch, calls } = wrappedFetch(options);
    const worktrees = recordingWorktrees(workDir);
    const dispatchWith = (fetchImpl: typeof fetch, now: () => number) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch: fetchImpl,
        engines: { 'claude-code': { adapter: fakeAdapter(), decodeSessionText: decodeClaudeCodeSessionText } },
        worktrees,
        resolveInput: () => Promise.resolve({ pedido: 'produce the artifact' }),
        timeoutSeconds: 60,
        artifactSpoolRoot: spoolRoot,
        now,
        envOverrides: {
          FAKE_ENGINE_LINES: linesDeclaringArtifact(),
          FAKE_ENGINE_WRITE_FILES: JSON.stringify({ [ARTIFACT_FILE]: 'what the step was asked to produce' }),
        },
      });
    const dispatch = dispatchWith(doFetch, Date.now);
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
    const again: Run['again'] = async (next, now) =>
      await dispatchWith(wrappedFetch(next).doFetch, () => now)(job.id);
    return { job, sessionId: sessions[0].id, calls, worktrees, workDir, spoolRoot, outcome, again };
  }

  const finishes = (calls: Traced[]): Traced[] =>
    calls.filter((call) => call.method === 'PATCH' && /^\/v1\/sessions\/\d+\/finish$/.test(call.route));
  const uploads = (calls: Traced[]): Traced[] =>
    calls.filter((call) => call.method === 'POST' && call.route.endsWith('/artifacts'));

  await parent.test('AT1 — the dispatch resolves blocked, and the transcript is stored', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    assert.ok('resolved' in ran.outcome, 'the upload failure no longer rejects the dispatch');
    assert.equal(ran.outcome.resolved.blocked, true);
    assert.match(ran.outcome.resolved.reason ?? '', /relatorio/);

    const stored = await api<{ transcript: string | null }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions/${String(ran.sessionId)}/transcript`,
    );
    assert.ok(typeof stored.transcript === 'string' && stored.transcript !== '', 'the transcript is non-empty');
    assert.ok(stored.transcript.includes(MARKER), 'and it holds what the engine printed');
  });

  // Since t1340 the closure is the ordinary one: `completed`, with the report
  // as reported and the name it could not upload declared pending. t1313's
  // `failed` closure stays for every other post-engine throw.
  await parent.test('AT2 — the session is closed completed, with the report and the name pending', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    const { sessions } = await api<{
      sessions: Array<{ id: number; status: string; finished_at: string | null; output: unknown }>;
    }>(baseUrl, token, 'GET', `/v1/sessions?job_id=${String(ran.job.id)}`);
    assert.equal(sessions[0].status, 'completed');
    assert.notEqual(sessions[0].finished_at, null);
    assert.deepEqual(sessions[0].output, { nota: 'the artifact is ready', relatorio: ARTIFACT_FILE });
    const settlements = await api<{ pending: string[] }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions/${String(ran.sessionId)}/artifact-settlements`,
    );
    assert.deepEqual(settlements.pending, ['relatorio']);
    const { events } = await api<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions/${String(ran.sessionId)}/events`,
    );
    const finished = events.find((event) => event.type === 'session.finished');
    assert.ok(finished !== undefined, 'session.finished was recorded');
    assert.equal(finished.data.error, null, 'no runner error: the session did not fail');
  });

  await parent.test('AT3 — the decoded log is readable', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    const log = await api<{ text: string | null }>(baseUrl, token, 'GET', `/v1/sessions/${String(ran.sessionId)}/log`);
    assert.ok(typeof log.text === 'string' && log.text !== '');
  });

  await parent.test('AT4 — the upload comes first, then exactly one finish, with transcript, output and pending', async (t) => {
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
    assert.equal(body.status, 'completed');
    assert.equal(typeof body.transcript, 'string');
    assert.ok((body.transcript as string).includes(MARKER));
    assert.deepEqual(body.output, { nota: 'the artifact is ready', relatorio: ARTIFACT_FILE });
    assert.deepEqual(body.pending_artifacts, ['relatorio']);
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

  await parent.test('AT6 — the worktree is released, and the declared file waits in the spool', async (t) => {
    const ran = await run(t, { artifactStatus: 500 });
    assert.equal(finishes(ran.calls).length, 1, 'the closure itself was still written');
    assert.deepEqual(ran.worktrees.releases, [{ keep: false }]);
    assert.equal(existsSync(path.join(ran.workDir, ARTIFACT_FILE)), false, 'it left the worktree');
    const spool = await spoolAt(ran.spoolRoot);
    const entry = spool.find(ran.job.id);
    assert.ok(entry !== null);
    assert.equal(readFileSync(spool.fileOf(entry, 'relatorio'), 'utf8'), 'what the step was asked to produce');
  });

  await parent.test('AT7 — a refused closure after a failed upload surfaces the finish error; the stale entry goes next time', async (t) => {
    const ran = await run(t, { artifactStatus: 500, failFinish: true });
    assert.ok('error' in ran.outcome);
    assert.match(ran.outcome.error.message, /finish/);
    assert.equal(finishes(ran.calls).length, 1, 'the closure was attempted, and refused');
    const { sessions } = await api<{ sessions: Array<{ id: number; status: string }> }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions?job_id=${String(ran.job.id)}`,
    );
    assert.equal(sessions[0].status, 'open', 'the session is left open');
    const spool = await spoolAt(ran.spoolRoot);
    assert.equal(spool.find(ran.job.id)?.state.session_id, ran.sessionId, 'a stale entry is left behind');

    // The next due dispatch asks the server, hears nothing is pending on that
    // session, discards the entry and runs the node as a normal dispatch.
    await ran.again({ artifactStatus: 201 }, Date.now() + 3_600_000);
    assert.equal(spool.find(ran.job.id), null);
    const after = await api<{ sessions: Array<{ id: number }> }>(
      baseUrl,
      token,
      'GET',
      `/v1/sessions?job_id=${String(ran.job.id)}`,
    );
    assert.equal(after.sessions.length, 2, 'the node ran again, as a normal dispatch');
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
