/**
 * `CodexAdapter.discoverMcpServers()` (t400, FR5).
 *
 * Same two paths as the first adapter, over a CLI that is structurally
 * different: measured on 2026-09-06 against `codex-cli 0.147.0`, `codex mcp
 * list` has a real `--json` mode, which `claude mcp list` does not. That is why
 * this adapter also asks the binary first — the ticket's own principle, prefer
 * the CLI because it applies the engine's own scoping rules, reads the same
 * either way — and keeps the `config.toml` read as its fallback.
 *
 * The case worth its own paragraph is the empty state. With nothing configured,
 * `codex mcp list` answers a plain English sentence rather than `[]`, even under
 * `--json`. That is the CLI honestly saying "zero", so it stays `origin: 'cli'`
 * with no servers — mistaking it for a parse failure would fall through to the
 * file and report a DIFFERENT source for an answer the engine already gave.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexAdapter } from '../../src/engine/codex-adapter.ts';

/** Real output of `codex mcp list --json` after one `codex mcp add`. */
const CODEX_MCP_LIST_JSON = `[
  {
    "name": "my-tool",
    "enabled": true,
    "disabled_reason": null,
    "transport": { "type": "stdio", "command": "my-command", "args": ["--flag"], "env": null, "env_vars": [], "cwd": null },
    "startup_timeout_sec": null,
    "tool_timeout_sec": null,
    "auth_status": "unsupported"
  }
]
`;

/** Real answer of `codex mcp list` with nothing configured. */
const CODEX_EMPTY_STATE =
  'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n';

/** Real `config.toml` written by `codex mcp add my-tool -- my-command --flag`. */
const CODEX_CONFIG_TOML = `[mcp_servers.my-tool]
command = "my-command"
args = ["--flag"]
`;

/** A path guaranteed not to exist, for the missing-binary case. */
const MISSING_BINARY = join(tmpdir(), 'cartografo-binary-that-does-not-exist-400-codex');

const printing = (text: string): { command: string; args: string[] } => ({
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
});

function withFixtures(body: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-codex-400-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('t400 — the JSON the CLI prints is origin "cli", with the name it names', async () => {
  const adapter = new CodexAdapter({
    mcpListCommandBuilder: () => printing(CODEX_MCP_LIST_JSON),
    probeEnvironment: {},
  });

  const discovery = await adapter.discoverMcpServers();

  assert.equal(discovery.origin, 'cli');
  assert.deepEqual(discovery.servers, [{ name: 'my-tool' }]);
  assert.ok(!Number.isNaN(Date.parse(discovery.resolvedAt)));
});

test(
  't400 — the real empty-state sentence is the CLI saying zero, not a fall-through',
  withFixtures(async (root) => {
    const config = join(root, 'config.toml');
    // Deliberately non-empty: if the adapter mistook the sentence for a parse
    // failure it would read this file and answer `my-tool`, which is the exact
    // confusion this case exists to catch.
    writeFileSync(config, CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({
      mcpListCommandBuilder: () => printing(CODEX_EMPTY_STATE),
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'cli');
    assert.deepEqual(discovery.servers, []);
  }),
);

test(
  't400 — a missing binary falls back to config.toml, and never rejects',
  withFixtures(async (root) => {
    const config = join(root, 'config.toml');
    writeFileSync(config, CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({
      mcpListCommandBuilder: () => ({ command: MISSING_BINARY, args: ['mcp', 'list', '--json'] }),
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'my-tool' }]);
  }),
);

test(
  't400 — a non-zero exit falls back the same way, whatever it printed',
  withFixtures(async (root) => {
    const config = join(root, 'config.toml');
    writeFileSync(config, CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({
      mcpListCommandBuilder: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }),
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'my-tool' }]);
  }),
);

test(
  't400 — with no mcpConfigPath given, CODEX_HOME is where config.toml is looked for',
  withFixtures(async (root) => {
    // The same `$CODEX_HOME`-aware resolution `#defaultCredentialsPath()` uses,
    // naming `config.toml` instead of `auth.json`. Observed through the only
    // surface there is: the file path really read on the fallback.
    writeFileSync(join(root, 'config.toml'), CODEX_CONFIG_TOML);

    const adapter = new CodexAdapter({
      mcpListCommandBuilder: () => ({ command: MISSING_BINARY, args: ['mcp', 'list', '--json'] }),
      probeEnvironment: { CODEX_HOME: root },
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'my-tool' }]);
  }),
);

test(
  't400 — nothing configured anywhere is zero servers from a file, not an error',
  withFixtures(async (root) => {
    const adapter = new CodexAdapter({
      mcpListCommandBuilder: () => ({ command: MISSING_BINARY, args: ['mcp', 'list', '--json'] }),
      probeEnvironment: {},
      mcpConfigPath: join(root, 'nothing-here.toml'),
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, []);
  }),
);
