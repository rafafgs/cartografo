/**
 * `ClaudeCodeAdapter.discoverMcpServers()` (t400, FR4).
 *
 * The two paths, and the difference between them is the whole point of the
 * method: `origin: 'cli'` means the engine's own binary was asked and applied
 * its own scoping and approval rules; `origin: 'file'` means the binary was not
 * there — or refused, or errored, or ran past the deadline — and this is a
 * direct read of the configuration files, which CAN disagree with what the CLI
 * would have said. A server declared in a repository's `.mcp.json` and never
 * approved is exactly that disagreement, measured on this machine on
 * 2026-09-06: `claude mcp list` shows it as "Pending approval" while the file
 * lists it flatly.
 *
 * Which is why the fixture below is the real captured text and not a plausible
 * one: `claude mcp list --help` documents no `--json`, so this parser's only
 * contract is with prose.
 *
 * The last case in this file is not about this adapter at all — it is FR7's
 * caller guard, which belongs with whichever of the new test files reads most
 * naturally and has no adapter of its own to live beside.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import {
  BASELINE_CAPABILITIES,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
  type McpDiscovery,
  type SessionStatus,
} from '../../src/engine/types.ts';

/** Real output of `claude mcp list` (claude 2.1.263), run from this repository. */
const CLAUDE_MCP_LIST = `Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
flowpilot: /Users/rafaelgomes/flowpilot/.venv/bin/flowpilot-mcp  - ✔ Connected
cartografo: node packages/mcp/bin/mcp.mjs - ⏸ Pending approval (run \`claude\` to approve)
`;

const CLAUDE_NAMES = [
  'claude.ai Google Drive',
  'claude.ai Gmail',
  'claude.ai Google Calendar',
  'flowpilot',
  'cartografo',
];

/** A path guaranteed not to exist, for the missing-binary case. */
const MISSING_BINARY = join(tmpdir(), 'cartografo-binary-that-does-not-exist-400');

/** A node process that prints the given text and exits 0. */
const printing = (text: string): { command: string; args: string[] } => ({
  command: process.execPath,
  args: ['-e', `process.stdout.write(${JSON.stringify(text)})`],
});

function withFixtures(body: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-claude-400-'));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Every field of the answer, checked as the shape the format promises. */
function assertDiscoveryShape(discovery: McpDiscovery): void {
  assert.ok(Array.isArray(discovery.servers));
  assert.ok(discovery.origin === 'cli' || discovery.origin === 'file');
  assert.equal(typeof discovery.resolvedAt, 'string');
  assert.ok(
    !Number.isNaN(Date.parse(discovery.resolvedAt)),
    `resolvedAt is not a readable instant: ${JSON.stringify(discovery.resolvedAt)}`,
  );
}

test('t400 — the CLI answering is origin "cli", with the names it printed', async () => {
  const adapter = new ClaudeCodeAdapter({
    mcpListCommandBuilder: () => printing(CLAUDE_MCP_LIST),
    probeEnvironment: {},
  });

  const discovery = await adapter.discoverMcpServers();

  assertDiscoveryShape(discovery);
  assert.equal(discovery.origin, 'cli');
  assert.deepEqual(
    discovery.servers.map((ref) => ref.name),
    CLAUDE_NAMES,
  );
});

test(
  't400 — a CLI that fails falls back to the two files, merged and deduped',
  withFixtures(async (root) => {
    const credentials = join(root, '.claude.json');
    const workingDir = join(root, 'repo');
    mkdirSync(workingDir);
    writeFileSync(credentials,'{"mcpServers":{"flowpilot":{}}}');
    writeFileSync(join(workingDir, '.mcp.json'), '{"mcpServers":{"cartografo":{}}}');

    const adapter = new ClaudeCodeAdapter({
      mcpListCommandBuilder: () => ({ command: process.execPath, args: ['-e', 'process.exit(1)'] }),
      probeEnvironment: {},
      credentialsPath: credentials,
      mcpWorkingDir: workingDir,
    });

    const discovery = await adapter.discoverMcpServers();

    assertDiscoveryShape(discovery);
    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'flowpilot' }, { name: 'cartografo' }]);
  }),
);

test(
  't400 — a missing binary is the same fallback, and never a rejection',
  withFixtures(async (root) => {
    const credentials = join(root, '.claude.json');
    writeFileSync(credentials, '{"mcpServers":{"flowpilot":{}}}');

    const adapter = new ClaudeCodeAdapter({
      mcpListCommandBuilder: () => ({ command: MISSING_BINARY, args: ['mcp', 'list'] }),
      probeEnvironment: {},
      credentialsPath: credentials,
      mcpWorkingDir: root,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'flowpilot' }]);
  }),
);

test(
  't400 — the deadline reaches the fallback too, and leaves no process behind',
  withFixtures(async (root) => {
    const pidFile = join(root, 'pid');
    const credentials = join(root, '.claude.json');
    writeFileSync(credentials, '{"mcpServers":{"flowpilot":{}}}');

    const adapter = new ClaudeCodeAdapter({
      // A child that prints its pid and then never ends: only the deadline can
      // settle this call.
      mcpListCommandBuilder: () => ({
        command: process.execPath,
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
            'setInterval(() => {}, 1000);',
        ],
      }),
      probeEnvironment: {},
      credentialsPath: credentials,
      mcpWorkingDir: root,
      mcpProbeDeadlineMs: 250,
    });

    const discovery = await adapter.discoverMcpServers();

    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, [{ name: 'flowpilot' }]);

    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0, 'the fixture never reported a pid');
    assert.ok(await died(pid), `the probe left ${pid} running past its deadline`);
  }),
);

test(
  't400 — every source empty is zero servers from a file, not an error',
  withFixtures(async (root) => {
    const adapter = new ClaudeCodeAdapter({
      mcpListCommandBuilder: () => ({ command: MISSING_BINARY, args: ['mcp', 'list'] }),
      probeEnvironment: {},
      credentialsPath: join(root, 'nothing-here.json'),
      mcpWorkingDir: join(root, 'no-such-repo'),
    });

    const discovery = await adapter.discoverMcpServers();

    assertDiscoveryShape(discovery);
    assert.equal(discovery.origin, 'file');
    assert.deepEqual(discovery.servers, []);
  }),
);

/* --- FR7: what a caller does when the method is not there ------------------- */

/**
 * A conformant adapter that never heard of MCP discovery.
 *
 * That it type-checks as an `EngineAdapter` at all is the additive-compatibility
 * claim, and it is the compiler that pins it (`npm run typecheck`), not an
 * assertion. What a compiler cannot pin is the RUNTIME half below.
 */
const adapterWithout: EngineAdapter = {
  engineName: 'engine-from-before-this-existed',
  startSession: async () => 'handle',
  getStatus: async (): Promise<SessionStatus> => 'running',
  cancel: async () => {},
  capabilities: (): EngineCapabilities => BASELINE_CAPABILITIES,
  verifyCli: async (): Promise<CliProbe> => ({
    available: true,
    version: '1.0.0',
    authenticated: false,
  }),
};

/**
 * The guard FR7 demands of every caller, written the way `list-models.test.ts`'s
 * own `catalogOf()` is: check the method before calling it, and report the
 * absence as an absence.
 */
async function discoveryOf(adapter: EngineAdapter): Promise<McpDiscovery | 'not implemented'> {
  const discover = adapter.discoverMcpServers;
  if (typeof discover !== 'function') return 'not implemented';
  return await discover.call(adapter);
}

test('t400 — an adapter without the method reports "not implemented", not zero servers', async () => {
  assert.equal(
    await discoveryOf(adapterWithout),
    'not implemented',
    'an absent capability and an engine that names no server are different facts, ' +
      'and a caller that collapses them tells an operator a lie about their machine',
  );

  const answered = await discoveryOf(
    new ClaudeCodeAdapter({
      mcpListCommandBuilder: () => printing(''),
      probeEnvironment: {},
    }),
  );
  assert.notEqual(answered, 'not implemented');
});

/** Polls until the pid is gone, up to two seconds. */
async function died(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
