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
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import type * as ProxyModule from '../src/proxy.ts';
import type * as ScreenServerModule from '../src/server.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'server.ts');
const PROXY_PATH = path.join(PACKAGE_ROOT, 'src', 'proxy.ts');

/** The command that actually ships — what `npm start` and `npx` both run. */
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'tela.mjs');

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

/* -------------------------------------------------------------------------- */
/* t199 (FR6) — one resolver, and it is the one the shipped command runs.      */
/*                                                                            */
/* Until this ticket the package had TWO address resolvers: this one, honoring */
/* `CARTOGRAFO_PORT` and pinned by the test above, and `router.ts`'s           */
/* `resolveControlPlaneAddress`, which ignored `CARTOGRAFO_PORT`, spoke        */
/* Portuguese and was the one `bin/tela.mjs` actually reached. The well-tested */
/* path was the one that did not ship. So the assertions below go through the  */
/* PROCESS — `bin/tela.mjs`, what `npm start` and `npx cartografo-tela` run —  */
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
 * Runs `bin/tela.mjs` and waits for the readiness line — or for it to give up.
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
  assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/tela/bin/tela.mjs');

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CARTOGRAFO_URL;
  delete env.CARTOGRAFO_PORT;
  delete env.CARTOGRAFO_TELA_PORT;
  delete env.CARTOGRAFO_TELA_TOKEN;
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
    env: { CARTOGRAFO_PORT: String(controlPlanePort), CARTOGRAFO_TELA_PORT: '0' },
  });

  assert.ok(run.readiness, `the screen did not announce itself:\n${run.stdout}\n${run.stderr}`);
  assert.equal(run.readiness.event, 'cartografo.tela.ready');
  assert.equal(
    run.readiness.controlPlane,
    `http://127.0.0.1:${controlPlanePort}`,
    'the precedence docs/spec/tela-inbox-propostas.md promises is the one the bin applies',
  );
});

test('t199 AT — --url wins over the environment, through the same command', { timeout: 120_000 }, async () => {
  const fromEnv = await freePort();
  const fromFlag = await freePort();

  const run = await runScreenBin({
    args: ['--url', `http://127.0.0.1:${fromFlag}/`],
    env: { CARTOGRAFO_URL: `http://127.0.0.1:${fromEnv}`, CARTOGRAFO_TELA_PORT: '0' },
  });

  assert.ok(run.readiness, `the screen did not announce itself:\n${run.stdout}\n${run.stderr}`);
  assert.equal(
    run.readiness.controlPlane,
    `http://127.0.0.1:${fromFlag}`,
    'an explicit --url beats CARTOGRAFO_URL, and the trailing slash is trimmed either way',
  );
});

test('t199 AT — a bad --url and a bad CARTOGRAFO_TELA_PORT both fail in English', { timeout: 120_000 }, async () => {
  const badUrl = await runScreenBin({
    args: ['--url', 'nem url é'],
    env: { CARTOGRAFO_TELA_PORT: '0' },
  });
  assert.equal(badUrl.readiness, null, 'a screen pointed at nothing must not come up');
  assert.notEqual(badUrl.code, 0);
  assert.match(badUrl.stderr, /invalid/);
  assert.doesNotMatch(badUrl.stderr, /inválida|esperado|precisa ser/);

  const badPort = await runScreenBin({
    env: { CARTOGRAFO_TELA_PORT: 'não é porta' },
  });
  assert.equal(badPort.readiness, null);
  assert.notEqual(badPort.code, 0);
  assert.match(badPort.stderr, /CARTOGRAFO_TELA_PORT invalid/);
  assert.doesNotMatch(badPort.stderr, /inválida|esperado um inteiro/);
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
