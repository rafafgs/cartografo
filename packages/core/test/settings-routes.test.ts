/**
 * The settings routes (t403, FR4/FR5/FR6).
 *
 * `GET /v1/settings` and `PATCH /v1/settings` are operator-only, by omission —
 * the same convention `GET /v1/engines` already established
 * (`test/engine-models-routes.test.ts`): neither route is in `auth.ts`'s
 * `RUNNER_SURFACE`, so a `runner` credential gets `403 out_of_scope_credential`
 * and a `user` credential reaches both.
 *
 * `project_id` follows `GET /v1/leases`'s own convention for a query filter:
 * absent or blank falls back to `DEFAULT_PROJECT`, and a value that is not an
 * integer refuses `400 invalid_filter` naming the field.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, requireArtifacts, startControlPlane, type TestContext } from './support.ts';

/** The artifacts this suite exercises; the initial red names the missing one. */
const T403_ARTIFACTS = Object.freeze({
  migration: 'migrations/0026_settings.sql',
  repository: 'src/repositories/settings.ts',
  routes: 'src/routes/settings.ts',
});

interface SettingsBody {
  project_id: number;
  workspace_root?: string;
  worktrees_root?: string;
  engine?: string;
}

interface ErrorBody {
  error?: string;
  message?: string;
  field?: string;
}

/** A request built header by header — this suite needs credentials of its own. */
async function call<T>(
  ctx: TestContext,
  method: string,
  routePath: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${ctx.url}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

/** Pairs a runner with the operator credential and returns its own token. */
async function pairedRunnerToken(ctx: TestContext, id: string): Promise<string> {
  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', { id });
  assert.equal(paired.status, 201);
  assert.equal(typeof paired.body.token, 'string', 'pairing is where a runner credential comes from');
  return paired.body.token ?? '';
}

/**
 * Test-local defaults, seeded straight into the table.
 *
 * `startControlPlane` (`test/support.ts`) only migrates and brings `createApp`
 * up — the seed itself is `start()`'s job (`src/index.ts`), exercised end to end
 * by `test/startup.test.ts`'s AT9. Route tests seed by hand so a `GET` has
 * something real to read.
 */
const SEEDED = Object.freeze({
  workspace_root: '/home/operator/.cartografo/workspace',
  worktrees_root: '/home/operator/.cartografo/worktrees',
  engine: 'claude-code',
});

function seedTestDefaults(ctx: TestContext, projectId = 1): void {
  const insert = ctx.db.prepare(
    'INSERT INTO setting (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(SEEDED)) {
    insert.run(projectId, key, value, now);
  }
}

test('t403 AT5 — GET /v1/settings: no credential refuses 401, a runner refuses 403, a user reads the defaults', async (t) => {
  requireArtifacts(...Object.values(T403_ARTIFACTS));
  const ctx = await startControlPlane(t);
  seedTestDefaults(ctx);

  const anonymous = await call<ErrorBody>(ctx, 'GET', '/v1/settings?project_id=1', null);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, 'missing_credential');

  const runnerToken = await pairedRunnerToken(ctx, 'runner-a');
  const asRunner = await call<ErrorBody>(ctx, 'GET', '/v1/settings?project_id=1', runnerToken);
  assert.equal(asRunner.status, 403);
  assert.equal(asRunner.body.error, 'out_of_scope_credential');

  const asUser = await call<SettingsBody>(ctx, 'GET', '/v1/settings?project_id=1', ctx.token);
  assert.equal(asUser.status, 200);
  assert.equal(asUser.body.project_id, 1);
  assert.deepEqual(
    { workspace_root: asUser.body.workspace_root, worktrees_root: asUser.body.worktrees_root, engine: asUser.body.engine },
    SEEDED,
    'the three seeded defaults come back',
  );
});

test('t403 AT6 — GET /v1/settings defaults project_id to 1, and refuses a non-integer value', async (t) => {
  requireArtifacts(...Object.values(T403_ARTIFACTS));
  const ctx = await startControlPlane(t);

  const noParam = await request<SettingsBody>(ctx, 'GET', '/v1/settings');
  assert.equal(noParam.status, 200);
  assert.equal(noParam.body.project_id, 1, 'an absent project_id defaults to project 1');

  const invalid = await call<ErrorBody>(ctx, 'GET', '/v1/settings?project_id=not-a-number', ctx.token);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'invalid_filter');
  assert.equal(invalid.body.field, 'project_id');
});

test('t403 AT7 — PATCH /v1/settings updates the named key and leaves the others alone; GET reflects it', async (t) => {
  requireArtifacts(...Object.values(T403_ARTIFACTS));
  const ctx = await startControlPlane(t);

  const before = await request<SettingsBody>(ctx, 'GET', '/v1/settings?project_id=1');
  assert.equal(before.status, 200);

  const patched = await request<SettingsBody>(ctx, 'PATCH', '/v1/settings', { engine: 'other-engine' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.project_id, 1);
  assert.equal(patched.body.engine, 'other-engine');
  assert.equal(patched.body.workspace_root, before.body.workspace_root);
  assert.equal(patched.body.worktrees_root, before.body.worktrees_root);

  const after = await request<SettingsBody>(ctx, 'GET', '/v1/settings?project_id=1');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, patched.body, 'a subsequent GET reflects the same values');
});

test('t403 AT8 — PATCH /v1/settings with an unknown key refuses 400 unknown_setting, and writes nothing', async (t) => {
  requireArtifacts(...Object.values(T403_ARTIFACTS));
  const ctx = await startControlPlane(t);

  const before = await request<SettingsBody>(ctx, 'GET', '/v1/settings?project_id=1');
  assert.equal(before.status, 200);

  const refused = await request<ErrorBody>(ctx, 'PATCH', '/v1/settings', { nonsense: 'x' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'unknown_setting');
  assert.ok((refused.body.message ?? '').length > 0, 'a refusal says what to fix');

  const after = await request<SettingsBody>(ctx, 'GET', '/v1/settings?project_id=1');
  assert.deepEqual(after.body, before.body, 'the refused patch wrote no key at all');
});

test('t403 — PATCH /v1/settings refuses a non-string value with 400 invalid_setting_value', async (t) => {
  requireArtifacts(...Object.values(T403_ARTIFACTS));
  const ctx = await startControlPlane(t);

  const refused = await request<ErrorBody>(ctx, 'PATCH', '/v1/settings', { engine: 42 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'invalid_setting_value');
});
