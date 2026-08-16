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
 * `docs/spec/ganchos-de-transicao.md` is what a receiver implements, and
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
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { applyPragmas, openDatabase, type Database } from '../src/db/connection.ts';
import { listEvents } from '../src/db/events.ts';
import { migrate } from '../src/db/migrate.ts';
import type { GraphDocument } from '../src/domain/graph.ts';
import { registerBaseGraph } from '../src/repositories/graphs.ts';
import { blockJob, createJob, transitionJob, type Job } from '../src/repositories/job.ts';
import { MIGRATIONS_DIR, PACKAGE_ROOT, requireArtifacts, type TestHook } from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T169_ARTIFACTS = Object.freeze({
  migration: 'migrations/0016_gancho.sql',
  repository: 'src/repositories/hooks.ts',
  dispatcher: 'src/hooks/dispatcher.ts',
});

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

/** Header the delivery carries; HTTP header names are case-insensitive. */
const SIGNATURE_HEADER = 'x-cartografo-assinatura';

/** The secret the graph's author chose — the server never generates one. */
const SECRET = 'segredo-declarado-no-grafo-169';

/** Instant every injected clock starts from. */
const START = '2026-08-16T12:00:00.000Z';

/** t142's published backoff schedule, which this dispatcher reuses whole. */
const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

/** The event type the control plane records when a hook gives up (FR9). */
const FAILURE_TYPE = 'trabalho.gancho_falhou';

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
    options?: { tickIntervalMs?: number; now?: () => string; fetchImpl?: FetchLike },
  ) => void;
}

/** A hook, as the graph document declares it. */
interface DeclaredHook {
  id: string;
  trigger: 'node_entered' | 'node_blocked';
  node_id: string;
  destination: { type: 'webhook'; url: string; secret: string };
}

/** One row of `entrega_gancho`, read straight from the table. */
interface HookDelivery {
  id: number;
  trabalho_id: number;
  gancho_id: string;
  no_id: string;
  evento_id: number;
  url: string;
  status: string;
  tentativas: number;
  proxima_tentativa_em: string;
  entregue_em: string | null;
  ultimo_erro: string | null;
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

/** A webhook-destination hook, spelled the way the schema declares it. */
function hook(id: string, trigger: DeclaredHook['trigger'], nodeId: string, url: string): DeclaredHook {
  return { id, trigger, node_id: nodeId, destination: { type: 'webhook', url, secret: SECRET } };
}

/**
 * Brings up the bare app: the hook dispatcher, and nothing else.
 *
 * @param t Test context, used to register the shutdown.
 * @param options How the transport answers, and how fast the tick runs.
 * @returns Open database, recorded attempts and the injected clock.
 */
async function startDispatcher(
  t: TestHook,
  options: { respond: Responder; tickIntervalMs?: number },
): Promise<DispatchContext> {
  requireArtifacts(
    T169_ARTIFACTS.migration,
    T169_ARTIFACTS.repository,
    T169_ARTIFACTS.dispatcher,
  );
  const { registerHookDispatcher } = (await import(
    '../src/hooks/dispatcher.ts'
  )) as HookDispatcherModule;

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t169d-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const calls: DeliveryCall[] = [];
  const clock = { value: START };

  const app = Fastify({ logger: false });
  registerHookDispatcher(app, db, {
    tickIntervalMs: options.tickIntervalMs ?? 10,
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
  const versionId = registerBaseGraph(db, graphWith(hooks)).version.id;
  return createJob(db, {
    titulo: 'a nota que dispara ganchos',
    no_entrada_id: 'redigir',
    grafo_versao_id: versionId,
  });
}

/** Every hook delivery in the table, oldest first. */
function deliveries(db: Database): HookDelivery[] {
  return db
    .prepare(
      `SELECT id, trabalho_id, gancho_id, no_id, evento_id, url, status, tentativas,
              proxima_tentativa_em, entregue_em, ultimo_erro
         FROM entrega_gancho ORDER BY id`,
    )
    .all() as HookDelivery[];
}

/** The one delivery of a table that is supposed to have exactly one. */
function only(rows: HookDelivery[]): HookDelivery {
  assert.equal(rows.length, 1, `expected exactly one hook delivery, got ${rows.length}`);
  return rows[0];
}

/** The `trabalho.gancho_falhou` events in the log, in order. */
function failureEvents(db: Database): ReturnType<typeof listEvents> {
  return listEvents(db).filter((event) => event.tipo === FAILURE_TYPE);
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

/** Waits for a condition, failing with a readable message instead of a timeout. */
async function waitFor(condition: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Sleeps for several ticks, for the "and then nothing else happened" assertions. */
const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('AT8 — the delivery carries the triggering event, signed with the hook\'s own secret', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 200 }) });

  const job = jobOn(ctx.db, [hook('avisar-revisao', 'node_entered', 'revisar', 'https://exemplo.invalid/gancho')]);
  transitionJob(ctx.db, job.id, { para_no_id: 'revisar' }, { now: () => ctx.clock.value });

  await waitFor(() => ctx.calls.length >= 1, 'the hook to be POSTed');
  const [call] = ctx.calls;

  assert.equal(call.url, 'https://exemplo.invalid/gancho');
  assert.equal(call.method, 'POST');
  assert.equal(headerValue(call.headers, 'content-type'), 'application/json');

  // The body is the taxonomy's envelope, byte for byte the same object the
  // stream and t142's webhooks serve — read here through a path the dispatcher
  // does not use.
  const trigger = listEvents(ctx.db, { trabalho_id: job.id }).find(
    (event) => event.tipo === 'trabalho.transicao',
  );
  assert.ok(trigger !== undefined, 'the transition has to be in the log');
  assert.equal(call.body, JSON.stringify(trigger), 'the body is the envelope, byte for byte');
  assert.equal(only(deliveries(ctx.db)).evento_id, trigger.id);

  const signature = headerValue(call.headers, SIGNATURE_HEADER);
  assert.equal(
    signature,
    `sha256=${createHmac('sha256', SECRET).update(call.body, 'utf8').digest('hex')}`,
    'the signature is the HMAC-SHA256 of the raw body, keyed with the HOOK\'s secret',
  );
});

test('AT9 — a 2xx closes the delivery in silence: no event is recorded', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 204 }) });

  const job = jobOn(ctx.db, [hook('avisar-bloqueio', 'node_blocked', 'redigir', 'https://exemplo.invalid/gancho')]);
  blockJob(ctx.db, job.id, { motivo: 'a redação parou esperando o tema' }, { now: () => ctx.clock.value });
  const recorded = listEvents(ctx.db).length;

  await waitFor(() => only(deliveries(ctx.db)).status === 'entregue', 'the 2xx to close the delivery');
  await settle();

  const delivered = only(deliveries(ctx.db));
  assert.equal(delivered.tentativas, 1);
  assert.equal(typeof delivered.entregue_em, 'string');
  assert.equal(delivered.ultimo_erro, null);
  assert.equal(
    listEvents(ctx.db).length,
    recorded,
    'success is silent: only the error signal is worth a line in the log',
  );
});

test('AT10 — a failed attempt is rescheduled by t142\'s backoff step, and retried', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async () => {
      throw new Error('sem rota para o host');
    },
  });

  const job = jobOn(ctx.db, [hook('avisar-revisao', 'node_entered', 'revisar', 'https://exemplo.invalid/gancho')]);
  transitionJob(ctx.db, job.id, { para_no_id: 'revisar' }, { now: () => ctx.clock.value });

  await waitFor(() => only(deliveries(ctx.db)).tentativas === 1, 'the first attempt to be recorded');

  const failed = only(deliveries(ctx.db));
  assert.equal(failed.status, 'pendente', 'a failure does not end the delivery');
  assert.equal(failed.proxima_tentativa_em, after(BACKOFF_MS[0]));
  assert.equal(failed.entregue_em, null);
  assert.ok(
    (failed.ultimo_erro ?? '').includes('sem rota para o host'),
    `the failure is recorded: ${String(failed.ultimo_erro)}`,
  );

  await settle();
  assert.equal(ctx.calls.length, 1, 'nothing is retried before the step has passed');

  advance(ctx.clock, BACKOFF_MS[0]);
  await waitFor(() => only(deliveries(ctx.db)).tentativas === 2, 'the second attempt to be recorded');

  assert.equal(
    only(deliveries(ctx.db)).proxima_tentativa_em,
    after(BACKOFF_MS[0] + BACKOFF_MS[1]),
    'the second failure waits the second step of the schedule',
  );
  assert.deepEqual(failureEvents(ctx.db), [], 'a transient failure is not an incident yet');
});

test('AT11 — the sixth failed attempt gives up and records one trabalho.gancho_falhou', async (t) => {
  const ctx = await startDispatcher(t, { respond: async () => ({ status: 500 }) });

  const job = jobOn(ctx.db, [hook('avisar-revisao', 'node_entered', 'revisar', 'https://exemplo.invalid/gancho')]);
  transitionJob(ctx.db, job.id, { para_no_id: 'revisar' }, { now: () => ctx.clock.value });

  // Six attempts in total: the first one, plus one per step of the schedule.
  for (let attempt = 1; attempt <= BACKOFF_MS.length + 1; attempt += 1) {
    await waitFor(
      () => only(deliveries(ctx.db)).tentativas >= attempt,
      `the result of attempt number ${attempt}`,
    );
    // Past the longest step of the schedule, so the next attempt is always due.
    advance(ctx.clock, 3 * 60 * 60 * 1000);
  }

  const exhausted = only(deliveries(ctx.db));
  assert.equal(exhausted.status, 'esgotada');
  assert.equal(exhausted.tentativas, BACKOFF_MS.length + 1);
  assert.equal(exhausted.entregue_em, null);

  const incidents = failureEvents(ctx.db);
  assert.equal(incidents.length, 1, 'exhaustion records exactly one event, not one per attempt');
  const [incident] = incidents;
  assert.equal(incident.entidade.tipo, 'trabalho');
  assert.equal(incident.entidade.id, job.id);
  assert.equal(incident.ator.tipo, 'sistema');
  assert.deepEqual(incident.dados, {
    gancho_id: 'avisar-revisao',
    no_id: 'revisar',
    url: 'https://exemplo.invalid/gancho',
    ultimo_erro: exhausted.ultimo_erro,
  });
  assert.ok(String(incident.dados.ultimo_erro).includes('500'), 'the last failure is what is reported');

  // However far the clock goes, a terminal delivery is not a delivery any more —
  // and it never records a second incident.
  const spent = ctx.calls.length;
  advance(ctx.clock, 365 * 24 * 60 * 60 * 1000);
  await settle();
  assert.equal(ctx.calls.length, spent, 'an esgotada delivery is never attempted again');
  assert.equal(failureEvents(ctx.db).length, 1);
});

test('AT12 — a dead hook does not hold up another hook of the same batch', async (t) => {
  const ctx = await startDispatcher(t, {
    respond: async (call) => {
      if (call.url === 'https://exemplo.invalid/morto') throw new Error('consumidor quebrado');
      return { status: 200 };
    },
  });

  const job = jobOn(ctx.db, [
    hook('avisar-morto', 'node_entered', 'revisar', 'https://exemplo.invalid/morto'),
    hook('avisar-vivo', 'node_entered', 'revisar', 'https://exemplo.invalid/vivo'),
  ]);
  transitionJob(ctx.db, job.id, { para_no_id: 'revisar' }, { now: () => ctx.clock.value });

  // One event, two hooks, two independent deliveries (FR5).
  await waitFor(() => deliveries(ctx.db).length === 2, 'both hooks to be enqueued');
  const [first, second] = deliveries(ctx.db);
  assert.equal(first.evento_id, second.evento_id, 'the same event fired both');

  const healthy = (): HookDelivery => {
    const found = deliveries(ctx.db).find((row) => row.gancho_id === 'avisar-vivo');
    assert.ok(found !== undefined, 'the healthy hook has to keep its row');
    return found;
  };

  await waitFor(() => healthy().status === 'entregue', 'the healthy hook to be delivered');
  assert.equal(healthy().ultimo_erro, null);

  const broken = deliveries(ctx.db).find((row) => row.gancho_id === 'avisar-morto');
  assert.ok(broken !== undefined);
  assert.equal(broken.status, 'pendente', 'the dead one keeps its own failure');
  assert.ok(broken.tentativas >= 1);
});
