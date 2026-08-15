/**
 * Acceptance tests of the webhook subscription routes (t142, AT1–AT4).
 *
 * The CRUD half of extension point nº 5's push transport: registering, listing
 * and deactivating a subscription. The fan-out and the delivery attempts live in
 * `test/webhooks-dispatch.test.ts` — here nothing is ever pushed, because no
 * event is ever recorded in these tests, and a subscription over an empty log
 * has nothing to fan out.
 *
 * Two properties are asserted on every response that carries a subscription, and
 * they are the reason this file exists apart from the dispatcher's:
 *
 * - **`segredo` never comes back.** It is supplied by the caller (there is no
 *   server-generated secret and no one-time-reveal flow), and from the moment it
 *   is stored the API has no read path for it. The assertion is on the raw JSON
 *   text, not on a parsed field: a nested copy would slip past `body.segredo`.
 * - **Nothing is deleted.** `DELETE` sets `desativada_em`, mirroring
 *   `credencial.revogada_em` (`migrations/0007_credential.sql`) and the "nothing
 *   is ever deleted" discipline of D15/D2.
 *
 * The `src/` artifacts are required by name before each test, for the same
 * reason as the rest of the suite (`test/support.ts:8-11`): on the initial red
 * the failure NAMES the file that is missing.
 *
 * The JSON field names stay in Portuguese: they mirror the migration columns,
 * which the D18 rename does not translate (t127, FR8).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, requireArtifacts, startControlPlane } from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T142_ARTIFACTS = Object.freeze({
  migration: 'migrations/0008_webhook.sql',
  repository: 'src/repositories/webhooks.ts',
  routes: 'src/routes/webhooks.ts',
  server: 'src/server.ts',
});

/** A subscription, as the API returns it — `segredo` is not part of the shape. */
interface Subscription {
  id: number;
  projeto_id: number;
  url: string;
  /** The taxonomy types this subscription wants; `null` means every type. */
  tipos: string[] | null;
  /** `MAX(evento.id)` at creation time: where the fan-out starts. */
  evento_inicial_id: number;
  criada_em: string;
  desativada_em: string | null;
}

/** The error envelope of `src/routes/common.ts`. */
interface ErrorBody {
  error: string;
  details?: string[];
}

const SECRET = 'segredo-do-consumidor-142';

/** Fails when the raw JSON carries the secret anywhere, at any depth. */
function assertNoSecret(body: unknown): void {
  const text = JSON.stringify(body);
  assert.ok(!text.includes('segredo'), `the response must not name the secret field: ${text}`);
  assert.ok(!text.includes(SECRET), `the response must not carry the secret: ${text}`);
}

test('AT1 — POST /v1/webhooks registers a subscription and never echoes the secret', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const response = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://exemplo.invalid/hook',
    segredo: SECRET,
  });

  assert.equal(response.status, 201);
  assert.ok(Number.isInteger(response.body.id) && response.body.id > 0);
  assert.equal(response.body.url, 'https://exemplo.invalid/hook');
  assert.equal(response.body.projeto_id, 1, 'without projeto_id the subscription is the default one');
  assert.equal(response.body.tipos, null, 'without tipos the subscription wants every type');
  assert.equal(response.body.desativada_em, null, 'a fresh subscription is active');
  assert.equal(typeof response.body.criada_em, 'string');
  assert.equal(response.body.evento_inicial_id, 0, 'the log of this control plane is empty');
  assertNoSecret(response.body);
});

test('AT2 — an invalid url, a missing secret or an unknown type is a 400', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const refused = async (body: Record<string, unknown>): Promise<ErrorBody> => {
    const response = await request<ErrorBody>(ctx, 'POST', '/v1/webhooks', body);
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(response.body.error, 'validation_failed');
    assert.ok(
      Array.isArray(response.body.details) && response.body.details.length > 0,
      'the 400 says what is wrong',
    );
    return response.body;
  };

  await refused({ url: 'ftp://exemplo.invalid/hook', segredo: SECRET });
  await refused({ url: 'nao-e-uma-url', segredo: SECRET });
  await refused({ url: '/apenas/um/caminho', segredo: SECRET });
  await refused({ segredo: SECRET });
  await refused({ url: 'https://exemplo.invalid/hook' });
  await refused({ url: 'https://exemplo.invalid/hook', segredo: '' });

  const unknownType = await refused({
    url: 'https://exemplo.invalid/hook',
    segredo: SECRET,
    tipos: ['nao_existe'],
  });
  assert.ok(
    (unknownType.details ?? []).some((detail) => detail.includes('nao_existe')),
    `the 400 names the unknown type: ${JSON.stringify(unknownType.details)}`,
  );

  const list = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.deepEqual(list.body.webhooks, [], 'a refused registration writes nothing');
});

test('AT3 — GET /v1/webhooks lists the subscriptions, filtered and without secrets', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const create = async (body: Record<string, unknown>): Promise<Subscription> => {
    const response = await request<Subscription>(ctx, 'POST', '/v1/webhooks', body);
    assert.equal(response.status, 201, `POST /v1/webhooks returned ${response.status}`);
    return response.body;
  };

  const mine = await create({
    url: 'https://exemplo.invalid/projeto-1',
    segredo: SECRET,
    tipos: ['trabalho.criado'],
  });
  const other = await create({
    url: 'https://exemplo.invalid/projeto-9',
    segredo: SECRET,
    projeto_id: 9,
  });

  const all = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.webhooks.map((subscription) => subscription.id).sort(),
    [mine.id, other.id].sort(),
  );
  assert.deepEqual(
    all.body.webhooks.find((subscription) => subscription.id === mine.id)?.tipos,
    ['trabalho.criado'],
  );
  assertNoSecret(all.body);

  const filtered = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    '/v1/webhooks?projeto_id=9',
  );
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filtered.body.webhooks.map((subscription) => subscription.id),
    [other.id],
  );
  assertNoSecret(filtered.body);
});

test('AT4 — DELETE deactivates, is idempotent, and 404s on an unknown id', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const created = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://exemplo.invalid/hook',
    segredo: SECRET,
  });
  assert.equal(created.status, 201);

  const removed = await request<Subscription>(ctx, 'DELETE', `/v1/webhooks/${created.body.id}`);
  assert.equal(removed.status, 200);
  assert.equal(typeof removed.body.desativada_em, 'string');
  assertNoSecret(removed.body);

  const again = await request<Subscription>(ctx, 'DELETE', `/v1/webhooks/${created.body.id}`);
  assert.equal(again.status, 200, 'deactivating twice is not an error');
  assert.equal(
    again.body.desativada_em,
    removed.body.desativada_em,
    'the second call does not move the instant of the first',
  );

  // Nothing was physically deleted: the row is still listed, now inactive.
  const list = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.deepEqual(
    list.body.webhooks.map((subscription) => subscription.id),
    [created.body.id],
  );
  assert.equal(list.body.webhooks[0].desativada_em, removed.body.desativada_em);

  const unknown = await request<ErrorBody>(ctx, 'DELETE', '/v1/webhooks/9999');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');
});
