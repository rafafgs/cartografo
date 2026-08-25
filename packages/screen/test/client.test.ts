/**
 * Unit test of the screen's HTTP client (t156).
 *
 * A fake `fetch` and nothing else, in the same shape
 * `packages/runner/test/controller/cliente-controle.test.ts` uses: what is
 * pinned here is how the client DECODES an answer, and not what the control
 * plane answers — the end-to-end tests of this package already run a real one
 * as a child process, and none of them can produce the answer below.
 *
 * The bug this file was written for: a broken intermediary — a reverse proxy
 * replying 502 with an HTML page — made the decoding blow up inside
 * `JSON.parse`, so whoever called saw a raw `SyntaxError` instead of the
 * client's own typed failure. Neither the status nor the raw answer survived,
 * and the screen turns a status into a page.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient, ApiError, NetworkError } from '../src/client.ts';

const BASE_URL = 'http://127.0.0.1:4317';
const BAD_GATEWAY_HTML = '<html>502 Bad Gateway</html>';

/** A `fetch` that hands back the same canned answer, built by the test. */
function fetchAnswering(make: () => Response): typeof fetch {
  return async () => make();
}

test('t156 — a non-JSON error body becomes ApiError with the raw text, not a SyntaxError', async () => {
  const client = new ApiClient({
    baseUrl: BASE_URL,
    doFetch: fetchAnswering(
      () =>
        new Response(BAD_GATEWAY_HTML, {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    ),
  });

  await assert.rejects(
    () => client.listJobs(),
    (failure: unknown) => {
      assert.ok(
        failure instanceof ApiError,
        `expected ApiError, got ${failure instanceof Error ? failure.name : String(failure)}`,
      );
      assert.ok(
        !(failure instanceof NetworkError),
        'an answer that arrived and could not be decoded is not a failure to REACH the control plane',
      );
      assert.equal(failure.status, 502);
      assert.equal(
        failure.body,
        BAD_GATEWAY_HTML,
        'the raw page is what is left to log: whoever answered was not the control plane',
      );
      return true;
    },
  );
});

/**
 * Non-regression pin, not a repro: the empty-body case ALREADY works today
 * (`text === '' ? undefined : JSON.parse(text)`), and what this test holds is
 * that t156's rewrite does not turn it into `''` or into a thrown failure.
 */
test('t156 (non-regression) — an empty error body still arrives as undefined', async () => {
  const client = new ApiClient({
    baseUrl: BASE_URL,
    doFetch: fetchAnswering(() => new Response('', { status: 500 })),
  });

  await assert.rejects(
    () => client.listJobs(),
    (failure: unknown) => {
      assert.ok(failure instanceof ApiError);
      assert.equal(failure.status, 500);
      assert.equal(failure.body, undefined);
      return true;
    },
  );
});

/**
 * The other half of the same boundary: a host that does not answer at all is
 * still a `NetworkError`, and never an `ApiError`. The two failures lead to
 * different pages, so the fix for the one above may not blur the other.
 */
test('t156 (non-regression) — a fetch that throws is still NetworkError, never ApiError', async () => {
  const client = new ApiClient({
    baseUrl: BASE_URL,
    doFetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  await assert.rejects(
    () => client.listJobs(),
    (failure: unknown) => {
      assert.ok(failure instanceof NetworkError);
      assert.ok(!(failure instanceof ApiError));
      return true;
    },
  );
});
