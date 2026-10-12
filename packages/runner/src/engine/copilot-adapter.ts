/**
 * `CopilotAdapter` — the third EngineAdapter, running the GitHub Copilot CLI
 * (`copilot`) headless as a subprocess (t675).
 *
 * It was measured against `@github/copilot@1.0.95` on 2026-10-12, method by
 * method, in `docs/formats/engine-adapter.md` ("Feasibility: a third CLI"), and
 * it implements `EngineAdapter` v1 with no interface change: the frozen
 * contract held for a third consumer, which is the point of having frozen it.
 *
 * The process lifecycle — the detached spawn and group signals, the end decided
 * on `close`, the two clocks and the SIGTERM→SIGKILL escalation — lives in
 * `process-lifecycle.ts`, shared with the other two CLI adapters since t678.
 *
 * What is specific to this engine:
 *
 * - **The adapter chooses the engine ref.** The `--output-format json` stream
 *   has NO start frame: the session id appears only in the final `result` frame
 *   (`{"type":"result","sessionId":"<uuid>","exitCode":0,…}`, measured). So the
 *   adapter generates the UUID, passes it as `--session-id` ("set the UUID for a
 *   new session") and reports it through `onEngineRef` as soon as the process
 *   has spawned. Nothing is parsed for it.
 * - **MCP and models (t676).** `discoverMcpServers` asks `copilot mcp list --json`
 *   first and falls back to `$COPILOT_HOME/mcp-config.json`;
 *   `resolveMcpServerConnection` reads that file; `listModels` is a static
 *   catalog. None of it reaches the session: the runner itself calls a node's
 *   declared server. `reportsUsage` stays undeclared, because the `result`
 *   frame's `usage` carries request counts, not tokens.
 * - **The status is the exit code AND the terminal `result` frame.** A `result`
 *   frame with `exitCode != 0` is `failed` even if the process then exits 0; with
 *   no `result` frame (a process that died first) the exit code alone decides.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  buildCommand,
  buildEnvironment,
  buildProbeCommand,
  COPILOT_BINARY,
  type EngineCommand,
} from './copilot-command.ts';
import { PERMISSION_REFUSAL_PREFIX, resolveCopilotPermissions } from './copilot-permission-policy.ts';
import {
  mcpServerConnectionFromEntry,
  parseCopilotMcpListJson,
  readCopilotDisabledMcpServers,
  readCopilotMcpConfigFile,
  readMcpServerConfigJsonFile,
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

/**
 * Credentials which, present in the environment, suggest an authenticable
 * session, in the CLI's own precedence order (`copilot help environment`:
 * "an authentication token that takes precedence over previously stored
 * credentials"; `copilot login --help` lists the same three).
 *
 * **Env-only, by measurement and not by omission.** `copilot login --help` says
 * the token goes "securely in the system credential store" and only falls back
 * to "a plain text config file under ~/.copilot/" without naming the file or its
 * layout. And a fresh `COPILOT_HOME` after the very first headless run already
 * holds a `config.json` (`{"firstLaunchAt": …}`) with nobody logged in, so
 * "a file exists" would answer true for a CLI that never authenticated. A stored
 * login is therefore invisible to this probe, and `authenticated: false` means
 * "no environment credential", not "will fail": best effort by the
 * specification's own decision, the way Codex's was.
 */
export const COPILOT_CREDENTIAL_VARIABLES = [
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
] as const;

/** Variable that relocates the CLI's configuration and state (`copilot help environment`). */
const COPILOT_HOME_VARIABLE = 'COPILOT_HOME';

/** The user-scope MCP configuration `copilot mcp add` writes, under the home. */
const MCP_CONFIG_FILE = 'mcp-config.json';

/**
 * Where `copilot mcp disable` records what it turned off, in the same directory
 * as {@link MCP_CONFIG_FILE}: the entry in `mcp-config.json` is left untouched.
 */
const SETTINGS_FILE = 'settings.json';

/**
 * The models `copilot` can be pointed at, plus `auto` (t676).
 *
 * Static, `origin: 'catalog'` on every entry, for the same measured reason the
 * other two catalogs are: `copilot --help` documents `--model <model>` ("Set the
 * AI model to use (use 'auto' to let Copilot pick automatically)") and nothing
 * that LISTS them non-interactively; the list lives behind the interactive
 * `/model`. These ids are the ones `copilot help config` prints under `model` for
 * `@github/copilot@1.0.95`, read on 2026-10-12, in the order it prints them.
 *
 * The list ages, and nothing validates against it: which of them an account may
 * use depends on its plan and its organization's policy, and an id nobody
 * validated is refused by the CLI at session start, which is where the truth
 * lives. `auto` is not a model but the CLI's own name for "route for me", and it
 * is listed because it is a value `--model` accepts; this adapter never sends it
 * by default (see the "No default model" choice in the spec).
 */
export const COPILOT_MODELS: readonly EngineModel[] = [
  { id: 'auto', label: 'Auto', origin: 'catalog' },
  ...[
    'claude-sonnet-5.5',
    'claude-sonnet-5',
    'claude-fable-5.1',
    'claude-fable-5',
    'claude-opus-5.5',
    'claude-opus-5',
    'claude-opus-4.8',
    'claude-opus-4.8-fast',
    'claude-sonnet-4.6',
    'claude-haiku-5.5',
    'claude-haiku-4.5',
    'gpt-6.1-sol',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex',
    'gpt-5-mini',
    'mai-code-1.1-flash',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'grok-4.7',
    'grok-4.6',
    'grok-4.5',
    'kimi-k3',
  ].map((id): EngineModel => ({ id, origin: 'catalog' })),
];

/**
 * Refusal of a session asked to continue an earlier one.
 *
 * `-r/--resume` exists in the CLI and stays unwired until a consumer exists
 * (`capabilities()` does not declare it), so the honest posture is the one the
 * other two adapters take: refuse `resumeFrom` at the door, which is what C10
 * certifies for an engine on this side of the split.
 */
export const RESUME_REFUSAL_MESSAGE =
  'session continuation unsupported: the copilot adapter does not implement ' +
  'SessionSpec.resumeFrom — `copilot --resume` exists but has no consumer yet; ' +
  'open the session without resumeFrom';

export interface CopilotAdapterOptions {
  /**
   * Test seam: swaps the real binary for the kit's fake engine. Takes the
   * engine ref the adapter generated as its second argument, so a builder can
   * put exactly that value in the argv.
   */
  readonly commandBuilder?: (spec: SessionSpec, engineRef: string) => EngineCommand;
  /** Test seam: environment handed to the engine process. */
  readonly environmentBuilder?: (spec: SessionSpec) => NodeJS.ProcessEnv;
  /** Wait between SIGTERM and SIGKILL. Default 5s. */
  readonly graceMs?: number;
  /** Test seam: the preflight command. */
  readonly probeCommandBuilder?: () => EngineCommand;
  /** Environment the preflight reads. Default `process.env`. */
  readonly probeEnvironment?: NodeJS.ProcessEnv;
  /** Test seam: the MCP discovery command. Default `copilot mcp list --json`. */
  readonly mcpListCommandBuilder?: () => EngineCommand;
  /**
   * Configuration file the file fallback and the connection reader use. Default
   * `$COPILOT_HOME/mcp-config.json` (`~/.copilot/mcp-config.json`). The
   * `settings.json` that names disabled servers is read from the same directory.
   */
  readonly mcpConfigPath?: string;
  /** Test seam: deadline of the MCP discovery probe. Default 10s. */
  readonly mcpProbeDeadlineMs?: number;
}

/** What a live session keeps beyond the shared lifecycle. The adapter persists nothing (D1). */
interface CopilotSessionState {
  /**
   * `exitCode` of the terminal `result` frame, once one was seen on stdout.
   * `null` while none has been: a process that died first never prints it.
   */
  resultExitCode: number | null;
}

/**
 * The `exitCode` of a terminal `result` frame, if this line is one.
 *
 * `{"type":"result","sessionId":"<uuid>","exitCode":0,"usage":{…}}` is the last
 * frame of a `--output-format json` run (measured, success and failure alike:
 * a provider that could not be reached ended with `"exitCode":1`). Demanding the
 * exact `type` and a NUMERIC `exitCode` is what separates it from an assistant
 * message that merely quotes one — that one is `type: "assistant.message"`.
 */
export function extractResultExitCode(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;

  const { type, exitCode } = frame as { type?: unknown; exitCode?: unknown };
  if (type !== 'result' || typeof exitCode !== 'number' || !Number.isFinite(exitCode)) return null;
  return exitCode;
}

export class CopilotAdapter implements EngineAdapter {
  readonly engineName = 'copilot';

  /** The session lifecycle, shared with the other two CLI adapters (t678). */
  readonly #lifecycle: ProcessLifecycle<CopilotSessionState>;

  readonly #commandBuilder: (spec: SessionSpec, engineRef: string) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;
  readonly #mcpListCommandBuilder: () => EngineCommand;
  readonly #mcpConfigPath: string;
  readonly #mcpProbeDeadlineMs: number;

  constructor(options: CopilotAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec, engineRef) => buildCommand(spec, engineRef));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#lifecycle = new ProcessLifecycle<CopilotSessionState>({
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      // The frames are on stdout; a `result`-looking line on stderr is not one.
      onLine: (state, line, channel) => {
        if (channel !== 'stdout') return;
        const resultExitCode = extractResultExitCode(line);
        if (resultExitCode !== null) state.resultExitCode = resultExitCode;
      },
      // Whoever ordered a stop still has the last word (the lifecycle sees to
      // that); without one the exit code decides — and the terminal `result`
      // frame can only make the verdict worse, never better: a frame saying
      // `exitCode != 0` is `failed` even if the process then exits 0. With no
      // frame the exit code alone decides. `code` arrives `null` when the
      // process died by a signal — "there was none", never "zero".
      classifyExit: (code, state) => {
        const frameFailed = state.resultExitCode !== null && state.resultExitCode !== 0;
        return code === 0 && !frameFailed ? 'completed' : 'failed';
      },
    });
    this.#probeCommandBuilder = options.probeCommandBuilder ?? buildProbeCommand;
    this.#probeEnvironment = options.probeEnvironment ?? process.env;
    this.#mcpListCommandBuilder =
      options.mcpListCommandBuilder ??
      (() => ({ command: COPILOT_BINARY, args: ['mcp', 'list', '--json'] }));
    this.#mcpConfigPath = options.mcpConfigPath ?? this.#defaultMcpConfigPath();
    this.#mcpProbeDeadlineMs = options.mcpProbeDeadlineMs ?? PROBE_DEADLINE_MS;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    // BEFORE the spawn, for the reason the other adapters record: an engine
    // that cannot do what was asked has to say so before opening, never open a
    // session that quietly does less.
    if (spec.resumeFrom) {
      throw new SessionStartError(RESUME_REFUSAL_MESSAGE);
    }

    // The same rule for a permission policy this engine cannot express. The
    // command builder resolves it a second time, independently, to build the
    // argv; the duplicated call is deliberate, so neither depends on the other
    // having run. A refusal happens before the builder, before any spawn.
    const { refusals } = resolveCopilotPermissions(spec.permissions);
    if (refusals.length > 0) {
      throw new SessionStartError(`${PERMISSION_REFUSAL_PREFIX}${refusals.join('; ')}`);
    }

    // The engine ref is OURS to choose: the stream has no start frame, and the
    // same value goes to `--session-id` through the builder and to `onEngineRef`
    // once the process is up.
    const engineRef = randomUUID();
    const command = this.#commandBuilder(spec, engineRef);

    // `stdin` piped only when there is something to write into it: the
    // oversized composition (see `copilot-command.ts`).
    return await this.#lifecycle.start(spec, listener, {
      command,
      environment: () => this.#environmentBuilder(spec),
      state: { resultExitCode: null },
      engineRef,
    });
  }

  /**
   * How many sessions this adapter still holds live — diagnostics only, and NOT
   * part of `EngineAdapter` (frozen v1): a seam of this class, in the family of
   * `commandBuilder` and `probeEnvironment`.
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
   * `--output-format json` emits JSONL, hence `hasStructuredOutput`.
   *
   * `hasResume` stays ABSENT although `-r/--resume` exists in the CLI: it has no
   * consumer yet, and a field with no consumer rots the way an invented one
   * does. Until then `startSession` refuses `resumeFrom` at the door.
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
   * The static catalog, stamped now (t676). `async` with nothing to await, on the
   * same terms as the other two adapters: the promise belongs to the interface.
   */
  async listModels(): Promise<ModelCatalog> {
    return { models: COPILOT_MODELS, resolvedAt: new Date().toISOString() };
  }

  /**
   * Which MCP servers this machine's `copilot` currently sees (t676).
   *
   * The CLI first, on the principle both other adapters follow, and here for the
   * Codex reason: `copilot mcp list --json` is a machine-readable mode (measured
   * against 1.0.95), and it reflects `enabled` and every source the CLI merges,
   * which a hand-read of one file does not. The file is the fallback.
   *
   * **Exit 0 is the CLI having answered, whatever it printed**, as for Codex:
   * unparsable output is zero servers from the CLI, not a reason to report a
   * different source for a question the engine already answered.
   *
   * What it leaves out is what a node cannot use: a server the CLI marks
   * `enabled: false`, and its builtin `github-mcp-server` (sessions run under
   * `--disable-builtin-mcps`). Nothing is carried about WHY — `McpServerRef` is
   * `{name}` by design.
   *
   * Nothing here is passed INTO a session: `SessionSpec` has no MCP field and no
   * adapter has one. The runner itself calls a declared server, through this and
   * {@link resolveMcpServerConnection}.
   *
   * It never rejects.
   */
  async discoverMcpServers(): Promise<McpDiscovery> {
    const output = await this.#probeMcpList();
    const resolvedAt = new Date().toISOString();

    if (output !== null) {
      return { servers: parseCopilotMcpListJson(output), origin: 'cli', resolvedAt };
    }

    return {
      servers: readCopilotMcpConfigFile(this.#mcpConfigPath, this.#settingsPath()),
      origin: 'file',
      resolvedAt,
    };
  }

  /**
   * How to reach one of those servers, by name (t676).
   *
   * The file half only, as the other two adapters do: `mcp-config.json` entries
   * are `{"type": "local", "command", "args", "env"}` or `{"type": "http",
   * "url", "headers"}`, which `mcpServerConnectionFromEntry` already reads for
   * Claude Code's `.mcp.json` (everything that is not http/sse is stdio).
   *
   * `null` for a name the file does not declare, for an entry that is neither
   * shape, and for a server `settings.json` lists as disabled: the CLI would not
   * start it. A server only a workspace's `.mcp.json` declares is not here
   * either, and resolves `null` — the runner has no workspace of its own to read.
   * An unset `${VAR}` placeholder rejects, exactly as it does for the others.
   */
  async resolveMcpServerConnection(name: string): Promise<McpServerConnection | null> {
    if (readCopilotDisabledMcpServers(this.#settingsPath()).has(name)) return null;

    const entry = readMcpServerConfigJsonFile(this.#mcpConfigPath, name);
    if (entry === null) return null;

    return mcpServerConnectionFromEntry(entry, this.#probeEnvironment);
  }

  /** `$COPILOT_HOME`, falling back to `~/.copilot` — the directory the CLI itself uses. */
  #home(): string {
    const home = this.#probeEnvironment[COPILOT_HOME_VARIABLE]?.trim();
    return home ? home : join(homedir(), '.copilot');
  }

  /** `$COPILOT_HOME/mcp-config.json`, falling back to `~/.copilot/mcp-config.json`. */
  #defaultMcpConfigPath(): string {
    return join(this.#home(), MCP_CONFIG_FILE);
  }

  /** `settings.json` beside the MCP configuration file, wherever that was put. */
  #settingsPath(): string {
    return join(dirname(this.#mcpConfigPath), SETTINGS_FILE);
  }

  /** `copilot --version`: a preflight that opens no session, needs no network, spends no quota. */
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
        // The first line only: 1.0.95 follows the version with an update hint.
        const version = out.trim().split('\n')[0]?.trim() ?? '';
        settle(code === 0 && version !== '' ? version : null);
      });
    });
  }

  /**
   * `copilot mcp list --json`: the stdout of a run that exited 0, or `null`.
   *
   * The shape of `#probeVersion`, with `COPILOT_AUTO_UPDATE=false` added for the
   * reason the session environment carries it: a runner must never change engine
   * version as a side effect of a preflight. `null` is every way the question went
   * unanswered (missing binary, non-zero exit, deadline); exit 0 is an answer even
   * when what came back is prose.
   */
  #probeMcpList(): Promise<string | null> {
    const command = this.#mcpListCommandBuilder();

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command.command, [...command.args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...this.#probeEnvironment, COPILOT_AUTO_UPDATE: 'false' },
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
   * Best effort, never a guarantee: a credential in the environment. `true`
   * means "I found no reason to fail", not "it will authenticate". See
   * {@link COPILOT_CREDENTIAL_VARIABLES} for why a stored login is not read.
   */
  #looksAuthenticated(): boolean {
    for (const name of COPILOT_CREDENTIAL_VARIABLES) {
      const value = this.#probeEnvironment[name];
      if (typeof value === 'string' && value.trim() !== '') return true;
    }
    return false;
  }
}
