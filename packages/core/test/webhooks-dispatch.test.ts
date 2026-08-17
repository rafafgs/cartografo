/**
 * Acceptance tests of the webhook fan-out and delivery (t142, AT5–AT11).
 *
 * This is the first background daemon of `packages/core`, so the shape of the
 * harness matters as much as the assertions:
 *
 * - a **bare app** carrying only the webhook routes and the dispatcher, over a
 *   throwaway database — the same shape as the stream-only app of
 *   `test/events-stream.test.ts`. The whole control plane is not started here on
 *   purpose: `createApp` wires a dispatcher of its own, with the production
 *   interval and the real `fetch`, and two dispatchers over one database would
 *   race for the same deliveries and reach for the network;
 * - **every clock is injected**: `tickIntervalMs` so a tick costs 10ms instead of
 *   a second, and `now` so "the backoff step has passed" is a variable and not a
 *   two-hour `sleep`;
 * - **`fetchImpl` is injected**, so a delivery is a function call the test can
 *   inspect byte by byte — and so no test ever opens a socket to the outside.
 *
 * The facts are written with `recordEvent`, the same function every route of the
 * control plane writes through. There is no route here that produces telemetry,
 * and going through a second app just to obtain an event would only add a moving
 * part to what these tests are about: what the dispatcher does with the log.
 *
 * The signature is recomputed in the test with `node:crypto` directly, never by
 * importing `src/webhooks/signature.ts`: the recipe published in
 * `docs/spec/webhooks-eventos.md` is what a consumer implements, and asserting
 * against the implementation would prove only that it agrees with itself.
 *
 * The JSON and column names stay in Portuguese: they mirror the migration and
 * the taxonomy's envelope (t127, FR8).
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { applyPragmas, openDatabase, type Database } from '../src/db/connection.ts';
import { getEventsByEntity, recordEvent } from '../src/db/events.ts';
import { migrate } from '../src/db/migrate.ts';
import { MIGRATIONS_DIR, requireArtifacts, type Event } from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T142_ARTIFACTS = Object.freeze({
  migration: 'migrations/0008_webhook.sql',
  repository: 'src/repositories/webhooks.ts',
  signature: 'src/webhooks/signature.ts',
  dispatcher: 'src/webhooks/dispatcher.ts',
  routes: 'src/routes/webhooks.ts',
});

/** Header the delivery carries; HTTP header names are case-insensitive. */
const SIGNATURE_HEADER = 'x-cartografo-assinatura';

/** The secret the caller supplies — the server never generates one. */
const SECRET = 'segredo-do-consumidor-142';

/** Instant every injected clock starts from. */
const START = '2026-08-15T12:00:00.000Z';

/** The published backoff schedule: five retries, six attempts in total. */
/**
 * Interval the dispatcher ticks on here — mocked since t201, so it costs nothing.
 *
 * `createPollingDispatcher` (`src/util/polling-dispatcher.ts`) registers exactly
 * ONE `setInterval`, non-recursive, on the app's `onReady`. That is what makes
 * `t.mock.timers` the simple case here: the whole background clock of this file
 * is that one timer, and every tick below is fired on purpose.
 */
const TICK_INTERVAL_MS = 10;

/**
 * Ticks a "and then nothing else happened" assertion drives before claiming it.
 *
 * They replace flat `setTimeout(150)` / `setTimeout(200)` sleeps — 15 and 20
 * real ticks' worth of wall clock, hoped for rather than observed. A sleep
 * racing a timer is exactly what flakes on a loaded CI box: the assertion "only
 * one attempt was made" was really asserting "the second attempt did not fit in
 * 150ms of somebody else's machine". The same margins, made of counted events.
 */
const SETTLE_TICKS = 15;
const LONG_SETTLE_TICKS = 20;

const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

/** One delivery attempt, as the injected `fetch` saw it. */
interface DeliveryCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** The slice of `fetch` the dispatcher is allowed to use. */
type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number }>;

/** The clocks and the transport the dispatcher accepts (FR4, FR5, FR8). */
interface DispatcherOptions {
  tickIntervalMs?: number;
  now?: () => string;
  fetchImpl?: FetchLike;
}

/** The surface `src/webhooks/dispatcher.ts` has to expose. */
interface DispatcherModule {
  registerWebhookDispatcher: (
    app: FastifyInstance,
    db: Database,
    options?: DispatcherOptions,
  ) => void;
}

/** The surface `src/routes/webhooks.ts` has to expose. */
interface WebhookRoutesModule {
  registerWebhooks: (app: FastifyInstance, db: Database) => void;
}

/** A subscription, as the API returns it — without the secret. */
interface Subscription {
  id: number;
  project_id: number;
  url: string;
  filter_types: string[] | null;
  initial_event_id: number;
  created_at: string;
  deactivated_at: string | null;
}

/** A delivery row, read straight from the table the migration creates. */
interface Delivery {
  id: number;
  subscription_id: number;
  event_id: number;
  status: string;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  delivered_at: string | null;
  last_error: string | null;
}

/** A dispatcher running against a throwaway database. */
interface DispatchContext {
  db: Database;
  /** Base URL of the bare app, for the subscription routes. */
  url: string;
  /** Every delivery attempt made so far, in arrival order. */
  calls: DeliveryCall[];
  /** The injected clock; the tests move it by hand. */
  clock: { value: string };
}

/** How the injected transport answers one attempt. */
type Responder = (call: DeliveryCall) => Promise<{ status: number }>;

/**
 * Brings up the bare app: subscription routes plus dispatcher, nothing else.
 *
 * @param t Test context, used to register the shutdown.
 * @param options How the transport answers, and how fast the tick runs.
 * @returns Open database, base URL, recorded attempts and the injected clock.
 */
async function startDispatcher(
  t: TestContext,
  options: { respond: Responder; tickIntervalMs?: number },
): Promise<DispatchContext> {
  requireArtifacts(
    T142_ARTIFACTS.migration,
    T142_ARTIFACTS.repository,
    T142_ARTIFACTS.signature,
    T142_ARTIFACTS.dispatcher,
    T142_ARTIFACTS.routes,
  );
  const { registerWebhooks } = (await import('../src/routes/webhooks.ts')) as WebhookRoutesModule;
  const { registerWebhookDispatcher } = (await import(
    '../src/webhooks/dispatcher.ts'
  )) as DispatcherModule;

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t142-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const calls: DeliveryCall[] = [];
  const clock = { value: START };

  // Before `app.listen()` — which readies the app — because that is where the
  // `onReady` hook arms the dispatcher's one `setInterval`. From here on nothing
  // in this file ticks by itself: `drive` and `waitFor` fire every single tick.
  // Only `setInterval` is mocked, so the HTTP server this file really listens on
  // and really talks to keeps its own timers.
  t.mock.timers.enable({ apis: ['setInterval'] });

  const app = Fastify({ logger: false });
  app.register(async (scope) => registerWebhooks(scope, db), { prefix: '/v1' });
  registerWebhookDispatcher(app, db, {
    tickIntervalMs: options.tickIntervalMs ?? TICK_INTERVAL_MS,
    now: () => clock.value,
    fetchImpl: async (url, init) => {
      const call: DeliveryCall = {
        url,
        method: init.method,
        headers: init.headers,
        body: init.body,
      };
      calls.push(call);
      return await options.respond(call);
    },
  });

  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db, url, calls, clock };
}

/** Registers a subscription through the route under test. */
async function subscribe(
  ctx: DispatchContext,
  body: Record<string, unknown>,
): Promise<Subscription> {
  const response = await fetch(`${ctx.url}/v1/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201, `POST /v1/webhooks returned ${response.status}`);
  return (await response.json()) as Subscription;
}

/** Deactivates a subscription through the route under test. */
async function unsubscribe(ctx: DispatchContext, id: number): Promise<Subscription> {
  const response = await fetch(`${ctx.url}/v1/webhooks/${id}`, { method: 'DELETE' });
  assert.equal(response.status, 200, `DELETE /v1/webhooks/${id} returned ${response.status}`);
  return (await response.json()) as Subscription;
}

/** Records a `job.created`, the way any route of the control plane would. */
function recordJobCreated(db: Database, id: number, title: string, projectId = 1): Event {
  return recordEvent(db, {
    type: 'job.created',
    project_id: projectId,
    execution_id: null,
    entity: { type: 'job', id },
    actor: { type: 'system', ref: 'control-plane' },
    occurred_at: new Date().toISOString(),
    data: { title: title, entry_node_id: 'entrada' },
  });
}

/** Records a `job.transitioned` — the second type AT7 filters against. */
function recordJobMoved(db: Database, id: number, target: string): Event {
  return recordEvent(db, {
    type: 'job.transitioned',
    project_id: 1,
    execution_id: null,
    entity: { type: 'job', id },
    actor: { type: 'system', ref: 'control-plane' },
    occurred_at: new Date().toISOString(),
    data: { from_node_id: null, to_node_id: target },
  });
}

/** The delivery rows of one subscription, oldest first. */
function deliveries(db: Database, subscriptionId: number): Delivery[] {
  return db
    .prepare(
      `SELECT id, subscription_id, event_id, status, attempts, next_attempt_at,
              created_at, delivered_at, last_error
         FROM webhook_delivery WHERE subscription_id = ? ORDER BY id`,
    )
    .all(subscriptionId) as Delivery[];
}

/** The one delivery of a subscription that is supposed to have exactly one. */
function only(rows: Delivery[]): Delivery {
  assert.equal(rows.length, 1, `expected exactly one delivery, got ${rows.length}`);
  return rows[0];
}

/** Moves the injected clock forward. */
function advance(clock: { value: string }, ms: number): void {
  clock.value = new Date(Date.parse(clock.value) + ms).toISOString();
}

/** The instant `ms` after `START`, in the same format the columns store. */
function after(ms: number): string {
  return new Date(Date.parse(START) + ms).toISOString();
}

/** Reads a header without depending on how the sender cased its name. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

/**
 * Fires the dispatcher's interval once and lets that tick run to the end.
 *
 * The two `setImmediate` turns are the whole reason this is not a one-liner.
 * `tick()` only RUNS the timer callback; the work it starts — the fan-out over
 * the subscriptions, the injected transport, the row writes that record each
 * outcome — is a promise chain, and a macrotask turn is what drains it. Firing
 * the next tick before that chain finished would hit the loop's own overlap
 * guard and be dropped, so "twenty ticks" would silently mean something else.
 *
 * @param t Test context, whose mocked timers this drives.
 */
async function tickOnce(t: TestContext): Promise<void> {
  t.mock.timers.tick(TICK_INTERVAL_MS);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drives the dispatcher forward a fixed, counted number of its own ticks.
 *
 * This is the "and then nothing else happened" device: the claim is not that
 * some milliseconds passed, it is that the dispatcher had N chances to act and
 * did not take them.
 *
 * @param t Test context, whose mocked timers this drives.
 * @param ticks How many firings to give it.
 */
async function drive(t: TestContext, ticks: number = SETTLE_TICKS): Promise<void> {
  for (let fired = 0; fired < ticks; fired += 1) await tickOnce(t);
}

/**
 * Drives ticks until the condition holds, failing with a readable message.
 *
 * The positive counterpart of {@link drive}, and tick-driven for the same
 * reason: with the interval mocked, the dispatcher only ever runs when this
 * file says so, and a poll on wall-clock time would wait for a tick that is
 * never coming.
 *
 * @param t Test context, whose mocked timers this drives.
 * @param condition Checked before every firing.
 * @param description What the failure message should say was expected.
 * @param maxTicks Ceiling, so a broken expectation fails instead of hanging.
 */
async function waitFor(
  t: TestContext,
  condition: () => boolean,
  description: string,
  maxTicks = 500,
): Promise<void> {
  for (let fired = 0; fired < maxTicks; fired += 1) {
    if (condition()) return;
    await tickOnce(t);
  }
  assert.fail(`timed out waiting for ${description} (drove ${maxTicks} ticks)`);
}

test('AT5 — the event is pushed with the envelope and a verifiable signature', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 200 }) });

  const subscription = await subscribe(ctx, {
    url: 'https://exemplo.invalid/hook',
    secret: SECRET,
  });
  recordJobCreated(ctx.db, 1, 'primeiro fato da rodada');

  await waitFor(t, () => ctx.calls.length >= 1, 'the recorded event to be pushed');
  const [call] = ctx.calls;

  assert.equal(call.url, 'https://exemplo.invalid/hook');
  assert.equal(call.method, 'POST');
  assert.equal(headerValue(call.headers, 'content-type'), 'application/json');

  // The body is the taxonomy's envelope, byte for byte what the stream's `data:`
  // field carries — read here through a path the dispatcher does not use.
  const [expected] = getEventsByEntity(ctx.db, 'job', 1);
  assert.deepEqual(JSON.parse(call.body), expected);

  const signature = headerValue(call.headers, SIGNATURE_HEADER);
  assert.equal(
    signature,
    `sha256=${createHmac('sha256', SECRET).update(call.body, 'utf8').digest('hex')}`,
    'the signature is the HMAC-SHA256 of the raw body, keyed with the secret',
  );

  await waitFor(
    t,
    () => only(deliveries(ctx.db, subscription.id)).status === 'entregue',
    'the 2xx to close the delivery',
  );
  const delivery = only(deliveries(ctx.db, subscription.id));
  assert.equal(typeof delivery.delivered_at, 'string');
  assert.equal(delivery.last_error, null);
});

test('AT6 — a subscription never replays what was already in the log', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 200 }) });

  const old = recordJobCreated(ctx.db, 1, 'já estava no log');
  const subscription = await subscribe(ctx, {
    url: 'https://exemplo.invalid/hook',
    secret: SECRET,
  });
  assert.equal(
    subscription.initial_event_id,
    old.id,
    'the subscription is born pointing at the end of the log',
  );

  const fresh = recordJobCreated(ctx.db, 2, 'depois da assinatura');

  await waitFor(t, () => ctx.calls.length >= 1, 'the new event to be pushed');
  await drive(t);

  assert.equal(ctx.calls.length, 1, 'history is not replayed by accident');
  assert.equal((JSON.parse(ctx.calls[0].body) as Event).id, fresh.id);
  assert.deepEqual(
    deliveries(ctx.db, subscription.id).map((delivery) => delivery.event_id),
    [fresh.id],
  );
});

test('AT7 — filter_types narrows the fan-out to the asked types', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 200 }) });

  const subscription = await subscribe(ctx, {
    url: 'https://exemplo.invalid/hook',
    secret: SECRET,
    filter_types: ['job.created'],
  });
  recordJobCreated(ctx.db, 1, 'entra');
  recordJobMoved(ctx.db, 1, 'revisao');
  recordJobCreated(ctx.db, 2, 'entra também');

  await waitFor(t, () => ctx.calls.length >= 2, 'the two matching events to be pushed');
  await drive(t);

  assert.deepEqual(
    ctx.calls.map((call) => (JSON.parse(call.body) as Event).type),
    ['job.created', 'job.created'],
  );
  assert.equal(deliveries(ctx.db, subscription.id).length, 2, 'the transition was never enqueued');
});

test('AT8 — a failed attempt is rescheduled by the backoff step, and retried', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async () => {
      throw new Error('sem rota para o host');
    },
  });

  const subscription = await subscribe(ctx, {
    url: 'https://exemplo.invalid/hook',
    secret: SECRET,
  });
  recordJobCreated(ctx.db, 1, 'para retentar');

  await waitFor(
    t,
    () => deliveries(ctx.db, subscription.id).length === 1,
    'the delivery to be enqueued',
  );
  await waitFor(
    t,
    () => only(deliveries(ctx.db, subscription.id)).attempts === 1,
    'the first attempt to be recorded',
  );

  const failed = only(deliveries(ctx.db, subscription.id));
  assert.equal(failed.status, 'pendente', 'a failure does not end the delivery');
  assert.equal(failed.next_attempt_at, after(BACKOFF_MS[0]));
  assert.equal(failed.delivered_at, null);
  assert.ok(
    (failed.last_error ?? '').includes('sem rota para o host'),
    `the failure is recorded: ${String(failed.last_error)}`,
  );

  await drive(t);
  assert.equal(ctx.calls.length, 1, 'nothing is retried before the step has passed');

  advance(ctx.clock, BACKOFF_MS[0]);
  await waitFor(t, () => ctx.calls.length >= 2, 'the retry once the step has passed');
  await waitFor(
    t,
    () => only(deliveries(ctx.db, subscription.id)).attempts === 2,
    'the second attempt to be recorded',
  );

  const retried = only(deliveries(ctx.db, subscription.id));
  assert.equal(retried.status, 'pendente');
  assert.equal(
    retried.next_attempt_at,
    after(BACKOFF_MS[0] + BACKOFF_MS[1]),
    'the second failure waits the second step of the schedule',
  );
});

test('AT9 — past the last step the delivery is esgotada, and never tried again', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async () => ({ status: 500 }),
  });

  const subscription = await subscribe(ctx, {
    url: 'https://exemplo.invalid/hook',
    secret: SECRET,
  });
  recordJobCreated(ctx.db, 1, 'para esgotar');

  // Six attempts in total: the first one, plus one per step of the schedule.
  for (let attempt = 1; attempt <= BACKOFF_MS.length + 1; attempt += 1) {
    await waitFor(t, () => ctx.calls.length >= attempt, `attempt number ${attempt}`);
    await waitFor(
      t,
      () => only(deliveries(ctx.db, subscription.id)).attempts >= attempt,
      `the result of attempt number ${attempt}`,
    );
    // Past the longest step of the schedule, so the next attempt is always due.
    advance(ctx.clock, 3 * 60 * 60 * 1000);
  }

  const exhausted = only(deliveries(ctx.db, subscription.id));
  assert.equal(exhausted.status, 'esgotada');
  assert.equal(exhausted.attempts, BACKOFF_MS.length + 1);
  assert.equal(exhausted.delivered_at, null);
  assert.ok((exhausted.last_error ?? '').includes('500'), 'the last failure is kept');

  // However far the clock goes, a terminal delivery is not a delivery any more.
  const spent = ctx.calls.length;
  advance(ctx.clock, 365 * 24 * 60 * 60 * 1000);
  await drive(t);
  assert.equal(ctx.calls.length, spent, 'an esgotada delivery is never attempted again');
});

test('AT10 — a broken subscriber does not hold up a healthy one', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async (call) => {
      if (call.url === 'https://exemplo.invalid/quebrado') throw new Error('consumidor quebrado');
      return { status: 200 };
    },
  });

  const broken = await subscribe(ctx, {
    url: 'https://exemplo.invalid/quebrado',
    secret: SECRET,
  });
  const healthy = await subscribe(ctx, {
    url: 'https://exemplo.invalid/saudavel',
    secret: SECRET,
  });
  recordJobCreated(ctx.db, 1, 'para os dois');

  await waitFor(
    t,
    () => deliveries(ctx.db, healthy.id).some((delivery) => delivery.status === 'entregue'),
    "the healthy subscriber's delivery",
  );
  assert.equal(only(deliveries(ctx.db, healthy.id)).status, 'entregue');

  const stuck = only(deliveries(ctx.db, broken.id));
  assert.equal(stuck.status, 'pendente', 'the broken one keeps its own failure');
  assert.ok(stuck.attempts >= 1);
  assert.equal(only(deliveries(ctx.db, healthy.id)).last_error, null);
});

test('AT11 — deactivating stops the retry in flight and every future fan-out', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async () => {
      throw new Error('nao responde');
    },
  });

  const subscription = await subscribe(ctx, {
    url: 'https://exemplo.invalid/hook',
    secret: SECRET,
  });
  const pushed = recordJobCreated(ctx.db, 1, 'antes da desativação');

  await waitFor(
    t,
    () => deliveries(ctx.db, subscription.id).some((delivery) => delivery.attempts === 1),
    'the first attempt, so there is a pending retry to stop',
  );
  const spent = ctx.calls.length;
  assert.equal(only(deliveries(ctx.db, subscription.id)).status, 'pendente');

  const removed = await unsubscribe(ctx, subscription.id);
  assert.equal(typeof removed.deactivated_at, 'string');
  assert.equal(
    only(deliveries(ctx.db, subscription.id)).status,
    'esgotada',
    'the pending retry is closed in the same call',
  );

  // Matching events keep arriving and the clock walks past every backoff step.
  recordJobCreated(ctx.db, 2, 'depois da desativação');
  advance(ctx.clock, 24 * 60 * 60 * 1000);
  await drive(t, LONG_SETTLE_TICKS);

  assert.equal(ctx.calls.length, spent, 'a deactivated subscription is never called again');
  assert.deepEqual(
    deliveries(ctx.db, subscription.id).map((delivery) => delivery.event_id),
    [pushed.id],
    'and the fan-out never enqueues anything else for it',
  );
});
