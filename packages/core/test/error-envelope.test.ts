/**
 * Acceptance tests of the control plane's last line of defence (t197).
 *
 * Everything a route MEANS to refuse already has its own envelope
 * (`routes/common.ts`: `refusal`/`notFound`/`conflict`/`withValidation`). What
 * had no owner until this ticket is the failure nobody planned — the throw that
 * escapes a handler — and Fastify's default for it is
 * `{statusCode, error, message}` with the thrown `message` inside. That is not
 * hypothetical here: `POST /v1/leases/:id/{heartbeats,releases}` check
 * `lease.status !== 'ativa'` and then call the repository with no `try/catch`,
 * so a lease that flips state in that window answers a 500 whose body quotes
 * `repositories/leases.ts`'s own sentence back at the client.
 *
 * So the two handlers pinned below are a SAFETY NET and not a router: the
 * global error handler never sees a reply a route already sent (AT4), and the
 * not-found handler exists only so that an address nobody registered answers in
 * the same `{error, message}` shape as everything else.
 *
 * The one thing the generic body carries beyond the two fixed strings is
 * `request_id`, and it is what makes the pair usable: the response says nothing
 * about what broke, so the operator needs SOME way to reach the log line that
 * does. Fastify binds the same id on the request-scoped logger as `reqId`
 * (AT2), which is the join.
 *
 * The harness here is deliberately local instead of `support.ts`'s
 * `startControlPlane`: two of these tests need something that helper does not
 * offer — one closes the database handle out from under a running app, the
 * other has to read what the app LOGGED, which means handing `createApp` a pino
 * destination of the test's own.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import { applyPragmas, openDatabase, type Database } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { issueCredential } from '../src/repositories/credentials.ts';
import { createApp } from '../src/server.ts';
import { MIGRATIONS_DIR, requireArtifacts, type TestHook } from './support.ts';

/** Artifacts this ticket touches; the initial red names them instead of blowing up. */
const ARTIFACTS = ['src/server.ts', 'src/index.ts'];

/** The generic body of an unexpected failure, minus the per-request id. */
const INTERNAL_ERROR = Object.freeze({
  error: 'internal_error',
  message: 'an unexpected error occurred',
});

/** The body of an address nobody registered. */
const NOT_FOUND_ROUTE = Object.freeze({ error: 'not_found', message: 'route not found' });

/** One line as pino writes it, in the slice these tests read. */
interface LogLine {
  msg?: string;
  reqId?: string;
  err?: { message?: string; stack?: string };
}

/** Control plane running, with what these tests need to break it and to read it. */
interface Harness {
  app: FastifyInstance;
  db: Database;
  url: string;
  token: string;
  /** Every line the app logged so far, when the test asked for a capture. */
  lines: () => LogLine[];
}

/**
 * A pino destination that keeps every line instead of writing it anywhere.
 *
 * pino hands whole lines, but it may hand more than one in a single `write`,
 * so the split is not decoration.
 */
function captureStream(): { stream: { write: (line: string) => void }; lines: () => LogLine[] } {
  const captured: LogLine[] = [];
  return {
    stream: {
      write: (line: string): void => {
        for (const piece of line.split('\n')) {
          if (piece.trim() === '') continue;
          captured.push(JSON.parse(piece) as LogLine);
        }
      },
    },
    lines: () => captured,
  };
}

/**
 * Brings the whole app up against a throwaway database.
 *
 * @param t Test context, used to register the shutdown.
 * @param options Whether to capture the log, and extra routes to declare.
 * @returns The running app, its database handle, url, credential and log.
 */
async function startApp(
  t: TestHook,
  options: { capture?: boolean; routes?: (app: FastifyInstance) => void } = {},
): Promise<Harness> {
  requireArtifacts(...ARTIFACTS);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t197-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const { token } = issueCredential(db, { tipo: 'user' });

  const capture = options.capture === true ? captureStream() : null;
  const app = createApp({
    db,
    ...(capture === null ? {} : { logger: { level: 'error', stream: capture.stream } }),
  });
  options.routes?.(app);

  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    // A test below closes it on purpose; better-sqlite3 tolerates the second
    // call, and the `try` is what keeps the cleanup from deciding the verdict.
    try {
      db.close();
    } catch {
      /* already closed by the test itself */
    }
    rmSync(base, { recursive: true, force: true });
  });

  return { app, db, url, token, lines: () => capture?.lines() ?? [] };
}

test('t197 AT1 — an unexpected throw answers 500 with the fixed envelope, and leaks nothing', async (t) => {
  const harness = await startApp(t);

  // The cheapest genuine failure the tree offers, and the one the ticket names:
  // the handle the whole app reads through stops being open. Everything below
  // this line throws the kind of error nothing catches — which is precisely the
  // case that had no owner before this handler.
  harness.db.close();

  const response = await fetch(`${harness.url}/v1/jobs/1`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  assert.equal(response.status, 500, 'an unhandled failure is a 500, not a crash and not a 200');

  const text = await response.text();
  const body = JSON.parse(text) as Record<string, unknown>;

  assert.equal(typeof body.request_id, 'string', 'the generic body has to carry a request id');
  assert.ok((body.request_id as string).length > 0, 'the request id cannot be empty');
  assert.deepEqual(
    { ...body, request_id: '<id>' },
    { ...INTERNAL_ERROR, request_id: '<id>' },
    'the body is exactly the fixed envelope plus the request id — no fourth field',
  );

  // Said again from the other side, over the RAW text: the deep equality above
  // already forbids a fourth field, and this forbids the internals sneaking
  // into one of the three.
  for (const leak of ['sqlite', 'database', 'stack', '.ts:']) {
    assert.ok(
      !text.toLowerCase().includes(leak),
      `the response leaks internals ("${leak}"): ${text}`,
    );
  }
});

test('t197 AT2 — the app logs the real error, with the reqId the response hands back', async (t) => {
  // A sentinel instead of the database trick of AT1: what this test asserts is
  // that the ORIGINAL text reaches the log, and a message the test wrote itself
  // is the only one that cannot accidentally match something else.
  const sentinel = 'sentinel-failure-97c1b3-never-on-the-wire';

  const harness = await startApp(t, {
    capture: true,
    routes: (app) => {
      // Declared on the root instance on purpose: this is about the error
      // handler, not about the credential gate the `/v1` scope installs.
      app.get('/boom', async () => {
        throw new Error(sentinel);
      });
    },
  });

  const response = await fetch(`${harness.url}/boom`);
  assert.equal(response.status, 500);

  const text = await response.text();
  assert.ok(!text.includes(sentinel), `the thrown message reached the client: ${text}`);

  const body = JSON.parse(text) as { request_id?: string };
  assert.equal(typeof body.request_id, 'string');

  const logged = harness.lines().filter((line) => line.msg === 'unhandled error');
  assert.equal(logged.length, 1, `expected one "unhandled error" line, got ${logged.length}`);
  assert.ok(
    (logged[0]?.err?.message ?? '').includes(sentinel),
    `the log line does not carry the original error: ${JSON.stringify(logged[0])}`,
  );
  assert.equal(
    logged[0]?.reqId,
    body.request_id,
    'the id in the body is the one on the log line, or the pair joins nothing',
  );
});

test('t197 AT3 — an address nobody registered answers the same envelope, not Fastify\'s', async (t) => {
  const harness = await startApp(t);

  for (const route of ['/v1/this-route-does-not-exist', '/this-route-does-not-exist']) {
    const response = await fetch(`${harness.url}${route}`, {
      headers: { authorization: `Bearer ${harness.token}` },
    });
    assert.equal(response.status, 404, `${route} has to be a 404`);
    assert.deepEqual(
      await response.json(),
      NOT_FOUND_ROUTE,
      `${route} answers the router's default body instead of the house envelope`,
    );
  }
});

/**
 * t256 — the two client mistakes that used to answer in Fastify's own words.
 *
 * The handler above hands any error carrying a `statusCode` straight back, and
 * for a genuine Fastify-internal failure (a payload over the limit) that is
 * still right. But a body that is not JSON and a body that is JSON but not an
 * object are ORDINARY client mistakes, and both arrived here with
 * `statusCode: 400` — so the API answered `{statusCode, error: 'Bad Request',
 * message}`, an envelope with a different shape and a `error` that is an English
 * phrase where every other refusal on `/v1` carries a snake_case code.
 */
const MALFORMED_BODIES: Array<{ name: string; body: string; code: string }> = [
  { name: 'not JSON at all', body: '{not valid json', code: 'invalid_json' },
  { name: 'JSON, but not an object', body: JSON.stringify([1, 2, 3]), code: 'invalid_body' },
];

test('t256 — an unusable body answers the house envelope, not Fastify\'s', async (t) => {
  const harness = await startApp(t);

  for (const scenario of MALFORMED_BODIES) {
    // `POST /v1/graphs`: authenticated, and its body schema is the
    // `OPEN_OBJECT_SCHEMA` that turns a non-object into an FST_ERR_VALIDATION.
    const response = await fetch(`${harness.url}/v1/graphs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness.token}`,
        'content-type': 'application/json',
      },
      body: scenario.body,
    });
    assert.equal(response.status, 400, `${scenario.name} has to be a 400`);

    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    assert.equal(typeof body.message, 'string', `${scenario.name}: the message describes the shape`);
    assert.ok((body.message as string).length > 0, `${scenario.name}: an empty message says nothing`);
    assert.deepEqual(
      { ...body, message: '<message>' },
      { error: scenario.code, message: '<message>' },
      `${scenario.name}: the body is the two-key envelope and nothing else`,
    );
    assert.ok(
      !text.includes('Bad Request'),
      `${scenario.name} answers the router's own phrase: ${text}`,
    );
  }
});

test('t197 AT4 — a refusal a route already sent is untouched by the global handler', async (t) => {
  const harness = await startApp(t);

  // `notFound()`'s own body (`routes/common.ts`), with `details` and no
  // `message`: the global handler only ever sees what NOBODY answered, so a
  // typed refusal has to come out exactly as its route wrote it.
  const missing = await fetch(`${harness.url}/v1/jobs/999999`, {
    headers: { authorization: `Bearer ${harness.token}` },
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not_found', details: ['job does not exist'] });

  // And the gate's 401, which is sent from an `onRequest` hook — the other
  // place a global handler could plausibly have swallowed.
  const anonymous = await fetch(`${harness.url}/v1/jobs`);
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { error?: string }).error, 'missing_credential');
});
