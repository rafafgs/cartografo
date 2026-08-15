/**
 * `ClaudeCodeAdapter` — the first EngineAdapter, running the `claude` CLI
 * headless as a subprocess.
 *
 * "Claude Code is the first adapter, not a dependency"
 * (`notas/2026-08-14-arquitetura-brain-dump.md:11-14`). Everything specific to
 * this CLI lives here and in `command.ts`; above this line there is only
 * `SessionSpec`, `SessionStatus` and `SessionListener`.
 *
 * Three structural decisions, all of them coming from the scars recorded in the
 * specification:
 *
 * - **The process comes up detached, and signals go to the GROUP.** It is what
 *   makes C4 pass: an engine that leaves a child alive brings the runner's
 *   machine down after the hundredth session, not the first
 *   (`docs/formatos/engine-adapter.md:367-369`).
 * - **The end is decided on `close`, not on `exit`.** `close` only arrives once
 *   the pipes are closed, and that is what guarantees invariant 4 (every line
 *   emitted reaches `onOutput`) before invariant 1 (`onFinished` exactly once).
 * - **The clock is ours.** Neither of the two CLIs analysed has a timeout flag
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
  CLAUDE_BINARY,
  ENGINE_STDIO,
  type EngineCommand,
} from './command.ts';
import { resolvePermissions } from './permission-policy.ts';
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

/**
 * Credentials which, present in the environment, suggest an authenticable
 * session.
 *
 * "Suggest" is the right verb: `authenticated` is best effort by a recorded
 * decision of the specification — there is an engine whose credential failure
 * only shows up in the middle of the first session
 * (`engine-adapter.md:452-461`).
 */
export const CREDENTIAL_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * Prefix of every refusal for a policy this engine cannot express (t125, FR3).
 *
 * Stable on purpose: it is what lets a caller tell "the session did not come
 * up" from "the session was never going to come up, and here is the field to
 * fix". The reasons after it come from `permission-policy.ts` verbatim.
 */
export const PERMISSION_REFUSAL_PREFIX = 'permission policy unsupported: ';

export interface ClaudeCodeAdapterOptions {
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
  /** Credential file the preflight reads. Default `~/.claude.json`. */
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
 * The session id the engine itself gave, if this line is a recognized
 * `stream-json` frame.
 *
 * Demanding `type` and `session_id` is what separates a real frame from a log
 * line that happens to mention the word: the stream mixes structured frames
 * with a "dying scream in plain text" (`engine-adapter.md:209-214`), and
 * classifying it wrong here would produce a made-up `engineRef`.
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

  const { type, session_id: sessionId } = frame as { type?: unknown; session_id?: unknown };
  if (typeof type !== 'string' || typeof sessionId !== 'string' || sessionId === '') return null;
  return sessionId;
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly engineName = 'claude-code';

  readonly #sessions = new Map<string, Session>();
  readonly #commandBuilder: (spec: SessionSpec) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #graceMs: number;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;
  readonly #credentialsPath: string;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec) => buildCommand(spec));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.#probeCommandBuilder =
      options.probeCommandBuilder ?? (() => ({ command: CLAUDE_BINARY, args: ['--version'] }));
    this.#probeEnvironment = options.probeEnvironment ?? process.env;
    this.#credentialsPath = options.credentialsPath ?? join(homedir(), '.claude.json');
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    // BEFORE the spawn, and before anything is reported: a policy this engine
    // cannot express is a session that must not exist. Opening it and enforcing
    // less than what was declared is the one failure mode a permission system
    // may never have — and a half-open session would already have produced
    // output, a pid and a row somewhere.
    const { refusals } = resolvePermissions(spec.permissions);
    if (refusals.length > 0) {
      throw new SessionStartError(`${PERMISSION_REFUSAL_PREFIX}${refusals.join('; ')}`);
    }

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
   * `stream-json` is parseable, hence `hasStructuredOutput`. The other two stay
   * absent (default `false`): resume and usage accounting are out of v0 and
   * have no consumer — "declaring the fourth, fifth and sixth before anybody
   * reads them is how a format rots" (`engine-adapter.md:160-165`).
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
    // the exit code decides. `code` already arrives `null` when the process
    // died by a signal — in POSIX there is no exit code in that case, and
    // `null` is "there was none", never "zero" (`engine-adapter.md:227-234`).
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

  /** `claude --version`: a preflight that opens no session and spends no quota. */
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
   * Best effort, never a guarantee: a credential in the environment OR an OAuth
   * account recorded in the credential file. `true` means "I found no reason to
   * fail", not "it will authenticate" (`engine-adapter.md:245-252`).
   */
  #looksAuthenticated(): boolean {
    for (const name of CREDENTIAL_VARIABLES) {
      const value = this.#probeEnvironment[name];
      if (typeof value === 'string' && value.trim() !== '') return true;
    }

    try {
      const content: unknown = JSON.parse(readFileSync(this.#credentialsPath, 'utf8'));
      if (typeof content !== 'object' || content === null) return false;
      return Boolean((content as { oauthAccount?: unknown }).oauthAccount);
    } catch {
      // A missing, unreadable or corrupt file is no sign of authentication —
      // and much less a reason to bring a preflight down.
      return false;
    }
  }
}
