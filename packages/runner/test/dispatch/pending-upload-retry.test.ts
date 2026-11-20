/**
 * Acceptance tests for t1340: a completed session whose only failure was the
 * artifact upload keeps its result, and the runner retries the upload — not the
 * node (AT11–AT25).
 *
 * Real control plane (`bootCore`), so the pending declaration, the settlement
 * and the next node's input are the core's own (t1338, t1339). The engine is a
 * stub adapter that prints a report and writes the declared file into the
 * directory it was handed; the store is the real artifact route behind a
 * `doFetch` that can be told to fail it. Time is an injected clock.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bootCore, resolvePins } from '@cartografo/test-support';

import type * as SpoolModule from '../../src/dispatch/artifact-spool.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import type { DispatchOutcome } from '../../src/dispatch/outcome.ts';
import { decodeShellSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import type { EngineAdapter } from '../../src/engine/types.ts';

const SPOOL_MODULE = path.resolve(import.meta.dirname, '..', '..', 'src', 'dispatch', 'artifact-spool.ts');

/** A reader of the spool on disk, loaded only once the module exists. */
async function spoolAt(root: string, now?: () => number): Promise<SpoolModule.ArtifactSpool> {
  assert.ok(existsSync(SPOOL_MODULE), 'artifact does not exist yet: packages/runner/src/dispatch/artifact-spool.ts');
  const { ArtifactSpool } = (await import(SPOOL_MODULE)) as typeof SpoolModule;
  return new ArtifactSpool({ root, ...(now === undefined ? {} : { now }) });
}

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SKILL_ID = 'pending-artifact';
const T0 = 1_900_000_000_000;
const FIRST_RUNG = 60_000;
const CONTENT = 'what the step was asked to produce';

interface Work {
  id: number;
  current_node_id: string;
  blocked: boolean;
}

interface Traced {
  method: string;
  route: string;
  body: unknown;
  artifactName: string | null;
}

interface Settlements {
  session_id: number;
  pending: string[];
  settled: Array<{ name: string; artifact_id: number }>;
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
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', file), 'utf8')) as Record<
    string,
    unknown
  >;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['nota'],
  properties: {
    nota: { type: 'string', minLength: 1 },
    relatorio: { type: 'string', minLength: 1, 'x-artifact': true },
    anexo: { type: 'string', minLength: 1, 'x-artifact': true },
  },
};

/** `do-crossing`, with two properties of its `output` declared as artifacts. */
function artifactSkill(): Record<string, unknown> {
  const skill: Record<string, unknown> = {
    ...fixture('skill-do-crossing.json'),
    id: SKILL_ID,
    description: 'Produces the files the step declares, and names them in the report.',
    output: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...OUTPUT_SCHEMA },
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
          contract: { ...(node.contract as Record<string, unknown>), output_schema: OUTPUT_SCHEMA },
        }
      : node,
  );
  return { ...document, problem_class: className, nodes };
}

/** The lines of a session that reports `report`, and optionally asks a question. */
function linesReporting(report: Record<string, unknown>, question?: string): string[] {
  const lines = ['I did what the step asked for.', '```resultado', JSON.stringify(report), '```'];
  if (question !== undefined) {
    lines.push(
      '```input-request',
      JSON.stringify({ question, context: 'c', options: ['a', 'b'], recommendation: 'a', default: 'a' }),
      '```',
    );
  }
  return lines;
}

/** An adapter that writes `files`, prints `lines` and ends `completed` (or `status`). */
function stubAdapter(
  lines: string[],
  files: Record<string, string> = {},
  status: 'completed' | 'failed' = 'completed',
): EngineAdapter {
  return {
    engineName: 'claude-code',
    startSession: (spec, listener) => {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(spec.workingDir, name), content);
      }
      queueMicrotask(() => {
        for (const line of lines) listener.onOutput(line);
        listener.onFinished(status, status === 'completed' ? 0 : 1);
      });
      return Promise.resolve('stub-session');
    },
    getStatus: () => Promise.resolve(status),
    cancel: () => Promise.resolve(),
    capabilities: () => ({}),
    verifyCli: () => Promise.resolve({ available: true, version: 'stub', authenticated: true }),
  } as EngineAdapter;
}

interface RecordingWorktrees extends WorktreeManager {
  readonly releases: Array<{ keep: boolean }>;
}

function recordingWorktrees(dir: string): RecordingWorktrees {
  const releases: Array<{ keep: boolean }> = [];
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

/** Every value of `key` anywhere inside `value`. */
function valuesOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => valuesOf(item, key));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...(key in record ? [record[key]] : []),
    ...Object.values(record).flatMap((item) => valuesOf(item, key)),
  ];
}

test('t1340 — an upload failure holds the result and retries only the upload', async (parent) => {
  const { url: baseUrl, token: bootToken } = await bootCore(parent);
  const token = bootToken ?? '';
  let sequence = 13400;

  const skill = artifactSkill();
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-do-crossing.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-check-crossing.json'), 201);
  await api(baseUrl, token, 'POST', '/v1/skills', skill, 201);

  const area = mkdtempSync(path.join(tmpdir(), 'cartografo-t1340-retry-'));
  parent.after(() => {
    rmSync(area, { recursive: true, force: true });
  });

  async function newJob(withGraph = true): Promise<Work> {
    sequence += 1;
    let graphVersionId: string | undefined;
    if (withGraph) {
      const document = artifactGraph(`t1340-${String(sequence)}`, skill.hash as string);
      await resolvePins(baseUrl, token, document);
      const registered = await api<{ graph_version: { id: string } }>(baseUrl, token, 'POST', '/v1/graphs', document, 201);
      graphVersionId = registered.graph_version.id;
    }
    return await api<Work>(
      baseUrl,
      token,
      'POST',
      '/v1/jobs',
      {
        title: `a step that declares an artifact (${String(sequence)})`,
        entry_node_id: 'implementar',
        execution_id: sequence,
        ...(graphVersionId === undefined ? {} : { graph_version_id: graphVersionId }),
      },
      201,
    );
  }

  /** Everything one case needs: a job, a store it controls, a clock and a spool. */
  interface Bench {
    job: Work;
    calls: Traced[];
    worktrees: RecordingWorktrees;
    workDir: string;
    spoolRoot: string;
    /** `up` delegates to the real route; `down` answers 500; `lost` stores then throws. */
    store: { mode: 'up' | 'down' | 'lost'; failNames: string[] };
    faults: { transitionsOnce: boolean };
    clock: { now: number };
    doFetch: typeof fetch;
    dispatch: (adapter?: EngineAdapter, extra?: Record<string, unknown>) => Promise<DispatchOutcome>;
    since: (mark: number) => Traced[];
  }

  async function bench(options: { withGraph?: boolean; adapter?: EngineAdapter } = {}): Promise<Bench> {
    const job = await newJob(options.withGraph ?? true);
    const root = path.join(area, `case-${String(sequence)}`);
    const workDir = path.join(root, 'tree');
    const spoolRoot = path.join(root, 'spool');
    const calls: Traced[] = [];
    const store: Bench['store'] = { mode: 'down', failNames: [] };
    const faults = { transitionsOnce: false };
    const clock = { now: T0 };

    const doFetch: typeof fetch = async (input, init) => {
      const route = String(input).slice(baseUrl.length);
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      const artifactName = new Headers(init?.headers).get('x-artifact-name');
      calls.push({
        method,
        route,
        body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
        artifactName,
      });
      if (method === 'POST' && /^\/v1\/sessions\/\d+\/artifacts$/.test(route)) {
        const failing = store.failNames.length === 0 || store.failNames.includes(artifactName ?? '');
        if (store.mode === 'down' && failing) {
          return new Response('the store is down', { status: 500 });
        }
        if (store.mode === 'lost' && failing) {
          await fetch(input, init);
          throw new TypeError('the answer of the store was lost');
        }
      }
      if (faults.transitionsOnce && method === 'POST' && route.endsWith('/transitions')) {
        faults.transitionsOnce = false;
        return new Response('the transition was refused', { status: 500 });
      }
      return await fetch(input, init);
    };

    const defaultAdapter =
      options.adapter ?? stubAdapter(linesReporting({ nota: 'ready', relatorio: 'report.md' }), { 'report.md': CONTENT });
    const worktrees = recordingWorktrees(workDir);
    const dispatch = (adapter: EngineAdapter = defaultAdapter, extra: Record<string, unknown> = {}) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: { 'claude-code': { adapter, decodeSessionText: decodeShellSessionText } },
        worktrees,
        resolveInput: () => Promise.resolve({ pedido: 'produce the artifact' }),
        timeoutSeconds: 60,
        artifactSpoolRoot: spoolRoot,
        now: () => clock.now,
        ...extra,
      })(job.id);

    return {
      job,
      calls,
      worktrees,
      workDir,
      spoolRoot,
      store,
      faults,
      clock,
      doFetch,
      dispatch,
      since: (mark) => calls.slice(mark),
    };
  }

  const finishes = (calls: Traced[]): Array<Record<string, unknown>> =>
    calls
      .filter((call) => call.method === 'PATCH' && /^\/v1\/sessions\/\d+\/finish$/.test(call.route))
      .map((call) => call.body as Record<string, unknown>);
  const count = (calls: Traced[], method: string, pattern: RegExp): number =>
    calls.filter((call) => call.method === method && pattern.test(call.route)).length;
  const UPLOAD = /^\/v1\/sessions\/\d+\/artifacts$/;
  const SETTLE = /^\/v1\/sessions\/\d+\/artifact-settlements/;
  const OPEN = /^\/v1\/sessions(\?.*)?$/;
  const TRANSITION = /^\/v1\/jobs\/\d+\/transitions$/;
  const BLOCK = /^\/v1\/jobs\/\d+\/blocks$/;

  const sessionsOf = async (jobId: number): Promise<Array<{ id: number; status: string }>> =>
    (await api<{ sessions: Array<{ id: number; status: string }> }>(baseUrl, token, 'GET', `/v1/sessions?job_id=${String(jobId)}`))
      .sessions;
  const settlementsOf = async (sessionId: number): Promise<Settlements> =>
    await api<Settlements>(baseUrl, token, 'GET', `/v1/sessions/${String(sessionId)}/artifact-settlements`);
  const artifactsOf = async (sessionId: number): Promise<Array<{ id: number; name: string }>> =>
    (await api<{ artifacts: Array<{ id: number; name: string }> }>(baseUrl, token, 'GET', `/v1/sessions/${String(sessionId)}/artifacts`))
      .artifacts;
  const jobOf = async (jobId: number): Promise<Work> => await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${String(jobId)}`);
  const contextOf = async (jobId: number): Promise<unknown> =>
    await api<unknown>(baseUrl, token, 'GET', `/v1/jobs/${String(jobId)}/context`);

  await parent.test('AT11 — the first dispatch closes completed with the name pending and spools the file', async () => {
    const b = await bench();
    const outcome = await b.dispatch();

    const sessions = await sessionsOf(b.job.id);
    assert.equal(sessions.length, 1, 'exactly one session');
    const [session] = sessions;
    assert.equal(session.status, 'completed');

    assert.equal(outcome.blocked, true);
    const reason = (outcome as { reason: string }).reason;
    assert.match(reason, /implementar/);
    assert.match(reason, new RegExp(`\\b${String(session.id)}\\b`));
    assert.match(reason, /relatorio/);
    assert.match(reason, /1 of 5/);

    const closed = finishes(b.calls);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].status, 'completed');
    assert.deepEqual(closed[0].output, { nota: 'ready', relatorio: 'report.md' }, 'the report as reported');
    assert.deepEqual(closed[0].pending_artifacts, ['relatorio']);

    const stored = await api<{ transcript: string | null }>(baseUrl, token, 'GET', `/v1/sessions/${String(session.id)}/transcript`);
    assert.ok(typeof stored.transcript === 'string' && stored.transcript.includes('I did what the step asked for.'));
    assert.deepEqual((await settlementsOf(session.id)).pending, ['relatorio']);

    assert.equal(count(b.calls, 'POST', TRANSITION), 0);
    assert.equal(count(b.calls, 'POST', BLOCK), 0);
    const after = await jobOf(b.job.id);
    assert.equal(after.blocked, false);
    assert.equal(after.current_node_id, 'implementar');

    assert.deepEqual(b.worktrees.releases, [{ keep: false }]);
    assert.equal(existsSync(path.join(b.workDir, 'report.md')), false, 'the file left the worktree');

    const spool = await spoolAt(b.spoolRoot);
    const entry = spool.find(b.job.id);
    assert.ok(entry !== null, 'the spool holds an entry');
    assert.equal(entry.state.attempts, 1);
    assert.equal(entry.state.session_id, session.id);
    assert.equal(entry.state.next_attempt_at, T0 + FIRST_RUNG);
    assert.equal(readFileSync(spool.fileOf(entry, 'relatorio'), 'utf8'), CONTENT);
  });

  await parent.test('AT12 — a dispatch before next_attempt_at uploads nothing and opens nothing', async () => {
    const b = await bench();
    await b.dispatch();
    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG - 1;
    const mark = b.calls.length;

    const outcome = await b.dispatch();
    assert.equal(outcome.blocked, true);
    assert.match((outcome as { reason: string }).reason, /relatorio/);
    const later = b.since(mark);
    assert.equal(count(later, 'POST', UPLOAD), 0);
    assert.equal(count(later, 'GET', SETTLE) + count(later, 'POST', SETTLE), 0);
    assert.equal(count(later, 'POST', OPEN), 0);
    assert.equal((await sessionsOf(b.job.id)).length, 1);
  });

  await parent.test('AT13 — a due retry with the store answering settles, advances and clears the spool', async () => {
    const b = await bench();
    await b.dispatch();
    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG;
    const mark = b.calls.length;

    assert.deepEqual(await b.dispatch(), { blocked: false });
    const later = b.since(mark);
    assert.equal(count(later, 'POST', UPLOAD), 1);
    assert.equal(count(later, 'POST', SETTLE), 1);
    assert.equal(count(later, 'POST', TRANSITION), 1);
    assert.equal(count(later, 'POST', OPEN), 0, 'no second session');

    assert.equal((await jobOf(b.job.id)).current_node_id, 'conferir');
    const [session] = await sessionsOf(b.job.id);
    assert.equal((await sessionsOf(b.job.id)).length, 1);
    const artifacts = await artifactsOf(session.id);
    assert.equal(artifacts.length, 1, 'exactly one artifact');
    const settlement = later.find((call) => call.method === 'POST' && SETTLE.test(call.route));
    assert.deepEqual(settlement?.body, { name: 'relatorio', artifact_id: artifacts[0].id });
    assert.deepEqual((await settlementsOf(session.id)).pending, []);
    assert.ok(
      valuesOf(await contextOf(b.job.id), 'relatorio').includes(String(artifacts[0].id)),
      'the next node reads the id as a decimal string',
    );
    assert.equal((await spoolAt(b.spoolRoot)).find(b.job.id), null);
  });

  await parent.test('AT14 — a retry that fails again records attempt 2 and the next rung', async () => {
    const b = await bench();
    await b.dispatch();
    b.clock.now = T0 + FIRST_RUNG + 5;
    const mark = b.calls.length;

    const outcome = await b.dispatch();
    assert.equal(outcome.blocked, true);
    assert.match((outcome as { reason: string }).reason, /2 of 5/);
    const later = b.since(mark);
    assert.equal(count(later, 'POST', UPLOAD), 1);
    assert.equal(count(later, 'POST', OPEN), 0);
    assert.equal(count(later, 'POST', BLOCK), 0);
    const entry = (await spoolAt(b.spoolRoot)).find(b.job.id);
    assert.equal(entry?.state.attempts, 2);
    assert.equal(entry.state.next_attempt_at, T0 + FIRST_RUNG + 5 + 120_000);
    assert.equal((await jobOf(b.job.id)).blocked, false);
  });

  await parent.test('AT15 — at the cap one block is posted; an unblock starts a fresh round', async () => {
    const b = await bench();
    const extra = { maxArtifactUploadAttempts: 2 };
    await b.dispatch(undefined, extra);
    const [session] = await sessionsOf(b.job.id);
    b.clock.now = T0 + FIRST_RUNG;

    const outcome = await b.dispatch(undefined, extra);
    assert.equal(outcome.blocked, true);
    assert.equal(count(b.calls, 'POST', BLOCK), 1, 'exactly one block');
    const blocked = await jobOf(b.job.id);
    assert.equal(blocked.blocked, true);
    const posted = b.calls.find((call) => call.method === 'POST' && BLOCK.test(call.route))?.body as { reason: string };
    for (const expected of [/implementar/, new RegExp(`\\b${String(session.id)}\\b`), /relatorio/, /\b2\b/, /the store is down/]) {
      assert.match(posted.reason, expected);
    }
    const spool = await spoolAt(b.spoolRoot);
    const entry = spool.find(b.job.id);
    assert.ok(entry !== null);
    assert.equal(readFileSync(spool.fileOf(entry, 'relatorio'), 'utf8'), CONTENT, 'the bytes are kept');
    assert.equal(entry.state.attempts, 0);

    await api(baseUrl, token, 'POST', `/v1/jobs/${String(b.job.id)}/unblocks`, { reason: 'the store is back' });
    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG + 1;
    assert.deepEqual(await b.dispatch(undefined, extra), { blocked: false });
    assert.equal((await jobOf(b.job.id)).current_node_id, 'conferir');
    assert.equal(spool.find(b.job.id), null);
    assert.equal((await sessionsOf(b.job.id)).length, 1);
  });

  await parent.test('AT16 — a freshly built dispatch on the same spool completes the retry', async () => {
    const b = await bench();
    await b.dispatch();
    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG;
    // `bench.dispatch` builds a new `createClaudeCodeDispatch` on every call,
    // so nothing but the spool on disk carries over.
    assert.deepEqual(await b.dispatch(stubAdapter(['never run'])), { blocked: false });
    assert.equal((await jobOf(b.job.id)).current_node_id, 'conferir');
    assert.equal((await sessionsOf(b.job.id)).length, 1);
  });

  await parent.test('AT17 — a crash between settlement and transition: the next dispatch only transitions', async () => {
    const b = await bench();
    await b.dispatch();
    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG;
    b.faults.transitionsOnce = true;
    await assert.rejects(b.dispatch(), /transitions/);
    assert.equal(count(b.calls, 'POST', SETTLE), 1);

    const mark = b.calls.length;
    assert.deepEqual(await b.dispatch(), { blocked: false });
    const later = b.since(mark);
    assert.equal(count(later, 'POST', UPLOAD), 0);
    assert.equal(count(later, 'POST', SETTLE), 0);
    assert.equal(count(later, 'POST', TRANSITION), 1);
    assert.equal((await jobOf(b.job.id)).current_node_id, 'conferir');
    const [session] = await sessionsOf(b.job.id);
    assert.equal((await artifactsOf(session.id)).length, 1);
  });

  await parent.test('AT18 — an upload whose answer was lost settles on the same artifact id', async () => {
    const b = await bench();
    b.store.mode = 'lost';
    const first = await b.dispatch();
    assert.equal(first.blocked, true);
    const [session] = await sessionsOf(b.job.id);
    const stored = await artifactsOf(session.id);
    assert.equal(stored.length, 1, 'the store kept it, the runner never heard');

    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG;
    assert.deepEqual(await b.dispatch(), { blocked: false });
    const after = await artifactsOf(session.id);
    assert.equal(after.length, 1, 'still exactly one artifact row');
    assert.deepEqual((await settlementsOf(session.id)).settled.map((entry) => entry.artifact_id), [stored[0].id]);
  });

  await parent.test('AT19 — two artifacts, one failing: only that one is pending and retried', async () => {
    const adapter = stubAdapter(linesReporting({ nota: 'ready', relatorio: 'report.md', anexo: 'annex.md' }), {
      'report.md': CONTENT,
      'annex.md': 'the annex',
    });
    const b = await bench({ adapter });
    b.store.failNames = ['relatorio'];
    await b.dispatch();
    const [session] = await sessionsOf(b.job.id);
    const [closed] = finishes(b.calls);
    const annex = (await artifactsOf(session.id)).find((artifact) => artifact.name === 'anexo');
    assert.ok(annex !== undefined);
    assert.deepEqual(closed.output, { nota: 'ready', relatorio: 'report.md', anexo: String(annex.id) });
    assert.deepEqual(closed.pending_artifacts, ['relatorio']);

    b.store.mode = 'up';
    b.clock.now = T0 + FIRST_RUNG;
    const mark = b.calls.length;
    assert.deepEqual(await b.dispatch(), { blocked: false });
    const uploads = b.since(mark).filter((call) => call.method === 'POST' && UPLOAD.test(call.route));
    assert.deepEqual(uploads.map((call) => call.artifactName), ['relatorio']);
    const report = (await artifactsOf(session.id)).find((artifact) => artifact.name === 'relatorio');
    assert.ok(report !== undefined);
    const context = await contextOf(b.job.id);
    assert.ok(valuesOf(context, 'relatorio').includes(String(report.id)));
    assert.ok(valuesOf(context, 'anexo').includes(String(annex.id)));
  });

  await parent.test('AT20 — a stale entry is discarded and the dispatch opens a session as usual', async () => {
    // (a) the entry's node is not the job's.
    const moved = await bench();
    moved.store.mode = 'up';
    const scratch = path.join(area, `scratch-${String(sequence)}`);
    mkdirSync(scratch, { recursive: true });
    const seed = async (b: Bench, nodeId: string, sessionId: number): Promise<void> => {
      const file = path.join(scratch, `seed-${String(sessionId)}`);
      writeFileSync(file, 'old bytes');
      (await spoolAt(b.spoolRoot, () => T0 - FIRST_RUNG)).hold({
        jobId: b.job.id,
        sessionId,
        nodeId,
        output: 'old text',
        files: [{ name: 'relatorio', file }],
      });
    };
    await seed(moved, 'conferir', 999_999);
    assert.deepEqual(await moved.dispatch(), { blocked: false });
    assert.equal(count(moved.calls, 'POST', OPEN), 1, 'a normal dispatch opened a session');
    assert.equal((await spoolAt(moved.spoolRoot)).find(moved.job.id), null);

    // (b) the server never heard of a pending name on that session (unknown id).
    const unknown = await bench();
    unknown.store.mode = 'up';
    await seed(unknown, 'implementar', 999_998);
    assert.deepEqual(await unknown.dispatch(), { blocked: false });
    assert.equal(count(unknown.calls, 'POST', OPEN), 1);
    assert.equal((await spoolAt(unknown.spoolRoot)).find(unknown.job.id), null);

    // (c) the session exists and declared nothing pending.
    const silent = await bench();
    silent.store.mode = 'up';
    const opened = await api<{ id: number }>(
      baseUrl,
      token,
      'POST',
      '/v1/sessions',
      { job_id: silent.job.id, node_id: 'implementar', engine: 'claude-code', engine_session_ref: null, working_dir: area, prompt: 'seeded' },
      201,
    );
    await seed(silent, 'implementar', opened.id);
    assert.deepEqual(await silent.dispatch(), { blocked: false });
    assert.equal(count(silent.calls, 'POST', OPEN), 1);
    assert.equal((await spoolAt(silent.spoolRoot)).find(silent.job.id), null);
  });

  await parent.test('AT21 — a refused declaration blocks as today and spools nothing', async () => {
    const b = await bench({ adapter: stubAdapter(linesReporting({ nota: 'ready', relatorio: 'report.md' })) });
    const outcome = await b.dispatch();
    assert.deepEqual(outcome, { blocked: false });
    const [closed] = finishes(b.calls);
    assert.ok(!('pending_artifacts' in closed));
    const posted = b.calls.find((call) => call.method === 'POST' && BLOCK.test(call.route))?.body as { reason: string };
    assert.match(posted.reason, /could NOT be taken out of its worktree/);
    assert.equal(existsSync(b.spoolRoot) && readdirSync(b.spoolRoot).length > 0, false);
  });

  await parent.test('AT22 — a session that asks and fails an upload posts the question and holds nothing', async () => {
    const adapter = stubAdapter(linesReporting({ nota: 'ready', relatorio: 'report.md' }, 'Which format?'), {
      'report.md': CONTENT,
    });
    const b = await bench({ adapter });
    await b.dispatch();
    const [closed] = finishes(b.calls);
    assert.equal(closed.status, 'completed');
    assert.ok(!('pending_artifacts' in closed));
    assert.deepEqual(closed.output, { nota: 'ready' }, 'no path for the failed key');
    assert.equal(count(b.calls, 'POST', /^\/v1\/input-requests$/), 1, 'the question is posted');
    assert.equal(existsSync(b.spoolRoot) && readdirSync(b.spoolRoot).length > 0, false);
  });

  await parent.test('AT23 — a report the core refuses discards the spool and posts the schema block', async () => {
    const adapter = stubAdapter(linesReporting({ nota: 42, relatorio: 'report.md' }), { 'report.md': CONTENT });
    const b = await bench({ adapter });
    await b.dispatch();
    const [closed] = finishes(b.calls);
    assert.deepEqual(closed.pending_artifacts, ['relatorio']);
    const posted = b.calls.find((call) => call.method === 'POST' && BLOCK.test(call.route))?.body as { reason: string };
    assert.ok(posted !== undefined, 'the schema-refusal block was posted');
    assert.match(posted.reason, /schema/i);
    assert.equal((await spoolAt(b.spoolRoot)).find(b.job.id), null);
    assert.equal(existsSync(path.join(b.spoolRoot, `job-${String(b.job.id)}`)), false);
  });

  await parent.test('AT24 — a job with no graph settles on resume, advances nothing and discards', async () => {
    const b = await bench({ withGraph: false });
    const opened = await api<{ id: number }>(
      baseUrl,
      token,
      'POST',
      '/v1/sessions',
      { job_id: b.job.id, node_id: 'implementar', engine: 'claude-code', engine_session_ref: null, working_dir: area, prompt: 'seeded' },
      201,
    );
    await api(baseUrl, token, 'PATCH', `/v1/sessions/${String(opened.id)}/finish`, {
      status: 'completed',
      exit_code: 0,
      output: { nota: 'ready', relatorio: 'report.md' },
      pending_artifacts: ['relatorio'],
    });
    const file = path.join(area, `seed-${String(sequence)}`);
    writeFileSync(file, CONTENT);
    (await spoolAt(b.spoolRoot, () => T0 - FIRST_RUNG)).hold({
      jobId: b.job.id,
      sessionId: opened.id,
      nodeId: 'implementar',
      output: 'text',
      files: [{ name: 'relatorio', file }],
    });
    b.store.mode = 'up';

    assert.deepEqual(await b.dispatch(), { blocked: false });
    assert.equal(count(b.calls, 'POST', SETTLE), 1);
    assert.equal(count(b.calls, 'POST', TRANSITION), 0);
    assert.equal(count(b.calls, 'POST', OPEN), 0);
    assert.deepEqual((await settlementsOf(opened.id)).pending, []);
    assert.equal((await spoolAt(b.spoolRoot)).find(b.job.id), null);
  });

  await parent.test('AT25 — a session that did not complete never uploads and never holds', async () => {
    const adapter = stubAdapter(linesReporting({ nota: 'ready', relatorio: 'report.md' }), { 'report.md': CONTENT }, 'failed');
    const b = await bench({ adapter });
    await assert.rejects(b.dispatch(), /ended as "failed"/);
    assert.equal(count(b.calls, 'POST', UPLOAD), 0);
    assert.equal(existsSync(b.spoolRoot) && readdirSync(b.spoolRoot).length > 0, false);
    const [closed] = finishes(b.calls);
    assert.ok(!('pending_artifacts' in closed));
  });
});
