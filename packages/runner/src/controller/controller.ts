/**
 * The runner's controller: the dispatch loop (t103, FR11).
 *
 * "Controller (inside the runner). Evaluates a directory (local mode) or asks
 * the API (distributed mode) to pick up released work. Maximum session control:
 * concurrency cap per runner and per project"
 * (`notas/2026-08-14-arquitetura-brain-dump.md`). This ticket implements the
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

/** Configuration of the controller. */
export interface ControllerOptions {
  /** Client already pointed at the control plane. */
  client: ClienteControle;
  /** Identity of this runner, already paired through `POST /v1/runners`. */
  runnerId: string;
  projectId: number;
  /** Cap of simultaneous sessions of this runner. */
  runnerCap: number;
  /** Cap of simultaneous sessions of the project, across every runner. */
  projectCap: number;
  /** Term of the lease asked for, in seconds. */
  ttlSeconds: number;
  /**
   * What to do with the work won. Resolves when the session ends; rejects when
   * it dies. In both cases the lease is given back.
   */
  dispatch: (jobId: number) => Promise<void>;
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
   * here only means another runner got there first or the cap is full — in both
   * cases trying the next one is the right move.
   *
   * @returns The work dispatched and the lease used, or `null` when there was
   *   no released work or no candidate yielded a lease.
   */
  async tick(): Promise<DispatchResult | null> {
    const candidates = await this.#options.client.listarTrabalhosLiberados();

    for (const job of candidates) {
      const { lease } = await this.#options.client.pedirLease({
        runner_id: this.#options.runnerId,
        projeto_id: this.#options.projectId,
        trabalho_id: job.id,
        teto_runner: this.#options.runnerCap,
        teto_projeto: this.#options.projectCap,
        ttl_segundos: this.#options.ttlSeconds,
      });

      if (lease === null) continue;

      await this.#dispatch(lease, job.id);
      return { jobId: job.id, leaseId: lease.id };
    }

    return null;
  }

  /** Dispatches under the lease, with the heartbeat armed, and returns it at the end. */
  async #dispatch(lease: Lease, jobId: number): Promise<void> {
    const stopHeartbeat = this.#armHeartbeat(lease);

    try {
      await this.#options.dispatch(jobId);
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
