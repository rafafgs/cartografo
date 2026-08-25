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

/**
 * Wires one session's four collectors and hands them back.
 *
 * @param call The dispatch's control-plane client, for the denial reporter.
 * @param permissions The policy this session actually ran under — the skill's
 *   when the node pins one, the dispatch's otherwise. It is what the tracker
 *   watches for: a tracker armed with the other one would report denials nobody
 *   was denied and miss the real ones (t125, FR6; t161).
 * @returns The collectors, and the listener that fills them.
 */
export function createSessionCollector(
  call: ControlPlaneCall,
  permissions: SessionPermissions | undefined,
): SessionCollector {
  const lines: string[] = [];
  const denials = new PermissionDenialReporter(call);
  const tracker = new PermissionDenialTracker(resolvePermissions(permissions).deniedTools);

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
    listener: {
      onOutput(line) {
        lines.push(line);
        for (const denial of tracker.observe(line)) denials.record(denial);
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
