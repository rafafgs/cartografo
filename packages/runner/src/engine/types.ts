/**
 * The EngineAdapter interface — a literal transcription of
 * `docs/formats/engine-adapter.md` § "Interface TypeScript".
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
   * (`notas/2026-08-14-architecture-brain-dump.md:17-20`). Never out of
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
   * An earlier session's `engineRef`, to be continued instead of started
   * fresh — the same opaque string `onEngineRef` reported for it.
   *
   * Absent (or empty) means a brand-new session, which is the behaviour of
   * every session opened before this field existed. Present means the caller
   * is asking for that session's context back, and an adapter that cannot do
   * it has to REFUSE before opening — same honesty rule as `permissions`
   * below. Losing this field silently is the one failure nothing downstream
   * can detect: a session that resumed nothing looks exactly like a session
   * that resumed.
   *
   * What continuing requires beyond the ref is the engine's business, and it
   * is not always only the ref. Measured on `claude-code` (t173, and it
   * contradicted what the ficha assumed): there the ref is enough, and
   * `workingDir` does not participate — the same ref recalled the same context
   * from a directory that session had never seen.
   */
  readonly resumeFrom?: string;

  /**
   * Which model of the engine runs this session, when the node pinned one.
   *
   * Absent means the ENGINE'S OWN default: no model flag is assembled at all,
   * and the argv is byte-identical to what it was before this field existed.
   * That is the same discipline `silenceSeconds` and `permissions` follow, and
   * it is the only honest default — this layer has no way to know which models
   * a given installation has access to, and inventing one here would put a
   * choice nobody made into the telemetry.
   *
   * An unknown or mistyped identifier is refused by the engine itself, at
   * session start, as an ordinary `SessionStartError` or a failed session. The
   * catalog `listModels()` publishes is advisory discovery, never a gate.
   */
  readonly model?: string;

  /**
   * What this work COSTS to run, as the intake triaged it (t175).
   *
   * Not `model` under another name, and the difference is one of layer. `model`
   * is the id the GRAPH pinned for this node: engine vocabulary, crossing the
   * boundary because a graph document wrote it. `modelTier` is THIS interface's
   * vocabulary — two values of ours — and it is the adapter that answers, each
   * in its own language, what "trivial" costs there. That is what lets the
   * runner ask for the cheap one without ever knowing which model is the cheap
   * one for any CLI.
   *
   * **`model` wins over `modelTier`.** When both arrive, the adapter assembles
   * ONE model flag and the value is `model`'s: a model id is a decision
   * somebody recorded in a graph document, and a triage heuristic does not
   * overrule a recorded decision. Assembling both would be an argv with two
   * model flags, which is not a preference — it is a broken command.
   *
   * Absent is "not triaged", which is the behaviour of every session opened
   * before this field existed. `standard` assembles no flag either: it asserts
   * "the engine's default is fine", a different sentence from "nobody
   * classified this", and it produces the same argv on purpose — the closed
   * pair exists so the triage can say both things, not so the adapter can act
   * on both.
   *
   * The set is closed, unlike `model`'s: a third value here is not new data
   * some engine understands, it is a mistake by whoever wrote it.
   */
  readonly modelTier?: 'trivial' | 'standard';

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
 * `hasResume` got its consumer in t173 (`SessionSpec.resumeFrom`) and
 * `reportsUsage` in t172 (`SessionFinishDetail.usage`), by the same road: the
 * capability was in the CLI all along, and what was missing was somebody
 * reading it. All three have one now, and the rule that governed all three
 * still holds for the fourth — declaring the fourth, fifth and sixth before
 * anybody reads them is how a format rots.
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
 * The token totals of a session, frozen at the end of its life.
 *
 * The four keys are exactly the ones the event taxonomy's `uso` has demanded
 * since t98 — this type is the adapter's side of the same accounting, and the
 * names matching is what lets the counts cross from the interface into the log
 * with no translation in between. There is no money field: cost is engine
 * vocabulary, and the price list belongs to whoever has one.
 *
 * **Four, and only four.** A real CLI reports considerably more than that in
 * its terminal frame (service tier, cache breakdown, iterations), and the log's
 * contract closes `additionalProperties`. Whoever implements this type PICKS
 * the four; an adapter that forwards the engine's whole object hands its
 * consumer a payload the control plane refuses.
 */
export interface SessionUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
}

/**
 * What the adapter knows about a terminal outcome, beyond the status itself.
 *
 * It was born for one fact and deliberately narrow: with two watchdogs, a
 * `timed_out` no longer says which one bit. Growing `SessionStatus` instead was
 * already rejected once, for quota/limit states, and the reasoning applies
 * unchanged — "the real reason lives in the event log, which is append-only and
 * loses nothing" (`engine-adapter.md`, "Rejeitado — `SessionStatus` mais rico").
 * One status, one cause beside it.
 *
 * It is also this frozen interface's additive growth point, and t172 cashed
 * that in: the two accounting fields below arrived here without touching
 * `EngineAdapter`'s shape or `onFinished`'s signature.
 *
 * Optional in every direction: the parameter, each field, and what a consumer
 * does with them. An adapter that has nothing to add reports two arguments, as
 * it always did.
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

  /**
   * The tokens the session spent, when the engine reported them (t172).
   *
   * Absent is "the engine did not count" — a session that died before the
   * terminal frame, a malformed frame, or a build of the CLI that omits the
   * accounting. An object of zeros in place of the absence is the one forbidden
   * reading: zero is a measurement, absence is silence, and merging the two
   * destroys the whole cost metric (the same rule the taxonomy's `uso` has
   * carried since t98).
   */
  readonly usage?: SessionUsage;

  /**
   * Which models ran the session, when the engine named them (t172).
   *
   * A list, and not a single identifier, because a session runs more than one
   * model: measured against the real CLI, a single turn already gave back two —
   * the main turn's, and a cheaper helper's. Collapsing to "the" model would
   * charge the whole bill to the wrong one, which is the same mistake the rule
   * above forbids for tokens.
   *
   * Absent follows the same discipline as `usage`; an empty list is no answer.
   */
  readonly models?: readonly string[];

  /**
   * What KIND of failure this was, when the engine said something the status
   * cannot carry (t265).
   *
   * The third use of this interface's additive-growth point, and it is here for
   * the same reason `timeoutReason` is: `failed` is one word for two facts that
   * deserve different answers. A crash is worth retrying — the process died, and
   * the next attempt may not. An engine REFUSAL is not: measured in t198, the
   * same prompt was refused four times in a row before a fifth session worked,
   * so a consumer that retries it is buying the same answer again.
   *
   * A closed set of one, and the opposite openness decision from
   * `refusalCategory` below: this word is OURS. A second value enters here when a
   * second failure kind is measured, never because an engine invented one.
   *
   * Absent is the ordinary case and covers every session opened before this
   * field existed — a crash, a clean end, a cancel. It is never inferred from an
   * exit code: a non-zero exit is what a refusal and a crash have in common,
   * which is exactly why this field had to exist.
   */
  readonly failureKind?: 'engine_refusal';

  /**
   * How the engine itself classified the refusal, when it classified it (t265).
   *
   * The engine's own word, verbatim and unmapped — `reasoning_extraction` is
   * what the bisection read off the real frame. Open vocabulary, like `models`
   * and unlike `failureKind`: a closed enum here would need a release of this
   * file every time an engine names a new category, and a category nobody could
   * record is a diagnosis nobody can make.
   *
   * Absent is "the engine refused and said no more than that", which is a real
   * shape of the frame and not a defect — the refusal itself already travels in
   * `failureKind`.
   */
  readonly refusalCategory?: string;
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
   * none guarantees the format. It was captured for telemetry and audit before
   * anything could use it, "cheap to add before there is a published adapter
   * and expensive to bolt on afterwards" — and t173 cashed that in: this is the
   * value that goes back into `SessionSpec.resumeFrom` to continue a session.
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

/**
 * One model an engine offers.
 *
 * `id` is the identifier that goes after the engine's model flag — the string
 * a node's `model` has to match — and nothing else: not a display name, not a
 * family alias the CLI happens to resolve. `label` is what a person reads, when
 * the adapter has one to give.
 *
 * `origin` is the field that keeps the catalog honest. `cli` means the binary
 * was asked and answered; `catalog` means the adapter is reciting a list it
 * carries. Collapsing the two would make "these are the models" a claim nobody
 * can weigh, which is the same demotion `CliProbe.authenticated` already took —
 * and both adapters answer `catalog` today, because neither CLI exposes a
 * listing surface (measured, not assumed).
 */
export interface EngineModel {
  readonly id: string;
  readonly label?: string;
  readonly origin: 'cli' | 'catalog';
}

/**
 * Everything an engine says it can run, at one instant.
 *
 * `resolvedAt` is not decoration: a static catalog and a CLI answer age
 * differently, and a consumer with no timestamp cannot tell a fresh report from
 * one a runner left behind before it died.
 */
export interface ModelCatalog {
  readonly models: readonly EngineModel[];
  readonly resolvedAt: string;
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

  /**
   * Which models this engine can run, as far as the adapter can tell.
   *
   * The METHOD is optional, not just its fields, and that is the compatibility
   * claim: a third-party adapter written before this existed keeps compiling,
   * which is what "growth of a published format is additive" has to mean once
   * the interface is frozen at v1. A consumer checks for the method before
   * calling it and skips the adapter that does not have one.
   *
   * Discovery, never enforcement: nothing validates a node's declared model
   * against this list, and an engine whose catalog is stale still refuses a
   * bad identifier itself, where the truth actually lives.
   */
  listModels?(): Promise<ModelCatalog>;
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
