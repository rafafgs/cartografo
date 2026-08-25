/**
 * The runner's controller: the dispatch loop (t103, FR11).
 *
 * "Controller (inside the runner). Evaluates a directory (local mode) or asks
 * the API (distributed mode) to pick up released work. Maximum session control:
 * concurrency cap per runner and per project"
 * (`notes/2026-08-14-architecture-brain-dump.md`). This ticket implements the
 * API path; local mode was left out for having no contract written anywhere in
 * the repo.
 *
 * One `tick()` is a complete pass: it asks what has been released, competes for
 * the lease of the first candidate that accepts, and — winning it — keeps the
 * heartbeat going while the dispatch runs. The cap is decided on the server
 * (D1), not here: the controller only declares the limits and obeys the answer.
 * Two runners asking at the same time do not need to know about each other.
 *
 * The rule that must not break: **the lease is always given back**. If the
 * dispatch blows up, the lease goes away all the same and only then does the
 * error travel up. A lease stuck on work that failed is capacity occupied by
 * nobody until the TTL expires — the worst of both worlds.
 *
 * Which error travels up is a separate question, and the answer is always **the
 * dispatch's**. Giving the lease back is cleanup, and cleanup that fails does
 * not get to speak for the work: a control plane that answers 503 on the
 * release would otherwise erase the reason the session died and leave whoever
 * called `tick()` reading about a lease. The release failure lands in
 * {@link Controller.lastReleaseError} instead.
 *
 * `dispatch` is injected and is the only seam with the `EngineAdapter` (t104):
 * this ticket opens no session at all. Whoever wires the cycle end to end with
 * a real session (t106/t109) passes the adapter through here without touching
 * this file.
 */

import type { ClienteControle, Lease } from './cliente-controle.ts';

/**
 * What one dispatch reports back about the work it was handed (t252).
 *
 * One field, and it answers one question: is this job still a candidate? A
 * dispatch that hit a failure which will reproduce on every retry — an engine
 * with no route, a skill nobody registered, a placeholder that does not resolve
 * — blocks the work itself and says so here, and the pass moves on to the next
 * candidate instead of returning as if a session had run.
 *
 * **Declared here, and deliberately not imported from `dispatch.ts`.** This file
 * has never imported that one, which is what the paragraph above means by "the
 * only seam is an injected callback": the controller opens no session and knows
 * about no engine. `dispatch.ts` answers with a richer shape of its own — it
 * carries the reason it blocked with — and structural typing means it satisfies
 * this without either module naming the other.
 */
export interface DispatchAttempt {
  /** `true` when the dispatch stopped the work rather than running it. */
  blocked: boolean;
}

/** Configuration of the controller. */
export interface ControllerOptions {
  /** Client already pointed at the control plane. */
  client: ClienteControle;
  /** Identity of this runner, already paired through `POST /v1/runners`. */
  runnerId: string;
  projectId: number;
  /**
   * The ceiling this runner DECLARES to the control plane for its own
   * `runner_id` (`teto_runner`) — `--declared-runner-cap` on the command line.
   *
   * It is not, and has never been, a count of sessions this process opens at
   * once: {@link Controller.tick} asks for at most one lease per pass and awaits
   * the whole dispatch before the loop can turn again, whatever the number says
   * (t208). Two things follow from that, and both are the point of the name.
   * The value is a declaration, and the server decides: it takes the MIN with
   * its own configured ceiling and is the one that enforces it (D1). And
   * scaling is horizontal — more runner processes under the same project,
   * sharing the project's ceiling through the server-side transaction, which is
   * what `multi-runner-fleet.e2e.test.ts` proves.
   */
  runnerCap: number;
  /** Cap of simultaneous sessions of the project, across every runner. */
  projectCap: number;
  /** Term of the lease asked for, in seconds. */
  ttlSeconds: number;
  /**
   * What to do with the work won. Resolves when the session ends; rejects when
   * it dies. In both cases the lease is given back.
   *
   * Since t252 it also resolves — with {@link DispatchAttempt.blocked} true —
   * for a work it stopped before opening anything, which is neither of those two
   * and must not be reported as either.
   */
  dispatch: (jobId: number) => Promise<DispatchAttempt>;
  /**
   * Interval between heartbeats. Default: a third of the TTL — slack for two
   * missed beats before the server gives the runner up for dead.
   *
   * Whoever passes an explicit value takes on the arithmetic: an interval
   * larger than the TTL lets the lease itself expire under the dispatch.
   */
  heartbeatIntervalMs?: number;
}

/** What one `tick()` won. */
export interface DispatchResult {
  jobId: number;
  leaseId: number;
}

export class Controller {
  readonly #options: ControllerOptions;

  /**
   * Last heartbeat error, for whoever wants to watch.
   *
   * A heartbeat that fails does NOT bring down the dispatch in flight: an
   * isolated network failure is transient, and the consequence of several in a
   * row is already the right one — the lease expires on the server and the work
   * goes back to the queue (D5). Killing the session on the first failure would
   * be trading a network hiccup for lost work.
   */
  lastHeartbeatError: unknown = null;

  /**
   * Last error from giving the lease back, for whoever wants to watch.
   *
   * Same shape of problem as {@link Controller.lastHeartbeatError}, one step
   * later: a background failure that must not kill the primary error path, but
   * must still be observable. A release that fails is transient — the lease
   * expires on the server by its own TTL and the work goes back to the queue
   * (D5) — while the dispatch's error is the one nobody else can reconstruct.
   * Letting the release's rejection out of the `finally` would trade the
   * irreplaceable one for the recoverable one.
   */
  lastReleaseError: unknown = null;

  constructor(options: ControllerOptions) {
    this.#options = options;
  }

  /** Effective interval between heartbeats, in milliseconds. */
  get heartbeatIntervalMs(): number {
    return (
      this.#options.heartbeatIntervalMs ?? Math.max(1, Math.floor((this.#options.ttlSeconds * 1000) / 3))
    );
  }

  /**
   * One pass of the dispatch loop.
   *
   * It tries the candidates in order and stops at the first one that yields a
   * lease: whoever decides whether there is room is the server, so "refused"
   * here means the answer to THIS request, and what to do next depends on which
   * refusal came back (t208).
   *
   * - `trabalho_ja_leased` is about one job's ownership — another runner got
   *   there first. It says nothing about the next candidate, which is why the
   *   loop tries it. This is the common answer of a healthy pool.
   * - `teto_runner` and `teto_projeto` are about capacity, and the capacity is
   *   this runner's or this project's, not this job's. Every remaining
   *   candidate in the same tick would come back with the identical answer, so
   *   the pass ends here: asking anyway spends one POST /v1/leases per
   *   candidate to be told what the first one already said.
   *
   * The pass that stops early is not a pass that gave up. The loop asks again
   * at the next interval, and by then a lease somewhere may have been released
   * or expired — which is the retry mechanism this layer already had.
   *
   * There is a third answer since t252, and it belongs to the DISPATCH rather
   * than to the lease: a work the dispatch blocked before opening anything. It
   * is not capacity refused and it is not work done, so the loop simply tries
   * the next candidate in the same pass — the blocked work has already left the
   * candidate list on the server (`GET /v1/jobs` filters `blocked === false`),
   * and waiting for the next interval to discover that would let one broken job
   * hold up every other released job of the project.
   *
   * @returns The work dispatched and the lease used, or `null` when there was
   *   no released work, no candidate yielded a lease, or every candidate that
   *   did blocked itself.
   */
  async tick(): Promise<DispatchResult | null> {
    const candidates = await this.#options.client.listarTrabalhosLiberados();

    for (const job of candidates) {
      const { lease, reason: motivo } = await this.#options.client.pedirLease({
        runner_id: this.#options.runnerId,
        project_id: this.#options.projectId,
        job_id: job.id,
        runner_cap: this.#options.runnerCap,
        project_cap: this.#options.projectCap,
        ttl_seconds: this.#options.ttlSeconds,
      });

      if (lease === null) {
        if (motivo === 'runner_cap' || motivo === 'project_cap') break;
        continue;
      }

      const attempt = await this.#dispatch(lease, job.id);
      // A block is a normal resolution, never an error: the lease has already
      // gone back through `#dispatch`'s own `finally`, and what is in front of
      // the loop now is simply one candidate fewer.
      if (attempt.blocked) continue;

      return { jobId: job.id, leaseId: lease.id };
    }

    return null;
  }

  /** Dispatches under the lease, with the heartbeat armed, and returns it at the end. */
  async #dispatch(lease: Lease, jobId: number): Promise<DispatchAttempt> {
    const stopHeartbeat = this.#armHeartbeat(lease);

    try {
      // Awaited and not just returned: a bare `return` would hand the promise
      // over before the `finally` below could run, and the lease would go back
      // while the dispatch was still in flight.
      return await this.#options.dispatch(jobId);
    } finally {
      // `finally`, and not the happy path: work that blows up gives the lease
      // back exactly like work that ends well. The dispatch error keeps
      // travelling up after this — whoever calls the loop decides what to do
      // with it.
      stopHeartbeat();
      try {
        await this.#options.client.liberar(lease.id);
      } catch (error: unknown) {
        // Caught HERE and nowhere else: a rejection escaping a `finally`
        // REPLACES whatever was already unwinding through it, so this one would
        // quietly take the dispatch's place on the way out. The attempt was
        // made, the fact is recorded, and the outcome of the work — error or
        // not — stays the outcome of `tick()`.
        this.lastReleaseError = error;
      }
    }
  }

  /**
   * Arms the lease's periodic heartbeat.
   *
   * The clock is `unref`ed: a runner waiting for a session to end is no reason
   * for the process to stay up on its own.
   *
   * Two things the interval decides, and both of them are about a control plane
   * that stopped answering rather than one that is down (t193):
   *
   * - **it is also the beat's own deadline.** A beat given the client's general
   *   30s while the interval is 20s would still be in the air when the next one
   *   is due, and what it renews by then is a lease that already expired. It
   *   fails on its own window instead, which is the honest report — the lease
   *   goes back to the queue on the server, which is what D5 asks for.
   * - **a beat still in flight is SKIPPED, never overlapped.** Otherwise a
   *   stalled control plane collects one open request per interval for as long
   *   as the session runs, and the runner spends the session leaking sockets to
   *   ask a question nobody is answering. What a skip costs is one beat, and
   *   the TTL already tolerates two.
   *
   * {@link Controller.lastHeartbeatError} records every failure exactly as it
   * always did. A skipped window is not one of them: nothing was asked in it,
   * so there was nothing to fail — and the beat it skipped for is still out
   * there, and still records if it comes back an error.
   *
   * @param lease A freshly granted lease.
   * @returns Function that disarms the clock.
   */
  #armHeartbeat(lease: Lease): () => void {
    const intervalMs = this.heartbeatIntervalMs;
    let inFlight = false;

    const clock = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void this.#options.client
        .heartbeat(lease.id, undefined, intervalMs)
        .catch((error: unknown) => {
          this.lastHeartbeatError = error;
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);

    if (typeof clock.unref === 'function') clock.unref();

    return () => {
      clearInterval(clock);
    };
  }
}
