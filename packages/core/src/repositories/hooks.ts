/**
 * Access to `entrega_gancho` — the deliveries a GRAPH asked for (t169).
 *
 * Sibling of `src/repositories/webhooks.ts`, and deliberately not a branch of
 * it. A webhook subscription is a contract somebody REGISTERS through the API;
 * a hook is a line of the graph document, so it has no registration step, no
 * fan-out cursor and no subscription row to hang off. What the two share — the
 * backoff schedule, the signature recipe, the tick discipline — is imported
 * from t142 rather than copied; what they do not share is here.
 *
 * Three decisions worth knowing before reading the code:
 *
 * - **The enqueue is a read of the graph, inside somebody else's transaction.**
 *   `enqueueHookDeliveries` is called from `transitionJob`/`blockJob`, in the
 *   very transaction that writes the projection and the event (FR18). So a
 *   transition that is rolled back takes its hook deliveries down with it, and
 *   there is no window in which a job moved without its declared reaction being
 *   queued.
 * - **URL and secret are COPIED into the row.** A later version of the graph may
 *   point the same hook somewhere else, and a delivery already in flight has to
 *   finish against the destination that was declared when it was enqueued —
 *   reading the snapshot again at attempt time would silently redirect it.
 *   Since t194 only the URL is copied out of the DOCUMENT: the key is resolved
 *   from `segredo_gancho` by name, at this same instant and for this same
 *   reason. A rotation after the fact does not reach a delivery already queued.
 * - **Exhaustion writes to the log, and it is the only place in the delivery
 *   path that does.** t142's dispatcher never touches `recordEvent` (its own
 *   header says so, and that is what makes a dead subscriber nobody else's
 *   problem). This is a scoped, deliberate exception: a hook nobody registered
 *   is a hook nobody is polling, so without an event a graph-declared reaction
 *   could fail forever in silence. It fires once, on the sixth failure, and it
 *   still cannot touch the traversal — nothing reads `trabalho.gancho_falhou`
 *   to decide where a job goes.
 *
 * `now` is injectable (default: the real clock), like `repositories/webhooks.ts`:
 * "the backoff step has passed" has to be testable without a two-hour `sleep`.
 *
 * The row field names mirror the migration's columns, so they stay in
 * Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import type { GraphHook } from '../domain/graph.ts';
import { isObject } from '../util/is-object.ts';
import { getVersion } from './graphs.ts';
import { resolveHookSecret } from './hook-secrets.ts';
import { API_ACTOR, now } from './common.ts';

/** Injectable clock; without it, the real one. */
export interface ClockOptions {
  now?: () => string;
}

/** The two triggers a graph may declare (`schema/grafo.schema.json`). */
export type HookTrigger = 'node_entered' | 'node_blocked';

/** The only destination kind this ticket ships; `local_command` is a follow-up. */
const WEBHOOK_DESTINATION = 'webhook';

/**
 * The fact that may have fired hooks, with everything the row needs.
 *
 * It is passed whole instead of the job's id because the caller is already
 * inside the transaction holding the job's row: re-reading it here would be a
 * second query for data the caller has in hand.
 */
export interface HookOccurrence {
  trigger: HookTrigger;
  /** The node the job entered, or the one it blocked on. */
  no_id: string;
  trabalho_id: number;
  projeto_id: number;
  execucao_id: number | null;
  /** The job's graph version; `null` means there is nothing to look hooks up in. */
  grafo_versao_id: string | null;
  /** The event that triggered it — the body every delivery of this row carries. */
  evento_id: number;
}

/** A delivery that is due, already carrying what an attempt needs. */
export interface HookDeliveryTask {
  id: number;
  evento_id: number;
  /** Attempts already made — the index into the backoff schedule. */
  tentativas: number;
  url: string;
  /** The HMAC key. It exists in memory for the length of one attempt. */
  segredo: string;
}

/** What a failed attempt reports back. */
export interface FailedHookAttempt {
  id: number;
  /** What went wrong, as it goes into `ultimo_erro`. */
  message: string;
  /** The retry schedule; its length is how many retries there are. */
  backoff: readonly number[];
}

/** The columns the exhaustion event is built out of. */
interface ExhaustedRow {
  projeto_id: number;
  execucao_id: number | null;
  trabalho_id: number;
  gancho_id: string;
  no_id: string;
  url: string;
}

/** An ISO 8601 instant shifted by milliseconds — the backoff's arithmetic. */
function addMilliseconds(instant: string, ms: number): string {
  return new Date(Date.parse(instant) + ms).toISOString();
}

const isFilledText = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/**
 * Is this entry a hook this occurrence has to deliver?
 *
 * Read defensively even though the document was validated on the way in: what
 * comes back from `grafo_versao.snapshot` is whatever was written when that
 * version was registered, and a reader that assumes shape is a reader that turns
 * an old document into a 500 on a job transition.
 */
function matches(hook: unknown, occurrence: HookOccurrence): hook is GraphHook {
  if (!isObject(hook)) return false;
  if (hook.trigger !== occurrence.trigger) return false;
  if (hook.node_id !== occurrence.no_id) return false;
  if (!isFilledText(hook.id)) return false;

  const destination = hook.destination;
  return (
    isObject(destination) &&
    destination.type === WEBHOOK_DESTINATION &&
    isFilledText(destination.url) &&
    isFilledText(destination.secret_ref)
  );
}

/**
 * Enqueues one delivery per hook the graph declared for this occurrence (FR5–7).
 *
 * Runs inside the caller's transaction, and is the whole of the write path's
 * hook work: it reads the snapshot, matches by trigger and node, and inserts.
 * No network call, no timer, nothing that can block — that is what makes "a
 * hook failure never blocks the traversal" true by construction and not by a
 * `try/catch` somebody has to remember.
 *
 * A job with no `grafo_versao_id`, a version id that no longer resolves, a
 * snapshot with no `hooks` key and — since t194 — a `secret_ref` that names no
 * live secret are all the same answer: zero rows, no error. The first two are
 * ordinary (`trabalho.grafo_versao_id` is loose text, not a foreign key), the
 * third is every graph written before t169, and the fourth is a deployment that
 * imported a graph without registering what it references. Giving a signal for
 * that last one — an event, a gate, a warning at import time — is deliberately
 * a separate ticket: it is the only one of the four somebody may want told.
 *
 * @param db Open database, inside the caller's transaction.
 * @param occurrence The fact that just happened, and where.
 * @param options Injectable clock.
 * @returns How many deliveries this call created.
 */
export function enqueueHookDeliveries(
  db: Database,
  occurrence: HookOccurrence,
  options: ClockOptions = {},
): number {
  if (occurrence.grafo_versao_id === null) return 0;

  const version = getVersion(db, occurrence.grafo_versao_id);
  if (version === undefined) return 0;

  const declared: unknown = version.snapshot.hooks;
  if (!Array.isArray(declared)) return 0;

  const firing = declared.filter((hook): hook is GraphHook => matches(hook, occurrence));
  if (firing.length === 0) return 0;

  const moment = (options.now ?? now)();
  // `INSERT OR IGNORE` over the migration's `UNIQUE (evento_id, gancho_id)`:
  // belt and suspenders, since an event is written exactly once ever.
  const statement = db.prepare(
    `INSERT OR IGNORE INTO entrega_gancho
       (projeto_id, execucao_id, trabalho_id, gancho_id, no_id, grafo_versao_id, evento_id,
        url, segredo, status, tentativas, proxima_tentativa_em, criada_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', 0, ?, ?)`,
  );

  let created = 0;
  for (const hook of firing) {
    // The one read of the secret store in the whole write path (t194). It sits
    // here, next to the `url` the row copies, because the two answer the same
    // question — "what did this hook mean when it fired?" — and a delivery in
    // flight has to finish against that answer and not against today's.
    const segredo = resolveHookSecret(db, hook.destination.secret_ref);
    if (segredo === undefined) continue;

    created += statement.run(
      occurrence.projeto_id,
      occurrence.execucao_id,
      occurrence.trabalho_id,
      hook.id,
      occurrence.no_id,
      occurrence.grafo_versao_id,
      occurrence.evento_id,
      hook.destination.url,
      segredo,
      // Born due, so the same tick that enqueues it can also attempt it.
      moment,
      moment,
    ).changes;
  }

  return created;
}

/**
 * The hook deliveries whose time has come, oldest first.
 *
 * No join and no "is the subscription still alive?" clause, unlike t142's: what
 * a hook belongs to is a graph version, and a version is immutable — there is
 * nothing that can be deactivated underneath a delivery in flight.
 *
 * @param db Open database.
 * @param moment Reference instant.
 * @param limit Ceiling of one tick's burst.
 * @returns Due deliveries, each carrying its own URL and secret.
 */
export function dueHookDeliveries(
  db: Database,
  moment: string,
  limit: number,
): HookDeliveryTask[] {
  return db
    .prepare(
      `SELECT id, evento_id, tentativas, url, segredo
         FROM entrega_gancho
        WHERE status = 'pendente' AND proxima_tentativa_em <= ?
        ORDER BY id
        LIMIT ?`,
    )
    .all(moment, limit) as HookDeliveryTask[];
}

/**
 * Closes a delivery that got a 2xx, in silence (FR10).
 *
 * No event is recorded: success is the expected case, and a log line per
 * delivered hook would drown the one line that matters — the failure.
 *
 * @param db Open database.
 * @param id Delivery id.
 * @param options Injectable clock.
 */
export function recordHookDeliverySuccess(
  db: Database,
  id: number,
  options: ClockOptions = {},
): void {
  db.prepare(
    `UPDATE entrega_gancho
        SET status = 'entregue', tentativas = tentativas + 1, entregue_em = ?, ultimo_erro = NULL
      WHERE id = ? AND status = 'pendente'`,
  ).run((options.now ?? now)(), id);
}

/**
 * Records a failed attempt and decides between waiting and giving up (FR9).
 *
 * The schedule is read as the list of RETRY delays, so five steps mean six
 * attempts in total. When the attempt that just failed has no step left, the
 * delivery becomes `esgotada` AND — in the same transaction — the control plane
 * records one `trabalho.gancho_falhou`. The two writes are one fact: a hook that
 * gave up without leaving an observable trace is a reaction that failed in
 * silence, which is exactly what the graph's author cannot debug.
 *
 * The actor is `sistema`: this is the control plane's own report about its own
 * delivery attempt, and there is nobody else to attribute it to.
 *
 * @param db Open database.
 * @param attempt Delivery id, what went wrong, and the schedule.
 * @param options Injectable clock.
 */
export function recordHookDeliveryFailure(
  db: Database,
  attempt: FailedHookAttempt,
  options: ClockOptions = {},
): void {
  const clock = options.now ?? now;

  db.transaction(() => {
    const current = db
      .prepare("SELECT tentativas FROM entrega_gancho WHERE id = ? AND status = 'pendente'")
      .get(attempt.id) as { tentativas: number } | undefined;
    if (current === undefined) return;

    const made = current.tentativas + 1;
    const step = attempt.backoff[made - 1];

    if (step !== undefined) {
      db.prepare(
        `UPDATE entrega_gancho SET tentativas = ?, ultimo_erro = ?, proxima_tentativa_em = ?
          WHERE id = ? AND status = 'pendente'`,
      ).run(made, attempt.message, addMilliseconds(clock(), step), attempt.id);
      return;
    }

    db.prepare(
      `UPDATE entrega_gancho SET status = 'esgotada', tentativas = ?, ultimo_erro = ?
        WHERE id = ? AND status = 'pendente'`,
    ).run(made, attempt.message, attempt.id);

    const row = db
      .prepare(
        `SELECT projeto_id, execucao_id, trabalho_id, gancho_id, no_id, url
           FROM entrega_gancho WHERE id = ?`,
      )
      .get(attempt.id) as ExhaustedRow;

    recordEvent(db, {
      tipo: 'trabalho.gancho_falhou',
      projeto_id: row.projeto_id,
      execucao_id: row.execucao_id,
      entidade: { tipo: 'trabalho', id: row.trabalho_id },
      ator: API_ACTOR,
      ocorrido_em: clock(),
      dados: {
        gancho_id: row.gancho_id,
        no_id: row.no_id,
        url: row.url,
        ultimo_erro: attempt.message,
      },
    });
  })();
}
