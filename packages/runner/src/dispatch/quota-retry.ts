/**
 * What happens to a work whose engine account said `429` (t296, FR6/FR7/FR8).
 *
 * The third time this repository writes down that "failed" is one word for
 * facts that need different answers, and the first time the answer is neither
 * "retry now" nor "stop". t265 separated the engine's REFUSAL from the crash,
 * because a refusal reproduces identically forever and the work has to stop.
 * t272 bounded the pre-session failure nobody can classify, because forever is
 * a bug however sympathetic the cause. A quota is the case both of those would
 * get wrong: it reproduces — for a while — and then it stops, by itself, with
 * nobody doing anything.
 *
 * The n=3 round measured what treating it as a crash costs
 * (`notes/2026-08-18-n3-round.md`, hole 1): a session died on a `429` after 25
 * minutes and 4M cache-read tokens, the runner re-leased the work about three
 * seconds later, the next two attempts died in 11 and 2.5 seconds, and t265's
 * consecutive-failure ceiling blocked the job — 20 seconds to burn a whole
 * ficha's ceiling, ≈US$9.3 for nothing usable, and a job reading "blocked:
 * consecutive failures" for an account that was merely at its limit. After the
 * unblock the next attempt did it again, and blocked it again, two hours later.
 *
 * So this module decides a WAIT, and it is careful about what it does not do:
 *
 * - **It never posts a block.** That is the whole difference from the refusal
 *   next door, and it is what keeps `job.blocked` false: nothing is broken,
 *   nobody has anything to fix, and a flag in the inbox for a fact that heals
 *   itself is a person interrupted for nothing. The work stays a candidate the
 *   whole time; what changes is that THIS runner stops offering it.
 * - **It waits for the engine's own instant when there is one.** The reset time
 *   the CLI printed is the truth, and the ladder is what is left when nobody
 *   said it. Reading it is the adapter's job (`claude-code-adapter.ts`), and it
 *   is tolerant by construction — an unparsable message costs a longer wait and
 *   nothing else.
 * - **It says nothing about any other work.** The account is shared, so a
 *   second job dispatched during the cooldown will very likely buy the same
 *   `429` and start a cooldown of its own — one wasted session per job in the
 *   pool, once. Holding the WHOLE queue back on one job's refusal is a bigger
 *   decision (it stops a project on the word of one node) and nobody has taken
 *   it; the cheap version is written down here so the next ficha can weigh it
 *   with the cost in front of it.
 *
 * **The counter lives in the runner process, and that is a decision with a
 * tradeoff** — the same one `pre-session-retry.ts` argued for its own streak,
 * taken again here for the same reason. The alternative is server-side: a new
 * column for "not before this instant", a route that writes it and a filter on
 * `GET /v1/jobs` that reads it. That would survive a restart and be seen by
 * every runner, and it is genuinely better; it is also a migration, a wire
 * change and a new field in the job projection, for an incident that happened
 * inside ONE runner process, in one afternoon. What is given up is written down
 * rather than papered over: the cooldown does not survive a runner restart, and
 * two runners each get their own. Both make a work retry EARLIER than the
 * policy says, never later — one wasted session, never a job that never runs
 * again, which is the safe direction to be wrong in.
 *
 * Everything that decides is here; when it is asked is `dispatch.ts`, which is
 * the same split `pre-session-retry.ts` already runs under. Nothing here
 * touches the database, and nothing here talks to the control plane at all: the
 * runner is an ordinary client of the public API (D1, D11), and this decision
 * does not even need that much.
 *
 * English per the repository's language rule.
 */

import { DEFAULT_QUOTA_BACKOFF_MS } from './options.ts';

/**
 * What a dispatch answers with while a work is cooling down.
 *
 * A reason and not a bare flag, because {@link DispatchOutcome} has never had a
 * shape for "stopped without saying why" — and this one is read by the
 * controller's loop and by whoever is watching the runner's own logs, never by
 * the control plane: no block is posted, so this text reaches no inbox and no
 * `block_reason` column. It says what is true for anybody who does read it.
 *
 * English, unlike the block reasons of `blocks.ts`, precisely because of that:
 * those are written for a person opening a job in the screen, and this one
 * never leaves the process.
 */
export const QUOTA_COOLDOWN_REASON =
  'the engine account is at its own limit (HTTP 429), so this work is waiting for the ' +
  'quota to reset instead of buying the same refusal again';

/**
 * The ladder a tracker actually runs with.
 *
 * `resolvePreSessionFailureCeiling`'s posture applied to a list: anything that
 * is not a usable policy is "no override", never "no wait". An empty ladder, a
 * zero or a `NaN` read literally would re-lease the work immediately, which is
 * the loop this module exists to close — and all three are reachable from a
 * hand-written configuration.
 *
 * All-or-nothing rather than per-rung filtering: a ladder with one broken rung
 * is a configuration somebody got wrong, and silently running three quarters of
 * it would hide that while pretending to honour it.
 *
 * @param declared What the dispatch was configured with, if anything.
 * @returns A non-empty list of positive, finite milliseconds.
 */
export function resolveQuotaBackoff(declared: readonly number[] | undefined): readonly number[] {
  if (declared === undefined || declared.length === 0) return DEFAULT_QUOTA_BACKOFF_MS;
  const usable = declared.every((rung) => Number.isFinite(rung) && rung > 0);
  return usable ? declared : DEFAULT_QUOTA_BACKOFF_MS;
}

/** What is known about one work that has been refused for quota. */
interface Cooldown {
  /** How many times in a row, which is the rung of the ladder it is standing on. */
  attempts: number;
  /** The instant it may be offered again — the engine's, or the ladder's. */
  nextEligibleAt: number;
}

/**
 * Until when each work is not worth dispatching, and why it grew.
 *
 * One instance per `createClaudeCodeDispatch`, held in that closure, exactly
 * like `PreSessionFailureTracker`: a cooldown has to survive from one tick to
 * the next inside a runner process, and nothing may be shared between two
 * dispatches that were wired separately. A module-level map would be a global,
 * and the spikes do build two runners in one process.
 *
 * Keyed by job id and never by node: what is out of quota is the ACCOUNT, and
 * the work is only the thing being held back. A work that moved to another node
 * moved because a session completed, and {@link reset} has already cleared it.
 *
 * Time is a parameter of every method rather than read from `Date.now()`
 * inside, which is what makes the policy testable at all: a cooldown measured
 * against the wall clock is a cooldown measured against how fast the test
 * machine ran.
 */
export class QuotaCooldownTracker {
  readonly #cooldowns = new Map<number, Cooldown>();
  readonly #backoffMs: readonly number[];

  /**
   * @param backoffMs The ladder to use when the engine names no reset instant.
   *   Anything unusable falls back to {@link DEFAULT_QUOTA_BACKOFF_MS}.
   */
  constructor(backoffMs?: readonly number[]) {
    this.#backoffMs = resolveQuotaBackoff(backoffMs);
  }

  /**
   * Records one more quota refusal for this work, and decides how long it waits.
   *
   * The engine's own instant wins whenever it is one and it is still ahead of
   * us. A reset that already happened is not a reset to wait for — it is a
   * message that was parsed a minute too late, or a clock that disagrees — and
   * trusting it would produce a cooldown of zero, which is the loop this class
   * closes. So the ladder is the fallback for all four ways of not having an
   * instant: none reported, unparsable, not a date, already behind us.
   *
   * The rung is the streak, capped at the last one: a work that keeps being
   * refused waits longer each time, and past the end of the ladder it waits the
   * longest wait there is rather than an ever-growing one.
   *
   * @param jobId The work that was refused.
   * @param resetAt When the engine said its quota resets, if it said.
   * @param nowMs The instant this refusal was seen.
   */
  recordQuotaFailure(jobId: number, resetAt: string | undefined, nowMs: number): void {
    const attempts = (this.#cooldowns.get(jobId)?.attempts ?? 0) + 1;

    const announced = resetAt === undefined ? Number.NaN : Date.parse(resetAt);
    const rung = this.#backoffMs[Math.min(attempts - 1, this.#backoffMs.length - 1)] as number;
    const nextEligibleAt =
      Number.isFinite(announced) && announced > nowMs ? announced : nowMs + rung;

    this.#cooldowns.set(jobId, { attempts, nextEligibleAt });
  }

  /**
   * Whether dispatching this work right now would only buy the same refusal.
   *
   * A work nobody has recorded anything about is not cooling down, which is the
   * answer for almost every call: this is asked once per dispatch, before
   * anything is read or opened.
   *
   * @param jobId The work about to be dispatched.
   * @param nowMs The instant of the question.
   * @returns Whether the wait is still running.
   */
  isCoolingDown(jobId: number, nowMs: number): boolean {
    const cooldown = this.#cooldowns.get(jobId);
    return cooldown !== undefined && nowMs < cooldown.nextEligibleAt;
  }

  /**
   * Forgets this work's cooldown and the streak behind it.
   *
   * Called from one place and it is the same fact `PreSessionFailureTracker.
   * reset` reads: the work is not stuck anymore. A session that COMPLETED is
   * proof the account is answering again, so the next refusal — whenever it
   * comes — starts at the first rung instead of inheriting a ladder position
   * from an afternoon that is over.
   *
   * @param jobId The work whose wait ends here. Unknown ids are ordinary.
   */
  reset(jobId: number): void {
    this.#cooldowns.delete(jobId);
  }
}
