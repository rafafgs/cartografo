/**
 * Acceptance tests of the synthesizer's credential (t148, AT4/AT5).
 *
 * Two claims, and they are the whole contract: a reader built with a token
 * presents it on every one of the three reads, and a reader built without one
 * presents nothing at all.
 *
 * The second half is not a formality. Since t124 there is no open mode, so the
 * absence of a header means a 401 — and the alternative, sending `Authorization:
 * Bearer ` with nothing after it, would read as a credential in the server's log
 * instead of as the absence of one. `controller/cliente-controle.ts` documents
 * exactly that rule, and this reader now follows it.
 *
 * `fetch` is captured rather than served: what is under test is which headers go
 * out, and a live socket would prove the routes of t101/t117 instead. The real
 * gate, against a real control plane, is `synthesize.e2e.test.ts`.
 *
 * English per D18; the payload keys (`classes`, `graph_version`, `skills`) are
 * the API's own wire format, which D20 took to English as well — t226 translated
 * them here (`docs/spec/glossario-wire.md`).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ClientModule from '../../src/synthesizer/control-plane-client.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/synthesizer/control-plane-client.ts';

const BASE_URL = 'http://127.0.0.1:4317';
const TOKEN = 'ct_um_token_de_operador';
const VERSION_ID = 'sha256:aaa';

/**
 * The one class the fake registry knows, and the version behind it.
 *
 * Typed against the module rather than written as loose object literals: with
 * the type on them, a field the reader renames stops the typecheck here instead
 * of quietly turning into an `undefined` at runtime. The envelope KEYS around
 * them are not typed anywhere — `getJson` names them inline — so those are
 * pinned by the assertions of the t233 test below.
 */
const REGISTERED_CLASS: ClientModule.ClassEntry = {
  class: 'nota-curta',
  current_version_id: VERSION_ID,
};

const REGISTERED_VERSION: ClientModule.GraphVersion = {
  id: VERSION_ID,
  graph_id: 'nota-curta',
  snapshot: { metadata: {} },
};

let cache: typeof ClientModule | null = null;

async function loadClient(): Promise<typeof ClientModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/synthesizer/control-plane-client.ts', import.meta.url).href
  )) as typeof ClientModule;
  return cache;
}

/** One request the reader made, reduced to what this suite asserts about. */
interface CapturedRequest {
  url: string;
  headers: Headers;
}

/**
 * A `fetch` that answers every route at once and remembers what it was asked.
 *
 * One body for the three routes on purpose: the reader picks its own key out of
 * it, and a per-route fake would be a second place to keep the shapes in sync.
 */
function recorder(captured: CapturedRequest[]): typeof fetch {
  const body = JSON.stringify({
    classes: [REGISTERED_CLASS],
    graph_version: REGISTERED_VERSION,
    skills: [],
  });

  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, headers: new Headers(init?.headers) });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** Drives all three reads of a reader and gives back what went out. */
async function readEverything(reader: ClientModule.ControlPlaneReader, captured: CapturedRequest[]) {
  await reader.fetchClasses();
  await reader.fetchClassVersion(VERSION_ID);
  await reader.fetchSkills();
  return captured;
}

test('AT4 — a reader built with a token presents it on all three reads', async () => {
  const { createControlPlaneReader } = await loadClient();

  const captured: CapturedRequest[] = [];
  const reader = createControlPlaneReader(BASE_URL, {
    token: TOKEN,
    fetchImpl: recorder(captured),
  });

  await readEverything(reader, captured);

  assert.deepEqual(
    captured.map((request) => request.url),
    [
      `${BASE_URL}/v1/classes`,
      `${BASE_URL}/v1/graph-versions/${encodeURIComponent(VERSION_ID)}`,
      `${BASE_URL}/v1/skills`,
    ],
    'the three reads the synthesizer consults, in the order it consults them',
  );

  for (const request of captured) {
    assert.equal(
      request.headers.get('authorization'),
      `Bearer ${TOKEN}`,
      `${request.url} went out without the credential`,
    );
  }
});

test('AT5 — a reader built with no token sends no Authorization at all', async () => {
  const { createControlPlaneReader } = await loadClient();

  const captured: CapturedRequest[] = [];
  const reader = createControlPlaneReader(BASE_URL, { fetchImpl: recorder(captured) });

  await readEverything(reader, captured);

  assert.equal(captured.length, 3);
  for (const request of captured) {
    assert.ok(
      !request.headers.has('authorization'),
      `${request.url} invented a header: an empty credential reads as a credential`,
    );
  }
});

test('t193 — a control plane that never answers is a rejection on the deadline, not a hang', async () => {
  const { createControlPlaneReader } = await loadClient();

  // Not a control plane that is down — that one answers, and the reads above
  // already say what happens then. This is one that accepted the connection and
  // then said nothing, against which a read with no deadline never comes back
  // and the command that made it cannot even be interrupted cleanly.
  const reader = createControlPlaneReader(BASE_URL, {
    fetchImpl: () => new Promise<Response>(() => undefined),
    requestTimeoutMs: 150,
  });

  const started = Date.now();
  let guard: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    reader.fetchClasses().then(
      () => ({ settled: 'resolved' as const, error: null as unknown }),
      (error: unknown) => ({ settled: 'rejected' as const, error }),
    ),
    new Promise<{ settled: 'hung'; error: unknown }>((resolve) => {
      guard = setTimeout(() => resolve({ settled: 'hung', error: null }), 5_000);
    }),
  ]);
  clearTimeout(guard);

  assert.equal(
    outcome.settled,
    'rejected',
    `the read has to give up on its own (it ${outcome.settled} after ${Date.now() - started}ms)`,
  );
  assert.ok(
    outcome.error instanceof Error && outcome.error.name === 'TimeoutError',
    `the rejection has to be recognizable as a timeout, got: ${String(outcome.error)}`,
  );
});

test('t233 — each read gives back what its envelope carried, not `undefined`', async () => {
  const { createControlPlaneReader } = await loadClient();

  // The two tests above drive all three reads and look only at what went OUT,
  // so they stay green against a fake whose envelope keys no longer match the
  // control plane's: a key the reader cannot find yields `undefined`, and
  // `undefined` is silent. This is the assertion that makes the fake's shape
  // load-bearing — `deepEqual(undefined, [])` is a failure, which is exactly
  // the alarm the translation of t226 needed and did not have.
  const reader = createControlPlaneReader(BASE_URL, { fetchImpl: recorder([]) });

  assert.deepEqual(await reader.fetchClasses(), [REGISTERED_CLASS], 'the `classes` envelope');
  assert.deepEqual(
    await reader.fetchClassVersion(VERSION_ID),
    REGISTERED_VERSION,
    'the `graph_version` envelope, English since t226',
  );
  assert.deepEqual(await reader.fetchSkills(), [], 'the `skills` envelope');
});

test('AT4 — the three exported reads keep their `(baseUrl, fetchImpl)` signature', async () => {
  const { fetchClasses, fetchClassVersion, fetchSkills } = await loadClient();

  const captured: CapturedRequest[] = [];
  const fetchImpl = recorder(captured);

  // The credential is wrapped around `fetch` INSIDE the reader, so these three
  // stay exactly as t115 wrote them — no `token` parameter threaded through
  // three functions and their shared `getJson`. They are unauthenticated by
  // construction, which is why nothing but the reader should call them.
  await fetchClasses(BASE_URL, fetchImpl);
  await fetchClassVersion(BASE_URL, VERSION_ID, fetchImpl);
  await fetchSkills(BASE_URL, fetchImpl);

  assert.equal(captured.length, 3);
  for (const request of captured) assert.ok(!request.headers.has('authorization'));
});
