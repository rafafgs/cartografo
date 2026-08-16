/**
 * The tick loop both background daemons of the control plane run on (t210).
 *
 * `src/webhooks/dispatcher.ts` (t142) wrote it first and `src/hooks/dispatcher.ts`
 * (t169) copied it, header and all — the timer, the `inFlight` guard, the
 * `onReady`/`onClose` pair, the try/catch that turns a bad tick into a log line
 * instead of a fallen process. The two copies never disagreed, which is exactly
 * why they were dangerous: a bug in the overlap guard, or in the shutdown wait,
 * would have had to be found and fixed twice.
 *
 * What is NOT here is what the two daemons genuinely do differently: the webhook
 * tick fans out over subscriptions before delivering, the hook tick only
 * delivers what is already in its table. That is the `run` callback, and it is
 * the whole of each dispatcher's own file now.
 *
 * The three rules this loop enforces, and why each one is not negotiable:
 *
 * - **Ticks never overlap.** While one is in flight the timer's next firing is
 *   dropped. Without it, a receiver slower than the interval gets attempted
 *   twice for the same delivery.
 * - **A failed tick is one tick lost, never a fallen process.** The next tick
 *   starts from the same tables and picks up where this one stopped.
 * - **`onClose` waits for the tick in flight.** That is what makes `app.close()`
 *   mean "nothing of mine is still writing"; a tick is bounded by the caller's
 *   own per-attempt timeout.
 *
 * The timer is `unref`ed, like the event stream's poll (`src/routes/events.ts`):
 * a dispatcher is no reason for the process to stay alive on its own.
 */

import type { FastifyInstance } from 'fastify';

/** Everything one polling daemon needs that this loop does not decide. */
export interface PollingDispatcherOptions {
  /** Interval between ticks. */
  tickIntervalMs: number;
  /**
   * Clock read ONCE per tick and handed to `run`.
   *
   * One reading per tick, not one per query: everything a tick decides about
   * what is due has to be decided against the same instant, or a slow tick
   * would compare its first batch and its last against different clocks.
   */
  now: () => string;
  /** The tick's work, whatever that is for this daemon. */
  run: (moment: string) => Promise<void>;
  /** Name of the daemon, used only in the log line of a failed tick. */
  name: string;
}

/**
 * Registers a polling tick on the app's lifecycle.
 *
 * The lifecycle hooks go on the whole app and not on the versioned scope, so
 * they fire exactly once — the same placement reasoning as `registerHealth`.
 *
 * @param app The Fastify app (not the `/v1` scope).
 * @param options Interval, clock, the work of one tick, and the daemon's name.
 */
export function createPollingDispatcher(
  app: FastifyInstance,
  options: PollingDispatcherOptions,
): void {
  const { tickIntervalMs, now, run, name } = options;

  const tick = async (): Promise<void> => {
    try {
      await run(now());
    } catch (failure) {
      app.log.error({ err: failure }, `${name} dispatcher tick failed`);
    }
  };

  let timer: NodeJS.Timeout | undefined;
  /** The tick in flight, or `null` — this is what stops two from overlapping. */
  let inFlight: Promise<void> | null = null;

  const schedule = (): void => {
    if (inFlight !== null) return;
    inFlight = tick().finally(() => {
      inFlight = null;
    });
  };

  app.addHook('onReady', async () => {
    timer = setInterval(schedule, tickIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  });

  app.addHook('onClose', async () => {
    if (timer !== undefined) clearInterval(timer);
    const pending = inFlight;
    if (pending !== null) await pending;
  });
}
