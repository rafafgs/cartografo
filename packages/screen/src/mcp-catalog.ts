/**
 * The MCP server catalogue (t373, RF-20 extension) — suggest, never install.
 *
 * The interview asks, per step, whether it reaches outside the machine and
 * through which server, offering the names `environment.mcp_servers` carries
 * (`docs/spec/interview.md` §2). When the person names something none of those
 * cover, the model writes one line into the question's `context`
 * (`NEEDS_MCP_SERVER: <capability>`), and this module is what turns that
 * capability into up to three candidates from the official registry, each with
 * the exact command that would add it.
 *
 * **The whole file exists under one rule, which is §1.4's: it suggests, and it
 * never installs.** Nothing here runs a command, writes a file, or touches an
 * engine's configuration. `install.claude_code` and `install.codex` are
 * strings for a person to read, copy and run themselves — and the page that
 * renders them draws no button at all.
 *
 * ## `search()` never rejects. That is the contract, not a courtesy.
 *
 * `docs/spec/screen-interview.md` §3 puts a three-second poll on this page: a
 * registry that hangs, refuses, or answers something nobody expected must cost
 * the question exactly what "nothing found" costs it, which is nothing. So
 * every failure — a socket that never answers, a non-2xx, a body that does not
 * parse, a body that parses into a different shape entirely — collapses into
 * `[]`, and the question renders with no suggestions and no error.
 *
 * That is also why {@link cachedCatalog}'s two TTLs are different numbers.
 * t434 measured the cost of an unbounded external call on a path this product
 * repeats: `discoverMcpServers()` on the runner's startup path cost 2.1–3.3s
 * because nothing bounded a repeat call. One layer up, the same mistake would
 * be a down registry re-attempted — timeout and all — on every three-second
 * poll. An empty answer is therefore cached SEPARATELY and briefly: long
 * enough that a poll cycle does not re-attempt it, short enough that a registry
 * coming back up is noticed within half a minute.
 *
 * ## Only what this repository can already assert
 *
 * A registry entry's `packages[]` is the only part of it from which a working
 * `mcp add` line is derivable, and only for two of its `registryType`s — the
 * two whose shape is measured here: `claude mcp add <name> -- <command>`
 * (`packages/mcp/README.md`) and `codex mcp add <name> -- <command>` (t400's
 * captured run, in `docs/formats/engine-adapter.md`). A `remotes`-only entry,
 * or a `docker`/`oci`/`nuget` package, gets NO command — a homepage and
 * nothing else. Inventing a flag for those would put an unverified command
 * beside a measured one with the same authority, which is exactly what t402
 * already refused once in this repository.
 *
 * Zero runtime dependencies, like `client.ts` next door: global `fetch` and
 * global `AbortController`, and no import from `packages/core` (D11).
 */

/** The official registry, and the default this module points at. */
export const OFFICIAL_REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

/** How long the catalogue waits for the registry before giving up on it. */
export const DEFAULT_TIMEOUT_MS = 3000;

/** How many candidates a question is ever offered. Three fit beside a form. */
export const MAX_SUGGESTIONS = 3;

/** How long a real answer is reused. "A few minutes" — nothing here is urgent. */
export const DEFAULT_SUCCESS_TTL_MS = 5 * 60 * 1000;

/**
 * How long an EMPTY answer is reused, and why it is its own number.
 *
 * Every failure collapses into `[]` (see the header), so this is also the TTL
 * of "the registry is down". Thirty seconds is ten polls of the interview's own
 * three-second cycle: a registry that is not answering is asked at most twice a
 * minute instead of twenty times, and one that recovers is noticed inside half
 * a minute. The figure is a judgement, not a measurement.
 */
export const DEFAULT_FAILURE_TTL_MS = 30 * 1000;

/** One candidate, as a person reads it. */
export interface McpServerSuggestion {
  /** The registry's own name for it, verbatim — it is also the local add name. */
  name: string;
  /** What it says it does. Rendered escaped; it is somebody else's prose. */
  description: string;
  /** Where to read about it, or `null` when the entry published no address. */
  homepage: string | null;
  /** The exact command to add it, per engine; `null` where none is evidenced. */
  install: {
    claude_code: string | null;
    codex: string | null;
  };
}

/**
 * Somewhere to look up MCP servers by capability.
 *
 * An interface and not a function so that a second catalogue (Smithery, a
 * private index) is a new implementation rather than a new branch — and so that
 * a test can inject a counting fake without a server. `officialRegistry` is the
 * only implementation this ticket builds.
 */
export interface McpCatalog {
  /**
   * Up to {@link MAX_SUGGESTIONS} candidates for a capability.
   *
   * @param query A capability phrase, as the interview named it.
   * @returns The candidates; `[]` for "nothing found" AND for every failure.
   */
  search(query: string): Promise<McpServerSuggestion[]>;
}

/** Options of {@link officialRegistry}; every one of them exists for a test. */
export interface OfficialRegistryOptions {
  /** Registry root. Default {@link OFFICIAL_REGISTRY_URL}. */
  baseUrl?: string;
  /** `fetch` implementation. Default: the global one. */
  doFetch?: typeof fetch;
  /** Milliseconds before the request is aborted. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Options of {@link cachedCatalog}. */
export interface CachedCatalogOptions {
  /** How long a non-empty answer is reused. Default {@link DEFAULT_SUCCESS_TTL_MS}. */
  successTtlMs?: number;
  /** How long an empty answer is reused. Default {@link DEFAULT_FAILURE_TTL_MS}. */
  failureTtlMs?: number;
  /** The clock, injectable so a TTL is testable without waiting for one. */
  now?: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string field, or `null` when it is absent, not a string, or blank. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * The command that runs one registry entry's server, or `null`.
 *
 * The first `packages[]` entry of a runtime this repository has a measured
 * `mcp add` shape for wins; everything else is skipped rather than guessed at.
 * An entry with no usable package is not half a suggestion — it is a
 * suggestion with a homepage and no command, which is an honest thing to show.
 *
 * @param packages The entry's `packages`, as it came.
 * @returns `npx -y <identifier>`, `uvx <identifier>`, or `null`.
 */
function runCommand(packages: unknown): string | null {
  if (!Array.isArray(packages)) return null;

  for (const candidate of packages) {
    if (!isObject(candidate)) continue;
    const identifier = text(candidate.identifier);
    if (identifier === null) continue;
    if (candidate.registryType === 'npm') return `npx -y ${identifier.trim()}`;
    if (candidate.registryType === 'pypi') return `uvx ${identifier.trim()}`;
  }
  return null;
}

/**
 * One registry entry's `server` object, read as a suggestion.
 *
 * @param server The `server` object, as it came off the wire.
 * @returns The suggestion, or `null` when there is not even a name to show.
 */
function toSuggestion(server: unknown): McpServerSuggestion | null {
  if (!isObject(server)) return null;

  const name = text(server.name);
  if (name === null) return null;

  const repository = isObject(server.repository) ? text(server.repository.url) : null;
  const command = runCommand(server.packages);

  return {
    name,
    description: text(server.description) ?? '',
    homepage: text(server.websiteUrl) ?? repository,
    install: {
      claude_code: command === null ? null : `claude mcp add ${name} -- ${command}`,
      codex: command === null ? null : `codex mcp add ${name} -- ${command}`,
    },
  };
}

/**
 * The official MCP registry, as an ordinary HTTP client (D11).
 *
 * `GET {baseUrl}/v0/servers?search=<query>&limit=3`. The response envelope is
 * the one a live `GET` returned on 2026-09-07 —
 * `{"servers": [{"server": {…}, "_meta": {…}}], "metadata": {…}}` — and `search`
 * is a substring match on the server's `name`, which is why the interview is
 * asked for a CAPABILITY phrase and never a product name.
 *
 * @param options Address, `fetch` and timeout; all three exist for tests.
 * @returns A catalogue that answers `[]` rather than ever rejecting.
 */
export function officialRegistry(options: OfficialRegistryOptions = {}): McpCatalog {
  const baseUrl = (options.baseUrl ?? OFFICIAL_REGISTRY_URL).replace(/\/+$/, '');
  const doFetch = options.doFetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async search(query: string): Promise<McpServerSuggestion[]> {
      // One controller per call: the deadline covers the response BODY too, not
      // only the headers, because a registry that answers `200` and then stops
      // sending is the same stall from this page's side.
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const target = `${baseUrl}/v0/servers?search=${encodeURIComponent(query)}&limit=${MAX_SUGGESTIONS}`;
        const response = await doFetch(target, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok) return [];

        const body: unknown = await response.json();
        if (!isObject(body) || !Array.isArray(body.servers)) return [];

        // Sliced HERE and not upstream: `limit` is a request the registry is
        // free to over-answer, and the page's own ceiling is not negotiable.
        return body.servers
          .map((wrapper) => (isObject(wrapper) ? toSuggestion(wrapper.server) : null))
          .filter((suggestion): suggestion is McpServerSuggestion => suggestion !== null)
          .slice(0, MAX_SUGGESTIONS);
      } catch {
        // Deliberately total, and deliberately silent. A network error, an
        // abort, a body that does not parse and a shape nobody expected are all
        // the same fact to the person answering a question: there is no
        // suggestion to make. See this file's header.
        return [];
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

/** One remembered answer, and the moment it stops being reused. */
interface CacheEntry {
  value: McpServerSuggestion[];
  expiresAt: number;
}

/**
 * The same catalogue, asked at most once per query per TTL.
 *
 * Built ONCE at server construction and never per request — that is the whole
 * point, since what it is protecting against is the interview's own repeated
 * poll. The two TTLs are asymmetric on purpose; the header says why.
 *
 * The map is in-process and unbounded, which is the right trade here: its keys
 * are capability phrases written by the interview for questions currently open
 * on this screen, so it holds a handful of short strings and dies with the
 * process.
 *
 * @param catalog The catalogue actually doing the looking up.
 * @param options TTLs and the clock.
 * @returns A catalogue with the same contract, and far fewer requests.
 */
export function cachedCatalog(
  catalog: McpCatalog,
  options: CachedCatalogOptions = {},
): McpCatalog {
  const successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();

  return {
    async search(query: string): Promise<McpServerSuggestion[]> {
      const at = now();
      const remembered = entries.get(query);
      if (remembered !== undefined && at < remembered.expiresAt) return remembered.value;

      const value = await catalog.search(query);
      entries.set(query, {
        value,
        expiresAt: at + (value.length === 0 ? failureTtlMs : successTtlMs),
      });
      return value;
    },
  };
}

/**
 * The one line the interview writes into `context` when nothing on the machine
 * covers what the step needs.
 *
 * A convention on top of a free-text field, not a new schema: `context` has
 * never been typed on this wire — `packages/core/src/cli/skill-import.ts`
 * already puts a JSON blob in it beside its prose — and this ticket does not
 * change that. The rule is enforced where the rest of the skill's behaviour is,
 * by the agentic check `mcp-suggestion-hint-when-unmatched` in
 * `factory-graphs/map-design/skills/interview.json`.
 */
const HINT_PATTERN = /^NEEDS_MCP_SERVER:\s*(.+)$/m;

/**
 * Reads the capability an open question is asking for a server for.
 *
 * @param context The pending question's `context`, as the projection gave it.
 * @returns The capability phrase, trimmed, or `null` when there is no hint.
 */
export function extractMcpHint(context: string | null): string | null {
  if (context === null) return null;

  const match = HINT_PATTERN.exec(context);
  if (match === null) return null;

  const hint = match[1].trim();
  return hint === '' ? null : hint;
}
