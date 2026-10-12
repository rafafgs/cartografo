/**
 * `CopilotAdapter.resolveMcpServerConnection()` (t676, FR5).
 *
 * The same capability over `mcp-config.json`, the JSON file `copilot mcp add`
 * writes under `$COPILOT_HOME` (measured against `@github/copilot@1.0.95`): a
 * stdio server is `{"type": "local", "command", "args", "env"}`, a remote one
 * `{"type": "http", "url", "headers"}`. Both go through the reader the Claude
 * adapter already uses on `.mcp.json`, `mcpServerConnectionFromEntry`, which
 * treats everything that is not http/sse as stdio.
 *
 * A server `copilot mcp disable` turned off keeps its entry in this file and is
 * named in the sibling `settings.json`'s `disabledMcpServers`; it resolves
 * `null`, because the CLI would not start it either.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';

const COPILOT_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    alpha: {
      tools: ['*'],
      type: 'local',
      command: 'node',
      args: ['/x/server.js', '--flag'],
      env: { FOO: 'bar', TOKEN: '${REPORTS_TOKEN}' },
    },
    beta: {
      tools: ['*'],
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-A': 'b' },
    },
    gamma: { tools: ['*'], type: 'local', command: 'echo', args: ['hi'] },
    broken: { tools: ['*'], type: 'local' },
  },
});

function withFixtures(body: (root: string, config: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-connection-copilot-676-'));
    try {
      const config = join(root, 'mcp-config.json');
      writeFileSync(config, COPILOT_MCP_CONFIG);
      await body(root, config);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  't676 — a declared stdio server resolves to its command, args and expanded env',
  withFixtures(async (_root, config) => {
    const adapter = new CopilotAdapter({
      mcpConfigPath: config,
      probeEnvironment: { REPORTS_TOKEN: 'a-secret' },
    });

    assert.deepEqual(await adapter.resolveMcpServerConnection('alpha'), {
      transport: 'stdio',
      command: 'node',
      args: ['/x/server.js', '--flag'],
      env: { FOO: 'bar', TOKEN: 'a-secret' },
    });
  }),
);

test(
  't676 — an http entry resolves to its url and headers',
  withFixtures(async (_root, config) => {
    const adapter = new CopilotAdapter({ mcpConfigPath: config, probeEnvironment: {} });

    assert.deepEqual(await adapter.resolveMcpServerConnection('beta'), {
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-A': 'b' },
    });
  }),
);

test(
  't676 — an absent name, an entry with no command, and a missing file all resolve to null',
  withFixtures(async (root, config) => {
    const adapter = new CopilotAdapter({ mcpConfigPath: config, probeEnvironment: {} });

    assert.equal(await adapter.resolveMcpServerConnection('nobody-has-this'), null);
    assert.equal(await adapter.resolveMcpServerConnection('broken'), null);
    assert.equal(
      await new CopilotAdapter({
        mcpConfigPath: join(root, 'nothing-here.json'),
        probeEnvironment: {},
      }).resolveMcpServerConnection('alpha'),
      null,
    );
  }),
);

test(
  't676 — a server settings.json lists as disabled resolves to null',
  withFixtures(async (root, config) => {
    writeFileSync(join(root, 'settings.json'), '{"disabledMcpServers":["gamma"]}');
    const adapter = new CopilotAdapter({ mcpConfigPath: config, probeEnvironment: {} });

    assert.equal(await adapter.resolveMcpServerConnection('gamma'), null);
    // The disabled one is the only one affected.
    assert.notEqual(await adapter.resolveMcpServerConnection('beta'), null);
  }),
);

test(
  't676 — an unset variable with no default rejects here too',
  withFixtures(async (_root, config) => {
    const adapter = new CopilotAdapter({ mcpConfigPath: config, probeEnvironment: {} });

    await assert.rejects(adapter.resolveMcpServerConnection('alpha'), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      assert.ok(error.message.includes('REPORTS_TOKEN'), error.message);
      return true;
    });
  }),
);

test(
  't676 — with no mcpConfigPath given, COPILOT_HOME is where the entry is read',
  withFixtures(async (root) => {
    const adapter = new CopilotAdapter({ probeEnvironment: { COPILOT_HOME: root } });

    const connection = await adapter.resolveMcpServerConnection('gamma');
    assert.deepEqual(connection, { transport: 'stdio', command: 'echo', args: ['hi'], env: {} });
  }),
);
