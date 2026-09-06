/**
 * Acceptance tests of the Examples page (t408, FR6/FR7).
 *
 * The page is one card per demo-ready bundle and one form per card, and the
 * form's whole job is to turn a click into `POST /v1/examples/:class/run` and
 * then open the board on the round that came back. Nothing about which bundles
 * exist is decided here: the screen reads `GET /v1/examples` and draws what it
 * is told, because it opens no directory and knows no path (D11).
 *
 * The control plane is a STUB, for the reason `project-switcher.test.ts` gives
 * for the same choice: what this file pins is what the screen PUTS ON THE WIRE
 * and what it does with the answer, and a real control plane would only add a
 * bundle registration to every assertion without making one of them stronger.
 * The route is proven against a real control plane end to end in
 * `packages/runner/test/controller/factory-graph-bets.e2e.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as RouterModule from '../src/router.ts';
import { T107_ARTIFACTS, requireArtifacts, type TestHooks } from './support.ts';

/** The examples the fake control plane offers. */
const EXAMPLES = [
  {
    class: 'asymmetric-bets',
    bundle: 'asymmetric-bets',
    demo_title: 'A worked thesis, end to end',
    registered: false,
  },
  {
    class: 'b3-flow-radar',
    bundle: 'b3-flow-radar',
    demo_title: 'Read the B3 flow of day-1',
    registered: true,
  },
];

/** The execution the fake control plane says the run landed in. */
const EXECUTION_ID = 77;

/** The screen, up, plus everything it asked the control plane for. */
interface StubbedScreen {
  url: string;
  calls: string[];
}

/** The canned bodies, by path. */
const CANNED: Record<string, unknown> = {
  '/v1/projects': { projects: [] },
  '/v1/examples': { examples: EXAMPLES },
};

/**
 * Starts the screen against a stub that records what it was asked for.
 *
 * @param t Test context, so the server is shut down at the end.
 * @returns The screen's URL and the list of calls it made.
 */
async function startScreenOverStub(t: TestHooks): Promise<StubbedScreen> {
  requireArtifacts(T107_ARTIFACTS.router, T107_ARTIFACTS.pages, T107_ARTIFACTS.client);
  const { startScreenRouter } = (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;

  const calls: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === 'string' ? input : String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${target.pathname}${target.search}`);

    if (method === 'POST' && target.pathname.endsWith('/run')) {
      return new Response(
        JSON.stringify({
          job: { id: 12, execution_id: EXECUTION_ID, title: 'A worked thesis, end to end' },
          execution_id: EXECUTION_ID,
          registered: true,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify(CANNED[target.pathname] ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const screen = await startScreenRouter({
    controlPlaneUrl: 'http://127.0.0.1:4317',
    port: 0,
    doFetch,
  });
  t.after(async () => {
    await screen.close();
  });

  return { url: screen.url, calls };
}

test('t408 AT — GET /examples draws one card per example, with its run form', async (t) => {
  const screen = await startScreenOverStub(t);

  const response = await fetch(`${screen.url}/examples`);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.ok(
    screen.calls.some((call) => call.startsWith('GET /v1/examples')),
    `the page did not read /v1/examples at all: ${screen.calls.join(', ')}`,
  );

  for (const example of EXAMPLES) {
    assert.ok(html.includes(example.class), `the card for ${example.class} is missing`);
    assert.ok(html.includes(example.demo_title), `the demo title of ${example.class} is missing`);
    assert.ok(
      html.includes(`action="/examples/${example.class}/run"`),
      `${example.class} has no run form`,
    );
  }

  assert.match(html, /already registered/i, 'the registered bundle says so');
  assert.match(html, /not registered yet/i, 'and the one that is not says that');
});

test('t408 AT — POST /examples/:class/run opens the board on the fresh execution', async (t) => {
  const screen = await startScreenOverStub(t);

  const submitted = await fetch(`${screen.url}/examples/asymmetric-bets/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: screen.url,
      referer: `${screen.url}/examples`,
    },
    body: '',
    redirect: 'manual',
  });

  assert.equal(submitted.status, 303, await submitted.text());
  assert.equal(
    submitted.headers.get('location'),
    `/executions/${EXECUTION_ID}`,
    'the redirect uses the execution the control plane allocated',
  );

  assert.ok(
    screen.calls.some((call) => call.startsWith('POST /v1/examples/asymmetric-bets/run')),
    `the write never reached the control plane: ${screen.calls.join(', ')}`,
  );
});

test('t408 AT — the run form is gated like every other write of this screen', async (t) => {
  const screen = await startScreenOverStub(t);

  const foreign = await fetch(`${screen.url}/examples/asymmetric-bets/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://somewhere.else',
    },
    body: '',
    redirect: 'manual',
  });

  assert.equal(foreign.status, 403, "a form on someone else's page may not start a demo");
  assert.deepEqual(
    screen.calls.filter((call) => call.startsWith('POST')),
    [],
    'and the control plane never learned the request existed',
  );
});
