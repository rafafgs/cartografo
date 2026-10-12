/**
 * `ClaudeCodeAdapter` — the first EngineAdapter, running the `claude` CLI
 * headless as a subprocess.
 *
 * "Claude Code is the first adapter, not a dependency"
 * (`notes/2026-08-14-architecture-brain-dump.md:11-14`). Everything specific to
 * this CLI lives here and in `command.ts`; above this line there is only
 * `SessionSpec`, `SessionStatus` and `SessionListener`.
 *
 * The process lifecycle — the detached spawn and group signals, the end decided
 * on `close`, the two clocks and the SIGTERM→SIGKILL escalation — lives in
 * `process-lifecycle.ts`, shared with the other two CLI adapters since t678.
 * What stays here is what only this engine does: the permission refusal, the
 * ephemeral system-prompt file (t203), the engine ref read off any
 * `stream-json` frame, and the harvest of the terminal `result` frame into
 * `SessionFinishDetail` (usage, models, refusal, quota).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildCommand,
  buildEnvironment,
  CLAUDE_BINARY,
  type EngineCommand,
} from './command.ts';
import {
  mergeServerRefs,
  parseClaudeMcpListOutput,
  mcpServerConnectionFromEntry,
  readMcpServerConfigJsonFile,
  readMcpServersJsonFile,
} from './mcp-discovery.ts';
import { resolvePermissions } from './permission-policy.ts';
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
  /** Test seam: the MCP discovery command. Default `claude mcp list`. */
  readonly mcpListCommandBuilder?: () => EngineCommand;
  /**
   * Directory MCP discovery answers FOR. Default `process.cwd()`.
   *
   * Both the `cwd` of the probe — so the CLI applies the scoping rules of the
   * right project, which is what makes its answer worth preferring — and where
   * that project's `.mcp.json` is looked for on the file fallback.
   */
  readonly mcpWorkingDir?: string;
  /** Test seam: deadline of the MCP discovery probe. Default 10s. */
  readonly mcpProbeDeadlineMs?: number;
}

/**
 * What a live session keeps beyond the shared lifecycle. The adapter persists
 * nothing (D1).
 */
interface ClaudeCodeSessionState {
  /**
   * What the terminal frame reported, when it arrived (t172).
   *
   * Kept on the session and not read at the end from a buffer of lines: this
   * adapter keeps no transcript — `onOutput` is the only place a line exists —
   * and holding every line to re-scan it later would turn a stream into a
   * memory leak measured in megabytes per session.
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
  /**
   * Whether a frame said the ACCOUNT refused, rather than the engine (t296).
   *
   * `false` until one does, and it never goes back: a later frame that says
   * nothing about a limit does not un-throttle the session, which is the rule
   * the refusal beside it already follows.
   */
  quota: boolean;
  /**
   * When the account said it would reset, if any line said (t296).
   *
   * `null` is the ordinary case and the one the consumer has to work without:
   * no engine promises this text. It is kept beside the flag rather than
   * derived from it because the two do not arrive together — the sentence can
   * be printed on a line of its own, before or after the frame that carries the
   * status.
   */
  quotaResetAt: string | null;
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
 * frames (`docs/spec/human-escalation.md:292-293`). Every one of them exited 1
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

/**
 * Whether the terminal `result` frame says the ACCOUNT refused (t296, FR4).
 *
 * One key, and it was not guessed either: `api_error_status: 429` is what the
 * n=3 round read off the real frame of a session that had just burned 25
 * minutes and 4M cache tokens (`notes/2026-08-18-n3-round.md`, hole 1). Like
 * the refusal above, it exited non-zero and looked exactly like a crash, so the
 * runner bought the same answer twice more inside twenty seconds and then
 * flagged the work as broken.
 *
 * `429` and not `terminal_reason` beside it: that field said `api_error`, which
 * is every API error there is — a 500, an overload, a connection that dropped —
 * and those are exactly the ones the next attempt SHOULD buy. The status code is
 * the only thing on that frame that separates "come back later" from "try
 * again now", and reading the looser field would have turned every transient
 * server error into a quarter-hour wait.
 *
 * The comparison is strict, against the number: a `"429"` in a string is a
 * frame this adapter does not recognize rather than one it half-reads, which is
 * `extractRefusal`'s posture applied to a numeric field.
 *
 * @param frame A parsed line of the stream.
 * @returns Whether this frame reports the account's own limit.
 */
export function extractQuota(frame: Record<string, unknown>): boolean {
  return frame.api_error_status === 429;
}

/**
 * The clock time and zone a limit message names, if a line names one.
 *
 * `resets 4:40pm Europe/Lisbon` is the shape that was measured, and the two
 * halves are what make an instant out of it: a wall clock with no date, and the
 * zone that clock is read in. Nothing else in the sentence is matched on — the
 * prose around it is the engine's and is free to change.
 */
const RESET_PATTERN =
  /reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+([A-Za-z][A-Za-z_-]*(?:\/[A-Za-z0-9_+-]+)*)/i;

/** The fields of an instant, as a zone's own calendar reads it. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * How a zone reads an instant, or `null` when the zone is not a zone.
 *
 * `Intl` is the whole timezone database and it is already in the runtime, which
 * is why no dependency is added for this: what a zone's offset was at a given
 * instant is a question only a tz database can answer, and getting it wrong by
 * an hour twice a year is the ordinary way hand-rolled offset arithmetic fails.
 */
function zonedParts(instantMs: number, zone: string): ZonedParts | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instantMs));
  } catch {
    // An unrecognized zone throws `RangeError`, and that is the answer: a zone
    // nobody can resolve is a hint this adapter does not have.
    return null;
  }

  const read = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const zoned = {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // `hour12: false` still spells midnight `24` in some ICU builds, and `24:00`
    // of one day is `00:00` of the next — which is the value being read here.
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
  return Object.values(zoned).some((value) => !Number.isFinite(value)) ? null : zoned;
}

/**
 * The instant a wall clock names in a zone, resolved through that zone's offset.
 *
 * Two passes on purpose: the offset itself depends on the instant, so the first
 * guess is corrected by the offset it lands in. Around a DST change the answer
 * is one of the two candidates rather than an error — an hour of slack in a
 * backoff hint is not worth a failure path, and the alternative is reporting
 * nothing at all for every session that ends near a clock change.
 */
function instantOfWallClock(
  zone: string,
  date: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  hour: number,
  minute: number,
): number | null {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);

  let instant = asUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = zonedParts(instant, zone);
    if (seen === null) return null;
    const offset =
      Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second) -
      Math.floor(instant / 1_000) * 1_000;
    instant = asUtc - offset;
  }
  return instant;
}

/**
 * When the account's quota resets, as a line of the stream said it (t296, FR4).
 *
 * Read off the RAW line rather than off a named field of the frame, and that is
 * the one decision here worth defending. There is no captured 429 in this
 * repository — the only evidence is the prose an incident note quoted — so
 * whether this text travels in the terminal frame's `result`, in a `message`
 * beside it, or in the "dying scream in plain text" the stream is already
 * documented to mix in (`engine-adapter.md`) is not something anybody can state
 * today. Matching on the sentence covers all three, and costs one `includes`
 * per line for every session that never sees a limit.
 *
 * **It never throws, and every way of being unsure ends the same.** A line with
 * no reset in it, a clock that is not a clock, a zone the runtime does not
 * know, a missing zone entirely: all `undefined`. This is a HINT — what it buys
 * is a shorter wait than the backoff ladder would give — and invariant 1 of the
 * frozen contract ("onFinished exactly once, always") outranks any hint.
 *
 * The date comes from `now`, because the message carries none: the next
 * occurrence of that wall clock in that zone, which is what "resets 4:40pm"
 * means at 1pm and equally at 5pm.
 *
 * @param line A line of the stream, frame or not.
 * @param nowMs The instant to resolve the missing date against.
 * @returns An ISO 8601 instant, or `undefined` when the line named none.
 */
export function extractQuotaResetAt(line: string, nowMs: number = Date.now()): string | undefined {
  // Cheap gate before the pattern: this runs on every line of every session,
  // and the sessions that matter here are the ones measured in millions of
  // tokens.
  if (!line.includes('reset')) return undefined;

  const match = RESET_PATTERN.exec(line);
  if (match === null) return undefined;

  const [, rawHour, rawMinute, meridiem, zone] = match;
  if (rawHour === undefined || zone === undefined) return undefined;

  const minute = rawMinute === undefined ? 0 : Number(rawMinute);
  if (minute > 59) return undefined;

  let hour = Number(rawHour);
  if (meridiem === undefined) {
    if (hour > 23) return undefined;
  } else {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  }

  const today = zonedParts(nowMs, zone);
  if (today === null) return undefined;

  const candidate = instantOfWallClock(zone, today, hour, minute);
  if (candidate === null) return undefined;
  if (candidate > nowMs) return new Date(candidate).toISOString();

  // The clock has already gone past today: the reset the engine is talking
  // about is the next one, which is tomorrow in the zone's own calendar.
  //
  // The day after is counted on the CALENDAR and not by adding 24 hours to the
  // instant: near a DST change those two are different days, and near midnight
  // they are different days in every zone that is not the one `Date` runs in.
  const nextDay = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const next = instantOfWallClock(
    zone,
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
    },
    hour,
    minute,
  );
  return next === null ? undefined : new Date(next).toISOString();
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
function harvest(state: ClaudeCodeSessionState, line: string): void {
  // BEFORE the frame check, and off the raw line: the reset instant is a
  // sentence, and where the CLI prints it is exactly what no capture in this
  // repository settles (t296). A frame's own field and the plain-text scream
  // the stream is documented to mix in are both just lines here.
  state.quotaResetAt = extractQuotaResetAt(line) ?? state.quotaResetAt;

  const frame = parseFrame(line);
  if (frame === null || frame.type !== 'result') return;

  // Independently: a frame may carry the counts without the breakdown, and a
  // build of the CLI that dropped one has no business erasing the other. The
  // refusal (t265) is read under the same rule and for the same reason — a
  // later frame that says nothing about it does not un-refuse the session.
  state.usage = extractUsage(frame) ?? state.usage;
  state.models = extractModels(frame) ?? state.models;
  state.refusal = extractRefusal(frame) ?? state.refusal;
  // Same rule again for the account's own limit (t296): a later frame that
  // says nothing about a `429` does not un-throttle the session.
  state.quota = extractQuota(frame) || state.quota;
}

/**
 * The `SessionFinishDetail` pieces beyond `timeoutReason`: three facts, each of
 * which travels only if it happened. The accounting is whatever the terminal
 * frame said, and a session that never reached one reports none of it.
 *
 * Assembled by spreading rather than by writing `usage: state.usage`,
 * because the two are not the same thing: a present key holding `undefined`
 * survives `JSON.stringify` as an absent key but reads as present to
 * `'usage' in detail`, and the contract this ficha is about is absence, not
 * falsiness. The lifecycle turns a detail with nothing at all into `undefined`,
 * the shape every consumer written before t163 already handles.
 */
function finishDetail(state: ClaudeCodeSessionState): Omit<SessionFinishDetail, 'timeoutReason'> {
  return {
    ...(state.usage === null ? {} : { usage: state.usage }),
    ...(state.models === null ? {} : { models: state.models }),
    // Two keys out of one fact, and they appear independently (t265): a
    // refusal the engine did not classify reports the KIND and no category —
    // absence is absence, and an empty string in its place would be a
    // category somebody could group sessions by.
    ...(state.refusal === null ? {} : { failureKind: 'engine_refusal' as const }),
    ...(state.refusal === null || state.refusal.category === null
      ? {}
      : { refusalCategory: state.refusal.category }),
    // ...and the third fact `failed` is one word for (t296). The status is
    // untouched by it — the six members are frozen against this very case, in
    // writing and by name (`engine-adapter.md`, "Rejected — a richer
    // `SessionStatus`") — so what changes is the kind beside it and nothing
    // else. AFTER the refusal and only when there is none: an engine that
    // declared a refusal said something about its own answer, and a rate limit
    // on top of that would be the account explaining a decision the engine had
    // already taken.
    ...(state.quota && state.refusal === null ? { failureKind: 'quota' as const } : {}),
    // The hint, and only where it means something: a reset instant beside a
    // session that was not throttled is a date nobody asked for.
    ...(state.quota && state.quotaResetAt !== null
      ? { quotaResetAt: state.quotaResetAt }
      : {}),
  };
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly engineName = 'claude-code';

  /** The session lifecycle, shared with the other two CLI adapters (t678). */
  readonly #lifecycle: ProcessLifecycle<ClaudeCodeSessionState>;

  readonly #commandBuilder: (spec: SessionSpec) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;
  readonly #credentialsPath: string;
  readonly #mcpListCommandBuilder: () => EngineCommand;
  readonly #mcpWorkingDir: string;
  readonly #mcpProbeDeadlineMs: number;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#commandBuilder = options.commandBuilder ?? ((spec) => buildCommand(spec));
    this.#environmentBuilder = options.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#lifecycle = new ProcessLifecycle<ClaudeCodeSessionState>({
      graceMs: options.graceMs ?? DEFAULT_GRACE_MS,
      extractEngineRef,
      onLine: harvest,
      finishDetail,
    });
    this.#probeCommandBuilder =
      options.probeCommandBuilder ?? (() => ({ command: CLAUDE_BINARY, args: ['--version'] }));
    this.#probeEnvironment = options.probeEnvironment ?? process.env;
    this.#credentialsPath = options.credentialsPath ?? join(homedir(), '.claude.json');
    this.#mcpListCommandBuilder =
      options.mcpListCommandBuilder ?? (() => ({ command: CLAUDE_BINARY, args: ['mcp', 'list'] }));
    this.#mcpWorkingDir = options.mcpWorkingDir ?? process.cwd();
    this.#mcpProbeDeadlineMs = options.mcpProbeDeadlineMs ?? PROBE_DEADLINE_MS;
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
    // closing it — and the lifecycle writes under the same condition it pipes.
    //
    // The file is removed on the one funnel every terminal path goes through —
    // natural completion, either watchdog, a `cancel()`, the escalation's
    // safety net and the post-spawn `error` — which is the listener's
    // `onFinished`, removed FIRST and forwarded after. A file left behind is a
    // skill sitting in a worktree that gets handed back to somebody else.
    const forwarded =
      ephemeralFilePath === null ? listener : this.#removingOnFinish(listener, ephemeralFilePath);

    try {
      return await this.#lifecycle.start(spec, forwarded, {
        command,
        environment: () => this.#environmentBuilder(spec),
        state: { usage: null, models: null, refusal: null, quota: false, quotaResetAt: null },
      });
    } catch (error) {
      // A session that never came up never reaches `onFinished`, so the
      // cleanup above never runs. Without this, a failing binary would leave
      // the node's instructions behind in the worktree on every attempt.
      this.#removeEphemeralFile(ephemeralFilePath);
      throw error;
    }
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
   * Which MCP servers this machine's `claude` currently sees (t400).
   *
   * The CLI first, and that is the whole design: `claude mcp list` applies this
   * engine's own scoping and approval rules — user scope, project scope, and
   * whether a `.mcp.json` server was ever approved — and no read of ours
   * reproduces them. Measured on 2026-09-06: the repository's own `cartografo`
   * server is listed by the CLI as "Pending approval" while `.mcp.json` names
   * it flatly.
   *
   * The files second, and honestly labelled. When the binary is missing,
   * refuses, errors or runs past the deadline, the two sources the founder's
   * decision named are read directly — `~/.claude.json`'s user scope and the
   * working directory's `.mcp.json` — and the answer says `origin: 'file'`,
   * because it CAN disagree with what the CLI would have said. The third
   * location this engine really has (`projects[<dir>].mcpServers`, nested in
   * the same `~/.claude.json`) is deliberately out of scope: the decision named
   * two files, and folding in a third unasked is how a report starts claiming
   * more than anyone approved.
   *
   * It never rejects. Every source unreadable resolves zero servers from a
   * file — a real "this engine names none", not an error swallowed into a lie.
   */
  async discoverMcpServers(): Promise<McpDiscovery> {
    const output = await this.#probeMcpList();
    const resolvedAt = new Date().toISOString();

    if (output !== null) {
      return { servers: parseClaudeMcpListOutput(output), origin: 'cli', resolvedAt };
    }

    return {
      servers: mergeServerRefs(
        readMcpServersJsonFile(this.#credentialsPath),
        readMcpServersJsonFile(join(this.#mcpWorkingDir, '.mcp.json')),
      ),
      origin: 'file',
      resolvedAt,
    };
  }

  /**
   * How to reach one of those servers, by name (t370, FR1).
   *
   * The SAME two files the discovery above falls back to, and no third source:
   * this is the other half of one decision, and reading somewhere the listing
   * never looks would let a server be reachable that nothing reports as
   * present.
   *
   * **The project file first.** `.mcp.json` is the scope closest to the work —
   * it travels with the repository the session runs against, and an operator
   * who put a server there meant it for THIS project. The user scope answers
   * for every name the project file does not declare, which is what keeps a
   * machine-wide server usable from a repository that never heard of it. The
   * discovery's own merge reads the two in the other order, and that is not a
   * contradiction: it produces a LIST, where order is presentation, while this
   * produces THE connection, where order is precedence.
   *
   * There is no CLI half here, unlike discovery. `claude mcp list` prints the
   * transport as part of a human sentence nobody versions
   * (`node packages/mcp/bin/mcp.mjs - ⏸ Pending approval`), and parsing a
   * command line out of prose to then SPAWN it is not a risk this ticket takes.
   * The discovery gate above is what still applies the CLI's own approval
   * rules: `resolveExternalInputs` refuses a server the listing does not carry
   * before it ever gets here.
   *
   * `null` for a name neither file declares; a REJECTION when a file declares
   * it and an environment placeholder inside it has no value and no default.
   */
  async resolveMcpServerConnection(name: string): Promise<McpServerConnection | null> {
    for (const path of [join(this.#mcpWorkingDir, '.mcp.json'), this.#credentialsPath]) {
      const entry = readMcpServerConfigJsonFile(path, name);
      if (entry === null) continue;

      const connection = mcpServerConnectionFromEntry(entry, this.#probeEnvironment);
      if (connection !== null) return connection;
    }

    return null;
  }

  /**
   * The caller's listener, with the ephemeral file removed before its
   * `onFinished` runs. `onEngineRef` is forwarded only if the caller has one,
   * because the lifecycle asks no line for a ref nobody listens for.
   */
  #removingOnFinish(listener: SessionListener, path: string): SessionListener {
    const forwarded: SessionListener = {
      onOutput: (line) => listener.onOutput(line),
      onFinished: (status, exitCode, detail) => {
        this.#removeEphemeralFile(path);
        listener.onFinished(status, exitCode, detail);
      },
    };
    if (listener.onEngineRef) forwarded.onEngineRef = (ref) => listener.onEngineRef?.(ref);
    return forwarded;
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
   * `claude mcp list`: the stdout of a run that exited 0, or `null`.
   *
   * The shape of `#probeVersion` — spawn, accumulate stdout, race `close`
   * against `error` against the deadline — with one difference that is not
   * cosmetic: the `cwd`. This CLI answers per project, so asking it from the
   * wrong directory is asking a different question.
   *
   * `null` is every way the question went unanswered (missing binary, non-zero
   * exit, deadline), and the caller turns each of them into the same honest
   * fallback. Only stdout is read: `--json` does not exist for this subcommand,
   * but it does for the other adapter's, and folding stderr into the capture
   * would be a habit that corrupts a JSON parse there.
   */
  #probeMcpList(): Promise<string | null> {
    const command = this.#mcpListCommandBuilder();

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command.command, [...command.args], {
          cwd: this.#mcpWorkingDir,
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
