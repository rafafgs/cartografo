/**
 * `CodexAdapter` — the second EngineAdapter, running the `codex` CLI headless as
 * a subprocess.
 *
 * It exists to satisfy the two-consumers rule
 * (`notes/2026-08-14-extension-and-quality.md:58-64`): "no extension point is
 * frozen before two real consumers exist". The feasibility review of t99 chose
 * this CLI "for the structural likeness to Claude Code's `stream-json`"
 * (`docs/formats/engine-adapter.md:378-395`) and measured it method by method
 * against `codex-cli 0.147.0`; this file is that analysis cashed in.
 *
 * The process lifecycle — the detached spawn and group signals, the end decided
 * on `close`, the two clocks and the SIGTERM→SIGKILL escalation — lives in
 * `process-lifecycle.ts`, shared with the other two CLI adapters since t678.
 * What is this engine's own: the resume and permission refusals before the
 * spawn, and the engine ref read off the `thread.started` frame
 * ({@link extractEngineRef}).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildCommand,
  buildEnvironment,
  CODEX_BINARY,
  type EngineCommand,
} from './codex-command.ts';
import { PERMISSION_REFUSAL_PREFIX, resolveCodexPermissions } from './codex-permission-policy.ts';
import {
  expandEnvPlaceholders,
  parseCodexMcpListJson,
  readMcpConfigToml,
  readMcpServerConfigToml,
} from './mcp-discovery.ts';
import { ProcessLifecycle } from './process-lifecycle.ts';
import {
  SessionStartError,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
  type EngineModel,
  type McpDiscovery,
  type McpServerConnection,
  type ModelCatalog,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
} from './types.ts';

/** Wait between the SIGTERM and the SIGKILL. */
export const DEFAULT_GRACE_MS = 5_000;

/** Deadline of the `--version` probe; a CLI that misses it is not up. */
const PROBE_DEADLINE_MS = 10_000;

/** Directory the CLI keeps its state and its credential file in. */
const CODEX_HOME_VARIABLE = 'CODEX_HOME';

/** Name of the credential file inside that directory. */
const CREDENTIAL_FILE = 'auth.json';

/**
 * Name of the configuration file inside that same directory.
 *
 * Measured, not assumed: `codex mcp add my-tool -- my-command --flag` in an
 * isolated `CODEX_HOME` wrote `[mcp_servers.my-tool]` into exactly this file.
 */
const CONFIG_FILE = 'config.toml';

/**
 * Credentials which, present in the environment, suggest an authenticable
 * session.
 *
 * Not a guess: FR8 asked for the measurement and this is its result. Run against
 * `codex-cli 0.147.0` on 2026-08-14, one variable at a time, `codex doctor`
 * answered `✓ auth  auth is provided by environment` with `auth env vars
 * present` naming each of the three — `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN`
 * landing on `auth mode none`, `CODEX_API_KEY` on `auth mode api_key`. With
 * none of them set, and also with a credential of the OTHER engine set, the
 * same command answered `✗ auth  no Codex credentials were found — Run codex
 * login or provide an API key through a supported auth env var`. The three
 * names also sit adjacent in the distributed binary's read-only data, right
 * after the `auth.json` string, which is how a Rust slice of static strings
 * looks: `auth.jsonOPENAI_API_KEYCODEX_API_KEYCODEX_ACCESS_TOKEN`.
 *
 * "Suggest" is still the right verb: `authenticated` is best effort by a
 * recorded decision of the specification, and it was THIS engine that forced
 * the demotion — with no credential it opens the session normally and only
 * fails in the middle of the stream (`engine-adapter.md:452-461`).
 */
export const CODEX_CREDENTIAL_VARIABLES = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
] as const;

/**
 * Refusal of a session asked to continue an earlier one (t173).
 *
 * Stable and prefix-shaped for the same reason as the `claude-code` adapter's
 * permission refusal: it is what lets a caller tell "the session did not come
 * up" from "the session was never going to come up, and here is the field to
 * fix".
 */
export const RESUME_REFUSAL_MESSAGE =
  'session continuation unsupported: the codex adapter does not implement ' +
  'SessionSpec.resumeFrom — `codex exec resume` is a subcommand, not a flag, ' +
  'and wiring it is a ficha of its own; open the session without resumeFrom';

/**
 * The models this adapter knows the `codex` CLI can be pointed at (t166).
 *
 * Static, and `origin: 'catalog'` on every entry, for the same measured reason
 * the first adapter's list is: `codex exec --help` documents `-m, --model
 * <MODEL>` — which SETS a model — and neither `codex --help` nor the exec
 * subcommand exposes anything that LISTS them. The CLI-query branch of
 * `listModels()` is written for a future engine that has one.
 *
 * Not invented: these are the presets the distributed binary itself carries,
 * read out of `codex-cli 0.147.0` — the four its own model list marks
 * `visibility: "list"`, in the priority order it gives them, with the display
 * names it ships. The one it hides (`gpt-5.4`) is left out for the same reason
 * the CLI hides it. That is why the labels look the way they do rather than
 * following any convention of ours.
 *
 * The list ages like the other one, and nothing validates against it: an id
 * this catalog never heard of is refused by the CLI at session start, which is
 * where the truth about a given account's access actually lives.
 */
export const CODEX_MODELS: readonly EngineModel[] = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', origin: 'catalog' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', origin: 'catalog' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', origin: 'catalog' },
  { id: 'gpt-5.5', label: 'GPT-5.5', origin: 'catalog' },
];

export interface CodexAdapterOptions {
  /** Test seam: swaps the real binary for the kit's fake engine. */
  readonly commandBuilder?: (spec: SessionSpec) => EngineCommand;
  /** Test seam: environment handed to the engine process. */
  readonly environmentBuilder?: (spec: SessionSpec) => NodeJS.ProcessEnv;
  /** Wait between SIGTERM and SIGKILL. Default 5s. */
  readonly graceMs?: number;
  /** Test seam: the preflight command. */
  readonly probeCommandBuilder?: () => EngineCommand;
  /** Environment the preflight reads. Default `process.env`. */
  readonly probeEnvironment?: NodeJS.ProcessEnv;
  /** Credential file the preflight reads. Default `$CODEX_HOME/auth.json`. */
  readonly credentialsPath?: string;
  /** Test seam: the MCP discovery command. Default `codex mcp list --json`. */
  readonly mcpListCommandBuilder?: () => EngineCommand;
  /** Configuration file the file fallback reads. Default `$CODEX_HOME/config.toml`. */
  readonly mcpConfigPath?: string;
  /** Test seam: deadline of the MCP discovery probe. Default 10s. */
  readonly mcpProbeDeadlineMs?: number;
}

/**
 * The session id the engine itself gave, if this line is a recognized frame of
 * the `--json` stream.
 *
 * The frame is the first of the stream —
 * `{"type":"thread.started","thread_id":"01a000e7-…"}`, measured on a real run
 * (`engine-adapter.md:410`) — and the field is `thread_id`, not `session_id`:
 * every CLI calls this something else, which is exactly why `engineRef` is an
 * opaque string in the interface.
 *
 * Demanding `type` and a non-empty id is what separates a real frame from a log
 * line that happens to mention the word. This engine is the one that proved the
 * risk: its runtime writes plain non-JSON text into the SAME stream, measured
 * as `ERROR codex_api::endpoint::responses_websocket: failed to connect to
 * websocket: HTTP error: 401 Unauthorized` (`engine-adapter.md:409`).
 */
export function extractEngineRef(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;

  const { type, thread_id: threadId } = frame as { type?: unknown; thread_id?: unknown };
  if (typeof type !== 'string' || typeof threadId !== 'string' || threadId === '') return null;
  return threadId;
}

export class CodexAdapter implements EngineAdapter {
  readonly engineName = 'codex';

  /** The session lifecycle, shared with the other two CLI adapters (t678). */
  readonly #lifecycle: ProcessLifecycle<undefined>;

  readonly #commandBuilder: (spec: SessionSpec) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;
  readonly #credentialsPath: string;
  readonly #mcpListCommandBuilder: () => EngineCommand;
  readonly #mcpConfigPath: string;
  readonly #mcpProbeDeadlineMs: number;

  constructor(options: CodexAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec) => buildCommand(spec));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#lifecycle = new ProcessLifecycle<undefined>({
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      extractEngineRef,
    });
    this.#probeCommandBuilder =
      options.probeCommandBuilder ?? (() => ({ command: CODEX_BINARY, args: ['--version'] }));
    this.#probeEnvironment = options.probeEnvironment ?? process.env;
    this.#credentialsPath = options.credentialsPath ?? this.#defaultCredentialsPath();
    this.#mcpListCommandBuilder =
      options.mcpListCommandBuilder ??
      (() => ({ command: CODEX_BINARY, args: ['mcp', 'list', '--json'] }));
    this.#mcpConfigPath = options.mcpConfigPath ?? this.#defaultConfigPath();
    this.#mcpProbeDeadlineMs = options.mcpProbeDeadlineMs ?? PROBE_DEADLINE_MS;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    // BEFORE the spawn, and for the same reason the `claude-code` adapter
    // refuses a policy it cannot express: an engine that cannot do what was
    // asked has to say so before opening, never open a session that quietly
    // does less. Silently dropping `resumeFrom` is the worst version of that —
    // a session that continued nothing is indistinguishable, from the outside,
    // from one that continued everything.
    if (spec.resumeFrom) {
      throw new SessionStartError(RESUME_REFUSAL_MESSAGE);
    }

    // The same rule, applied to the other thing this engine can be asked for
    // and might not be able to give (t195). Until this ficha the field was read
    // by nobody here: the adapter took a declared policy, said nothing, and
    // opened a session that enforced none of it — the exact failure the comment
    // above forbids, one field over. `codex-command.ts` resolves this a second
    // time, independently, to build the argv; the duplicated call is deliberate
    // and mirrors `command.ts`, so that neither module depends on the other
    // having already run.
    const { refusals } = resolveCodexPermissions(spec.permissions);
    if (refusals.length > 0) {
      throw new SessionStartError(`${PERMISSION_REFUSAL_PREFIX}${refusals.join('; ')}`);
    }

    const command = this.#commandBuilder(spec);

    // `stdin` piped only when there is something to write into it (t203). This
    // is the engine that MADE invariant 6 normative, so the conditional is the
    // invariant and not an exception to it. No ephemeral file on this side —
    // this CLI has no system-prompt flag to point at one, and an `AGENTS.md`
    // would collide with a real one in the target repository
    // (`codex-command.ts`).
    return await this.#lifecycle.start(spec, listener, {
      command,
      environment: () => this.#environmentBuilder(spec),
      state: undefined,
    });
  }

  /**
   * How many sessions this adapter still holds live — diagnostics only.
   *
   * NOT part of `EngineAdapter`, which is frozen by the rule of two consumers
   * (`notes/2026-08-14-extension-and-quality.md`): it is a seam of this class, in
   * the same family as `commandBuilder` and `probeEnvironment`, and a third-party
   * adapter owes nobody an implementation of it. What it measures is the map of
   * sessions with a process on the other side; the terminal-status stubs are not
   * sessions and are not counted.
   */
  get liveSessionCount(): number {
    return this.#lifecycle.liveSessionCount;
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return this.#lifecycle.getStatus(sessionId);
  }

  async cancel(sessionId: string, status: SessionStatus = 'cancelled'): Promise<void> {
    this.#lifecycle.cancel(sessionId, status);
  }

  /**
   * `--json` emits JSONL, hence `hasStructuredOutput`.
   *
   * `hasResume` stays ABSENT even though `codex exec resume [SESSION_ID]` exists
   * for real and the feasibility table suggests declaring it
   * (`engine-adapter.md:415`). t173 gave the flag a consumer and the
   * `claude-code` adapter lit it up; this one did not, and the reason is not
   * scope any more, it is mechanism: `resume` there is a SUBCOMMAND that
   * replaces `exec` in the argv, not a flag added to it, so it rewrites the
   * command of an adapter already certified in C1–C10 and it is a ficha of its
   * own. Until then the honest posture is the one `startSession` takes — refuse
   * `resumeFrom` at the door — which is exactly what C10 certifies for an
   * engine on this side of the split.
   */
  capabilities(): EngineCapabilities {
    return { hasStructuredOutput: true };
  }

  async verifyCli(): Promise<CliProbe> {
    const version = await this.#probeVersion();
    return {
      available: version !== null,
      version,
      authenticated: this.#looksAuthenticated(),
    };
  }

  /**
   * The static catalog, stamped now (t166).
   *
   * `async` with nothing to await, on the same terms as the first adapter: the
   * promise belongs to the interface, not to this implementation's shortcut.
   */
  async listModels(): Promise<ModelCatalog> {
    return { models: CODEX_MODELS, resolvedAt: new Date().toISOString() };
  }

  /**
   * Which MCP servers this machine's `codex` currently sees (t400).
   *
   * The CLI first, on the same principle as the first adapter — prefer the
   * binary, because it applies the engine's own rules — and here the binary is
   * strictly better placed to be preferred: `codex mcp list --json` really is a
   * machine-readable mode (measured against `codex-cli 0.147.0`; the other CLI
   * has none), and it reflects `enabled`/`disabled_reason` and whatever
   * configuration sources the CLI grows, none of which a hand-scan of a
   * `config.toml` reproduces. That is a default this ticket took and wrote
   * down: the file read stays exactly as decided, as the fallback.
   *
   * **Exit 0 is the CLI having answered, whatever it printed.** With nothing
   * configured the real CLI prints "No MCP servers configured yet. …" instead
   * of `[]`, even under `--json`, and treating unparsable output as a failure
   * would report `origin: 'file'` for a question the engine already answered.
   * So a successful run always yields `origin: 'cli'`, and what did not parse
   * is zero servers.
   *
   * No project-local file on this side: `codex mcp`'s configuration is
   * `$CODEX_HOME`-scoped, with no per-directory equivalent to `.mcp.json`.
   *
   * It never rejects.
   */
  async discoverMcpServers(): Promise<McpDiscovery> {
    const output = await this.#probeMcpList();
    const resolvedAt = new Date().toISOString();

    if (output !== null) {
      return { servers: parseCodexMcpListJson(output), origin: 'cli', resolvedAt };
    }

    return { servers: readMcpConfigToml(this.#mcpConfigPath), origin: 'file', resolvedAt };
  }

  /**
   * How to reach one of those servers, by name (t370, FR1).
   *
   * The same file the discovery above falls back to, read for the VALUES of one
   * table instead of the names of all of them — `[mcp_servers.<name>]` plus its
   * `[mcp_servers.<name>.env]` sub-table, which is exactly what
   * `codex mcp add` writes.
   *
   * No CLI half, for the reason the first adapter's own note gives: `codex mcp
   * list --json` DOES carry a `transport` object, and reading it would be the
   * better source the day something needs it — but the two adapters answering
   * this question from two different kinds of source is a difference nobody
   * asked for, and the discovery gate above already applies the CLI's approval
   * rules before this is ever reached. `$CODEX_HOME`'s config is the one file
   * both halves of this adapter agree on.
   *
   * Only stdio comes out: a `config.toml` server is a spawned command, and the
   * `url`-shaped remote server codex grew has no representation in the tables
   * this scanner reads. A name it does not declare is `null`.
   */
  async resolveMcpServerConnection(name: string): Promise<McpServerConnection | null> {
    const entry = readMcpServerConfigToml(this.#mcpConfigPath, name);
    if (entry === null) return null;

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.env)) {
      env[key] = expandEnvPlaceholders(value, this.#probeEnvironment);
    }

    return {
      transport: 'stdio',
      command: expandEnvPlaceholders(entry.command, this.#probeEnvironment),
      args: entry.args.map((value) => expandEnvPlaceholders(value, this.#probeEnvironment)),
      env,
    };
  }

  /**
   * `$CODEX_HOME/auth.json`, falling back to `~/.codex/auth.json`.
   *
   * Both halves are measured: `codex doctor` reports `CODEX_HOME  ~/.codex
   * (dir)` and `auth file  ~/.codex/auth.json`, and the CLI says of an API key
   * typed at login that "it will be stored locally in auth.json".
   */
  #defaultCredentialsPath(): string {
    const home = this.#probeEnvironment[CODEX_HOME_VARIABLE]?.trim();
    return join(home ? home : join(homedir(), '.codex'), CREDENTIAL_FILE);
  }

  /**
   * `$CODEX_HOME/config.toml`, falling back to `~/.codex/config.toml`.
   *
   * The same resolution as the credential file's, and it has to be the same
   * one: both files live in the directory `CODEX_HOME` names, so an operator
   * who moved that directory moved both, and a second rule here would send the
   * discovery to read a config the CLI itself never opens.
   */
  #defaultConfigPath(): string {
    const home = this.#probeEnvironment[CODEX_HOME_VARIABLE]?.trim();
    return join(home ? home : join(homedir(), '.codex'), CONFIG_FILE);
  }

  /** `codex --version`: a preflight that opens no session and spends no quota. */
  #probeVersion(): Promise<string | null> {
    const command = this.#probeCommandBuilder();

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command.command, [...command.args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.#probeEnvironment,
        });
      } catch {
        resolve(null);
        return;
      }

      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });

      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, PROBE_DEADLINE_MS);

      const settle = (version: string | null): void => {
        clearTimeout(deadline);
        resolve(version);
      };

      // A missing binary arrives here as ENOENT: `available: false`, no throw.
      child.once('error', () => settle(null));
      child.once('close', (code: number | null) => {
        const trimmed = out.trim();
        settle(code === 0 && trimmed !== '' ? trimmed : null);
      });
    });
  }

  /**
   * `codex mcp list --json`: the stdout of a run that exited 0, or `null`.
   *
   * The shape of `#probeVersion`, and no `cwd` of its own: this CLI's MCP
   * configuration is `$CODEX_HOME`-scoped, so the answer does not depend on
   * which directory it was asked from — the difference from the first adapter,
   * and a measured one.
   *
   * `null` is every way the question went unanswered (missing binary, non-zero
   * exit, deadline). Exit 0 is an answer even when what came back is prose:
   * deciding that here, and not in the parser, is what keeps the empty state
   * `origin: 'cli'`.
   */
  #probeMcpList(): Promise<string | null> {
    const command = this.#mcpListCommandBuilder();

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command.command, [...command.args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.#probeEnvironment,
        });
      } catch {
        resolve(null);
        return;
      }

      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });

      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, this.#mcpProbeDeadlineMs);

      const settle = (output: string | null): void => {
        clearTimeout(deadline);
        resolve(output);
      };

      // A missing binary arrives here as ENOENT: the file fallback, no throw.
      child.once('error', () => settle(null));
      child.once('close', (code: number | null) => settle(code === 0 ? out : null));
    });
  }

  /**
   * Best effort, never a guarantee: a credential in the environment OR the
   * credential file the CLI writes at login. `true` means "I found no reason to
   * fail", not "it will authenticate" (`engine-adapter.md:245-252`).
   *
   * `codex doctor` is the richer probe the document points at
   * (`engine-adapter.md:416`) and it is deliberately NOT what runs here: it
   * reaches the network — the run of 2026-08-14 came back with `⚠ websocket
   * Responses WebSocket failed` — and the interface asks for a preflight that
   * spends no quota and answers fast. What its output was used for was
   * measuring which signals are real; those signals are read locally.
   */
  #looksAuthenticated(): boolean {
    for (const name of CODEX_CREDENTIAL_VARIABLES) {
      const value = this.#probeEnvironment[name];
      if (typeof value === 'string' && value.trim() !== '') return true;
    }

    try {
      const content: unknown = JSON.parse(readFileSync(this.#credentialsPath, 'utf8'));
      if (typeof content !== 'object' || content === null) return false;
      // The file holds either the API key typed at login or the OAuth tokens of
      // the browser login; either one is a signal, neither is a guarantee.
      const { OPENAI_API_KEY: storedKey, tokens } = content as {
        OPENAI_API_KEY?: unknown;
        tokens?: unknown;
      };
      if (typeof storedKey === 'string' && storedKey.trim() !== '') return true;
      return typeof tokens === 'object' && tokens !== null;
    } catch {
      // A missing, unreadable or corrupt file is no sign of authentication —
      // and much less a reason to bring a preflight down.
      return false;
    }
  }
}
