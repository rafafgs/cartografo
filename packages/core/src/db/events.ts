/**
 * The event log — the control plane's source of truth (t102, FR2).
 *
 * This module is the ONLY one that touches the `event` table, and its surface
 * is the taxonomy's append-only rule turned into code: one insert and two reads,
 * nothing else. There is no `updateEvent`, there is no `deleteEvent`, and that
 * is not an oversight — a fact recorded wrong is corrected by ANOTHER fact,
 * never by overwriting.
 *
 * It is the same discipline as flowpilot's `TicketEventRepository` (rule 10),
 * including how it is enforced: `test/event-append-only.test.ts` checks the
 * export list here and sweeps the rest of `src/` for update/delete against the
 * table. Adding a fourth exported function breaks the test on purpose.
 *
 * The functions are synchronous because the driver is synchronous: calling
 * `recordEvent` from inside the caller's `db.transaction(...)` is the normal
 * path, and it is what makes projection and event land together or not at all
 * (FR18).
 *
 * This module used to be the row ↔ wire boundary of the log (t227). The
 * envelope, the event types and the payload keys went English with D20's second
 * child; the TABLE and its columns followed with the FOURTH (t229), and two of
 * those columns are not free text — migration `0003` pins `entity_type` and
 * `actor_type` to five and three values with a `CHECK`. Those two were the last
 * Portuguese in the log, translated here in both directions, and D20's FIFTH
 * child (t235) rewrote `0003` so the `CHECK` itself reads
 * `('job','session','input_request','lease','graph_version')` and
 * `('user','agent','system')`. The maps went with it: what this module writes
 * into the row is the envelope's own word.
 *
 * `type` and `data` never had a CHECK and always took the new vocabulary
 * straight, which is why a database written before those tickets cannot be read
 * after them — the README says so, and D20's answer is to recreate it, never to
 * migrate it.
 *
 * What was left after all that was a projection that aliased the nine renamed
 * columns back onto a Portuguese-spelled {@link EventRow}, so that `toEvent`
 * could rename them forward again on the way to the envelope. t290 deleted the
 * middle step: the row below spells every field the way the column does, and the
 * `SELECT` carries no alias. `toEvent` stayed, because what is left of it is the
 * NESTING and the `JSON.parse` — a shape, not a spelling.
 */

import type { Database } from './connection.ts';
import {
  requireValidEvent,
  type Entity,
  type Event,
  type EntityType,
} from './event-validation.ts';

/**
 * Raw table row, before becoming an envelope.
 *
 * Flat where the envelope is nested, and a `data` that is still the stored TEXT
 * — those two differences are the whole reason this interface exists. The names
 * are the column's own since t290; before it every field here was spelled in
 * Portuguese and the projection below aliased the schema back onto it.
 */
interface EventRow {
  id: number;
  type: string;
  project_id: number;
  execution_id: number | null;
  entity_type: string;
  entity_id: string;
  actor_type: string;
  actor_ref: string;
  occurred_at: string;
  data: string;
}

/** The row, in the order the envelope reads it. */
const COLUMNS = `
  id, type, project_id, execution_id,
  entity_type, entity_id,
  actor_type, actor_ref, occurred_at,
  data
`;

/**
 * Returns the entity id in the type the envelope promises.
 *
 * The column is TEXT (one log for five entities, and one of them has a hash for
 * an id — D15), but the contract the client reads says integer for
 * `job`/`session`/`input_request`/`lease`. The conversion happens here, at the
 * boundary, and not in every consumer's head.
 *
 * @param type Entity type as the column spells it, which since t235 is the
 *   envelope's own spelling.
 */
function entityId(type: string, raw: string): number | string {
  return type === 'graph_version' ? raw : Number(raw);
}

/**
 * Reshapes the flat row into the taxonomy's envelope.
 *
 * The one `toX` of this series that survived t290, because it is not a
 * translation: it NESTS `entity_type`/`entity_id` and `actor_type`/`actor_ref`
 * into the two objects the taxonomy publishes, and parses the `data` the column
 * stores as text. Every field name it reads is now the same one it writes; what
 * it still does is the shape.
 */
function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    type: row.type,
    project_id: row.project_id,
    execution_id: row.execution_id,
    entity: {
      type: row.entity_type as EntityType,
      id: entityId(row.entity_type, row.entity_id),
    },
    actor: { type: row.actor_type as Event['actor']['type'], ref: row.actor_ref },
    occurred_at: row.occurred_at,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

/**
 * Inserts an event into the log and returns it already carrying the server's id.
 *
 * Validates before writing (FR3): nothing enters the log without a contract.
 * Running inside the caller's transaction is the normal use — whoever writes a
 * projection writes the event in the same transaction.
 *
 * @param db Open handle.
 * @param input Envelope without an `id`.
 * @returns The recorded event, with `id` and normalized `data`.
 * @throws {ValidationError} When the envelope or the payload does not match.
 */
export function recordEvent(db: Database, input: unknown): Event {
  const event = requireValidEvent(input);

  const result = db
    .prepare(
      `INSERT INTO event (
         type, project_id, execution_id, entity_type, entity_id,
         actor_type, actor_ref, occurred_at, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.type,
      event.project_id,
      event.execution_id,
      event.entity.type,
      String(event.entity.id),
      event.actor.type,
      event.actor.ref,
      event.occurred_at,
      JSON.stringify(event.data),
    );

  return { ...event, id: Number(result.lastInsertRowid) };
}

/** The slice of the log asked for from `listEvents`. */
export interface EventFilter {
  /**
   * The timeline of a job (FR9): ITS events, plus the session and input-request
   * ones that cite it in `data.job_id`.
   *
   * Note that `session.finished`, `input_request.answered` and
   * `input_request.auto_resolved` do NOT appear: the schemas of those types have
   * no `job_id` in the payload (the link was declared at opening/creation, and
   * repeating it would be duplicated data in the log). Whoever wants the end of
   * the session asks about the session.
   */
  job_id?: number;

  /**
   * The whole log of one execution (t110, FR2): every event whose `execution_id`
   * column matches, be it from a `job`, a `session` or an `input_request`.
   *
   * This is not the union of the timelines of that round's jobs: the link here
   * is the COLUMN, written by whoever recorded the fact from the owning job
   * (`repositories/session.ts`, `repositories/input-request.ts`), and not a
   * `json_extract` of the payload. It is what lets the surveyor cross
   * different nodes of a single execution without asking job by job.
   *
   * Combined with `job_id`, the two filters add up (AND, not OR).
   */
  execution_id?: number;

  /**
   * Everything recorded AFTER this id (t123, FR4).
   *
   * This is the cursor of the outbound stream, and it is the envelope's own
   * `id` because that is "the only total ordering there is"
   * (`specs/events/taxonomy.md:54`). Strictly greater, never greater
   * or equal: what the consumer sends back is the last id it ALREADY has, so
   * delivering it again would be the duplicate the reconnect protocol exists to
   * avoid.
   */
  sinceId?: number;

  /** The events of one project — the `project_id` column, exactly (t123, FR3). */
  projetoId?: number;

  /**
   * Only these event types, exact strings of the taxonomy (t123, FR3).
   *
   * The catalogue is NOT re-declared here: whoever filters validates against
   * `KNOWN_TYPES` (`src/db/event-validation.ts`) before calling, and an empty
   * list means "no type filter" instead of "no event" — an empty filter that
   * silently returns nothing is a trap, not a feature.
   */
  tipos?: string[];

  /**
   * Ceiling of rows for one read (t123, FR8).
   *
   * Only the stream uses it: a consumer that reconnects far behind would
   * otherwise turn one poll tick into an unbounded write burst. Whoever reads a
   * whole timeline (`GET /v1/executions/:id/events`) keeps asking for
   * everything, because there the response IS the whole slice.
   */
  limit?: number;
}

/**
 * The log, in `id` order.
 *
 * The order is the id's because `occurred_at` is not a total ordering: two
 * events can carry the same timestamp.
 *
 * @param db Open handle.
 * @param filter Optional slice; without it, the whole log.
 * @returns Events from oldest to newest.
 */
export function listEvents(db: Database, filter: EventFilter = {}): Event[] {
  const conditions: string[] = [];
  const parameters: Record<string, number | string> = {};

  if (filter.job_id !== undefined) {
    conditions.push(
      `((entity_type = 'job' AND entity_id = @id_texto)
        OR (entity_type IN ('session','input_request')
            AND json_extract(data, '$.job_id') = @id))`,
    );
    parameters.id = filter.job_id;
    parameters.id_texto = String(filter.job_id);
  }

  if (filter.execution_id !== undefined) {
    conditions.push('execution_id = @execution_id');
    parameters.execution_id = filter.execution_id;
  }

  if (filter.sinceId !== undefined) {
    conditions.push('id > @since_id');
    parameters.since_id = filter.sinceId;
  }

  if (filter.projetoId !== undefined) {
    conditions.push('project_id = @project_id');
    parameters.project_id = filter.projetoId;
  }

  if (filter.tipos !== undefined && filter.tipos.length > 0) {
    // One named parameter per type, and never interpolation: the list comes from
    // a query string, and the only reason it is safe is that it never touches
    // the SQL text.
    conditions.push(`type IN (${filter.tipos.map((_, index) => `@type_${index}`).join(', ')})`);
    filter.tipos.forEach((value, index) => {
      parameters[`type_${index}`] = value;
    });
  }

  if (filter.limit !== undefined) {
    parameters.limit = filter.limit;
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const ceiling = filter.limit === undefined ? '' : 'LIMIT @limit';
  const statement = db.prepare(`SELECT ${COLUMNS} FROM event ${where} ORDER BY id ${ceiling}`);
  const rows = (
    Object.keys(parameters).length === 0 ? statement.all() : statement.all(parameters)
  ) as EventRow[];
  return rows.map(toEvent);
}

/**
 * The events of one entity, in `id` order.
 *
 * @param db Open handle.
 * @param type Entity type (`job`, `session`, `input_request`, ...), which the
 *   column spells the same way since t235.
 * @param id Entity id; an integer for all of them except `graph_version`.
 * @returns Events of that entity, from oldest to newest.
 */
export function getEventsByEntity(
  db: Database,
  type: Entity['type'],
  id: number | string,
): Event[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM event
        WHERE entity_type = ? AND entity_id = ?
        ORDER BY id`,
    )
    .all(type, String(id)) as EventRow[];
  return rows.map(toEvent);
}
