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
 * The wire field names are the migration's columns (`motor`, `modelo_id`,
 * `rotulo`, `origem`), so they stay in Portuguese (t127, FR8). The two values of
 * `origem` are English on purpose: they are the `EngineAdapter`'s vocabulary,
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
interface EngineModelRow {
  modelo_id: string;
  rotulo: string | null;
  origem: string;
  atualizado_em?: string;
}

/** One engine with everything reported for it. */
interface EngineRow {
  motor: string;
  modelos: EngineModelRow[];
}

interface ReportBody {
  motor: string;
  modelos: EngineModelRow[];
}

interface ErrorBody {
  erro?: string;
  mensagem?: string;
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
  models: Array<{ modelo_id: string; rotulo?: string | null; origem: string }>,
): Promise<ReportBody> {
  const response = await request<ReportBody>(
    ctx,
    'POST',
    `/v1/engines/${encodeURIComponent(engine)}/models`,
    { modelos: models },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

/** Reads the whole catalog with the operator credential. */
async function listEngines(ctx: TestContext): Promise<EngineRow[]> {
  const response = await request<{ motores: EngineRow[] }>(ctx, 'GET', '/v1/engines');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.motores;
}

test('t166 AT — a reported catalog comes back out of GET /v1/engines with origem intact', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  assert.deepEqual(await listEngines(ctx), [], 'nothing is known before a runner says so');

  const reported = await report(ctx, 'claude-code', [
    { modelo_id: 'claude-opus-5', rotulo: 'Claude Opus 5', origem: 'catalog' },
    { modelo_id: 'claude-haiku-4-5', rotulo: 'Claude Haiku 4.5', origem: 'catalog' },
  ]);
  assert.equal(reported.motor, 'claude-code');
  assert.equal(reported.modelos.length, 2);

  const engines = await listEngines(ctx);
  assert.equal(engines.length, 1);
  assert.equal(engines[0]?.motor, 'claude-code');
  assert.deepEqual(
    engines[0]?.modelos.map((model) => ({
      modelo_id: model.modelo_id,
      rotulo: model.rotulo,
      origem: model.origem,
    })),
    [
      { modelo_id: 'claude-haiku-4-5', rotulo: 'Claude Haiku 4.5', origem: 'catalog' },
      { modelo_id: 'claude-opus-5', rotulo: 'Claude Opus 5', origem: 'catalog' },
    ],
    'every model comes back, in a stable order, with the origin the adapter declared',
  );
  for (const model of engines[0]?.modelos ?? []) {
    assert.equal(typeof model.atualizado_em, 'string', 'a catalog with no date cannot be judged stale');
  }
});

test('t166 AT — a second report REPLACES the first: a dropped model does not linger', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'codex', [
    { modelo_id: 'gpt-5.6-sol', origem: 'catalog' },
    { modelo_id: 'gpt-5.4', origem: 'catalog' },
  ]);
  await report(ctx, 'codex', [
    { modelo_id: 'gpt-5.6-sol', rotulo: 'GPT-5.6-Sol', origem: 'catalog' },
    { modelo_id: 'gpt-5.6-luna', origem: 'catalog' },
  ]);

  const [engine] = await listEngines(ctx);
  assert.deepEqual(
    engine?.modelos.map((model) => model.modelo_id).sort(),
    ['gpt-5.6-luna', 'gpt-5.6-sol'],
    'the model the second report dropped has to be gone, not merged in',
  );
  assert.equal(
    engine?.modelos.find((model) => model.modelo_id === 'gpt-5.6-sol')?.rotulo,
    'GPT-5.6-Sol',
    'the surviving row carries the label of the LAST report',
  );
});

test('t166 AT — one engine\'s report never touches another engine\'s catalog', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'claude-code', [{ modelo_id: 'claude-opus-5', origem: 'catalog' }]);
  await report(ctx, 'codex', [{ modelo_id: 'gpt-5.6-sol', origem: 'catalog' }]);
  await report(ctx, 'codex', [{ modelo_id: 'gpt-5.6-luna', origem: 'catalog' }]);

  const engines = await listEngines(ctx);
  assert.deepEqual(
    engines.map((engine) => [engine.motor, engine.modelos.map((model) => model.modelo_id)]),
    [
      ['claude-code', ['claude-opus-5']],
      ['codex', ['gpt-5.6-luna']],
    ],
    'replacement is scoped to the engine that reported',
  );
});

test('t166 AT — an empty report is how an engine says it offers nothing', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'claude-code', [{ modelo_id: 'claude-opus-5', origem: 'catalog' }]);
  await report(ctx, 'claude-code', []);

  assert.deepEqual(
    (await listEngines(ctx)).map((engine) => [engine.motor, engine.modelos.length]),
    [['claude-code', 0]],
    'the engine stays known, and known to offer nothing — that is information, not absence',
  );
});

test('t166 AT — a malformed report is refused, and writes nothing', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);

  await report(ctx, 'claude-code', [{ modelo_id: 'claude-opus-5', origem: 'catalog' }]);

  const refusals: Array<[string, unknown]> = [
    ['modelos_obrigatorio', {}],
    ['modelos_obrigatorio', { modelos: 'claude-opus-5' }],
    ['modelo_invalido', { modelos: [{ origem: 'catalog' }] }],
    ['modelo_invalido', { modelos: [{ modelo_id: '  ', origem: 'catalog' }] }],
    ['origem_invalida', { modelos: [{ modelo_id: 'claude-opus-5' }] }],
    ['origem_invalida', { modelos: [{ modelo_id: 'claude-opus-5', origem: 'catalogo' }] }],
  ];

  for (const [code, body] of refusals) {
    const response = await request<ErrorBody>(ctx, 'POST', '/v1/engines/claude-code/models', body);
    assert.equal(response.status, 400, `${JSON.stringify(body)} should be refused`);
    assert.equal(response.body.erro, code, JSON.stringify(response.body));
    assert.ok((response.body.mensagem ?? '').length > 0, 'a refusal says what to fix');
  }

  assert.deepEqual(
    (await listEngines(ctx))[0]?.modelos.map((model) => model.modelo_id),
    ['claude-opus-5'],
    'a refused report leaves the previous catalog exactly as it was',
  );
});

test('t166 AT — a runner credential may report, and is refused the operator read', async (t) => {
  requireArtifacts(...Object.values(T166_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const allowed = await call<ReportBody>(ctx, 'POST', '/v1/engines/claude-code/models', token, {
    modelos: [{ modelo_id: 'claude-opus-5', origem: 'catalog' }],
  });
  assert.equal(
    allowed.status,
    200,
    'reporting what this machine can run is exactly what a runner credential is for',
  );

  const denied = await call<ErrorBody>(ctx, 'GET', '/v1/engines', token);
  assert.equal(denied.status, 403, 'reading the whole fleet\'s menu is the operator\'s, not a runner\'s');
  assert.equal(denied.body.erro, 'credencial_fora_de_escopo');

  // ...and what the runner reported is there, for the operator who may read it.
  assert.deepEqual(
    (await listEngines(ctx))[0]?.modelos.map((model) => model.modelo_id),
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
      body: method === 'POST' ? JSON.stringify({ modelos: [] }) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${route} answered without a credential`);
  }
});
