/**
 * Shared support for the MCP server's acceptance tests.
 *
 * Not a test file (the package glob is `test/*.test.ts`): it is the repeated
 * part of the end-to-end suite — start the REAL command as a child process,
 * speak JSON-RPC to it over a pipe, and take it down at the end.
 *
 * The server comes up as a CHILD PROCESS and not through an import, unlike the
 * screen's in-process router. It is not a style choice: what an MCP client
 * actually starts is `bin/mcp.mjs`, and the two things most likely to break in
 * that path — the tsx shell resolving `src/index.ts`, and stdout staying clean
 * enough to parse — exist only in a real process with real pipes. A test that
 * called `serve()` on two fake streams would prove neither.
 *
 * The control plane behind it is real too, booted by `@cartografo/test-support`
 * the way the screen's suites boot theirs (D1, D11): every check goes through
 * the public API, because that is the only surface this package has.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Root of the `packages/mcp` package. */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Root of the monorepo. */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The command an MCP client starts. */
export const MCP_BIN = path.join(PACKAGE_ROOT, 'bin', 'mcp.mjs');

/** How long a request may take before the test gives up on it. */
export const REQUEST_DEADLINE_MS = 30_000;

/** The slice of `node:test`'s `TestContext` this module uses. */
export interface TestHooks {
  after: (fn: () => void | Promise<void>) => void;
}

/** The MCP server, up, with a pipe in each direction. */
export interface McpUnderTest {
  /** Sends a request and waits for the response matching its id. */
  request: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  /** Sends a notification, which is answered with silence. */
  notify: (method: string, params?: unknown) => void;
  /** Calls one tool and returns the result object whole. */
  call: (name: string, args?: Record<string, unknown>) => Promise<{
    text: string;
    isError: boolean;
  }>;
  /** Everything the process wrote to stderr so far. */
  stderr: () => string;
}

/**
 * Fails naming the missing file, instead of letting the spawn blow up.
 *
 * @param relatives Paths relative to the root of `packages/mcp`.
 */
export function requireArtifacts(...relatives: string[]): void {
  for (const relative of relatives) {
    assert.ok(
      existsSync(path.join(PACKAGE_ROOT, relative)),
      `artifact does not exist yet: packages/mcp/${relative}`,
    );
  }
}

/**
 * Starts `cartografo-mcp` against a control plane and speaks to it.
 *
 * @param t Test context, so the process is taken down at the end.
 * @param options Control plane address and the credential to present.
 * @returns A client of the running server.
 */
export function startMcp(
  t: TestHooks,
  options: { url: string; token?: string },
): McpUnderTest {
  requireArtifacts('bin/mcp.mjs', 'src/index.ts');

  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [MCP_BIN], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CARTOGRAFO_URL: options.url,
      // Explicitly emptied, never inherited: a token in the developer's shell
      // would make a test that forgot to pass one pass anyway.
      CARTOGRAFO_TOKEN: options.token ?? '',
      CARTOGRAFO_MCP_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errors += chunk;
  });

  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    const message = JSON.parse(text) as Record<string, unknown>;
    const settle = pending.get(message.id as number);
    if (settle !== undefined) {
      pending.delete(message.id as number);
      settle(message);
    }
  });

  t.after(() => {
    child.stdin.end();
    child.kill('SIGTERM');
  });

  let nextId = 0;

  const request = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = ++nextId;
    const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no answer to ${method} in ${REQUEST_DEADLINE_MS}ms\nstderr:\n${errors}`));
      }, REQUEST_DEADLINE_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return await answered;
  };

  const notify = (method: string, params?: unknown): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  const call = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> => {
    const message = await request('tools/call', { name, arguments: args });
    assert.equal(
      message.error,
      undefined,
      `tools/call answered a protocol error: ${JSON.stringify(message.error)}`,
    );
    const result = message.result as {
      content: { type: string; text: string }[];
      isError: boolean;
    };
    return { text: result.content[0]?.text ?? '', isError: result.isError };
  };

  return { request, notify, call, stderr: () => errors };
}

/**
 * Runs the handshake an MCP client opens with.
 *
 * @param mcp The server, up.
 * @returns The `initialize` result.
 */
export async function handshake(mcp: McpUnderTest): Promise<Record<string, unknown>> {
  const message = await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'acceptance', version: '0' },
  });
  assert.equal(message.error, undefined, `initialize failed: ${JSON.stringify(message.error)}`);
  mcp.notify('notifications/initialized');
  return message.result as Record<string, unknown>;
}

/** An HTTP/JSON answer from the control plane. */
export interface JsonResponse<T> {
  status: number;
  body: T;
}

/**
 * Speaks JSON with the control plane — the tests' seeding and checking.
 *
 * @param cp Control plane, up, with its credential.
 * @param method HTTP verb.
 * @param route Path, already carrying the `/v1` prefix.
 * @param body JSON body, when there is one.
 * @returns Status and decoded body.
 */
export async function api<T>(
  cp: { url: string; token: string },
  method: string,
  route: string,
  body?: unknown,
): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${cp.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${cp.url}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}
