/**
 * Acceptance tests of the screen's cross-origin gate (t192, AT1–AT7).
 *
 * The screen's `/v1/*` proxy stamps the operator's credential onto everything it
 * forwards (t124), and the control plane's write routes accept an empty body. A
 * `fetch(url, {method:'POST', mode:'no-cors'})` from ANY page open in the same
 * browser is a "simple" request — no preflight — so, before this ticket, any
 * page could apply a proposal or answer a question with the operator's token.
 *
 * The gate is fetch metadata: `Sec-Fetch-Site` and `Origin` are set by the
 * browser's own network stack and cannot be overridden by page script, not even
 * in `no-cors` mode. That is what makes them usable as the signal here — and
 * also what bounds this fix: a malicious LOCAL PROCESS forges any header it
 * likes and is unaffected, by design (D11 keeps loopback as the boundary).
 *
 * Two things every test below proves, and the second is the one that matters:
 * that the screen answered `403`, AND that the control plane never saw the
 * request at all. The fake upstream's `requests` array is the second half for
 * AT1–AT6; AT7 goes further and reads the real control plane back, independently
 * of the screen, exactly like `questions.test.ts` does.
 *
 * The fake-upstream pattern is `server-proxy.test.ts`'s, repeated here rather
 * than shared: this file is about what NEVER reaches the upstream, so it records
 * one more field (`User-Agent`) that the pass-through tests have no use for.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import type * as ScreenServerModule from '../src/server.ts';
import {
  api,
  createJob,
  createQuestion,
  startControlPlane,
  startScreen,
  type Question,
  type RunningControlPlane,
} from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'server.ts');

/** A browser that predates fetch metadata still looks like a browser. */
const OLD_BROWSER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0';

/** Minimal shape of the test context this file uses (same idiom as the core). */
interface Cleanup {
  after: (fn: () => void | Promise<void>) => void;
}

let cache: typeof ScreenServerModule | null = null;

async function loadServer(): Promise<typeof ScreenServerModule> {
  assert.ok(existsSync(SERVER_PATH), 'artifact does not exist yet: packages/tela/src/server.ts');
  cache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ScreenServerModule;
  return cache;
}

/** What the fake control plane saw — and, mostly here, did not see. */
interface RecordedRequest {
  method: string;
  target: string;
  contentType: string | undefined;
  /** Recorded because the gate's last branch reads it (FR1c). */
  agent: string | undefined;
  body: string;
}

interface FakeUpstream {
  url: string;
  requests: RecordedRequest[];
}

async function startFakeUpstream(
  t: Cleanup,
  respond: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? '',
        target: request.url ?? '',
        contentType: request.headers['content-type'],
        agent: request.headers['user-agent'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      respond(recorded, response);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fake upstream did not bind a port'));
        return;
      }
      resolve(address.port);
    });
  });

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return { url: `http://127.0.0.1:${port}`, requests };
}

async function startScreenFor(
  t: Cleanup,
  env: NodeJS.ProcessEnv,
): Promise<ScreenServerModule.Screen> {
  const { startScreen: start } = await loadServer();
  const screen = await start({ CARTOGRAFO_TELA_PORT: '0', ...env });
  t.after(async () => {
    await screen.close();
  });
  return screen;
}

/** An upstream that answers every call, so a refusal is never a missing route. */
async function startAgreeableUpstream(t: Cleanup): Promise<FakeUpstream> {
  return await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"proposta":{"id":7,"status":"aprovada"}}');
  });
}

/** The shape of the refusal, asserted the same way wherever it appears. */
async function assertRefused(response: Response): Promise<void> {
  assert.equal(response.status, 403);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  const body = (await response.json()) as { erro: string; mensagem: string };
  assert.equal(body.erro, 'origem_nao_confiavel');
  assert.ok(body.mensagem.length > 0, 'the refusal says what to do about it');
}

test('t192 AT1 — a cross-site POST to /v1/* is refused, and the control plane never sees it', async (t) => {
  const upstream = await startAgreeableUpstream(t);
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const response = await fetch(`${screen.url}/v1/proposals/9/apply`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site' },
  });

  await assertRefused(response);
  assert.deepEqual(upstream.requests, [], 'the write never reached the control plane');
});

test('t192 AT2 — a foreign Origin is refused even with no Sec-Fetch-Site', async (t) => {
  const upstream = await startAgreeableUpstream(t);
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const response = await fetch(`${screen.url}/v1/proposals/7/approve`, {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });

  await assertRefused(response);
  assert.deepEqual(upstream.requests, [], 'the write never reached the control plane');
});

test("t192 AT3 — the screen's own page is forwarded verbatim, by either signal", async (t) => {
  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"proposta":{"id":7,"status":"aprovada"}}');
  });
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const sent = JSON.stringify({ reason: 'métrica esperada não é observável' });

  // 1. What a current browser sends from the screen's own tab.
  const bySite = await fetch(`${screen.url}/v1/proposals/7/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: sent,
  });
  assert.equal(bySite.status, 200);
  assert.equal(await bySite.text(), '{"proposta":{"id":7,"status":"aprovada"}}');
  assert.match(bySite.headers.get('content-type') ?? '', /^application\/json/);

  // 2. And the same call identified only by an Origin that matches this screen.
  const byOrigin = await fetch(`${screen.url}/v1/proposals/7/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://${new URL(screen.url).host}`,
    },
    body: sent,
  });
  assert.equal(byOrigin.status, 200);
  assert.equal(await byOrigin.text(), '{"proposta":{"id":7,"status":"aprovada"}}');

  assert.equal(upstream.requests.length, 2, 'both went through');
  for (const forwarded of upstream.requests) {
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.target, '/v1/proposals/7/approve');
    assert.match(forwarded.contentType ?? '', /^application\/json/);
    assert.equal(forwarded.body, sent, 'the gate did not touch the traffic it lets through');
  }
});

test('t192 AT4 — a caller with none of the three headers is still forwarded', async (t) => {
  const upstream = await startAgreeableUpstream(t);
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  // No headers set at all: this is what every other test in this package sends,
  // and what a script or a `curl` on the same machine sends. The local-process
  // exception is deliberate — D11 keeps the loopback port as the boundary.
  const response = await fetch(`${screen.url}/v1/proposals/7/approve`, { method: 'POST' });

  assert.equal(response.status, 200);
  assert.equal(upstream.requests.length, 1);
  assert.doesNotMatch(
    upstream.requests[0].agent ?? '',
    /Mozilla\/|Chrome\/|Safari\/|Firefox\/|Edg\//,
    "Node's own fetch does not present itself as a browser, which is why no existing test had to change",
  );
});

test('t192 AT5 — a browser that sends neither signal is refused on its User-Agent', async (t) => {
  const upstream = await startAgreeableUpstream(t);
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const response = await fetch(`${screen.url}/v1/proposals/7/approve`, {
    method: 'POST',
    headers: { 'user-agent': OLD_BROWSER_AGENT },
  });

  await assertRefused(response);
  assert.deepEqual(upstream.requests, [], 'a pre-fetch-metadata browser gets no free pass');
});

test('t192 AT6 — a cross-site GET is forwarded: reading is not gated', async (t) => {
  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"propostas":[]}');
  });
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  // A `no-cors` response body is opaque to the page that asked for it, so there
  // is nothing to exfiltrate through the read side; gating it would be cost with
  // no gain (`docs/spec/tela.md`, §1).
  const response = await fetch(`${screen.url}/v1/proposals`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"propostas":[]}');
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].method, 'GET');
});

/** Reads the question straight from the control plane, bypassing the screen. */
async function readFromControlPlane(
  cp: RunningControlPlane,
  jobId: number,
  questionId: number,
): Promise<Question> {
  const response = await api<{ input_requests: Question[] }>(
    cp,
    'GET',
    `/v1/input-requests?trabalho_id=${jobId}`,
  );
  assert.equal(response.status, 200);
  const found = response.body.input_requests.find((question) => question.id === questionId);
  assert.ok(found !== undefined, `the control plane does not know question ${questionId}`);
  return found;
}

test("t192 AT7 — the server-rendered form refuses a cross-site submit, and nothing is written", async (t) => {
  const cp = await startControlPlane(t);
  const job = await createJob(cp, { title: 'com pergunta', entry_node_id: 'refinar' });
  const question = await createQuestion(cp, {
    job_id: job.id,
    question: 'Renumerar a migração para 0003?',
  });

  const screen = await startScreen(t, cp);
  const submission = await fetch(`${screen.url}/input-requests/${question.id}/answer`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
    },
    body: new URLSearchParams({ resposta: 'Manter 0002', respondido_por: 'rafael' }).toString(),
    redirect: 'manual',
  });

  assert.equal(submission.status, 403);
  assert.match(submission.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(await submission.text(), /origem não confiável/);

  // The proof is not the page: it is the state, read back through the public API
  // without going through the screen at all.
  const after = await readFromControlPlane(cp, job.id, question.id);
  assert.equal(after.status, 'pending', 'nothing was written');
  assert.equal(after.answer, null);
});
