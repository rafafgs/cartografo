/**
 * Acceptance tests for the repair command of sessions left open (t1313, FR9).
 *
 * Before t1313 a tick that failed after the engine ended never closed its
 * session, and job 2's sessions 25–38 are still `open` on the live board. The
 * script closes such sessions through the API only — never the database — with
 * a dry run as the default and `--yes` as the one way to write.
 *
 * The fake server is an injected `fetch` that records every request, so "no
 * request was sent" is an assertion and not a hope.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'close-stuck-sessions.mjs');

/** Imports the script, failing with its path while it does not exist. */
async function loadScript() {
  assert.ok(existsSync(SCRIPT_PATH), 'artifact does not exist yet: scripts/close-stuck-sessions.mjs');
  return await import(new URL('./close-stuck-sessions.mjs', import.meta.url).href);
}

const ENV = Object.freeze({ CARTOGRAFO_URL: 'http://control.plane:4317', CARTOGRAFO_TOKEN: 'token-abc' });

const OPERATOR_ERROR = 'closed by operator: session left open by a tick that failed after the engine ended';

/** Sessions of job 2 as `GET /v1/sessions?job_id=2` lists them. */
const SESSIONS = Object.freeze([
  { id: 24, job_id: 2, node_id: 'x-artifact', status: 'completed', opened_at: '2026-11-18T10:00:00Z' },
  { id: 25, job_id: 2, node_id: 'x-artifact', status: 'open', opened_at: '2026-11-18T10:01:00Z' },
  { id: 26, job_id: 2, node_id: 'x-artifact', status: 'open', opened_at: '2026-11-18T10:02:00Z' },
  { id: 27, job_id: 2, node_id: 'x-artifact', status: 'failed', opened_at: '2026-11-18T10:03:00Z' },
]);

/** A fake control plane: records each request and answers like the real routes. */
function fakeServer(sessions = SESSIONS) {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    sent.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const target = new URL(String(url));
    if ((init.method ?? 'GET') === 'GET' && target.pathname === '/v1/sessions') {
      const jobId = Number(target.searchParams.get('job_id'));
      return Response.json({ sessions: sessions.filter((session) => session.job_id === jobId) });
    }
    const finish = /^\/v1\/sessions\/(\d+)\/finish$/.exec(target.pathname);
    if (init.method === 'PATCH' && finish !== null) {
      return Response.json({ id: Number(finish[1]), status: 'failed' });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  };
  return { sent, fetchImpl };
}

/** Runs the script's entry point in-process, capturing what it printed. */
async function runScript(argv, env, server) {
  const { run } = await loadScript();
  const out = [];
  const err = [];
  const code = await run(argv, env, {
    fetchImpl: server.fetchImpl,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('t1313 AT13 — arguments: a missing --job, a non-integer id or an incomplete environment exit 2 with no request', async () => {
  const { parseArguments } = await loadScript();

  const parsed = parseArguments(['--job', '2', '--session', '25', '--session', '26', '--project', '3', '--yes'], ENV);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.options, {
    jobId: 2,
    sessionIds: [25, 26],
    projectId: 3,
    yes: true,
    url: 'http://control.plane:4317',
    token: 'token-abc',
  });

  const defaults = parseArguments(['--job', '2'], ENV);
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.options.sessionIds, []);
  assert.equal(defaults.options.projectId, null);
  assert.equal(defaults.options.yes, false, 'a dry run is the default');

  const refusals = [
    [[], ENV, '--job'],
    [['--job'], ENV, '--job'],
    [['--job', 'two'], ENV, '--job'],
    [['--job', '2.5'], ENV, '--job'],
    [['--job', '0'], ENV, '--job'],
    [['--job', '2', '--session', 'x'], ENV, '--session'],
    [['--job', '2', '--project', '-1'], ENV, '--project'],
    [['--job', '2', '--force'], ENV, '--force'],
    [['--job', '2'], { CARTOGRAFO_TOKEN: 'token-abc' }, 'CARTOGRAFO_URL'],
    [['--job', '2'], { CARTOGRAFO_URL: 'http://control.plane:4317' }, 'CARTOGRAFO_TOKEN'],
    [['--job', '2'], { CARTOGRAFO_URL: '', CARTOGRAFO_TOKEN: 'token-abc' }, 'CARTOGRAFO_URL'],
  ];
  for (const [argv, env, named] of refusals) {
    const result = parseArguments(argv, env);
    assert.equal(result.ok, false, `refused: ${argv.join(' ')}`);
    assert.ok(result.message.includes(named), `the message names ${named}: ${result.message}`);

    const server = fakeServer();
    const ran = await runScript(argv, env, server);
    assert.equal(ran.code, 2, `exit 2 for: ${argv.join(' ')}`);
    assert.deepEqual(server.sent, [], 'no request was sent');
  }

  // And through the real CLI entry point, where no fake fetch is in play.
  const cli = spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(cli.status, 2, `stderr:\n${cli.stderr}`);
  assert.match(cli.stderr, /--job/);
});

test('t1313 AT14 — selection: only open sessions of the job, narrowed by --session, all-or-nothing', async () => {
  const { selectSessions } = await loadScript();

  const all = selectSessions(SESSIONS, 2, []);
  assert.equal(all.ok, true);
  assert.deepEqual(all.selected.map((session) => session.id), [25, 26]);

  const narrowed = selectSessions(SESSIONS, 2, [26]);
  assert.deepEqual(narrowed.selected.map((session) => session.id), [26]);

  const foreign = [...SESSIONS, { id: 90, job_id: 3, node_id: 'n', status: 'open', opened_at: 'x' }];
  assert.deepEqual(
    selectSessions(foreign, 2, []).selected.map((session) => session.id),
    [25, 26],
    'a session of another job is never chosen, even if the listing carried one',
  );

  for (const bad of [[24], [27], [90], [25, 999]]) {
    const refused = selectSessions(foreign, 2, bad);
    assert.equal(refused.ok, false, `refused: --session ${bad.join(' ')}`);
    assert.match(refused.message, /not an open session of job 2/);
  }

  // Through the entry point: the refusal happens after the read and before any write.
  const server = fakeServer();
  const ran = await runScript(['--job', '2', '--session', '25', '--session', '27', '--yes'], ENV, server);
  assert.equal(ran.code, 2);
  assert.deepEqual(
    server.sent.map((request) => request.method),
    ['GET'],
    'nothing but the read was sent',
  );
});

test('t1313 AT15 — a dry run only reads; --yes sends one closure per selected session', async () => {
  const { closureBody } = await loadScript();
  assert.deepEqual(closureBody(), {
    status: 'failed',
    exit_code: null,
    timeout_reason: null,
    transcript: '',
    error: OPERATOR_ERROR,
  });

  const dry = fakeServer();
  const preview = await runScript(['--job', '2'], ENV, dry);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(dry.sent.length, 1, 'one request');
  assert.equal(dry.sent[0].method, 'GET');
  assert.equal(dry.sent[0].url, 'http://control.plane:4317/v1/sessions?job_id=2');
  assert.equal(dry.sent[0].headers.authorization, 'Bearer token-abc');
  assert.match(preview.stdout, /\b25\b/);
  assert.match(preview.stdout, /\b26\b/);
  assert.doesNotMatch(preview.stdout, /\b24\b|\b27\b/, 'closed sessions are not listed');
  assert.match(preview.stdout, /--yes/, 'the dry run says how to really close them');

  const scoped = fakeServer();
  await runScript(['--job', '2', '--project', '3'], ENV, scoped);
  assert.equal(scoped.sent[0].url, 'http://control.plane:4317/v1/sessions?job_id=2&project_id=3');

  const real = fakeServer();
  const closed = await runScript(['--job', '2', '--yes'], ENV, real);
  assert.equal(closed.code, 0, closed.stderr);
  const writes = real.sent.filter((request) => request.method !== 'GET');
  assert.deepEqual(
    writes.map((request) => [request.method, new URL(request.url).pathname]),
    [
      ['PATCH', '/v1/sessions/25/finish'],
      ['PATCH', '/v1/sessions/26/finish'],
    ],
    'one PATCH per open session, none for sessions already closed',
  );
  for (const request of writes) {
    assert.deepEqual(request.body, closureBody());
    assert.equal(request.headers.authorization, 'Bearer token-abc');
    assert.equal(request.headers['content-type'], 'application/json');
  }
  assert.equal(closed.stdout.split('\n').filter((line) => /closed session/.test(line)).length, 2);

  const none = fakeServer(SESSIONS.filter((session) => session.status !== 'open'));
  const nothing = await runScript(['--job', '2', '--yes'], ENV, none);
  assert.equal(nothing.code, 0);
  assert.deepEqual(none.sent.map((request) => request.method), ['GET'], 'nothing open, nothing written');
});
