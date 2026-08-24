/**
 * Access to `webhook_subscription` and `webhook_delivery` (t142, FR1–FR6).
 *
 * Two tables, one repository, because they are one story: what was contracted
 * and what happened to it. Everything that decides WHEN a delivery is attempted
 * lives here; the dispatcher (`src/webhooks/dispatcher.ts`) only asks what is
 * due and reports how it went.
 *
 * Three decisions are worth knowing before reading the code:
 *
 * - **The secret leaves this module exactly once, and only downwards.** The
 *   public view (`Subscription`) has no field for it, so no route can leak it by
 *   accident; the only reader is `dueDeliveries`, which hands it to the signer.
 *   That is a stronger guarantee than remembering to strip a field in every
 *   response.
 * - **The fan-out cursor is derived, never stored.** It is `MAX(event_id)`
 *   among the subscription's own delivery rows, falling back to
 *   `initial_event_id`. A mutable cursor column would be a second piece of
 *   state that can disagree with what was actually enqueued; this one cannot,
 *   because it IS what was enqueued.
 * - **Re-running the fan-out is free.** `enqueueDeliveries` is
 *   `INSERT OR IGNORE` over the `UNIQUE (subscription_id, event_id)` of the
 *   migration, so a tick that died halfway costs a repeated read and nothing
 *   else.
 *
 * The `event` table is only ever READ from here (`MAX(id)`, at creation time),
 * the same direct read the stream already does (`src/routes/events.ts:143-146`)
 * and for the same reason: `src/db/events.ts` keeps exactly three exports
 * (`test/event-append-only.test.ts`, AT16).
 *
 * `now` is injectable (default: the real clock), like `repositories/leases.ts`:
 * "the backoff step has passed" has to be testable without a two-hour `sleep`.
 *
 * The COLUMNS are English since D20's fourth child (t229) and the field names
 * since t290 — {@link DeliveryTask}, {@link NewSubscription} and the private
 * subscription row used to be spelled `assinatura_id`/`segredo`/`tipos`/…,
 * because `src/webhooks/dispatcher.ts` and `routes/webhooks.ts` read them, and
 * every `SELECT` aliased the renamed column back onto the field.
 *
 * What survived that deletion is the one thing the mapper did besides renaming:
 * {@link hydrate} still parses `filter_types` out of the TEXT the column stores.
 * That is why a private row interface is still here at all — its `filter_types`
 * is a `string`, and {@link Subscription}'s is a `string[]`.
 */

import type { Database } from '../db/connection.ts';
import { jsonOrNull, now } from './common.ts';

/** Injectable clock; without it, the real one. */
export interface ClockOptions {
  now?: () => string;
}

/**
 * A subscription as the API shows it — deliberately without the secret.
 *
 * This type IS the wire (t226, FR1), and since t290 the row's own words as well:
 * the columns it comes from are `project_id`/`filter_types`/`created_at` since
 * t229, and the only field {@link hydrate} still does anything to is the JSON
 * one. Before t226 the mapper renamed one column and let five other names
 * straight through, which is the leak that ticket closed.
 */
export interface Subscription {
  id: number;
  project_id: number;
  url: string;
  /** Taxonomy types this subscription wants; `null` means every type. */
  filter_types: string[] | null;
  /** `MAX(event.id)` at creation time — where the fan-out starts (FR4). */
  initial_event_id: number;
  created_at: string;
  deactivated_at: string | null;
}

/** What the caller declares when registering a subscription. */
export interface NewSubscription {
  project_id: number;
  url: string;
  /** Key of the HMAC. Supplied by the caller; the server never generates one. */
  secret: string;
  /** Types to filter by, already validated against the taxonomy, or `null`. */
  filter_types: string[] | null;
}

/** Listing filters (FR2). */
export interface SubscriptionFilters {
  project_id?: number;
  /** Only subscriptions that were not deactivated — what the fan-out asks for. */
  activeOnly?: boolean;
}

/** A delivery that is due, already carrying what an attempt needs (FR5). */
export interface DeliveryTask {
  id: number;
  subscription_id: number;
  event_id: number;
  /** Attempts already made — the index into the backoff schedule. */
  attempts: number;
  url: string;
  /** The HMAC key. It exists in memory for the length of one attempt. */
  secret: string;
}

/** What a failed attempt reports back. */
export interface FailedAttempt {
  id: number;
  /** What went wrong, as it goes into `last_error`. */
  message: string;
  /** The retry schedule; its length is how many retries there are (FR6). */
  backoff: readonly number[];
}

/**
 * Raw subscription row, before the JSON in it is parsed.
 *
 * Field for field {@link Subscription}, with one difference and only one:
 * `filter_types` is the TEXT the column stores rather than the list it encodes.
 */
interface SubscriptionRow extends Omit<Subscription, 'filter_types'> {
  filter_types: string | null;
}

/** Every column of the subscription EXCEPT the secret. */
const SUBSCRIPTION_COLUMNS = `id, project_id, url, filter_types,
                              initial_event_id, created_at, deactivated_at`;

/** What `last_error` records when the subscription itself went away (FR3). */
const DEACTIVATED = 'subscription deactivated';

/**
 * Parses the row's one JSON column into the view the API returns.
 *
 * Not a translator, which is why it outlived the ones t290 deleted: every other
 * field goes straight across, and `filter_types` changes TYPE rather than name.
 */
function hydrate(row: SubscriptionRow): Subscription {
  return { ...row, filter_types: jsonOrNull<string[]>(row.filter_types) };
}

/** An ISO 8601 instant shifted by milliseconds — the backoff's arithmetic. */
function addMilliseconds(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/**
 * Registers a subscription, anchored at the current end of the log.
 *
 * Reading `MAX(event.id)` and writing the row happen in one transaction: an
 * event landing between the two would otherwise decide, by luck, whether the
 * brand-new subscription receives it.
 *
 * @param db Open database.
 * @param data URL, secret, project and type filter, already validated.
 * @param options Injectable clock.
 * @returns The created subscription, without the secret.
 */
export function createSubscription(
  db: Database,
  data: NewSubscription,
  options: ClockOptions = {},
): Subscription {
  const clock = options.now ?? now;

  return db.transaction((): Subscription => {
    const last = db.prepare('SELECT MAX(id) AS last_id FROM event').get() as {
      last_id: number | null;
    };

    const effect = db
      .prepare(
        `INSERT INTO webhook_subscription
           (project_id, url, secret, filter_types, initial_event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.project_id,
        data.url,
        data.secret,
        data.filter_types === null ? null : JSON.stringify(data.filter_types),
        last.last_id ?? 0,
        clock(),
      );

    const created = getSubscription(db, Number(effect.lastInsertRowid));
    if (created === undefined) throw new Error('the subscription was not written');
    return created;
  })();
}

/**
 * @param db Open database.
 * @param id Subscription id.
 * @returns The subscription, or `undefined`.
 */
export function getSubscription(db: Database, id: number): Subscription | undefined {
  const row = db
    .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscription WHERE id = ?`)
    .get(id) as SubscriptionRow | undefined;
  return row === undefined ? undefined : hydrate(row);
}

/**
 * @param db Open database.
 * @param filters Optional slice by project and by "still active".
 * @returns The matching subscriptions, in creation order.
 */
export function listSubscriptions(
  db: Database,
  filters: SubscriptionFilters = {},
): Subscription[] {
  const conditions: string[] = [];
  const values: number[] = [];

  if (filters.project_id !== undefined) {
    conditions.push('project_id = ?');
    values.push(filters.project_id);
  }
  if (filters.activeOnly === true) conditions.push('deactivated_at IS NULL');

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM webhook_subscription${where} ORDER BY id`)
    .all(...values) as SubscriptionRow[];
  return rows.map(hydrate);
}

/**
 * Deactivates a subscription and closes what it still had in flight (FR3).
 *
 * Both writes are one transaction because they are one fact: "this consumer is
 * gone". Leaving the pending deliveries behind would keep a dead URL being
 * retried for up to two hours, and deleting them would throw away the record of
 * what was never delivered.
 *
 * Calling it twice is not an error and does not move the instant of the first
 * call: deactivating is a state, not an event to be counted.
 *
 * @param db Open database.
 * @param id Subscription id.
 * @param options Injectable clock.
 * @returns The deactivated subscription, or `undefined` when the id is unknown.
 */
export function deactivateSubscription(
  db: Database,
  id: number,
  options: ClockOptions = {},
): Subscription | undefined {
  const clock = options.now ?? now;

  return db.transaction((): Subscription | undefined => {
    const current = getSubscription(db, id);
    if (current === undefined) return undefined;
    if (current.deactivated_at !== null) return current;

    const moment = clock();
    db.prepare(
      'UPDATE webhook_subscription SET deactivated_at = ? WHERE id = ? AND deactivated_at IS NULL',
    ).run(moment, id);
    db.prepare(
      `UPDATE webhook_delivery SET status = 'exhausted', last_error = ?
        WHERE subscription_id = ? AND status = 'pending'`,
    ).run(DEACTIVATED, id);

    return getSubscription(db, id);
  })();
}

/**
 * Enqueues one delivery per event, skipping what is already enqueued (FR4).
 *
 * `INSERT OR IGNORE` plus the migration's `UNIQUE (subscription_id, event_id)`
 * is the whole idempotency story: the same window can be fanned out any number
 * of times and produce the same rows.
 *
 * The delivery is born due (`next_attempt_at` = now), so the same tick that
 * enqueues it can also attempt it.
 *
 * @param db Open database.
 * @param subscriptionId Subscription the events go to.
 * @param eventIds Ids of the matched events, in log order.
 * @param options Injectable clock.
 * @returns How many rows this call actually created.
 */
export function enqueueDeliveries(
  db: Database,
  subscriptionId: number,
  eventIds: readonly number[],
  options: ClockOptions = {},
): number {
  const moment = (options.now ?? now)();
  const statement = db.prepare(
    `INSERT OR IGNORE INTO webhook_delivery
       (subscription_id, event_id, status, next_attempt_at, created_at)
     VALUES (?, ?, 'pending', ?, ?)`,
  );

  return db.transaction((): number => {
    let created = 0;
    for (const eventId of eventIds) {
      created += statement.run(subscriptionId, eventId, moment, moment).changes;
    }
    return created;
  })();
}

/**
 * Where the fan-out of this subscription resumes (FR4).
 *
 * @param db Open database.
 * @param subscription The subscription being fanned out.
 * @returns The highest event id already enqueued for it, or its
 *   `initial_event_id` when it has never received anything.
 */
export function fanoutCursor(db: Database, subscription: Subscription): number {
  const row = db
    .prepare('SELECT MAX(event_id) AS last_id FROM webhook_delivery WHERE subscription_id = ?')
    .get(subscription.id) as { last_id: number | null };
  return row.last_id ?? subscription.initial_event_id;
}

/**
 * The deliveries whose time has come, oldest first (FR5).
 *
 * A deactivated subscription is filtered out here as well as having its rows
 * closed by `deactivateSubscription`: the first is what stops an attempt that
 * was already selected, the second is what stops it being selected again.
 *
 * @param db Open database.
 * @param moment Reference instant.
 * @param limit Ceiling of one tick's burst.
 * @returns Due deliveries, each carrying the URL and the secret of its
 *   subscription.
 */
export function dueDeliveries(db: Database, moment: string, limit: number): DeliveryTask[] {
  return db
    .prepare(
      `SELECT delivery.id,
              delivery.subscription_id,
              delivery.event_id,
              delivery.attempts,
              subscription.url,
              subscription.secret
         FROM webhook_delivery AS delivery
         JOIN webhook_subscription AS subscription
           ON subscription.id = delivery.subscription_id
        WHERE delivery.status = 'pending'
          AND delivery.next_attempt_at <= ?
          AND subscription.deactivated_at IS NULL
        ORDER BY delivery.id
        LIMIT ?`,
    )
    .all(moment, limit) as DeliveryTask[];
}

/**
 * Closes a delivery that got a 2xx (FR6).
 *
 * Guarded by `status = 'pending'`: a delivery closed while this attempt was in
 * flight — the subscription was deactivated meanwhile — stays closed.
 *
 * @param db Open database.
 * @param id Delivery id.
 * @param options Injectable clock.
 */
export function recordDeliverySuccess(db: Database, id: number, options: ClockOptions = {}): void {
  db.prepare(
    `UPDATE webhook_delivery
        SET status = 'delivered', attempts = attempts + 1, delivered_at = ?, last_error = NULL
      WHERE id = ? AND status = 'pending'`,
  ).run((options.now ?? now)(), id);
}

/**
 * Records a failed attempt and decides between waiting and giving up (FR6).
 *
 * The schedule is read as the list of RETRY delays, so a schedule of five steps
 * means six attempts in total: the first one, plus one per step. When the
 * attempt that just failed has no step left, the delivery is `exhausted` and
 * terminal — the row stays, because "tried six times and gave up" is the fact
 * whoever debugs a silent integration is looking for.
 *
 * @param db Open database.
 * @param attempt Delivery id, what went wrong, and the schedule.
 * @param options Injectable clock.
 */
export function recordDeliveryFailure(
  db: Database,
  attempt: FailedAttempt,
  options: ClockOptions = {},
): void {
  const clock = options.now ?? now;

  db.transaction(() => {
    const current = db
      .prepare("SELECT attempts FROM webhook_delivery WHERE id = ? AND status = 'pending'")
      .get(attempt.id) as { attempts: number } | undefined;
    if (current === undefined) return;

    const made = current.attempts + 1;
    const step = attempt.backoff[made - 1];

    if (step === undefined) {
      db.prepare(
        `UPDATE webhook_delivery SET status = 'exhausted', attempts = ?, last_error = ?
          WHERE id = ? AND status = 'pending'`,
      ).run(made, attempt.message, attempt.id);
      return;
    }

    db.prepare(
      `UPDATE webhook_delivery SET attempts = ?, last_error = ?, next_attempt_at = ?
        WHERE id = ? AND status = 'pending'`,
    ).run(made, attempt.message, addMilliseconds(clock(), step), attempt.id);
  })();
}
