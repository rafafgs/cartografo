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
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import type * as ProxyModule from '../src/proxy.ts';
import type * as RouterModule from '../src/router.ts';
import type * as ScreenServerModule from '../src/server.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'server.ts');
const PROXY_PATH = path.join(PACKAGE_ROOT, 'src', 'proxy.ts');
const ROUTER_PATH = path.join(PACKAGE_ROOT, 'src', 'router.ts');

/** The command that actually ships — what `npm start` and `npx` both run. */
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'screen.mjs');

/** Minimal shape of the test context this file uses (same idiom as the core). */
interface Cleanup {
  after: (fn: () => void | Promise<void>) => void;
}

let cache: typeof ScreenServerModule | null = null;
let proxyCache: typeof ProxyModule | null = null;
let routerCache: typeof RouterModule | null = null;

async function loadServer(): Promise<typeof ScreenServerModule> {
  assert.ok(existsSync(SERVER_PATH), 'artifact does not exist yet: packages/screen/src/server.ts');
  cache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ScreenServerModule;
  return cache;
}

async function loadProxy(): Promise<typeof ProxyModule> {
  assert.ok(existsSync(PROXY_PATH), 'artifact does not exist yet: packages/screen/src/proxy.ts');
  proxyCache ??= (await import(
    new URL('../src/proxy.ts', import.meta.url).href
  )) as typeof ProxyModule;
  return proxyCache;
}

async function loadRouter(): Promise<typeof RouterModule> {
  assert.ok(existsSync(ROUTER_PATH), 'artifact does not exist yet: packages/screen/src/router.ts');
  routerCache ??= (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;
  return routerCache;
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
  const screen = await startScreen({ CARTOGRAFO_SCREEN_PORT: '0', ...env });
  t.after(async () => {
    await screen.close();
  });
  return screen;
}

test('AT1 — GET /v1/proposals reaches CARTOGRAFO_URL and comes back body and status verbatim', async (t) => {
  const listBody = '{"proposals":[{"id":1,"status":"pending"},{"id":2,"status":"applied"}]}';
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

  const body = JSON.stringify({ reason: 'métrica esperada não é observável' });
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

test('AT4 — the screen listens on CARTOGRAFO_SCREEN_PORT, and on 4318 when it is unset', async (t) => {
  const { resolveScreenPort, DEFAULT_SCREEN_PORT, SCREEN_PORT_ENV } = await loadServer();

  assert.equal(SCREEN_PORT_ENV, 'CARTOGRAFO_SCREEN_PORT');
  assert.equal(DEFAULT_SCREEN_PORT, 4318);
  // The default is asserted on the resolver, not by binding 4318 for real: a
  // test that grabs the product's default port fails for the wrong reason the
  // day someone leaves the screen running next to it.
  assert.equal(resolveScreenPort({}), 4318);
  assert.equal(resolveScreenPort({ CARTOGRAFO_SCREEN_PORT: '5099' }), 5099);
  assert.equal(resolveScreenPort({ CARTOGRAFO_SCREEN_PORT: '  ' }), 4318);
  assert.throws(
    () => resolveScreenPort({ CARTOGRAFO_SCREEN_PORT: 'não é porta' }),
    /CARTOGRAFO_SCREEN_PORT/,
  );

  const port = await freePort();
  const screen = await startScreenFor(t, {
    CARTOGRAFO_SCREEN_PORT: String(port),
    CARTOGRAFO_URL: 'http://127.0.0.1:4317',
  });

  assert.equal(screen.port, port);
  assert.equal(new URL(screen.url).port, String(port));
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
});

test('t124 AT — the screen presents its service credential on every call it makes upstream', async (t) => {
  const upstream = await startFakeUpstream(t, (request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(request.target.startsWith('/v1/jobs') ? '{"jobs":[]}' : '{"proposals":[]}');
  });

  const screen = await startScreenFor(t, {
    CARTOGRAFO_URL: upstream.url,
    CARTOGRAFO_SCREEN_TOKEN: 'token-de-servico-da-tela',
  });

  // 1. The verbatim `/v1/*` passthrough, with the browser sending nothing.
  const proxied = await fetch(`${screen.url}/v1/proposals?status=pendente`);
  assert.equal(proxied.status, 200);

  // 2. A server-rendered page, whose API calls do not pass through the proxy at
  //    all — they are the screen's own `ApiClient`, and they need the token too.
  const board = await fetch(`${screen.url}/board`);
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
    response.end('{"proposals":[]}');
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
    'with CARTOGRAFO_SCREEN_TOKEN unset the screen falls back to CARTOGRAFO_TOKEN, and what the browser sent is replaced, never forwarded',
  );
});

test('AT5 — an unreachable control plane becomes 502 control_plane_unavailable, never a stack trace', async (t) => {
  const deadPort = await freePort();
  const screen = await startScreenFor(t, { CARTOGRAFO_URL: `http://127.0.0.1:${deadPort}` });

  const response = await fetch(`${screen.url}/v1/proposals`);
  assert.equal(response.status, 502);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);

  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, 'control_plane_unavailable');
  assert.ok(
    body.message.includes(`127.0.0.1:${deadPort}`),
    'the message says which address did not answer',
  );
  assert.doesNotMatch(body.message, /\n\s*at |Error:|ECONNREFUSED/);
});

/* -------------------------------------------------------------------------- */
/* t180 — the two surfaces of the screen that are API plumbing, not UI copy.   */
/*                                                                            */
/* t133's decision stands whole: the screen RENDERS its pages in Portuguese on */
/* purpose. What moves here is the prose of the two failures the screen        */
/* answers by itself, which a person meets as an API body and not as a page.   */
/*                                                                            */
/* Their ENVELOPE moved later, in t255: the core's converged on               */
/* `{error, message}` with t226 and this proxy went on answering               */
/* `{erro, mensagem}` for four more tickets, which is why `messageOf()` in     */
/* `public/inbox.js` reads both and shows "falha 502" when it hits this one.   */
/* -------------------------------------------------------------------------- */

test('t180 — the 502 and the static 404 keep their shape and say it in English', async (t) => {
  const { unavailableResponse } = await loadProxy();

  const down = unavailableResponse('http://127.0.0.1:4317');
  assert.equal(down.status, 502);
  const body = JSON.parse(down.body.toString('utf8')) as { error: string; message: string };
  assert.equal(body.error, 'control_plane_unavailable', 'the code is the wire’s since t255');
  assert.equal(
    body.message,
    'could not reach the control plane at http://127.0.0.1:4317 — run `npx cartografo` first (or point somewhere else with CARTOGRAFO_URL)',
  );

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: 'http://127.0.0.1:4317' });
  const missing = await fetch(`${screen.url}/nao-existe.js`);
  assert.equal(missing.status, 404);
  const notFound = (await missing.json()) as { error: string; message: string };
  assert.equal(notFound.error, 'file_not_found', 'the code is the wire’s since t255');
  assert.equal(notFound.message, 'the screen does not serve "/nao-existe.js"');
});

test('t255 — every body this proxy invents is the core’s {error, message} envelope', async () => {
  const {
    unavailableResponse,
    untrustedOriginResponse,
    bodyTooLargeResponse,
    UPSTREAM_DOWN_CODE,
    UNTRUSTED_ORIGIN_CODE,
    BODY_TOO_LARGE_CODE,
  } = await loadProxy();
  // The static 404 is the fourth body this package invents, and it is the same
  // claim; `static.ts` is loaded here rather than mirrored into its own suite.
  const staticPath = path.join(PACKAGE_ROOT, 'src', 'static.ts');
  assert.ok(existsSync(staticPath), 'artifact does not exist yet: packages/screen/src/static.ts');
  const { serveStatic } = (await import(new URL('../src/static.ts', import.meta.url).href)) as {
    serveStatic: (pathname: string) => Promise<{ status: number; body: Buffer }>;
  };

  assert.equal(UPSTREAM_DOWN_CODE, 'control_plane_unavailable');
  assert.equal(UNTRUSTED_ORIGIN_CODE, 'untrusted_origin');
  assert.equal(BODY_TOO_LARGE_CODE, 'body_too_large');

  const invented = [
    unavailableResponse('http://127.0.0.1:4317'),
    untrustedOriginResponse(),
    bodyTooLargeResponse(1024),
    await serveStatic('/nao-existe.js'),
  ];

  for (const response of invented) {
    const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(body).sort(),
      ['error', 'message'],
      `this proxy still answers a shape the page cannot read: ${JSON.stringify(body)}`,
    );
    assert.equal(typeof body.error, 'string');
    assert.ok(String(body.message).length > 0, 'a refusal that says nothing is not a refusal');
  }
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

/* -------------------------------------------------------------------------- */
/* t199 (FR6) — one resolver, and it is the one the shipped command runs.      */
/*                                                                            */
/* Until this ticket the package had TWO address resolvers: this one, honoring */
/* `CARTOGRAFO_PORT` and pinned by the test above, and `router.ts`'s           */
/* `resolveControlPlaneAddress`, which ignored `CARTOGRAFO_PORT`, spoke        */
/* Portuguese and was the one `bin/screen.mjs` actually reached. The well-tested */
/* path was the one that did not ship. So the assertions below go through the  */
/* PROCESS — `bin/screen.mjs`, what `npm start` and `npx cartografo-screen` run —  */
/* and not through an import that could once again prove the wrong function.   */
/* -------------------------------------------------------------------------- */

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, stdout/stderr both read. */
type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

/** The readiness line the screen prints when it comes up. */
interface ReadinessLine {
  event: string;
  url: string;
  controlPlane: string;
}

/** One run of the command: how it ended, or how it announced itself. */
interface ScreenRun {
  code: number | null;
  stdout: string;
  stderr: string;
  readiness: ReadinessLine | null;
}

/**
 * Runs `bin/screen.mjs` and waits for the readiness line — or for it to give up.
 *
 * The ambient configuration is stripped first: whoever runs the suite may have
 * `CARTOGRAFO_URL` exported in their own shell, and a test about precedence
 * must not be decided by it.
 *
 * @param options Command line arguments and the environment to run under.
 * @returns Exit code, output and the readiness line, when there was one.
 */
async function runScreenBin(options: {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<ScreenRun> {
  assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/screen/bin/screen.mjs');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CARTOGRAFO_URL;
  delete env.CARTOGRAFO_PORT;
  delete env.CARTOGRAFO_SCREEN_PORT;
  delete env.CARTOGRAFO_SCREEN_TOKEN;
  delete env.CARTOGRAFO_TOKEN;
  Object.assign(env, options.env ?? {});

  const child: CommandChild = spawn(process.execPath, [BIN_PATH, ...(options.args ?? [])], {
    cwd: PACKAGE_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const ended = new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const line = stdout
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{'));
    if (line !== undefined) {
      const readiness = JSON.parse(line) as ReadinessLine;
      child.kill('SIGTERM');
      const code = await ended;
      return { code, stdout, stderr, readiness };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: await ended, stdout, stderr, readiness: null };
    }
    await wait(50);
  }

  child.kill('SIGKILL');
  await ended;
  throw new Error(`the screen neither started nor failed in 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

test('t199 AT — the shipped command honors CARTOGRAFO_PORT when CARTOGRAFO_URL is unset', { timeout: 120_000 }, async () => {
  const controlPlanePort = await freePort();

  const run = await runScreenBin({
    env: { CARTOGRAFO_PORT: String(controlPlanePort), CARTOGRAFO_SCREEN_PORT: '0' },
  });

  assert.ok(run.readiness, `the screen did not announce itself:\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.readiness.event, 'cartografo.tela.ready');
  assert.equal(
    run.readiness.controlPlane,
    `http://127.0.0.1:${controlPlanePort}`,
    'the precedence docs/spec/screen-proposal-inbox.md promises is the one the bin applies',
  );
});

test('t199 AT — --url wins over the environment, through the same command', { timeout: 120_000 }, async () => {
  const fromEnv = await freePort();
  const fromFlag = await freePort();

  const run = await runScreenBin({
    args: ['--url', `http://127.0.0.1:${fromFlag}/`],
    env: { CARTOGRAFO_URL: `http://127.0.0.1:${fromEnv}`, CARTOGRAFO_SCREEN_PORT: '0' },
  });

  assert.ok(run.readiness, `the screen did not announce itself:\n${run.stdout}\n${run.stderr}`);
  assert.equal(
    run.readiness.controlPlane,
    `http://127.0.0.1:${fromFlag}`,
    'an explicit --url beats CARTOGRAFO_URL, and the trailing slash is trimmed either way',
  );
});

test('t199 AT — a bad --url and a bad CARTOGRAFO_SCREEN_PORT both fail in English', { timeout: 120_000 }, async () => {
  const badUrl = await runScreenBin({
    args: ['--url', 'nem url é'],
    env: { CARTOGRAFO_SCREEN_PORT: '0' },
  });
  assert.equal(badUrl.readiness, null, 'a screen pointed at nothing must not come up');
  assert.notEqual(badUrl.code, 0);
  assert.match(badUrl.stderr, /invalid/);
  assert.doesNotMatch(badUrl.stderr, /inválida|esperado|precisa ser/);

  const badPort = await runScreenBin({
    env: { CARTOGRAFO_SCREEN_PORT: 'não é porta' },
  });
  assert.equal(badPort.readiness, null);
  assert.notEqual(badPort.code, 0);
  assert.match(badPort.stderr, /CARTOGRAFO_SCREEN_PORT invalid/);
  assert.doesNotMatch(badPort.stderr, /inválida|esperado um inteiro/);
});

/* -------------------------------------------------------------------------- */
/* t206 — the ceiling on what the screen will hold for somebody else's API.    */
/*                                                                            */
/* The proxy buffers a `/v1/*` body whole before it forwards it, because it    */
/* forwards bytes and not a stream. Without a ceiling, anything that reaches   */
/* this loopback port decides how much memory the screen spends, and the       */
/* control plane never even learns it was asked. The ceiling matches Fastify's */
/* own default (1 MiB), so it refuses nothing the core would have accepted     */
/* through a door this screen's page can reach.                               */
/* -------------------------------------------------------------------------- */

/**
 * Sends a `/v1/*` POST of `size` bytes over a raw socket and waits for the end.
 *
 * Raw, and not `fetch`, because the assertion is about the CONNECTION: `fetch`
 * hands back a response and says nothing about whether the socket under it
 * survived, which is the whole of what `connection: close` promises.
 *
 * The body goes out in two writes with a pause between them so that the byte
 * crossing the ceiling is the last one on the wire. That is not cosmetic: the
 * screen answers and hangs up without draining what it did not read, and a
 * socket closed with bytes still unread is reset rather than finished — which
 * on a much bigger body can throw away the very answer it is sending.
 *
 * @param port Screen port.
 * @param size Body size in bytes, announced honestly in `Content-Length`.
 * @returns Everything read back, and whether the screen hung up.
 */
async function postRawBody(
  port: number,
  size: number,
  timeoutMs = 5_000,
): Promise<{ data: string; closed: boolean }> {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve();
    });
    socket.once('error', reject);
  });

  const ended = new Promise<boolean>((resolve) => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    socket.on('close', () => finish(true));
    // Writing into a socket the screen already hung up on is the expected end of
    // this exchange, not a failure of it.
    socket.on('error', () => finish(true));
  });

  socket.write(
    [
      'POST /v1/algum-caminho HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Content-Type: application/json',
      `Content-Length: ${size}`,
      '',
      '',
    ].join('\r\n'),
  );
  socket.write('a'.repeat(size - 1));
  await wait(150);
  socket.write('a');

  const closed = await ended;
  socket.destroy();
  return { data, closed };
}

test('AT6 — a /v1 body past PROXY_BODY_LIMIT is refused with 413, and never forwarded', async (t) => {
  const { PROXY_BODY_LIMIT } = await loadRouter();
  assert.equal(PROXY_BODY_LIMIT, 1_048_576, 'the ceiling is Fastify’s own default, in bytes');

  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"o upstream nunca deveria ver isto":true}');
  });

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const refused = await fetch(`${screen.url}/v1/algum-caminho`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'a'.repeat(PROXY_BODY_LIMIT + 1),
  });

  assert.equal(refused.status, 413);
  assert.match(refused.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(
    refused.headers.get('connection'),
    'close',
    'what was not read must not be parsed as the next request on a kept-alive socket',
  );

  const body = (await refused.json()) as { error: string; message: string };
  assert.equal(body.error, 'body_too_large', 'the code is English, like its two siblings');
  assert.ok(
    body.message.includes(String(PROXY_BODY_LIMIT)),
    `the message has to name the ceiling that was crossed, got: ${body.message}`,
  );
  assert.doesNotMatch(
    body.message,
    /[áâãàçéêíóôõú]/i,
    'this body is API plumbing, and t180 keeps that in English',
  );

  // The header above is a promise about the connection; this is the connection
  // keeping it.
  const raw = await postRawBody(screen.port, PROXY_BODY_LIMIT + 1);
  assert.match(raw.data, /^HTTP\/1\.1 413 /);
  assert.ok(raw.closed, 'the screen hangs up instead of holding a socket it stopped reading');

  assert.deepEqual(upstream.requests, [], 'a body the screen refuses never reaches the control plane');
});

test('AT7 — a /v1 body of exactly PROXY_BODY_LIMIT bytes still goes through, whole', async (t) => {
  const { PROXY_BODY_LIMIT } = await loadRouter();

  const upstream = await startFakeUpstream(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"aceito":true}');
  });

  const screen = await startScreenFor(t, { CARTOGRAFO_URL: upstream.url });

  const body = 'a'.repeat(PROXY_BODY_LIMIT);
  const accepted = await fetch(`${screen.url}/v1/algum-caminho`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), '{"aceito":true}');

  assert.equal(upstream.requests.length, 1, 'the body at the ceiling is forwarded, not refused');
  assert.equal(
    upstream.requests[0].body.length,
    PROXY_BODY_LIMIT,
    'the ceiling is a ceiling, not a ceiling minus one',
  );
  assert.equal(upstream.requests[0].body, body, 'and it crosses whole, not truncated to the ceiling');
});

test('t199 AT — the surviving resolver takes the explicit override as its first choice', async () => {
  const { resolveControlPlaneUrl, CONTROL_PLANE_URL_ENV, CONTROL_PLANE_PORT_ENV } =
    await loadProxy();

  assert.equal(
    resolveControlPlaneUrl({ [CONTROL_PLANE_URL_ENV]: 'http://127.0.0.1:4317' }, 'http://10.0.0.2:9000'),
    'http://10.0.0.2:9000',
  );
  assert.equal(
    resolveControlPlaneUrl({ [CONTROL_PLANE_PORT_ENV]: '5099' }),
    'http://127.0.0.1:5099',
  );
  // Blank is not a choice: `--url` absent and `--url ""` mean the same thing.
  assert.equal(resolveControlPlaneUrl({ [CONTROL_PLANE_PORT_ENV]: '5099' }, '  '), 'http://127.0.0.1:5099');
  assert.throws(() => resolveControlPlaneUrl({}, 'nem url é'), {
    message: '--url invalid: "nem url é" (expected something like http://127.0.0.1:4317)',
  });
  assert.throws(() => resolveControlPlaneUrl({}, 'ftp://127.0.0.1:4317'), {
    message: '--url has to be http or https: "ftp://127.0.0.1:4317"',
  });
});
