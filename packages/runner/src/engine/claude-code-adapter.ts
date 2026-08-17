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
 * - **The clocks are ours.** Neither of the two CLIs analysed has a timeout flag
 *   (`engine-adapter.md:407`), so the adapter arms them, escalates
 *   SIGTERM→SIGKILL and disarms them. Since t163 there are two: the wall clock,
 *   armed once, and the inactivity watchdog, re-armed on every chunk the process
 *   writes. They are independent because they answer different questions — "this
 *   already cost too much" and "this stopped happening" — and whichever fires
 *   first wins outright.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  type EngineModel,
  type ModelCatalog,
  type SessionFinishDetail,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
  type SessionUsage,
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

/**
 * The models this adapter knows the `claude` CLI can be pointed at (t166).
 *
 * Static, and `origin: 'catalog'` on every entry, because there is nothing to
 * ask: `claude --help` documents `--model <model>` — which SETS a model — and
 * exposes no subcommand or flag that LISTS the available ones (run against
 * `claude 2.1.233` for this ficha, subcommand list included). The CLI-query
 * branch of `listModels()` exists in the interface for a future engine that has
 * one; this adapter never takes it, and says so in the field rather than
 * dressing a hardcoded list as a measurement.
 *
 * The identifiers are the full names the CLI's own help gives as its example
 * form ("a model's full name (e.g. 'claude-fable-5')"), not the aliases it also
 * accepts (`opus`, `sonnet`): an alias resolves to whatever is latest, and a
 * graph that pinned one would silently change model under a node that was
 * never re-proposed. Pinning is the whole point of the field.
 *
 * The list ages, and that is expected: it is a catalog, refreshed by restarting
 * the runner against a newer adapter, and a node may name a model that is not
 * here — nothing validates against this list (Out of Scope), and the CLI is
 * what refuses an identifier it does not know.
 */
export const CLAUDE_CODE_MODELS: readonly EngineModel[] = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', origin: 'catalog' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', origin: 'catalog' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', origin: 'catalog' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', origin: 'catalog' },
];

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
  /**
   * What the terminal frame reported, when it arrived (t172).
   *
   * Kept on the session and not read at the end from a buffer of lines, for the
   * same reason `refSent` is: this adapter keeps no transcript — `onOutput` is
   * the only place a line exists — and holding every line to re-scan it later
   * would turn a stream into a memory leak measured in megabytes per session.
   */
  usage: SessionUsage | null;
  models: string[] | null;
  /**
   * The refusal the terminal frame declared, when it declared one (t265).
   *
   * `null` is "no frame said this session was refused" — a crash, a clean end,
   * a build of the CLI that does not report `stop_reason`. The `category` inside
   * is `null` on its own account: an engine can refuse and say no more than
   * that, and inventing a word for it here would be a diagnosis this adapter
   * made up.
   */
  refusal: { category: string | null } | null;
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
  /**
   * Absolute path of the ephemeral system-prompt file this session wrote, when
   * its content was too large to travel in the argv (t203). `null` for every
   * ordinary session, which is almost all of them.
   *
   * Kept on the session because the removal happens somewhere else entirely
   * from the writing: the file is written before the spawn and deleted in
   * `#finish`, which is the one funnel every terminal path goes through.
   */
  ephemeralFilePath: string | null;
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
  const frame = parseFrame(line);
  if (frame === null) return null;

  const { type, session_id: sessionId } = frame as { type?: unknown; session_id?: unknown };
  if (typeof type !== 'string' || typeof sessionId !== 'string' || sessionId === '') return null;
  return sessionId;
}

/**
 * A line of the stream as an object, or `null` when it is not a frame at all.
 *
 * The same classification `extractEngineRef` has always applied, factored out
 * once there was a second reader of it: the stream mixes structured frames with
 * "a dying scream in plain text" (`engine-adapter.md:209-214`), and a line that
 * merely looks like JSON is not a frame.
 */
function parseFrame(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return null;
  return frame as Record<string, unknown>;
}

/** The four counts of the contract, in the order the schema declares them. */
const USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

/**
 * The token accounting of the terminal `result` frame (t172, FR2/FR3).
 *
 * **It picks the four keys; it never forwards the object.** Measured against
 * `claude 2.1.233`, the real `usage` carries ten — `service_tier`, `iterations`,
 * `output_tokens_details`, a `cache_creation` breakdown and more around the four
 * that matter. The taxonomy's `uso` closes `additionalProperties`, so an adapter
 * that passed the frame's object through would produce a `/finish` body the
 * control plane answers 400 to, and every session would land with `uso: null`
 * anyway — with nothing in the log saying why.
 *
 * All four or nothing, and each of them a non-negative integer: a partial
 * accounting completed with zeros is exactly the "absence read as a
 * measurement" this whole ficha exists to prevent.
 *
 * @param frame A parsed line of the stream.
 * @returns The four counts, or `null` when this frame does not carry them.
 */
export function extractUsage(frame: Record<string, unknown>): SessionUsage | null {
  const usage = frame.usage;
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null;

  const counts = usage as Record<string, unknown>;
  const picked: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const value = counts[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
    picked[key] = value;
  }
  return picked as unknown as SessionUsage;
}

/**
 * The models named by the terminal frame's `modelUsage` breakdown (t172,
 * FR4/FR5).
 *
 * The KEYS and nothing else: what each model spent is a per-model split the
 * `uso` contract has no room for, and summing them here would produce a total
 * that disagrees with the frame's own `usage` (measured: on a one-turn session,
 * `usage.input_tokens` was 2 while the breakdown's two models added up to 525 —
 * the top-level counts describe the main turn, the breakdown describes every
 * model that ran). What travels is identity, not a second accounting.
 *
 * The order is the frame's own, never sorted: a ranking of models is a claim,
 * and this adapter has no basis for one.
 *
 * @param frame A parsed line of the stream.
 * @returns The distinct model identifiers, or `null` when none was reported.
 */
export function extractModels(frame: Record<string, unknown>): string[] | null {
  const breakdown = frame.modelUsage;
  if (typeof breakdown !== 'object' || breakdown === null || Array.isArray(breakdown)) return null;

  const models = Object.keys(breakdown as Record<string, unknown>).filter(
    (id) => id.trim() !== '',
  );
  // An empty breakdown is not "it ran under no model", it is a frame with
  // nothing to say — and the absence has a name already.
  return models.length === 0 ? null : models;
}

/**
 * The refusal the terminal `result` frame declares, when it declares one (t265,
 * FR1).
 *
 * Two keys, and they were not guessed: `stop_reason` and `stop_details.category`
 * are what the bisection of t198's four refused sessions read off the real
 * frames (`docs/spec/escalacao-humana.md:292-293`). Every one of them exited 1
 * with zero output tokens, which is precisely the shape of a crash — the exit
 * code cannot tell the two apart, and this is the only place that can.
 *
 * `"refusal"` and nothing else: an unknown `stop_reason` is not a refusal this
 * adapter half-recognizes, it is a frame with nothing to say about one. The
 * category travels unmapped, because it is the engine's own vocabulary crossing
 * a boundary that was built to carry engine words (the same posture `models`
 * has), and an empty or non-string one is no category at all.
 *
 * @param frame A parsed line of the stream.
 * @returns The refusal, with the category when the frame named one, or `null`.
 */
export function extractRefusal(
  frame: Record<string, unknown>,
): { category: string | null } | null {
  if (frame.stop_reason !== 'refusal') return null;

  const details = frame.stop_details;
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    return { category: null };
  }

  const category = (details as Record<string, unknown>).category;
  return {
    category: typeof category === 'string' && category.trim() !== '' ? category : null,
  };
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly engineName = 'claude-code';

  /** The sessions with a process still on the other side. */
  readonly #sessions = new Map<string, Session>();

  /**
   * One terminal status per session that already ended (t207).
   *
   * The stub that lets `#finish` drop everything else. Invariant 3 of the frozen
   * contract — "getStatus só devolve status terminal depois que onFinished
   * correu" (`docs/formatos/engine-adapter.md:778`) — is answerable from a
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

    // BEFORE the spawn, because the engine reads it as it comes up (t203). Mode
    // 0600 and then a `chmod` on top of it: `writeFileSync`'s mode only applies
    // when the file is CREATED, so a leftover from a session that died between
    // the write and the cleanup would keep whatever permissions it had. The
    // content is a node's instructions, in a directory a session runs commands
    // in — world-readable would be a skill leaking to every process on the box.
    let ephemeralFilePath: string | null = null;
    if (command.ephemeralFile) {
      ephemeralFilePath = join(spec.workingDir, command.ephemeralFile.relativePath);
      writeFileSync(ephemeralFilePath, command.ephemeralFile.content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(ephemeralFilePath, 0o600);
    }

    // `stdin` piped only when there is something to write into it. Invariant 6
    // forbids the third shape — a pipe open with nothing written and nothing
    // closing it — and that is exactly what is avoided by deciding here instead
    // of piping unconditionally: the write below is unconditional TOO, and the
    // two conditions are the same one.
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
      this.#removeEphemeralFile(ephemeralFilePath);
      throw new SessionStartError(`could not start "${command.command}"`, { cause });
    }

    // Synchronously, right after the spawn, and the error listener FIRST: an
    // engine that exits before reading its stdin breaks the pipe, and an
    // unhandled `'error'` on a stream is an uncaught exception — the runner
    // dying over one session's fast exit. A broken pipe is not a session
    // failure; the process's own exit is the outcome, and it is already
    // reported through `close`.
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
      usage: null,
      models: null,
      refusal: null,
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
      ephemeralFilePath,
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
      // A session that never came up never reaches `#finish`, so the cleanup
      // that lives there never runs. Without this, a failing binary would leave
      // the node's instructions behind in the worktree on every attempt.
      this.#removeEphemeralFile(session.ephemeralFilePath);
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

  /**
   * How many sessions this adapter still holds live — diagnostics only.
   *
   * NOT part of `EngineAdapter`, which is frozen by the rule of two consumers
   * (`notas/2026-08-14-extensao-e-qualidade.md`): it is a seam of this class, in
   * the same family as `commandBuilder` and `probeEnvironment`, and a third-party
   * adapter owes nobody an implementation of it. What it measures is the map of
   * sessions with a process on the other side; the terminal-status stubs are not
   * sessions and are not counted.
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
   * `stream-json` is parseable, hence `hasStructuredOutput`; `-r, --resume` is
   * real and `SessionSpec.resumeFrom` reaches it, hence `hasResume` (t173); the
   * terminal `result` frame carries `usage` and `SessionFinishDetail.usage`
   * delivers it, hence `reportsUsage` (t172).
   *
   * All three arrived the same way, and the pattern is the point: the CLI had
   * the capability all along, and what this adapter refused to declare without
   * was a CONSUMER. Declaring the fourth, the fifth and the sixth before
   * anybody reads them is still how a format rots
   * (`engine-adapter.md:160-165`) — the rule did not soften, it got satisfied.
   */
  capabilities(): EngineCapabilities {
    return { hasStructuredOutput: true, hasResume: true, reportsUsage: true };
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
   * `async` with nothing to await, and it stays that way: the interface returns
   * a promise because the engine that HAS a query path will need one, and an
   * adapter that narrowed the signature to fit its own shortcut would be a
   * consumer breaking the format it implements.
   */
  async listModels(): Promise<ModelCatalog> {
    return { models: CLAUDE_CODE_MODELS, resolvedAt: new Date().toISOString() };
  }

  /**
   * (Re)arms the inactivity watchdog, if this session has one.
   *
   * Called at the start and on every raw chunk, which is what makes "silence"
   * mean what it says: the session is alive while the process is producing,
   * whatever the produce happens to parse into.
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
    // long unbroken line is producing output, and judging it silent because no
    // `\n` arrived yet would kill a session that is working.
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

    this.#harvest(session, line);

    if (session.refSent || !session.listener.onEngineRef) return;
    const ref = extractEngineRef(line);
    if (ref === null) return;
    session.refSent = true;
    session.listener.onEngineRef(ref);
  }

  /**
   * Keeps whatever accounting a line carries, for the outcome to report (t172).
   *
   * Read off EVERY line rather than only the last one, because "the last line"
   * is not a thing the adapter can identify while streaming — and the terminal
   * `result` frame is not always the last thing the process writes: a CLI can
   * print a warning to stderr after it, and the two streams are merged in
   * arrival order. What is asserted is the frame's TYPE, not its position.
   *
   * A later frame with the same accounting wins, which cannot happen in a
   * session that ends once but is the honest rule if one ever does: the last
   * report is the one the engine stands by.
   */
  #harvest(session: Session, line: string): void {
    const frame = parseFrame(line);
    if (frame === null || frame.type !== 'result') return;

    // Independently: a frame may carry the counts without the breakdown, and a
    // build of the CLI that dropped one has no business erasing the other. The
    // refusal (t265) is read under the same rule and for the same reason — a
    // later frame that says nothing about it does not un-refuse the session.
    session.usage = extractUsage(frame) ?? session.usage;
    session.models = extractModels(frame) ?? session.models;
    session.refusal = extractRefusal(frame) ?? session.refusal;
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
      }, this.#graceMs);
    }, this.#graceMs);
  }

  #finish(id: string, status: SessionStatus, exitCode: number | null): void {
    const session = this.#sessions.get(id);
    if (!session || session.finished) return;

    this.#disarm(session);
    // Here and not on any single path, because this is the funnel every one of
    // them goes through: natural completion, either watchdog, a `cancel()`, the
    // escalation's safety net and the post-spawn `error`. A file left behind is
    // a skill sitting in a worktree that gets handed back to somebody else.
    this.#removeEphemeralFile(session.ephemeralFilePath);
    session.ephemeralFilePath = null;
    session.finished = true;
    // Invariant 3: the status only turns terminal together with onFinished,
    // never before.
    session.status = status;
    // Three facts, each of which travels only if it happened. The cause is set
    // beside `requestedStatus`, so it can only ever accompany the status that
    // watchdog asked for; the accounting is whatever the terminal frame said,
    // and a session that never reached one reports none of it.
    //
    // Assembled by spreading rather than by writing `usage: session.usage`,
    // because the two are not the same thing: a present key holding `undefined`
    // survives `JSON.stringify` as an absent key but reads as present to
    // `'usage' in detail`, and the contract this ficha is about is absence, not
    // falsiness. `undefined` for the whole object when there is nothing at all
    // keeps the shape every consumer written before t163 already handles.
    const detail: SessionFinishDetail = {
      ...(session.timeoutReason === null ? {} : { timeoutReason: session.timeoutReason }),
      ...(session.usage === null ? {} : { usage: session.usage }),
      ...(session.models === null ? {} : { models: session.models }),
      // Two keys out of one fact, and they appear independently (t265): a
      // refusal the engine did not classify reports the KIND and no category —
      // absence is absence, and an empty string in its place would be a
      // category somebody could group sessions by.
      ...(session.refusal === null ? {} : { failureKind: 'engine_refusal' as const }),
      ...(session.refusal === null || session.refusal.category === null
        ? {}
        : { refusalCategory: session.refusal.category }),
    };
    session.listener.onFinished(
      status,
      exitCode,
      Object.keys(detail).length === 0 ? undefined : detail,
    );

    // AFTER the listener has been told, and only then (t207): everything this
    // session was holding — the `ChildProcess`, the caller's listener, the
    // accounting, the leftovers — becomes garbage the moment the map lets go,
    // and what is left is the one string `getStatus` owes invariant 3. The
    // order is the whole point: dropping it BEFORE the call would hand
    // `onFinished` an adapter that no longer knows the session it is reporting.
    this.#sessions.delete(id);
    this.#terminalStatus.set(id, status);
  }

  /**
   * Removes the ephemeral system-prompt file, if this session wrote one.
   *
   * Best effort by design: the failure modes are a file the session itself
   * deleted, a directory already torn down by whoever owns the worktree, or a
   * permission the runner lost. None of them is a reason to throw out of a
   * terminal path and cost the session its `onFinished` — invariant 1 outranks
   * a leftover file, and the leftover is what this method is trying to prevent
   * in the first place.
   */
  #removeEphemeralFile(path: string | null): void {
    if (path === null) return;
    try {
      rmSync(path, { force: true });
    } catch {
      /* the file is gone, or was never ours to remove */
    }
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
   * Takes this session's process group down with the runner (t193, FR11).
   *
   * The backstop, and only that: t193 gave the runner an explicit shutdown that
   * cancels a live session through {@link ClaudeCodeAdapter.cancel}, and this
   * covers every OTHER way the process can end — an uncaught exception
   * somewhere else, a bare `process.exit()`, a `finally` that never ran. Without
   * it, the engine is reparented to init and goes on writing in a worktree
   * nobody is left to give back.
   *
   * SIGTERM only, and no escalation: `'exit'` is the last synchronous turn this
   * process gets. There is no event loop left for a SIGKILL five seconds later,
   * `await` is not allowed here, and a listener that pretended otherwise would
   * be a promise nobody could keep. An engine that ignores SIGTERM survives
   * this path — which is precisely why it is the backstop and not the plan.
   *
   * The one honest limit stays a limit: a `SIGKILL` of the runner itself runs
   * no JavaScript at all, `'exit'` never fires, and nothing in this process can
   * prevent that orphan.
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
