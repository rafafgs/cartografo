/**
 * The model-discovery routes (t166, FR13/FR14).
 *
 * Engines are RUNNER-LOCAL: the control plane has never heard of one, and it
 * still does not know what a `claude-code` is. What these two routes add is a
 * reporting path — the runner discovered a catalog, the server persists it and
 * serves it back — in exactly the shape `POST /v1/runners` already has, down to
 * the posture on refresh: a restarted runner reports again, and there is no
 * timer, no TTL and no cache to invalidate.
 *
 * Two claims carry the ficha:
 *
 * - **A report REPLACES the stored catalog for that engine.** Merging would let
 *   a model an engine stopped offering linger as a row nobody can explain, and
 *   the operator reading `GET /v1/engines` would see a menu that no longer
 *   exists.
 * - **The two routes sit on opposite sides of the credential gate.** The `POST`
 *   is the runner's, by one explicit line in `auth.ts`; the `GET` is the
 *   operator's, by omission — the same reasoning `GET /v1/runners` already
 *   wrote down, and for the same reason: one compromised machine must not
 *   become a map of the fleet.
 *
 * The wire field names are English since t226 (`engine`, `model_id`, `label`,
 * `source`), while the migration's columns behind them are untouched. The two
 * values of `source` were already English: they are the `EngineAdapter`'s own
 * vocabulary,
 * produced by the adapter, exactly as `timeout_reason`'s `wall_clock`/`silence`
 * already are.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, requireArtifacts, startControlPlane, type TestContext } from './support.ts';

/** The artifacts this suite exercises; the initial red names the missing one. */
const T166_ARTIFACTS = Object.freeze({
  migration: 'migrations/0012_motor_modelo.sql',
  repository: 'src/repositories/engine-models.ts',
  routes: 'src/routes/engines.ts',
});

/** One model, as the wire carries it. */
interface EngineModel {
  model_id: string;
  label: string | null;
  source: string;
  updated_at?: string;
}

/** One engine with everything reported for it. */
interface EngineRow {
  engine: string;
  models: EngineModel[];
}

interface ReportBody {
  engine: string;
  models: EngineModel[];
}

interface ErrorBody {
  error?: string;
  message?: string;
}

/** A request built header by header — this suite needs credentials of its own. */
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
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

/** Pairs a runner with the operator credential and returns its own token. */
async function pairedRunnerToken(ctx: TestContext, id: string): Promise<string> {
  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', { id });
  assert.equal(paired.status, 201);
  assert.equal(typeof paired.body.token, 'string', 'pairing is where a runner credential comes from');
  return paired.body.token ?? '';
}

/** Reports a catalog with the operator credential (the gate has its own test). */
async function report(
  ctx: TestContext,
  engine: string,
  models: Array<{ model_id: string; label?: string | null; source: string }>,
): Promise<ReportBody> {
  const response = await request<ReportBody>(
    ctx,
    'POST',
    `/v1/engines/${encodeURIComponent(engine)}/models`,
    { models: models },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

/** Reads the whole catalog with the operator credential. */
async function listEngines(ctx: TestContext): Promise<EngineRow[]> {
  const response = await request<{ engines: EngineRow[] }>(ctx, 'GET', '/v1/engines');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.engines;
}

test('t166 AT — a reported catalog comes back out of GET /v1/engines with source intact', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  assert.deepEqual(await listEngines(ctx), [], 'nothing is known before a runner says so');

  const reported = await report(ctx, 'claude-code', [
    { model_id: 'claude-opus-5', label: 'Claude Opus 5', source: 'catalog' },
    { model_id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'catalog' },
  ]);
  assert.equal(reported.engine, 'claude-code');
  assert.equal(reported.models.length, 2);

  const engines = await listEngines(ctx);
  assert.equal(engines.length, 1);
  assert.equal(engines[0]?.engine, 'claude-code');
  assert.deepEqual(
    engines[0]?.models.map((model) => ({
      model_id: model.model_id,
      label: model.label,
      source: model.source,
    })),
    [
      { model_id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', source: 'catalog' },
      { model_id: 'claude-opus-5', label: 'Claude Opus 5', source: 'catalog' },
    ],
    'every model comes back, in a stable order, with the origin the adapter declared',
  );
  for (const model of engines[0]?.models ?? []) {
    assert.equal(typeof model.updated_at, 'string', 'a catalog with no date cannot be judged stale');
  }
});

test('t166 AT — a second report REPLACES the first: a dropped model does not linger', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'codex', [
    { model_id: 'gpt-5.6-sol', source: 'catalog' },
    { model_id: 'gpt-5.4', source: 'catalog' },
  ]);
  await report(ctx, 'codex', [
    { model_id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', source: 'catalog' },
    { model_id: 'gpt-5.6-luna', source: 'catalog' },
  ]);

  const [engine] = await listEngines(ctx);
  assert.deepEqual(
    engine?.models.map((model) => model.model_id).sort(),
    ['gpt-5.6-luna', 'gpt-5.6-sol'],
    'the model the second report dropped has to be gone, not merged in',
  );
  assert.equal(
    engine?.models.find((model) => model.model_id === 'gpt-5.6-sol')?.label,
    'GPT-5.6-Sol',
    'the surviving row carries the label of the LAST report',
  );
});

test('t166 AT — one engine\'s report never touches another engine\'s catalog', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'claude-code', [{ model_id: 'claude-opus-5', source: 'catalog' }]);
  await report(ctx, 'codex', [{ model_id: 'gpt-5.6-sol', source: 'catalog' }]);
  await report(ctx, 'codex', [{ model_id: 'gpt-5.6-luna', source: 'catalog' }]);

  const engines = await listEngines(ctx);
  assert.deepEqual(
    engines.map((engine) => [engine.engine, engine.models.map((model) => model.model_id)]),
    [
      ['claude-code', ['claude-opus-5']],
      ['codex', ['gpt-5.6-luna']],
    ],
    'replacement is scoped to the engine that reported',
  );
});

test('t166 AT — an empty report clears the engine, and says so in its own answer', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'claude-code', [{ model_id: 'claude-opus-5', source: 'catalog' }]);
  const cleared = await report(ctx, 'claude-code', []);

  // The report's OWN answer names the engine, which is the only place an empty
  // catalog stays visible...
  assert.deepEqual(cleared, { engine: 'claude-code', models: [] });

  // ...and the listing loses the engine entirely. That is the stated price of
  // `motor_modelo` being rows-of-models and not rows-of-engines (FR12): with no
  // model row there is nothing left to carry the name, so an engine that offers
  // nothing is indistinguishable from one that never reported. Closing that
  // would take a second table, and nothing in this ficha needs it — a runner
  // whose adapter has no catalog is a runner with no models to dispatch on.
  assert.deepEqual(await listEngines(ctx), []);
});

test('t166 AT — a malformed report is refused, and writes nothing', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'claude-code', [{ model_id: 'claude-opus-5', source: 'catalog' }]);

  const refusals: Array<[string, unknown]> = [
    ['models_required', {}],
    ['models_required', { models: 'claude-opus-5' }],
    ['invalid_model', { models: [{ source: 'catalog' }] }],
    ['invalid_model', { models: [{ model_id: '  ', source: 'catalog' }] }],
    ['invalid_source', { models: [{ model_id: 'claude-opus-5' }] }],
    ['invalid_source', { models: [{ model_id: 'claude-opus-5', source: 'catalogo' }] }],
  ];

  for (const [code, body] of refusals) {
    const response = await request<ErrorBody>(ctx, 'POST', '/v1/engines/claude-code/models', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)} should be refused`);
    assert.equal(response.body.error, code, JSON.stringify(response.body));
    assert.ok((response.body.message ?? '').length > 0, 'a refusal says what to fix');
  }

  assert.deepEqual(
    (await listEngines(ctx))[0]?.models.map((model) => model.model_id),
    ['claude-opus-5'],
    'a refused report leaves the previous catalog exactly as it was',
  );
});

test('t166 AT — a runner credential may report, and is refused the operator read', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const allowed = await call<ReportBody>(ctx, 'POST', '/v1/engines/claude-code/models', token, {
    models: [{ model_id: 'claude-opus-5', source: 'catalog' }],
  });
  assert.equal(
    allowed.status,
    200,
    'reporting what this machine can run is exactly what a runner credential is for',
  );

  const denied = await call<ErrorBody>(ctx, 'GET', '/v1/engines', token);
  assert.equal(denied.status, 403, 'reading the whole fleet\'s menu is the operator\'s, not a runner\'s');
  assert.equal(denied.body.error, 'out_of_scope_credential');

  // ...and what the runner reported is there, for the operator who may read it.
  assert.deepEqual(
    (await listEngines(ctx))[0]?.models.map((model) => model.model_id),
    ['claude-opus-5'],
  );
});

test('t166 AT — neither route answers without a credential', async (t) => {
  const ctx = await startControlPlane(t);

  for (const [method, route] of [
    ['POST', '/v1/engines/claude-code/models'],
    ['GET', '/v1/engines'],
  ] as const) {
    const response = await fetch(`${ctx.url}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ models: [] }) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${route} answered without a credential`);
  }
});
