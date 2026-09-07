/**
 * Everything one live session PRODUCES, collected in one place (t296).
 *
 * Four things come out of a dispatched session and none of them arrives when
 * the sequence would like: the raw lines, as the engine writes them; the ref
 * the engine names for itself, at some point early; the tools it attempted and
 * was denied, at any point at all; and the outcome, exactly once, at the end.
 * Wiring the four is not sequencing them — the wiring says how each fact is
 * caught, and `dispatch.ts` still owns the part that is a decision: WHEN each
 * one is read, in which order the writes that depend on them are attempted, and
 * what happens when one of those writes fails (t148, t207-B).
 *
 * That split is the rule the orchestrator's own header states and the reason
 * this module exists: `dispatch.ts` is under a 600-line budget that a gate
 * enforces (`test/dispatch/file-size-budget.test.ts`), and t296 needed room for
 * a decision the ficha before it did not have. The same trade t223 and t272
 * made twice before, and made the same way — nothing renamed, nothing
 * reordered, no behaviour changed.
 *
 * Nothing here decides anything. There is no policy in this file, no call to
 * the control plane it did not already own (the reporter's queue is the
 * reporter's), and no branch on what the session said.
 *
 * English per the repository's language rule.
 */

import { resolvePermissions } from '../engine/permission-policy.ts';
import type { SessionListener, SessionPermissions } from '../engine/types.ts';
import type { ControlPlaneCall } from './control-plane-client.ts';
import { PermissionDenialTracker } from './parse-permission-denial.ts';
import { PermissionDenialReporter, type Outcome } from './report.ts';

/**
 * How often a running session's draft is sent to the control plane, in
 * milliseconds (t465, FR6).
 *
 * The interview page's own poll interval, and that is the whole derivation: the
 * screen refreshes what a person is watching every three seconds, so a write
 * rate faster than that buys nobody anything and a slower one is a page that
 * lags behind its own source. It is emphatically NOT the engine's rate — a
 * session printing a thousand frames a second is not a thousand writes a
 * second.
 *
 * A constant with a test seam and not a setting, on `TRANSCRIPT_CAP_BYTES`'s
 * own reasoning: a knob nobody turns is a knob that rots.
 */
export const PARTIAL_TEXT_INTERVAL_MS = 3000;

/** The four collectors of one session, and the listener that feeds them. */
export interface SessionCollector {
  /**
   * Every line the engine emitted, raw and in arrival order.
   *
   * The buffer this dispatch has always kept: it is the escalation parser's
   * input, the node's report, and — since t159 — the transcript that ships with
   * the closure. Mutated by the listener, read by the sequence.
   */
  readonly lines: string[];

  /**
   * The denials, queued until there is a session id to post them against.
   *
   * A tool can be refused before `POST /v1/sessions` has answered, and there is
   * no id to address the report to until then, so the queue lives in the
   * reporter and is drained as soon as the id exists (`report.ts`).
   */
  readonly denials: PermissionDenialReporter;

  /** What is handed to `startSession`, and the only thing the engine sees. */
  readonly listener: SessionListener;

  /**
   * Names the session the drafts are written against (t465, FR6).
   *
   * Sibling of `denials.bindSession`, called from the same place and for the
   * same reason: there is no id to address a write to until
   * `POST /v1/sessions` has answered. Unlike the denials there is no queue
   * behind it — what happened before the id existed is already inside `lines`,
   * so the first tick past the interval sends it along with everything since.
   *
   * It also starts the throttle's clock, which is what makes the first draft
   * land one interval AFTER the session opened rather than immediately: the
   * same posture the page's own poll takes, and it keeps a session that dies in
   * its first second from having written anything at all.
   */
  bindSession(id: number): void;

  /**
   * The outcome, resolved exactly once when the adapter reports it.
   *
   * A promise and not a callback, because the sequence awaits it in the middle
   * of a `try` that has to be able to cancel the session if anything else in
   * that window fails (t148, FR2).
   */
  readonly end: Promise<Outcome>;

  /**
   * The ref the engine gave itself, as far as it is known RIGHT NOW.
   *
   * A function and not a value on purpose: it is read at `POST /v1/sessions`,
   * and `null` there means "the engine had not said it yet" — there is no
   * endpoint to fill it in later, and freezing it at collector-construction
   * time would make it `null` always.
   */
  engineRef(): string | null;

  /**
   * When the engine said its account's quota resets, if it said (t296).
   *
   * Read off the finish detail and kept HERE rather than folded into
   * {@link Outcome}, and that is a guarantee and not a preference: `Outcome` is
   * what `report.ts` serializes into `PATCH /v1/sessions/:id/finish`, and this
   * value has no key on that wire and no row in the event contract. A field
   * that cannot reach the body cannot be sent by accident.
   *
   * `undefined` is the ordinary case — most engines say nothing, and an
   * unparsable message says nothing too (`claude-code-adapter.ts`). Meaningful
   * only beside `failureKind: 'quota'`.
   */
  quotaResetAt(): string | undefined;
}

/** The two seams every timed component of this package offers a test (t465). */
export interface SessionCollectorOptions {
  /** Milliseconds between two draft writes; {@link PARTIAL_TEXT_INTERVAL_MS} by default. */
  partialTextIntervalMs?: number;
  /** The clock the throttle reads; `Date.now` by default. */
  now?: () => number;
}

/**
 * Wires one session's four collectors and hands them back.
 *
 * ## The draft, and why it can never cost the dispatch anything (FR6)
 *
 * `onOutput` gained one job beside the two it had: once the session is bound
 * and an interval has passed, it decodes the lines SO FAR and sends them to
 * `PATCH /v1/sessions/:id/partial-text`. Three things make that safe to put on
 * the hottest path this package has:
 *
 * - **the decode is the caller's.** `dispatch.ts` hands over the very
 *   `route.decodeSessionText` it will run at the end, so the text the page
 *   shows mid-turn and the text the transcript settles on are built by one
 *   function. FlowPilot's lesson is that two accumulation rules make the reply
 *   visibly redraw at the finish line; there is no second rule here to disagree;
 * - **nothing waits on it.** The call is not awaited and its rejection is
 *   swallowed. A control plane that blinks costs one interval of staleness and
 *   nothing else — there is no retry, because the next tick resends the whole,
 *   larger buffer anyway;
 * - **it is throttled to the reader's rate, not the writer's**
 *   ({@link PARTIAL_TEXT_INTERVAL_MS}).
 *
 * @param call The dispatch's control-plane client, for the denial reporter.
 * @param permissions The policy this session actually ran under — the skill's
 *   when the node pins one, the dispatch's otherwise. It is what the tracker
 *   watches for: a tracker armed with the other one would report denials nobody
 *   was denied and miss the real ones (t125, FR6; t161).
 * @param decodeSessionText The engine's own decoder — literally
 *   `route.decodeSessionText`, the same function the dispatch runs once at the
 *   end. Passed in rather than resolved here: this module knows nothing about
 *   engines, and a second lookup would be a second chance to pick the wrong one.
 * @param options The throttle's interval and clock, for tests.
 * @returns The collectors, and the listener that fills them.
 */
export function createSessionCollector(
  call: ControlPlaneCall,
  permissions: SessionPermissions | undefined,
  decodeSessionText: (lines: readonly string[]) => string,
  options: SessionCollectorOptions = {},
): SessionCollector {
  const lines: string[] = [];
  const denials = new PermissionDenialReporter(call);
  const tracker = new PermissionDenialTracker(resolvePermissions(permissions).deniedTools);

  const intervalMs = options.partialTextIntervalMs ?? PARTIAL_TEXT_INTERVAL_MS;
  const now = options.now ?? Date.now;

  /** The session the drafts go to; `null` until `POST /v1/sessions` answered. */
  let partialSessionId: number | null = null;
  /** When the last draft was ATTEMPTED — sent, not acknowledged. */
  let lastAttemptAt = 0;

  let engineRef: string | null = null;
  let quotaResetAt: string | undefined;
  let announceEnd: (outcome: Outcome) => void = () => undefined;
  const end = new Promise<Outcome>((resolve) => {
    announceEnd = resolve;
  });

  return {
    lines,
    denials,
    end,
    engineRef: () => engineRef,
    quotaResetAt: () => quotaResetAt,
    bindSession(id) {
      partialSessionId = id;
      lastAttemptAt = now();
    },
    listener: {
      onOutput(line) {
        lines.push(line);
        for (const denial of tracker.observe(line)) denials.record(denial);

        if (partialSessionId === null || now() - lastAttemptAt < intervalMs) return;
        // Stamped before the call and not after it: what the throttle counts is
        // attempts, so a control plane that takes longer than an interval to
        // answer cannot make the next line send a second draft on top.
        lastAttemptAt = now();
        void call(`/v1/sessions/${String(partialSessionId)}/partial-text`, 'PATCH', {
          text: decodeSessionText(lines),
        }).catch(() => {
          // Deliberately nothing. A draft is the freshest value of something
          // nobody replays: the next tick carries this text and more, and a
          // rejection escaping here would take a whole dispatch down over a
          // write the page could have missed for three seconds.
        });
      },

      onEngineRef(ref) {
        engineRef = ref;
      },
      onFinished(status, exitCode, detail) {
        // Beside the outcome and not inside it (t296): everything in `Outcome`
        // is on its way to the wire, and this one is a scheduling hint that
        // stays in this process.
        quotaResetAt = detail?.quotaResetAt;

        // The adapter's optional detail, flattened into the shape every write
        // downstream reads. Each field travels only if the adapter reported it:
        // `undefined` here is "nothing was said", and `report.ts` is what turns
        // that into the explicit `null` the wire carries.
        announceEnd({
          status,
          exitCode,
          timeoutReason: detail?.timeoutReason,
          usage: detail?.usage,
          models: detail?.models,
          failureKind: detail?.failureKind,
          refusalCategory: detail?.refusalCategory,
        });
      },
    },
  };
}
