/**
 * `CopilotAdapter` — the third EngineAdapter, running the GitHub Copilot CLI
 * (`copilot`) headless as a subprocess (t675).
 *
 * It was measured against `@github/copilot@1.0.95` on 2026-10-12, method by
 * method, in `docs/formats/engine-adapter.md` ("Feasibility: a third CLI"), and
 * it implements `EngineAdapter` v1 with no interface change: the frozen
 * contract held for a third consumer, which is the point of having frozen it.
 *
 * The process lifecycle is DUPLICATED a third time from `codex-adapter.ts` and
 * `claude-code-adapter.ts`, on purpose and for the third time recorded: this
 * ticket's scope is the adapter, and extracting a common base from three copies
 * is a ticket of its own (named in the delivery report), not a thing to smuggle
 * into the one that adds the copy. What the three lifecycles share:
 *
 * - **The process comes up detached, and signals go to the GROUP** (C4).
 * - **The end is decided on `close`, not on `exit`**, so every line reaches
 *   `onOutput` (invariant 4) before `onFinished` runs exactly once (invariant 1).
 * - **The clocks are ours.** This CLI has no timeout flag either, so the adapter
 *   arms the wall clock and the t163 inactivity watchdog and escalates
 *   SIGTERM→SIGKILL.
 *
 * What is specific to this engine:
 *
 * - **The adapter chooses the engine ref.** The `--output-format json` stream
 *   has NO start frame: the session id appears only in the final `result` frame
 *   (`{"type":"result","sessionId":"<uuid>","exitCode":0,…}`, measured). So the
 *   adapter generates the UUID, passes it as `--session-id` ("set the UUID for a
 *   new session") and reports it through `onEngineRef` as soon as the process
 *   has spawned. Nothing is parsed for it.
 * - **The status is the exit code AND the terminal `result` frame.** A `result`
 *   frame with `exitCode != 0` is `failed` even if the process then exits 0; with
 *   no `result` frame (a process that died first) the exit code alone decides.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  buildCommand,
  buildEnvironment,
  buildProbeCommand,
  ENGINE_STDIO,
  type EngineCommand,
} from './copilot-command.ts';
import { PERMISSION_REFUSAL_PREFIX, resolveCopilotPermissions } from './copilot-permission-policy.ts';
import {
  SessionStartError,
  UnknownSessionError,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
  type SessionFinishDetail,
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
}

/** Which of the two watchdogs stopped a session, when one of ours did. */
type TimeoutReason = NonNullable<SessionFinishDetail['timeoutReason']>;

/** Local state of a live session. The adapter persists nothing (D1). */
interface Session {
  /** This adapter's own handle, so a timer can order a stop by it. */
  readonly id: string;
  readonly child: ChildProcess;
  readonly listener: SessionListener;
  status: SessionStatus;
  /** Terminal status asked for by whoever ordered the stop (cancel or clock). */
  requestedStatus: SessionStatus | null;
  /**
   * Which watchdog of OURS ordered the stop. `null` for a `cancel()` somebody
   * else drove — the caller knows their own reason, and inventing one here
   * would put a cause in the telemetry that nobody measured.
   */
  timeoutReason: TimeoutReason | null;
  finished: boolean;
  refSent: boolean;
  /**
   * `exitCode` of the terminal `result` frame, once one was seen on stdout.
   * `null` while none has been: a process that died first never prints it.
   */
  resultExitCode: number | null;
  clock: NodeJS.Timeout | null;
  /** Inactivity watchdog, re-armed on every raw chunk (t163). */
  silence: NodeJS.Timeout | null;
  /** Silence tolerated, in milliseconds. `0` = this session has no inactivity watchdog. */
  readonly silenceMs: number;
  escalation: NodeJS.Timeout | null;
  safetyNet: NodeJS.Timeout | null;
  /**
   * The `process.on('exit')` listener that takes this session's group down with
   * the runner, while it is live (t193, FR11). `null` once it is not.
   */
  exitBackstop: (() => void) | null;
  leftovers: { stdout: string; stderr: string };
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

  /** The sessions with a process still on the other side. */
  readonly #sessions = new Map<string, Session>();

  /**
   * One terminal status per session that already ended — what is left once
   * `#finish` drops everything else, so that invariant 3 ("`getStatus` only
   * returns a terminal status after `onFinished` has run") keeps answering.
   * Mirrored from the other two adapters, with the trade they record: one short
   * string per session this process ever dispatched.
   */
  readonly #terminalStatus = new Map<string, SessionStatus>();

  readonly #commandBuilder: (spec: SessionSpec, engineRef: string) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #graceMs: number;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;

  constructor(options: CopilotAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec, engineRef) => buildCommand(spec, engineRef));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.#probeCommandBuilder = options.probeCommandBuilder ?? buildProbeCommand;
    this.#probeEnvironment = options.probeEnvironment ?? process.env;
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
    // oversized composition (see `copilot-command.ts`). What invariant 6 forbids
    // is a pipe left open with nothing written and nothing closing it.
    const stdio = [...ENGINE_STDIO] as Array<'ignore' | 'pipe'>;
    if (command.stdin !== undefined) stdio[0] = 'pipe';

    let child: ChildProcess;
    try {
      child = spawn(command.command, [...command.args], {
        cwd: spec.workingDir,
        env: this.#environmentBuilder(spec),
        stdio,
        // Its own group: that is what allows signalling grandchildren along
        // with the parent.
        detached: true,
      });
    } catch (cause) {
      throw new SessionStartError(`could not start "${command.command}"`, { cause });
    }

    // Synchronously, right after the spawn, and the error listener FIRST: an
    // engine that exits before reading its stdin breaks the pipe, and an
    // unhandled `'error'` on a stream is an uncaught exception.
    if (command.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* the engine went away without reading; its exit is the real outcome */
      });
      child.stdin.end(command.stdin, 'utf8');
    }

    const id = randomUUID();
    const session: Session = {
      id,
      child,
      listener,
      status: 'pending',
      requestedStatus: null,
      timeoutReason: null,
      finished: false,
      refSent: false,
      resultExitCode: null,
      clock: null,
      silence: null,
      // `> 0` posture of the wall clock: absent, zero or negative is no
      // watchdog at all.
      silenceMs:
        typeof spec.silenceSeconds === 'number' && spec.silenceSeconds > 0
          ? spec.silenceSeconds * 1_000
          : 0,
      escalation: null,
      safetyNet: null,
      exitBackstop: null,
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
      this.#armExitBackstop(session);
      announceStart(null);

      // As soon as the process has spawned, exactly once: the id is already
      // known, and nothing in the stream could say it any earlier or better.
      if (!session.refSent) {
        session.refSent = true;
        listener.onEngineRef?.(engineRef);
      }
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

    // Two watchdogs, armed independently and cleared together. Whichever fires
    // first wins outright: `#stop` is a complete no-op once a stop is in flight.
    if (spec.timeoutSeconds > 0) {
      session.clock = setTimeout(() => {
        this.#stop(id, 'timed_out', 'wall_clock');
      }, spec.timeoutSeconds * 1_000);
    }
    this.#armSilence(session);

    return id;
  }

  /**
   * How many sessions this adapter still holds live — diagnostics only, and NOT
   * part of `EngineAdapter` (frozen v1): a seam of this class, in the family of
   * `commandBuilder` and `probeEnvironment`.
   */
  get liveSessionCount(): number {
    return this.#sessions.size;
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    const session = this.#sessions.get(sessionId);
    if (session) return session.status;

    // A session that ended: everything but its outcome was dropped on the way
    // through `#finish`, and the outcome is what invariant 3 promises.
    const terminal = this.#terminalStatus.get(sessionId);
    if (terminal !== undefined) return terminal;

    throw new UnknownSessionError(sessionId);
  }

  async cancel(sessionId: string, status: SessionStatus = 'cancelled'): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) {
      // A silent no-op, not an error: whoever cancels races with the adapter's
      // own streaming thread and has no way of knowing it lost the race.
      if (session.finished) return;
      this.#stop(sessionId, status);
      return;
    }

    if (this.#terminalStatus.has(sessionId)) return;

    throw new UnknownSessionError(sessionId);
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
   * (Re)arms the inactivity watchdog, if this session has one.
   *
   * Called at the start and on every raw chunk, which is what makes "silence"
   * mean what it says: the session is alive while the process is producing.
   */
  #armSilence(session: Session): void {
    if (session.silenceMs <= 0 || session.finished) return;
    if (session.silence) clearTimeout(session.silence);
    session.silence = setTimeout(() => {
      this.#stop(session.id, 'timed_out', 'silence');
    }, session.silenceMs);
  }

  /** Splits the stream into lines, keeping the `\n`-less tail for the next chunk. */
  #pump(session: Session, channel: 'stdout' | 'stderr', chunk: string): void {
    // On the RAW chunk, before any line-splitting: an engine that writes one
    // long unbroken line is producing output.
    this.#armSilence(session);

    const accumulated = session.leftovers[channel] + chunk;
    const parts = accumulated.split('\n');
    session.leftovers[channel] = parts.pop() ?? '';
    for (const line of parts) this.#emit(session, channel, line);
  }

  #emit(session: Session, channel: 'stdout' | 'stderr', line: string): void {
    // Invariant 2: after onFinished, no onOutput.
    if (session.finished) return;
    session.listener.onOutput(line);

    // The frames are on stdout; a `result`-looking line on stderr is not one.
    if (channel !== 'stdout') return;
    const resultExitCode = extractResultExitCode(line);
    if (resultExitCode !== null) session.resultExitCode = resultExitCode;
  }

  /** Natural end of the process: drains what is left and classifies the outcome. */
  #complete(id: string, code: number | null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;

    for (const channel of ['stdout', 'stderr'] as const) {
      const leftover = session.leftovers[channel];
      session.leftovers[channel] = '';
      if (leftover !== '') this.#emit(session, channel, leftover);
    }

    // Whoever ordered the stop has the last word on the status; without that,
    // the exit code decides — and the terminal `result` frame can only make the
    // verdict worse, never better: a frame saying `exitCode != 0` is `failed`
    // even if the process then exits 0. With no frame the exit code alone
    // decides. `code` arrives `null` when the process died by a signal — "there
    // was none", never "zero".
    const frameFailed = session.resultExitCode !== null && session.resultExitCode !== 0;
    const status = session.requestedStatus ?? (code === 0 && !frameFailed ? 'completed' : 'failed');
    this.#finish(id, status, code);
  }

  /**
   * Asks for a stop: SIGTERM to the group, SIGKILL after the grace.
   *
   * @param id The session's handle.
   * @param status Terminal status to report.
   * @param timeoutReason Which watchdog of ours ordered it, when one did. A
   *   `cancel()` from outside passes nothing: reporting a cause the caller
   *   never gave would be telemetry this adapter made up.
   */
  #stop(id: string, status: SessionStatus, timeoutReason: TimeoutReason | null = null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;
    // A stop is already in flight: this call is a COMPLETE no-op. Whoever
    // ordered the stop FIRST decides, which is what `cancel()`'s contract
    // promises (the escalation timer captures `status` in its closure, so a
    // second writer would make the outcome depend on SIGTERM vs SIGKILL).
    if (session.escalation) return;

    session.requestedStatus = status;
    session.timeoutReason = timeoutReason;
    this.#signalGroup(session, 'SIGTERM');

    session.escalation = setTimeout(() => {
      this.#signalGroup(session, 'SIGKILL');

      // Safety net for invariant 1 ("onFinished exactly once, always"): if not
      // even after the SIGKILL the `close` arrives, the outcome is reported all
      // the same.
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
    // Invariant 3: the status only turns terminal together with onFinished.
    session.status = status;
    // The cause only travels when one of our own watchdogs produced it.
    const reason = session.timeoutReason;
    session.listener.onFinished(
      status,
      exitCode,
      reason === null ? undefined : { timeoutReason: reason },
    );

    // AFTER the listener has been told, and only then: dropping it BEFORE the
    // call would hand `onFinished` an adapter that no longer knows the session
    // it is reporting.
    this.#sessions.delete(id);
    this.#terminalStatus.set(id, status);
  }

  #disarm(session: Session): void {
    for (const name of ['clock', 'silence', 'escalation', 'safetyNet'] as const) {
      const timer = session[name];
      if (timer) clearTimeout(timer);
      session[name] = null;
    }
    if (session.exitBackstop !== null) {
      process.off('exit', session.exitBackstop);
      session.exitBackstop = null;
    }
  }

  /**
   * Takes this session's process group down with the runner, while it is live.
   *
   * The backstop for every way the runner can end that is NOT an explicit
   * `cancel` (an uncaught exception elsewhere, a bare `process.exit()`).
   * SIGTERM only: `'exit'` is the last synchronous turn there is, so no
   * escalation. A `SIGKILL` of the runner itself runs no JavaScript at all, and
   * that orphan stays a limit.
   */
  #armExitBackstop(session: Session): void {
    session.exitBackstop = () => {
      this.#signalGroup(session, 'SIGTERM');
    };
    process.on('exit', session.exitBackstop);
  }

  /**
   * Signals the process's whole group (negative pid).
   *
   * The process came up `detached`, so it leads its own group. If the group no
   * longer exists, it falls back to the direct process, and the final failure is
   * ignored — the target is already dead.
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
