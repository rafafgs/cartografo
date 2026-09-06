/**
 * Reading which MCP servers an engine names — the parsing half.
 *
 * Pure on purpose, the same seam `command.ts` is: no spawn, no adapter state,
 * no clock. What is engine-specific here is a FORMAT, not a process, and
 * keeping it side-effect free is what lets both formats be checked against
 * their real captures without a CLI, without credentials and without a network.
 *
 * Two engines, two formats, and the asymmetry is measured rather than assumed
 * (2026-09-06, `claude 2.1.263` and `codex-cli 0.147.0`): `codex mcp list` has
 * a `--json` mode, `claude mcp list` has none at all and prints a human list
 * nobody versions. That is why only the name is read from either — see
 * `McpServerRef` for why the status text is not a fact this format promises.
 *
 * One discipline runs through every reader below: a missing, unreadable or
 * corrupt source returns an empty list and never throws. The same as
 * `#looksAuthenticated`'s — a corrupt file is not a crash, it is silence — and
 * the adapter above is what turns that silence into an honest `origin`.
 */

import { readFileSync } from 'node:fs';

import type { McpServerRef } from './types.ts';

/**
 * A top-level MCP server table in Codex's `config.toml`.
 *
 * `[^.\]]+` is the part that matters: `[mcp_servers.my-tool]` declares a
 * server, `[mcp_servers.my-tool.env]` configures the one already declared, and
 * a pattern that let a dot through would report the second as a server of its
 * own — a name nobody configured, in a list an operator reads to find out what
 * their machine has.
 */
const CODEX_SERVER_TABLE = /^\[mcp_servers\.([^.\]]+)\]$/;

/**
 * The names in the output of `claude mcp list`.
 *
 * One entry per non-blank line shaped `<name>: <target> - <status>`, and the
 * name is everything before the FIRST `": "`. Not the last, and not a bare
 * `":"`: the real capture's first three targets are URLs, which carry a colon
 * of their own, and splitting anywhere else names a server "claude.ai Google
 * Drive: https".
 *
 * Everything without that separator is dropped, which is how the
 * `Checking MCP server health…` banner — and any other line the CLI decides to
 * print around the list — costs nothing. This is a parser for prose: it is
 * written to under-report rather than to invent.
 */
export function parseClaudeMcpListOutput(output: string): McpServerRef[] {
  const refs: McpServerRef[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf(': ');
    if (separator <= 0) continue;

    const name = trimmed.slice(0, separator).trim();
    if (name !== '') refs.push({ name });
  }

  return refs;
}

/**
 * The names in the output of `codex mcp list --json`.
 *
 * A parse failure and a non-array value both return `[]` instead of throwing,
 * and that is not defensive padding: with nothing configured, the real CLI
 * answers the plain sentence "No MCP servers configured yet. Try `codex mcp add
 * my-tool -- my-command`." even under `--json`. That is the engine honestly
 * saying zero, and an exception here would turn it into an error the adapter
 * would then report as a different source.
 */
export function parseCodexMcpListJson(output: string): McpServerRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const refs: McpServerRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim() !== '') refs.push({ name });
  }

  return refs;
}

/**
 * The keys of a `{ "mcpServers": { "<name>": {…} } }` file.
 *
 * The shape of both of Claude Code's file sources: the user-scope
 * `~/.claude.json` and a project's own `.mcp.json`. Only the keys are read —
 * what is under them is the transport, and this ticket discovers servers, it
 * does not call them.
 */
export function readMcpServersJsonFile(path: string): McpServerRef[] {
  try {
    const content: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof content !== 'object' || content === null) return [];

    const servers = (content as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== 'object' || servers === null) return [];

    return Object.keys(servers).map((name) => ({ name }));
  } catch {
    // A missing, unreadable or corrupt file names no server — and is much less
    // a reason to bring a preflight down.
    return [];
  }
}

/**
 * The server tables of a Codex `config.toml`.
 *
 * A line scan, not a TOML parser, and deliberately: the runner declares no
 * runtime dependency (D17, and `packages/runner/package.json` still has none),
 * the one thing being read is a table header, and a scanner that recognises
 * only that header degrades to silence on everything it does not understand
 * instead of failing on a file whose OTHER half it has no business reading.
 */
export function readMcpConfigToml(path: string): McpServerRef[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const refs: McpServerRef[] = [];
  for (const line of content.split('\n')) {
    const match = CODEX_SERVER_TABLE.exec(line.trim());
    if (match) refs.push({ name: match[1] });
  }

  return mergeServerRefs(refs);
}

/**
 * The given lists as one, deduped by name, first seen winning its position.
 *
 * Order is a decision and not an accident: the caller passes its sources in
 * priority order, and a name repeated later keeps the place the earlier source
 * gave it. Nothing is merged FIELD-wise, because there is only one field.
 */
export function mergeServerRefs(...lists: readonly McpServerRef[][]): McpServerRef[] {
  const seen = new Set<string>();
  const merged: McpServerRef[] = [];

  for (const list of lists) {
    for (const ref of list) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);
      merged.push(ref);
    }
  }

  return merged;
}
