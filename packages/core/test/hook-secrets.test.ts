/**
 * Acceptance tests of the deployment-owned hook secret store (t194).
 *
 * A hook's `destination` carries a NAME since this ticket, never a value, and
 * this file is the other half of that move: the place the value actually lives.
 * `segredo_gancho` is a table of the deployment, written through an
 * authenticated route, and it is deliberately shaped like `assinatura_webhook`
 * rather than like graph content — a credential that travels inside a versioned,
 * exported, content-addressed document is a credential every reader of the
 * document has.
 *
 * Two properties are asserted on every response that carries a secret, and they
 * are why the suite exists apart from the enqueue and dispatch ones:
 *
 * - **`valor` never comes back.** Not because a field is stripped on the way
 *   out, but because the view these routes return has no place to put it — the
 *   guarantee `POST /v1/webhooks` and `issueCredential` already give. The
 *   assertion is on the raw JSON text, not on a parsed field: a nested copy
 *   would slip past `body.valor`.
 * - **Nothing is deleted.** `DELETE` sets `revogada_em`, mirroring
 *   `credencial.revoked_at` and `assinatura_webhook.desativada_em`, and
 *   rotating writes a NEW row instead of overwriting the old one (D15/D2).
 *
 * The repository is called directly for the two questions the wire cannot ask:
 * "what does this name resolve to right now" is precisely the read the API has
 * no path for, so it is checked where the read exists.
 *
 * The JSON field names stay in Portuguese: they mirror the migration's columns,
 * which the D18 rename does not translate (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { Database } from '../src/db/connection.ts';
import {
  PACKAGE_ROOT,
  request,
  requireArtifacts,
  startControlPlane,
  type TestContext,
} from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T194_ARTIFACTS = Object.freeze({
  migration: 'migrations/0018_segredo_gancho.sql',
  repository: 'src/repositories/hook-secrets.ts',
  routes: 'src/routes/hook-secrets.ts',
  server: 'src/server.ts',
});

/** A named secret, as the API shows it — `valor` is not part of the shape. */
interface HookSecret {
  name: string;
  created_at: string;
  revoked_at: string | null;
}

/** What `PUT` answers: the name and when THIS registration was written. */
interface RegisteredSecret {
  name: string;
  created_at: string;
}

/** The error envelope of `src/routes/common.ts`. */
interface ErrorBody {
  error: string;
  details?: string[];
}

/** The `{erro, mensagem}` body the credential gate answers with. */
interface GateBody {
  error?: string;
  message?: string;
}

/** The surface `src/repositories/hook-secrets.ts` has to expose. */
interface HookSecretsModule {
  resolveHookSecret: (db: Database, name: string) => string | undefined;
}

const NAME = 'gancho-revisao';
const VALUE = 'chave-hmac-do-gancho-194';
const ROTATED = 'chave-hmac-rotacionada-194';

/**
 * Loads the repository on demand, naming the file on the initial red.
 *
 * Same reason as `test/support.ts:8-11`: a module-resolution error at import
 * time looks like any other bug, and the first run of this suite is supposed to
 * say which artifact does not exist yet.
 */
async function loadRepository(): Promise<HookSecretsModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, T194_ARTIFACTS.repository)),
    `artifact does not exist yet: packages/core/${T194_ARTIFACTS.repository}`,
  );
  return (await import('../src/repositories/hook-secrets.ts')) as HookSecretsModule;
}

/** Fails when the raw JSON carries the value, or names its field, at any depth. */
function assertNoValue(body: unknown, ...values: string[]): void {
  const text = JSON.stringify(body);
  assert.ok(!text.includes('valor'), `the response must not name the value field: ${text}`);
  for (const value of values) {
    assert.ok(!text.includes(value), `the response must not carry the secret: ${text}`);
  }
}

/**
 * One request with the credential handed in explicitly.
 *
 * `request()` always presents the context's operator token, which is exactly
 * what the runner-credential test cannot use.
 */
async function call<T>(
  ctx: TestContext,
  method: string,
  routePath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${ctx.url}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}

test('AT1 — PUT /v1/hook-secrets/:name registers a secret and never echoes the value', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const response = await request<RegisteredSecret>(ctx, 'PUT', `/v1/hook-secrets/${NAME}`, {
    value: VALUE,
  });

  assert.equal(response.status, 201, 'the first registration of a name creates it');
  assert.equal(response.body.name, NAME);
  assert.equal(typeof response.body.created_at, 'string');
  assertNoValue(response.body, VALUE);

  const { resolveHookSecret } = await loadRepository();
  assert.equal(
    resolveHookSecret(ctx.db, NAME),
    VALUE,
    'what the route stored is what the enqueue will resolve',
  );
});

test('AT2 — a second PUT rotates the secret, and the new value is what resolves', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);
  const { resolveHookSecret } = await loadRepository();

  const first = await request<RegisteredSecret>(ctx, 'PUT', `/v1/hook-secrets/${NAME}`, {
    value: VALUE,
  });
  assert.equal(first.status, 201);

  const second = await request<RegisteredSecret>(ctx, 'PUT', `/v1/hook-secrets/${NAME}`, {
    value: ROTATED,
  });
  assert.equal(second.status, 200, 'rotating an existing name is not a creation');
  assert.equal(second.body.name, NAME);
  assertNoValue(second.body, VALUE, ROTATED);

  assert.equal(
    resolveHookSecret(ctx.db, NAME),
    ROTATED,
    'a rotation takes effect on the very next delivery, with no restart',
  );

  // The old value is not merely unreachable through the API: it stopped being
  // the live one, which is what "rotating" has to mean for a key in use.
  const live = ctx.db
    .prepare('SELECT COUNT(*) AS total FROM hook_secret WHERE name = ? AND revoked_at IS NULL')
    .get(NAME) as { total: number };
  assert.equal(live.total, 1, 'at most one live row per name, ever');

  const rows = ctx.db
    .prepare('SELECT COUNT(*) AS total FROM hook_secret WHERE name = ?')
    .get(NAME) as { total: number };
  assert.equal(rows.total, 2, 'the revoked registration stays: nothing is deleted (D15/D2)');
});

test('AT3 — an empty value, a missing value or a name outside the charset is a 400', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const refused = async (routePath: string, body: Record<string, unknown>): Promise<ErrorBody> => {
    const response = await request<ErrorBody>(ctx, 'PUT', routePath, body);
    assert.equal(response.status, 400, `expected 400 for ${routePath} ${JSON.stringify(body)}`);
    assert.equal(response.body.error, 'validation_failed');
    assert.ok(
      Array.isArray(response.body.details) && response.body.details.length > 0,
      'the 400 says what is wrong',
    );
    return response.body;
  };

  await refused(`/v1/hook-secrets/${NAME}`, {});
  await refused(`/v1/hook-secrets/${NAME}`, { value: '' });
  await refused(`/v1/hook-secrets/${NAME}`, { value: 42 });

  // The same charset a node id and `secret_ref` are constrained to: the name has
  // to round-trip through a URL path and through the graph document alike.
  await refused('/v1/hook-secrets/Gancho', { value: VALUE });
  await refused('/v1/hook-secrets/-comeca-com-hifen', { value: VALUE });
  await refused('/v1/hook-secrets/com.ponto', { value: VALUE });
  await refused('/v1/hook-secrets/with%20space', { value: VALUE });

  const list = await request<{ secrets: HookSecret[] }>(ctx, 'GET', '/v1/hook-secrets');
  assert.deepEqual(list.body.secrets, [], 'a refused registration writes nothing');
});

test('AT4 — GET /v1/hook-secrets lists the names, oldest first, with no value anywhere', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const registered = await request<RegisteredSecret>(ctx, 'PUT', `/v1/hook-secrets/${NAME}`, {
    value: VALUE,
  });
  assert.equal(registered.status, 201);
  const other = await request<RegisteredSecret>(ctx, 'PUT', '/v1/hook-secrets/gancho-bloqueio', {
    value: 'outra-chave-194',
  });
  assert.equal(other.status, 201);

  const list = await request<{ secrets: HookSecret[] }>(ctx, 'GET', '/v1/hook-secrets');
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.secrets.map((secret) => secret.name),
    [NAME, 'gancho-bloqueio'],
    'oldest first',
  );
  for (const secret of list.body.secrets) {
    assert.equal(typeof secret.created_at, 'string');
    assert.equal(secret.revoked_at, null, 'a fresh registration is live');
  }
  assertNoValue(list.body, VALUE, 'outra-chave-194');
});

test('AT5 — DELETE revokes, is idempotent, and 404s on a name nobody registered', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const created = await request<RegisteredSecret>(ctx, 'PUT', `/v1/hook-secrets/${NAME}`, {
    value: VALUE,
  });
  assert.equal(created.status, 201);

  const revoked = await request<HookSecret>(ctx, 'DELETE', `/v1/hook-secrets/${NAME}`);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.name, NAME);
  assert.equal(typeof revoked.body.revoked_at, 'string');
  assertNoValue(revoked.body, VALUE);

  const again = await request<HookSecret>(ctx, 'DELETE', `/v1/hook-secrets/${NAME}`);
  assert.equal(again.status, 200, 'revoking twice is not an error');
  assert.equal(
    again.body.revoked_at,
    revoked.body.revoked_at,
    'the second call does not move the instant of the first',
  );

  // Nothing was physically deleted: the row is still listed, now revoked.
  const list = await request<{ secrets: HookSecret[] }>(ctx, 'GET', '/v1/hook-secrets');
  assert.deepEqual(
    list.body.secrets.map((secret) => secret.name),
    [NAME],
  );
  assert.equal(list.body.secrets[0].revoked_at, revoked.body.revoked_at);

  const unknown = await request<ErrorBody>(ctx, 'DELETE', '/v1/hook-secrets/nunca-registrado');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');
  assert.ok(
    Array.isArray(unknown.body.details) && unknown.body.details.length > 0,
    'the 404 says what does not exist',
  );
});

test('AT6 — a revoked secret resolves to nothing at all', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);
  const { resolveHookSecret } = await loadRepository();

  const created = await request<RegisteredSecret>(ctx, 'PUT', `/v1/hook-secrets/${NAME}`, {
    value: VALUE,
  });
  assert.equal(created.status, 201);
  assert.equal(resolveHookSecret(ctx.db, NAME), VALUE);

  const revoked = await request<HookSecret>(ctx, 'DELETE', `/v1/hook-secrets/${NAME}`);
  assert.equal(revoked.status, 200);

  assert.equal(
    resolveHookSecret(ctx.db, NAME),
    undefined,
    'a revoked name is the same answer as a name that never existed',
  );
  assert.equal(resolveHookSecret(ctx.db, 'nunca-registrado'), undefined);
});

test('AT7 — a runner credential is out of scope on all three routes', async (t) => {
  requireArtifacts(T194_ARTIFACTS.migration, T194_ARTIFACTS.routes, T194_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', {
    id: 'runner-a',
  });
  assert.equal(paired.status, 201);
  const token = paired.body.token ?? '';
  assert.notEqual(token, '', 'pairing is where a runner credential comes from');

  const denied = async (method: string, routePath: string, body?: unknown): Promise<void> => {
    const response = await call<GateBody>(ctx, method, routePath, token, body);
    assert.equal(response.status, 403, `${method} ${routePath} has to refuse a runner`);
    assert.equal(response.body.error, 'out_of_scope_credential');
  };

  await denied('PUT', `/v1/hook-secrets/${NAME}`, { value: VALUE });
  await denied('GET', '/v1/hook-secrets');
  await denied('DELETE', `/v1/hook-secrets/${NAME}`);

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM hook_secret').get() as {
    total: number;
  };
  assert.equal(rows.total, 0, 'a refused request writes nothing');
});
