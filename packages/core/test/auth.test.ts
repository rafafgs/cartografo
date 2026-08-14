/**
 * Acceptance tests of the API's bearer-token gate (t124, FR3/FR8).
 *
 * `POST /v1/jobs` stands in for the whole business surface on purpose: the hook
 * is registered ONCE on the `/v1` scope, so a route family is not what is under
 * test here — the scope is. What each case pins is the difference between the
 * two refusals: a request that never presented a credential (`credencial_ausente`)
 * and one that presented an unusable one (`credencial_invalida`). Collapsing the
 * two into a single message would leave whoever has a stale token unable to tell
 * "I forgot the header" from "my token no longer works".
 *
 * `GET /health` is the fifth case and the reason the hook is scoped instead of
 * global: a supervisor has to be able to poll liveness before any credential
 * exists anywhere.
 *
 * The `erro` values are the wire contract, in Portuguese like every other error
 * code the API answers with (t127, FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startControlPlane, type TestContext } from './support.ts';

/** An answer, already decoded, from a request built header by header. */
interface RawResponse {
  status: number;
  body: { erro?: string; mensagem?: string; id?: number };
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
    body: JSON.stringify({ titulo: 'trabalho autenticado', no_entrada_id: 'refinar' }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as RawResponse['body'],
  };
}

test('t124 AT — a /v1 request with no Authorization header is denied with credencial_ausente', async (t) => {
  const ctx = await startControlPlane(t);

  const denied = await raw(ctx, '/v1/jobs');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.erro, 'credencial_ausente');
  assert.equal(typeof denied.body.mensagem, 'string');
  assert.ok((denied.body.mensagem ?? '').length > 0, 'the refusal says what to do about it');

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM trabalho').get() as { total: number };
  assert.equal(rows.total, 0, 'a denied request writes nothing');
});

test('t124 AT — a malformed Authorization header is the same refusal as none at all', async (t) => {
  const ctx = await startControlPlane(t);

  for (const header of ['not-bearer-shaped', 'Basic abc123', 'Bearer', 'Bearer ', ctx.token]) {
    const denied = await raw(ctx, '/v1/jobs', header);
    assert.equal(denied.status, 401, `"${header}" is not a well-formed credential`);
    assert.equal(denied.body.erro, 'credencial_ausente');
  }
});

test('t124 AT — a well-formed header carrying an unknown token is credencial_invalida', async (t) => {
  const ctx = await startControlPlane(t);

  const denied = await raw(ctx, '/v1/jobs', 'Bearer garbage');
  assert.equal(denied.status, 401);
  assert.equal(
    denied.body.erro,
    'credencial_invalida',
    'presenting a credential that does not resolve is a different failure from presenting none',
  );
});

test('t124 AT — a valid token reaches the handler and the route behaves exactly as before', async (t) => {
  const ctx = await startControlPlane(t);

  const created = await raw(ctx, '/v1/jobs', `Bearer ${ctx.token}`);
  assert.equal(created.status, 201, 'an authenticated write is the same write it always was');
  assert.equal(typeof created.body.id, 'number');

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM trabalho').get() as { total: number };
  assert.equal(rows.total, 1);

  // Case-insensitive scheme: `Authorization: bearer <token>` is the same header.
  const again = await raw(ctx, '/v1/jobs', `bearer ${ctx.token}`);
  assert.equal(again.status, 201, 'the scheme name is not case sensitive (RFC 7235)');
});

test('t124 AT — GET /health keeps answering with no credential at all', async (t) => {
  const ctx = await startControlPlane(t);

  const response = await fetch(`${ctx.url}/health`);
  assert.equal(response.status, 200, 'the liveness probe is polled before any credential exists');
  assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });
});
