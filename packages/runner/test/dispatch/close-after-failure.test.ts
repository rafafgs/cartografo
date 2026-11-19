/**
 * Acceptance tests for the compensating closure of a session (t1313, FR1–FR5).
 *
 * A dispatch that throws AFTER the engine ended used to leave the session row
 * `open` forever: the board read "an agent is working", and the control plane's
 * streak guard never saw a failure to count. `close-after-failure.ts` holds the
 * two pieces that fix it without growing `dispatch.ts`: the text that describes
 * the failure, and the one best-effort `PATCH /finish` that carries it.
 *
 * Same harness as `report.test.ts`: the function takes its `call` as a
 * parameter, so a fake that records what it was handed is the whole rig.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type * as CloseModule from '../../src/dispatch/close-after-failure.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/close-after-failure.ts';

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this directory uses: in the red phase the failure reads
 * as "the implementation is missing", never as a module resolution stack trace.
 */
async function loadClose(): Promise<typeof CloseModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(
    new URL('../../src/dispatch/close-after-failure.ts', import.meta.url).href
  )) as typeof CloseModule;
}

/** One call the fake client was handed. */
interface Sent {
  route: string;
  method: string;
  body: unknown;
}

/** A fake `call` that records every request, and rejects with `refusal` when given one. */
function recorder(refusal?: unknown): { sent: Sent[]; call: ControlPlaneCall } {
  const sent: Sent[] = [];
  const call = <T>(route: string, method: string, body?: unknown): Promise<T> => {
    sent.push({ route, method, body });
    return refusal === undefined ? Promise.resolve(undefined as T) : Promise.reject(refusal);
  };
  return { sent, call: call as ControlPlaneCall };
}

test('t1313 AT1 — describeFailure names the error, keeps it short and never answers empty', async () => {
  const { describeFailure } = await loadClose();

  assert.equal(describeFailure(new Error('boom')), 'boom', 'a plain Error is its message alone');
  assert.equal(describeFailure(new TypeError('x')), 'TypeError: x', 'any other name prefixes it');
  assert.equal(describeFailure('a string was thrown'), 'a string was thrown');
  assert.equal(describeFailure(new Error('')), 'Error', 'an empty message falls back to the name');
  assert.equal(describeFailure(new RangeError('')), 'RangeError');

  const named = new Error('the upload broke');
  named.name = 'UploadError';
  assert.equal(describeFailure(named), 'UploadError: the upload broke');

  const long = describeFailure(new Error('y'.repeat(5000)));
  assert.ok(long.length <= 2000, `cut to at most 2000 characters, got ${String(long.length)}`);
  assert.ok(long.endsWith('…'), 'a cut text says it was cut');
  assert.ok(long.startsWith('yyyy'), 'the cut keeps the beginning');

  const exact = 'z'.repeat(2000);
  assert.equal(describeFailure(new Error(exact)), exact, 'exactly 2000 characters is not cut');

  const nameless = new Error('');
  nameless.name = '';
  for (const value of [nameless, '', undefined, null]) {
    const text = describeFailure(value);
    assert.ok(text.length > 0, `never empty, for ${String(value)}`);
  }
  assert.equal(describeFailure(nameless), 'unknown error');
  assert.equal(describeFailure(''), 'unknown error');
});

test('t1313 AT2 — closeAfterFailure sends one failed /finish with the error and no output', async () => {
  const { closeAfterFailure } = await loadClose();
  const { sent, call } = recorder();

  await closeAfterFailure(
    call,
    { sessionId: 25, exitCode: 0, lines: ['first line', 'second line'] },
    new TypeError('fetch failed'),
  );

  assert.equal(sent.length, 1, 'exactly one request');
  assert.equal(sent[0].route, '/v1/sessions/25/finish');
  assert.equal(sent[0].method, 'PATCH');
  const body = sent[0].body as Record<string, unknown>;
  assert.equal(body.status, 'failed');
  assert.equal(body.exit_code, 0, 'the exit code the engine reported is kept');
  assert.equal(body.timeout_reason, null);
  assert.equal(body.transcript, 'first line\nsecond line', 'the raw lines collected so far');
  assert.equal(body.error, 'TypeError: fetch failed');
  assert.ok(!('output' in body), 'the compensating closure never carries an output');

  const nullExit = recorder();
  await closeAfterFailure(nullExit.call, { sessionId: 3, exitCode: null, lines: [] }, 'x');
  assert.equal((nullExit.sent[0].body as Record<string, unknown>).exit_code, null);
  assert.equal((nullExit.sent[0].body as Record<string, unknown>).transcript, '');
});

test('t1313 AT2 — closeAfterFailure swallows its own failure, a 409 included', async () => {
  const { closeAfterFailure } = await loadClose();

  const conflict = Object.assign(new Error('PATCH /v1/sessions/25/finish answered 409'), {
    name: 'ControlPlaneClientError',
    status: 409,
    body: { error: 'conflict' },
  });
  for (const refusal of [conflict, new TypeError('fetch failed'), 'a bare string']) {
    const { sent, call } = recorder(refusal);
    await assert.doesNotReject(
      closeAfterFailure(call, { sessionId: 25, exitCode: 1, lines: ['x'] }, new Error('original')),
      `a rejection of ${String(refusal)} stays inside the closure`,
    );
    assert.equal(sent.length, 1, 'attempted once, never retried');
  }
});
