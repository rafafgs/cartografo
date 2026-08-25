/**
 * Acceptance test of the controller's HTTP client (t103, FR10/AT13).
 *
 * The runner is a client of the API and nothing else (D1): everything it knows
 * about the state of the world arrives over HTTP. This test pins the outgoing
 * contract of every method — method, path and body — against an injected fake
 * `fetch`, in the same pattern `packages/screen/src/client.ts` uses.
 *
 * `GET /v1/jobs` is t102's route, merged long ago; the client consumes only the
 * subset of it that it needs (`id`, `blocked`), and the `blocked` filter lives
 * on the client side. The route is still faked here because what this test
 * charges for is the client, not t102's server.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type * as ClientModule from '../../src/controller/control-plane-client.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_URL = 'http://127.0.0.1:4317';

/** One request, as the fake `fetch` saw it. */
interface HttpCall {
  url: string;
  method: string;
  body: unknown;
}

let clientCache: typeof ClientModule | null = null;

async function loadClient(): Promise<typeof ClientModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'controller', 'control-plane-client.ts')),
    'artifact does not exist yet: packages/runner/src/controller/control-plane-client.ts',
  );
  clientCache ??= (await import(
    new URL('../../src/controller/control-plane-client.ts', import.meta.url).href
  )) as typeof ClientModule;
  return clientCache;
}

/**
 * Fake `fetch` that records what it received and answers what it is told to.
 *
 * @param respond Decides the answer from the recorded call.
 * @returns The pair `{fetchImpl, calls}`.
 */
function fakeFetch(respond: (call: HttpCall) => { status: number; body: unknown }): {
  fetchImpl: typeof fetch;
  calls: HttpCall[];
} {
  const calls: HttpCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const rawBody = init?.body;
    const call: HttpCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined,
    };
    calls.push(call);

    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const LEASE = {
  id: 12,
  runner_id: 'runner-a',
  job_id: 55,
  project_id: 3,
  status: 'active',
  ttl_seconds: 30,
  granted_at: '2026-08-14T12:00:00.000Z',
  heartbeat_at: '2026-08-14T12:00:00.000Z',
  expires_at: '2026-08-14T12:00:30.000Z',
  released_at: null,
  expiration_reason: null,
};

test('AT13 — every method of the client builds the right verb, path and body', async () => {
  const { ControlPlaneClient } = await loadClient();

  const { fetchImpl, calls } = fakeFetch((call) => {
    if (call.url.endsWith('/v1/runners')) {
      return {
        status: 201,
        body: { runner: { id: 'runner-a', name: 'laptop', registered_at: '2026-08-14T12:00:00.000Z' } },
      };
    }
    if (call.url.endsWith('/v1/jobs')) {
      return {
        status: 200,
        body: {
          jobs: [
            {
              id: 1,
              title: 'released',
              current_node_id: 'implementar',
              blocked: false,
              completed: false,
              execution_id: 9,
              graph_version_id: 'sha256:abc',
            },
            {
              id: 2,
              title: 'blocked',
              current_node_id: 'revisar',
              blocked: true,
              completed: false,
              execution_id: 9,
              graph_version_id: 'sha256:abc',
            },
            {
              id: 3,
              title: 'also released',
              current_node_id: 'implementar',
              blocked: false,
              completed: false,
              execution_id: 9,
              graph_version_id: 'sha256:abc',
            },
          ],
        },
      };
    }
    if (call.url.endsWith('/v1/leases')) return { status: 201, body: { lease: LEASE } };
    if (call.url.endsWith('/heartbeats')) {
      return { status: 200, body: { lease: { ...LEASE, ttl_seconds: 45 } } };
    }
    if (call.url.endsWith('/releases')) {
      return { status: 200, body: { lease: { ...LEASE, status: 'released' } } };
    }
    throw new Error(`unexpected call: ${call.method} ${call.url}`);
  });

  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });

  const runner = await client.registerRunner('runner-a', 'laptop');
  assert.equal(runner.id, 'runner-a');
  assert.deepEqual(calls[0], {
    url: `${BASE_URL}/v1/runners`,
    method: 'POST',
    body: { id: 'runner-a', name: 'laptop' },
  });

  const releasedJobs = await client.listReleasedJobs();
  assert.deepEqual(calls[1], {
    url: `${BASE_URL}/v1/jobs`,
    method: 'GET',
    body: undefined,
  });
  assert.deepEqual(
    releasedJobs.map((job) => job.id),
    [1, 3],
    'a blocked job never becomes a candidate for a lease',
  );

  const grant = await client.requestLease({
    runner_id: 'runner-a',
    project_id: 3,
    job_id: 55,
    runner_cap: 2,
    project_cap: 4,
    ttl_seconds: 30,
  });
  assert.equal(grant.lease?.id, 12);
  assert.deepEqual(calls[2], {
    url: `${BASE_URL}/v1/leases`,
    method: 'POST',
    body: {
      runner_id: 'runner-a',
      project_id: 3,
      job_id: 55,
      runner_cap: 2,
      project_cap: 4,
      ttl_seconds: 30,
    },
  });

  const renewed = await client.heartbeat(12, 45);
  assert.equal(renewed.ttl_seconds, 45);
  assert.deepEqual(calls[3], {
    url: `${BASE_URL}/v1/leases/12/heartbeats`,
    method: 'POST',
    body: { ttl_seconds: 45 },
  });

  const releasedLease = await client.release(12);
  assert.equal(releasedLease.status, 'released');
  assert.deepEqual(calls[4], {
    url: `${BASE_URL}/v1/leases/12/releases`,
    method: 'POST',
    body: {},
  });

  assert.equal(calls.length, 5, 'not one call beyond the five of the contract');
});

test('t161 — a completed job stops being a candidate, even unblocked', async () => {
  const { ControlPlaneClient } = await loadClient();

  // `completed` has come out of `GET /v1/jobs` since t152: it is derived from
  // `current_node_id` against the `final_nodes` of the job's version. Without
  // this filter, a job that reaches the final node stays released forever — and
  // the controller redispatches it in a loop, which is t161's gap 3.
  const { fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: {
      jobs: [
        {
          id: 1,
          title: 'still moving',
          current_node_id: 'implementar',
          blocked: false,
          completed: false,
          execution_id: 9,
          graph_version_id: 'sha256:abc',
        },
        {
          id: 2,
          title: 'reached the final node',
          current_node_id: 'publicar',
          blocked: false,
          completed: true,
          execution_id: 9,
          graph_version_id: 'sha256:abc',
        },
      ],
    },
  }));

  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });
  const releasedJobs = await client.listReleasedJobs();

  assert.deepEqual(
    releasedJobs.map((job) => job.id),
    [1],
    'a job on the final node does not go back to the dispatch queue',
  );
  assert.equal(releasedJobs[0].completed, false, 'the field reaches the caller, not only the filter');
});

test('AT13 — a denied lease reaches the caller as a reason, not as an error', async () => {
  const { ControlPlaneClient } = await loadClient();

  const { fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: { lease: null, reason: 'project_cap' },
  }));

  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });
  const grant = await client.requestLease({
    runner_id: 'runner-a',
    project_id: 3,
    job_id: 55,
    runner_cap: 1,
    project_cap: 1,
    ttl_seconds: 30,
  });

  assert.equal(grant.lease, null);
  assert.equal(grant.reason, 'project_cap');
});

test('AT13 — an error answer of the control plane becomes an exception with the status', async () => {
  const { ControlPlaneClient, ControlPlaneClientError } = await loadClient();

  const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { erro: 'runner_desconhecido' } }));
  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });

  await assert.rejects(
    async () =>
      client.requestLease({
        runner_id: 'fantasma',
        project_id: 3,
        job_id: 55,
        runner_cap: 1,
        project_cap: 1,
        ttl_seconds: 30,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ControlPlaneClientError);
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test('AT13 — the base URL tolerates a trailing slash, like the screen client', async () => {
  const { ControlPlaneClient } = await loadClient();

  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 201,
    body: { runner: { id: 'runner-a', name: null, registered_at: '2026-08-14T12:00:00.000Z' } },
  }));

  const client = new ControlPlaneClient({ urlBase: `${BASE_URL}/`, fetchImpl });
  await client.registerRunner('runner-a');

  assert.equal(calls[0].url, `${BASE_URL}/v1/runners`);
  assert.deepEqual(calls[0].body, { id: 'runner-a' }, 'an absent name does not become null in the body');
});

/**
 * Fake `fetch` that records the HEADERS of every call (t124).
 *
 * Kept apart from `fakeFetch` above on purpose: that one pins verb, path and
 * body, and is the contract t103 froze. What this ticket adds is orthogonal —
 * the same request, with a credential — and a fake `fetch` that recorded
 * everything would make that test's `deepEqual` hostage to this one.
 */
function fetchRecordingHeaders(): {
  fetchImpl: typeof fetch;
  authorizations: Array<string | null>;
} {
  const authorizations: Array<string | null> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return new Response(
      JSON.stringify(
        String(input).endsWith('/v1/jobs')
          ? { jobs: [] }
          : { runner: { id: 'runner-a', name: null, registered_at: '2026-08-14T12:00:00.000Z' } },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, authorizations };
}

test('t124 — with `token` configured, every call carries the Bearer header', async () => {
  const { ControlPlaneClient } = await loadClient();

  const { fetchImpl, authorizations } = fetchRecordingHeaders();
  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl, token: 'runner-token' });

  await client.registerRunner('runner-a');
  await client.listReleasedJobs();

  assert.deepEqual(
    authorizations,
    ['Bearer runner-token', 'Bearer runner-token'],
    'the POST and the GET both carry the credential: no business route is exempt',
  );
});

test('t124 — with no `token`, the client invents no header at all', async () => {
  const { ControlPlaneClient } = await loadClient();

  const { fetchImpl, authorizations } = fetchRecordingHeaders();
  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });

  await client.registerRunner('runner-a');
  await client.listReleasedJobs();

  assert.deepEqual(
    authorizations,
    [null, null],
    'a client with no credential takes a 401 from the control plane — not an empty header that looks like a credential',
  );
});

/**
 * Fake `fetch` that answers a RAW response, built by the test (t156).
 *
 * Kept apart from `fakeFetch` at the top on purpose: that one always serializes
 * JSON and announces `application/json`, and so cannot even describe this
 * ticket's case — a broken intermediary (a reverse proxy) answering 502 with an
 * HTML page, which is a body `JSON.parse` does not swallow.
 */
function fetchAnswering(build: () => Response): typeof fetch {
  return async () => build();
}

const HTML_502 = '<html>502 Bad Gateway</html>';

test('t156 — a non-JSON error body becomes a ControlPlaneClientError with the raw text, never a SyntaxError', async () => {
  const { ControlPlaneClient, ControlPlaneClientError } = await loadClient();

  const client = new ControlPlaneClient({
    urlBase: BASE_URL,
    fetchImpl: fetchAnswering(
      () => new Response(HTML_502, { status: 502, headers: { 'content-type': 'text/html' } }),
    ),
  });

  await assert.rejects(
    () => client.listReleasedJobs(),
    (error: unknown) => {
      assert.ok(
        error instanceof ControlPlaneClientError,
        `expected ControlPlaneClientError, got ${error instanceof Error ? error.name : String(error)}`,
      );
      assert.equal(error.status, 502);
      assert.equal(
        error.body,
        HTML_502,
        'the raw body is what is left for whoever logs it: it was not the control plane that answered',
      );
      return true;
    },
  );
});

/**
 * A non-regression pin, not a repro: the empty-body case ALREADY works today
 * (`text === '' ? undefined : JSON.parse(text)`), and what this test guards is
 * that t156's refactor does not swap it for `''` or for an exception.
 */
test('t156 (non-regression) — an empty body in an error answer still arrives as undefined', async () => {
  const { ControlPlaneClient, ControlPlaneClientError } = await loadClient();

  const client = new ControlPlaneClient({
    urlBase: BASE_URL,
    fetchImpl: fetchAnswering(() => new Response('', { status: 500 })),
  });

  await assert.rejects(
    () => client.listReleasedJobs(),
    (error: unknown) => {
      assert.ok(error instanceof ControlPlaneClientError);
      assert.equal(error.status, 500);
      assert.equal(error.body, undefined);
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* t144 — the one write the intake generation command adds (AT4).              */
/* -------------------------------------------------------------------------- */

/** The two items of a batch, in the shape `domain/intake.ts` validates. */
const INTAKE_ITEMS = [
  { ref: 'migracao', title: 'Migracao do intake' },
  { ref: 'rotas', title: 'Rotas do intake', depende_de: ['migracao'] },
];

test('AT4 — createIntake posts the body to /v1/intake and resolves the draft', async () => {
  const { ControlPlaneClient } = await loadClient();

  const draft = {
    id: 9,
    project_id: 3,
    execution_id: null,
    class: 'software-development',
    request: 'fechar a camada de intake',
    items: INTAKE_ITEMS,
    status: 'pending',
    created_jobs: null,
    created_at: '2026-08-16T12:00:00.000Z',
    updated_at: '2026-08-16T12:00:00.000Z',
  };

  const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { draft } }));
  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });

  const created = await client.createIntake({
    class: 'software-development',
    request: 'fechar a camada de intake',
    items: INTAKE_ITEMS,
  });

  assert.deepEqual(calls, [
    {
      url: `${BASE_URL}/v1/intake`,
      method: 'POST',
      body: {
        class: 'software-development',
        request: 'fechar a camada de intake',
        items: INTAKE_ITEMS,
      },
    },
  ]);
  assert.deepEqual(created, draft, 'the draft comes out of `{draft}`, unwrapped');
  assert.equal(created.status, 'pending', 'a draft is born pending; confirming it is the human gate');
});

test('AT4 — a refused write carries the status, like every other call of this door', async () => {
  const { ControlPlaneClient, ControlPlaneClientError } = await loadClient();

  const { fetchImpl } = fakeFetch(() => ({
    status: 404,
    body: { erro: 'grafo_desconhecido', class: 'nao-registrada' },
  }));
  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl });

  await assert.rejects(
    () =>
      client.createIntake({
        class: 'nao-registrada',
        request: 'anything at all',
        items: INTAKE_ITEMS,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ControlPlaneClientError);
      assert.equal(error.status, 404);
      assert.deepEqual(error.body, { erro: 'grafo_desconhecido', class: 'nao-registrada' });
      return true;
    },
  );
});

test('AT4 — the client has no confirm, amend or discard: those are the human gate', async () => {
  const { ControlPlaneClient } = await loadClient();

  const client = new ControlPlaneClient({ urlBase: BASE_URL, fetchImpl: fakeFetch(() => ({ status: 200, body: {} })).fetchImpl });

  // The same reasoning `createProposal` records: a client that does not have
  // the method cannot take the decision by accident (README, principle 5).
  for (const absent of ['confirmIntake', 'amendIntake', 'discardIntake']) {
    assert.equal(
      (client as unknown as Record<string, unknown>)[absent],
      undefined,
      `${absent} would put t122's human gate inside the runner`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* t193 — every call of this door carries a deadline.                         */
/*                                                                            */
/* The failure they describe is not a control plane that is down: that one     */
/* answers, and `fakeFetch` above already covers what it answers with. It is   */
/* a control plane that ACCEPTS the connection and then says nothing — and     */
/* against that, a client with no deadline hangs the tick, and with it the     */
/* loop and the shutdown that awaits it.                                       */
/* -------------------------------------------------------------------------- */

/** A `fetch` that connects and never answers: the server that is there and silent. */
const NEVER_ANSWERS: typeof fetch = () => new Promise<Response>(() => undefined);

/** Deadline of these two cases: what "not never" means. Well above their own. */
const NEVER_MS = 5_000;

/**
 * Settles a promise against a deadline, so that a hang is an assertion and not
 * a suite that stops.
 */
async function settleWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: 'resolved' | 'rejected' | 'hung'; error: unknown; elapsed: number }> {
  const started = Date.now();
  // Aborted on the way out, so that a case which settled in 150ms does not keep
  // the suite's event loop alive for the whole deadline it did not need.
  const guard = new AbortController();
  try {
    const outcome = await Promise.race([
      promise.then(
        () => ({ settled: 'resolved' as const, error: null as unknown }),
        (error: unknown) => ({ settled: 'rejected' as const, error }),
      ),
      delay(ms, undefined, { signal: guard.signal }).then(
        () => ({ settled: 'hung' as const, error: null as unknown }),
        () => ({ settled: 'hung' as const, error: null as unknown }),
      ),
    ]);
    return { ...outcome, elapsed: Date.now() - started };
  } finally {
    guard.abort();
  }
}

test('t193 — a control plane that never answers is a rejection on the deadline, not a hang', async () => {
  const { ControlPlaneClient } = await loadClient();

  const client = new ControlPlaneClient({
    urlBase: BASE_URL,
    fetchImpl: NEVER_ANSWERS,
    requestTimeoutMs: 150,
  });

  const outcome = await settleWithin(client.listReleasedJobs(), NEVER_MS);

  assert.equal(
    outcome.settled,
    'rejected',
    `a tick that never comes back is a runner that stops working and cannot even be stopped (it ${outcome.settled} after ${outcome.elapsed}ms)`,
  );
  assert.ok(
    outcome.error instanceof Error && outcome.error.name === 'TimeoutError',
    `the rejection has to be recognizable as a timeout, got: ${String(outcome.error)}`,
  );
});

test('t193 — heartbeat given a shorter deadline fails on its own, not on the client default', async () => {
  const { ControlPlaneClient } = await loadClient();

  // A default nobody in this case wants to wait for: if the per-call override
  // were ignored, this test would time out on the deadline below instead of on
  // the 150ms it asked for.
  const client = new ControlPlaneClient({
    urlBase: BASE_URL,
    fetchImpl: NEVER_ANSWERS,
    requestTimeoutMs: 60_000,
  });

  const outcome = await settleWithin(client.heartbeat(12, undefined, 150), NEVER_MS);

  assert.equal(
    outcome.settled,
    'rejected',
    `the heartbeat's own deadline is what keeps a beat from outliving the interval that armed it (it ${outcome.settled} after ${outcome.elapsed}ms)`,
  );
  assert.ok(
    outcome.error instanceof Error && outcome.error.name === 'TimeoutError',
    `expected a timeout, got: ${String(outcome.error)}`,
  );
  assert.ok(
    outcome.elapsed < 2_000,
    `it waited ${outcome.elapsed}ms: the per-call override lost to the client's default`,
  );
});

/* -------------------------------------------------------------------------- */
/* t247 — `createProposal` reports whether it CREATED anything (AT1).          */
/*                                                                            */
/* Since t246 the control plane deduplicates: a repeat that matches a still-  */
/* pending proposal on `(lens, target_version, operations)` answers 200 with  */
/* that same proposal instead of 201 with a clone. The proposal that comes    */
/* back reads `pending` either way — the ONE signal that tells the two apart  */
/* is the status, and this door used to throw it away.                        */
/* -------------------------------------------------------------------------- */

/** The proposal body both cases answer with; only the status differs. */
const STORED_PROPOSAL = {
  id: 42,
  graph_id: 'nota-curta',
  target_version: 'sha256:v1',
  status: 'pending',
};

/** The five keys of `POST /v1/proposals`, as the flow lens sends them. */
const PROPOSAL_INPUT = {
  graph_id: 'nota-curta',
  target_version: 'sha256:v1',
  operations: [
    {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'description',
      from: 'before',
      to: 'after',
      inverse: {
        type: 'change_node_field',
        node_id: 'revisar',
        field: 'description',
        from: 'after',
        to: 'before',
      },
    },
  ],
  evidence: { lens: 'flow' },
  expected_metric: { nome: 'tempo_espera_ms:revisar', direcao: 'cai', de: 100, para: 80 },
};

test('t247 AT1 — createProposal reports `created` from the HTTP status', async () => {
  const { ControlPlaneClient } = await loadClient();

  const created = await new ControlPlaneClient({
    urlBase: BASE_URL,
    fetchImpl: fakeFetch(() => ({ status: 201, body: { proposal: STORED_PROPOSAL } })).fetchImpl,
  }).createProposal(PROPOSAL_INPUT);

  assert.equal(created.created, true, '201 is a proposal that did not exist a moment ago');
  assert.deepEqual(created.proposal, STORED_PROPOSAL, 'and the proposal is the one the body carried');

  const deduplicated = await new ControlPlaneClient({
    urlBase: BASE_URL,
    fetchImpl: fakeFetch(() => ({ status: 200, body: { proposal: STORED_PROPOSAL } })).fetchImpl,
  }).createProposal(PROPOSAL_INPUT);

  assert.equal(
    deduplicated.created,
    false,
    '200 is t246 answering with the pending proposal that was already there',
  );
  assert.deepEqual(
    deduplicated.proposal,
    STORED_PROPOSAL,
    'the same proposal comes back on both, which is exactly why the status is the only signal',
  );
  assert.equal(
    deduplicated.proposal.status,
    created.proposal.status,
    'a deduplicated proposal reads `pending` too: `status` cannot tell the two apart',
  );
});
