/**
 * Acceptance tests of the API's bearer-token gate (t124, FR3/FR8).
 *
 * `POST /v1/jobs` stands in for the whole business surface on purpose: the hook
 * is registered ONCE on the `/v1` scope, so a route family is not what is under
 * test here — the scope is. What each case pins is the difference between the
 * two refusals: a request that never presented a credential
 * (`missing_credential`) and one that presented an unusable one
 * (`invalid_credential`). Collapsing the two into a single message would leave
 * whoever has a stale token unable to tell "I forgot the header" from "my token
 * no longer works".
 *
 * `GET /health` is the fifth case and the reason the hook is scoped instead of
 * global: a supervisor has to be able to poll liveness before any credential
 * exists anywhere.
 *
 * Since t226 the three bodies are the one envelope of the whole `/v1` surface —
 * `{error, message}` — and the three codes are the rows the same ticket added to
 * `docs/spec/glossario-wire.md` §1.4 under FR6, following the `invalid_X` /
 * `missing_X` naming that section already used. These are the only refusals
 * EVERY client can receive, which is why they are pinned by value here and not
 * merely by status.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, startControlPlane, type TestContext } from './support.ts';

/** An answer, already decoded, from a request built header by header. */
interface RawResponse {
  status: number;
  body: { error?: string; message?: string; id?: number };
}

/**
 * Speaks HTTP with the control plane WITHOUT the harness's default credential.
 *
 * `test/support.ts`'s `request()` attaches the bootstrap token for every other
 * suite in the package; this file is the one that must be able to leave it out,
 * or send something deliberately wrong.
 *
 * @param ctx Control plane running.
 * @param routePath Path, already carrying the `/v1` prefix.
 * @param authorization Value of the `Authorization` header; omitted when absent.
 * @returns Status and decoded body.
 */
async function raw(
  ctx: TestContext,
  routePath: string,
  authorization?: string,
): Promise<RawResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (authorization !== undefined) headers.authorization = authorization;

  const response = await fetch(`${ctx.url}${routePath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'authenticated job', entry_node_id: 'refinar' }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as RawResponse['body'],
  };
}

test('t124 AT — a /v1 request with no Authorization header is denied with missing_credential', async (t) => {
  const ctx = await startControlPlane(t);

  const denied = await raw(ctx, '/v1/jobs');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error, 'missing_credential');
  assert.equal(typeof denied.body.message, 'string');
  assert.ok((denied.body.message ?? '').length > 0, 'the refusal says what to do about it');

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM job').get() as { total: number };
  assert.equal(rows.total, 0, 'a denied request writes nothing');
});

test('t124 AT — a malformed Authorization header is the same refusal as none at all', async (t) => {
  const ctx = await startControlPlane(t);

  for (const header of ['not-bearer-shaped', 'Basic abc123', 'Bearer', 'Bearer ', ctx.token]) {
    const denied = await raw(ctx, '/v1/jobs', header);
    assert.equal(denied.status, 401, `"${header}" is not a well-formed credential`);
    assert.equal(denied.body.error, 'missing_credential');
  }
});

test('t124 AT — a well-formed header carrying an unknown token is invalid_credential', async (t) => {
  const ctx = await startControlPlane(t);

  const denied = await raw(ctx, '/v1/jobs', 'Bearer garbage');
  assert.equal(denied.status, 401);
  assert.equal(
    denied.body.error,
    'invalid_credential',
    'presenting a credential that does not resolve is a different failure from presenting none',
  );
});

test('t124 AT — a valid token reaches the handler and the route behaves exactly as before', async (t) => {
  const ctx = await startControlPlane(t);

  const created = await raw(ctx, '/v1/jobs', `Bearer ${ctx.token}`);
  assert.equal(created.status, 201, 'an authenticated write is the same write it always was');
  assert.equal(typeof created.body.id, 'number');

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM job').get() as { total: number };
  assert.equal(rows.total, 1);

  // Case-insensitive scheme: `Authorization: bearer <token>` is the same header.
  const again = await raw(ctx, '/v1/jobs', `bearer ${ctx.token}`);
  assert.equal(again.status, 201, 'the scheme name is not case sensitive (RFC 7235)');
});

/* -------------------------------------------------------------------------- */
/* t143 — authorization: a runner credential opens the runner's surface only.  */
/* -------------------------------------------------------------------------- */

/**
 * One request, built verb by verb, with the credential handed in explicitly.
 *
 * `raw()` above is POST-only and carries a job body; this ticket needs the same
 * credential presented to different verbs and routes, which is exactly what
 * separates "authenticated" from "authorized".
 *
 * @param ctx Control plane running.
 * @param method HTTP verb.
 * @param routePath Path, already carrying the `/v1` prefix.
 * @param token Raw token to present.
 * @param body JSON body, when the route takes one.
 * @returns Status and decoded body.
 */
async function call(
  ctx: TestContext,
  method: string,
  routePath: string,
  token: string,
  body?: unknown,
): Promise<RawResponse> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${ctx.url}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as RawResponse['body'],
  };
}

/** Pairs a runner with the operator credential and returns its own token (t143, FR1). */
async function pairedRunnerToken(ctx: TestContext, id: string): Promise<string> {
  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', { id });
  assert.equal(paired.status, 201);
  assert.equal(typeof paired.body.token, 'string', 'pairing is where a runner credential comes from');
  return paired.body.token ?? '';
}

test('t143 AT — a runner credential is refused outside its route family', async (t) => {
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const denied = await call(ctx, 'POST', '/v1/jobs', token, {
    title: 'a job a runner does not create',
    entry_node_id: 'refinar',
  });
  assert.equal(denied.status, 403, 'authenticated is not authorized: the token is valid and refused');
  assert.equal(denied.body.error, 'out_of_scope_credential');
  assert.ok((denied.body.message ?? '').length > 0, 'the refusal says what the credential may do');

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM job').get() as { total: number };
  assert.equal(rows.total, 0, 'a refused request writes nothing');

  const allowed = await call(ctx, 'GET', '/v1/jobs', token);
  assert.equal(allowed.status, 200, 'the same credential reads the queue: that is its whole job');
});

test('t143 AT — a runner credential cannot revoke, not even its own', async (t) => {
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const denied = await call(ctx, 'POST', '/v1/runners/runner-a/revocations', token);
  assert.equal(
    denied.status,
    403,
    'decommissioning a runner is the operator\'s act; a compromised runner does not get to hide',
  );
  assert.equal(denied.body.error, 'out_of_scope_credential');

  const stillAlive = await call(ctx, 'GET', '/v1/jobs', token);
  assert.equal(stillAlive.status, 200, 'the refused revocation did not revoke anything');
});

test('t143 AT — a runner credential cannot pair another runner', async (t) => {
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const denied = await call(ctx, 'POST', '/v1/runners', token, { id: 'runner-inventado' });
  assert.equal(denied.status, 403, 'a runner never pairs itself, nor anybody else (FR1/FR2)');
  assert.equal(denied.body.error, 'out_of_scope_credential');
});

test('t124 AT — GET /health keeps answering with no credential at all', async (t) => {
  const ctx = await startControlPlane(t);

  const response = await fetch(`${ctx.url}/health`);
  assert.equal(response.status, 200, 'the liveness probe is polled before any credential exists');
  assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });
});

/* -------------------------------------------------------------------------- */
/* t180 — the three refusals of the gate, in the words a person reads.         */
/*                                                                            */
/* Pinned whole, not by length: a refusal that says nothing useful is exactly  */
/* as long as one that does, and the point of these bodies is that whoever     */
/* reads them knows what to do next.                                          */
/* -------------------------------------------------------------------------- */

test('t180 — the two 401 bodies say, in English, what to do about them', async (t) => {
  const ctx = await startControlPlane(t);

  const missing = await raw(ctx, '/v1/jobs');
  assert.equal(missing.status, 401);
  assert.equal(
    missing.body.message,
    'this route requires `Authorization: Bearer <token>` — use the token printed when the control plane starts (CARTOGRAFO_TOKEN, or --token on the command)',
  );

  const dead = await raw(ctx, '/v1/jobs', 'Bearer garbage');
  assert.equal(dead.status, 401);
  assert.equal(
    dead.body.message,
    'the credential presented is no longer valid (unknown or revoked) — ask whoever administers this control plane for another one',
  );
});

test('t180 — the 403 of a runner outside its surface names the surface in English', async (t) => {
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const denied = await call(ctx, 'POST', '/v1/jobs', token, {
    title: 'a job a runner does not create',
    entry_node_id: 'refinar',
  });

  assert.equal(denied.status, 403);
  // The message spells the whole surface, so it moves whenever the allowlist
  // does — which is the point of writing it out: widening the runner's reach
  // shows up here, in a diff somebody reads. `POST /v1/engines/:name/models`
  // joined it in t166.
  assert.equal(
    denied.body.message,
    'a runner credential reaches only GET /v1/jobs, POST /v1/leases, POST /v1/leases/:id/heartbeats, POST /v1/leases/:id/releases, GET /v1/leases, POST /v1/engines/:name/models — "POST /v1/jobs" requires a user credential',
  );
});
