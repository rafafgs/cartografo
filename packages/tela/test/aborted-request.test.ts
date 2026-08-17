/**
 * t151 — a client that goes away must not take the whole screen down.
 *
 * `createScreenRouter` runs every request inside a floating `void (async …)()`.
 * A rejection in there reaches nobody, and since Node 15 an unhandled rejection
 * kills the process — so ONE browser tab dropping an upload mid-body would take
 * both halves of D11 down with it, for every other tab.
 *
 * The failure is reproduced here with a raw `node:net` socket, and not with
 * `fetch` plus an `AbortController`: what has to happen is a body that STOPS
 * arriving after the server was promised more (`Content-Length` bigger than
 * what is written, then the socket dies), and that is the one thing `fetch`
 * does not do reliably.
 *
 * The spy shape — collect into an array, assert the array stayed empty — is the
 * one `packages/core/test/events-stream.test.ts` (AT8) already proved for
 * `uncaughtException`; here it watches `unhandledRejection`, because the
 * failure mode is a rejected promise and not a thrown error.
 *
 * Every string below that names a route or a wire field keeps its Portuguese
 * spelling: those are the product's own surface (t133, exceptions 9 and 10).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import type * as RouterModule from '../src/router.ts';
import type * as ScreenServerModule from '../src/server.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_PATH = path.join(PACKAGE_ROOT, 'src', 'router.ts');
const SERVER_PATH = path.join(PACKAGE_ROOT, 'src', 'server.ts');

/** Minimal shape of the test context the helpers here need. */
interface Cleanup {
  after: (fn: () => void | Promise<void>) => void;
}

let routerCache: typeof RouterModule | null = null;
let serverCache: typeof ScreenServerModule | null = null;

async function loadRouter(): Promise<typeof RouterModule> {
  assert.ok(existsSync(ROUTER_PATH), 'artifact does not exist yet: packages/tela/src/router.ts');
  routerCache ??= (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;
  return routerCache;
}

async function loadServer(): Promise<typeof ScreenServerModule> {
  assert.ok(existsSync(SERVER_PATH), 'artifact does not exist yet: packages/tela/src/server.ts');
  serverCache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ScreenServerModule;
  return serverCache;
}

/**
 * A control plane that answers whatever the rendered views ask of it.
 *
 * Same fake as `server-proxy.test.ts` uses: enough for `/quadro` to render a
 * real 200 after the abort, which is the whole point of AT2.
 */
async function startFakeUpstream(t: Cleanup): Promise<string> {
  const server = createServer((request, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end((request.url ?? '').startsWith('/v1/jobs') ? '{"jobs":[]}' : '{"proposals":[]}');
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

  return `http://127.0.0.1:${port}`;
}

/** The screen, in process, on a port the system picks. */
async function startScreenFor(t: Cleanup): Promise<ScreenServerModule.Screen> {
  const controlPlaneUrl = await startFakeUpstream(t);
  const { startScreen } = await loadServer();
  const screen = await startScreen({
    CARTOGRAFO_TELA_PORT: '0',
    CARTOGRAFO_URL: controlPlaneUrl,
  });
  t.after(async () => {
    await screen.close();
  });
  return screen;
}

/**
 * Everything written to stderr while the test runs.
 *
 * The abort itself is invisible over HTTP — the socket that would receive the
 * answer is exactly the one that died — so the log is the only place the screen
 * can say WHICH failure it survived, and the only observable difference between
 * "labelled and handled" and "swallowed by whichever `catch` happened to be
 * closest".
 */
function watchStderr(t: Cleanup): string[] {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    written.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
  return written;
}

/** Everything Node would have crashed on, collected instead of thrown. */
function watchUnhandledRejections(t: Cleanup): unknown[] {
  const collected: unknown[] = [];
  const collect = (reason: unknown): void => {
    collected.push(reason);
  };
  process.on('unhandledRejection', collect);
  t.after(() => {
    process.off('unhandledRejection', collect);
  });
  return collected;
}

/** Renders what was collected, so a failure says WHAT crashed the screen. */
function describeCollected(collected: unknown[]): string {
  return collected
    .map((reason) => (reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)))
    .join('; ');
}

/**
 * Promises a body, writes part of it, and kills the socket.
 *
 * The `Content-Length` is the lie that matters: the server is still inside its
 * `for await` waiting for the rest when the connection disappears.
 */
async function abortMidBody(port: number, target: string, contentType: string): Promise<void> {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(
    [
      `POST ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Content-Type: ${contentType}`,
      'Content-Length: 4096',
      '',
      'resposta=metade+do+que+prometi',
    ].join('\r\n'),
  );

  // Long enough for the handler to be reading the body when the socket dies.
  await wait(60);
  socket.destroy();
  await wait(200);
}

/** What one raw exchange produced: an answer, a closed socket, or nothing. */
interface RawExchange {
  answered: boolean;
  closed: boolean;
  data: string;
}

/** Writes a raw request and waits for an answer, a close, or the deadline. */
async function rawExchange(port: number, text: string, timeoutMs = 1500): Promise<RawExchange> {
  const socket = net.connect(port, '127.0.0.1');
  let data = '';

  return await new Promise<RawExchange>((resolve) => {
    const finish = (closed: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ answered: data !== '', closed, data });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    socket.on('close', () => finish(true));
    socket.on('error', () => finish(true));
  });
}

test('AT1 — a body that stops arriving mid-proxy leaves no unhandled rejection behind', async (t) => {
  const screen = await startScreenFor(t);
  const collected = watchUnhandledRejections(t);
  const stderr = watchStderr(t);

  await abortMidBody(screen.port, '/v1/algum-caminho', 'application/json');

  assert.deepEqual(
    collected,
    [],
    `an aborted upload must not reach the event loop unhandled: ${describeCollected(collected)}`,
  );
  assert.ok(
    stderr.some((line) => line.includes('ClientAbortedError')),
    `the abort is caught AND named, got ${JSON.stringify(stderr)}`,
  );
});

test('AT2 — the screen keeps serving the next request after a client aborted one', async (t) => {
  const screen = await startScreenFor(t);
  const collected = watchUnhandledRejections(t);

  await abortMidBody(screen.port, '/v1/algum-caminho', 'application/json');

  const board = await fetch(`${screen.url}/quadro`);
  assert.equal(board.status, 200, 'the screen survived the abort and still answers');
  assert.match(await board.text(), /<html/i);

  assert.deepEqual(collected, [], describeCollected(collected));
});

test('AT3 — the same abort against the form route leaves nothing unhandled either', async (t) => {
  const screen = await startScreenFor(t);
  const collected = watchUnhandledRejections(t);
  const stderr = watchStderr(t);

  await abortMidBody(screen.port, '/perguntas/1/resposta', 'application/x-www-form-urlencoded');

  assert.deepEqual(
    collected,
    [],
    `the form reader has the same hole as the proxy one: ${describeCollected(collected)}`,
  );
  // The form reader lives one call further in (`submitAnswer`), behind the view
  // branch's own `catch`. Without the label, that `catch` turns a dead client
  // into a 500 page written to a socket nobody is holding, and the operator
  // never learns the connection dropped.
  assert.ok(
    stderr.some((line) => line.includes('ClientAbortedError')),
    `the form reader labels the abort too, got ${JSON.stringify(stderr)}`,
  );

  const board = await fetch(`${screen.url}/quadro`);
  assert.equal(board.status, 200, 'the screen survived the aborted form too');
});

test('AT4 — a request target the URL parser refuses is answered or closed, never left hanging', async (t) => {
  const screen = await startScreenFor(t);
  const collected = watchUnhandledRejections(t);

  // `//[` is protocol-relative, so `new URL(target, 'http://tela.local')`
  // parses `[` as a host and throws — synchronously, inside the request IIFE.
  const exchange = await rawExchange(
    screen.port,
    ['GET //[ HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close', '', ''].join('\r\n'),
  );

  assert.ok(
    exchange.answered || exchange.closed,
    'a target the parser refuses must end the exchange, not leave the browser waiting',
  );
  assert.deepEqual(collected, [], describeCollected(collected));

  const board = await fetch(`${screen.url}/quadro`);
  assert.equal(board.status, 200, 'a fresh connection is still served afterwards');
});

test('AT5 — failurePage turns a ClientAbortedError into 499', async () => {
  const { ClientAbortedError, failurePage } = await loadRouter();

  const page = failurePage(new ClientAbortedError('o cliente sumiu'), 'http://example.invalid');

  assert.equal(page.status, 499, 'nginx’s "client closed request": the mapping stays total');
  assert.match(page.html, /<html/i);
});

test('AT6 — installCrashGuard logs to stderr and keeps the process alive', async (t) => {
  const { installCrashGuard } = await loadRouter();

  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    written.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  t.after(() => {
    process.stderr.write = originalWrite;
  });

  const exits: unknown[] = [];
  const originalExit = process.exit;
  process.exit = ((code?: number): void => {
    exits.push(code);
  }) as unknown as typeof process.exit;
  t.after(() => {
    process.exit = originalExit;
  });

  // The emit below reaches EVERY listener, and the test runner registers one of
  // its own that rethrows what it cannot attribute to a test — the harness, not
  // the product. So the guard is measured alone: the runner's listeners step
  // aside for this one assertion and are put back right after.
  const others = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');

  // The guard is removed again: this file starts the screen in process, and a
  // listener left behind would follow the runner into the next test file.
  const remove = installCrashGuard();
  t.after(() => {
    remove();
    for (const listener of others) {
      process.on('unhandledRejection', listener as (...args: unknown[]) => void);
    }
  });

  const settled = Promise.reject(new Error('teste')).catch(() => undefined);
  assert.doesNotThrow(() => {
    process.emit('unhandledRejection', new Error('teste'), settled);
  });
  await settled;

  assert.deepEqual(exits, [], 'the guard logs the rejection; it does not end the process');
  assert.ok(
    written.some((line) => line.includes('teste')),
    `the guard has to say what was rejected, got ${JSON.stringify(written)}`,
  );
});
