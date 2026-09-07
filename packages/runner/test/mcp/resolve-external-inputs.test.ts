/**
 * Acceptance tests for resolving a node's declared external inputs (t370,
 * AT5–AT13).
 *
 * The claim under test is the ticket's whole first half: before a session
 * exists, every `external.inputs` entry of the node has been fetched from its
 * named MCP server, hashed, and set aside as bytes to write — and every way that
 * can fail has ONE named reason, because a reason is what a person reads in the
 * inbox after the job blocks.
 *
 * Nothing here touches a worktree. `resolveExternalInputs` runs in the
 * pre-worktree window, where `workingDir` does not exist yet, and hands back
 * `pendingWrites` for the dispatch to write once the tree is cut. The one case
 * that IS about disk — AT12's traversal guard — drives `writeExternalInput`
 * directly.
 *
 * The server is `test/fakes/mcp-server.mjs`, spawned for real over stdio: what
 * is being proved is a network boundary, and a hand-rolled stub of the client
 * would prove only that the test agrees with itself.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXED_BLOB, readFileText } from '../fakes/mcp-server.mjs';

import type {
  EngineAdapter,
  McpDiscovery,
  McpServerConnection,
  SessionStatus,
} from '../../src/engine/types.ts';
import type { ResolvedNode } from '../../src/dispatch/resolve-node.ts';
import type * as ResolveModule from '../../src/mcp/resolve-external-inputs.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/mcp/resolve-external-inputs.ts';
const FAKE_SERVER = fileURLToPath(new URL('../fakes/mcp-server.mjs', import.meta.url));

async function loadModule(): Promise<typeof ResolveModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(
    new URL('../../src/mcp/resolve-external-inputs.ts', import.meta.url).href
  )) as typeof ResolveModule;
}

/** A directory that lives as long as the callback. */
function withFixtures(body: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t370-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** One `external.inputs` entry, in t369's declared shape. */
interface Declaration {
  name: string;
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  as: string;
}

/** The node the work is standing on, carrying the entries under test. */
function nodeWith(inputs: Declaration[]): ResolvedNode {
  return {
    versionId: 'sha256:t370',
    node: { id: 'collect-fundamentals', external: { inputs } },
    edges: [],
  };
}

/**
 * An adapter that answers the two MCP questions and nothing else.
 *
 * Everything a session needs throws: this resolution runs BEFORE a session
 * exists, so an adapter method reached from here would be a sequencing bug, and
 * a stub that answered politely would hide it.
 */
function adapterWith(options: {
  servers?: string[];
  connection?: McpServerConnection | null;
  connectionError?: Error;
}): EngineAdapter {
  const unreachable = (name: string): never => {
    throw new Error(`the resolution reached ${name}, which happens after the session opens`);
  };

  return {
    engineName: 'fake',
    startSession: () => unreachable('startSession'),
    getStatus: () => unreachable('getStatus') as Promise<SessionStatus>,
    cancel: () => unreachable('cancel'),
    capabilities: () => ({}),
    verifyCli: () => Promise.resolve({ available: true, version: null, authenticated: true }),
    discoverMcpServers: (): Promise<McpDiscovery> =>
      Promise.resolve({
        servers: (options.servers ?? ['reports']).map((name) => ({ name })),
        origin: 'file',
        resolvedAt: new Date().toISOString(),
      }),
    resolveMcpServerConnection: (): Promise<McpServerConnection | null> => {
      if (options.connectionError !== undefined) return Promise.reject(options.connectionError);
      return Promise.resolve(options.connection === undefined ? stdio() : options.connection);
    },
  };
}

/** The connection that points at the fake server, in the given mode. */
function stdio(mode = 'normal', env: Record<string, string> = {}): McpServerConnection {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: [FAKE_SERVER],
    env: { CARTOGRAFO_FAKE_MCP_MODE: mode, ...env },
  };
}

const CALL_OPTIONS = { callTimeoutMs: 5_000, resultSizeCapBytes: 10 * 1_048_576 };

/** sha256, hex — the same digest the resolution is specified to record. */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Runs the resolution and asserts it refused with the named reason. */
async function rejectsWith(
  promise: Promise<unknown>,
  reason: string,
  mentions: readonly string[] = [],
): Promise<void> {
  const { ExternalInputResolutionError } = await loadModule();

  await assert.rejects(promise, (error: unknown) => {
    assert.ok(
      error instanceof ExternalInputResolutionError,
      `the refusal has to be an ExternalInputResolutionError: ${String(error)}`,
    );
    assert.equal(error.reason, reason, `the reason reads "${error.reason}": ${error.message}`);
    for (const mention of mentions) {
      assert.ok(
        error.message.includes(mention),
        `the message has to name "${mention}", and it reads: ${error.message}`,
      );
    }
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* AT5 — the happy path: two entries, two files' worth of bytes, two digests.  */
/* -------------------------------------------------------------------------- */

test('AT5 — two entries resolve to input.external and to their pending writes', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    {
      name: 'report',
      server: 'reports',
      tool: 'read_file',
      arguments: { path: 'notes/report.md' },
      as: 'external/report.md',
    },
    {
      name: 'fixture',
      server: 'reports',
      tool: 'read_blob',
      arguments: { path: 'fixture.bin' },
      as: 'external/fixture.bin',
    },
  ]);

  const answer = await resolveExternalInputs(resolved, {}, adapterWith({}), CALL_OPTIONS);

  const text = Buffer.from(readFileText('notes/report.md'), 'utf8');
  assert.deepEqual(answer.input.external, {
    report: { path: 'external/report.md', size: text.byteLength, sha256: sha256(text) },
    fixture: {
      path: 'external/fixture.bin',
      size: FIXED_BLOB.byteLength,
      sha256: sha256(FIXED_BLOB),
    },
  });

  assert.deepEqual(
    answer.pendingWrites.map((write) => write.as),
    ['external/report.md', 'external/fixture.bin'],
    'the writes come back in the order the node declared them',
  );
  assert.deepEqual(answer.pendingWrites[0]?.bytes, text);
  assert.deepEqual(answer.pendingWrites[1]?.bytes, FIXED_BLOB);
});

test('AT5 — a node with no external inputs resolves an empty drawer and no writes', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved: ResolvedNode = { versionId: 'sha256:t370', node: { id: 'redigir' }, edges: [] };
  const answer = await resolveExternalInputs(
    resolved,
    { pedido: 'write the note' },
    adapterWith({}),
    CALL_OPTIONS,
  );

  assert.deepEqual(answer.input, { pedido: 'write the note', external: {} });
  assert.deepEqual(answer.pendingWrites, []);
});

/* -------------------------------------------------------------------------- */
/* AT6–AT11 — the five reasons, each a different fact.                        */
/* -------------------------------------------------------------------------- */

test('AT6 — a server discovery does not name is unknown_server', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    { name: 'report', server: 'nobody-has-this', tool: 'read_file', as: 'external/report.md' },
  ]);

  await rejectsWith(
    resolveExternalInputs(resolved, {}, adapterWith({ servers: ['reports'] }), CALL_OPTIONS),
    'unknown_server',
    ['nobody-has-this', 'collect-fundamentals'],
  );
});

test('AT6 — an adapter with no discovery at all is unknown_server too', async () => {
  const { resolveExternalInputs } = await loadModule();

  const adapter = adapterWith({});
  delete (adapter as { discoverMcpServers?: unknown }).discoverMcpServers;

  const resolved = nodeWith([
    { name: 'report', server: 'reports', tool: 'read_file', as: 'external/report.md' },
  ]);

  // An absent capability and an empty answer are different facts (`types.ts`),
  // and neither of them makes a server callable.
  await rejectsWith(
    resolveExternalInputs(resolved, {}, adapter, CALL_OPTIONS),
    'unknown_server',
  );
});

test('AT6 — a connection that does not resolve is a call_error, naming the server', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    { name: 'report', server: 'reports', tool: 'read_file', as: 'external/report.md' },
  ]);

  await rejectsWith(
    resolveExternalInputs(resolved, {}, adapterWith({ connection: null }), CALL_OPTIONS),
    'call_error',
    ['reports'],
  );
});

test('AT7 — a tool the server does not publish is tool_not_found', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    { name: 'report', server: 'reports', tool: 'read_the_future', as: 'external/report.md' },
  ]);

  await rejectsWith(
    resolveExternalInputs(resolved, {}, adapterWith({}), CALL_OPTIONS),
    'tool_not_found',
    ['read_the_future', 'reports'],
  );
});

test('AT8 — a tool that answers isError is a call_error, not a missing tool', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    {
      name: 'report',
      server: 'reports',
      tool: 'read_file',
      arguments: { path: 'notes/report.md' },
      as: 'external/report.md',
    },
  ]);

  // The tool EXISTS and the call itself failed: two different facts, and the
  // one thing a person can act on is which of the two it was.
  await rejectsWith(
    resolveExternalInputs(
      resolved,
      {},
      adapterWith({ connection: stdio('error-call') }),
      CALL_OPTIONS,
    ),
    'call_error',
    ['read_file'],
  );
});

test('AT9 — a server that never answers the call is a timeout', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    {
      name: 'report',
      server: 'reports',
      tool: 'read_file',
      arguments: { path: 'notes/report.md' },
      as: 'external/report.md',
    },
  ]);

  await rejectsWith(
    resolveExternalInputs(resolved, {}, adapterWith({ connection: stdio('silent-call') }), {
      ...CALL_OPTIONS,
      callTimeoutMs: 250,
    }),
    'timeout',
    ['reports', 'read_file'],
  );
});

test(
  'AT10 — an argument the input does not carry refuses before anything is spawned',
  withFixtures(async (root) => {
    const { resolveExternalInputs } = await loadModule();

    // The spawn is observed rather than assumed: this "server" writes a file the
    // moment it runs, so a resolution that reached the transport leaves a trace.
    const marker = path.join(root, 'the-server-ran');
    const connection: McpServerConnection = {
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
      env: {},
    };

    const resolved = nodeWith([
      {
        name: 'report',
        server: 'reports',
        tool: 'read_file',
        arguments: { path: '{{input.thesis.slug}}/report.md' },
        as: 'external/report.md',
      },
    ]);

    await rejectsWith(
      resolveExternalInputs(resolved, { thesis: {} }, adapterWith({ connection }), CALL_OPTIONS),
      'unresolved_argument',
      ['thesis.slug'],
    );

    assert.ok(
      !existsSync(marker),
      'a placeholder that does not resolve fails closed BEFORE the server is reached',
    );
  }),
);

test('AT10 — an argument that DOES resolve is interpolated into the call', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    {
      name: 'report',
      server: 'reports',
      tool: 'read_file',
      arguments: { path: 'notes/{{input.thesis.slug}}.md' },
      as: 'external/report.md',
    },
  ]);

  const answer = await resolveExternalInputs(
    resolved,
    { thesis: { slug: 'eqx' } },
    adapterWith({}),
    CALL_OPTIONS,
  );

  // The fake echoes what it was asked for, which is how the interpolated value
  // is observed on the far side of the wire rather than at the call site.
  assert.deepEqual(
    answer.pendingWrites[0]?.bytes,
    Buffer.from(readFileText('notes/eqx.md'), 'utf8'),
  );
});

test('AT11 — a result over the size cap is a call_error, and nothing comes back', async () => {
  const { resolveExternalInputs } = await loadModule();

  const resolved = nodeWith([
    {
      name: 'report',
      server: 'reports',
      tool: 'read_file',
      arguments: { path: 'notes/report.md' },
      as: 'external/report.md',
    },
  ]);

  await rejectsWith(
    resolveExternalInputs(resolved, {}, adapterWith({}), {
      ...CALL_OPTIONS,
      resultSizeCapBytes: 8,
    }),
    'call_error',
    ['reports'],
  );
});

/* -------------------------------------------------------------------------- */
/* AT12 — the write, and the one thing it refuses.                            */
/* -------------------------------------------------------------------------- */

test(
  'AT12 — writeExternalInput writes under the working directory, and only under it',
  withFixtures(async (root) => {
    const { writeExternalInput } = await loadModule();

    await writeExternalInput(root, { as: 'external/nested/report.md', bytes: FIXED_BLOB });
    assert.deepEqual(readFileSync(path.join(root, 'external/nested/report.md')), FIXED_BLOB);

    // Defense in depth: t369's own schema refuses `as: "../x"` at registration,
    // and a snapshot that arrived from anywhere else still may not write outside
    // the session's entire write scope.
    for (const escape of ['../escaped.md', 'external/../../escaped.md', '/etc/escaped.md']) {
      await assert.rejects(
        writeExternalInput(root, { as: escape, bytes: FIXED_BLOB }),
        (error: unknown) => {
          assert.ok(error instanceof Error, String(error));
          return true;
        },
        `"${escape}" resolves outside the worktree and has to be refused`,
      );
    }

    assert.ok(!existsSync(path.join(root, '..', 'escaped.md')), 'nothing escaped the tree');
  }),
);

/* -------------------------------------------------------------------------- */
/* AT13 — one client per server per dispatch, not one per entry.              */
/* -------------------------------------------------------------------------- */

test('AT13 — two entries off the same server open exactly one client', async () => {
  const { resolveExternalInputs } = await loadModule();

  let initialized = 0;
  let closed = 0;

  const resolved = nodeWith([
    { name: 'first', server: 'reports', tool: 'read_file', as: 'external/a.md' },
    { name: 'second', server: 'reports', tool: 'read_file', as: 'external/b.md' },
  ]);

  const answer = await resolveExternalInputs(resolved, {}, adapterWith({}), {
    ...CALL_OPTIONS,
    createClient: () => ({
      initialize: () => {
        initialized += 1;
        return Promise.resolve({});
      },
      listTools: () => Promise.resolve([{ name: 'read_file' }]),
      callTool: () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    }),
  });

  assert.equal(initialized, 1, 'a node with two inputs off one server opens one connection');
  assert.equal(closed, 1, 'and closes it, so no child process survives the resolution');
  assert.equal(answer.pendingWrites.length, 2);
});
