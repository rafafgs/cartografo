/**
 * Acceptance tests of the cost lens's HTTP client (t114, AT8).
 *
 * All of it with an injected fake `fetch`, no real network: what this ticket
 * proves is the contract the surveyor uses from the public API — four routes,
 * not one more — and not the behaviour of the control plane, which has its own
 * tests in the core.
 *
 * The same pattern as `packages/tela/src/index.ts:31`: `doFetch` is injectable
 * for tests only; in production it is the global `fetch`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ClientModule from '../src/client.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'topografo-cost.md');

let cache: typeof ClientModule | null = null;

async function load(): Promise<typeof ClientModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'client.ts')),
    'artifact does not exist yet: packages/topografo-custo/src/client.ts',
  );
  cache ??= (await import(new URL('../src/client.ts', import.meta.url).href)) as typeof ClientModule;
  return cache;
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Fake `fetch` that records the call and returns the agreed body. */
function spy(answerBody: unknown): { calls: Call[]; doFetch: typeof fetch } {
  const calls: Call[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(answerBody), {
      status: init?.method === 'POST' ? 201 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, doFetch };
}

test('AT8 — getSessions and getJobs put execucao_id in the query when it is given', async () => {
  const { getSessions, getJobs } = await load();

  const forSessions = spy({ sessions: [{ id: 1 }] });
  const sessions = await getSessions(
    'http://127.0.0.1:4317',
    { execution_id: 7 },
    forSessions.doFetch,
  );
  assert.equal(sessions.length, 1);
  assert.deepEqual(
    forSessions.calls.map((call) => call.url),
    ['http://127.0.0.1:4317/v1/sessions?execution_id=7'],
  );

  const forJobs = spy({ jobs: [{ id: 1 }] });
  await getJobs('http://127.0.0.1:4317', { execution_id: 7 }, forJobs.doFetch);
  assert.deepEqual(
    forJobs.calls.map((call) => call.url),
    ['http://127.0.0.1:4317/v1/jobs?execution_id=7'],
  );

  // With no filter there is no dangling `?` left on the URL.
  const noFilter = spy({ sessions: [] });
  await getSessions('http://127.0.0.1:4317/', {}, noFilter.doFetch);
  assert.deepEqual(
    noFilter.calls.map((call) => call.url),
    ['http://127.0.0.1:4317/v1/sessions'],
    'the trailing slash of the base url is normalized, as in packages/tela',
  );
});

test('AT8 — createProposal does POST /v1/proposals with the five keys of the contract', async () => {
  const { createProposal } = await load();

  const input = {
    graph_id: 'nota-curta',
    target_version: 'sha256:v1',
    operations: [
      {
        type: 'change_node_field' as const,
        node_id: 'redigir',
        field: 'description' as const,
        from: 'antes',
        to: 'depois',
        inverse: {
          type: 'change_node_field' as const,
          node_id: 'redigir',
          field: 'description' as const,
          from: 'depois',
          to: 'antes',
        },
      },
    ],
    evidence: { lens: 'cost' as const },
    // The candidate's keys are English since t255; what `expected_metric` CARRIES
    // is the frozen hypothesis shape, which is why it reads Portuguese inside.
    expected_metric: { nome: 'tokens_total do nó "redigir"', direcao: 'cai', de: 5000, para: 1000 },
  };

  const { calls, doFetch } = spy({ proposal: { id: 42, status: 'pendente' } });
  // The call answers `{proposal, created}` since t247: the body is still the
  // proposal, and what rides beside it is whether the route CREATED one.
  const { proposal } = await createProposal('http://127.0.0.1:4317', input, doFetch);

  assert.equal(proposal.id, 42);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4317/v1/proposals');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(Object.keys(calls[0].body as object).sort(), [
    'evidence',
    'expected_metric',
    'graph_id',
    'operations',
    'target_version',
  ]);
  assert.deepEqual(calls[0].body, input);

  // t228: the operation inside the body speaks §3 English too — the five outer
  // keys went English with t226, and what they wrap went with D20's third child.
  const posted = (calls[0].body as { operations: Array<Record<string, unknown>> }).operations[0];
  assert.deepEqual(Object.keys(posted).sort(), [
    'field',
    'from',
    'inverse',
    'node_id',
    'to',
    'type',
  ]);
  assert.equal(posted.type, 'change_node_field');
});

test('AT8 — getGraphVersion reads the snapshot through the public version route', async () => {
  const { getGraphVersion } = await load();

  const { calls, doFetch } = spy({
    graph_version: { id: 'sha256:v1', graph_id: 'nota-curta', snapshot: { nodes: [] } },
  });
  const version = await getGraphVersion('http://127.0.0.1:4317', 'sha256:v1', doFetch);

  assert.equal(version.graph_id, 'nota-curta');
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://127.0.0.1:4317/v1/graph-versions/sha256%3Av1'],
    'the version id carries ":" and has to go into the path escaped',
  );
});

/**
 * The pre-D18 paths the API stopped serving (t127/t130/t132/t133).
 *
 * A hand-written list, and that is the point: a path renamed in the core breaks
 * no test of this ticket, because every unit test here talks to a fake `fetch`.
 * That is how the whole lens ended up pointing at routes answering 404 with
 * nothing to show for it (t136). Whoever renames again adds the line here.
 */
const PRE_D18_PATHS = Object.freeze([
  '/v1/sessoes',
  '/v1/trabalhos',
  '/v1/grafos',
  '/v1/grafo-versoes',
  '/v1/propostas',
  '/v1/execucoes',
]);

/** The boundary of the lens: the four routes of §5, and not one more. */
const BOUNDARY = Object.freeze([
  ['/v1/sessions', 'GET'],
  ['/v1/jobs', 'GET'],
  ['/v1/graph-versions/:id', 'GET'],
  ['/v1/proposals', 'POST'],
]);

/** The text of a `## N.` section of the spec, up to the next section. */
function section(spec: string, number: number): string {
  const start = spec.indexOf(`\n## ${number}.`);
  assert.notEqual(start, -1, `the spec has no section ${number}`);
  const remainder = spec.slice(start + 1);
  const end = remainder.indexOf('\n## ');
  return end === -1 ? remainder : remainder.slice(0, end);
}

test('t136 — the spec cites no pre-D18 path of the API', () => {
  assert.ok(existsSync(SPEC_PATH), `artifact does not exist yet: ${SPEC_PATH}`);
  const spec = readFileSync(SPEC_PATH, 'utf8');

  for (const route of PRE_D18_PATHS) {
    const lines = spec
      .split('\n')
      .map((text, index) => [index + 1, text] as const)
      .filter(([, text]) => new RegExp(`${route}\\b`).test(text));

    assert.deepEqual(
      lines,
      [],
      `the spec promises ${route}, which the API no longer serves (D18):\n` +
        lines.map(([number, text]) => `  ${number}: ${text.trim()}`).join('\n'),
    );
  }
});

test('t136 — the boundary table of §5 is exactly what the client calls', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');

  const table = [
    ...section(spec, 5).matchAll(/^\|\s*`(\/v1\/[^`]+)`\s*\|\s*(GET|POST|PATCH)\s*\|/gm),
  ].map((line) => [line[1], line[2]]);

  assert.deepEqual(
    table,
    BOUNDARY.map((line) => [...line]),
    'the §5 table and the routes of src/client.ts have to say the same thing',
  );
});

test('AT8 — an error answer becomes an exception with status and body, not silence', async () => {
  const { getSessions, ApiError } = await load();

  const doFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ erro: 'parametro_invalido' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });

  await assert.rejects(
    () => getSessions('http://127.0.0.1:4317', { execution_id: 7 }, doFetch),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 400);
      assert.deepEqual(error.body, { erro: 'parametro_invalido' });
      return true;
    },
  );
});

/**
 * Fake `fetch` that returns a RAW answer, built by the test (t156).
 *
 * Kept apart from the `spy` at the top on purpose: that one always serializes
 * JSON and announces `application/json`, and so it cannot even describe the case
 * of this ticket — a broken intermediary (reverse proxy) answering 502 with an
 * HTML page, which is a body `JSON.parse` does not swallow.
 */
function fetchAnswering(make: () => Response): typeof fetch {
  return async () => make();
}

const HTML_502 = '<html>502 Bad Gateway</html>';

test('t156 — a non-JSON error body becomes an ApiError with the raw text, not a SyntaxError', async () => {
  const { getSessions, ApiError } = await load();

  const doFetch = fetchAnswering(
    () => new Response(HTML_502, { status: 502, headers: { 'content-type': 'text/html' } }),
  );

  await assert.rejects(
    () => getSessions('http://127.0.0.1:4317', { execution_id: 7 }, doFetch),
    (error: unknown) => {
      assert.ok(
        error instanceof ApiError,
        `expected an ApiError, got ${error instanceof Error ? error.name : String(error)}`,
      );
      assert.equal(error.status, 502);
      assert.equal(
        error.body,
        HTML_502,
        'the raw body is what is left for whoever logs: it was not the API that answered',
      );
      return true;
    },
  );
});

/**
 * A non-regression pin, not a repro: the empty-body case ALREADY works today
 * (`text === '' ? undefined : JSON.parse(text)`), and what this test guards is
 * that the t156 refactor does not swap it for `''` nor for an exception.
 */
test('t156 (non-regression) — an empty body on an error answer still arrives as undefined', async () => {
  const { getSessions, ApiError } = await load();

  const doFetch = fetchAnswering(() => new Response('', { status: 500 }));

  await assert.rejects(
    () => getSessions('http://127.0.0.1:4317', {}, doFetch),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 500);
      assert.equal(error.body, undefined);
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* t247 — `createProposal` reports whether it CREATED anything (AT3).          */
/*                                                                            */
/* Since t246 the control plane deduplicates for every caller at once: a       */
/* repeat that matches a still-pending proposal on                            */
/* `(lens, target_version, operations)` answers 200 with that same proposal    */
/* instead of 201 with a clone. Both are a success and both carry a proposal   */
/* reading `pending`, so the status is the only thing that tells them apart —  */
/* and this door used to drop it on the floor.                                 */
/* -------------------------------------------------------------------------- */

/** A `fetch` that answers `POST` with the status the case is about. */
function answering(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

/** The five keys of the contract, as `evaluateExecution` assembles them. */
const CANDIDATE_INPUT = {
  graph_id: 'nota-curta',
  target_version: 'sha256:v1',
  operations: [
    {
      type: 'change_node_field' as const,
      node_id: 'redigir',
      field: 'description' as const,
      from: 'antes',
      to: 'depois',
      inverse: {
        type: 'change_node_field' as const,
        node_id: 'redigir',
        field: 'description' as const,
        from: 'depois',
        to: 'antes',
      },
    },
  ],
  evidence: { lens: 'cost' as const },
  expected_metric: { nome: 'tokens_total', direcao: 'cai', de: 5000, para: 1000 },
};

test('t247 AT3 — createProposal reports `created` from the HTTP status', async () => {
  const { createProposal } = await load();
  const recorded = { proposal: { id: 7, status: 'pending' } };

  const created = await createProposal(
    'http://127.0.0.1:4317',
    CANDIDATE_INPUT,
    answering(201, recorded),
  );
  assert.equal(created.created, true, '201 is a candidate nobody had raised yet');
  assert.deepEqual(created.proposal, recorded.proposal);

  const deduped = await createProposal(
    'http://127.0.0.1:4317',
    CANDIDATE_INPUT,
    answering(200, recorded),
  );
  assert.equal(deduped.created, false, '200 is t246 answering with the proposal already in the book');
  assert.deepEqual(deduped.proposal, recorded.proposal);
  assert.equal(
    deduped.proposal.status,
    created.proposal.status,
    'both read `pending`, which is exactly why the status of the answer is the only signal',
  );
});
