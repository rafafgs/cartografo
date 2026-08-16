/**
 * Acceptance tests of the outbound event stream (t123, AT1–AT8).
 *
 * This suite reads a response WHILE it is still open, which is the one thing the
 * other route tests never do: `request()` from `./support.ts` waits for the body
 * to end, and an SSE body never ends. So everything here goes through `fetch`
 * against the real listening server (`startControlPlane`), reading
 * `response.body` chunk by chunk into a tiny SSE parser — and, since t124, with
 * the credential every `/v1` route now demands (`startAuthorizedControlPlane`).
 *
 * Two servers show up below, on purpose:
 *
 * - the control plane itself (`ctx.url`), which is what proves the route is
 *   registered in `src/server.ts` and answers on `/v1/events/stream` with the
 *   production intervals (AT1, AT4);
 * - a bare app carrying ONLY the stream route, over the same open database, with
 *   the poll and heartbeat intervals injected small (`startStreamApp`). This is
 *   what FR5's injectable interval buys: the heartbeat test costs 20ms instead
 *   of 15 real seconds, and the resume tests do not wait three poll ticks.
 *
 * The `src/` modules are loaded on demand, behind `requireArtifacts`, for the
 * same reason as the rest of the suite (`test/support.ts:8-11`): on the initial
 * red the failure NAMES the missing route file instead of blowing up with a
 * module resolution error that looks like any other bug.
 *
 * The JSON field names stay in Portuguese: they are the envelope the taxonomy
 * froze, mirrored from the untouched migration columns (t127, FR8).
 */

import assert from 'node:assert/strict';
import { connect } from 'node:net';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { authorizeGlobalFetch } from './authorized-fetch.ts';
import type { Database } from '../src/db/connection.ts';
import {
  createJob,
  request,
  requireArtifacts,
  startControlPlane,
  type Event,
  type Job,
  type TestContext,
  type TestHook,
} from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T123_ARTIFACTS = Object.freeze({
  streamRoutes: 'src/routes/events.ts',
  events: 'src/db/events.ts',
  server: 'src/server.ts',
});

/** Intervals the stream route accepts so a test does not wait real seconds. */
interface StreamOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

/** The surface `src/routes/events.ts` has to expose (FR5). */
interface StreamRoutesModule {
  registerEvents: (app: FastifyInstance, db: Database, options?: StreamOptions) => void;
}

/** Loads the stream route on demand (named initial red). */
async function loadStreamRoutes(): Promise<StreamRoutesModule> {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  return (await import('../src/routes/events.ts')) as StreamRoutesModule;
}

/** One SSE message, already split into its three fields. */
interface StreamMessage {
  id: string | null;
  event: string | null;
  data: string;
}

/** An open SSE connection, being read in the background. */
interface OpenStream {
  status: number;
  contentType: string | null;
  /** Messages delivered so far, in arrival order. */
  messages: StreamMessage[];
  /** Comment lines delivered so far (`: heartbeat` arrives here). */
  comments: string[];
  abort: () => void;
}

/** Parses one `\n\n`-terminated SSE block into the arrays above. */
function absorb(block: string, stream: OpenStream): void {
  const lines = block.split('\n').filter((line) => line !== '');
  if (lines.length === 0) return;

  if (lines.every((line) => line.startsWith(':'))) {
    for (const line of lines) stream.comments.push(line.slice(1).trim());
    return;
  }

  const message: StreamMessage = { id: null, event: null, data: '' };
  for (const line of lines) {
    const cut = line.indexOf(':');
    const field = cut === -1 ? line : line.slice(0, cut);
    const value = cut === -1 ? '' : line.slice(cut + 1).replace(/^ /, '');
    if (field === 'id') message.id = value;
    if (field === 'event') message.event = value;
    if (field === 'data') message.data = message.data === '' ? value : `${message.data}\n${value}`;
  }
  stream.messages.push(message);
}

/**
 * Opens the stream and starts reading it in the background.
 *
 * `fetch` resolves as soon as the headers arrive — which, for this route, is
 * after the server has already resolved the connection's cursor. That is what
 * makes "open the stream, THEN record the event" a reliable order in the tests
 * below, and not a race.
 */
async function openStream(
  url: string,
  headers: Record<string, string> = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });

  const stream: OpenStream = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    messages: [],
    comments: [],
    abort: () => controller.abort(),
  };

  const body = response.body;
  if (body !== null) {
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          absorb(buffer.slice(0, cut), stream);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
    })().catch(() => {
      // The abort of the test itself ends the read; there is nothing to report.
    });
  }

  return stream;
}

/** Waits for a condition, failing with a readable message instead of a timeout. */
async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Sleeps, for the "and then nothing else arrived" assertions. */
const settle = (ms = 150): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The control plane, with this file's raw `fetch` calls already authenticated.
 *
 * `request()` from `./support.ts` attaches the credential itself, but the whole
 * point of this suite is the calls that CANNOT go through it — an SSE body never
 * ends — and those speak the global `fetch` directly. Since t124 every `/v1`
 * route answers `401` without a credential, so the same patch the other
 * fetch-by-hand suites use (`./authorized-fetch.ts`) applies here: it presents a
 * real token, issued against this very database, and only to THIS server — the
 * bare stream app below carries no gate and is left alone.
 *
 * @param t Test context, so the patch is undone at the end.
 * @returns The control plane context, credential included.
 */
async function startAuthorizedControlPlane(t: TestHook): Promise<TestContext> {
  const ctx = await startControlPlane(t);
  authorizeGlobalFetch(t, { baseUrl: ctx.url, token: ctx.token });
  return ctx;
}

/**
 * A second app carrying only the stream route, over the same database.
 *
 * The writes keep going through the control plane's own API (D1: the server is
 * the writer); what changes here is only the read side's clock.
 */
async function startStreamApp(
  t: TestHook,
  ctx: TestContext,
  options: StreamOptions,
): Promise<{ url: string; app: FastifyInstance }> {
  const { registerEvents } = await loadStreamRoutes();
  const app = Fastify({ logger: false });
  app.register(async (scope) => registerEvents(scope, ctx.db, options), { prefix: '/v1' });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
  });
  return { url, app };
}

/** Records a `trabalho.transicao` through the API. */
async function moveJob(ctx: TestContext, id: number, target: string): Promise<void> {
  const response = await request<Job>(ctx, 'POST', `/v1/jobs/${id}/transitions`, {
    para_no_id: target,
  });
  assert.equal(response.status, 200, `POST /v1/jobs/${id}/transitions returned ${response.status}`);
}

test('AT1 — the stream delivers the envelope the events route would return', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes, T123_ARTIFACTS.server);
  const ctx = await startAuthorizedControlPlane(t);

  const stream = await openStream(`${ctx.url}/v1/events/stream`);
  t.after(() => stream.abort());

  assert.equal(stream.status, 200);
  assert.equal(stream.contentType, 'text/event-stream');

  const job = await createJob(ctx, {
    titulo: 'primeiro trabalho da rodada',
    no_entrada_id: 'entrada',
    execucao_id: 41,
  });

  await waitFor(() => stream.messages.length >= 1, 'the created job to reach the stream');

  const [message] = stream.messages;
  const recorded = await request<{ eventos: Event[] }>(
    ctx,
    'GET',
    '/v1/executions/41/events',
  );
  assert.equal(recorded.status, 200);
  const [expected] = recorded.body.eventos;

  assert.equal(message.event, 'trabalho.criado');
  assert.equal(message.id, String(expected.id));
  assert.deepEqual(JSON.parse(message.data), expected);
  assert.equal((JSON.parse(message.data) as Event).entidade.id, job.id);
});

test('AT2 — ?tipo filters the stream down to the asked types', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startAuthorizedControlPlane(t);
  const { url } = await startStreamApp(t, ctx, { pollIntervalMs: 20 });

  const stream = await openStream(`${url}/v1/events/stream?tipo=trabalho.transicao`);
  t.after(() => stream.abort());

  const job = await createJob(ctx, { titulo: 'anda', no_entrada_id: 'entrada' });
  await moveJob(ctx, job.id, 'revisao');

  await waitFor(() => stream.messages.length >= 1, 'the transition to reach the stream');
  await settle();

  assert.equal(stream.messages.length, 1, 'only the transition was asked for');
  assert.deepEqual(
    stream.messages.map((message) => message.event),
    ['trabalho.transicao'],
  );
});

test('AT3 — ?projeto_id keeps another project out of the stream', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startAuthorizedControlPlane(t);
  const { url } = await startStreamApp(t, ctx, { pollIntervalMs: 20 });

  const stream = await openStream(`${url}/v1/events/stream?projeto_id=42`);
  t.after(() => stream.abort());

  await createJob(ctx, { titulo: 'de outro projeto', no_entrada_id: 'entrada', projeto_id: 7 });
  const mine = await createJob(ctx, {
    titulo: 'do projeto 42',
    no_entrada_id: 'entrada',
    projeto_id: 42,
  });

  await waitFor(() => stream.messages.length >= 1, "project 42's job to reach the stream");
  await settle();

  assert.equal(stream.messages.length, 1, "the other project's event must not be delivered");
  const delivered = JSON.parse(stream.messages[0].data) as Event;
  assert.equal(delivered.projeto_id, 42);
  assert.equal(delivered.entidade.id, mine.id);
});

test('AT4 — an unknown ?tipo is a 400, and nothing is upgraded to SSE', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes, T123_ARTIFACTS.server);
  const ctx = await startAuthorizedControlPlane(t);

  const response = await fetch(`${ctx.url}/v1/events/stream?tipo=nao_existe`);
  const body = (await response.json()) as { error: string; details?: string[] };

  assert.equal(response.status, 400);
  assert.equal(body.error, 'validation_failed');
  assert.ok(Array.isArray(body.details) && body.details.length > 0, 'the 400 says what is wrong');
  assert.ok(
    !(response.headers.get('content-type') ?? '').includes('text/event-stream'),
    'the connection must never become a stream before the filter is validated',
  );
});

test('AT5 — Last-Event-ID resumes without gaps and without repeating', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startAuthorizedControlPlane(t);
  const { url } = await startStreamApp(t, ctx, { pollIntervalMs: 20 });

  const first = await openStream(`${url}/v1/events/stream`);
  await createJob(ctx, { titulo: 'antes da queda', no_entrada_id: 'entrada' });
  await waitFor(() => first.messages.length >= 1, 'the first event to reach the stream');
  const cursor = first.messages[0].id;
  assert.ok(cursor !== null);
  first.abort();

  const second = await createJob(ctx, { titulo: 'durante a queda', no_entrada_id: 'entrada' });
  await moveJob(ctx, second.id, 'revisao');

  const resumed = await openStream(`${url}/v1/events/stream`, { 'last-event-id': cursor });
  t.after(() => resumed.abort());

  await waitFor(() => resumed.messages.length >= 2, 'the two missed events to be replayed');
  await settle();

  assert.deepEqual(
    resumed.messages.map((message) => message.event),
    ['trabalho.criado', 'trabalho.transicao'],
  );
  assert.ok(
    resumed.messages.every((message) => Number(message.id) > Number(cursor)),
    'an event already delivered must not come back',
  );
});

test('AT6 — without Last-Event-ID the stream never replays what is already in the log', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startAuthorizedControlPlane(t);
  const { url } = await startStreamApp(t, ctx, { pollIntervalMs: 20 });

  const old = await createJob(ctx, { titulo: 'já estava no log', no_entrada_id: 'entrada' });

  const stream = await openStream(`${url}/v1/events/stream`);
  t.after(() => stream.abort());

  const fresh = await createJob(ctx, { titulo: 'depois da conexão', no_entrada_id: 'entrada' });

  await waitFor(() => stream.messages.length >= 1, 'the new event to reach the stream');
  await settle();

  assert.equal(stream.messages.length, 1, 'history is not replayed by accident');
  const delivered = JSON.parse(stream.messages[0].data) as Event;
  assert.equal(delivered.entidade.id, fresh.id);
  assert.notEqual(delivered.entidade.id, old.id);
});

test('AT7 — an idle stream sends the keep-alive comment', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startAuthorizedControlPlane(t);
  const { url } = await startStreamApp(t, ctx, {
    pollIntervalMs: 20,
    heartbeatIntervalMs: 20,
  });

  const stream = await openStream(`${url}/v1/events/stream`);
  t.after(() => stream.abort());

  await waitFor(() => stream.comments.length >= 1, 'the keep-alive comment');

  assert.ok(
    stream.comments.some((comment) => comment === 'heartbeat'),
    `expected a ": heartbeat" comment, got ${JSON.stringify(stream.comments)}`,
  );
  assert.deepEqual(stream.messages, [], 'no real event was recorded in this test');
});

test('AT8 — a client that goes away leaves no timer and no error behind', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startAuthorizedControlPlane(t);
  const { url, app } = await startStreamApp(t, ctx, {
    pollIntervalMs: 20,
    heartbeatIntervalMs: 20,
  });

  const failures: unknown[] = [];
  const collect = (error: unknown): void => {
    failures.push(error);
  };
  process.on('uncaughtException', collect);
  t.after(() => process.off('uncaughtException', collect));

  const stream = await openStream(`${url}/v1/events/stream`);
  await createJob(ctx, { titulo: 'antes do abandono', no_entrada_id: 'entrada' });
  await waitFor(() => stream.messages.length >= 1, 'the first event to reach the stream');

  stream.abort();
  await settle();

  // The write path does not care that nobody is listening any more (FR6).
  const orphan = await createJob(ctx, { titulo: 'depois do abandono', no_entrada_id: 'entrada' });
  assert.ok(orphan.id > 0);
  await settle();

  // If the poll/heartbeat timers had leaked, this close would never resolve.
  const closed = await Promise.race([
    app.close().then(() => 'closed' as const),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
  ]);

  assert.equal(closed, 'closed', 'app.close() has to resolve once the client is gone');
  assert.deepEqual(failures, [], 'an abandoned stream must not blow up on the server');
});

test('t218 — a connection that never sent a request does not hold the shutdown', async (t) => {
  requireArtifacts(T123_ARTIFACTS.streamRoutes);
  const ctx = await startControlPlane(t);
  const { url, app } = await startStreamApp(t, ctx, {});

  // AT8 above only catches this on Node 22, because there it is the client's
  // own connection pool that leaves the socket behind (see the `preClose` hook
  // in `src/routes/events.ts`). The same handle held open by hand is red on
  // EVERY runtime, which is what turns "green on one matrix leg" into a
  // regression this suite can actually keep watching.
  const { port, hostname } = new URL(url);
  const mute = connect(Number(port), hostname);
  // The shutdown destroys this socket from the other side; the reset that
  // follows is the end of the test, not something to report.
  mute.on('error', () => {});
  t.after(() => mute.destroy());
  await new Promise<void>((resolve, reject) => {
    mute.once('connect', resolve);
    mute.once('error', reject);
  });
  // The handshake finished on this side; give the server the tick it needs to
  // have accepted it, so the red below is the leak and never a race.
  await settle(50);

  const closed = await Promise.race([
    app.close().then(() => 'closed' as const),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3000)),
  ]);

  assert.equal(closed, 'closed', 'a socket carrying no request must not hold app.close()');
});
