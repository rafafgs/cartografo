/**
 * Access to `assinatura_webhook` and `entrega_webhook` (t142, FR1–FR6).
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
 * - **The fan-out cursor is derived, never stored.** It is `MAX(evento_id)`
 *   among the subscription's own delivery rows, falling back to
 *   `evento_inicial_id`. A mutable cursor column would be a second piece of
 *   state that can disagree with what was actually enqueued; this one cannot,
 *   because it IS what was enqueued.
 * - **Re-running the fan-out is free.** `enqueueDeliveries` is
 *   `INSERT OR IGNORE` over the `UNIQUE (assinatura_id, evento_id)` of the
 *   migration, so a tick that died halfway costs a repeated read and nothing
 *   else.
 *
 * The `evento` table is only ever READ from here (`MAX(id)`, at creation time),
 * the same direct read the stream already does (`src/routes/events.ts:143-146`)
 * and for the same reason: `src/db/events.ts` keeps exactly three exports
 * (`test/event-append-only.test.ts`, AT16).
 *
 * `now` is injectable (default: the real clock), like `repositories/leases.ts`:
 * "the backoff step has passed" has to be testable without a two-hour `sleep`.
 *
 * The row field names mirror the untouched migration columns, so they stay in
 * Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { jsonOrNull, now } from './common.ts';

/** Injectable clock; without it, the real one. */
export interface ClockOptions {
  now?: () => string;
}

/** A subscription as the API shows it — deliberately without `segredo`. */
export interface Subscription {
  id: number;
  projeto_id: number;
  url: string;
  /** Taxonomy types this subscription wants; `null` means every type. */
  tipos: string[] | null;
  /** `MAX(evento.id)` at creation time — where the fan-out starts (FR4). */
  evento_inicial_id: number;
  criada_em: string;
  desativada_em: string | null;
}

/** What the caller declares when registering a subscription. */
export interface NewSubscription {
  projeto_id: number;
  url: string;
  /** Key of the HMAC. Supplied by the caller; the server never generates one. */
  segredo: string;
  /** Types to filter by, already validated against the taxonomy, or `null`. */
  tipos: string[] | null;
}

/** Listing filters (FR2). */
export interface SubscriptionFilters {
  projeto_id?: number;
  /** Only subscriptions that were not deactivated — what the fan-out asks for. */
  activeOnly?: boolean;
}

/** A delivery that is due, already carrying what an attempt needs (FR5). */
export interface DeliveryTask {
  id: number;
  assinatura_id: number;
  evento_id: number;
  /** Attempts already made — the index into the backoff schedule. */
  tentativas: number;
  url: string;
  /** The HMAC key. It exists in memory for the length of one attempt. */
  segredo: string;
}

/** What a failed attempt reports back. */
export interface FailedAttempt {
  id: number;
  /** What went wrong, as it goes into `ultimo_erro`. */
  message: string;
  /** The retry schedule; its length is how many retries there are (FR6). */
  backoff: readonly number[];
}

/** Raw subscription row, before becoming the public view. */
interface SubscriptionRow {
  id: number;
  projeto_id: number;
  url: string;
  tipos_filtro: string | null;
  evento_inicial_id: number;
  criada_em: string;
  desativada_em: string | null;
}

/** Every column of the subscription EXCEPT the secret. */
const SUBSCRIPTION_COLUMNS = `id, projeto_id, url, tipos_filtro, evento_inicial_id,
                              criada_em, desativada_em`;

/** What `ultimo_erro` records when the subscription itself went away (FR3). */
const DEACTIVATED = 'subscription deactivated';

/** Translates the row into the view the API returns. */
function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    projeto_id: row.projeto_id,
    url: row.url,
    tipos: jsonOrNull<string[]>(row.tipos_filtro),
    evento_inicial_id: row.evento_inicial_id,
    criada_em: row.criada_em,
    desativada_em: row.desativada_em,
  };
}

/** An ISO 8601 instant shifted by milliseconds — the backoff's arithmetic. */
function addMilliseconds(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/**
 * Registers a subscription, anchored at the current end of the log.
 *
 * Reading `MAX(evento.id)` and writing the row happen in one transaction: an
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
    const last = db.prepare('SELECT MAX(id) AS last_id FROM evento').get() as {
      last_id: number | null;
    };

    const effect = db
      .prepare(
        `INSERT INTO assinatura_webhook
           (projeto_id, url, segredo, tipos_filtro, evento_inicial_id, criada_em)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.projeto_id,
        data.url,
        data.segredo,
        data.tipos === null ? null : JSON.stringify(data.tipos),
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
    .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM assinatura_webhook WHERE id = ?`)
    .get(id) as SubscriptionRow | undefined;
  return row === undefined ? undefined : toSubscription(row);
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

  if (filters.projeto_id !== undefined) {
    conditions.push('projeto_id = ?');
    values.push(filters.projeto_id);
  }
  if (filters.activeOnly === true) conditions.push('desativada_em IS NULL');

  const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM assinatura_webhook${where} ORDER BY id`)
    .all(...values) as SubscriptionRow[];
  return rows.map(toSubscription);
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
    if (current.desativada_em !== null) return current;

    const moment = clock();
    db.prepare(
      'UPDATE assinatura_webhook SET desativada_em = ? WHERE id = ? AND desativada_em IS NULL',
    ).run(moment, id);
    db.prepare(
      `UPDATE entrega_webhook SET status = 'esgotada', ultimo_erro = ?
        WHERE assinatura_id = ? AND status = 'pendente'`,
    ).run(DEACTIVATED, id);

    return getSubscription(db, id);
  })();
}

/**
 * Enqueues one delivery per event, skipping what is already enqueued (FR4).
 *
 * `INSERT OR IGNORE` plus the migration's `UNIQUE (assinatura_id, evento_id)`
 * is the whole idempotency story: the same window can be fanned out any number
 * of times and produce the same rows.
 *
 * The delivery is born due (`proxima_tentativa_em` = now), so the same tick that
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
    `INSERT OR IGNORE INTO entrega_webhook
       (assinatura_id, evento_id, status, proxima_tentativa_em, criada_em)
     VALUES (?, ?, 'pendente', ?, ?)`,
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
 *   `evento_inicial_id` when it has never received anything.
 */
export function fanoutCursor(db: Database, subscription: Subscription): number {
  const row = db
    .prepare('SELECT MAX(evento_id) AS last_id FROM entrega_webhook WHERE assinatura_id = ?')
    .get(subscription.id) as { last_id: number | null };
  return row.last_id ?? subscription.evento_inicial_id;
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
      `SELECT entrega.id, entrega.assinatura_id, entrega.evento_id, entrega.tentativas,
              assinatura.url, assinatura.segredo
         FROM entrega_webhook AS entrega
         JOIN assinatura_webhook AS assinatura ON assinatura.id = entrega.assinatura_id
        WHERE entrega.status = 'pendente'
          AND entrega.proxima_tentativa_em <= ?
          AND assinatura.desativada_em IS NULL
        ORDER BY entrega.id
        LIMIT ?`,
    )
    .all(moment, limit) as DeliveryTask[];
}

/**
 * Closes a delivery that got a 2xx (FR6).
 *
 * Guarded by `status = 'pendente'`: a delivery closed while this attempt was in
 * flight — the subscription was deactivated meanwhile — stays closed.
 *
 * @param db Open database.
 * @param id Delivery id.
 * @param options Injectable clock.
 */
export function recordDeliverySuccess(db: Database, id: number, options: ClockOptions = {}): void {
  db.prepare(
    `UPDATE entrega_webhook
        SET status = 'entregue', tentativas = tentativas + 1, entregue_em = ?, ultimo_erro = NULL
      WHERE id = ? AND status = 'pendente'`,
  ).run((options.now ?? now)(), id);
}

/**
 * Records a failed attempt and decides between waiting and giving up (FR6).
 *
 * The schedule is read as the list of RETRY delays, so a schedule of five steps
 * means six attempts in total: the first one, plus one per step. When the
 * attempt that just failed has no step left, the delivery is `esgotada` and
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
      .prepare("SELECT tentativas FROM entrega_webhook WHERE id = ? AND status = 'pendente'")
      .get(attempt.id) as { tentativas: number } | undefined;
    if (current === undefined) return;

    const made = current.tentativas + 1;
    const step = attempt.backoff[made - 1];

    if (step === undefined) {
      db.prepare(
        `UPDATE entrega_webhook SET status = 'esgotada', tentativas = ?, ultimo_erro = ?
          WHERE id = ? AND status = 'pendente'`,
      ).run(made, attempt.message, attempt.id);
      return;
    }

    db.prepare(
      `UPDATE entrega_webhook SET tentativas = ?, ultimo_erro = ?, proxima_tentativa_em = ?
        WHERE id = ? AND status = 'pendente'`,
    ).run(made, attempt.message, addMilliseconds(clock(), step), attempt.id);
  })();
}
