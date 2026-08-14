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
 * The table, column and event-type names stay in Portuguese: the migrations are
 * untouched and the taxonomy governs the event vocabulary (t127, FR8).
 */

import type { Database } from './connection.ts';
import {
  requireValidEvent,
  type Entity,
  type Event,
  type EntityType,
} from './event-validation.ts';

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
 * `trabalho`/`sessao`/`pergunta`/`lease`. The conversion happens here, at the boundary,
 * and not in every consumer's head.
 */
function entityId(type: string, raw: string): number | string {
  return type === 'grafo_versao' ? raw : Number(raw);
}

/** Translates the database row into the taxonomy's envelope. */
function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    tipo: row.tipo,
    projeto_id: row.projeto_id,
    execucao_id: row.execucao_id,
    entidade: {
      tipo: row.entidade_tipo as EntityType,
      id: entityId(row.entidade_tipo, row.entidade_id),
    },
    ator: { tipo: row.ator_tipo as Event['ator']['tipo'], ref: row.ator_ref },
    ocorrido_em: row.ocorrido_em,
    dados: JSON.parse(row.dados) as Record<string, unknown>,
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
 * @returns The recorded event, with `id` and normalized `dados`.
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
      event.tipo,
      event.projeto_id,
      event.execucao_id,
      event.entidade.tipo,
      String(event.entidade.id),
      event.ator.tipo,
      event.ator.ref,
      event.ocorrido_em,
      JSON.stringify(event.dados),
    );

  return { ...event, id: Number(result.lastInsertRowid) };
}

/** The slice of the log asked for from `listEvents`. */
export interface EventFilter {
  /**
   * The timeline of a job (FR9): ITS events, plus the session and input-request
   * ones that cite it in `dados.trabalho_id`.
   *
   * Note that `sessao.finalizada`, `pergunta.respondida` and
   * `pergunta.auto_resolvida` do NOT appear: the schemas of those types have no
   * `trabalho_id` in the payload (the link was declared at opening/creation, and
   * repeating it would be duplicated data in the log). Whoever wants the end of
   * the session asks about the session.
   */
  trabalho_id?: number;

  /**
   * The whole log of one execution (t110, FR2): every event whose `execucao_id`
   * column matches, be it from a `trabalho`, a `sessao` or a `pergunta`.
   *
   * This is not the union of the timelines of that round's jobs: the link here
   * is the COLUMN, written by whoever recorded the fact from the owning
   * `trabalho` (`repositories/session.ts`, `repositories/input-request.ts`), and
   * not a `json_extract` of the payload. It is what lets the surveyor cross
   * different nodes of a single execution without asking job by job.
   *
   * Combined with `trabalho_id`, the two filters add up (AND, not OR).
   */
  execucao_id?: number;
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
            AND json_extract(dados, '$.trabalho_id') = @id))`,
    );
    parameters.id = filter.trabalho_id;
    parameters.id_texto = String(filter.trabalho_id);
  }

  if (filter.execucao_id !== undefined) {
    conditions.push('execucao_id = @execucao_id');
    parameters.execucao_id = filter.execucao_id;
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const statement = db.prepare(`SELECT ${COLUMNS} FROM evento ${where} ORDER BY id`);
  const rows = (
    conditions.length === 0 ? statement.all() : statement.all(parameters)
  ) as EventRow[];
  return rows.map(toEvent);
}

/**
 * The events of one entity, in `id` order.
 *
 * @param db Open handle.
 * @param type Entity type (`trabalho`, `sessao`, `pergunta`, ...).
 * @param id Entity id; an integer for all of them except `grafo_versao`.
 * @returns Events of that entity, from oldest to newest.
 */
export function getEventsByEntity(
  db: Database,
  type: Entity['tipo'],
  id: number | string,
): Event[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM evento
        WHERE entidade_tipo = ? AND entidade_id = ?
        ORDER BY id`,
    )
    .all(type, String(id)) as EventRow[];
  return rows.map(toEvent);
}
