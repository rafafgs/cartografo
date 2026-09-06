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

import type { McpServerConnection, McpServerRef } from './types.ts';

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

/* -------------------------------------------------------------------------- */
/* t370 — reading a CONNECTION out of the same files, not just a name.         */
/*                                                                            */
/* The readers above answer "which servers does this engine name". The ones    */
/* below answer "how would I reach this one", which is a different question    */
/* with a different failure mode: a name that is wrong costs a listing entry,  */
/* and a connection that is wrong spawns the wrong process with somebody's     */
/* credential in its environment. That is why these three are the only         */
/* functions in this module that are allowed to THROW — and only one of them   */
/* does, over exactly one thing.                                              */
/* -------------------------------------------------------------------------- */

/**
 * A `${VAR}` or `${VAR:-default}` inside a configured value.
 *
 * Both forms are real: this repository's own `.mcp.json` writes
 * `"${CARTOGRAFO_URL:-http://127.0.0.1:4317}"`, and a bare `${TOKEN}` is what
 * every configuration that carries a credential looks like. `[^}:]+` keeps the
 * name from swallowing the `:-` that starts the default, and the default half
 * is `[^}]*` so an empty default (`${VAR:-}`) stays a default rather than
 * failing to match.
 */
const ENV_PLACEHOLDER = /\$\{([^}:]+)(?::-([^}]*))?\}/g;

/** One `[mcp_servers.<name>]` or `[mcp_servers.<name>.env]` header. */
const CODEX_SERVER_SECTION = /^\[mcp_servers\.([^.\]]+)(\.env)?\]$/;

/** A `key = "value"` or `key = ["a", "b"]` line under one of those headers. */
const TOML_ASSIGNMENT = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/;

/** A referenced variable that is unset and names no default (t370, FR1). */
export class UnresolvedEnvPlaceholderError extends Error {
  /** The variable nobody set. */
  readonly variable: string;

  constructor(variable: string) {
    super(
      `the MCP server configuration references \`\${${variable}}\`, which is unset in this ` +
        'runner\'s environment and declares no default — an unresolved credential placeholder ' +
        'is not an empty string',
    );
    this.name = 'UnresolvedEnvPlaceholderError';
    this.variable = variable;
  }
}

/**
 * Expands `${VAR}` and `${VAR:-default}` against an environment.
 *
 * Against the RUNNER's own environment, which is where the credential really
 * lives (RNF-12/RNF-13): the control plane never holds it, and the engine's
 * configuration file only holds the NAME of the variable that does.
 *
 * **An unset variable with no default is a failure, not an empty string.** It
 * is the same fail-closed rule `{{input.<path>}}` already runs under
 * (`interpolate-input.ts`), applied where it matters most: a wrong credential
 * reaching a spawned process is worse than none, because none fails loudly at
 * the far end and a wrong one can succeed against something else.
 *
 * @param value The configured value, verbatim.
 * @param processEnv The environment to resolve against.
 * @returns The value with every placeholder expanded.
 * @throws {UnresolvedEnvPlaceholderError} A referenced variable is unset and
 *   the file supplies no default for it.
 */
export function expandEnvPlaceholders(
  value: string,
  processEnv: NodeJS.ProcessEnv,
): string {
  // Collected first and thrown after the pass, so a value with two gaps reports
  // the first one deterministically instead of depending on the replace order.
  let missing: string | null = null;

  const expanded = value.replace(
    ENV_PLACEHOLDER,
    (token: string, variable: string, fallback: string | undefined): string => {
      const found = processEnv[variable];
      if (found !== undefined) return found;
      if (fallback !== undefined) return fallback;
      missing ??= variable;
      // Left in place and never read: the caller throws before this string
      // reaches a spawn, the same way `interpolate()` leaves its token behind.
      return token;
    },
  );

  if (missing !== null) throw new UnresolvedEnvPlaceholderError(missing);
  return expanded;
}

/**
 * The FULL entry under `mcpServers.<name>` of a JSON config, or `null`.
 *
 * The value, where {@link readMcpServersJsonFile} reads only the key. Same two
 * sources, same silence discipline: a missing, unreadable or corrupt file
 * declares no server, so it answers `null` rather than throwing — what a
 * missing connection means is the ADAPTER's to say, and it says it by returning
 * `null` too.
 *
 * Deliberately untyped past "an object": the shapes a `.mcp.json` entry can
 * take are the engine's, not ours, and normalizing them is
 * {@link mcpServerConnectionFromEntry}'s single job.
 *
 * @param path File to read.
 * @param name Server to look for.
 * @returns The object under that key, or `null`.
 */
export function readMcpServerConfigJsonFile(
  path: string,
  name: string,
): Record<string, unknown> | null {
  try {
    const content: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof content !== 'object' || content === null) return null;

    const servers = (content as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== 'object' || servers === null) return null;
    if (!Object.hasOwn(servers, name)) return null;

    const entry = (servers as Record<string, unknown>)[name];
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A string map read out of a configuration, before any expansion. */
type RawStringMap = Record<string, string>;

/** What a Codex `[mcp_servers.<name>]` table declares, before any expansion. */
export interface RawTomlServerEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<RawStringMap>;
}

/** Reads a TOML scalar: `"text"` or `["a", "b"]`. Anything else is `null`. */
function tomlValue(raw: string): string | string[] | null {
  const trimmed = raw.trim();

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inside = trimmed.slice(1, -1).trim();
    if (inside === '') return [];
    const parts = inside.split(',').map((part) => part.trim());
    if (!parts.every((part) => part.startsWith('"') && part.endsWith('"') && part.length >= 2)) {
      return null;
    }
    return parts.map((part) => part.slice(1, -1));
  }

  return null;
}

/**
 * The `[mcp_servers.<name>]` table of a Codex `config.toml`, or `null`.
 *
 * A line scan and not a TOML parser, mirroring {@link readMcpConfigToml}'s own
 * discipline and for its reasons: the runner declares no runtime dependency
 * (D17), the shapes being read are two table headers and two assignment forms,
 * and a scanner that recognises only what it was taught degrades to `null` on
 * everything else instead of guessing at a file whose other half is none of its
 * business.
 *
 * `args` and `env` default to empty, which is what the real CLI writes when
 * neither was configured. A table with no `command` at all is `null` and never
 * a half connection: a spawn needs a binary, and inventing one is exactly the
 * guess this scanner refuses to make.
 *
 * @param path File to read.
 * @param name Server to look for.
 * @returns Its command, args and env, unexpanded, or `null`.
 */
export function readMcpServerConfigToml(path: string, name: string): RawTomlServerEntry | null {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let section: 'server' | 'env' | null = null;
  let command: string | null = null;
  let args: string[] = [];
  const env: RawStringMap = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('[')) {
      const header = CODEX_SERVER_SECTION.exec(trimmed);
      // Any other table — this server's under a different name, or a part of
      // the file that has nothing to do with MCP — ends the section.
      section =
        header === null || header[1] !== name ? null : header[2] === undefined ? 'server' : 'env';
      continue;
    }

    if (section === null) continue;

    const assignment = TOML_ASSIGNMENT.exec(trimmed);
    if (assignment === null) continue;

    const value = tomlValue(assignment[2]);
    if (value === null) continue;

    if (section === 'env') {
      if (typeof value === 'string') env[assignment[1]] = value;
      continue;
    }

    if (assignment[1] === 'command' && typeof value === 'string') command = value;
    if (assignment[1] === 'args' && Array.isArray(value)) args = value;
  }

  return command === null ? null : { command, args, env };
}

/** Reads a `Record<string, string>` out of an untyped config value. */
function stringMap(value: unknown, processEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const map: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') map[key] = expandEnvPlaceholders(raw, processEnv);
  }
  return map;
}

/**
 * Turns one `mcpServers.<name>` entry into a connection, or `null`.
 *
 * The transport is chosen the way the engine's own configuration expresses it:
 * `type: 'http'`/`'sse'`, or the bare presence of a `url`, is http; everything
 * else is stdio, which is the common case and the only one this repository's
 * own `.mcp.json` uses. An entry that is neither — no `url` and no `command` —
 * is `null`, for {@link readMcpServerConfigToml}'s reason: a spawn needs a
 * binary.
 *
 * Every string that reaches the transport goes through
 * {@link expandEnvPlaceholders} first, `url` and `headers` included: an http
 * server's credential lives in a header exactly as a stdio one's lives in an
 * environment variable.
 *
 * @param entry The raw object under the server's key.
 * @param processEnv The environment placeholders resolve against.
 * @returns The connection, or `null` when the entry declares neither shape.
 * @throws {UnresolvedEnvPlaceholderError} A referenced variable has no value.
 */
export function mcpServerConnectionFromEntry(
  entry: Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv,
): McpServerConnection | null {
  const declaredType = typeof entry.type === 'string' ? entry.type : null;
  const url = typeof entry.url === 'string' ? entry.url : null;

  if (declaredType === 'http' || declaredType === 'sse' || url !== null) {
    if (url === null) return null;
    const headers = stringMap(entry.headers, processEnv);
    return {
      transport: 'http',
      url: expandEnvPlaceholders(url, processEnv),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    };
  }

  if (typeof entry.command !== 'string' || entry.command === '') return null;

  const args = Array.isArray(entry.args)
    ? entry.args
        .filter((value): value is string => typeof value === 'string')
        .map((value) => expandEnvPlaceholders(value, processEnv))
    : [];

  return {
    transport: 'stdio',
    command: expandEnvPlaceholders(entry.command, processEnv),
    args,
    env: stringMap(entry.env, processEnv),
  };
}
