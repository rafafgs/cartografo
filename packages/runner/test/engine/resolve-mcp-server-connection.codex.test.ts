/**
 * `CodexAdapter.resolveMcpServerConnection()` (t370, FR1).
 *
 * The same capability over the other engine's format: `config.toml`'s
 * `[mcp_servers.<name>]` table plus its `[mcp_servers.<name>.env]` sub-table,
 * read by the line scan `readMcpConfigToml` already established rather than by
 * a TOML parser — the runner declares no runtime dependency (D17), and a
 * scanner that recognises only what it was taught degrades to `null` on
 * everything else instead of guessing.
 *
 * The fixture is the real capture t400 took from `codex mcp add`, with the env
 * sub-table the real CLI writes when one is configured.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CodexAdapter } from '../../src/engine/codex-adapter.ts';

/** Real `config.toml` written by `codex mcp add`, with an env sub-table. */
const CODEX_CONFIG_TOML = `[mcp_servers.my-tool]
command = "my-command"
args = ["--flag"]

[mcp_servers.my-tool.env]
TOKEN = "\${REPORTS_TOKEN}"
`;

function withFixtures(body: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-connection-codex-370-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  't370 — the real config.toml resolves the stdio connection it declares',
  withFixtures(async (root) => {
    const config = join(root, 'config.toml');
    writeFileSync(config, CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({
      mcpConfigPath: config,
      probeEnvironment: { REPORTS_TOKEN: 'a-secret' },
    });

    assert.deepEqual(await adapter.resolveMcpServerConnection('my-tool'), {
      transport: 'stdio',
      command: 'my-command',
      args: ['--flag'],
      env: { TOKEN: 'a-secret' },
    });
  }),
);

test(
  't370 — a name the file does not declare resolves to null',
  withFixtures(async (root) => {
    const config = join(root, 'config.toml');
    writeFileSync(config, CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({ mcpConfigPath: config, probeEnvironment: {} });

    assert.equal(await adapter.resolveMcpServerConnection('nobody-has-this'), null);
    assert.equal(
      await new CodexAdapter({
        mcpConfigPath: join(root, 'nothing-here.toml'),
        probeEnvironment: {},
      }).resolveMcpServerConnection('my-tool'),
      null,
    );
  }),
);

test(
  't370 — an unset variable with no default rejects here too',
  withFixtures(async (root) => {
    const config = join(root, 'config.toml');
    writeFileSync(config, CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({ mcpConfigPath: config, probeEnvironment: {} });

    await assert.rejects(adapter.resolveMcpServerConnection('my-tool'), (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      assert.ok(error.message.includes('REPORTS_TOKEN'), error.message);
      return true;
    });
  }),
);
