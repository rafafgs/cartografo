/**
 * The pure helpers of `mcp-discovery.ts` (t400, FR3).
 *
 * Every fixture in this file is a REAL capture, taken on 2026-09-06 against the
 * binaries this machine actually has (`claude 2.1.263`, `codex-cli 0.147.0`),
 * and transcribed here byte for byte. That is not ceremony: one of the two
 * formats has no machine-readable mode at all, so the parser's only contract is
 * with a human-facing text that nobody versions, and a hand-written sample of
 * what the output "probably looks like" would pin the wrong thing.
 *
 * No spawn here, and no adapter: this module is pure on purpose, the same seam
 * `command.ts` is, so the parsing can be checked without a CLI, without
 * authentication and without a network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  expandEnvPlaceholders,
  mergeServerRefs,
  parseClaudeMcpListOutput,
  parseCodexMcpListJson,
  readMcpConfigToml,
  readMcpServerConfigJsonFile,
  readMcpServerConfigToml,
  readMcpServersJsonFile,
} from '../../src/engine/mcp-discovery.ts';

/** Real output of `claude mcp list`, run from this repository. */
const CLAUDE_MCP_LIST = `Checking MCP server health…

claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ! Needs authentication
flowpilot: /Users/rafaelgomes/flowpilot/.venv/bin/flowpilot-mcp  - ✔ Connected
cartografo: node packages/mcp/bin/mcp.mjs - ⏸ Pending approval (run \`claude\` to approve)
`;

/** The five names that output carries, in the order it carries them. */
const CLAUDE_NAMES = [
  'claude.ai Google Drive',
  'claude.ai Gmail',
  'claude.ai Google Calendar',
  'flowpilot',
  'cartografo',
];

/** Real output of `codex mcp list --json`, in an isolated `CODEX_HOME`. */
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

/** Real answer of `codex mcp list` with nothing configured — not JSON at all. */
const CODEX_EMPTY_STATE =
  'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n';

/** Real `config.toml` written by `codex mcp add my-tool -- my-command --flag`. */
const CODEX_CONFIG_TOML = `[mcp_servers.my-tool]
command = "my-command"
args = ["--flag"]
`;

/** A directory that lives as long as the callback, fixtures and all. */
function withFixtures(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-mcp-400-'));
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* --- parseClaudeMcpListOutput ---------------------------------------------- */

test('t400 — the real `claude mcp list` text yields its five names, in order', () => {
  assert.deepEqual(
    parseClaudeMcpListOutput(CLAUDE_MCP_LIST).map((ref) => ref.name),
    CLAUDE_NAMES,
  );
});

test('t400 — the health banner is not a server, and neither is a blank line', () => {
  assert.deepEqual(parseClaudeMcpListOutput(''), []);
  assert.deepEqual(parseClaudeMcpListOutput('Checking MCP server health…\n'), []);
  assert.deepEqual(parseClaudeMcpListOutput('\n\n   \n'), []);
});

test('t400 — the name is everything before the FIRST ": ", target and all after', () => {
  // The target of the first real entry is a URL, and a URL carries a colon of
  // its own. Splitting on the last one, or on a bare ":", would name the server
  // "claude.ai Google Drive: https" — which is nothing anybody configured.
  const [first] = parseClaudeMcpListOutput(
    'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ! Needs authentication\n',
  );
  assert.deepEqual(first, { name: 'claude.ai Google Drive' });
});

/* --- parseCodexMcpListJson -------------------------------------------------- */

test('t400 — the real `codex mcp list --json` output yields its one name', () => {
  assert.deepEqual(parseCodexMcpListJson(CODEX_MCP_LIST_JSON), [{ name: 'my-tool' }]);
});

test('t400 — an empty JSON array is zero servers', () => {
  assert.deepEqual(parseCodexMcpListJson('[]'), []);
});

test('t400 — the real empty-state line is zero servers, not a throw', () => {
  // Measured: with nothing configured, `codex mcp list` answers this sentence
  // even under `--json`. A parser that threw here would turn the engine's own
  // honest "none" into an error the adapter would report as something else.
  assert.deepEqual(parseCodexMcpListJson(CODEX_EMPTY_STATE), []);
  assert.deepEqual(parseCodexMcpListJson(''), []);
  assert.deepEqual(parseCodexMcpListJson('{"servers":[]}'), []);
});

/* --- readMcpServersJsonFile ------------------------------------------------- */

test('t400 — an `mcpServers` object yields one ref per key, in file order', () => {
  withFixtures((root) => {
    const path = join(root, 'config.json');
    writeFileSync(path, '{"mcpServers":{"a":{},"b":{}}}');

    assert.deepEqual(readMcpServersJsonFile(path), [{ name: 'a' }, { name: 'b' }]);
  });
});

test('t400 — a missing or corrupt json file is silence, never a crash', () => {
  withFixtures((root) => {
    assert.deepEqual(readMcpServersJsonFile(join(root, 'nothing-here.json')), []);

    const corrupt = join(root, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    assert.deepEqual(readMcpServersJsonFile(corrupt), []);

    const noKey = join(root, 'other.json');
    writeFileSync(noKey, '{"projects":{}}');
    assert.deepEqual(readMcpServersJsonFile(noKey), []);
  });
});

/* --- readMcpConfigToml ------------------------------------------------------ */

test('t400 — the real `config.toml` yields the server its table header names', () => {
  withFixtures((root) => {
    const path = join(root, 'config.toml');
    writeFileSync(path, CODEX_CONFIG_TOML);

    assert.deepEqual(readMcpConfigToml(path), [{ name: 'my-tool' }]);
  });
});

test('t400 — a nested table is part of a server, not a second one', () => {
  withFixtures((root) => {
    const path = join(root, 'config.toml');
    writeFileSync(
      path,
      `${CODEX_CONFIG_TOML}\n[mcp_servers.my-tool.env]\nTOKEN = "x"\n\n[mcp_servers.other]\ncommand = "c"\n`,
    );

    assert.deepEqual(
      readMcpConfigToml(path),
      [{ name: 'my-tool' }, { name: 'other' }],
      '[mcp_servers.my-tool.env] configures my-tool; it does not add a server',
    );
  });
});

test('t400 — a missing or truncated toml is silence, never a crash', () => {
  withFixtures((root) => {
    assert.deepEqual(readMcpConfigToml(join(root, 'nothing-here.toml')), []);

    const truncated = join(root, 'truncated.toml');
    writeFileSync(truncated, '[mcp_servers.my-to');
    assert.deepEqual(readMcpConfigToml(truncated), []);
  });
});

/* --- mergeServerRefs -------------------------------------------------------- */

test('t400 — a name repeated in a later list keeps the position the first list gave it', () => {
  const first = [{ name: 'a' }, { name: 'b' }];
  const second = [{ name: 'b' }, { name: 'c' }];

  assert.deepEqual(mergeServerRefs(first, second), [
    { name: 'a' },
    { name: 'b' },
    { name: 'c' },
  ]);
  assert.deepEqual(mergeServerRefs(second, first), [
    { name: 'b' },
    { name: 'c' },
    { name: 'a' },
  ]);
});

test('t400 — merging nothing, or only empty lists, is an empty list', () => {
  assert.deepEqual(mergeServerRefs(), []);
  assert.deepEqual(mergeServerRefs([], []), []);
});

/* -------------------------------------------------------------------------- */
/* t370 — the pure helpers that read a CONNECTION, not just a name (AT14–AT16).*/
/*                                                                            */
/* Discovery names servers; it does not say how to reach one. `McpServerRef`   */
/* is `{name}` by deliberate design (see this file's header and                */
/* `types.ts`), so the connection details — command, args, env, url — live     */
/* only in the very config files the readers above already open, and until     */
/* this ticket nothing exported anything but their keys.                      */
/* -------------------------------------------------------------------------- */

/** This repository's own `.mcp.json`, transcribed byte for byte. */
const REPOSITORY_MCP_JSON = `{
  "mcpServers": {
    "cartografo": {
      "type": "stdio",
      "command": "node",
      "args": ["packages/mcp/bin/mcp.mjs"],
      "env": {
        "CARTOGRAFO_URL": "\${CARTOGRAFO_URL:-http://127.0.0.1:4317}"
      }
    }
  }
}
`;

/** Real `config.toml` written by `codex mcp add`, env sub-table and all. */
const CODEX_CONFIG_TOML_WITH_ENV = `[mcp_servers.my-tool]
command = "my-command"
args = ["--flag", "--second"]

[mcp_servers.my-tool.env]
TOKEN = "a-secret"
REGION = "eu"

[mcp_servers.other]
command = "c"
`;

test('t370 AT14 — the json reader gives the FULL entry of one server, or null', () => {
  withFixtures((root) => {
    const path = join(root, '.mcp.json');
    writeFileSync(path, REPOSITORY_MCP_JSON);

    assert.deepEqual(readMcpServerConfigJsonFile(path, 'cartografo'), {
      type: 'stdio',
      command: 'node',
      args: ['packages/mcp/bin/mcp.mjs'],
      env: { CARTOGRAFO_URL: '${CARTOGRAFO_URL:-http://127.0.0.1:4317}' },
    });

    // A name nobody declared is `null` and never a half-built entry: the caller
    // turns that into "known to discovery, unreachable" rather than guessing.
    assert.equal(readMcpServerConfigJsonFile(path, 'nobody-has-this'), null);
    assert.equal(readMcpServerConfigJsonFile(join(root, 'nothing-here.json'), 'cartografo'), null);
  });
});

test('t370 AT15 — the two placeholder forms this repository really uses', () => {
  // The literal is `.mcp.json:6`, and it carries both halves of the grammar:
  // a variable name and a default the file supplies when it is unset.
  const literal = '${CARTOGRAFO_URL:-http://127.0.0.1:4317}';

  assert.equal(
    expandEnvPlaceholders(literal, { CARTOGRAFO_URL: 'http://control-plane:9000' }),
    'http://control-plane:9000',
  );
  assert.equal(expandEnvPlaceholders(literal, {}), 'http://127.0.0.1:4317');
  assert.equal(expandEnvPlaceholders('${TOKEN}', { TOKEN: 'a-secret' }), 'a-secret');
  assert.equal(expandEnvPlaceholders('plain, no placeholder', {}), 'plain, no placeholder');
  assert.equal(
    expandEnvPlaceholders('${A}/${B:-two}', { A: 'one' }),
    'one/two',
    'more than one placeholder in one value is ordinary',
  );
});

test('t370 AT15 — an unset variable with no default is a failure, never an empty string', () => {
  // A credential placeholder that quietly became `''` is a wrong credential
  // reaching a spawned process, which is the same silent wrongness
  // `{{input.<path>}}` already refuses everywhere else in this package.
  assert.throws(
    () => expandEnvPlaceholders('${TOKEN}', {}),
    (error: unknown) => {
      assert.ok(error instanceof Error, String(error));
      assert.ok(error.message.includes('TOKEN'), `the failure has to name it: ${error.message}`);
      return true;
    },
  );
});

test('t370 AT16 — the toml reader gives command, args and the env sub-table', () => {
  withFixtures((root) => {
    const path = join(root, 'config.toml');
    writeFileSync(path, CODEX_CONFIG_TOML_WITH_ENV);

    assert.deepEqual(readMcpServerConfigToml(path, 'my-tool'), {
      command: 'my-command',
      args: ['--flag', '--second'],
      env: { TOKEN: 'a-secret', REGION: 'eu' },
    });

    // The second table is a server of its own and its own answer, which is what
    // keeps the scan from bleeding one server's keys into another's.
    assert.deepEqual(readMcpServerConfigToml(path, 'other'), {
      command: 'c',
      args: [],
      env: {},
    });

    assert.equal(readMcpServerConfigToml(path, 'nobody-has-this'), null);
    assert.equal(readMcpServerConfigToml(join(root, 'nothing-here.toml'), 'my-tool'), null);
  });
});

test('t370 AT16 — a table with no command at all is null, never a half connection', () => {
  withFixtures((root) => {
    const path = join(root, 'config.toml');
    writeFileSync(path, '[mcp_servers.my-tool]\nstartup_timeout_sec = 10\n');

    // The scanner returns `null` for what it does not recognize rather than
    // guessing — the same discipline `readMcpConfigToml` already runs under.
    assert.equal(readMcpServerConfigToml(path, 'my-tool'), null);
  });
});
