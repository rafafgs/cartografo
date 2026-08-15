/**
 * The webhook dispatcher (t142, FR4–FR8) — the first background daemon of the
 * control plane.
 *
 * Until this file, the only loop that ran on its own in the whole repository was
 * the runner's heartbeat (`packages/runner/src/controller/controller.ts:147-159`);
 * inside `packages/core` nothing polled anything — even lease expiry is decided
 * lazily, when somebody asks (`src/repositories/leases.ts:163-184`). So the
 * discipline of this tick is copied, deliberately, from the one background clock
 * this package already had reviewed: the stream's poll
 * (`src/routes/events.ts:195-196`) — bounded burst, `unref`ed timer, tied to the
 * app's lifecycle.
 *
 * What one tick does, in this order:
 *
 * 1. **Fan-out.** For every active subscription, read the log past its cursor
 *    through `listEvents` — the very same function the stream reads through, with
 *    the very same filters — and enqueue one delivery row per matched event.
 * 2. **Deliver.** Attempt everything that is due, in bounded batches, until it
 *    is caught up.
 *
 * Four rules keep a bad subscriber from being anybody else's problem (FR7):
 *
 * - the tick NEVER touches `recordEvent` and never writes to `evento`; it reads
 *   the log and writes only its own tables. A consumer that hangs cannot slow
 *   down a job transition, because there is no path from one to the other;
 * - each attempt is wrapped on its own, and the batch runs through
 *   `Promise.allSettled`: a rejection, a timeout, a non-2xx and a malformed
 *   response are all just "a failed attempt", recorded and moved past;
 * - a slow subscriber cannot hold the batch, because the attempts of one batch
 *   are in flight together, each with its own timeout;
 * - ticks never overlap: while one is in flight the timer's next firing is
 *   dropped. Without that, a subscriber slower than the interval would be
 *   attempted twice for the same delivery.
 *
 * Every clock, ceiling and the transport itself are injectable, which is what
 * lets `test/webhooks-dispatch.test.ts` prove a two-hour backoff step in
 * milliseconds and without opening a socket.
 *
 * The event-type strings and the column names stay in Portuguese: they are the
 * taxonomy's vocabulary and the schema's (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { listEvents } from '../db/events.ts';
import type { Event } from '../db/event-validation.ts';
import { now } from '../repositories/common.ts';
import {
  dueDeliveries,
  enqueueDeliveries,
  fanoutCursor,
  listSubscriptions,
  recordDeliveryFailure,
  recordDeliverySuccess,
  type DeliveryTask,
} from '../repositories/webhooks.ts';
import { SIGNATURE_HEADER, signPayload } from './signature.ts';

/** How often the dispatcher looks for work. */
export const DEFAULT_TICK_INTERVAL_MS = 1000;

/**
 * Delays between retries — five steps, so six attempts in total (FR6).
 *
 * It grows fast on purpose: a consumer that is down is usually down for minutes,
 * not for milliseconds, and the last step buys a two-hour outage without anybody
 * having to do anything. Past it the delivery gives up; the log is still the
 * source of truth, and it is still there.
 */
export const RETRY_BACKOFF_MS: readonly number[] = Object.freeze([
  10_000, 60_000, 300_000, 1_800_000, 7_200_000,
]);

/** Ceiling of events one subscription's fan-out reads per tick (FR4). */
export const FANOUT_CEILING = 500;

/** Ceiling of delivery attempts started at once; the tick loops until caught up. */
export const DELIVERY_CEILING = 50;

/** How long one attempt may take before it counts as a failure. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The slice of `fetch` the dispatcher uses; the global `fetch` satisfies it.
 *
 * Narrow on purpose: a test's stub is three lines, and nothing here depends on
 * the parts of the `Response` this file never reads.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number }>;

/** Clocks, ceilings and transport of the dispatcher; production uses defaults. */
export interface DispatcherOptions {
  /** Interval between ticks. Default: `DEFAULT_TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
  /** Retry schedule. Default: `RETRY_BACKOFF_MS`. */
  backoffMs?: readonly number[];
  /** Events read per subscription per tick. Default: `FANOUT_CEILING`. */
  fanoutCeiling?: number;
  /** Attempts started per batch. Default: `DELIVERY_CEILING`. */
  deliveryCeiling?: number;
  /** Timeout of one attempt. Default: `DELIVERY_TIMEOUT_MS`. */
  deliveryTimeoutMs?: number;
  /** Injectable clock. Default: the real one. */
  now?: () => string;
  /** Injectable transport. Default: the global `fetch`. */
  fetchImpl?: FetchLike;
}

/** Is this the response of a consumer that accepted the delivery? */
function accepted(response: { status: number } | undefined): boolean {
  return (
    typeof response?.status === 'number' && response.status >= 200 && response.status < 300
  );
}

/** What goes into `ultimo_erro` when an attempt threw. */
function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The envelope of one event, exactly as the stream serves it.
 *
 * `listEvents` has no by-id filter and `src/db/events.ts` is closed at three
 * exports (AT16), so the event is read as the first one AFTER `id - 1`. That is
 * one comparison more than a `WHERE id = ?` would cost, and it buys the
 * guarantee the whole ticket rests on: the body a consumer verifies is built by
 * the same function that builds the stream's, never by a second copy of the
 * envelope's shape.
 */
function eventById(db: Database, id: number): Event | undefined {
  const [found] = listEvents(db, { sinceId: id - 1, limit: 1 });
  return found?.id === id ? found : undefined;
}

/**
 * Registers the fan-out + delivery tick on the app's lifecycle (FR8).
 *
 * The hooks go on the whole app, not on the versioned scope, so they fire
 * exactly once — the same placement reasoning as `registerHealth`.
 *
 * @param app The Fastify app (not the `/v1` scope).
 * @param db Open database.
 * @param options Injected clocks, ceilings and transport.
 */
export function registerWebhookDispatcher(
  app: FastifyInstance,
  db: Database,
  options: DispatcherOptions = {},
): void {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const backoff = options.backoffMs ?? RETRY_BACKOFF_MS;
  const fanoutCeiling = options.fanoutCeiling ?? FANOUT_CEILING;
  const deliveryCeiling = options.deliveryCeiling ?? DELIVERY_CEILING;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init));
  // One clock object, built once and handed to every repository call, so the
  // whole tick reads the same time source.
  const clock = { now: options.now ?? now };

  /** Turns new events into delivery rows, one subscription at a time (FR4). */
  const fanout = (): void => {
    for (const subscription of listSubscriptions(db, { activeOnly: true })) {
      const matched = listEvents(db, {
        projetoId: subscription.projeto_id,
        tipos: subscription.tipos ?? undefined,
        sinceId: fanoutCursor(db, subscription),
        limit: fanoutCeiling,
      });
      if (matched.length === 0) continue;
      enqueueDeliveries(
        db,
        subscription.id,
        matched.map((event) => event.id),
        clock,
      );
    }
  };

  /** One attempt, which can only ever end as a recorded success or failure. */
  const attempt = async (task: DeliveryTask): Promise<void> => {
    const event = eventById(db, task.evento_id);
    if (event === undefined) {
      // Cannot happen while the foreign key holds; recorded as a failure anyway,
      // because a delivery with no event to carry must not stay due forever.
      recordDeliveryFailure(
        db,
        { id: task.id, message: `event ${task.evento_id} is not in the log`, backoff },
        clock,
      );
      return;
    }

    const rawBody = JSON.stringify(event);
    try {
      const response = await send(task.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signPayload(task.segredo, rawBody),
        },
        body: rawBody,
        // `AbortSignal.timeout` arms an `unref`ed timer, so a delivery in flight
        // is never a reason for the process to stay up.
        signal: AbortSignal.timeout(deliveryTimeoutMs),
      });

      if (accepted(response)) {
        recordDeliverySuccess(db, task.id, clock);
        return;
      }
      recordDeliveryFailure(
        db,
        { id: task.id, message: `HTTP ${String(response?.status)}`, backoff },
        clock,
      );
    } catch (failure) {
      recordDeliveryFailure(db, { id: task.id, message: describe(failure), backoff }, clock);
    }
  };

  /** Attempts everything that is due, in bounded batches (FR5). */
  const deliver = async (moment: string): Promise<void> => {
    for (;;) {
      const batch = dueDeliveries(db, moment, deliveryCeiling);
      if (batch.length === 0) return;

      // `allSettled` and not `all`: one attempt that throws where it was not
      // expected to must not cancel the batch of the other subscribers (FR7).
      await Promise.allSettled(batch.map(attempt));

      // A full batch means there may be more behind it. Everything just handled
      // is either terminal or scheduled into the future, so the next read is
      // strictly different work and this loop always ends.
      if (batch.length < deliveryCeiling) return;
    }
  };

  const tick = async (): Promise<void> => {
    try {
      fanout();
      await deliver(clock.now());
    } catch (failure) {
      // A tick that fails is one tick lost, never a process that falls: the
      // next one starts from the same tables and picks up where this stopped.
      app.log.error({ err: failure }, 'webhook dispatcher tick failed');
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
    // `unref`ed, like the stream's poll: a dispatcher is no reason for the
    // process to stay alive on its own.
    if (typeof timer.unref === 'function') timer.unref();
  });

  app.addHook('onClose', async () => {
    if (timer !== undefined) clearInterval(timer);
    // Waiting for the tick in flight is what makes `app.close()` mean "nothing
    // of mine is still writing" — a tick is bounded by the delivery timeout.
    const pending = inFlight;
    if (pending !== null) await pending;
  });
}
