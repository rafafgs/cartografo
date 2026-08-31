/**
 * `ShellAdapter` — the third EngineAdapter, and the first one that runs no model
 * (t332).
 *
 * Route B of b3-radar's own #331. Its D15 rejected route A — an agent session
 * spending tokens to invoke a command — and left "a `shell` engine" as the right
 * answer "for the day the graph needs a deterministic node inside the trail".
 * That day is on record twice in the same file: `radar.promote` runs from
 * `bin/crossing.sh` BESIDE the job "because a graph node cannot run a script",
 * and the `record` node opens a whole agent session to type one `ledger add`.
 * Neither workaround gets what only a real node gets — the event log, the retry
 * ladder, the human-escalation policy.
 *
 * What this file is NOT is a second execution model bolted beside the first one.
 * Everything downstream of `onFinished` was already engine-agnostic: the fenced
 * ```resultado``` block is parsed by `parse-node-result.ts` without knowing which
 * engine printed it, `/finish` holds it against the pinned skill's `output`
 * whatever produced it, and the failure ladder counts sessions, not models. So a
 * shell node reports the way every other node reports, and this adapter's whole
 * job is to spawn a process and be honest about what happened to it.
 *
 * The process lifecycle is DELIBERATELY DUPLICATED from `codex-adapter.ts`,
 * which duplicated it from `claude-code-adapter.ts`. That was a recorded
 * decision at two adapters — "with only two adapters there is not yet evidence
 * of what shape the abstraction should have" — and this is the third, so the
 * decision is now genuinely due for review. It is deliberately NOT taken here:
 * extracting a base class in the same ticket that adds a new engine would mean
 * refactoring two certified adapters to serve a third that has not run in
 * production yet. What this file changes about that decision is that it is no
 * longer a hypothesis: three copies of a watchdog escalation is a real cost, and
 * the simplification ticket the other two headers hypothesized now has its
 * evidence.
 *
 * Where it legitimately DIVERGES from the other two, and why each time:
 *
 * - **No stdin channel and no ephemeral file.** There is no oversized content to
 *   route around: what would be large in an agent session — the instructions,
 *   the transcript — is not sent to this process at all.
 * - **No permission policy of its own, and no refusal for one.** The other two
 *   adapters refuse a policy they cannot express, which is the right rule for an
 *   engine that HAS a permission surface and might enforce less than was asked.
 *   This one has none to be dishonest about: what a spawned process may touch is
 *   the operating system's answer, and the only two things this adapter really
 *   controls are the working directory (invariant 7 — `cwd` is the session's
 *   whole scope) and the environment, which it closes by default
 *   (`shell-command.ts`, FR4). A skill's declared `permissions` therefore
 *   describe the command's own promise and are NOT enforced here. That is a real
 *   gap, it is written down as one rather than papered over, and closing it —
 *   with an OS sandbox — is the item `engine-adapter.md` has kept in "out of
 *   scope" since v0 for every engine.
 * - **No `engineRef`.** A process has a pid, and a pid is not an opaque handle
 *   anybody can resume from. `onEngineRef` is never called, which is exactly
 *   what "optional" on the listener means.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  SHELL_ENGINE_NAME,
  buildCommand,
  buildEnvironment,
  ENGINE_STDIO,
  type ShellCommand,
} from './shell-command.ts';
import {
  BASELINE_CAPABILITIES,
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

/**
 * Refusal of a session asked to continue an earlier one.
 *
 * A command has no context to continue INTO. Every run starts from the same
 * argv, and a caller handing back a `resumeFrom` is asking for something this
 * engine cannot mean — so it is refused at the door, before any process exists,
 * which is the branch C10 already certifies for an engine that does not declare
 * `hasResume`. Dropping the field silently would be the one failure nothing
 * downstream can detect.
 */
export const RESUME_REFUSAL_MESSAGE =
  'session continuation unsupported: the shell adapter runs a command, and a command has ' +
  'no earlier context to continue — open the session without resumeFrom';

export interface ShellAdapterOptions {
  /**
   * Test seam: what to spawn, in place of the skill's own argv.
   *
   * The same shape `commandBuilder` has on the other two adapters, and it exists
   * for the same reason — the conformance kit has to run against a controllable
   * fake — but it stands for something different. There the seam swaps a real
   * CLI for the fake engine; here there is no CLI, and what the seam supplies is
   * the argv the kit's own `SessionSpec`s cannot carry (the kit speaks the
   * interface, and the interface does not know which engine is under test).
   * Production never passes it.
   */
  readonly commandBuilder?: (spec: SessionSpec) => ShellCommand;
  /** Test seam: environment handed to the child. Default: the allowlist. */
  readonly environmentBuilder?: (spec: SessionSpec) => NodeJS.ProcessEnv;
  /** Wait between SIGTERM and SIGKILL. Default 5s. */
  readonly graceMs?: number;
}

/** Which of the two watchdogs stopped a session, when one of ours did. */
type TimeoutReason = NonNullable<SessionFinishDetail['timeoutReason']>;

/** Local state of a live session. The adapter persists nothing (D1). */
interface Session {
  readonly id: string;
  readonly child: ChildProcess;
  readonly listener: SessionListener;
  status: SessionStatus;
  requestedStatus: SessionStatus | null;
  timeoutReason: TimeoutReason | null;
  finished: boolean;
  clock: NodeJS.Timeout | null;
  silence: NodeJS.Timeout | null;
  /** Silence tolerated, in milliseconds. `0` = no inactivity watchdog. */
  readonly silenceMs: number;
  escalation: NodeJS.Timeout | null;
  safetyNet: NodeJS.Timeout | null;
  exitBackstop: (() => void) | null;
  leftovers: { stdout: string; stderr: string };
}

export class ShellAdapter implements EngineAdapter {
  readonly engineName = SHELL_ENGINE_NAME;

  /** The sessions with a process still on the other side. */
  readonly #sessions = new Map<string, Session>();

  /**
   * One terminal status per session that already ended (t207).
   *
   * Mirrored from the other two adapters, and it is what keeps invariant 3 —
   * "`getStatus` only returns a terminal status after `onFinished` has run" —
   * answerable once `#finish` has dropped everything else.
   */
  readonly #terminalStatus = new Map<string, SessionStatus>();

  readonly #commandBuilder: (spec: SessionSpec) => ShellCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #graceMs: number;

  constructor(options: ShellAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec) => buildCommand(spec));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    // BEFORE anything is built and long before anything is spawned, for the
    // reason the other two adapters refuse what they cannot do: an engine unable
    // to give what was asked has to say so at the door, never open a session
    // that quietly does less.
    if (spec.resumeFrom) {
      throw new SessionStartError(RESUME_REFUSAL_MESSAGE);
    }

    // Throws `SessionStartError` for a spec with nothing to run, which is the
    // whole reason the seam is pure: the refusal costs no process.
    const command = this.#commandBuilder(spec);

    let child: ChildProcess;
    try {
      child = spawn(command.command, [...command.args], {
        // Invariant 7: the working directory is this session's entire write
        // scope, and it is the caller's to choose — never this adapter's.
        cwd: spec.workingDir,
        env: this.#environmentBuilder(spec),
        stdio: [...ENGINE_STDIO],
        // No shell, and this is the load-bearing line of the file: with
        // `shell: true` every argument would be reparsed by `sh`, and a file
        // path with a space in it, a `$` or a backtick would stop being data.
        // The argv a manifest declared is the argv the kernel gets.
        shell: false,
        // Its own group: that is what allows signalling grandchildren along
        // with the parent, which is what C4 measures.
        detached: true,
      });
    } catch (cause) {
      throw new SessionStartError(`could not start "${command.command}"`, { cause });
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
      clock: null,
      silence: null,
      // Same `> 0` posture the wall clock has: absent, zero or negative is no
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

    // Every handler is registered NOW, synchronously: a command that dies fast
    // — and a deterministic step usually does — would fire `close` before a
    // registration deferred by an `await`, and the session would hang forever.
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
    });

    child.once('error', (error: Error) => {
      // A command that is not on the path arrives here as ENOENT, before
      // `spawn`: it is a session that never opened, not one that failed.
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
        announceStart(new Error(`the command closed before coming up (code ${String(code)})`));
        return;
      }
      this.#complete(id, code);
    });

    const failure = await start;
    if (failure) {
      this.#sessions.delete(id);
      throw new SessionStartError(
        `could not run "${command.command}" in "${spec.workingDir}"`,
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

  /** How many sessions this adapter still holds live — diagnostics only. */
  get liveSessionCount(): number {
    return this.#sessions.size;
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    const session = this.#sessions.get(sessionId);
    if (session) return session.status;

    const terminal = this.#terminalStatus.get(sessionId);
    if (terminal !== undefined) return terminal;

    throw new UnknownSessionError(sessionId);
  }

  async cancel(sessionId: string, status: SessionStatus = 'cancelled'): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session) {
      if (session.finished) return;
      this.#stop(sessionId, status);
      return;
    }

    if (this.#terminalStatus.has(sessionId)) return;

    throw new UnknownSessionError(sessionId);
  }

  /**
   * The baseline, whole and explicit.
   *
   * Not an empty object: a shell node has no resume to offer, emits no
   * structured frames of any engine's, and counts no tokens because it spends
   * none. Declaring any of the three would light up a capability with no
   * consumer, which is the way `types.ts` says a published format rots.
   */
  capabilities(): EngineCapabilities {
    return BASELINE_CAPABILITIES;
  }

  /**
   * The preflight, answered without probing anything.
   *
   * There is no external binary to ask. `available: true` because what this
   * adapter needs is the ability to spawn, and that belongs to the process it is
   * already running in; `version: null` because there is nothing whose version
   * this could be, and a made-up string would be a fact about a CLI that does
   * not exist; `authenticated: true` because the field means "I found no reason
   * to fail" and this engine has no credential to have found a reason in.
   *
   * Whether the skill's own `argv[0]` exists is deliberately NOT probed here:
   * that is a property of one session's manifest, not of the engine, and it
   * answers itself as a `SessionStartError` at the door of that session.
   */
  async verifyCli(): Promise<CliProbe> {
    return { available: true, version: null, authenticated: true };
  }

  /**
   * (Re)arms the inactivity watchdog, if this session has one.
   *
   * Called at the start and on every raw chunk, which is what makes "silence"
   * mean what it says: a long-running command that keeps printing is alive.
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
    // On the RAW chunk, before any line-splitting: a command that writes one
    // long unbroken line is producing output, and judging it silent because no
    // `\n` arrived yet would kill work that is happening.
    this.#armSilence(session);

    const accumulated = session.leftovers[channel] + chunk;
    const parts = accumulated.split('\n');
    session.leftovers[channel] = parts.pop() ?? '';
    for (const line of parts) this.#emit(session, line);
  }

  #emit(session: Session, line: string): void {
    // Invariant 2: after onFinished, no onOutput.
    if (session.finished) return;
    session.listener.onOutput(line);
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
    // the exit code decides, and it decides ALONE. There is no frame to parse
    // and no richer verdict to prefer: a command's exit status is the one thing
    // the operating system guarantees about it, and masking a non-zero behind a
    // `completed` would be this adapter inventing a verdict. `code` arrives
    // `null` when the process died by a signal — in POSIX there is no exit code
    // in that case, and `null` is "there was none", never "zero".
    const status = session.requestedStatus ?? (code === 0 ? 'completed' : 'failed');
    this.#finish(id, status, code);
  }

  /**
   * Asks for a stop: SIGTERM to the group, SIGKILL after the grace.
   *
   * @param id The session's handle.
   * @param status Terminal status to report.
   * @param timeoutReason Which watchdog of ours ordered it, when one did. A
   *   `cancel()` from outside passes nothing: reporting a cause the caller never
   *   gave would be telemetry this adapter made up.
   */
  #stop(id: string, status: SessionStatus, timeoutReason: TimeoutReason | null = null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;
    // A stop is already in flight: this call is a COMPLETE no-op. The escalation
    // timer below captures `status` in its closure, so a second writer to
    // `requestedStatus` would make the reported outcome depend on whether the
    // process died from the SIGTERM or from the SIGKILL. Whoever ordered the
    // stop FIRST is the one who decides (C8).
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
    const reason = session.timeoutReason;
    session.listener.onFinished(
      status,
      exitCode,
      reason === null ? undefined : { timeoutReason: reason },
    );

    // AFTER the listener has been told, and only then (t207): what is left is
    // the one string `getStatus` owes invariant 3.
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
   * Takes this session's process group down with the runner (t193).
   *
   * SIGTERM only, and no escalation: `'exit'` is the last synchronous turn this
   * process gets, there is no event loop left for a SIGKILL five seconds later,
   * and `await` is not allowed there. The one honest limit stays a limit: a
   * SIGKILL of the runner itself runs no JavaScript at all.
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
   * The process came up `detached`, so it leads its own group: the signal
   * reaches whatever the command spawned. If the group no longer exists it falls
   * back to the direct process, and the final failure is ignored — the target is
   * already dead.
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
}
