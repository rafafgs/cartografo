/**
 * Acceptance tests for the session a post-engine throw used to leave open
 * (t1313, FR1–FR4).
 *
 * Between the engine's end and `finishSession` the dispatch still decodes the
 * session text, parses the report, uploads the declared artifacts, releases the
 * tree and drains the denials. A throw from any of them landed in the outer
 * `catch`, which rethrew without closing the session: job 2's sessions 25–38
 * are still `open` on the live board for exactly that reason. Since t1313 that
 * catch closes the session as `failed`, once, with the error text, and the
 * ORIGINAL error is still what the dispatch rejects with.
 *
 * Against a real control plane, booted once for the file the way
 * `input-file-dispatch.test.ts` boots it. The engine is a stub adapter (the
 * outcome is the input here, not the subject), and every fault is injected
 * through `doFetch` or the engine route's decoder, so the recorded calls are
 * exactly what the dispatch sent.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import type { EngineRoute } from '../../src/dispatch/dispatch.ts';
import { decodeShellSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import type { EngineAdapter } from '../../src/engine/types.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

interface Work {
  id: number;
  current_node_id: string;
}

interface SessionRow {
  id: number;
  status: string;
  finished_at: string | null;
}

interface EventRow {
  type: string;
  entity: { type: string; id: number | string };
  data: Record<string, unknown>;
}

/** One call the dispatch made, as the recording `fetch` saw it. */
interface Traced {
  method: string;
  route: string;
  body: unknown;
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

/** The lines a session prints when it reports `report` in its closing block. */
function linesReporting(report: Record<string, unknown>): string[] {
  return ['I did what the step asked for.', '```resultado', JSON.stringify(report), '```'];
}

/**
 * An adapter that ends `completed`, after printing `lines` and writing `files`
 * into the directory it was handed.
 *
 * On the next turn of the loop and never inside `startSession`, the posture
 * `dispatch.test.ts`'s `stubAdapter` documents: the dispatch is entitled to its
 * handle before the outcome lands.
 */
function stubAdapter(lines: string[], files: Record<string, string> = {}): EngineAdapter {
  return {
    engineName: 'claude-code',
    startSession: (spec, listener) => {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(spec.workingDir, name), content);
      }
      queueMicrotask(() => {
        for (const line of lines) listener.onOutput(line);
        listener.onFinished('completed', 0);
      });
      return Promise.resolve('stub-session');
    },
    getStatus: () => Promise.resolve('completed'),
    cancel: () => Promise.resolve(),
    capabilities: () => ({}),
    verifyCli: () => Promise.resolve({ available: true, version: 'stub', authenticated: true }),
  } as EngineAdapter;
}

/** A worktree manager handing out one scratch directory and keeping nothing. */
function scratchWorktrees(dir: string): WorktreeManager {
  return {
    acquire: (jobId) => {
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/**
 * A `fetch` that records every request and lets `fault` answer instead of the
 * real control plane. `fault` returns `undefined` to delegate.
 */
function tracing(
  baseUrl: string,
  fault: (method: string, route: string) => Promise<Response> | undefined,
): { doFetch: typeof fetch; calls: Traced[] } {
  const calls: Traced[] = [];
  const doFetch: typeof fetch = (input, init) => {
    const route = String(input).slice(baseUrl.length);
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    calls.push({
      method,
      route,
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
    });
    return fault(method, route) ?? fetch(input, init);
  };
  return { doFetch, calls };
}

/** The `/finish` calls among the recorded ones. */
function finishes(calls: Traced[]): Array<Record<string, unknown>> {
  return calls
    .filter((call) => call.method === 'PATCH' && /^\/v1\/sessions\/\d+\/finish$/.test(call.route))
    .map((call) => call.body as Record<string, unknown>);
}

function fixtureGraph(className: string, artifact: boolean): Record<string, unknown> {
  const document = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', 'graph-traversal.json'), 'utf8'),
  ) as Record<string, unknown>;
  if (!artifact) return { ...document, problem_class: className };
  const nodes = (document.nodes as Array<Record<string, unknown>>).map((node) =>
    node.id === 'implementar'
      ? {
          ...node,
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

test('t1313 — a throw after the engine ended closes the session as failed, once', async (parent) => {
  const { url: baseUrl, token } = await bootCore(parent);
  let sequence = 13130;

  const area = mkdtempSync(path.join(tmpdir(), 'cartografo-t1313-'));
  parent.after(() => {
    rmSync(area, { recursive: true, force: true });
  });

  /** A job on `implementar`, on a graph of its own when `graph` is set. */
  async function jobOnImplementar(graph: 'none' | 'plain' | 'artifact'): Promise<Work> {
    sequence += 1;
    let graphVersionId: string | undefined;
    if (graph !== 'none') {
      const document = fixtureGraph(`t1313-${String(sequence)}`, graph === 'artifact');
      await resolvePins(baseUrl, token, document);
      const registered = await api<{ graph_version: { id: string } }>(
        baseUrl,
        token,
        'POST',
        '/v1/graphs',
        document,
        201,
      );
      graphVersionId = registered.graph_version.id;
    }
    return await api<Work>(
      baseUrl,
      token,
      'POST',
      '/v1/jobs',
      {
        title: `a job whose tick fails after the engine (${String(sequence)})`,
        entry_node_id: 'implementar',
        execution_id: sequence,
        ...(graphVersionId === undefined ? {} : { graph_version_id: graphVersionId }),
      },
      201,
    );
  }

  function dispatcher(
    route: EngineRoute,
    doFetch: typeof fetch,
    extra: { artifactSpoolRoot?: string } = {},
  ): (jobId: number) => Promise<unknown> {
    return createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      doFetch,
      engines: { 'claude-code': route },
      worktrees: scratchWorktrees(path.join(area, `tree-${String(sequence)}`)),
      resolveInput: () => Promise.resolve({ pedido: 'produce the artifact' }),
      timeoutSeconds: 60,
      ...extra,
    });
  }

  const sessionsOf = async (jobId: number): Promise<SessionRow[]> =>
    (
      await api<{ sessions: SessionRow[] }>(
        baseUrl,
        token,
        'GET',
        `/v1/sessions?job_id=${String(jobId)}`,
      )
    ).sessions;

  // Rewritten by t1340: an upload failure is no longer a post-engine throw. The
  // session closes `completed` with the name declared pending and the file in
  // the runner's spool; every other case of this file keeps the failed closure.
  await parent.test('AT3 — the artifact upload throws: one completed /finish declares it pending', async () => {
    const job = await jobOnImplementar('artifact');
    const uploadFailure = new Error('the artifact store is unreachable');
    const { doFetch, calls } = tracing(baseUrl, (method, route) =>
      method === 'POST' && /\/artifacts$/.test(route) ? Promise.reject(uploadFailure) : undefined,
    );
    const adapter = stubAdapter(linesReporting({ nota: 'ready', relatorio: 'report.md' }), {
      'report.md': 'the report',
    });

    const outcome = (await dispatcher({ adapter, decodeSessionText: decodeShellSessionText }, doFetch, {
      artifactSpoolRoot: path.join(area, `spool-${String(sequence)}`),
    })(job.id)) as { blocked: boolean; reason?: string };
    assert.equal(outcome.blocked, true, 'the dispatch resolves, held on the pending upload');

    assert.ok(
      calls.some((call) => call.method === 'POST' && call.route.endsWith('/artifacts')),
      'the upload was really attempted',
    );
    const closed = finishes(calls);
    assert.equal(closed.length, 1, 'exactly one /finish');
    assert.equal(closed[0].status, 'completed');
    assert.equal(closed[0].exit_code, 0);
    assert.deepEqual(closed[0].output, { nota: 'ready', relatorio: 'report.md' });
    assert.deepEqual(closed[0].pending_artifacts, ['relatorio']);
    assert.ok(!('error' in closed[0]), 'not a compensating closure');

    const [session] = await sessionsOf(job.id);
    assert.equal(session.status, 'completed');
    assert.notEqual(session.finished_at, null);
  });

  await parent.test('AT4 — the session text decoder throws: same closure, same original error', async () => {
    const job = await jobOnImplementar('none');
    const decodeFailure = new SyntaxError('the session text could not be decoded');
    const { doFetch, calls } = tracing(baseUrl, () => undefined);
    const adapter = stubAdapter(linesReporting({ nota: 'ready' }));

    await assert.rejects(
      dispatcher(
        {
          adapter,
          decodeSessionText: () => {
            throw decodeFailure;
          },
        },
        doFetch,
      )(job.id),
      (error: unknown) => error === decodeFailure,
    );

    const closed = finishes(calls);
    assert.equal(closed.length, 1, 'exactly one /finish');
    assert.equal(closed[0].status, 'failed');
    assert.ok(!('output' in closed[0]));
    assert.match(String(closed[0].error), /SyntaxError: the session text could not be decoded/);
    assert.equal(
      closed[0].transcript,
      linesReporting({ nota: 'ready' }).join('\n'),
      'the raw transcript collected so far rides with it',
    );

    const [session] = await sessionsOf(job.id);
    assert.equal(session.status, 'failed');
  });

  await parent.test('AT5 — a throw after finishSession (the transition) produces no second /finish', async () => {
    const job = await jobOnImplementar('plain');
    const transitionFailure = new Error('the transition was lost');
    const { doFetch, calls } = tracing(baseUrl, (method, route) =>
      method === 'POST' && route.endsWith('/transitions') ? Promise.reject(transitionFailure) : undefined,
    );
    const adapter = stubAdapter(linesReporting({ nota: 'ready' }));

    await assert.rejects(
      dispatcher({ adapter, decodeSessionText: decodeShellSessionText }, doFetch)(job.id),
      (error: unknown) => error === transitionFailure,
    );

    assert.ok(
      calls.some((call) => call.method === 'POST' && call.route.endsWith('/transitions')),
      'the advance really reached the transition',
    );
    const closed = finishes(calls);
    assert.equal(closed.length, 1, 'exactly one /finish');
    assert.equal(closed[0].status, 'completed', 'and it is the normal one');
    assert.ok(!('error' in closed[0]), 'the normal closure carries no error key');
  });

  await parent.test('AT6 — a throw before the outcome is known keeps the cancel path, no /finish', async () => {
    const job = await jobOnImplementar('none');
    const lostAnswer = new Error('the answer to POST /v1/sessions was lost');
    // The session row IS written on the control plane, then the answer is lost:
    // a session that opened, with the dispatch failing before it read an outcome.
    const { doFetch, calls } = tracing(baseUrl, (method, route) =>
      method === 'POST' && route === '/v1/sessions'
        ? fetch(`${baseUrl}${route}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(calls.at(-1)?.body),
          }).then(() => Promise.reject(lostAnswer))
        : undefined,
    );
    let cancelled = 0;
    const adapter = stubAdapter(linesReporting({ nota: 'ready' }));
    adapter.cancel = () => {
      cancelled += 1;
      return Promise.resolve();
    };

    await assert.rejects(
      dispatcher({ adapter, decodeSessionText: decodeShellSessionText }, doFetch)(job.id),
      (error: unknown) => error === lostAnswer,
    );

    assert.equal(cancelled, 1, 'the existing path cancelled the engine handle');
    assert.deepEqual(finishes(calls), [], 'no /finish from the post-engine path');
    const sessions = await sessionsOf(job.id);
    assert.equal(sessions.length, 1, 'the session row was written');
  });

  await parent.test('AT7 — when the compensating /finish fails too, the ORIGINAL error propagates', async () => {
    const job = await jobOnImplementar('none');
    const decodeFailure = new Error('the original failure');
    const { doFetch, calls } = tracing(baseUrl, (method, route) =>
      method === 'PATCH' && route.endsWith('/finish')
        ? Promise.reject(new Error('the closure failed as well'))
        : undefined,
    );
    const adapter = stubAdapter(linesReporting({ nota: 'ready' }));

    await assert.rejects(
      dispatcher(
        {
          adapter,
          decodeSessionText: () => {
            throw decodeFailure;
          },
        },
        doFetch,
      )(job.id),
      (error: unknown) => error === decodeFailure,
      'the closure failure never replaces the cause',
    );
    assert.equal(finishes(calls).length, 1, 'the closure was attempted, once');
  });
});
