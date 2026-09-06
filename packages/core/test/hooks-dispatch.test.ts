/**
 * Acceptance tests of the DELIVERY half of graph-declared hooks (t169, AT8–AT12).
 *
 * The harness is `test/webhooks-dispatch.test.ts`'s, deliberately: a bare app
 * carrying only the hook dispatcher over a throwaway database, every clock
 * injected so a two-hour backoff step costs a variable instead of a `sleep`, and
 * `fetchImpl` injected so a delivery is a function call the test reads byte by
 * byte and no test ever opens a socket to the outside.
 *
 * What differs from t142 is where the work comes from. A webhook delivery is
 * born of a FAN-OUT over registered subscriptions; a hook delivery is born of
 * the graph document itself, inside the transaction of the fact that triggered
 * it. So the facts here are produced by `transitionJob`/`blockJob` — the real
 * write path — and never by hand.
 *
 * The signature is recomputed with `node:crypto` directly and never by importing
 * `src/webhooks/signature.ts`: the recipe published in
 * `docs/spec/transition-hooks.md` is what a receiver implements, and
 * asserting against the implementation would prove only that it agrees with
 * itself.
 *
 * The column and JSON names stay in Portuguese: they mirror the migration and
 * the taxonomy's envelope (t127, FR8).
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { applyPragmas, openDatabase, type Database } from '../src/db/connection.ts';
import { listEvents } from '../src/db/events.ts';
import { migrate } from '../src/db/migrate.ts';
import type { GraphDocument } from '../src/domain/graph.ts';
import { registerBaseGraph } from '../src/repositories/graphs.ts';
import { blockJob, createJob, transitionJob, type Job } from '../src/repositories/job.ts';
import { MIGRATIONS_DIR, PACKAGE_ROOT, requireArtifacts } from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T169_ARTIFACTS = Object.freeze({
  migration: 'migrations/0016_gancho.sql',
  repository: 'src/repositories/hooks.ts',
  dispatcher: 'src/hooks/dispatcher.ts',
});

/**
 * What t359 adds on top: the claim that decides who sends (RF-06).
 *
 * The repository and the dispatcher are t169's files, listed again because a
 * missing `claimDelivery` has to fail by NAME here too, not as an `undefined is
 * not a function` three frames deep. The claim itself lives in
 * `src/repositories/webhooks.ts` — the same direction this dispatcher already
 * imports its schedule and its ceilings from.
 */
const T359_ARTIFACTS = Object.freeze({
  migration: 'migrations/0029_delivery_claim.sql',
  claim: 'src/repositories/webhooks.ts',
  repository: 'src/repositories/hooks.ts',
  dispatcher: 'src/hooks/dispatcher.ts',
});

/** Where the key itself lives since t194 — the document only names it. */
const T194_ARTIFACTS = Object.freeze({
  migration: 'migrations/0018_segredo_gancho.sql',
  repository: 'src/repositories/hook-secrets.ts',
});

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

/** Header the delivery carries; HTTP header names are case-insensitive. */
const SIGNATURE_HEADER = 'x-cartografo-signature';

/**
 * The HMAC key itself — registered in `hook_secret`, never in the document.
 *
 * The signature assertion below is unchanged by t194 and that is the point: what
 * moved is where the key is READ from, not what it signs.
 */
const SECRET = 'segredo-declarado-no-grafo-169';

/** The name the document carries in `destination.secret_ref` (t194). */
const SECRET_REF = 'gancho-do-grafo-169';

/** Instant every injected clock starts from. */
const START = '2026-08-16T12:00:00.000Z';

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
 * It replaces a flat `setTimeout(150)` — 15 real ticks' worth of wall clock,
 * hoped for rather than observed. A sleep racing a timer is exactly what flakes
 * on a loaded CI box: the assertion "only one attempt was made" was really
 * asserting "the second attempt did not fit in 150ms of somebody else's
 * machine". Fifteen ticks FIRED is the same margin, made of counted events.
 */
const SETTLE_TICKS = 15;

/** t142's published backoff schedule, which this dispatcher reuses whole. */
const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

/** The event type the control plane records when a hook gives up (FR9). */
const FAILURE_TYPE = 'job.hook_failed';

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
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

/** The surface `src/hooks/dispatcher.ts` has to expose. */
interface HookDispatcherModule {
  registerHookDispatcher: (
    app: FastifyInstance,
    db: Database,
    options?: {
      tickIntervalMs?: number;
      /** How long one attempt may take — and, since t359, how long a claim holds. */
      deliveryTimeoutMs?: number;
      now?: () => string;
      fetchImpl?: FetchLike;
    },
  ) => void;
}

/** A hook, as the graph document declares it. */
interface DeclaredHook {
  id: string;
  trigger: 'node_entered' | 'node_blocked';
  node_id: string;
  destination: { type: 'webhook'; url: string; secret_ref: string };
}

/** The slice of `src/repositories/hook-secrets.ts` this suite writes through. */
interface HookSecretsModule {
  setHookSecret: (db: Database, data: { name: string; value: string }) => unknown;
}

/** One row of `hook_delivery`, read straight from the table. */
interface HookDelivery {
  id: number;
  job_id: number;
  hook_id: string;
  node_id: string;
  event_id: number;
  url: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
}

/** A dispatcher running against a throwaway database. */
interface DispatchContext {
  db: Database;
  /** Every delivery attempt made so far, in arrival order. */
  calls: DeliveryCall[];
  /** The injected clock; the tests move it by hand. */
  clock: { value: string };
}

/** How the injected transport answers one attempt. */
type Responder = (call: DeliveryCall) => Promise<{ status: number }>;

/** The minimal fixture with the given hooks bolted on — a valid document. */
function graphWith(hooks: DeclaredHook[]): GraphDocument {
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as GraphDocument;
  return { ...document, hooks } as GraphDocument;
}

/**
 * A webhook-destination hook, spelled the way the schema declares it.
 *
 * `secretRef` defaults to the one name `startDispatcher` registers, so every
 * test that does not care about resolution gets a hook that resolves; passing
 * another name is how the "reference points at nothing" case is built.
 */
function hook(
  id: string,
  trigger: DeclaredHook['trigger'],
  nodeId: string,
  url: string,
  secretRef: string = SECRET_REF,
): DeclaredHook {
  return {
    id,
    trigger,
    node_id: nodeId,
    destination: { type: 'webhook', url, secret_ref: secretRef },
  };
}

/**
 * Brings up the bare app: the hook dispatcher, and nothing else.
 *
 * @param t Test context, used to register the shutdown.
 * @param options How the transport answers, and how fast the tick runs.
 * @returns Open database, recorded attempts and the injected clock.
 */
async function startDispatcher(
  t: TestContext,
  options: { respond: Responder; tickIntervalMs?: number },
): Promise<DispatchContext> {
  requireArtifacts(
    T169_ARTIFACTS.migration,
    T169_ARTIFACTS.repository,
    T169_ARTIFACTS.dispatcher,
    T194_ARTIFACTS.migration,
    T194_ARTIFACTS.repository,
  );
  const { registerHookDispatcher } = (await import(
    '../src/hooks/dispatcher.ts'
  )) as HookDispatcherModule;
  const { setHookSecret } = (await import(
    '../src/repositories/hook-secrets.ts'
  )) as HookSecretsModule;

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t169d-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  // The deployment's half of the contract (t194): the document names the key,
  // this registers it. Without it every hook below would resolve to nothing.
  setHookSecret(db, { name: SECRET_REF, value: SECRET });

  const calls: DeliveryCall[] = [];
  const clock = { value: START };

  // Before `app.ready()`, because that is where the `onReady` hook arms the
  // dispatcher's one `setInterval`. From here on nothing in this file ticks by
  // itself: `drive` and `waitFor` below fire every single tick, by hand.
  t.mock.timers.enable({ apis: ['setInterval'] });

  const app = Fastify({ logger: false });
  registerHookDispatcher(app, db, {
    tickIntervalMs: options.tickIntervalMs ?? TICK_INTERVAL_MS,
    now: () => clock.value,
    fetchImpl: async (url, init) => {
      const call: DeliveryCall = { url, method: init.method, headers: init.headers, body: init.body };
      calls.push(call);
      return await options.respond(call);
    },
  });
  await app.ready();

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db, calls, clock };
}

/** Registers the graph, creates a job on it and returns the job. */
function jobOn(db: Database, hooks: DeclaredHook[]): Job {
  // `checked`, because this suite is about hook delivery and not about the
  // contract gate: an unchecked version would make `createJob` refuse before any
  // hook could fire (t283). The repository is called directly here, so the
  // outcome is stated instead of computed.
  const versionId = registerBaseGraph(db, graphWith(hooks), {
    state: 'checked',
    problems: [],
  }).version.id;
  return createJob(db, {
    title: 'the note that fires hooks',
    entry_node_id: 'redigir',
    graph_version_id: versionId,
  });
}

/** Every hook delivery in the table, oldest first. */
function deliveries(db: Database): HookDelivery[] {
  return db
    .prepare(
      `SELECT id, job_id, hook_id, node_id, event_id, url, status, attempts,
              next_attempt_at, delivered_at, last_error
         FROM hook_delivery ORDER BY id`,
    )
    .all() as HookDelivery[];
}

/** The one delivery of a table that is supposed to have exactly one. */
function only(rows: HookDelivery[]): HookDelivery {
  assert.equal(rows.length, 1, `expected exactly one hook delivery, got ${rows.length}`);
  return rows[0];
}

/** The `job.hook_failed` events in the log, in order. */
function failureEvents(db: Database): ReturnType<typeof listEvents> {
  return listEvents(db).filter((event) => event.type === FAILURE_TYPE);
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
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/**
 * Fires the dispatcher's interval once and lets that tick run to the end.
 *
 * The two `setImmediate` turns are the whole reason this is not a one-liner.
 * `tick()` only RUNS the timer callback; the work it starts — a read of the due
 * rows, the injected transport, the row write that records the outcome — is a
 * promise chain, and a macrotask turn is what drains it. Firing the next tick
 * before that chain finished would hit the loop's own overlap guard and be
 * dropped, so "twenty ticks" would silently mean something else.
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

test('AT8 — the delivery carries the triggering event, signed with the hook\'s own secret', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 200 }) });

  const job = jobOn(ctx.db, [hook('avisar-revisao', 'node_entered', 'revisar', 'https://example.invalid/gancho')]);
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });

  await waitFor(
t,
() => ctx.calls.length >= 1, 'the hook to be POSTed');
  const [call] = ctx.calls;

  assert.equal(call.url, 'https://example.invalid/gancho');
  assert.equal(call.method, 'POST');
  assert.equal(headerValue(call.headers, 'content-type'), 'application/json');

  // The body is the taxonomy's envelope, byte for byte the same object the
  // stream and t142's webhooks serve — read here through a path the dispatcher
  // does not use.
  const trigger = listEvents(ctx.db, { job_id: job.id }).find(
    (event) => event.type === 'job.transitioned',
  );
  assert.ok(trigger !== undefined, 'the transition has to be in the log');
  assert.equal(call.body, JSON.stringify(trigger), 'the body is the envelope, byte for byte');
  assert.equal(only(deliveries(ctx.db)).event_id, trigger.id);

  const signature = headerValue(call.headers, SIGNATURE_HEADER);
  assert.equal(
    signature,
    `sha256=${createHmac('sha256', SECRET).update(call.body, 'utf8').digest('hex')}`,
    'the signature is the HMAC-SHA256 of the raw body, keyed with the HOOK\'s secret',
  );
});

test('AT9 — a 2xx closes the delivery in silence: no event is recorded', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 204 }) });

  const job = jobOn(ctx.db, [hook('avisar-bloqueio', 'node_blocked', 'redigir', 'https://example.invalid/gancho')]);
  blockJob(ctx.db, job.id, { reason: 'the drafting stopped waiting for the theme' }, { now: () => ctx.clock.value });
  const recorded = listEvents(ctx.db).length;

  await waitFor(
t,
() => only(deliveries(ctx.db)).status === 'delivered', 'the 2xx to close the delivery');
  await drive(t);

  const delivered = only(deliveries(ctx.db));
  assert.equal(delivered.attempts, 1);
  assert.equal(typeof delivered.delivered_at, 'string');
  assert.equal(delivered.last_error, null);
  assert.equal(
    listEvents(ctx.db).length,
    recorded,
    'success is silent: only the error signal is worth a line in the log',
  );
});

test('AT10 — a failed attempt is rescheduled by t142\'s backoff step, and retried', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async () => {
      throw new Error('no route to host');
    },
  });

  const job = jobOn(ctx.db, [hook('avisar-revisao', 'node_entered', 'revisar', 'https://example.invalid/gancho')]);
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });

  await waitFor(
t,
() => only(deliveries(ctx.db)).attempts === 1, 'the first attempt to be recorded');

  const failed = only(deliveries(ctx.db));
  assert.equal(failed.status, 'pending', 'a failure does not end the delivery');
  assert.equal(failed.next_attempt_at, after(BACKOFF_MS[0]));
  assert.equal(failed.delivered_at, null);
  assert.ok(
    (failed.last_error ?? '').includes('no route to host'),
    `the failure is recorded: ${String(failed.last_error)}`,
  );

  await drive(t);
  assert.equal(ctx.calls.length, 1, 'nothing is retried before the step has passed');

  advance(ctx.clock, BACKOFF_MS[0]);
  await waitFor(
t,
() => only(deliveries(ctx.db)).attempts === 2, 'the second attempt to be recorded');

  assert.equal(
    only(deliveries(ctx.db)).next_attempt_at,
    after(BACKOFF_MS[0] + BACKOFF_MS[1]),
    'the second failure waits the second step of the schedule',
  );
  assert.deepEqual(failureEvents(ctx.db), [], 'a transient failure is not an incident yet');
});

test('AT11 — the sixth failed attempt gives up and records one job.hook_failed', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 500 }) });

  const job = jobOn(ctx.db, [hook('avisar-revisao', 'node_entered', 'revisar', 'https://example.invalid/gancho')]);
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });

  // Six attempts in total: the first one, plus one per step of the schedule.
  for (let attempt = 1; attempt <= BACKOFF_MS.length + 1; attempt += 1) {
    await waitFor(
      t,
      () => only(deliveries(ctx.db)).attempts >= attempt,
      `the result of attempt number ${attempt}`,
    );
    // Past the longest step of the schedule, so the next attempt is always due.
    advance(ctx.clock, 3 * 60 * 60 * 1000);
  }

  const exhausted = only(deliveries(ctx.db));
  assert.equal(exhausted.status, 'exhausted');
  assert.equal(exhausted.attempts, BACKOFF_MS.length + 1);
  assert.equal(exhausted.delivered_at, null);

  const incidents = failureEvents(ctx.db);
  assert.equal(incidents.length, 1, 'exhaustion records exactly one event, not one per attempt');
  const [incident] = incidents;
  assert.equal(incident.entity.type, 'job');
  assert.equal(incident.entity.id, job.id);
  assert.equal(incident.actor.type, 'system');
  assert.deepEqual(incident.data, {
    hook_id: 'avisar-revisao',
    node_id: 'revisar',
    url: 'https://example.invalid/gancho',
    last_error: exhausted.last_error,
  });
  assert.ok(String(incident.data.last_error).includes('500'), 'the last failure is what is reported');

  // However far the clock goes, a terminal delivery is not a delivery any more —
  // and it never records a second incident.
  const spent = ctx.calls.length;
  advance(ctx.clock, 365 * 24 * 60 * 60 * 1000);
  await drive(t);
  assert.equal(ctx.calls.length, spent, 'an esgotada delivery is never attempted again');
  assert.equal(failureEvents(ctx.db).length, 1);
});

test('AT12 — a dead hook does not hold up another hook of the same batch', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async (call) => {
      if (call.url === 'https://example.invalid/morto') throw new Error('broken consumer');
      return { status: 200 };
    },
  });

  const job = jobOn(ctx.db, [
    hook('avisar-morto', 'node_entered', 'revisar', 'https://example.invalid/morto'),
    hook('avisar-vivo', 'node_entered', 'revisar', 'https://example.invalid/vivo'),
  ]);
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });

  // One event, two hooks, two independent deliveries (FR5).
  await waitFor(
t,
() => deliveries(ctx.db).length === 2, 'both hooks to be enqueued');
  const [first, second] = deliveries(ctx.db);
  assert.equal(first.event_id, second.event_id, 'the same event fired both');

  const healthy = (): HookDelivery => {
    const found = deliveries(ctx.db).find((row) => row.hook_id === 'avisar-vivo');
    assert.ok(found !== undefined, 'the healthy hook has to keep its row');
    return found;
  };

  await waitFor(
t,
() => healthy().status === 'delivered', 'the healthy hook to be delivered');
  assert.equal(healthy().last_error, null);

  const broken = deliveries(ctx.db).find((row) => row.hook_id === 'avisar-morto');
  assert.ok(broken !== undefined);
  assert.equal(broken.status, 'pending', 'the dead one keeps its own failure');
  assert.ok(broken.attempts >= 1);
});

test('t194 — a secret_ref that resolves to nothing enqueues nothing, and is silent about it', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 200 }) });

  const job = jobOn(ctx.db, [
    hook(
      'avisar-sem-chave',
      'node_entered',
      'revisar',
      'https://example.invalid/sem-chave',
      'nome-que-ninguem-registrou',
    ),
    hook('avisar-vivo', 'node_entered', 'revisar', 'https://example.invalid/vivo'),
  ]);
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });

  await waitFor(
t,
() => ctx.calls.length >= 1, 'the resolvable hook to be POSTed');
  await drive(t);

  // Zero rows and zero error, the same answer the repository already gives for a
  // job with no version, a version that does not resolve and a snapshot with no
  // `hooks` — a reference the deployment never registered is the same kind of
  // "nothing to look this up in".
  assert.deepEqual(
    deliveries(ctx.db).map((row) => row.hook_id),
    ['avisar-vivo'],
    'a hook with no live secret produces no delivery row at all',
  );
  assert.deepEqual(
    ctx.calls.map((call) => call.url),
    ['https://example.invalid/vivo'],
    'and the healthy hook of the same batch goes out untouched',
  );
  assert.deepEqual(
    failureEvents(ctx.db),
    [],
    'observability for an unresolvable reference is a separate ticket, on purpose',
  );
});

/* -------------------------------------------------------------------------- *
 * t359 — the claim: two dispatchers on one queue, one outbound call (RF-06)
 * -------------------------------------------------------------------------- */

/**
 * How long a claim holds the row, injected so it is not a backoff step.
 *
 * t142's `DELIVERY_TIMEOUT_MS` and `BACKOFF_MS[0]` are both 10 seconds in
 * production, which would make "the claim expired" and "the first backoff step
 * elapsed" indistinguishable in an assertion. 45 seconds is neither, so every
 * date below names exactly one reason.
 */
const CLAIM_TIMEOUT_MS = 45_000;

/** How many hook deliveries the two dispatchers race over. */
const RACED_DELIVERIES = 10;

/** Ticks a "and then nothing else happened" assertion drives over two ticks. */
const LONG_SETTLE_TICKS = 20;

/** Everything the claim writes, beside everything it must not touch. */
interface ClaimedRow {
  id: number;
  status: string;
  attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
}

/**
 * The claim, read from where it LIVES.
 *
 * `src/repositories/hooks.ts` imports it from `src/repositories/webhooks.ts`
 * rather than defining a second one, so that is where this suite reaches for it
 * too — the same direction `src/hooks/dispatcher.ts` already imports the backoff
 * schedule and the ceilings from.
 */
interface ClaimModule {
  claimDelivery: (
    db: Database,
    table: 'webhook_delivery' | 'hook_delivery',
    id: number,
    moment: string,
    attemptTimeoutMs: number,
    options?: { now?: () => string },
  ) => boolean;
}

/** The claim's own view of a hook delivery row, `claimed_at` included. */
function claimRow(db: Database, id: number): ClaimedRow {
  const row = db
    .prepare(
      `SELECT id, status, attempts, next_attempt_at, claimed_at, delivered_at, last_error
         FROM hook_delivery WHERE id = ?`,
    )
    .get(id) as ClaimedRow | undefined;
  assert.ok(row !== undefined, `hook delivery ${id} has to be in the table`);
  return row;
}

/** Ten hooks on the same node, so one transition queues ten deliveries. */
function tenHooks(): DeclaredHook[] {
  return Array.from({ length: RACED_DELIVERIES }, (_ignored, index) =>
    hook(
      `avisar-${String(index + 1)}`,
      'node_entered',
      'revisar',
      `https://example.invalid/gancho-${String(index + 1)}`,
    ),
  );
}

/**
 * TWO hook dispatchers over ONE database file — the shape RF-06 is about.
 *
 * Two things make this different from {@link startDispatcher}, and both are the
 * point:
 *
 * - the file path is real and each app gets its own `openDatabase()` over it,
 *   never `:memory:`. Two handles on one memory database are two databases;
 *   two handles on one file are what a hosted second control plane would be;
 * - the two apps share ONE mocked `setInterval`, so a single
 *   `t.mock.timers.tick()` fires both dispatchers' timers in the same turn.
 *   That IS the `Promise.all` over both ticks: `better-sqlite3` is synchronous,
 *   so the first tick's claims land before the second tick reads what is due,
 *   and if the claim were missing the second tick would read the very same rows
 *   the first is already sending — which is exactly the race being asserted
 *   away.
 *
 * @param t Test context, used to register the shutdown.
 * @param options How the transport answers, and how long a claim holds.
 * @returns The FIRST app's database, the attempts BOTH dispatchers made, and
 *   the one clock they share.
 */
async function startDispatcherPair(
  t: TestContext,
  options: { respond: Responder; deliveryTimeoutMs?: number },
): Promise<DispatchContext> {
  requireArtifacts(
    T169_ARTIFACTS.migration,
    T169_ARTIFACTS.repository,
    T194_ARTIFACTS.migration,
    T359_ARTIFACTS.migration,
    T359_ARTIFACTS.claim,
    T359_ARTIFACTS.dispatcher,
  );
  const { registerHookDispatcher } = (await import(
    '../src/hooks/dispatcher.ts'
  )) as HookDispatcherModule;
  const { setHookSecret } = (await import(
    '../src/repositories/hook-secrets.ts'
  )) as HookSecretsModule;

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t359h-'));
  const file = path.join(base, 'cartografo.db');

  const first = openDatabase(file);
  applyPragmas(first);
  migrate(first, MIGRATIONS_DIR);
  setHookSecret(first, { name: SECRET_REF, value: SECRET });

  // The second routine's own connection to the same file. It does NOT migrate:
  // the schema is already there, and a second `migrate()` is a different
  // ticket's assertion.
  const second = openDatabase(file);
  applyPragmas(second);

  const calls: DeliveryCall[] = [];
  const clock = { value: START };

  t.mock.timers.enable({ apis: ['setInterval'] });

  const apps: FastifyInstance[] = [];
  for (const db of [first, second]) {
    const app = Fastify({ logger: false });
    registerHookDispatcher(app, db, {
      tickIntervalMs: TICK_INTERVAL_MS,
      deliveryTimeoutMs: options.deliveryTimeoutMs ?? CLAIM_TIMEOUT_MS,
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
    await app.ready();
    apps.push(app);
  }

  t.after(async () => {
    for (const app of apps) await app.close();
    first.close();
    second.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db: first, calls, clock };
}

test('t359 — two hook dispatchers over one queue make exactly one call per delivery', async (t) => {
  const ctx = await startDispatcherPair(t, { respond: async () => ({ status: 200 }) });

  const job = jobOn(ctx.db, tenHooks());
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });
  assert.equal(deliveries(ctx.db).length, RACED_DELIVERIES, 'ten hooks, ten queued deliveries');

  await waitFor(
    t,
    () => deliveries(ctx.db).every((delivery) => delivery.status === 'delivered'),
    'every hook delivery to be closed',
  );
  await drive(t);

  assert.equal(
    ctx.calls.length,
    RACED_DELIVERIES,
    'ten deliveries, ten outbound calls: whoever lost each race called nothing',
  );

  const rows = deliveries(ctx.db);
  assert.equal(rows.length, RACED_DELIVERIES);
  for (const row of rows) {
    assert.equal(row.attempts, 1, `hook delivery ${row.id} was attempted exactly once`);
    assert.equal(row.last_error, null, `hook delivery ${row.id} recorded no failure`);
  }
  assert.deepEqual(failureEvents(ctx.db), [], 'and nobody gave up on anything');
});

test('t359 — a hook claim whose routine never comes back is claimed again, and only once more', async (t) => {
  // The first attempt hangs and never resolves: a process that crashed after
  // winning the claim and before writing the outcome. `release` exists only so
  // the teardown is not left waiting on it forever.
  let release: (() => void) | undefined;
  const hang = new Promise<{ status: number }>((resolve) => {
    release = () => resolve({ status: 200 });
  });
  // Registered BEFORE the harness's own shutdown hook, and `after` hooks run in
  // registration order: whatever this test asserts, the crashed attempt is let
  // go before `app.close()` waits on the tick that is holding it.
  t.after(() => release?.());

  let seen = 0;
  const ctx = await startDispatcherPair(t, {
    respond: async () => {
      seen += 1;
      return seen === 1 ? await hang : { status: 200 };
    },
  });

  const job = jobOn(ctx.db, [
    hook('avisar-revisao', 'node_entered', 'revisar', 'https://example.invalid/gancho'),
  ]);
  transitionJob(ctx.db, job.id, { to_node_id: 'revisar' }, { now: () => ctx.clock.value });

  await waitFor(t, () => ctx.calls.length >= 1, 'the first attempt to go out');
  const claimed = only(deliveries(ctx.db));
  assert.equal(claimed.attempts, 1, 'the claim counted the attempt before the call went out');
  assert.equal(claimed.status, 'pending', 'nothing was recorded: the routine never came back');

  // Not yet: the claim still holds the row, so neither routine may touch it.
  advance(ctx.clock, CLAIM_TIMEOUT_MS - 1000);
  await drive(t, LONG_SETTLE_TICKS);
  assert.equal(ctx.calls.length, 1, 'a live claim is not stolen by the other dispatcher');

  // Past `claimedAt + deliveryTimeoutMs` the row is a due candidate again.
  advance(ctx.clock, 1000);
  await waitFor(
    t,
    () => only(deliveries(ctx.db)).status === 'delivered',
    'the expired claim to be taken again and delivered',
  );
  await drive(t, LONG_SETTLE_TICKS);

  assert.equal(ctx.calls.length, 2, 'exactly one more attempt: not none, and not a stampede');
  const delivered = only(deliveries(ctx.db));
  assert.equal(delivered.attempts, 2, 'the re-claim costs one more attempt, and only one');
  assert.equal(delivered.last_error, null);

  // The crashed routine finally answers. Its outcome write finds a row that is
  // no longer `pending`, so it changes nothing.
  release?.();
  await drive(t);
  assert.equal(ctx.calls.length, 2);
  assert.deepEqual(only(deliveries(ctx.db)), delivered);
});

test('t359 — a lost hook claim leaves the row exactly as the winner left it', async (t) => {
  requireArtifacts(T169_ARTIFACTS.migration, T359_ARTIFACTS.migration, T359_ARTIFACTS.claim);
  const { claimDelivery } = (await import('../src/repositories/webhooks.ts')) as ClaimModule;
  assert.equal(
    typeof claimDelivery,
    'function',
    'src/repositories/webhooks.ts has to export claimDelivery',
  );
  const { setHookSecret } = (await import(
    '../src/repositories/hook-secrets.ts'
  )) as HookSecretsModule;

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t359hu-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);
  setHookSecret(db, { name: SECRET_REF, value: SECRET });
  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  const job = jobOn(db, [
    hook('avisar-revisao', 'node_entered', 'revisar', 'https://example.invalid/gancho'),
  ]);
  transitionJob(db, job.id, { to_node_id: 'revisar' }, { now: () => START });
  const queued = only(deliveries(db));

  const won = claimDelivery(db, 'hook_delivery', queued.id, START, CLAIM_TIMEOUT_MS, {
    now: () => START,
  });
  assert.equal(won, true, 'the first routine over a due row wins the claim');

  const winner = claimRow(db, queued.id);
  assert.equal(winner.attempts, 1, 'the claim counts the attempt it authorises');
  assert.equal(winner.claimed_at, START, 'and records when it took the row');
  assert.equal(
    winner.next_attempt_at,
    after(CLAIM_TIMEOUT_MS),
    'and holds the row for one attempt timeout',
  );

  // The loser runs a full second later, so any write it made would be visible.
  const lost = claimDelivery(db, 'hook_delivery', queued.id, START, CLAIM_TIMEOUT_MS, {
    now: () => after(1000),
  });
  assert.equal(lost, false, 'the second routine over the same row loses the race');

  const afterLoss = claimRow(db, queued.id);
  assert.equal(afterLoss.status, winner.status, 'a lost claim does not move the status');
  assert.equal(afterLoss.attempts, winner.attempts, 'a lost claim counts no attempt');
  assert.equal(
    afterLoss.next_attempt_at,
    winner.next_attempt_at,
    'a lost claim does not push the schedule',
  );
  assert.equal(afterLoss.claimed_at, winner.claimed_at, 'a lost claim does not restamp the claim');
  assert.equal(afterLoss.last_error, winner.last_error, 'a lost claim records no failure');
  assert.equal(afterLoss.delivered_at, winner.delivered_at, 'a lost claim records no delivery');
  assert.deepEqual(afterLoss, winner, 'and nothing else on the row moved either');
});
