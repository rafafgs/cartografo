/**
 * Acceptance tests of `GET /sessions/:id/log` (t368, RF-39/RF-40).
 *
 * The densest surface of the product, per the ticket's own Context (Part 2
 * component 6): monospace, wrapping inside its own scrolling container, the
 * failed line marked with the same red bar used elsewhere, and the cut
 * declared instead of hidden.
 *
 * A STUB control plane, for the same reason `job-page.test.ts` and
 * `examples-page.test.ts` use one: this file pins what the page draws out of
 * `GET /v1/sessions/:id/log`'s answer, not the route itself — that is proven
 * against a real control plane in `packages/core/test/sessions.test.ts`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as RouterModule from '../src/router.ts';
import { T107_ARTIFACTS, requireArtifacts, type TestHooks } from './support.ts';

/** The screen, up, over a stub that answers one canned `SessionLog`. */
async function startScreenOverStub(
  t: TestHooks,
  log: Record<string, unknown>,
): Promise<{ url: string }> {
  requireArtifacts(T107_ARTIFACTS.router, T107_ARTIFACTS.pages, T107_ARTIFACTS.client);
  const { startScreenRouter } = (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;

  const doFetch: typeof fetch = async (input) => {
    const target = new URL(typeof input === 'string' ? input : String(input));
    if (target.pathname === '/v1/projects') {
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(log), {
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

  return { url: screen.url };
}

const BASE_LOG = Object.freeze({
  session_id: 148,
  node_id: 'conferir-numeros',
  engine: 'claude-code',
  transcript_truncated: false,
  transcript_original_size: null,
  transcript_artifact_id: null,
});

test('t368 AT — exit_code: 1 marks exactly one line, the last non-blank one, log-line-failed', async (t) => {
  const log = {
    ...BASE_LOG,
    exit_code: 1,
    text: 'reading the ticket\nchecking the numbers\nthey do not add up\n\n',
  };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  assert.equal(response.status, 200);
  const html = await response.text();

  const marked = [
    ...html.matchAll(/class="[^"]*log-line-failed[^"]*"\s+data-log-line="(\d+)"/g),
  ];
  assert.equal(marked.length, 1, `expected exactly one marked line:\n${html}`);
  // Lines: 1 reading…, 2 checking…, 3 they do not add up, 4 "" (blank), 5 "" (trailing split).
  // The last NON-BLANK line is #3.
  assert.equal(marked[0][1], '3', `the wrong line was marked:\n${html}`);
});

test('t368 AT — exit_code: 0 marks zero lines', async (t) => {
  const log = { ...BASE_LOG, exit_code: 0, text: 'all good\ndone' };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  const html = await response.text();
  // Not a bare substring check: the stylesheet ITSELF names `.log-line-failed`
  // on every page, so the marker of a MARKED line is the class attached to a
  // `<div>`, never the mention of the rule that styles it.
  assert.ok(
    !/class="[^"]*log-line-failed/.test(html),
    `a successful session marked a line:\n${html}`,
  );
});

test('t368 AT — exit_code: null marks zero lines', async (t) => {
  const log = { ...BASE_LOG, exit_code: null, text: 'still running, or ran before exit codes existed' };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  const html = await response.text();
  assert.ok(!/class="[^"]*log-line-failed/.test(html), `a null exit code marked a line:\n${html}`);
});

test('t368 AT — a truncated transcript renders the cut notice with both sizes, no artifact link when null', async (t) => {
  const log = {
    ...BASE_LOG,
    exit_code: 1,
    text: 'b'.repeat(1_048_576),
    transcript_truncated: true,
    transcript_original_size: 3_565_158,
    transcript_artifact_id: null,
  };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  const html = await response.text();

  assert.match(html, /1 MiB/, `the cap size is missing:\n${html}`);
  assert.match(html, /3\.4 MiB/, `the formatted original size is missing:\n${html}`);
  assert.ok(!html.includes('/v1/artifacts/'), `an artifact link rendered with a null id:\n${html}`);
});

test('t368 AT — the cut notice links the artifact when transcript_artifact_id is set', async (t) => {
  const log = {
    ...BASE_LOG,
    exit_code: 1,
    text: 'b'.repeat(1_048_576),
    transcript_truncated: true,
    transcript_original_size: 3_565_158,
    transcript_artifact_id: 777,
  };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  const html = await response.text();

  assert.ok(html.includes('/v1/artifacts/777/content'), `the artifact link is missing:\n${html}`);
});

test('t368 AT — the log container and the stylesheet both declare overflow: auto and a max-height', async (t) => {
  const log = { ...BASE_LOG, exit_code: 0, text: 'hello' };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  const html = await response.text();
  assert.match(html, /<div class="log">/, 'the log has no container to scroll on its own');

  // The stylesheet is a linked file since t458, not an inline <style> block —
  // read the same document a browser would fetch alongside this page.
  const styleResponse = await fetch(`${screen.url}/style.css`);
  const stylesheet = await styleResponse.text();
  assert.match(stylesheet, /\.log\s*\{[^}]*overflow:\s*auto/s, `the stylesheet has no overflow: auto:\n${stylesheet}`);
  assert.match(stylesheet, /\.log\s*\{[^}]*max-height:/s, `the stylesheet has no max-height:\n${stylesheet}`);
});

test('t368 AT — the top bar carries the session id, node and exit code', async (t) => {
  const log = { ...BASE_LOG, exit_code: 1, text: 'x' };
  const screen = await startScreenOverStub(t, log);

  const response = await fetch(`${screen.url}/sessions/148/log`);
  const html = await response.text();

  assert.match(html, /session #148/);
  assert.match(html, /node conferir-numeros/);
  assert.match(html, /exit 1/);
});
