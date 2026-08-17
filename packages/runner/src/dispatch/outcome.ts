/**
 * How a dispatch ends, for the controller waiting on it (t252, t265).
 *
 * Two declarations and nothing else: the answer a dispatch resolves with, and
 * the error it rejects with. They lived at the top of `dispatch.ts` until t265,
 * and they moved for the reason the split rule in that file's own header gives —
 * the orchestrator is the SEQUENCE, and a type the controller reads is not part
 * of it. `dispatch.ts` re-exports both, so nobody edits an import.
 *
 * The pair belongs together because it is one question read from either end:
 * a dispatch that stopped the work answers, a dispatch whose session died
 * throws, and telling those two apart is the whole contract the controller has
 * with this package.
 *
 * English per D18.
 */

import type { SessionStatus } from '../engine/types.ts';

/**
 * How a dispatch ended, for the controller waiting on it (t252).
 *
 * Two answers and not three: a session ran (whatever it then did — asked, was
 * denied, advanced), or the work was stopped. A session that DIED is still a
 * rejection, and always was.
 *
 * Until t265 "stopped" meant "stopped BEFORE anything opened", because the five
 * pre-session failures were the only thing that produced it. A refusal the
 * engine declared produces it too now, after a session ran and reported — the
 * shape did not have to change for that, which is what makes it the right shape.
 *
 * The reason travels with the block because the caller may want it and the
 * controller does not: `ControllerOptions.dispatch` declares the narrower
 * `{blocked: boolean}` of its own, which this satisfies structurally without
 * either file importing the other.
 */
export type DispatchOutcome = { blocked: false } | { blocked: true; reason: string };

/** A session that started but did not end well. */
export class DispatchError extends Error {
  readonly status: SessionStatus;
  readonly exitCode: number | null;

  constructor(message: string, status: SessionStatus, exitCode: number | null) {
    super(message);
    this.name = 'DispatchError';
    this.status = status;
    this.exitCode = exitCode;
  }
}
