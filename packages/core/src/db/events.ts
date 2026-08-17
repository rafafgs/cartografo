/**
 * The event log — the control plane's source of truth (t102, FR2).
 *
 * This module is the ONLY one that touches the `evento` table, and its surface
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
 * This module is also the row ↔ wire boundary of the log (t227). The envelope,
 * the event types and the payload keys are English since D20's second child;
 * the TABLE is untouched, and two of its columns are not free text — migration
 * `0003` pins `entidade_tipo` and `ator_tipo` to their five and three
 * Portuguese values with a `CHECK`. So those two values are translated here,
 * both ways, exactly as
 * `repositories/leases.ts` and `repositories/input-request.ts` already do for
 * their own CHECK-constrained enums. Renaming the columns AND their values is
 * D20's FIFTH child; when it lands, the two maps below are what disappears.
 *
 * `tipo` and `dados` have no CHECK and take the new vocabulary straight, which
 * is why a database written before this ticket cannot be read after it — the
 * README says so, and D20's answer is to recreate it, never to migrate it.
 */

import type { Database } from './connection.ts';
import {
  requireValidEvent,
  type Entity,
  type Event,
  type EntityType,
} from './event-validation.ts';

/**
 * The `entidade_tipo` column's five values, wire ↔ column.
 *
 * Not a `Record<EntityType, string>` by accident: the reverse direction reads a
 * value that came out of the database, which is a `string` and not an
 * `EntityType` until this map says so.
 */
const ENTITY_COLUMN: Record<string, string> = {
  job: 'trabalho',
  session: 'sessao',
  input_request: 'pergunta',
  lease: 'lease',
  graph_version: 'grafo_versao',
};

const ENTITY_FIELD: Record<string, string> = {
  trabalho: 'job',
  sessao: 'session',
  pergunta: 'input_request',
  lease: 'lease',
  grafo_versao: 'graph_version',
};

/** The `ator_tipo` column's three values, wire ↔ column. */
const ACTOR_COLUMN: Record<string, string> = {
  user: 'usuario',
  agent: 'agente',
  system: 'sistema',
};

const ACTOR_FIELD: Record<string, string> = {
  usuario: 'user',
  agente: 'agent',
  sistema: 'system',
};

/** Raw table row, before becoming an envelope. */
interface EventRow {
  id: number;
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade_tipo: string;
  entidade_id: string;
  ator_tipo: string;
  ator_ref: string;
  ocorrido_em: string;
  dados: string;
}

const COLUMNS = `
  id, tipo, projeto_id, execucao_id, entidade_tipo, entidade_id,
  ator_tipo, ator_ref, ocorrido_em, dados
`;

/**
 * Returns the entity id in the type the envelope promises.
 *
 * The column is TEXT (one log for five entities, and one of them has a hash for
 * an id — D15), but the contract the client reads says integer for
 * `job`/`session`/`input_request`/`lease`. The conversion happens here, at the
 * boundary, and not in every consumer's head.
 *
 * @param type Entity type as the COLUMN spells it, before {@link ENTITY_FIELD}.
 */
function entityId(type: string, raw: string): number | string {
  return type === 'grafo_versao' ? raw : Number(raw);
}

/** Translates the database row into the taxonomy's envelope. */
function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    type: row.tipo,
    project_id: row.projeto_id,
    execution_id: row.execucao_id,
    entity: {
      type: ENTITY_FIELD[row.entidade_tipo] as EntityType,
      id: entityId(row.entidade_tipo, row.entidade_id),
    },
    actor: { type: ACTOR_FIELD[row.ator_tipo] as Event['actor']['type'], ref: row.ator_ref },
    occurred_at: row.ocorrido_em,
    data: JSON.parse(row.dados) as Record<string, unknown>,
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
      `INSERT INTO evento (
         tipo, projeto_id, execucao_id, entidade_tipo, entidade_id,
         ator_tipo, ator_ref, ocorrido_em, dados
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.type,
      event.project_id,
      event.execution_id,
      ENTITY_COLUMN[event.entity.type],
      String(event.entity.id),
      ACTOR_COLUMN[event.actor.type],
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
  trabalho_id?: number;

  /**
   * The whole log of one execution (t110, FR2): every event whose `execucao_id`
   * column matches, be it from a `trabalho`, a `sessao` or a `pergunta`.
   *
   * This is not the union of the timelines of that round's jobs: the link here
   * is the COLUMN, written by whoever recorded the fact from the owning job
   * (`repositories/session.ts`, `repositories/input-request.ts`), and not a
   * `json_extract` of the payload. It is what lets the surveyor cross
   * different nodes of a single execution without asking job by job.
   *
   * Combined with `trabalho_id`, the two filters add up (AND, not OR).
   */
  execucao_id?: number;

  /**
   * Everything recorded AFTER this id (t123, FR4).
   *
   * This is the cursor of the outbound stream, and it is the envelope's own
   * `id` because that is "the only total ordering there is"
   * (`especificacoes/eventos/taxonomia.md:52`). Strictly greater, never greater
   * or equal: what the consumer sends back is the last id it ALREADY has, so
   * delivering it again would be the duplicate the reconnect protocol exists to
   * avoid.
   */
  sinceId?: number;

  /** The events of one project — the `projeto_id` column, exactly (t123, FR3). */
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
 * The order is the id's because `ocorrido_em` is not a total ordering: two
 * events can carry the same timestamp.
 *
 * @param db Open handle.
 * @param filter Optional slice; without it, the whole log.
 * @returns Events from oldest to newest.
 */
export function listEvents(db: Database, filter: EventFilter = {}): Event[] {
  const conditions: string[] = [];
  const parameters: Record<string, number | string> = {};

  if (filter.trabalho_id !== undefined) {
    conditions.push(
      `((entidade_tipo = 'trabalho' AND entidade_id = @id_texto)
        OR (entidade_tipo IN ('sessao','pergunta')
            AND json_extract(dados, '$.job_id') = @id))`,
    );
    parameters.id = filter.trabalho_id;
    parameters.id_texto = String(filter.trabalho_id);
  }

  if (filter.execucao_id !== undefined) {
    conditions.push('execucao_id = @execucao_id');
    parameters.execucao_id = filter.execucao_id;
  }

  if (filter.sinceId !== undefined) {
    conditions.push('id > @since_id');
    parameters.since_id = filter.sinceId;
  }

  if (filter.projetoId !== undefined) {
    conditions.push('projeto_id = @projeto_id');
    parameters.projeto_id = filter.projetoId;
  }

  if (filter.tipos !== undefined && filter.tipos.length > 0) {
    // One named parameter per type, and never interpolation: the list comes from
    // a query string, and the only reason it is safe is that it never touches
    // the SQL text.
    conditions.push(`tipo IN (${filter.tipos.map((_, index) => `@tipo_${index}`).join(', ')})`);
    filter.tipos.forEach((value, index) => {
      parameters[`tipo_${index}`] = value;
    });
  }

  if (filter.limit !== undefined) {
    parameters.limit = filter.limit;
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const ceiling = filter.limit === undefined ? '' : 'LIMIT @limit';
  const statement = db.prepare(`SELECT ${COLUMNS} FROM evento ${where} ORDER BY id ${ceiling}`);
  const rows = (
    Object.keys(parameters).length === 0 ? statement.all() : statement.all(parameters)
  ) as EventRow[];
  return rows.map(toEvent);
}

/**
 * The events of one entity, in `id` order.
 *
 * @param db Open handle.
 * @param type Entity type on the WIRE (`job`, `session`, `input_request`, ...);
 *   the column's spelling is this module's business, not the caller's.
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
      `SELECT ${COLUMNS} FROM evento
        WHERE entidade_tipo = ? AND entidade_id = ?
        ORDER BY id`,
    )
    .all(ENTITY_COLUMN[type], String(id)) as EventRow[];
  return rows.map(toEvent);
}
