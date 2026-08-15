/**
 * The EngineAdapter interface — a literal transcription of
 * `docs/formatos/engine-adapter.md` § "Interface TypeScript".
 *
 * This file is NOT a place for design decisions. It is the specification
 * compiling: the `typescript` blocks of that section, in the order they appear,
 * carrying the same commentary in English (D18 — the document is a repo
 * document and stays in Portuguese; the code does not). Since t119 the
 * specification is **frozen at v1** (`engine-adapter.md:1-9`): the
 * two-consumers rule is satisfied, and growth from here is additive. That
 * makes `test/engine/spec-parity.test.ts` matter MORE, not less — it is the
 * gate that keeps the code from drifting away from a document that no longer
 * moves to meet it.
 *
 * What that gate compares is the set of EXPORTED SYMBOLS and their kinds, never
 * the prose around them: a change of symbol here without a change there (or the
 * other way round) breaks the parity test — on purpose. The document rules;
 * this module obeys.
 */

/**
 * Lifecycle of an agent session, in the minimum vocabulary every headless CLI
 * manages to express.
 *
 * `timed_out` exists apart from `failed` because the operational answer is a
 * different one: it was WE who killed the session when the clock ran out, and
 * the retry ladder can react to that without treating it as a bug of the work.
 * Engine-specific statuses (quota exhausted, resume expired) do NOT enter the
 * baseline — they are an extension of whoever has them, and a consumer that
 * branches on them has already broken boundary 1.
 */
export type SessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Statuses nothing transitions out of without a new action. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Everything an engine needs in order to run one unit of work. */
export interface SessionSpec {
  /** Directory the session runs in (typically a git worktree). */
  readonly workingDir: string;

  /**
   * The node's instructions, coming from the database. It is the node's
   * contract rendered — "the node's instructions come out of the database and
   * are injected into the session by the runner"
   * (`notas/2026-08-14-arquitetura-brain-dump.md:17-20`). Never out of
   * CLAUDE.md nor of a markdown file resident in the target repository.
   */
  readonly instructions: string;

  /** The content specific to this task/turn. See the normative rule below. */
  readonly prompt: string;

  /** Wall-clock limit; past it the session is killed. */
  readonly timeoutSeconds: number;

  /**
   * Seconds of SILENCE tolerated before the session is killed — a second
   * watchdog, independent of the wall clock, and measuring something else: the
   * clock says "this already cost too much", inactivity says "this stopped
   * happening". It restarts at every output of the process, so a session that
   * keeps talking is never stopped by it.
   *
   * Absent or `<= 0` means no inactivity watchdog, which is the posture the
   * wall clock already has through its own `> 0` guard, and the behaviour of
   * every session opened before this field existed.
   */
  readonly silenceSeconds?: number;

  /**
   * Opaque additions to the engine process's environment. Deliberately
   * untyped from this layer's point of view: what the keys mean is the
   * engine's business.
   */
  readonly envOverrides?: Readonly<Record<string, string>>;

  /**
   * What this session is allowed to touch. Absent = no restriction, which is
   * the behaviour of every session opened before this field existed.
   */
  readonly permissions?: SessionPermissions;
}

/**
 * Engine with no native system prompt: the adapter concatenates internally
 * (equivalent to what the flowpilot does today). The caller never sees it.
 */
export function composeSingleArgument(spec: SessionSpec): string {
  return `${spec.instructions}\n\n---\n\n${spec.prompt}`;
}

/**
 * Engine with a native flag: the instructions become the system prompt and the
 * prompt goes through untouched. Same `SessionSpec`, better injection — with
 * the caller knowing nothing about it.
 */
export function composeWithSystemPromptFlag(spec: SessionSpec): string[] {
  return ["--system-prompt", spec.instructions, spec.prompt];
}

/**
 * The permission policy of one session, as the skill manifest declares it (D4).
 *
 * The field the specification recorded as missing and left "for the D4 ticket"
 * (`engine-adapter.md`, tension 1). It is OPTIONAL for the same compatibility
 * reason as `EngineCapabilities`: growth of a published format is additive, and
 * a session that says nothing keeps the behaviour it had.
 *
 * `filesystem.leitura` of the manifest has no counterpart here on purpose:
 * declaring a field no adapter enforces would be exactly the dead capability
 * the specification refuses to accumulate.
 *
 * What an adapter does with this is ITS business, and it may legitimately be
 * "refuse the session": an engine unable to express a policy has to say so
 * before opening, never open a session that quietly enforces less than what was
 * asked.
 */
export interface SessionPermissions {
  readonly filesystem: { readonly write: readonly string[] };
  readonly network: { readonly allowed: boolean; readonly domains?: readonly string[] };
}

/**
 * What an engine does beyond the baseline.
 *
 * Every field is OPTIONAL by a compatibility decision: in a published format,
 * adding a mandatory flag breaks the compilation of every third-party adapter
 * that builds the object literally. Absent is `false` — the safe direction to
 * be wrong in.
 *
 * None of these flags has a consumer in v0; the three name exactly the
 * capabilities deferred in "Fora de escopo". Declaring the fourth, fifth and
 * sixth before anybody reads them is how a format rots.
 */
export interface EngineCapabilities {
  /** Continues an earlier session from an `engineRef`. */
  readonly hasResume?: boolean;
  /** Emits machine-readable frames, not just text. */
  readonly hasStructuredOutput?: boolean;
  /** The output carries aggregatable token accounting. */
  readonly reportsUsage?: boolean;
}

/** The baseline: a CLI that takes a prompt, runs commands and returns output. */
export const BASELINE_CAPABILITIES: Required<EngineCapabilities> = {
  hasResume: false,
  hasStructuredOutput: false,
  reportsUsage: false,
};

/** Normalizes what an adapter declared against the baseline. */
export function resolveCapabilities(
  declared: EngineCapabilities = {},
): Required<EngineCapabilities> {
  return {
    hasResume: declared.hasResume ?? false,
    hasStructuredOutput: declared.hasStructuredOutput ?? false,
    reportsUsage: declared.reportsUsage ?? false,
  };
}

/**
 * What the adapter knows about a terminal outcome, beyond the status itself.
 *
 * It exists for one fact and is deliberately narrow: with two watchdogs, a
 * `timed_out` no longer says which one bit. Growing `SessionStatus` instead was
 * already rejected once, for quota/limit states, and the reasoning applies
 * unchanged — "the real reason lives in the event log, which is append-only and
 * loses nothing" (`engine-adapter.md`, "Rejeitado — `SessionStatus` mais rico").
 * One status, one cause beside it.
 *
 * Optional in every direction: the parameter, the field, and what a consumer
 * does with it. An adapter that has nothing to add reports two arguments, as it
 * always did.
 */
export interface SessionFinishDetail {
  /**
   * Which watchdog stopped the session, when the ADAPTER itself decided to.
   *
   * Absent for a `cancel()` an external caller drove: whoever cancelled knows
   * their own reason, and inventing one here would put a cause in the telemetry
   * that nobody measured.
   */
  readonly timeoutReason?: 'wall_clock' | 'silence';
}

/**
 * The one way everything a session produces leaves the adapter.
 *
 * Nothing escapes through an engine-specific channel: what the caller needs
 * arrives here, and that is what allows appending to the event log and
 * updating the session row without knowing which CLI ran (D1 — the adapter
 * reports, the server writes).
 */
export interface SessionListener {
  /**
   * One line emitted by the engine (stdout and stderr merged, in arrival
   * order), raw and unparsed. Raw is a requirement: not every line is a
   * structured frame — a CLI writes its dying scream in plain text in the
   * middle of the stream, and the log is only replayable (event sourcing) if
   * it keeps both.
   */
  onOutput(line: string): void;

  /**
   * The identifier the engine itself gave the session, as soon as it is known.
   *
   * Optional and an opaque string: every CLI calls this something else and
   * none guarantees the format. Captured today only for telemetry and audit —
   * resume is out of scope. It exists now because it is cheap to add before
   * there is a published adapter and expensive to bolt on afterwards.
   */
  onEngineRef?(engineRef: string): void;

  /**
   * Called EXACTLY ONCE, on reaching a terminal status.
   *
   * `exitCode` is `number | null`: in POSIX, a process killed by a signal has
   * no exit code, and that is precisely what happens in the kit's timeout and
   * cancellation cases. `null` is "there was none", not "zero".
   *
   * `detail` is populated only when the adapter has something the status does
   * not carry — today, which of the two watchdogs stopped the session. A
   * consumer written before it existed keeps working: an extra argument to a
   * two-parameter callback is ignored.
   */
  onFinished(
    status: SessionStatus,
    exitCode: number | null,
    detail?: SessionFinishDetail,
  ): void;
}

/** Result of the CLI preflight, consumed by the install wizard. */
export interface CliProbe {
  /** The binary exists and answers. */
  readonly available: boolean;
  readonly version: string | null;
  /**
   * Best effort, never a guarantee: there is an engine whose credential
   * failure only shows up in the middle of the first session (see
   * "Viabilidade"). `true` means "I found no reason to fail", not "it will
   * authenticate".
   */
  readonly authenticated: boolean;
}

export interface EngineAdapter {
  /** Stable identifier, persisted on the session row. */
  readonly engineName: string;

  /**
   * Opens a session and returns THIS ADAPTER'S LOCAL handle for it — which is
   * not the engine's `engineRef` and must not be confused with it.
   *
   * Resolves as soon as the session is up; the work goes on and is reported
   * through the listener. Rejects with `SessionStartError` if it did not come
   * up.
   */
  startSession(spec: SessionSpec, listener: SessionListener): Promise<string>;

  /** Current status. Throws `UnknownSessionError` for an unknown handle. */
  getStatus(sessionId: string): Promise<SessionStatus>;

  /**
   * Stops a session in flight; a no-op if it already ended.
   *
   * `status` is the terminal status to report through `onFinished`, default
   * `"cancelled"` (somebody pressed the button). A watchdog passes
   * `"timed_out"`. Recording the reason HERE is what takes the watchdog out of
   * the race with the adapter's own streaming thread: the alternative —
   * cancelling and then overwriting the row the thread has just written —
   * loses whichever write arrives last.
   *
   * Throws `UnknownSessionError` for an unknown handle.
   */
  cancel(sessionId: string, status?: SessionStatus): Promise<void>;

  /**
   * Declares what this engine does beyond the baseline. Logically not
   * mandatory: an adapter with nothing to say returns
   * `BASELINE_CAPABILITIES`, and the safe default is every flag false.
   */
  capabilities(): EngineCapabilities;

  /** Preflight without spending quota. */
  verifyCli(): Promise<CliProbe>;
}

export class EngineError extends Error {}

/** The session could not be opened (missing binary, missing workdir, spawn). */
export class SessionStartError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStartError";
  }
}

/**
 * The handle never existed IN THIS ADAPTER.
 *
 * `getStatus` and `cancel` over an unknown handle THROW — they never return a
 * made-up status. A consolation `"failed"` here becomes, further up, a live
 * session marked as dead, and the difference between "I do not know" and "it
 * went wrong" is exactly what telemetry has to preserve.
 */
export class UnknownSessionError extends EngineError {
  constructor(public readonly sessionId: string) {
    super(`Unknown session handle: ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}
