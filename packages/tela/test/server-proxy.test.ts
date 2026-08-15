/**
 * Acceptance tests for the screen's own HTTP server (AT1–AT5).
 *
 * The screen serves its own page and forwards `/v1/*` to the control plane, so
 * the browser only ever talks same-origin. That is what keeps D11 true without
 * CORS in the core: the screen stays one more HTTP client of the public API,
 * never a second writer (D1).
 *
 * Every test here runs against a fake upstream in memory. The screen has no
 * database, no core import and no fixture — the only thing worth proving is
 * that what goes in comes out unchanged, and that an upstream that is down
 * becomes an answer instead of a stack trace.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import test from 'node:test';

import type * as ProxyModule from '../src/proxy.ts';
import type * as ScreenServerModule from '../src/server.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'server.ts');
const PROXY_PATH = path.join(PACKAGE_ROOT, 'src', 'proxy.ts');

/** Minimal shape of the test context this file uses (same idiom as the core). */
interface Cleanup {
  after: (fn: () => void | Promise<void>) => void;
}

let cache: typeof ScreenServerModule | null = null;
let proxyCache: typeof ProxyModule | null = null;

async function loadServer(): Promise<typeof ScreenServerModule> {
  assert.ok(existsSync(SERVER_PATH), 'artifact does not exist yet: packages/tela/src/server.ts');
  cache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ScreenServerModule;
  return cache;
}

async function loadProxy(): Promise<typeof ProxyModule> {
  assert.ok(existsSync(PROXY_PATH), 'artifact does not exist yet: packages/tela/src/proxy.ts');
  proxyCache ??= (await import(
    new URL('../src/proxy.ts', import.meta.url).href
  )) as typeof ProxyModule;
  return proxyCache;
}

/** A port nothing is listening on: reserved by the OS, then released. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not reserve a free port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** What the fake control plane saw — the assertion surface of AT1 and AT2. */
interface RecordedRequest {
  method: string;
  target: string;
  contentType: string | undefined;
  /** The credential the screen presented, if it presented one (t124, FR7). */
  authorization: string | undefined;
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
        authorization: request.headers.authorization,
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
  const { startScreen } = await loadServer();
  const screen = await startScreen({ CARTOGRAFO_TELA_PORT: '0', ...env });
  t.after(async () => {
    await screen.close();
  });
  return screen;
}

test('AT1 — GET /v1/proposals reaches CARTOGRAFO_URL and comes back body and status verbatim', async (t) => {
  const listBody = '{"propostas":[{"id":1,"status":"pendente"},{"id":2,"status":"aplicada"}]}';
  const conflictBody = '{"erro":"proposta_nao_pendente","status":"aplicada"}';

  const upstream = await startFakeUpstream(t, (request, response) => {
    if (request.target.startsWith('/v1/proposals?')) {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(listBody);
      return;
    }
    response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
    response.end(conflictBody);
  });

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const list = await fetch(`${screen.url}/v1/proposals?status=pendente`);
  assert.equal(list.status, 200);
  assert.equal(await list.text(), listBody);
  assert.match(list.headers.get('content-type') ?? '', /^application\/json/);

  // A non-2xx from the core is an answer, not an error the proxy may reshape.
  const conflict = await fetch(`${screen.url}/v1/proposals/9/apply`, { method: 'POST' });
  assert.equal(conflict.status, 409);
  assert.equal(await conflict.text(), conflictBody);

  assert.deepEqual(
    upstream.requests.map((request) => `${request.method} ${request.target}`),
    ['GET /v1/proposals?status=pendente', 'POST /v1/proposals/9/apply'],
    'the query string is part of the request: filtering by status happens upstream',
  );
});

test('AT2 — POST /v1/proposals/:id/approve forwards method, body and content-type unchanged', async (t) => {
  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"proposta":{"id":7,"status":"aprovada"}}');
  });

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const body = JSON.stringify({ motivo: 'métrica esperada não é observável' });
  const response = await fetch(`${screen.url}/v1/proposals/7/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"proposta":{"id":7,"status":"aprovada"}}');

  assert.equal(upstream.requests.length, 1);
  const [forwarded] = upstream.requests;
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.target, '/v1/proposals/7/approve');
  assert.match(forwarded.contentType ?? '', /^application\/json/);
  assert.equal(forwarded.body, body, 'the body travels byte for byte, accents included');
});

test('AT3 — a path outside /v1/* is served from the static page, not proxied', async (t) => {
  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('o upstream nunca deveria ver isto');
  });

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const page = await fetch(`${screen.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);

  const html = await page.text();
  assert.match(html, /<html/i);
  assert.match(html, /Pendentes/);
  assert.match(html, /Histórico/);

  // The page is useless without its module; serving it is part of the same job.
  const script = await fetch(`${screen.url}/inbox.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);

  assert.deepEqual(upstream.requests, [], 'static paths never touch the control plane');
});

test('AT4 — the screen listens on CARTOGRAFO_TELA_PORT, and on 4318 when it is unset', async (t) => {
  const { resolveScreenPort, DEFAULT_SCREEN_PORT, SCREEN_PORT_ENV } = await loadServer();

  assert.equal(SCREEN_PORT_ENV, 'CARTOGRAFO_TELA_PORT');
  assert.equal(DEFAULT_SCREEN_PORT, 4318);
  // The default is asserted on the resolver, not by binding 4318 for real: a
  // test that grabs the product's default port fails for the wrong reason the
  // day someone leaves the screen running next to it.
  assert.equal(resolveScreenPort({}), 4318);
  assert.equal(resolveScreenPort({ CARTOGRAFO_TELA_PORT: '5099' }), 5099);
  assert.equal(resolveScreenPort({ CARTOGRAFO_TELA_PORT: '  ' }), 4318);
  assert.throws(
    () => resolveScreenPort({ CARTOGRAFO_TELA_PORT: 'não é porta' }),
    /CARTOGRAFO_TELA_PORT/,
  );

  const port = await freePort();
  const screen = await startScreenFor(t, {
    CARTOGRAFO_TELA_PORT: String(port),
    CARTOGRAFO_URL: 'http://127.0.0.1:4317',
  });

  assert.equal(screen.port, port);
  assert.equal(new URL(screen.url).port, String(port));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

test('t124 AT — the screen presents its service credential on every call it makes upstream', async (t) => {
  const upstream = await startFakeUpstream(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(request.target.startsWith('/v1/jobs') ? '{"trabalhos":[]}' : '{"propostas":[]}');
  });

  const screen = await startScreenFor(t, {
    CARTOGRAFO_URL: upstream.url,
    CARTOGRAFO_TELA_TOKEN: 'token-de-servico-da-tela',
  });

  // 1. The verbatim `/v1/*` passthrough, with the browser sending nothing.
  const proxied = await fetch(`${screen.url}/v1/proposals?status=pendente`);
  assert.equal(proxied.status, 200);

  // 2. A server-rendered page, whose API calls do not pass through the proxy at
  //    all — they are the screen's own `ApiClient`, and they need the token too.
  const board = await fetch(`${screen.url}/quadro`);
  assert.equal(board.status, 200, 'the board renders against an authenticated control plane');
  assert.match(board.headers.get('content-type') ?? '', /^text\/html/);

  assert.ok(upstream.requests.length >= 2, 'both halves of the screen reached the control plane');
  for (const request of upstream.requests) {
    assert.equal(
      request.authorization,
      'Bearer token-de-servico-da-tela',
      `${request.method} ${request.target} went upstream without the credential`,
    );
  }

  // The browser side is unchanged (D11): it presented no credential and still
  // got both answers. The screen is a client that HOLDS a token, not a second
  // authentication boundary that DEMANDS one.
  assert.equal(proxied.status, 200);
});

test('t124 AT — CARTOGRAFO_TOKEN is the fallback, and the browser cannot swap the credential', async (t) => {
  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end('{"propostas":[]}');
  });

  const shared = await startScreenFor(t, {
    CARTOGRAFO_URL: upstream.url,
    CARTOGRAFO_TOKEN: 'token-compartilhado',
  });

  await fetch(`${shared.url}/v1/proposals`, {
    headers: { authorization: 'Bearer token-que-o-navegador-inventou' },
  });

  assert.equal(upstream.requests.length, 1);
  assert.equal(
    upstream.requests[0].authorization,
    'Bearer token-compartilhado',
    'with CARTOGRAFO_TELA_TOKEN unset the screen falls back to CARTOGRAFO_TOKEN, and what the browser sent is replaced, never forwarded',
  );
});

test('AT5 — an unreachable control plane becomes 502 control_plane_indisponivel, never a stack trace', async (t) => {
  const deadPort = await freePort();
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: `http://127.0.0.1:${deadPort}` });

  const response = await fetch(`${screen.url}/v1/proposals`);
  assert.equal(response.status, 502);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);

  const body = (await response.json()) as { erro: string; mensagem: string };
  assert.equal(body.erro, 'control_plane_indisponivel');
  assert.ok(
    body.mensagem.includes(`127.0.0.1:${deadPort}`),
    'the message says which address did not answer',
  );
  assert.doesNotMatch(body.mensagem, /\n\s*at |Error:|ECONNREFUSED/);
});

/* -------------------------------------------------------------------------- */
/* t180 — the two surfaces of the screen that are API plumbing, not UI copy.   */
/*                                                                            */
/* t133's decision stands whole: the screen RENDERS its pages in Portuguese on */
/* purpose, and the wire vocabulary it reads (`erro`, `mensagem`, `pendente`)  */
/* is frozen. What moves here is the prose of the two failures the screen      */
/* answers by itself, which a person meets as an API body and not as a page.   */
/* -------------------------------------------------------------------------- */

test('t180 — the 502 and the static 404 keep their shape and say it in English', async (t) => {
  const { unavailableResponse } = await loadProxy();

  const down = unavailableResponse('http://127.0.0.1:4317');
  assert.equal(down.status, 502);
  const body = JSON.parse(down.body.toString('utf8')) as { erro: string; mensagem: string };
  assert.equal(body.erro, 'control_plane_indisponivel', 'the code is frozen');
  assert.equal(
    body.mensagem,
    'could not reach the control plane at http://127.0.0.1:4317 — run `npx cartografo` first (or point somewhere else with CARTOGRAFO_URL)',
  );

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: 'http://127.0.0.1:4317' });
  const missing = await fetch(`${screen.url}/nao-existe.js`);
  assert.equal(missing.status, 404);
  const notFound = (await missing.json()) as { erro: string; mensagem: string };
  assert.equal(notFound.erro, 'arquivo_nao_encontrado', 'the code is frozen');
  assert.equal(notFound.mensagem, 'the screen does not serve "/nao-existe.js"');
});

test('t180 — a bad configuration fails at startup in English', async () => {
  const { parsePortFromEnv, resolveControlPlaneUrl, CONTROL_PLANE_URL_ENV } = await loadProxy();

  assert.throws(
    () => parsePortFromEnv({ CARTOGRAFO_PORT: 'não é porta' }, 'CARTOGRAFO_PORT', 4317),
    { message: 'CARTOGRAFO_PORT invalid: "não é porta" (expected an integer from 0 to 65535)' },
  );

  assert.throws(
    () => resolveControlPlaneUrl({ [CONTROL_PLANE_URL_ENV]: 'nem url é' }),
    { message: 'CARTOGRAFO_URL invalid: "nem url é" (expected something like http://127.0.0.1:4317)' },
  );

  assert.throws(
    () => resolveControlPlaneUrl({ [CONTROL_PLANE_URL_ENV]: 'ftp://127.0.0.1:4317' }),
    { message: 'CARTOGRAFO_URL has to be http or https: "ftp://127.0.0.1:4317"' },
  );
});
