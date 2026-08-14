/**
 * `CodexAdapter` — the second EngineAdapter, running the `codex` CLI headless as
 * a subprocess.
 *
 * It exists to satisfy the two-consumers rule
 * (`notas/2026-08-14-extensao-e-qualidade.md:57-63`): "no extension point is
 * frozen before two real consumers exist". The feasibility review of t99 chose
 * this CLI "for the structural likeness to Claude Code's `stream-json`"
 * (`docs/formatos/engine-adapter.md:378-395`) and measured it method by method
 * against `codex-cli 0.147.0`; this file is that analysis cashed in.
 *
 * The process lifecycle is DELIBERATELY DUPLICATED from `claude-code-adapter.ts`
 * instead of extracted into a common base. The duplication is real and it is a
 * decision, not an oversight: with only two adapters there is not yet evidence
 * of what shape the abstraction should have, and generalizing early is the same
 * mistake the two-consumers rule exists to prevent one level up. It is recorded
 * as a candidate for a simplification ticket if a third adapter ever appears.
 *
 * What the two lifecycles share, and why:
 *
 * - **The process comes up detached, and signals go to the GROUP.** It is what
 *   makes C4 pass: an engine that leaves a child alive brings the runner's
 *   machine down after the hundredth session, not the first
 *   (`engine-adapter.md:367-369`).
 * - **The end is decided on `close`, not on `exit`.** `close` only arrives once
 *   the pipes are closed, and that is what guarantees invariant 4 (every line
 *   emitted reaches `onOutput`) before invariant 1 (`onFinished` exactly once).
 * - **The clock is ours.** This CLI has no timeout flag either
 *   (`engine-adapter.md:407`), so the adapter arms it, escalates SIGTERM→SIGKILL
 *   and disarms it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  buildCommand,
  buildEnvironment,
  CODEX_BINARY,
  ENGINE_STDIO,
  type EngineCommand,
} from './codex-command.ts';
import {
  SessionStartError,
  UnknownSessionError,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
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
}

/** Local state of a live session. The adapter persists nothing (D1). */
interface Session {
  readonly child: ChildProcess;
  readonly listener: SessionListener;
  status: SessionStatus;
  /** Terminal status asked for by whoever ordered the stop (cancel or clock). */
  requestedStatus: SessionStatus | null;
  finished: boolean;
  refSent: boolean;
  clock: NodeJS.Timeout | null;
  escalation: NodeJS.Timeout | null;
  safetyNet: NodeJS.Timeout | null;
  leftovers: { stdout: string; stderr: string };
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

  readonly #sessions = new Map<string, Session>();
  readonly #commandBuilder: (spec: SessionSpec) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #graceMs: number;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;
  readonly #credentialsPath: string;

  constructor(options: CodexAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec) => buildCommand(spec));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.#probeCommandBuilder =
      options.probeCommandBuilder ?? (() => ({ command: CODEX_BINARY, args: ['--version'] }));
    this.#probeEnvironment = options.probeEnvironment ?? process.env;
    this.#credentialsPath = options.credentialsPath ?? this.#defaultCredentialsPath();
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    const command = this.#commandBuilder(spec);

    let child: ChildProcess;
    try {
      child = spawn(command.command, [...command.args], {
        cwd: spec.workingDir,
        env: this.#environmentBuilder(spec),
        stdio: [...ENGINE_STDIO],
        // Its own group: that is what allows signalling grandchildren along
        // with the parent.
        detached: true,
      });
    } catch (cause) {
      throw new SessionStartError(`could not start "${command.command}"`, { cause });
    }

    const id = randomUUID();
    const session: Session = {
      child,
      listener,
      status: 'pending',
      requestedStatus: null,
      finished: false,
      refSent: false,
      clock: null,
      escalation: null,
      safetyNet: null,
      leftovers: { stdout: '', stderr: '' },
    };
    this.#sessions.set(id, session);

    // Every handler is registered NOW, synchronously: a process that dies fast
    // would fire `close` before a registration deferred by an `await`, and the
    // session would hang forever.
    let started = false;
    let announceStart: (error: Error | null) => void = () => {};
    const start = new Promise<Error | null>((resolve) => {
      announceStart = resolve;
    });

    child.once('spawn', () => {
      started = true;
      session.status = 'running';
      announceStart(null);
    });

    child.once('error', (error: Error) => {
      if (!started) {
        announceStart(error);
        return;
      }
      this.#finish(id, session.requestedStatus ?? 'failed', null);
    });

    for (const channel of ['stdout', 'stderr'] as const) {
      const stream = child[channel];
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        this.#pump(session, channel, chunk);
      });
    }

    child.once('close', (code: number | null) => {
      if (!started) {
        announceStart(new Error(`the engine process closed before coming up (code ${code})`));
        return;
      }
      this.#complete(id, code);
    });

    const failure = await start;
    if (failure) {
      this.#sessions.delete(id);
      throw new SessionStartError(
        `could not open a session with "${command.command}" in "${spec.workingDir}"`,
        { cause: failure },
      );
    }

    if (spec.timeoutSeconds > 0) {
      session.clock = setTimeout(() => {
        this.#stop(id, 'timed_out');
      }, spec.timeoutSeconds * 1_000);
    }

    return id;
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return this.#requireSession(sessionId).status;
  }

  async cancel(sessionId: string, status: SessionStatus = 'cancelled'): Promise<void> {
    const session = this.#requireSession(sessionId);
    // A silent no-op, not an error: whoever cancels races with the adapter's
    // own streaming thread and has no way of knowing it lost the race.
    if (session.finished) return;
    this.#stop(sessionId, status);
  }

  /**
   * `--json` emits JSONL, hence `hasStructuredOutput`.
   *
   * `hasResume` stays ABSENT even though `codex exec resume [SESSION_ID]` exists
   * for real and the feasibility table suggests declaring it
   * (`engine-adapter.md:415`). The table is exploratory analysis; the decision
   * that rules is "Fora de escopo (v0)" (`:487-491`), which lists resume
   * explicitly outside. Lighting up a field with no consumer rots a published
   * format exactly the way inventing one does — "declaring the fourth, fifth and
   * sixth before anybody reads them" (`engine-adapter.md:160-165`) — and the
   * day resume lands, this is one line and a kit case, not a migration.
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

  #requireSession(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new UnknownSessionError(sessionId);
    return session;
  }

  /** Splits the stream into lines, keeping the `\n`-less tail for the next chunk. */
  #pump(session: Session, channel: 'stdout' | 'stderr', chunk: string): void {
    const accumulated = session.leftovers[channel] + chunk;
    const parts = accumulated.split('\n');
    session.leftovers[channel] = parts.pop() ?? '';
    for (const line of parts) this.#emit(session, line);
  }

  #emit(session: Session, line: string): void {
    // Invariant 2: after onFinished, no onOutput.
    if (session.finished) return;
    session.listener.onOutput(line);

    if (session.refSent || !session.listener.onEngineRef) return;
    const ref = extractEngineRef(line);
    if (ref === null) return;
    session.refSent = true;
    session.listener.onEngineRef(ref);
  }

  /** Natural end of the process: drains what is left and classifies the outcome. */
  #complete(id: string, code: number | null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;

    for (const channel of ['stdout', 'stderr'] as const) {
      const leftover = session.leftovers[channel];
      session.leftovers[channel] = '';
      if (leftover !== '') this.#emit(session, leftover);
    }

    // Whoever ordered the stop has the last word on the status; without that,
    // the exit code decides. No `turn.completed`/`turn.failed` parsing: the
    // feasibility run measured a failed turn leaving with exit code 1, and it
    // "does not mask the failure behind a 0" (`engine-adapter.md:411-412, 429`),
    // so the exit code alone already is the source of truth the interface asks
    // for. `code` already arrives `null` when the process died by a signal — in
    // POSIX there is no exit code in that case, and `null` is "there was none",
    // never "zero" (`engine-adapter.md:227-234`).
    const status = session.requestedStatus ?? (code === 0 ? 'completed' : 'failed');
    this.#finish(id, status, code);
  }

  /** Asks for a stop: SIGTERM to the group, SIGKILL after the grace. */
  #stop(id: string, status: SessionStatus): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;

    session.requestedStatus = status;
    this.#signalGroup(session, 'SIGTERM');
    if (session.escalation) return;

    session.escalation = setTimeout(() => {
      this.#signalGroup(session, 'SIGKILL');

      // Safety net for invariant 1 ("onFinished exactly once, always"): if not
      // even after the SIGKILL the `close` arrives, the outcome is reported all
      // the same. A session hanging forever is worse than a session reported
      // without its last line, and this path should not happen — killing the
      // group closes the pipes.
      session.safetyNet = setTimeout(() => {
        this.#finish(id, status, null);
      }, this.#graceMs);
    }, this.#graceMs);
  }

  #finish(id: string, status: SessionStatus, exitCode: number | null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;

    this.#disarm(session);
    session.finished = true;
    // Invariant 3: the status only turns terminal together with onFinished,
    // never before.
    session.status = status;
    session.listener.onFinished(status, exitCode);
  }

  #disarm(session: Session): void {
    for (const name of ['clock', 'escalation', 'safetyNet'] as const) {
      const timer = session[name];
      if (timer) clearTimeout(timer);
      session[name] = null;
    }
  }

  /**
   * Signals the process's whole group (negative pid).
   *
   * The process came up `detached`, so it leads its own group: the signal
   * reaches the child the engine left behind. If the group no longer exists, it
   * falls back to the direct process, and the final failure is ignored — the
   * target is already dead.
   */
  #signalGroup(session: Session, signal: NodeJS.Signals): void {
    const pid = session.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        session.child.kill(signal);
      } catch {
        /* already dead; nothing to do */
      }
    }
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
