/**
 * Acceptance tests of the watcher's stream consumer (t247, AT5).
 *
 * The protocol under test is `docs/spec/events-stream.md` §2–§7, and the fake
 * on the other end is a REAL HTTP server rather than an injected `fetch`: what
 * this consumer has to get right — chunk boundaries that cut a message in half,
 * a socket that dies mid-body, the header a reconnection presents — only exists
 * over a socket. An injected `fetch` handing back a pre-built `Response` would
 * be testing the parser and calling it the protocol.
 *
 * The four claims, one per case of AT5:
 *
 * - (a) two events, a drop, and a resume from `Last-Event-ID`: each event comes
 *   out exactly once, in order, and the header the server saw on the second
 *   connection is the id of the last event the CONSUMER finished processing;
 * - (b) `: heartbeat` comment lines never become events (§6);
 * - (c) an event of another type is ignored rather than yielded (§4);
 * - (d) a `401` on connect throws at once, with no retry (§7: "neither of the
 *   two gets better with a retry").
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import type * as StreamModule from '../src/stream.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const STREAM_MODULE = 'src/stream.ts';

/** Backoff of these cases: real, so the retry path runs, but not a wait. */
const FAST_BACKOFF_MS = 10;

let cache: typeof StreamModule | null = null;

async function loadStream(): Promise<typeof StreamModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, STREAM_MODULE)),
    `artifact does not exist yet: packages/topografo/${STREAM_MODULE}`,
  );
  cache ??= (await import(
    new URL(`../${STREAM_MODULE}`, import.meta.url).href
  )) as typeof StreamModule;
  return cache;
}

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** One connection, as the fake server saw it. */
interface Connection {
  url: string;
  authorization: string | undefined;
  lastEventId: string | undefined;
}

/** A fake control plane that serves whatever the handler writes. */
interface FakeStream {
  url: string;
  connections: Connection[];
}

/**
 * Starts a server that answers `/v1/events/stream` with the handler's script.
 *
 * The handler receives the connection index, so a case can serve one thing on
 * the first connection and another on the reconnection.
 *
 * @param t Test context; the server is closed when the test ends.
 * @param handle What to write on connection number `n`, and whether to end it.
 * @returns The base URL and the log of connections received.
 */
async function fakeStream(
  t: TestHook,
  handle: (attempt: number, response: ServerResponse, request: IncomingMessage) => void,
): Promise<FakeStream> {
  const connections: Connection[] = [];
  const sockets = new Set<ServerResponse>();

  const server: Server = createServer((request, response) => {
    const header = request.headers['last-event-id'];
    connections.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
      lastEventId: Array.isArray(header) ? header[0] : header,
    });
    sockets.add(response);
    response.on('close', () => sockets.delete(response));
    handle(connections.length, response, request);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the fake server has no port');
  return { url: `http://127.0.0.1:${address.port}`, connections };
}

/** Writes the SSE preamble a real stream opens with (§2). */
function openStream(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  response.flushHeaders();
}

/** One SSE message, in the exact shape `routes/events.ts` writes it. */
function message(id: number, type: string, executionId: number): string {
  const envelope = {
    id,
    type,
    project_id: 1,
    execution_id: executionId,
    entity: { type: 'execution', id: executionId },
    actor: { type: 'system', ref: 'control-plane' },
    occurred_at: '2026-08-17T10:00:00.000Z',
    data: {},
  };
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * Takes `count` messages off the consumer and then lets it go.
 *
 * Reading with an explicit `break` and not a bare `for await` is deliberate:
 * the generator is infinite by design (a stream that ends is a reconnection,
 * never an end), so a test that did not stop reading would never return.
 */
async function take(
  events: AsyncIterable<StreamModule.StreamMessage>,
  count: number,
): Promise<StreamModule.StreamMessage[]> {
  const taken: StreamModule.StreamMessage[] = [];
  if (count === 0) return taken;
  for await (const event of events) {
    taken.push(event);
    if (taken.length === count) break;
  }
  return taken;
}

test('t247 AT5a — the consumer resumes from the last event it PROCESSED, once each and in order', async (t) => {
  const { watchFinishedExecutions } = await loadStream();

  const fake = await fakeStream(t, (attempt, response) => {
    openStream(response);
    if (attempt === 1) {
      // Two events, and then the socket dies under the consumer's feet.
      response.write(message(11, 'execution.finished', 501));
      response.write(message(12, 'execution.finished', 502));
      setTimeout(() => response.destroy(), 20);
      return;
    }
    // The resume: everything with `id >` the cursor presented, and nothing else.
    response.write(message(13, 'execution.finished', 503));
  });

  const events = watchFinishedExecutions({
    url: fake.url,
    token: 'operator-token',
    backoffMs: FAST_BACKOFF_MS,
  });

  const taken = await take(events, 3);

  assert.deepEqual(
    taken.map((event) => event.id),
    [11, 12, 13],
    'each event arrives exactly once, in stream order, across the drop',
  );
  assert.deepEqual(
    taken.map((event) => event.envelope.execution_id),
    [501, 502, 503],
    'the envelope travels whole: `execution_id` is what the watcher dispatches on',
  );

  assert.equal(fake.connections.length, 2, 'a drop is a reconnection, not an end');
  assert.equal(
    fake.connections[0].lastEventId,
    undefined,
    'the FIRST connection sends no cursor: the stream starts from now (§5)',
  );
  assert.equal(
    fake.connections[1].lastEventId,
    '12',
    'the reconnection resumes at the last event the consumer finished processing (§5)',
  );
  for (const connection of fake.connections) {
    assert.equal(
      connection.authorization,
      'Bearer operator-token',
      'every connection is a new request and carries the credential itself (§2)',
    );
    assert.ok(
      connection.url.includes('type=execution.finished'),
      `the consumer subscribes to the one type it acts on: ${connection.url}`,
    );
  }
});

test('t247 AT5b/AT5c — heartbeats and other types are ignored, never yielded', async (t) => {
  const { watchFinishedExecutions } = await loadStream();

  const fake = await fakeStream(t, (_attempt, response) => {
    openStream(response);
    // The keep-alive comment of §6, an event of another type (§4: "an unknown
    // type is to be ignored, not an error"), and only then the real thing.
    response.write(': heartbeat\n\n');
    response.write(message(20, 'job.transitioned', 601));
    response.write(': heartbeat\n\n');
    response.write(message(21, 'execution.finished', 602));
  });

  const events = watchFinishedExecutions({
    url: fake.url,
    token: 'operator-token',
    backoffMs: FAST_BACKOFF_MS,
  });

  const taken = await take(events, 1);

  assert.equal(taken.length, 1);
  assert.equal(taken[0].id, 21, 'the comment lines and the foreign type produced no event');
  assert.equal(taken[0].type, 'execution.finished');
  assert.equal(taken[0].envelope.execution_id, 602);
});

test('t247 AT5d — a 401 on connect throws at once, and never retries', async (t) => {
  const { watchFinishedExecutions, StreamDeniedError } = await loadStream();

  const fake = await fakeStream(t, (_attempt, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'missing_credential' }));
  });

  const events = watchFinishedExecutions({
    url: fake.url,
    token: '',
    backoffMs: FAST_BACKOFF_MS,
  });

  await assert.rejects(
    async () => await take(events, 1),
    (failure: unknown) => {
      assert.ok(
        failure instanceof StreamDeniedError,
        `a refused credential is denied, not degraded: ${String(failure)}`,
      );
      assert.equal(failure.status, 401);
      return true;
    },
  );

  // The whole point of the case: no second attempt was made. A credential that
  // does not resolve is configuration, and a retry loop over it is a process
  // that looks alive and is doing nothing (§7).
  assert.equal(fake.connections.length, 1, 'a 401 is fatal on the first connection');
});

test('t247 AT5d — a 400 is fatal too; a 502 is a drop and reconnects', async (t) => {
  const { watchFinishedExecutions, StreamDeniedError } = await loadStream();

  const refused = await fakeStream(t, (_attempt, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'validation_failed', details: ['bad filter'] }));
  });

  const denial = watchFinishedExecutions({
    url: refused.url,
    token: 'operator-token',
    backoffMs: FAST_BACKOFF_MS,
  });

  await assert.rejects(
    async () => await take(denial, 1),
    (failure: unknown) => failure instanceof StreamDeniedError && failure.status === 400,
  );
  assert.equal(refused.connections.length, 1, 'a wrong contract does not improve with a retry');

  // A gateway answering 502 is availability, not contract: it is the one the
  // reference consumer of §8 keeps retrying, and so does this one.
  const flaky = await fakeStream(t, (attempt, response) => {
    if (attempt === 1) {
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end('<html>bad gateway</html>');
      return;
    }
    openStream(response);
    response.write(message(30, 'execution.finished', 700));
  });

  const events = watchFinishedExecutions({
    url: flaky.url,
    token: 'operator-token',
    backoffMs: FAST_BACKOFF_MS,
  });

  const taken = await take(events, 1);
  assert.equal(taken[0].envelope.execution_id, 700);
  assert.equal(flaky.connections.length, 2, 'the 502 was retried, and the retry worked');
});
