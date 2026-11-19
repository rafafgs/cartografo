/**
 * Acceptance tests of the abandoned-attempt cap, seen from the runner (t1312,
 * AT12–AT13).
 *
 * AT12 replays the t1311 incident with an injected fault: the engine session
 * completes, then the runner fails a write it owes AFTER the session (the
 * finish PATCH answers 500), so the session is never closed and the tick
 * throws. Before t1312 every following tick leased the same job again and
 * opened one more paid session. Now the control plane counts those abandoned
 * attempts at the lease grant and blocks the job at the cap.
 *
 * AT13 pins the controller's half: the two new refusals (`retry_backoff`,
 * `retry_cap_reached`) mean "try the next candidate", never "stop the pass",
 * and never an exception.
 *
 * The real control plane runs as a child process (`bootCore`), as in
 * `dispatch-and-lease.e2e.test.ts`; the runner imports nothing from the core.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { ControlPlaneClient, type LeaseGrantResponse } from '../../src/controller/control-plane-client.ts';
import { Controller } from '../../src/controller/controller.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The cap when the job has no graph version to declare one. */
const DEFAULT_CAP = 3;

interface JobRead {
  id: number;
  blocked: boolean;
  block_reason: string | null;
}

interface SessionRead {
  id: number;
  node_id: string | null;
  status: string;
}

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

/** A worktree manager that hands out plain directories: no git is needed here. */
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

test('t1312 AT12 — a failure after a completed session stops at the cap, then nothing opens', async (t) => {
  const { url: baseUrl, token } = await bootCore(t, {
    env: { CARTOGRAFO_RETRY_BACKOFF_SECONDS: '0' },
  });

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t1312-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const job = await api<JobRead>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    { title: 'the job whose finish write never lands', entry_node_id: 'implementar' },
    201,
  );

  const client = new ControlPlaneClient({ urlBase: baseUrl, token });
  await client.registerRunner('runner-t1312', 'the one whose writes fail after the session');

  // The injected fault: the engine session runs and completes, and then the
  // closure the runner owes is refused. The session row stays `open`.
  const doFetch: typeof fetch = async (input, init) => {
    if (
      (init?.method ?? 'GET') === 'PATCH' &&
      /\/v1\/sessions\/\d+\/finish$/.test(String(input))
    ) {
      return new Response('{"error":"injected"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fetch(input, init);
  };

  const dispatch = createClaudeCodeDispatch({
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
    worktrees: directoryWorktrees(root),
    timeoutSeconds: 60,
    envOverrides: {
      FAKE_ENGINE_LINES: JSON.stringify([{ stream: 'stdout', text: 'I did the work.' }]),
    },
  });

  const controller = new Controller({
    client,
    runnerId: 'runner-t1312',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    dispatch,
  });

  const sessions = async (): Promise<SessionRead[]> =>
    (
      await api<{ sessions: SessionRead[] }>(
        baseUrl,
        token,
        'GET',
        `/v1/sessions?job_id=${String(job.id)}`,
      )
    ).sessions;

  // Tick after tick, the way `runRunner` drives it: a tick that throws is logged
  // and the loop goes on.
  const thrown: unknown[] = [];
  const results: Array<unknown> = [];
  for (let tick = 0; tick < DEFAULT_CAP + 3; tick += 1) {
    try {
      results.push(await controller.tick());
    } catch (error: unknown) {
      thrown.push(error);
      results.push('threw');
    }
  }

  const opened = await sessions();
  assert.equal(opened.length, DEFAULT_CAP, `exactly the cap of sessions opened: ${JSON.stringify(opened)}`);
  assert.ok(opened.every((session) => session.status === 'open' && session.node_id === 'implementar'));
  assert.equal(thrown.length, DEFAULT_CAP, 'each abandoned attempt threw, and nothing after it');
  assert.deepEqual(
    results.slice(DEFAULT_CAP),
    [null, null, null],
    'once capped, ticks dispatch nothing and do not throw',
  );

  const read = await api<JobRead>(baseUrl, token, 'GET', `/v1/jobs/${String(job.id)}`);
  assert.equal(read.blocked, true);
  const reason = read.block_reason ?? '';
  assert.ok(reason.includes('implementar'), `the reason names the node: ${reason}`);
  assert.ok(reason.includes(String(DEFAULT_CAP)), `the reason carries the count: ${reason}`);
  const last = opened.reduce((a, b) => (a.id > b.id ? a : b));
  assert.ok(reason.includes(String(last.id)), `the reason names the last session: ${reason}`);
  assert.ok(reason.includes('runner log'), `the reason points at the runner log: ${reason}`);

  // And it stays that way: further ticks open nothing.
  assert.equal(await controller.tick(), null);
  assert.equal((await sessions()).length, DEFAULT_CAP);
});

/**
 * A client whose control plane is a stub: two candidates, and a lease answer
 * chosen per job.
 *
 * @param answers What `POST /v1/leases` answers for each job id.
 */
function stubClient(answers: Record<number, LeaseGrantResponse>): {
  client: ControlPlaneClient;
  leaseAsks: number[];
} {
  const leaseAsks: number[] = [];
  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const doFetch: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/jobs') {
      const job = (id: number): Record<string, unknown> => ({
        id,
        title: `job ${String(id)}`,
        current_node_id: 'implementar',
        blocked: false,
        completed: false,
        execution_id: 9,
        graph_version_id: 'sha256:abc',
      });
      return Promise.resolve(respond(200, { jobs: [job(1), job(2)] }));
    }
    if (url.pathname === '/v1/leases' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { job_id: number };
      leaseAsks.push(body.job_id);
      const answer = answers[body.job_id];
      return Promise.resolve(respond(answer.lease === null ? 200 : 201, answer));
    }
    if (/^\/v1\/leases\/\d+\/(releases|heartbeats)$/.test(url.pathname)) {
      return Promise.resolve(respond(200, { lease: answers[2].lease }));
    }
    return Promise.resolve(respond(404, { error: 'not_found' }));
  };

  return {
    client: new ControlPlaneClient({ urlBase: 'http://127.0.0.1:4317', fetchImpl: doFetch }),
    leaseAsks,
  };
}

const LEASE_ON_TWO: LeaseGrantResponse = {
  lease: {
    id: 12,
    runner_id: 'runner-a',
    job_id: 2,
    project_id: 1,
    status: 'active',
    ttl_seconds: 6,
    granted_at: '2026-11-19T12:00:00.000Z',
    heartbeat_at: '2026-11-19T12:00:00.000Z',
    expires_at: '2026-11-19T12:00:06.000Z',
    released_at: null,
    expiration_reason: null,
  },
};

test('t1312 AT13 — retry_backoff and retry_cap_reached move on to the next candidate', async () => {
  const refusals: LeaseGrantResponse[] = [
    { lease: null, reason: 'retry_backoff', retry_after: '2026-11-19T12:01:00.000Z' },
    { lease: null, reason: 'retry_cap_reached' },
  ];

  for (const refusal of refusals) {
    const { client, leaseAsks } = stubClient({ 1: refusal, 2: LEASE_ON_TWO });
    const dispatched: number[] = [];
    const controller = new Controller({
      client,
      runnerId: 'runner-a',
      projectId: 1,
      runnerCap: 1,
      projectCap: 4,
      ttlSeconds: 6,
      dispatch: (jobId) => {
        dispatched.push(jobId);
        return Promise.resolve({ blocked: false });
      },
    });

    const result = await controller.tick();
    assert.deepEqual(leaseAsks, [1, 2], `${String(refusal.reason)}: the second candidate was asked`);
    assert.deepEqual(dispatched, [2], `${String(refusal.reason)}: and dispatched`);
    assert.deepEqual(result, { jobId: 2, leaseId: 12 });
  }
});

test('t1312 AT13 — a runner_cap answer still ends the pass', async () => {
  const { client, leaseAsks } = stubClient({
    1: { lease: null, reason: 'runner_cap' },
    2: LEASE_ON_TWO,
  });
  const dispatched: number[] = [];
  const controller = new Controller({
    client,
    runnerId: 'runner-a',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 6,
    dispatch: (jobId) => {
      dispatched.push(jobId);
      return Promise.resolve({ blocked: false });
    },
  });

  assert.equal(await controller.tick(), null);
  assert.deepEqual(leaseAsks, [1], 'a full cap is not worth asking the next candidate');
  assert.deepEqual(dispatched, []);
});
