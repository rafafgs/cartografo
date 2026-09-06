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

import { request, requireArtifacts, startControlPlane, type TestContext } from './support.ts';

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
  project_id: number;
  url: string;
  /** The taxonomy types this subscription wants; `null` means every type. */
  filter_types: string[] | null;
  /** `MAX(evento.id)` at creation time: where the fan-out starts. */
  initial_event_id: number;
  created_at: string;
  deactivated_at: string | null;
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

/** Declares a project and returns its id (t412). */
async function declareProject(ctx: TestContext, name: string): Promise<number> {
  const response = await request<{ id: number }>(ctx, 'POST', '/v1/projects', { name });
  assert.equal(response.status, 201, `POST /v1/projects returned ${response.status}`);
  return response.body.id;
}

test('AT1 — POST /v1/webhooks registers a subscription and never echoes the secret', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const response = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/hook',
    secret: SECRET,
  });

  assert.equal(response.status, 201);
  assert.ok(Number.isInteger(response.body.id) && response.body.id > 0);
  assert.equal(response.body.url, 'https://example.invalid/hook');
  assert.equal(response.body.project_id, 1, 'without projeto_id the subscription is the default one');
  assert.equal(response.body.filter_types, null, 'without tipos the subscription wants every type');
  assert.equal(response.body.deactivated_at, null, 'a fresh subscription is active');
  assert.equal(typeof response.body.created_at, 'string');
  assert.equal(response.body.initial_event_id, 0, 'the log of this control plane is empty');
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

  await refused({ url: 'ftp://example.invalid/hook', secret: SECRET });
  await refused({ url: 'not-a-url', secret: SECRET });
  await refused({ url: '/only/one/path', secret: SECRET });
  await refused({ secret: SECRET });
  await refused({ url: 'https://example.invalid/hook' });
  await refused({ url: 'https://example.invalid/hook', secret: '' });

  const unknownType = await refused({
    url: 'https://example.invalid/hook',
    secret: SECRET,
    filter_types: ['nao_existe'],
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

  // The second project is DECLARED and not merely named, and since t417 it has
  // to be on BOTH sides: it used to be a bare `project_id: 9`, which the listing
  // was happy to filter on because nothing resolved it; t412 made
  // `GET /v1/webhooks` resolve its scope like every other scoped listing, and
  // t417 made `POST /v1/webhooks` refuse one that answers to nobody. So the
  // partition this case filters on is asked for, and its id is used rather than
  // assumed. The case itself is unchanged — one subscription in the default
  // project, one outside it, and the listing telling them apart.
  const second = await declareProject(ctx, 'second');

  const mine = await create({
    url: 'https://example.invalid/projeto-1',
    secret: SECRET,
    filter_types: ['job.created'],
  });
  const other = await create({
    url: 'https://example.invalid/projeto-2',
    secret: SECRET,
    project_id: second,
  });

  // An omitted scope is the DEFAULT project and not "every project" (t412, FR10):
  // the unfiltered listing is project 1's listing, so `other` is not in it.
  const all = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.equal(all.status, 200);
  assert.deepEqual(
    all.body.webhooks.map((subscription) => subscription.id),
    [mine.id],
  );
  assert.deepEqual(all.body.webhooks[0].filter_types, ['job.created']);
  assertNoSecret(all.body);

  const filtered = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    `/v1/webhooks?project_id=${second}`,
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
    url: 'https://example.invalid/hook',
    secret: SECRET,
  });
  assert.equal(created.status, 201);

  const removed = await request<Subscription>(ctx, 'DELETE', `/v1/webhooks/${created.body.id}`);
  assert.equal(removed.status, 200);
  assert.equal(typeof removed.body.deactivated_at, 'string');
  assertNoSecret(removed.body);

  const again = await request<Subscription>(ctx, 'DELETE', `/v1/webhooks/${created.body.id}`);
  assert.equal(again.status, 200, 'deactivating twice is not an error');
  assert.equal(
    again.body.deactivated_at,
    removed.body.deactivated_at,
    'the second call does not move the instant of the first',
  );

  // Nothing was physically deleted: the row is still listed, now inactive.
  const list = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.deepEqual(
    list.body.webhooks.map((subscription) => subscription.id),
    [created.body.id],
  );
  assert.equal(list.body.webhooks[0].deactivated_at, removed.body.deactivated_at);

  const unknown = await request<ErrorBody>(ctx, 'DELETE', '/v1/webhooks/9999');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');
});

/* -------------------------------------------------------------------------- */
/* t412 — a subscription is read and deactivated inside its project (D25).      */
/*                                                                            */
/* `DELETE /v1/webhooks/:id` used to call `deactivateSubscription(db, id)` with */
/* no project anywhere in the call, so any valid credential could silence any    */
/* other project's consumer just by knowing its numeric id — the sharpest of the */
/* gaps t354 left behind. `GET /v1/webhooks` had the mirror of it: with no       */
/* `?project_id=` the filter was simply absent and the listing crossed every     */
/* project at once.                                                             */
/* -------------------------------------------------------------------------- */

test('t412 AT5 — an omitted scope lists the default project, not every project', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const mine = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/default',
    secret: SECRET,
  });
  assert.equal(mine.status, 201);
  const theirs = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/second',
    secret: SECRET,
    project_id: 2,
  });
  assert.equal(theirs.status, 201);

  const unscoped = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.equal(unscoped.status, 200);
  assert.deepEqual(
    unscoped.body.webhooks.map((subscription) => subscription.id),
    [mine.body.id],
    'no scope means project 1, the same default every other scoped listing takes',
  );

  const second = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    '/v1/webhooks?project_id=2',
  );
  assert.equal(second.status, 200);
  assert.deepEqual(
    second.body.webhooks.map((subscription) => subscription.id),
    [theirs.body.id],
  );
});

test('t412 AT6 — DELETE refuses a subscription of another project and deactivates nothing', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);
  await declareProject(ctx, 'second');

  const theirs = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/second',
    secret: SECRET,
    project_id: 2,
  });
  assert.equal(theirs.status, 201);

  const crossed = await request<ErrorBody>(
    ctx,
    'DELETE',
    `/v1/webhooks/${theirs.body.id}?project_id=1`,
  );
  assert.equal(crossed.status, 404, JSON.stringify(crossed.body));
  assert.equal(crossed.body.error, 'not_found', 'the same 404 an unknown id already answers');

  const stillThere = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    '/v1/webhooks?project_id=2',
  );
  assert.equal(
    stillThere.body.webhooks[0].deactivated_at,
    null,
    'the refusal is a refusal: the consumer of project 2 is still being delivered to',
  );

  const owned = await request<Subscription>(
    ctx,
    'DELETE',
    `/v1/webhooks/${theirs.body.id}?project_id=2`,
  );
  assert.equal(owned.status, 200, JSON.stringify(owned.body));
  assert.equal(typeof owned.body.deactivated_at, 'string');
  assertNoSecret(owned.body);
});

test('t412 AT7 — a scope that answers to no project is a 404 on both webhook reads', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const created = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/hook',
    secret: SECRET,
  });
  assert.equal(created.status, 201);

  const listed = await request<ErrorBody & { project_id?: number }>(
    ctx,
    'GET',
    '/v1/webhooks?project_id=99',
  );
  assert.equal(listed.status, 404, JSON.stringify(listed.body));
  assert.equal(listed.body.error, 'unknown_project');
  assert.equal(listed.body.project_id, 99);

  const removed = await request<ErrorBody>(
    ctx,
    'DELETE',
    `/v1/webhooks/${created.body.id}?project_id=99`,
  );
  assert.equal(removed.status, 404, JSON.stringify(removed.body));
  assert.equal(removed.body.error, 'unknown_project');

  const untouched = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.equal(
    untouched.body.webhooks[0].deactivated_at,
    null,
    'refused before the subscription was touched',
  );
});

/* -------------------------------------------------------------------------- */
/* t417 — a subscription is never registered under a project nobody declared. */
/*                                                                            */
/* `readProject` checked integer-ness and stopped there, so `POST /v1/webhooks`*/
/* happily wrote a row into a partition that does not exist — one the scoped   */
/* listing t412 built above has no way to hand back. Same refusal as every     */
/* other scope, same code, same words.                                        */
/* -------------------------------------------------------------------------- */

/** The scope refusal, in the slice these two cases assert on. */
interface ScopeRefusal {
  error: string;
  message?: string;
  project_id?: number;
}

test('t417 AT6 — POST /v1/webhooks refuses a project nobody declared', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);

  const refused = await request<ScopeRefusal>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/phantom',
    secret: SECRET,
    project_id: 99,
  });

  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'unknown_project');
  assert.equal(refused.body.message, 'no project answers to this scope');
  assert.equal(refused.body.project_id, 99, 'the scope rides as a sibling field');

  const listed = await request<{ webhooks: Subscription[] }>(ctx, 'GET', '/v1/webhooks');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.webhooks, [], 'nothing was written anywhere');
  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM webhook_subscription').get() as {
    total: number;
  };
  assert.equal(rows.total, 0, 'and no row of the table either');
});

test('t417 AT7 — the default project and a declared one still register unchanged', async (t) => {
  requireArtifacts(T142_ARTIFACTS.migration, T142_ARTIFACTS.routes, T142_ARTIFACTS.server);
  const ctx = await startControlPlane(t);
  assert.equal(await declareProject(ctx, 'second'), 2);

  const implicit = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/default',
    secret: SECRET,
  });
  assert.equal(implicit.status, 201, JSON.stringify(implicit.body));
  assert.equal(implicit.body.project_id, 1, 'no project_id is still the default one');

  const explicit = await request<Subscription>(ctx, 'POST', '/v1/webhooks', {
    url: 'https://example.invalid/second',
    secret: SECRET,
    project_id: 2,
  });
  assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
  assert.equal(explicit.body.project_id, 2);

  const scoped = await request<{ webhooks: Subscription[] }>(
    ctx,
    'GET',
    '/v1/webhooks?project_id=2',
  );
  assert.deepEqual(
    scoped.body.webhooks.map((subscription) => subscription.id),
    [explicit.body.id],
    'a subscription that was created is a subscription that reads back',
  );
});
