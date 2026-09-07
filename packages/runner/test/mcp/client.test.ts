/**
 * Acceptance tests for the MCP client and its two transports (t370, AT1–AT4).
 *
 * The client is written from nothing in this ticket, and this file is what says
 * it really speaks the protocol rather than a private dialect: every case below
 * drives it against a server that answers JSON-RPC 2.0 — line-delimited over a
 * spawned child, one POST per message over HTTP — and the two transports are
 * held to the SAME assertions, because a result that differs by transport is a
 * result the caller above cannot reason about.
 *
 * The server is `test/fakes/mcp-server.mjs`, and it is a fake for the reason the
 * conformance kit already records for the engine: CI has to be deterministic and
 * may not depend on a server somebody installed and authorised. Its bytes are
 * fixed and exported, so "byte-identical to the fixed output" is read from the
 * fixture instead of transcribed here.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FIXED_BLOB,
  handle,
  HANGS,
  readFileText,
  TOOLS,
} from '../fakes/mcp-server.mjs';

import type * as ClientModule from '../../src/mcp/client.ts';
import type { McpServerConnection } from '../../src/engine/types.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLIENT_MODULE = 'src/mcp/client.ts';
const FAKE_SERVER = fileURLToPath(new URL('../fakes/mcp-server.mjs', import.meta.url));

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom this package's suites already use: in the red phase the failure has
 * to read as "the implementation is missing", never as a module resolution
 * stack trace.
 */
async function loadClient(): Promise<typeof ClientModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, CLIENT_MODULE)),
    `artifact does not exist yet: packages/runner/${CLIENT_MODULE}`,
  );
  return (await import(new URL('../../src/mcp/client.ts', import.meta.url).href)) as typeof ClientModule;
}

/** The stdio connection that points at the fake server, in the given mode. */
function stdioConnection(mode = 'normal'): McpServerConnection {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { CARTOGRAFO_FAKE_MCP_MODE: mode },
  };
}

/** An HTTP double speaking the same three messages the fixture answers. */
async function httpDouble(
  t: { after: (fn: () => void | Promise<void>) => void },
  mode = 'normal',
): Promise<McpServerConnection> {
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const answer = handle(JSON.parse(body) as unknown, mode);
      if (answer === HANGS) return; // never answers, on purpose
      if (answer === null) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the double has to be listening');
  return { transport: 'http', url: `http://127.0.0.1:${String(address.port)}/mcp` };
}

/* -------------------------------------------------------------------------- */
/* AT1/AT2 — the whole usable subset, over stdio.                             */
/* -------------------------------------------------------------------------- */

test('AT1 — over stdio: initialize, the tool list, and a text result', async (t) => {
  const { createMcpClient } = await loadClient();

  const client = createMcpClient(stdioConnection());
  t.after(async () => {
    await client.close();
  });

  await client.initialize();

  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
    'the listing is the server\'s own, in the server\'s own order',
  );

  const result = await client.callTool('read_file', { path: 'notes/report.md' }, 5_000);
  assert.equal(result.isError ?? false, false);
  assert.deepEqual(result.content, [{ type: 'text', text: readFileText('notes/report.md') }]);
});

test('AT2 — over stdio: a resource result whose blob decodes to the fixture bytes', async (t) => {
  const { createMcpClient } = await loadClient();

  const client = createMcpClient(stdioConnection());
  t.after(async () => {
    await client.close();
  });

  await client.initialize();
  const result = await client.callTool('read_blob', { path: 'fixture.bin' }, 5_000);

  const [first] = result.content as [{ type: string; resource: { blob: string } }];
  assert.equal(first.type, 'resource');
  // Base64 and not text: two of the fixture's bytes are not valid UTF-8, and a
  // client that decoded them as text would corrupt exactly those.
  assert.deepEqual(Buffer.from(first.resource.blob, 'base64'), FIXED_BLOB);
});

/* -------------------------------------------------------------------------- */
/* AT3 — a call that never answers is a timeout, and says so.                 */
/* -------------------------------------------------------------------------- */

test('AT3 — a call past its deadline rejects as a timeout, distinguishably', async (t) => {
  const { createMcpClient, McpTimeoutError } = await loadClient();

  const client = createMcpClient(stdioConnection('silent-call'));
  t.after(async () => {
    await client.close();
  });

  // The handshake and the listing answer normally: what hangs is the CALL, so
  // the deadline this case proves is the one the caller passes per call.
  await client.initialize();
  await client.listTools();

  await assert.rejects(
    client.callTool('read_file', { path: 'notes/report.md' }, 200),
    (error: unknown) => {
      assert.ok(
        error instanceof McpTimeoutError,
        `a call that did not answer is a timeout and not a call error: ${String(error)}`,
      );
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* AT4 — the same three messages over HTTP, with the same results.            */
/* -------------------------------------------------------------------------- */

test('AT4 — over HTTP: identical results to AT1 and AT2', async (t) => {
  const { createMcpClient } = await loadClient();

  const client = createMcpClient(await httpDouble(t));
  t.after(async () => {
    await client.close();
  });

  await client.initialize();

  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    TOOLS.map((tool) => tool.name),
  );

  const text = await client.callTool('read_file', { path: 'notes/report.md' }, 5_000);
  assert.deepEqual(text.content, [{ type: 'text', text: readFileText('notes/report.md') }]);

  const blob = await client.callTool('read_blob', { path: 'fixture.bin' }, 5_000);
  const [first] = blob.content as [{ type: string; resource: { blob: string } }];
  assert.deepEqual(Buffer.from(first.resource.blob, 'base64'), FIXED_BLOB);
});

test('AT4 — over HTTP, a call past its deadline is a timeout too', async (t) => {
  const { createMcpClient, McpTimeoutError } = await loadClient();

  const client = createMcpClient(await httpDouble(t, 'silent-call'));
  t.after(async () => {
    await client.close();
  });

  await client.initialize();
  await assert.rejects(
    client.callTool('read_file', { path: 'x' }, 200),
    (error: unknown) => error instanceof McpTimeoutError,
  );
});

/* -------------------------------------------------------------------------- */
/* The TDD exception this ticket records: a scripted death mid-request.       */
/* -------------------------------------------------------------------------- */

test('t370 — a stdio server that dies with a call in flight rejects, it does not hang', async (t) => {
  const { createMcpClient, McpCallError } = await loadClient();

  const client = createMcpClient(stdioConnection('crash-call'));
  t.after(async () => {
    await client.close();
  });

  await client.initialize();
  await assert.rejects(
    client.callTool('read_file', { path: 'x' }, 5_000),
    (error: unknown) => {
      assert.ok(
        error instanceof McpCallError,
        `a child that exited mid-call is a call error, not a timeout: ${String(error)}`,
      );
      return true;
    },
  );
});
