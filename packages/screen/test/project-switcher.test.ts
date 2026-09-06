/**
 * Acceptance test of the project switcher (t354, FR7).
 *
 * The screen holds no state of its own — D11 has not moved — so "which project
 * am I looking at" is a COOKIE and nothing else: `POST /project` writes it,
 * every GET route reads it, and every call the route makes through `ApiClient`
 * carries `project_id`. There is no session, no memory between requests, and
 * nothing about the choice reaches the control plane except as a query
 * parameter on reads the operator was already allowed to make.
 *
 * The control plane is a STUB here, and deliberately so. What this file pins is
 * the query parameter the screen puts on the wire, and asserting that against a
 * real control plane would mean seeding two projects' worth of jobs to observe
 * the difference indirectly — a longer test that proves less. `startScreenRouter`
 * takes a `doFetch`, so the outgoing request is readable directly, which is the
 * one thing the assertion is about.
 *
 * The switcher's own markup in the nav is a declared TDD exception (the
 * ticket's own list): what is pinned here is the cookie being set, read and
 * defaulted, because that is the behaviour a wrong implementation gets wrong
 * silently.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as RouterModule from '../src/router.ts';
import { T107_ARTIFACTS, requireArtifacts, type TestHooks } from './support.ts';

/** Every URL the screen asked the control plane for, in order. */
interface StubbedControlPlane {
  url: string;
  calls: string[];
}

/** The bodies the stub answers with, by path prefix. */
const CANNED: Record<string, unknown> = {
  '/v1/projects': {
    projects: [
      { id: 1, name: 'default', created_at: '2026-09-06T12:00:00.000Z' },
      { id: 2, name: 'second', created_at: '2026-09-06T12:00:01.000Z' },
    ],
  },
  '/v1/jobs': { jobs: [] },
  '/v1/executions': { executions: [] },
  '/v1/input-requests': { input_requests: [] },
  '/v1/runners': { runners: [] },
  '/v1/sessions': { sessions: [] },
};

/**
 * Starts the screen against a stub that records what it was asked for.
 *
 * @param t Test context, so the server is shut down at the end.
 * @returns The screen's URL and the list of paths it requested.
 */
async function startScreenOverStub(t: TestHooks): Promise<StubbedControlPlane> {
  requireArtifacts(T107_ARTIFACTS.router, T107_ARTIFACTS.pages, T107_ARTIFACTS.client);
  const { startScreenRouter } = (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;

  const calls: string[] = [];
  const doFetch: typeof fetch = async (input) => {
    const target = new URL(typeof input === 'string' ? input : String(input));
    calls.push(`${target.pathname}${target.search}`);
    const canned = CANNED[target.pathname] ?? {};
    return new Response(JSON.stringify(canned), {
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

/** The `project_id` the screen put on the jobs read, or `null` when it put none. */
function scopeOfJobsCall(calls: string[]): string | null {
  const jobs = calls.find((call) => call.startsWith('/v1/jobs'));
  assert.ok(jobs !== undefined, `the board did not read /v1/jobs at all: ${calls.join(', ')}`);
  return new URL(jobs, 'http://control.local').searchParams.get('project_id');
}

test('t354 AT — with no cookie the screen reads project 1', async (t) => {
  const screen = await startScreenOverStub(t);

  const response = await fetch(`${screen.url}/board`);
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(
    scopeOfJobsCall(screen.calls),
    '1',
    'the default is the same one the API uses, stated rather than left absent',
  );
});

test('t354 AT — POST /project sets the cookie and sends the browser back', async (t) => {
  const screen = await startScreenOverStub(t);

  const submitted = await fetch(`${screen.url}/project`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: screen.url,
      referer: `${screen.url}/board`,
    },
    body: new URLSearchParams({ project_id: '2' }).toString(),
    redirect: 'manual',
  });

  assert.equal(submitted.status, 302);
  assert.equal(submitted.headers.get('location'), '/board', 'back to where the switch happened');

  const cookie = submitted.headers.get('set-cookie') ?? '';
  assert.match(cookie, /(^|[;\s])cartografo_project=2\b/, `no cookie was set: "${cookie}"`);
  assert.match(cookie, /Path=\//i, 'the cookie has to be readable from every page of the screen');
});

test('t354 AT — a GET carrying the cookie reads that project', async (t) => {
  const screen = await startScreenOverStub(t);

  const response = await fetch(`${screen.url}/board`, {
    headers: { cookie: 'cartografo_project=2' },
  });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.equal(scopeOfJobsCall(screen.calls), '2');
  assert.ok(
    screen.calls.some((call) => call.startsWith('/v1/projects')),
    'the switcher needs the list of projects to draw itself',
  );
  assert.match(html, /cartografo/, 'the page still renders');
});

test('t354 AT — a cookie that is not a number falls back to project 1', async (t) => {
  const screen = await startScreenOverStub(t);

  const response = await fetch(`${screen.url}/board`, {
    headers: { cookie: 'cartografo_project=nonsense' },
  });
  assert.equal(response.status, 200);
  await response.text();

  assert.equal(
    scopeOfJobsCall(screen.calls),
    '1',
    'a cookie a person edited by hand is not a reason to refuse the page',
  );
});

test('t354 AT — POST /project is gated like every other write of this screen', async (t) => {
  const screen = await startScreenOverStub(t);

  const foreign = await fetch(`${screen.url}/project`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://somewhere.else',
    },
    body: new URLSearchParams({ project_id: '2' }).toString(),
    redirect: 'manual',
  });

  assert.equal(foreign.status, 403, 'a form on someone else\'s page may not switch the project');
  assert.equal(foreign.headers.get('set-cookie'), null, 'and it sets nothing');
});
