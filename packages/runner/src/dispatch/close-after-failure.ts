/**
 * The closure a session gets when the dispatch fails after its engine ended
 * (t1313).
 *
 * Between the engine's end and `finishSession` the dispatch still decodes the
 * session text, parses the report, uploads the declared artifacts, releases the
 * tree and drains the denials. Any of those can throw, and until t1313 a throw
 * there reached the outer `catch` of `dispatch.ts`, which rethrew without ever
 * closing the session. The row stayed `open` with `finished_at = null` forever:
 * the board read "an agent is working" while nothing was, and the control
 * plane's streak guard never saw a failure to count (job 2's sessions 25–38).
 *
 * So that catch now calls {@link closeAfterFailure} once, when the outcome was
 * known and `finishSession` had not been attempted yet. Three rules, each of
 * them load-bearing:
 *
 * - **It is best-effort.** Its own failure is swallowed, a `409` included (the
 *   first attempt landed and its answer was lost). The error that explains the
 *   dispatch is the original one, and a cleanup failure must never replace a
 *   cause with a symptom — the same rule the engine cancel follows.
 * - **It is `failed`, always, with no `failure_kind`.** The control plane's
 *   `blockOnRepeatedFailure` therefore counts it, which is what turns a loop of
 *   dead ticks into a visible block instead of an invisible one.
 * - **It sends no `output`.** Keeping the result of a session that completed
 *   when only its upload failed is a separate decision, not this one.
 *
 * Its own module so `dispatch.ts`, already over the line budget, grows by the
 * few lines that place the call and nothing more.
 */

import type { ControlPlaneCall } from './control-plane-client.ts';

/** The longest error text a closure carries, in characters (FR5). */
export const MAX_ERROR_LENGTH = 2000;

/** What a failure with nothing to say is described as. */
const UNKNOWN_ERROR = 'unknown error';

/**
 * What the compensating closure needs to know about the session it closes,
 * captured the moment the outcome is known.
 */
export interface PendingClosure {
  /** The session row `POST /v1/sessions` answered with. */
  sessionId: number;
  /** The exit code the engine reported, kept even though the status is `failed`. */
  exitCode: number | null;
  /** The raw lines collected so far, undecoded — the transcript. */
  lines: readonly string[];
}

/**
 * The failure, as one short line a person can read on `cartografo job <id>`.
 *
 * `error.message` for an `Error`, prefixed by its `name` when that is anything
 * but plain `Error` (`UploadError: ...`, `TypeError: ...`), and `String(error)`
 * for anything else that was thrown. Never empty, and cut to
 * {@link MAX_ERROR_LENGTH} characters with a trailing `…` when it is longer.
 *
 * @param error Whatever the dispatch caught.
 * @returns The description, 1 to {@link MAX_ERROR_LENGTH} characters long.
 */
export function describeFailure(error: unknown): string {
  return truncate(rawDescription(error) || UNKNOWN_ERROR);
}

function rawDescription(error: unknown): string {
  if (error instanceof Error) {
    const name = typeof error.name === 'string' ? error.name : '';
    const message = typeof error.message === 'string' ? error.message : '';
    if (message === '') return name;
    return name === '' || name === 'Error' ? message : `${name}: ${message}`;
  }
  if (error === undefined || error === null) return '';
  try {
    return String(error);
  } catch {
    // An object whose `toString` throws describes nothing.
    return '';
  }
}

function truncate(text: string): string {
  return text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

/**
 * Closes the session as `failed`, carrying the error, in one attempt.
 *
 * @param call The dispatch's control-plane client.
 * @param pending The session and what its engine reported.
 * @param error The failure the dispatch is about to rethrow.
 * @returns Always resolves: a failure of the closure itself is swallowed, so the
 *   caller goes on to rethrow the original error.
 */
export async function closeAfterFailure(
  call: ControlPlaneCall,
  pending: PendingClosure,
  error: unknown,
): Promise<void> {
  try {
    await call(`/v1/sessions/${String(pending.sessionId)}/finish`, 'PATCH', {
      status: 'failed',
      exit_code: pending.exitCode,
      timeout_reason: null,
      transcript: pending.lines.join('\n'),
      error: describeFailure(error),
    });
  } catch {
    // Swallowed on purpose, a 409 included: the original failure is the one
    // that explains the dispatch.
  }
}
