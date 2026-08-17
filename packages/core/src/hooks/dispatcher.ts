/**
 * The hook dispatcher (t169, FR8–FR10) — the second background daemon of the
 * control plane, and deliberately the same daemon as the first.
 *
 * Everything about WHEN and HOW an attempt happens is imported from
 * `src/webhooks/dispatcher.ts` (t142): the backoff schedule, the batch ceiling,
 * the per-attempt timeout, the signature recipe. That is not laziness — a
 * consumer that already implemented a cartografo receiver has to be able to
 * point it at a graph-declared hook without changing a line, and two schedules
 * that drift apart is the failure mode a shared constant makes impossible.
 *
 * What is NOT shared is the fan-out, because a hook has none. A webhook delivery
 * is born of a sweep over registered subscriptions; a hook delivery is already
 * in the table when this tick starts, put there by `transitionJob`/`blockJob`
 * inside the transaction of the fact that fired it. So one tick here does one
 * thing: attempt what is due.
 *
 * The four rules that keep a bad receiver from being anybody else's problem are
 * t142's, unchanged — each attempt wrapped on its own, the batch through
 * `Promise.allSettled`, a per-attempt timeout, and ticks that never overlap.
 * The last of those is no longer a copy: since t210 both daemons take the timer,
 * the overlap guard and the `onReady`/`onClose` pair from the one
 * `createPollingDispatcher` in `src/util/polling-dispatcher.ts`.
 *
 * The ONE deliberate divergence: on the sixth failure this dispatcher's
 * repository call records a `job.hook_failed` event, which t142's tick
 * never does. The reasoning is in `src/repositories/hooks.ts` — a hook nobody
 * registered is a hook nobody is polling — and the exception is as narrow as it
 * can be: only on exhaustion, only through that one function, and never on a
 * path that can reach the job's traversal.
 *
 * The COLUMN names stay in Portuguese — the schema is untouched, and renaming
 * it is D20's fifth child. The event this dispatcher delivers is English on
 * every key since t227, and nothing here had to change for that: the body is
 * `JSON.stringify(event)` and the signature is over those bytes, whatever they
 * spell.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { listEvents } from '../db/events.ts';
import type { Event } from '../db/event-validation.ts';
import { now } from '../repositories/common.ts';
import {
  dueHookDeliveries,
  recordHookDeliveryFailure,
  recordHookDeliverySuccess,
  type HookDeliveryTask,
} from '../repositories/hooks.ts';
import { createPollingDispatcher } from '../util/polling-dispatcher.ts';
import {
  DEFAULT_TICK_INTERVAL_MS,
  DELIVERY_CEILING,
  DELIVERY_TIMEOUT_MS,
  RETRY_BACKOFF_MS,
  type FetchLike,
} from '../webhooks/dispatcher.ts';
import { SIGNATURE_HEADER, signPayload } from '../webhooks/signature.ts';

/** Clocks, ceilings and transport of the dispatcher; production uses defaults. */
export interface HookDispatcherOptions {
  /** Interval between ticks. Default: t142's `DEFAULT_TICK_INTERVAL_MS`. */
  tickIntervalMs?: number;
  /** Retry schedule. Default: t142's `RETRY_BACKOFF_MS`. */
  backoffMs?: readonly number[];
  /** Attempts started per batch. Default: t142's `DELIVERY_CEILING`. */
  deliveryCeiling?: number;
  /** Timeout of one attempt. Default: t142's `DELIVERY_TIMEOUT_MS`. */
  deliveryTimeoutMs?: number;
  /** Injectable clock. Default: the real one. */
  now?: () => string;
  /** Injectable transport. Default: the global `fetch`. */
  fetchImpl?: FetchLike;
}

/** Is this the response of a receiver that accepted the delivery? */
function accepted(response: { status: number } | undefined): boolean {
  return typeof response?.status === 'number' && response.status >= 200 && response.status < 300;
}

/** What goes into `ultimo_erro` when an attempt threw. */
function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The envelope of one event, exactly as the stream and t142 serve it.
 *
 * Same trick as `src/webhooks/dispatcher.ts`: `listEvents` has no by-id filter
 * and `src/db/events.ts` is closed at three exports (AT16), so the event is read
 * as the first one AFTER `id - 1`. One comparison more than a `WHERE id = ?`,
 * and it buys the guarantee this ticket rests on — the body a receiver verifies
 * is built by the same function that builds the stream's, never by a second copy
 * of the envelope's shape.
 */
function eventById(db: Database, id: number): Event | undefined {
  const [found] = listEvents(db, { sinceId: id - 1, limit: 1 });
  return found?.id === id ? found : undefined;
}

/**
 * Registers the hook delivery tick on the app's lifecycle (FR8).
 *
 * The hooks go on the whole app, not on the versioned scope, so they fire
 * exactly once — the same placement reasoning as `registerWebhookDispatcher`.
 *
 * @param app The Fastify app (not the `/v1` scope).
 * @param db Open database.
 * @param options Injected clocks, ceilings and transport.
 */
export function registerHookDispatcher(
  app: FastifyInstance,
  db: Database,
  options: HookDispatcherOptions = {},
): void {
  const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const backoff = options.backoffMs ?? RETRY_BACKOFF_MS;
  const deliveryCeiling = options.deliveryCeiling ?? DELIVERY_CEILING;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  const send = options.fetchImpl ?? ((url, init) => fetch(url, init));
  // One clock object, built once and handed to every repository call, so the
  // whole tick reads the same time source.
  const clock = { now: options.now ?? now };

  /** One attempt, which can only ever end as a recorded success or failure. */
  const attempt = async (task: HookDeliveryTask): Promise<void> => {
    const event = eventById(db, task.evento_id);
    if (event === undefined) {
      // Cannot happen while the foreign key holds; recorded as a failure anyway,
      // because a delivery with no event to carry must not stay due forever.
      recordHookDeliveryFailure(
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
        recordHookDeliverySuccess(db, task.id, clock);
        return;
      }
      recordHookDeliveryFailure(
        db,
        { id: task.id, message: `HTTP ${String(response?.status)}`, backoff },
        clock,
      );
    } catch (failure) {
      recordHookDeliveryFailure(db, { id: task.id, message: describe(failure), backoff }, clock);
    }
  };

  /** Attempts everything that is due, in bounded batches. */
  const deliver = async (moment: string): Promise<void> => {
    for (;;) {
      const batch = dueHookDeliveries(db, moment, deliveryCeiling);
      if (batch.length === 0) return;

      // `allSettled` and not `all`: one attempt that throws where it was not
      // expected to must not cancel the batch of the other hooks.
      await Promise.allSettled(batch.map(attempt));

      // A full batch means there may be more behind it. Everything just handled
      // is either terminal or scheduled into the future, so the next read is
      // strictly different work and this loop always ends.
      if (batch.length < deliveryCeiling) return;
    }
  };

  // One hook tick is one `deliver`, and there is no fan-out to precede it: the
  // rows are already in the table, put there inside the transaction of the fact
  // that fired them. Everything about WHEN it runs is the shared loop's (t210).
  createPollingDispatcher(app, {
    tickIntervalMs,
    now: clock.now,
    name: 'hook',
    run: deliver,
  });
}
