/**
 * Everything a dispatch is CONFIGURED with, and the defaults it falls back to
 * (t223).
 *
 * No logic lives here: one interface for the work that is read, one for the
 * options that are passed in, and the three constants those options default to.
 * Every one of them was declared inside `dispatch.ts`, and together they were a
 * third of that file — 163 lines of {@link ClaudeCodeDispatchOptions} alone,
 * because each field of it carries the argument for why it is a seam and not a
 * hardcoded value. That prose is worth its length and it is not orchestration,
 * which is the whole reason it now lives one import away from the sequence it
 * configures.
 *
 * `dispatch.ts` re-exports the surface unchanged, so `cli/run.ts`, the spikes
 * and this package's tests import exactly what they imported before. The split
 * renames nothing and changes no behaviour; the file a declaration is written in
 * is all that moved — the same rule t202 wrote for itself.
 *
 * English, {@link DEFAULT_INSTRUCTIONS} included (D24, t309). It was the one
 * thing in here exempted, "because it is the one thing that reaches a model" —
 * and reaching a model was never what put a text beyond reading. It is also the
 * text a person sees when they dispatch a job by hand with no graph behind it,
 * which is every job this package's own suite runs.
 */

import type { SessionPermissions } from '../engine/types.ts';
import type { MainLineAdvancer } from './advance-main-line.ts';
import { ESCALATION_PROTOCOL } from './escalation-protocol.ts';
import type { EngineRoute } from './resolve-engine.ts';
import type { ResolvedNode } from './resolve-node.ts';
import type { WorktreeManager } from './session-worktree.ts';

/**
 * The instruction of a work with NO resolvable node, fixed and literal — as
 * t104's spike wrote it, in the language t309 put it into.
 *
 * It stopped being the instruction of every session in t161: a work standing on
 * a node of a registered graph is dispatched with that node's skill rendered
 * into it (`render-skill-instructions.ts`), which is what the manifest format
 * had been waiting for since t117. What is left here is the honest fallback for
 * the case that has no graph to read — a work created by hand, which is every
 * work this package's own suite dispatches — and it composes
 * {@link ESCALATION_PROTOCOL} rather than restating it, so that the two texts
 * cannot drift apart on the one paragraph both of them need.
 */
export const DEFAULT_INSTRUCTIONS = [
  'You are a work session dispatched by the cartografo runner.',
  '',
  'Work in the current directory and do what the job asks.',
  '',
  ESCALATION_PROTOCOL,
].join('\n');

/** Default wall-clock limit, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 3_600;

/**
 * Server ceiling for silence, in seconds (t163, FR9).
 *
 * 300s is flowpilot's own `DEFAULT_SILENCE_SECONDS`: short enough that a stuck
 * session is noticed while somebody still cares, long enough that a session
 * thinking hard between two tool calls is not murdered for it. Exported because
 * it IS the ceiling — whoever reads a skill's declared budget resolves against
 * this number, and a ceiling nobody can name is a ceiling nobody can check.
 *
 * "Server config" in the ticket's sense is exactly this: a constant plus a
 * dispatch option, the same shape {@link DEFAULT_TIMEOUT_SECONDS} has had since
 * t106. There is no configuration subsystem in `packages/core` to put it in, and
 * inventing one for two numbers is how a knob nobody turns gets born.
 */
export const DEFAULT_SILENCE_SECONDS = 300;

/**
 * How many consecutive pre-session failures a work gets before it stops (t272,
 * FR4).
 *
 * Five, and the number is a compromise with only one hard side to it. A failure
 * nobody can classify may well be a hiccup — a 5xx, an `EMFILE`, a `PATH` that
 * was wrong for a minute — so blocking on the first one would make a person undo
 * something that had already healed itself, which is exactly what
 * `pre-session-failure.ts` refuses to do. What the t109 game run proved is only
 * the other side: 38 attempts in two minutes with nothing recorded is not a
 * retry policy, it is a loop. Five ticks at the default `--interval-ms` is about
 * ten seconds of retrying before somebody is told — long enough for a restart,
 * short enough that nobody pays for the eleventh attempt.
 *
 * It is a ceiling on a COUNT and not on a rate, which is what makes it safe to
 * be wrong about: whatever the interval, the work stops after five, and a person
 * unblocks it with `POST /v1/jobs/:id/unblocks` once the cause is gone.
 */
export const DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES = 5;

/**
 * How long a work waits after each quota refusal, rung by rung (t296, FR7).
 *
 * The ladder is only reached when the engine did NOT name its own reset instant
 * — when it does, that instant wins, because it is the truth and this is a
 * guess. 30 seconds doubling to a 15-minute cap, and both ends were picked
 * against the same incident (`notes/2026-08-18-n3-round.md`, hole 1): the
 * measured re-leases were 3 seconds apart, which is fast enough to burn three
 * attempts and the whole failure ceiling before anybody could read the log, and
 * the measured window was hours, which is long enough that a wait growing past
 * a quarter of an hour would only add latency to the recovery nobody is
 * watching.
 *
 * It is a ladder and not a single number for the reason a single number cannot
 * have both ends: the first rung has to be short, because a limit can be one
 * minute of an unlucky burst, and the last has to be long, because an account
 * that is genuinely out for the day should not be asked sixty times an hour.
 *
 * Nothing here is load-bearing to another decision. Frozen so a caller cannot
 * mutate the default for every dispatch in the process, which is the same
 * posture every other shared constant of this file has.
 */
export const DEFAULT_QUOTA_BACKOFF_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
]);

/**
 * Deadline of one `tools/call` to an MCP server, in milliseconds (t370, FR4).
 *
 * 30 seconds, which is `DEFAULT_REQUEST_TIMEOUT_MS`'s own number and chosen the
 * same way: it is the deadline of a request this dispatch makes to something
 * outside itself, and a second answer to "how long is too long" would only be a
 * second place to keep it. A tool that reads a file answers in milliseconds; a
 * tool that has not answered in half a minute has stopped answering.
 *
 * There is no CLI flag (Out of Scope), the posture `quotaBackoffMs` took before
 * one ever arrived for it: a dispatch option and a sane default are what a
 * wiring needs, and a flag is additive the day an operator has to turn it.
 */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 30_000;

/**
 * Attempts a SAFE node's declared output gets, in total (t371, FR4).
 *
 * Re-exported from where the ladder is written (`src/mcp/write-external-outputs.ts`)
 * so that the two constants a wiring may override sit beside every other default
 * this file holds. The value and the reasoning live with the ladder: a delivery
 * that failed three times in a couple of seconds failed for a reason a fourth
 * attempt will not fix.
 *
 * This ladder is emphatically NOT
 * {@link DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES}'s and not the control
 * plane's `max_consecutive_failures`. Those two count SESSIONS — dispatch
 * attempts, and failed sessions across leases — and this one counts HTTP calls
 * inside a single dispatch that already succeeded. Three axes, three ceilings,
 * and collapsing any two of them would make one number answer a question it was
 * never measured for.
 */
export {
  DEFAULT_MAX_OUTPUT_WRITE_ATTEMPTS,
  DEFAULT_OUTPUT_WRITE_BACKOFF_MS,
} from '../mcp/write-external-outputs.ts';

/**
 * What `GET /v1/jobs/:id` gives back, in the part the dispatch reads.
 *
 * Exported since t204 for one reason: {@link ClaudeCodeDispatchOptions.resolveInput}
 * is handed the work, and whoever writes that function has to be able to name
 * its argument.
 */
export interface Job {
  id: number;
  title: string;
  /**
   * The request in the person's own words, when it carries one (t360).
   *
   * Optional and nullable because the column already is: a work born with a
   * title and nothing else reads `null` (t122), and every dispatch written
   * before this field ignored it. It is declared here because
   * `createClassPrecedentsResolver` scores it — the problem as somebody
   * described it is the richer half of the signal, and a resolver reading it
   * off an untyped cast would be a resolver nobody can check.
   */
  body?: string | null;
  current_node_id: string;
  blocked: boolean;
  execution_id: number | null;
  /**
   * The graph version this work traverses, when it has one (t101).
   *
   * `null` is ordinary and not a defect: a work created by hand names an entry
   * node and no graph at all, and that is the shape every dispatch had before
   * t141. It is the first of the three ways `DEFAULT_ENGINE` is reached.
   */
  graph_version_id?: string | null;

  /**
   * What this work costs to run, as the intake triaged it (t175).
   *
   * Optional and nullable for the same reason `graph_version_id` above is: a work
   * created by hand names no tier, and every work born before the column existed
   * reads `null`. Absent and `null` mean the same thing here — nobody
   * classified it — and neither means `trivial`.
   */
  tier?: 'trivial' | 'standard' | null;
}

/** Configuration of a dispatch. */
export interface ClaudeCodeDispatchOptions {
  /**
   * Base URL of the control plane. Named as in `ControlPlaneClient`, on purpose:
   * whoever wires both passes the same value to both.
   */
  urlBase: string;
  /**
   * Credential presented on every call (t124, t147).
   *
   * Generic on purpose: any token this control plane accepts. In production it
   * has to be the operator token, and that is not a shortcut — the five routes
   * a pairing credential reaches (`RUNNER_SURFACE`, `packages/core/src/auth.ts`)
   * do not include a single one of the seven this module calls, so a runner
   * credential answers `403 credencial_fora_de_escopo` on all of them rather
   * than degrading into anything usable. Cutting a credential that reaches
   * exactly these routes is another ticket, the same one t146 deferred for the
   * flow surveyor (`docs/spec/surveyor-flow.md`).
   *
   * With no token no header goes out, and the API answers 401 — which is the
   * honest outcome: an empty header would look like a credential.
   */
  token?: string;
  /**
   * The project this dispatch's work belongs to (t410).
   *
   * Three of the routes below read one project's partition since that ticket —
   * `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events` and `GET /v1/jobs/:id/context`
   * — and a read that names none reads the default project. Without this a
   * runner working any other project takes a lease, is told its own work does
   * not exist, gives the lease back and tries again forever: the loop turns, no
   * session opens and nothing says why.
   *
   * The runner's own project and not the work's, because it is the same number:
   * the controller polls one board and leases inside it, so every `jobId` that
   * reaches a dispatch was already resolved in this project.
   *
   * Optional, and absent means the server's default project — which is what
   * every wiring written before the partition meant, and what the spikes and
   * the traversal suites still mean.
   */
  projectId?: number;
  /**
   * The engines this dispatch can route to, by the name a node declares (t141,
   * FR4).
   *
   * A table and not a single adapter, because the choice belongs to the NODE:
   * `POST /v1/sessions` has recorded `engine` dynamically since t124/t147, but
   * until this ficha there was only ever one adapter to record. The key is what
   * `no.engine` says in the graph document; the absence of that field resolves
   * to `DEFAULT_ENGINE`, so a graph that declares nothing behaves exactly
   * as it did before.
   *
   * Whoever wires this owns the pairing: an adapter and the decoder for the
   * frames that adapter's engine prints. Getting that pair wrong is how a
   * session's escalation stops being readable, so they travel together rather
   * than being resolved from the engine name in two different places.
   */
  engines: Record<string, EngineRoute>;
  /**
   * Who gives each session the directory it runs in (t160, FR6).
   *
   * It replaced a static `workingDir: string`, and the replacement IS the
   * enforcement: while that field existed, every session this dispatch ever
   * opened wrote in the same tree — including the operator's own checkout — and
   * any "isolate it" logic would have had a value to quietly fall back to.
   * There is no such value here anymore.
   *
   * Required, with no default: a manager chosen by this module would be a guess
   * about which repository sessions may write in, and that guess is what gap #6
   * of the first dogfood run cost.
   */
  worktrees: WorktreeManager;
  /** Wall-clock limit of the session. Default: one hour. */
  timeoutSeconds?: number;
  /**
   * Silence tolerated before the session is stopped (t163, FR9).
   *
   * The second watchdog, and the second budget: it resolves through
   * `resolveBudget` against {@link DEFAULT_SILENCE_SECONDS}, so declaring
   * a shorter one shortens it and declaring a longer one does nothing. Zero and
   * negative are "no override", never "no watchdog".
   *
   * This is where a skill's declared `orcamentos.silencio_s` will arrive when
   * something finally renders a registered manifest into a dispatch — the same
   * seam `permissions` below already is, and for the same missing pipeline.
   */
  silenceSeconds?: number;
  /**
   * Node instructions, for a work with no resolvable node.
   *
   * Since t161 it is a FALLBACK and no longer an override: a work standing on a
   * node of a registered graph is dispatched with that node's skill rendered
   * into the session, and a dispatch-wide literal that replaced it would be
   * exactly the hand-cranked mode this ficha closes — one instruction for every
   * node of every graph, decided by whoever wired the process. What still
   * arrives here is the text for a work with no graph, or one whose node the
   * snapshot does not carry. Default: {@link DEFAULT_INSTRUCTIONS}.
   */
  instructions?: string;
  /**
   * What this node's `{{input.<caminho>}}` placeholders resolve against
   * (t204, FR8).
   *
   * Called once per dispatch, and only for a work standing on a node the
   * snapshot carries — a graph-less work renders no manifest, so there is
   * nothing to interpolate.
   *
   * **The default is the real projection** (t259). It reads
   * `GET /v1/jobs/:id/context` — the control plane's own assembly of the job's
   * identity, the class's `project` config, every completed node's structured
   * output in the bucket its `contract.produces` names, and the answered
   * escalations (`packages/core/src/domain/context.ts`, D1: the sole writer is
   * the one place that can build it without a second round trip). For four
   * fichas it resolved `{}` instead, honestly: nothing carried a node's output,
   * so nothing could assemble the object the next node's `input` schema
   * declares, and every skill with a placeholder failed closed. What that
   * replaced is still worse than either — the same skill used to open a session
   * with `{{input.triaged_thesis.title}}` in the prompt and nobody the wiser.
   *
   * Asynchronous since that wiring, and it is what forced the signature: the
   * projection is an HTTP call. It stays a seam rather than a hardcoded call
   * for the reason `silenceSeconds` above is one — a named parameter is what
   * lets a test pin the renderer against an input it chose, with no control
   * plane in the way.
   */
  resolveInput?: (job: Job, resolved: ResolvedNode) => Promise<Record<string, unknown>>;
  /**
   * What only THIS MACHINE knows, merged over the projection (t270).
   *
   * The second half of the same object, and the reason it is a second seam and
   * not a widening of the first: `resolveInput` reads the control plane, and
   * the control plane cannot answer either of the two questions this one does.
   * `input.banco_de_testes.caminho` is a filesystem path — it names a directory
   * on one machine, and a graph version carrying it would be wrong for every
   * other runner — and `input.referencia.commit` is a live commit, stale the
   * moment anything stores it (D1). Built by
   * `createExecutorEnvironmentResolver` (`resolve-executor-environment.ts`) out
   * of what the operator configured at boot.
   *
   * **The keys win on collision.** `dispatch.ts` merges
   * `{...projected, ...executorEnv}`, so a projection that happened to carry
   * the same key loses — it would be carrying a stale copy of local ground
   * truth, which is the one thing this seam exists to be authoritative about.
   *
   * Absent contributes `{}` and changes nothing, which is the ordinary case: a
   * bets runner has no bench, and neither does a deployment that has not set one
   * up. Same signature as {@link resolveInput}, so whoever wires a dispatch
   * writes both the same way.
   */
  executorEnvironment?: (job: Job, resolved: ResolvedNode) => Promise<Record<string, unknown>>;
  /**
   * What KEEPS that bench true, after an integration (t273).
   *
   * The write half of the seam above, and the reason the two are separate
   * options rather than one: {@link executorEnvironment} runs on EVERY dispatch
   * and only reads, while this one runs on the few reports that name a
   * `merge_commit` and moves a branch. It fast-forwards the shared bench onto
   * that commit — and prepares it, if the operator configured a command for
   * that — before the work is allowed off the node that reported it.
   *
   * The trigger is the SHAPE of the report and never a node or skill id (D9):
   * a second graph whose integration node declares the same output field is
   * covered with no change here. What happens when it rejects is
   * `advance-main-line.ts`'s and `blocks.ts`'s — the work stops on its node
   * with a reason, because a `git` that refuses refuses identically on every
   * retry.
   *
   * Absent changes nothing, which is the ordinary case: a bets runner has no
   * bench to advance, and neither does a deployment that has not set one up.
   * Built by `createMainLineAdvancer` out of what the operator configured at
   * boot (`cli/run.ts`), the same way `createExecutorEnvironmentResolver` is.
   */
  advanceMainLine?: MainLineAdvancer;
  /** Opaque additions to the engine's environment. */
  envOverrides?: Readonly<Record<string, string>>;
  /**
   * Permission policy of a session with no resolvable node (t125).
   *
   * The seam t125 left open is filled: a dispatch that resolves a node resolves
   * its skill too, and the session runs under the policy that skill's manifest
   * declares — registry lookup and hash check included (t161, FR6). This field
   * is what is left for a work with no graph behind it, and for those it behaves
   * exactly as it always did.
   *
   * The precedence is not a preference. `permissions` is inside the manifest's
   * content hash on purpose, so a skill that opens a permission changes hash and
   * reappears at the human gate; letting a dispatch-wide option override it
   * would make that whole mechanism decorative.
   */
  permissions?: SessionPermissions;
  /**
   * Consecutive pre-session failures tolerated per work before it is stopped
   * (t272, FR4). Default: {@link DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES}.
   *
   * Resolved through `resolvePreSessionFailureCeiling`, the same posture
   * `silenceSeconds` has: a value that is not a positive integer is "no
   * override", never "no ceiling". A `0` read literally would block every work
   * on its first hiccup and a `NaN` would never block anything — the two ways of
   * having no policy at all.
   *
   * The streak it bounds is counted IN THIS PROCESS, in the closure
   * `createClaudeCodeDispatch` returns, and it is deliberately not the same fact
   * as `job.consecutive_failures`: that one counts failed SESSIONS across
   * leases and processes (t265, `packages/core/src/repositories/job.ts`), and a
   * failure before a session creates no row for it to see.
   */
  maxConsecutivePreSessionFailures?: number;
  /**
   * How long each quota refusal makes a work wait, rung by rung (t296, FR7).
   * Default: {@link DEFAULT_QUOTA_BACKOFF_MS}.
   *
   * The same override discipline the ceiling above has, applied to a list: what
   * is not a usable policy — an empty ladder, a zero, a negative, a `NaN` — is
   * "no override" and never "no wait", because a wait of zero is the loop this
   * option exists to close. `resolveQuotaBackoff` (`quota-retry.ts`) is where
   * that is decided.
   *
   * Only the fallback is configurable, and that is deliberate: when the engine
   * names the instant its quota resets, THAT is what the work waits for, and a
   * dispatch that could shorten it would be paying for a refusal it already
   * knows the answer to.
   */
  quotaBackoffMs?: readonly number[];
  /**
   * Deadline of each MCP `tools/call` this dispatch makes (t370, FR4).
   * Default: {@link DEFAULT_MCP_CALL_TIMEOUT_MS}.
   *
   * An option and no flag of its own, the same standing `quotaBackoffMs` above
   * has. It bounds ONE call: a node declaring three external inputs gets three
   * deadlines, not a third of one each, because what this number is about is a
   * server that stopped answering and not a budget for the node.
   *
   * It is a pre-session budget and deliberately not one of the session's own
   * ({@link timeoutSeconds}, {@link silenceSeconds}): every MCP call has
   * finished before `startSession` is reached, so a call that runs long costs a
   * dispatch its latency and never an engine its quota.
   */
  mcpCallTimeoutMs?: number;
  /**
   * Attempts a SAFE node's declared output gets, in total (t371, FR4).
   * Default: {@link DEFAULT_MAX_OUTPUT_WRITE_ATTEMPTS}.
   *
   * The same standing `quotaBackoffMs` and `mcpCallTimeoutMs` above have: an
   * option, no flag of its own, and a value that bounds ONE delivery — a node
   * declaring three of them gets three ladders, because what this is about is a
   * server that refused and not a budget for the node.
   *
   * It applies to a safe node and to nothing else. An `unsafe_to_retry` node
   * gets exactly one attempt whatever is configured here, and no setting widens
   * that: the flag is the map saying the step may not be repeated, and an
   * operator's dispatch configuration does not get to overrule a graph.
   */
  maxOutputWriteAttempts?: number;
  /**
   * What that ladder waits between attempts, rung by rung (t371, FR4).
   * Default: {@link DEFAULT_OUTPUT_WRITE_BACKOFF_MS}.
   *
   * One entry fewer than there are attempts, which is what "between" means. A
   * ladder shorter than the attempt count simply stops waiting once it runs out
   * — the ATTEMPTS are the policy and the waits are the courtesy.
   */
  outputWriteBackoffMs?: readonly number[];
  /** `fetch` implementation. Default: the global one. Test seam only. */
  doFetch?: typeof fetch;
  /**
   * Deadline of every control-plane call this dispatch makes, in milliseconds
   * (t193, FR4). Default: `DEFAULT_REQUEST_TIMEOUT_MS`.
   *
   * The session's own budgets are elsewhere and stay there
   * ({@link timeoutSeconds}, {@link silenceSeconds}): this one is about the
   * seven HTTP calls around the session, none of which had a deadline before —
   * a control plane that accepted the connection and went quiet used to hang
   * the dispatch between two writes it owed, with an engine still running.
   */
  requestTimeoutMs?: number;
  /**
   * Called the moment a session is live, with the one function that can take it
   * down (t193, FR9).
   *
   * It exists for the shutdown and for nothing else. Whoever owns the process
   * (`cli/index.ts`) has to be able to end a session that is already running —
   * a stop that could only wait would wait up to {@link timeoutSeconds}, and a
   * process that just died would leave the engine writing in a worktree nobody
   * is left to give back.
   *
   * The cancel handed over goes through `EngineAdapter.cancel`, so everything
   * downstream of it is the path the dispatch already has for an adapter-driven
   * end: `cancelled` is recorded as `travada`, the worktree is KEPT (a session
   * that was cancelled did not complete), the lease goes back through the
   * controller's own `finally`, and the dispatch rejects with the
   * `DispatchError` the loop already logs and moves past. No new way of
   * closing out a session is invented here — only a new caller of the one that
   * exists.
   */
  onSessionStarted?: (cancel: () => Promise<void>) => void;
  /**
   * Called once the session's outcome is known, on every path (t193, FR9).
   *
   * The other half of {@link onSessionStarted}, and the half that makes the
   * reference safe to hold: between the two calls there is a live process, and
   * outside them there is nothing to cancel.
   */
  onSessionEnded?: () => void;
}
