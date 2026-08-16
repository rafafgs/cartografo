/**
 * Acceptance tests of the one HTTP mechanic every runner-initiated call uses
 * (t193, FR1).
 *
 * Two claims, and they are the whole of what this module exists for. The first
 * is t156's discipline pinned at its SOURCE instead of once per client: the
 * status is read before the body is decoded, so a proxy answering 502 with an
 * HTML page becomes the caller's own error carrying that page, never a raw
 * `SyntaxError` that lost both the status and the text. The second is the one
 * this ficha adds: a control plane that accepts the connection and then says
 * nothing has to become a rejection on a deadline — a request with no deadline
 * is a runner that hangs on its tick, its shutdown, or both.
 *
 * `fetchImpl` is injected in both, and in the second one it never resolves:
 * that is the only honest way to describe a server that is there and silent,
 * and it is why the deadline may not be delegated to whatever `fetch` happens
 * to do with the signal.
 *
 * English per D18 — this module is new code.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type * as HttpModule from '../../src/controller/http-client.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/controller/http-client.ts';

const URL_UNDER_TEST = 'http://127.0.0.1:4317/v1/jobs';

/** What a broken intermediary answers, and what `JSON.parse` refuses. */
const HTML_502 = '<html>502 Bad Gateway</html>';

/**
 * Deadline of the timeout cases: what "not never" means here.
 *
 * Far above the timeouts the cases themselves configure, so that a failure
 * reads as "the module has no deadline" and never as "the machine was busy".
 */
const NEVER_MS = 5_000;

let cache: typeof HttpModule | null = null;

async function loadHttpClient(): Promise<typeof HttpModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/controller/http-client.ts', import.meta.url).href
  )) as typeof HttpModule;
  return cache;
}

/** The error a caller of this module builds for itself, out of `{status, body}`. */
class CallerError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(failure: { status: number; body: string }) {
    super(`answered ${failure.status}`);
    this.name = 'CallerError';
    this.status = failure.status;
    this.body = failure.body;
  }
}

test('t193 AT1 — a non-ok body that is not JSON becomes the caller\'s error, never a SyntaxError', async () => {
  const { requestJson } = await loadHttpClient();

  const fetchImpl: typeof fetch = async () =>
    new Response(HTML_502, { status: 502, headers: { 'content-type': 'text/html' } });

  await assert.rejects(
    async () =>
      requestJson({
        url: URL_UNDER_TEST,
        fetchImpl,
        buildError: (failure) => new CallerError(failure),
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof CallerError,
        `expected the caller's own error, got ${error instanceof Error ? error.name : String(error)}`,
      );
      assert.equal(error.status, 502);
      assert.equal(
        error.body,
        HTML_502,
        'the raw text is what is left for whoever logs it: the answer did not come from the control plane',
      );
      return true;
    },
  );
});

test('t193 AT1 — an empty error body is still the caller\'s error, and the success path still decodes', async () => {
  const { requestJson, decodeErrorBody } = await loadHttpClient();

  // The non-regression half of the same rule: an empty body is not a second
  // failure, and `undefined` is what it decodes to — the shape both clients
  // have promised since t156.
  assert.equal(decodeErrorBody(''), undefined);
  assert.deepEqual(decodeErrorBody('{"erro":"nao_encontrado"}'), { erro: 'nao_encontrado' });
  assert.equal(decodeErrorBody(HTML_502), HTML_502);

  await assert.rejects(
    async () =>
      requestJson({
        url: URL_UNDER_TEST,
        fetchImpl: async () => new Response('', { status: 500 }),
        buildError: (failure) => new CallerError(failure),
      }),
    (error: unknown) => {
      assert.ok(error instanceof CallerError);
      assert.equal(error.status, 500);
      assert.equal(error.body, '');
      return true;
    },
  );

  const decoded = await requestJson<{ trabalhos: number[] }>({
    url: URL_UNDER_TEST,
    fetchImpl: async () =>
      new Response(JSON.stringify({ trabalhos: [1, 2] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    buildError: (failure) => new CallerError(failure),
  });
  assert.deepEqual(decoded, { trabalhos: [1, 2] });

  const empty = await requestJson<undefined>({
    url: URL_UNDER_TEST,
    fetchImpl: async () => new Response('', { status: 200 }),
    buildError: (failure) => new CallerError(failure),
  });
  assert.equal(empty, undefined, 'a 2xx with no body is `undefined`, never an exception');
});

test('t193 AT2 — a fetch that never resolves rejects on the deadline: not before, not never', async () => {
  const { requestJson, DEFAULT_REQUEST_TIMEOUT_MS } = await loadHttpClient();

  assert.equal(
    DEFAULT_REQUEST_TIMEOUT_MS,
    30_000,
    'the default deadline is named, so that every client can be read against one number',
  );

  const timeoutMs = 150;
  const started = Date.now();

  const pending = requestJson({
    url: URL_UNDER_TEST,
    timeoutMs,
    // A server that accepted the connection and never answered. It ignores the
    // signal on purpose: whether the request gives up may not depend on the
    // goodwill of whatever `fetch` was injected.
    fetchImpl: () => new Promise<Response>(() => undefined),
    buildError: (failure) => new CallerError(failure),
  });

  // The guard is aborted on the way out, so that a case which settled in 150ms
  // does not keep the suite's event loop alive for the whole deadline.
  const guard = new AbortController();
  const outcome = await Promise.race([
    pending.then(
      () => ({ settled: 'resolved' as const, error: null as unknown }),
      (error: unknown) => ({ settled: 'rejected' as const, error }),
    ),
    delay(NEVER_MS, undefined, { signal: guard.signal }).then(
      () => ({ settled: 'hung' as const, error: null as unknown }),
      () => ({ settled: 'hung' as const, error: null as unknown }),
    ),
  ]);
  guard.abort();
  const elapsed = Date.now() - started;

  assert.equal(
    outcome.settled,
    'rejected',
    `a request with no deadline hangs the tick that made it (it ${outcome.settled} after ${elapsed}ms)`,
  );
  assert.ok(
    outcome.error instanceof Error && outcome.error.name === 'TimeoutError',
    `the rejection has to be recognizable as a timeout, got: ${String(outcome.error)}`,
  );

  // Not before, either: a deadline that fires early would turn a slow control
  // plane into a broken one. The 20ms of slack is timer granularity, not
  // tolerance for a wrong number.
  assert.ok(
    elapsed >= timeoutMs - 20,
    `it gave up after ${elapsed}ms, before the ${timeoutMs}ms it was given`,
  );
});
