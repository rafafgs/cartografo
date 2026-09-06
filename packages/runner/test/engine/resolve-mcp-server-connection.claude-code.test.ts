/**
 * `ClaudeCodeAdapter.resolveMcpServerConnection()` (t370, FR1).
 *
 * The second, symmetric half of t400's discovery. Discovery answers WHICH
 * servers this machine's engine names; this answers HOW to reach ONE of them,
 * and the two are deliberately separate capabilities: conflating them would
 * grow the frozen, carefully narrow `McpDiscovery` shape for a reason that only
 * ever applies to this ticket's one caller.
 *
 * It reads the SAME two files `discoverMcpServers()` already falls back to —
 * the project's `.mcp.json` and the user scope's `~/.claude.json` — and AT17
 * points it at this repository's own, unmodified, because a connection resolved
 * out of a hand-written sample proves nothing about the file the runner will
 * really open.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { test } from 'node:test';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** A path guaranteed not to exist, for the "no user scope here" case. */
const MISSING_FILE = join(tmpdir(), 'cartografo-claude-json-that-does-not-exist-370.json');

function withFixtures(body: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-connection-370-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('AT17 — this repository\'s own .mcp.json resolves the exact stdio connection it declares', async () => {
  const adapter = new ClaudeCodeAdapter({
    mcpWorkingDir: REPO_ROOT,
    credentialsPath: MISSING_FILE,
    probeEnvironment: {},
  });

  // With `CARTOGRAFO_URL` unset, the `${VAR:-default}` the file writes is the
  // value that reaches the child — which is what the file was written to mean.
  assert.deepEqual(await adapter.resolveMcpServerConnection('cartografo'), {
    transport: 'stdio',
    command: 'node',
    args: ['packages/mcp/bin/mcp.mjs'],
    env: { CARTOGRAFO_URL: 'http://127.0.0.1:4317' },
  });
});

test('AT17 — a set variable wins over the default the file supplies', async () => {
  const adapter = new ClaudeCodeAdapter({
    mcpWorkingDir: REPO_ROOT,
    credentialsPath: MISSING_FILE,
    probeEnvironment: { CARTOGRAFO_URL: 'http://control-plane:9000' },
  });

  const connection = await adapter.resolveMcpServerConnection('cartografo');
  assert.equal(
    connection?.transport === 'stdio' ? connection.env.CARTOGRAFO_URL : null,
    'http://control-plane:9000',
  );
});

test('t370 — a name no source declares resolves to null, never to a guess', async () => {
  const adapter = new ClaudeCodeAdapter({
    mcpWorkingDir: REPO_ROOT,
    credentialsPath: MISSING_FILE,
    probeEnvironment: {},
  });

  assert.equal(await adapter.resolveMcpServerConnection('nobody-has-this'), null);
});

test(
  't370 — a `url` entry resolves as http, headers and all',
  withFixtures(async (root) => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://reports.example.com/mcp',
            headers: { authorization: 'Bearer ${REPORTS_TOKEN}' },
          },
        },
      }),
    );

    const adapter = new ClaudeCodeAdapter({
      mcpWorkingDir: root,
      credentialsPath: MISSING_FILE,
      probeEnvironment: { REPORTS_TOKEN: 'a-secret' },
    });

    assert.deepEqual(await adapter.resolveMcpServerConnection('remote'), {
      transport: 'http',
      url: 'https://reports.example.com/mcp',
      headers: { authorization: 'Bearer a-secret' },
    });
  }),
);

test(
  't370 — the project file wins over the user scope for the same name',
  withFixtures(async (root) => {
    const userScope = join(root, 'claude.json');
    writeFileSync(
      userScope,
      JSON.stringify({ mcpServers: { reports: { command: 'user-scope' } } }),
    );
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { reports: { command: 'project-scope' } } }),
    );

    const adapter = new ClaudeCodeAdapter({
      mcpWorkingDir: root,
      credentialsPath: userScope,
      probeEnvironment: {},
    });

    const connection = await adapter.resolveMcpServerConnection('reports');
    assert.equal(connection?.transport === 'stdio' ? connection.command : null, 'project-scope');
  }),
);

test(
  't370 — the user scope still answers for a name only it declares',
  withFixtures(async (root) => {
    const userScope = join(root, 'claude.json');
    writeFileSync(
      userScope,
      JSON.stringify({ mcpServers: { reports: { command: 'user-scope', args: ['--json'] } } }),
    );

    const adapter = new ClaudeCodeAdapter({
      mcpWorkingDir: root,
      credentialsPath: userScope,
      probeEnvironment: {},
    });

    assert.deepEqual(await adapter.resolveMcpServerConnection('reports'), {
      transport: 'stdio',
      command: 'user-scope',
      args: ['--json'],
      env: {},
    });
  }),
);

test(
  't370 — an unset variable with no default REJECTS, it does not spawn with an empty one',
  withFixtures(async (root) => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: { reports: { command: 'reports-mcp', env: { TOKEN: '${REPORTS_TOKEN}' } } },
      }),
    );

    const adapter = new ClaudeCodeAdapter({
      mcpWorkingDir: root,
      credentialsPath: MISSING_FILE,
      probeEnvironment: {},
    });

    // A credential that quietly became `''` is a WRONG credential reaching a
    // spawned process, and a wrong credential is worse than none (RNF-12/13).
    await assert.rejects(adapter.resolveMcpServerConnection('reports'), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      assert.ok(error.message.includes('REPORTS_TOKEN'), error.message);
      return true;
    });
  }),
);
