/**
 * `CopilotAdapter.discoverMcpServers()` (t676, FR5).
 *
 * Measured on 2026-10-12 against `@github/copilot@1.0.95`:
 *
 * - `copilot mcp list --json` EXISTS. It prints `{"mcpServers": {"<name>": {…,
 *   "source": "user"|"builtin"|…, "enabled": true|false}}}`, so this adapter asks
 *   the binary first, as the Codex one does, and falls back to the file.
 * - The user-scope file is `$COPILOT_HOME/mcp-config.json` (`~/.copilot` by
 *   default), `{"mcpServers": {…}}`, and it carries NO disabled marker:
 *   `copilot mcp disable <name>` left the entry untouched and wrote
 *   `{"disabledMcpServers": ["<name>"]}` into the sibling `settings.json`.
 *   `enabled: false` exists only in the CLI's merged view.
 * - The CLI always lists a builtin `github-mcp-server`. Sessions run under
 *   `--disable-builtin-mcps`, so it is not a server a node can use, and it is
 *   left out so discovery and resolution agree.
 *
 * The fixtures are those captures, byte for byte where short and trimmed to the
 * fields read where long (the real `github-mcp-server` entry carries headers and
 * a filter map).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';

/** `copilot mcp list --json` with alpha, beta, a disabled gamma and the builtin. */
const COPILOT_MCP_LIST_JSON = JSON.stringify(
  {
    mcpServers: {
      alpha: {
        tools: ['*'],
        type: 'local',
        command: 'node',
        args: ['/x/server.js', '--flag'],
        env: { FOO: 'bar' },
        source: 'user',
        enabled: true,
      },
      beta: {
        tools: ['*'],
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-A': 'b' },
        source: 'user',
        enabled: true,
      },
      gamma: {
        tools: ['*'],
        type: 'local',
        command: 'echo',
        args: ['hi'],
        source: 'user',
        enabled: false,
      },
      'github-mcp-server': {
        type: 'http',
        url: 'https://api.individual.githubcopilot.com/mcp/readonly',
        tools: ['*'],
        isDefaultServer: true,
        source: 'builtin',
        enabled: true,
      },
    },
  },
  null,
  2,
);

/** `mcp-config.json` as `copilot mcp add` wrote it: alpha, beta, gamma, no marker. */
const COPILOT_MCP_CONFIG = JSON.stringify({
  mcpServers: {
    alpha: { tools: ['*'], type: 'local', command: 'node', args: ['/x/server.js', '--flag'], env: { FOO: 'bar' } },
    beta: { tools: ['*'], type: 'http', url: 'https://example.com/mcp', headers: { 'X-A': 'b' } },
    gamma: { tools: ['*'], type: 'local', command: 'echo', args: ['hi'] },
  },
});

/** `settings.json` after `copilot mcp disable gamma`. */
const COPILOT_SETTINGS_DISABLED_GAMMA = '{\n  "disabledMcpServers": [\n    "gamma"\n  ]\n}\n';

/** A path guaranteed not to exist, for the missing-binary case. */
const MISSING_BINARY = join(tmpdir(), 'cartografo-binary-that-does-not-exist-676-copilot');

const printing = (text: string): { command: string; args: string[] } => ({
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
});

const noCli = { command: MISSING_BINARY, args: ['mcp', 'list', '--json'] };

function withFixtures(body: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-copilot-676-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('t676 — the JSON the CLI prints is origin "cli", with the enabled, non-builtin servers', async () => {
  const adapter = new CopilotAdapter({
    mcpListCommandBuilder: () => printing(COPILOT_MCP_LIST_JSON),
    probeEnvironment: {},
  });

  const discovery = await adapter.discoverMcpServers();

  assert.equal(discovery.origin, 'cli');
  // gamma is disabled (`enabled: false`) and the builtin is not usable in a
  // session: neither is a server this runner can call.
  assert.deepEqual(discovery.servers, [{ name: 'alpha' }, { name: 'beta' }]);
  assert.ok(!Number.isNaN(Date.parse(discovery.resolvedAt)));
});

test(
  't676 — a CLI that answered with something unreadable is still the CLI saying zero',
  withFixtures(async (root) => {
    const config = join(root, 'mcp-config.json');
    writeFileSync(config, COPILOT_MCP_CONFIG);

    // Deliberately a non-empty file: mistaking the prose for a failed call would
    // read it and answer alpha/beta/gamma from a DIFFERENT source.
    const adapter = new CopilotAdapter({
      mcpListCommandBuilder: () => printing('No MCP servers configured.\n'),
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'cli');
    assert.deepEqual(discovery.servers, []);
  }),
);

test(
  't676 — a missing binary falls back to mcp-config.json, and never rejects',
  withFixtures(async (root) => {
    const config = join(root, 'mcp-config.json');
    writeFileSync(config, COPILOT_MCP_CONFIG);

    const adapter = new CopilotAdapter({
      mcpListCommandBuilder: () => noCli,
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]);
  }),
);

test(
  't676 — a non-zero exit falls back the same way, whatever it printed',
  withFixtures(async (root) => {
    const config = join(root, 'mcp-config.json');
    writeFileSync(config, COPILOT_MCP_CONFIG);

    const adapter = new CopilotAdapter({
      mcpListCommandBuilder: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }),
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]);
  }),
);

test(
  't676 — on the file path, a server named in settings.json disabledMcpServers is omitted',
  withFixtures(async (root) => {
    const config = join(root, 'mcp-config.json');
    writeFileSync(config, COPILOT_MCP_CONFIG);
    writeFileSync(join(root, 'settings.json'), COPILOT_SETTINGS_DISABLED_GAMMA);

    const adapter = new CopilotAdapter({
      mcpListCommandBuilder: () => noCli,
      probeEnvironment: {},
      mcpConfigPath: config,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'alpha' }, { name: 'beta' }]);
  }),
);

test(
  't676 — missing and corrupt files give an empty list from the file, never a throw',
  withFixtures(async (root) => {
    const missing = new CopilotAdapter({
      mcpListCommandBuilder: () => noCli,
      probeEnvironment: {},
      mcpConfigPath: join(root, 'nothing-here.json'),
    });
    const absent = await missing.discoverMcpServers();
    assert.equal(absent.origin, 'file');
    assert.deepEqual(absent.servers, []);

    writeFileSync(join(root, 'mcp-config.json'), '{ this is not json');
    writeFileSync(join(root, 'settings.json'), '[1, 2');
    const corrupt = new CopilotAdapter({
      mcpListCommandBuilder: () => noCli,
      probeEnvironment: {},
      mcpConfigPath: join(root, 'mcp-config.json'),
    });
    const garbled = await corrupt.discoverMcpServers();
    assert.equal(garbled.origin, 'file');
    assert.deepEqual(garbled.servers, []);
  }),
);

test(
  't676 — with no mcpConfigPath given, COPILOT_HOME is where mcp-config.json is looked for',
  withFixtures(async (root) => {
    writeFileSync(join(root, 'mcp-config.json'), COPILOT_MCP_CONFIG);

    const adapter = new CopilotAdapter({
      mcpListCommandBuilder: () => noCli,
      probeEnvironment: { COPILOT_HOME: root },
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]);
  }),
);

test(
  't676 — a CLI that outlasts the deadline is abandoned for the file',
  withFixtures(async (root) => {
    const config = join(root, 'mcp-config.json');
    writeFileSync(config, COPILOT_MCP_CONFIG);

    const adapter = new CopilotAdapter({
      mcpListCommandBuilder: () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] }),
      probeEnvironment: {},
      mcpConfigPath: config,
      mcpProbeDeadlineMs: 200,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.equal(discovery.servers.length, 3);
  }),
);
