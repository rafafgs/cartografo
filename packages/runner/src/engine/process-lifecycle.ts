/**
 * `ProcessLifecycle` — the session lifecycle the three CLI adapters share
 * (t678).
 *
 * t119 duplicated `ClaudeCodeAdapter`'s lifecycle into `CodexAdapter` on
 * purpose: with two adapters there was no evidence of what shape the
 * abstraction should have. t675 added `CopilotAdapter`, the third copy, and the
 * three side by side were that evidence. This module is the two-consumers rule
 * applied one level down: what all three did line for line lives here, and a
 * hook exists only where at least two of them already did a thing differently.
 *
 * A COMPOSITION helper, not a base class: each adapter owns one and delegates
 * to it, so each public class keeps its own `#` fields, its own `engineName`
 * and its own `liveSessionCount`. It is runner-internal; `EngineAdapter` (v1,
 * `types.ts`) does not change.
 *
 * Three structural decisions, all of them coming from the scars recorded in the
 * specification:
 *
 * - **The process comes up detached, and signals go to the GROUP.** It is what
 *   makes C4 pass: an engine that leaves a child alive brings the runner's
 *   machine down after the hundredth session, not the first
 *   (`docs/formats/engine-adapter.md:367-369`).
 * - **The end is decided on `close`, not on `exit`.** `close` only arrives once
 *   the pipes are closed, and that is what guarantees invariant 4 (every line
 *   emitted reaches `onOutput`) before invariant 1 (`onFinished` exactly once).
 * - **The clocks are ours.** None of the three CLIs has a timeout flag
 *   (`engine-adapter.md:407`), so the lifecycle arms them, escalates
 *   SIGTERM→SIGKILL and disarms them. Since t163 there are two: the wall clock,
 *   armed once, and the inactivity watchdog, re-armed on every chunk the process
 *   writes. They answer different questions — "this already cost too much" and
 *   "this stopped happening" — and whichever fires first wins outright.
 *
 * What stays in each adapter: the refusals before the spawn, the command and
 * environment builders, and anything only one engine does (Claude Code's
 * ephemeral system-prompt file is written and removed by that adapter).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  SessionStartError,
  UnknownSessionError,
  type SessionFinishDetail,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
} from './types.ts';

/** The two streams a session's lines arrive on. */
export type LifecycleChannel = 'stdout' | 'stderr';

/** Which of the two watchdogs stopped a session, when one of ours did. */
type TimeoutReason = NonNullable<SessionFinishDetail['timeoutReason']>;

/** What the lifecycle spawns: the common shape of the three `EngineCommand`s. */
export interface LifecycleCommand {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * What is written to the process's stdin, when the content did not fit in
   * the argv. Absent means stdin stays closed (invariant 6).
   */
  readonly stdin?: string;
}

/**
 * The hooks, fixed for the lifetime of one adapter. Each optional one exists
 * because at least two adapters do that thing differently.
 */
export interface LifecycleHooks<State> {
  /** Wait between SIGTERM and SIGKILL, and again before the safety net. */
  readonly graceMs: number;
  /**
   * The engine ref read off a line (Claude Code, Codex). Asked of every line
   * until one answers, and only if the listener has `onEngineRef`.
   */
  readonly extractEngineRef?: (line: string) => string | null;
  /** Per-line work on the adapter's own state (Claude Code, Copilot), after `onOutput`. */
  readonly onLine?: (state: State, line: string, channel: LifecycleChannel) => void;
  /**
   * Status of a natural end nobody ordered a stop for. Default: the exit code
   * alone, `code === 0 ? 'completed' : 'failed'` (Copilot overrides it).
   */
  readonly classifyExit?: (code: number | null, state: State) => SessionStatus;
  /**
   * The `SessionFinishDetail` pieces beyond `timeoutReason` (Claude Code).
   * Default: none. An empty object adds nothing.
   */
  readonly finishDetail?: (state: State) => Omit<SessionFinishDetail, 'timeoutReason'>;
}

/** One session's launch, built by the adapter after its refusals. */
export interface LifecycleLaunch<State> {
  readonly command: LifecycleCommand;
  /**
   * The engine's environment, built inside the spawn's `try`: a builder that
   * throws is a session that could not start, like a spawn that throws.
   */
  readonly environment: () => NodeJS.ProcessEnv;
  /** The adapter's own per-session state, handed to every hook. */
  readonly state: State;
  /**
   * An engine ref the adapter chose up front (Copilot): announced exactly once,
   * as soon as the process has spawned, and no line is asked for one.
   */
  readonly engineRef?: string;
}

/** What of a `SessionSpec` the lifecycle reads. */
export type LifecycleSpec = Pick<SessionSpec, 'workingDir' | 'timeoutSeconds' | 'silenceSeconds'>;

/**
 * The `stdio` every session gets: stdin closed, both outputs piped (invariant
 * 6). The same value each command module exports and its own test pins.
 */
const ENGINE_STDIO = ['ignore', 'pipe', 'pipe'] as const;

/** Local state of a live session. The adapter persists nothing (D1). */
interface Session<State> {
  /** The handle, so a timer can order a stop by it. */
  readonly id: string;
  readonly child: ChildProcess;
  readonly listener: SessionListener;
  readonly state: State;
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

export class ProcessLifecycle<State> {
  /** The sessions with a process still on the other side. */
  readonly #sessions = new Map<string, Session<State>>();

  /**
   * One terminal status per session that already ended (t207).
   *
   * The stub that lets `#finish` drop everything else. Invariant 3 of the frozen
   * contract — "`getStatus` only returns a terminal status after `onFinished`
   * has run" (`docs/formats/engine-adapter.md:844`) — is answerable from a
   * string, and a string is all a session that is over needs to leave behind:
   * the `ChildProcess`, the caller's listener (in the real dispatch it closes
   * over the whole transcript buffer), the timers and the leftovers all go.
   *
   * It grows with the number of sessions this process ever dispatched, one short
   * string per id, and that is an accepted trade and not a leak deferred: a TTL
   * would make `getStatus` answer differently depending on WHEN it is asked,
   * which is precisely the invariant four cases of the kit (C1, C3, C8, C9)
   * pin down.
   */
  readonly #terminalStatus = new Map<string, SessionStatus>();

  readonly #hooks: LifecycleHooks<State>;

  constructor(hooks: LifecycleHooks<State>) {
    this.#hooks = hooks;
  }

  /**
   * Spawns the engine and resolves with the session's handle once it is up.
   *
   * Rejects with `SessionStartError` when the process could not be started or
   * did not come up; such a session never reaches the listener.
   */
  async start(spec: LifecycleSpec, listener: SessionListener, launch: LifecycleLaunch<State>): Promise<string> {
    const { command } = launch;

    // `stdin` piped only when there is something to write into it. Invariant 6
    // forbids the third shape — a pipe open with nothing written and nothing
    // closing it — and the write below runs under exactly the same condition.
    const stdio = [...ENGINE_STDIO] as Array<'ignore' | 'pipe'>;
    if (command.stdin !== undefined) stdio[0] = 'pipe';

    let child: ChildProcess;
    try {
      child = spawn(command.command, [...command.args], {
        cwd: spec.workingDir,
        env: launch.environment(),
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
    // unhandled `'error'` on a stream is an uncaught exception — the runner
    // dying over one session's fast exit. A broken pipe is not a session
    // failure; the process's own exit is the outcome, reported through `close`.
    if (command.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        /* the engine went away without reading; its exit is the real outcome */
      });
      child.stdin.end(command.stdin, 'utf8');
    }

    const id = randomUUID();
    const session: Session<State> = {
      id,
      child,
      listener,
      state: launch.state,
      status: 'pending',
      requestedStatus: null,
      timeoutReason: null,
      finished: false,
      refSent: false,
      clock: null,
      silence: null,
      // Same `> 0` posture the wall clock has: absent, zero or negative is no
      // watchdog at all, which is what every session had before this existed.
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

      // An up-front ref is already known, and nothing in the stream could say
      // it any earlier or better: as soon as the process has spawned, once.
      if (launch.engineRef !== undefined && !session.refSent) {
        session.refSent = true;
        listener.onEngineRef?.(launch.engineRef);
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
    // first wins outright: `#stop` is a complete no-op once a stop is in
    // flight, which is the same discipline C8 already demands of `cancel()`.
    if (spec.timeoutSeconds > 0) {
      session.clock = setTimeout(() => {
        this.#stop(id, 'timed_out', 'wall_clock');
      }, spec.timeoutSeconds * 1_000);
    }
    this.#armSilence(session);

    return id;
  }

  /** How many sessions still have a process on the other side; the stubs are not counted. */
  get liveSessionCount(): number {
    return this.#sessions.size;
  }

  getStatus(sessionId: string): SessionStatus {
    const session = this.#sessions.get(sessionId);
    if (session) return session.status;

    // A session that ended: everything but its outcome was dropped on the way
    // through `#finish`, and the outcome is what invariant 3 promises.
    const terminal = this.#terminalStatus.get(sessionId);
    if (terminal !== undefined) return terminal;

    throw new UnknownSessionError(sessionId);
  }

  cancel(sessionId: string, status: SessionStatus = 'cancelled'): void {
    const session = this.#sessions.get(sessionId);
    if (session) {
      // A silent no-op, not an error: whoever cancels races with the adapter's
      // own streaming thread and has no way of knowing it lost the race. It
      // survives here for the window between `#finish` clearing the map and a
      // caller that still holds the handle — the same "already finished" C5
      // covers, now answered from the stub below.
      if (session.finished) return;
      this.#stop(sessionId, status);
      return;
    }

    if (this.#terminalStatus.has(sessionId)) return;

    throw new UnknownSessionError(sessionId);
  }

  /**
   * (Re)arms the inactivity watchdog, if this session has one.
   *
   * Called at the start and on every raw chunk, which is what makes "silence"
   * mean what it says: the session is alive while the process is producing,
   * whatever the produce happens to parse into.
   */
  #armSilence(session: Session<State>): void {
    if (session.silenceMs <= 0 || session.finished) return;
    if (session.silence) clearTimeout(session.silence);
    session.silence = setTimeout(() => {
      this.#stop(session.id, 'timed_out', 'silence');
    }, session.silenceMs);
  }

  /** Splits the stream into lines, keeping the `\n`-less tail for the next chunk. */
  #pump(session: Session<State>, channel: LifecycleChannel, chunk: string): void {
    // On the RAW chunk, before any line-splitting: an engine that writes one
    // long unbroken line is producing output, and judging it silent because no
    // `\n` arrived yet would kill a session that is working.
    this.#armSilence(session);

    const accumulated = session.leftovers[channel] + chunk;
    const parts = accumulated.split('\n');
    session.leftovers[channel] = parts.pop() ?? '';
    for (const line of parts) this.#emit(session, channel, line);
  }

  #emit(session: Session<State>, channel: LifecycleChannel, line: string): void {
    // Invariant 2: after onFinished, no onOutput.
    if (session.finished) return;
    session.listener.onOutput(line);

    this.#hooks.onLine?.(session.state, line, channel);

    const extract = this.#hooks.extractEngineRef;
    if (extract === undefined || session.refSent || !session.listener.onEngineRef) return;
    const ref = extract(line);
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
      if (leftover !== '') this.#emit(session, channel, leftover);
    }

    // Whoever ordered the stop has the last word on the status; without that,
    // the classifier decides, and by default the exit code alone. `code`
    // already arrives `null` when the process died by a signal — in POSIX there
    // is no exit code in that case, and `null` is "there was none", never
    // "zero" (`engine-adapter.md:227-234`).
    const classify = this.#hooks.classifyExit;
    const status =
      session.requestedStatus ??
      (classify ? classify(code, session.state) : code === 0 ? 'completed' : 'failed');
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
    // A stop is already in flight: this call is a COMPLETE no-op — it does not
    // overwrite the status, does not signal again, does not re-arm anything.
    // The order matters, and it is the whole point: the escalation timer below
    // captures `status` in its closure, so a second writer to
    // `requestedStatus` would make the reported outcome depend on whether the
    // process died from the SIGTERM (the closure's status) or from the SIGKILL
    // (the last writer's). Whoever ordered the stop FIRST is the one who
    // decides — which is what `cancel()`'s contract already promises
    // (`types.ts:236-241`).
    if (session.escalation) return;

    session.requestedStatus = status;
    session.timeoutReason = timeoutReason;
    this.#signalGroup(session, 'SIGTERM');

    session.escalation = setTimeout(() => {
      this.#signalGroup(session, 'SIGKILL');

      // Safety net for invariant 1 ("onFinished exactly once, always"): if not
      // even after the SIGKILL the `close` arrives, the outcome is reported all
      // the same. A session hanging forever is worse than a session reported
      // without its last line, and this path should not happen — killing the
      // group closes the pipes.
      session.safetyNet = setTimeout(() => {
        this.#finish(id, status, null);
      }, this.#hooks.graceMs);
    }, this.#hooks.graceMs);
  }

  /**
   * The one funnel every terminal path goes through: natural completion, either
   * watchdog, a `cancel()`, the escalation's safety net and the post-spawn
   * `error`.
   */
  #finish(id: string, status: SessionStatus, exitCode: number | null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;

    this.#disarm(session);
    session.finished = true;
    // Invariant 3: the status only turns terminal together with onFinished,
    // never before.
    session.status = status;
    // The cause travels only when one of our own watchdogs produced it; it is
    // set beside `requestedStatus`, so it can only ever accompany the status
    // that watchdog asked for. The adapter's pieces follow it, and `undefined`
    // for the whole object when there is nothing at all keeps the shape every
    // consumer written before t163 already handles.
    const detail: SessionFinishDetail = {
      ...(session.timeoutReason === null ? {} : { timeoutReason: session.timeoutReason }),
      ...this.#hooks.finishDetail?.(session.state),
    };
    session.listener.onFinished(
      status,
      exitCode,
      Object.keys(detail).length === 0 ? undefined : detail,
    );

    // AFTER the listener has been told, and only then (t207): everything this
    // session was holding — the `ChildProcess`, the caller's listener, the
    // adapter's state, the leftovers — becomes garbage the moment the map lets
    // go, and what is left is the one string `getStatus` owes invariant 3. The
    // order is the whole point: dropping it BEFORE the call would hand
    // `onFinished` an adapter that no longer knows the session it is reporting.
    this.#sessions.delete(id);
    this.#terminalStatus.set(id, status);
  }

  #disarm(session: Session<State>): void {
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
   * Takes this session's process group down with the runner (t193, FR11).
   *
   * The backstop, and only that: t193 gave the runner an explicit shutdown that
   * cancels a live session through the adapter's `cancel`, and this covers
   * every OTHER way the process can end — an uncaught exception somewhere else,
   * a bare `process.exit()`, a `finally` that never ran. Without it, the engine
   * is reparented to init and goes on writing in a worktree nobody is left to
   * give back.
   *
   * SIGTERM only, and no escalation: `'exit'` is the last synchronous turn this
   * process gets. There is no event loop left for a SIGKILL five seconds later,
   * and an engine that ignores SIGTERM survives this path — which is precisely
   * why it is the backstop and not the plan. A `SIGKILL` of the runner itself
   * runs no JavaScript at all, `'exit'` never fires, and that orphan stays a
   * limit.
   */
  #armExitBackstop(session: Session<State>): void {
    session.exitBackstop = () => {
      this.#signalGroup(session, 'SIGTERM');
    };
    process.on('exit', session.exitBackstop);
  }

  /**
   * Signals the process's whole group (negative pid).
   *
   * The process came up `detached`, so it leads its own group: the signal
   * reaches the child the engine left behind. If the group no longer exists, it
   * falls back to the direct process, and the final failure is ignored — the
   * target is already dead.
   */
  #signalGroup(session: Session<State>, signal: NodeJS.Signals): void {
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
