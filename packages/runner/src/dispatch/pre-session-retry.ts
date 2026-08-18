/**
 * What happens to a pre-session failure the classifier does NOT recognize
 * (t272, FR2/FR3/FR4).
 *
 * `pre-session-failure.ts` answers one question — will this reproduce
 * identically forever? — and answers it conservatively on purpose: a wrong
 * "yes" blocks a work that would have healed itself. Everything it says `null`
 * to is retried on the next tick, which is right, and which until this ficha
 * meant retried FOREVER. The t109 game run measured what that costs: 38
 * `lease.granted` in about two minutes, zero `session.opened`, nothing in
 * anybody's inbox, and no other job of the project ever tried, because the
 * queue's head never moved (`notas/2026-08-17-t109-feature-do-jogo.md`, gap 2).
 *
 * So this module makes a strictly WEAKER claim than a classification, and it is
 * the weakness that makes it safe: it says nothing about the cause, only that
 * the same work has failed before opening a session N times in a row. Five of
 * those is not proof of anything permanent — it is the point where paying for
 * the next attempt stops being cheaper than telling a person. Being wrong here
 * costs one `POST /v1/jobs/:id/unblocks`; being wrong in the other direction is
 * the loop this ficha was opened over.
 *
 * **The counter lives in the runner process, and that is a decision with a
 * tradeoff.** t265's consecutive-failure ceiling lives in the control plane
 * because it counts SESSION ROWS, and a streak of those crosses leases and
 * processes (`packages/core/src/repositories/job.ts`). A pre-session failure
 * creates no session row at all — there is nothing for that query to see — so
 * folding this into it would mean inventing a row for something that never
 * became one, and making `session` lie about what ran. Building a parallel
 * counter in core instead would mean a new column, a new event and a new route
 * for a fact the incident does not need: the loop that was measured happened
 * inside ONE runner process, in two minutes. What is given up is written down
 * rather than papered over — the streak does not survive a runner restart, and
 * two runners each get their own. Both make a work retry more than the ceiling
 * says, never less, which is the safe direction to be wrong in.
 *
 * Everything that decides is here; who posts the block is `blocks.ts` and who
 * sequences it is `dispatch.ts`, which is the same split `pre-session-failure.ts`
 * already runs under. Nothing here touches the database: the runner is an
 * ordinary client of the public API (D1, D11).
 *
 * English per D18. The reason is Portuguese, because it is what a PERSON reads
 * in the inbox — same voice as the five reasons next door.
 */

import { blockForPreSessionFailure, type JobRef } from './blocks.ts';
import type { ControlPlaneCall } from './control-plane-client.ts';
import { DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES } from './options.ts';
import { classifyPreSessionFailure } from './pre-session-failure.ts';

/**
 * The part of a work this decision needs: the id to address, the node to name,
 * and the version the classifier may quote.
 *
 * Declared here rather than imported from `options.ts`, the rule both
 * `blocks.ts` and `pre-session-failure.ts` already follow: this side owes the
 * orchestrator nothing, and structural typing means the dispatch's own `Job`
 * satisfies it without either file naming the other.
 */
export interface PreSessionRetryJob extends JobRef {
  /** The version it traverses, which is the one that may be dangling. */
  graph_version_id?: string | null;
}

/**
 * How many times in a row each work has failed before a session could open.
 *
 * One instance per `createClaudeCodeDispatch`, held in that closure, so a
 * streak survives from one tick to the next inside a runner process and nothing
 * is shared between two dispatches that were wired separately. A module-level
 * map would be a global: two runners in one process — which the spikes do
 * build — would count each other's failures.
 *
 * Keyed by job id and never by node: a work that moved to another node moved
 * because a session completed, and {@link reset} has already cleared it.
 */
export class PreSessionFailureTracker {
  readonly #streaks = new Map<number, number>();

  /**
   * Records one more failure for this work.
   *
   * @param jobId The work that failed.
   * @returns How many times in a row it has now failed, counting this one.
   */
  recordFailure(jobId: number): number {
    const next = (this.#streaks.get(jobId) ?? 0) + 1;
    this.#streaks.set(jobId, next);
    return next;
  }

  /**
   * Forgets this work's streak.
   *
   * Called from two places, and both are the same fact: the work is not stuck
   * anymore. A session that opened is the obvious one; a work that got blocked
   * is the other — it is out of the candidate list now, and a count left behind
   * would be waiting for whatever a person unblocks it into.
   *
   * @param jobId The work whose streak ends here. Unknown ids are ordinary.
   */
  reset(jobId: number): void {
    this.#streaks.delete(jobId);
  }
}

/**
 * The ceiling a dispatch actually runs with.
 *
 * `resolveBudget`'s posture (`engine/resolve-budget.ts`) with `resolveFailure-
 * Ceiling`'s guard (`packages/core/src/repositories/job.ts`): anything that is
 * not a positive integer is "no override", never "no ceiling". Reading a `0`
 * literally would block every work on its first hiccup, and a `NaN` would never
 * block anything — the two ways of having no policy at all, and both reachable
 * from a hand-written configuration.
 *
 * There is no server-side maximum to take the `min()` of, unlike the two
 * budgets: this ceiling protects the runner's own time, and a runner that wants
 * to try twenty times before telling anybody is only spending its own.
 *
 * @param declared What the dispatch was configured with, if anything.
 * @returns A positive integer.
 */
export function resolvePreSessionFailureCeiling(declared: number | undefined): number {
  return declared !== undefined && Number.isInteger(declared) && declared >= 1
    ? declared
    : DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES;
}

/** The message an error carries, whatever it turned out to be. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ONE decision point for every failure that happens before a session exists.
 *
 * Three call sites route through it (`dispatch.ts`, FR5) — the read window
 * before the worktree, the worktree acquisition itself, and a
 * `SessionStartError` from `startSession` — precisely so that the three cannot
 * drift into three policies. What it does, in order:
 *
 * 1. asks the classifier. A cause that reproduces identically stops the work on
 *    its FIRST occurrence, exactly as it did before this ficha: waiting five
 *    ticks to say "this skill is not in the registry" buys the same answer five
 *    times;
 * 2. counts, for everything else. Below the ceiling it hands back `null`, which
 *    means "not handled" — the caller rethrows and the loop retries, which is
 *    the behaviour t252 deliberately left in place for a control plane having a
 *    bad day;
 * 3. at the ceiling, stops the work with a reason that names the count and
 *    quotes the error. The count is the whole evidence there is: nobody can say
 *    WHY this failed, and a reason that hid how many times it happened would
 *    leave a person with nothing to go on.
 *
 * The block is the same `POST /v1/jobs/:id/blocks` every pre-session block
 * already uses (`blocks.ts`), with no new field and no new route: what makes
 * "forever" into "once" is `GET /v1/jobs` filtering `blocked === false`.
 *
 * @param error Whatever failed, unopened.
 * @param job The work being dispatched.
 * @param call The dispatch's control-plane client.
 * @param tracker The streaks of this runner process.
 * @param ceiling How many in a row are tolerated, already resolved.
 * @returns The reason that was posted, when the work was stopped; `null` when it
 *   was not, meaning the caller should rethrow and let the next tick try again.
 */
export async function handlePreSessionFailure(
  error: unknown,
  job: PreSessionRetryJob,
  call: ControlPlaneCall,
  tracker: PreSessionFailureTracker,
  ceiling: number,
): Promise<string | null> {
  const classified = classifyPreSessionFailure(error, job);
  if (classified !== null) {
    await blockForPreSessionFailure(call, job, classified);
    tracker.reset(job.id);
    return classified;
  }

  const failures = tracker.recordFailure(job.id);
  if (failures < ceiling) return null;

  const reason =
    `O despacho do nó \`${job.current_node_id}\` falhou ${String(failures)} vezes seguidas ` +
    'antes de conseguir abrir sessão, e o runner não sabe classificar a causa: ' +
    `${messageOf(error)}. Nenhuma sessão foi aberta em nenhuma dessas tentativas — o ` +
    'trabalho para aqui em vez de voltar para a fila a cada tick, que é o que faria dele ' +
    'uma lease por intervalo para sempre, com a fila do projeto parada atrás dele. Pode ' +
    'muito bem ser transitório: veja o que a mensagem aponta, e desbloqueie se já passou.';

  await blockForPreSessionFailure(call, job, reason);
  tracker.reset(job.id);
  return reason;
}
