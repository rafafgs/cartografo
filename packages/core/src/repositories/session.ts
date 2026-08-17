/**
 * Session repository — the run of an agent by an EngineAdapter.
 *
 * In flowpilot this was a mutable row born `pending` and updated until
 * `completed`. Here there are TWO facts (`session.opened`, `session.finished`)
 * and a projection derived from them — consequence 2 of the taxonomy's
 * append-only rule.
 *
 * The care that runs through the file: an absent `usage` is `null`, never zero.
 * Zero tokens is a measurement; absence is the engine not having reported
 * anything, and collapsing the two destroys the only cost metric the PoC will
 * have.
 *
 * The TABLE and its columns are English since D20's fourth child (t229);
 * {@link Session}'s field names are not, because `routes/sessions.ts` and the
 * topographer's reader consume them, so every `SELECT` aliases the renamed
 * column back onto the field (t229, FR4). {@link WireSession} is what `/v1`
 * publishes and is English, event-type strings included, since t227.
 */

import type { Database } from '../db/connection.ts';
import { getEventsByEntity, recordEvent } from '../db/events.ts';
import { requireValidData, ValidationError } from '../db/event-validation.ts';
import {
  RUNNER_ACTOR,
  DEFAULT_PROJECT,
  now,
  asBoolean,
  asInteger,
  integerOrNull,
  integerOrDefault,
  jsonOrNull,
  resolveActor,
} from './common.ts';

/** Token totals frozen at the end of the session's life. */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Ceiling of a stored transcript, in bytes (t159, FR2).
 *
 * A fixed constant, not a setting: v0 has one number to get roughly right, and
 * a knob nobody turns is a knob that rots. 1 MiB is generous for the sessions
 * this PoC runs and small enough that a runaway loop printing gigabytes cannot
 * take the database with it.
 */
export const TRANSCRIPT_CAP_BYTES = 1_048_576;

/** Session projection, as the API returns it. */
export interface Session {
  id: number;
  trabalho_id: number | null;
  execucao_id: number | null;
  no_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  timeout_seconds: number | null;
  /**
   * Inactivity budget the session was opened with (t163). `null` is "this
   * session declares no policy" — which is also what every row from before the
   * second watchdog existed reads as, and never a budget of zero seconds.
   */
  silence_seconds: number | null;
  status: string;
  exit_code: number | null;
  /** Which watchdog stopped it, when one did (t163). `null` = not applicable. */
  timeout_reason: string | null;
  uso: SessionUsage | null;
  /**
   * Which models the engine reported having run this session (t172).
   *
   * A list because a session runs more than one — a real single-turn run
   * already reported two — and collapsing to "the" model would charge the whole
   * bill to the wrong one. `null` is "the engine named none", which is also
   * what every row from before this column existed reads as; `[]` is not a way
   * to say that and never gets stored.
   */
  modelos: string[] | null;
  transcricao: string | null;
  transcricao_truncada: boolean;
  transcricao_tamanho_original: number | null;
  aberta_em: string;
  finalizada_em: string | null;
}

interface SessionRow extends Omit<Session, 'uso' | 'modelos' | 'transcricao_truncada'> {
  uso: string | null;
  modelos: string | null;
  transcricao_truncada: number;
}

/**
 * The row, read back into {@link Session}'s spelling (t229, FR4).
 *
 * `transcricao_truncada` and `transcricao_tamanho_original` carry no alias
 * because they carry no new name: `glossario-wire.md` §4.2 registers
 * `transcricao` and neither of its two siblings, and inventing a spelling the
 * glossary does not hold is what the glossary exists to prevent.
 */
const COLUMNS = `
  id, job_id AS trabalho_id, execution_id AS execucao_id, node_id AS no_id,
  engine, engine_session_ref, working_dir,
  prompt, timeout_seconds, silence_seconds, status, exit_code, timeout_reason,
  usage AS uso, models AS modelos, transcript AS transcricao,
  transcricao_truncada, transcricao_tamanho_original,
  opened_at AS aberta_em, finished_at AS finalizada_em
`;

function toSession(row: SessionRow): Session {
  return {
    ...row,
    uso: jsonOrNull<SessionUsage>(row.uso),
    // Same JSON-in-a-column convention `usage` above already uses, and the same
    // reading of a NULL: nothing was reported. A row written before t172 lands
    // here as `null` with no backfill and no special case.
    modelos: jsonOrNull<string[]>(row.modelos),
    transcricao_truncada: asBoolean(row.transcricao_truncada),
  };
}

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1; closed by t227).                        */
/*                                                                             */
/* Both sides cross it now. The reads went English with the API child, and the */
/* three writes — `POST /v1/sessions`, `PATCH /finish`,                        */
/* `/permission-denials` — followed with the events child, because their       */
/* bodies go straight into `validateEvent` and that vocabulary is D20's second */
/* child (`routes/common.ts` tells the whole story).                           */
/*                                                                             */
/* `status` still has no map, and for the OPPOSITE reason it used to: the      */
/* column takes whatever `session.finished`'s `data.status` carries, and since */
/* t227 that is `completed`, `failed`, `timed_out`, … — so `/finish` accepts   */
/* the same word it answers, with nothing in between. The column has no CHECK  */
/* (migration `0003`), which is why the value could simply change. Renaming    */
/* the COLUMNS was D20's FOURTH child (t229), and it renamed identifiers only: */
/* it moved no stored value and retired no map.                                */
/* -------------------------------------------------------------------------- */

/** A session, as `/v1` publishes it. */
export interface WireSession {
  id: number;
  job_id: number | null;
  execution_id: number | null;
  node_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  timeout_seconds: number | null;
  silence_seconds: number | null;
  /** The column's value, which is the wire's word since t227 — see the note above. */
  status: string;
  exit_code: number | null;
  timeout_reason: string | null;
  usage: SessionUsage | null;
  models: string[] | null;
  transcript: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
  opened_at: string;
  finished_at: string | null;
}

/**
 * The transcript payload, as `/v1` publishes it (t232).
 *
 * The same three names {@link WireSession} already publishes for the same three
 * facts, and deliberately not a shorter second spelling: `truncada` reads fine
 * next to `transcricao` in one body, but `truncated` next to `/finish`'s
 * `transcript_truncated` is one concept with two names, and a client that reads
 * the end of a session and then its output would parse both.
 */
export interface WireSessionTranscript {
  transcript: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
}

/** Transcript to wire. */
export function toWireSessionTranscript(
  transcript: SessionTranscript,
): WireSessionTranscript {
  return {
    transcript: transcript.transcricao,
    transcript_truncated: transcript.truncada,
    transcript_original_size: transcript.tamanho_original,
  };
}

/** Projection to wire: the one place the session's column names meet the API's. */
export function toWireSession(session: Session): WireSession {
  return {
    id: session.id,
    job_id: session.trabalho_id,
    execution_id: session.execucao_id,
    node_id: session.no_id,
    engine: session.engine,
    engine_session_ref: session.engine_session_ref,
    working_dir: session.working_dir,
    prompt: session.prompt,
    timeout_seconds: session.timeout_seconds,
    silence_seconds: session.silence_seconds,
    status: session.status,
    exit_code: session.exit_code,
    timeout_reason: session.timeout_reason,
    usage: session.uso,
    models: session.modelos,
    transcript: session.transcricao,
    transcript_truncated: session.transcricao_truncada,
    transcript_original_size: session.transcricao_tamanho_original,
    opened_at: session.aberta_em,
    finished_at: session.finalizada_em,
  };
}

/** What the cap left of an incoming transcript, and what it cost. */
interface CappedTranscript {
  /** The text to store; `null` when nothing was reported. */
  text: string | null;
  /** Whether the cap bit. Reported whether it did or not — silence is the bug. */
  truncated: boolean;
  /** Size in BYTES before the cap, or `null` when nothing was reported. */
  originalBytes: number | null;
}

/**
 * Applies {@link TRANSCRIPT_CAP_BYTES} to what the runner reported (FR1, FR2).
 *
 * Three states, and they are three different facts:
 *
 * - **absent/null** — nobody reported anything. Stores a real NULL, never an
 *   empty string, the same discipline `uso` has had in this file since t102;
 * - **`''`** — the session ran and printed nothing. That is a measurement, and
 *   it is stored as given;
 * - **over the cap** — the TAIL survives, because the end of a stream is where
 *   a crash's evidence lives, and the row says so out loud: the flag plus the
 *   size the transcript had BEFORE the cut. Reporting the capped size instead
 *   would erase how much was lost.
 *
 * The cut lands on a character boundary, never inside a rune: slicing UTF-8 at
 * an arbitrary byte and decoding anyway prints a `U+FFFD` no engine ever
 * emitted, and re-encoding it can push the result back over the cap. Dropping
 * the broken head costs at most three bytes.
 *
 * Deliberately outside `requireValidData`: the transcript is not part of the
 * `session.finished` contract and never enters the event log, so its own type
 * check lives here — and still raises the `ValidationError` the route already
 * turns into a 400.
 *
 * @param value What came in the body, if it came.
 * @returns The text to store, the flag and the original size.
 * @throws {ValidationError} When it is present and is not a string.
 */
function capTranscript(value: unknown): CappedTranscript {
  if (value === undefined || value === null) {
    return { text: null, truncated: false, originalBytes: null };
  }
  if (typeof value !== 'string') {
    throw new ValidationError(['transcript has to be a string, or absent']);
  }

  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= TRANSCRIPT_CAP_BYTES) {
    return { text: value, truncated: false, originalBytes: bytes.byteLength };
  }

  // `0b10xxxxxx` is a UTF-8 continuation byte: walking forward off them lands
  // on the first byte of a whole character.
  let start = bytes.byteLength - TRANSCRIPT_CAP_BYTES;
  while (start < bytes.byteLength && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;

  return {
    text: bytes.subarray(start).toString('utf8'),
    truncated: true,
    originalBytes: bytes.byteLength,
  };
}

function readRow(db: Database, id: number): SessionRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM session WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
}

/**
 * The project this session was opened under (t157, FR3/FR4).
 *
 * The `session` table has no `project_id` column: `openSession` resolves the
 * project — the served job's, or the one declared in the body — and records it
 * in the envelope of `session.opened`, and that event is where it lives. Every
 * later event of the session reads it from there.
 *
 * Deriving it again from `job` (which is what this file did until t157)
 * quietly loses the answer for a session with no job — a discovery session, a
 * conversation turn, the very case `session.opened`'s contract calls out: the
 * join finds nothing and the end of the session gets filed under
 * `DEFAULT_PROJECT`, whatever project it actually opened under. The log already
 * knew; nobody was asking it.
 *
 * Read-only, over the `event` table: the append-only rule is untouched.
 *
 * @param db Open handle.
 * @param id Session id.
 * @returns The project of the opening event; `DEFAULT_PROJECT` only for a
 *   session with no opening event, which `openSession`'s transaction makes
 *   unreachable in practice.
 */
function sessionProject(db: Database, id: number): number {
  const opening = getEventsByEntity(db, 'session', id).find(
    (event) => event.type === 'session.opened',
  );
  return opening?.project_id ?? DEFAULT_PROJECT;
}

/**
 * Gets a session by its projection.
 *
 * @param db Open handle.
 * @param id Session id.
 * @returns The session, or `null` if it does not exist.
 */
export function getSession(db: Database, id: number): Session | null {
  const row = readRow(db, id);
  return row === undefined ? null : toSession(row);
}

/** Body of `POST /v1/sessions`. */
export interface OpenSessionInput {
  job_id?: unknown;
  node_id?: unknown;
  engine?: unknown;
  engine_session_ref?: unknown;
  working_dir?: unknown;
  prompt?: unknown;
  timeout_seconds?: unknown;
  silence_seconds?: unknown;
  execution_id?: unknown;
  project_id?: unknown;
  actor?: unknown;
}

/**
 * Opens the session and records `session.opened` (FR10).
 *
 * `execution_id` and `project_id` are inherited from the job served when there is
 * one — the session belongs to the job's round, and asking the caller to repeat
 * that would invite divergence. Without a job (a discovery session, a
 * conversation turn), what came in the body holds.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The open session, or `null` if the given `job_id` does not exist.
 * @throws {ValidationError} When a required field is missing.
 */
export function openSession(db: Database, input: OpenSessionInput): Session | null {
  const data = requireValidData('session.opened', {
    job_id: input.job_id,
    node_id: input.node_id,
    engine: input.engine,
    engine_session_ref: input.engine_session_ref,
    working_dir: input.working_dir,
    prompt: input.prompt,
    timeout_seconds: input.timeout_seconds,
    silence_seconds: input.silence_seconds,
  });

  const jobId = data.job_id as number | null;
  const owner =
    jobId === null
      ? undefined
      : (db
          .prepare(
            'SELECT project_id AS projeto_id, execution_id AS execucao_id FROM job WHERE id = ?',
          )
          .get(jobId) as
          | { projeto_id: number; execucao_id: number | null }
          | undefined);
  if (jobId !== null && owner === undefined) return null;

  const projectId =
    owner?.projeto_id ?? integerOrDefault('project_id', input.project_id, DEFAULT_PROJECT);
  const executionId = owner?.execucao_id ?? integerOrNull('execution_id', input.execution_id);
  const actor = resolveActor(input.actor, RUNNER_ACTOR);

  const open = db.transaction((): Session => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO session (
           job_id, execution_id, node_id, engine, engine_session_ref, working_dir,
           prompt, timeout_seconds, silence_seconds, status, exit_code, usage,
           opened_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', NULL, NULL, ?, NULL)`,
      )
      .run(
        jobId,
        executionId,
        data.node_id as string | null,
        data.engine as string,
        data.engine_session_ref as string | null,
        data.working_dir as string,
        data.prompt as string,
        data.timeout_seconds as number | null,
        data.silence_seconds as number | null,
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      type: 'session.opened',
      project_id: projectId,
      execution_id: executionId,
      entity: { type: 'session', id },
      actor,
      occurred_at: timestamp,
      data,
    });

    return toSession(readRow(db, id) as SessionRow);
  });

  return open();
}

/** Body of `PATCH /v1/sessions/:id/finish`. */
export interface FinishSessionInput {
  status?: unknown;
  exit_code?: unknown;
  timeout_reason?: unknown;
  usage?: unknown;
  models?: unknown;
  transcript?: unknown;
  actor?: unknown;
}

/**
 * Closes the session and records `session.finished` (FR11).
 *
 * Closing is exactly-once: the `UPDATE` is guarded by `status = 'aberta'` and a
 * lost claim throws before anything is appended, the same shape the sibling
 * repositories already use (t149). A second finish would rewrite the terminal
 * status and NULL the `usage` this whole file exists to protect — so it is refused
 * with a 409 by the route, and never silently applied.
 *
 * The transcript (t159) rides in the SAME transaction, and there is no second
 * endpoint for it: one write, one caller. It is the raw stream the engine
 * printed, capped by {@link capTranscript} — and it goes to the row only, never
 * into `data`, because the event schema does not know it exists.
 *
 * @param db Open handle.
 * @param id Session id.
 * @param input Request body.
 * @returns The closed session, or `null` if it does not exist.
 * @throws {ValidationError} When the status is outside the enum, `usage` or
 *   `models` does not match, or `transcript` is present and is not a string.
 * @throws {Error} When the session stopped being open mid-flight.
 */
export function finishSession(
  db: Database,
  id: number,
  input: FinishSessionInput,
): Session | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData('session.finished', {
    status: input.status,
    exit_code: input.exit_code,
    timeout_reason: input.timeout_reason,
    usage: input.usage,
    models: input.models,
  });
  const usage = data.usage as SessionUsage | null;
  const models = data.models as string[] | null;
  const transcript = capTranscript(input.transcript);
  const actor = resolveActor(input.actor, RUNNER_ACTOR);
  const projectId = sessionProject(db, id);

  const close = db.transaction((): Session => {
    const timestamp = now();
    const effect = db
      .prepare(
        `UPDATE session SET status = ?, exit_code = ?, timeout_reason = ?, usage = ?,
                models = ?, transcript = ?, transcricao_truncada = ?,
                transcricao_tamanho_original = ?, finished_at = ?
          WHERE id = ? AND status = 'aberta'`,
      )
      .run(
        data.status as string,
        data.exit_code as number | null,
        // NULL is "no watchdog stopped this session" — for a natural end, for a
        // cancel somebody drove, and for an adapter that reported no cause.
        data.timeout_reason as string | null,
        // An absent `usage` writes a real NULL, never an object of zeros.
        usage === null ? null : JSON.stringify(usage),
        // ...and an absent `models` writes a real NULL, never an empty list:
        // "the engine named no model" and "it ran under zero models" are not
        // the same claim, and only the first one has ever been measured (t172).
        models === null ? null : JSON.stringify(models),
        // ...and the same reading for the transcript: NULL is "nothing was
        // reported", `''` is "the session printed nothing".
        transcript.text,
        asInteger(transcript.truncated),
        transcript.originalBytes,
        timestamp,
        id,
      );

    // The whole transaction falls if the session stopped being open between the
    // route's check and this UPDATE: finishing twice is a 409, never a second
    // ending over the first (t149). Throwing HERE is what keeps the second
    // `session.finished` out of the log.
    if (effect.changes !== 1) {
      throw new Error(`session ${id} stopped being open during the finish`);
    }

    recordEvent(db, {
      type: 'session.finished',
      project_id: projectId,
      execution_id: row.execucao_id,
      entity: { type: 'session', id },
      actor,
      occurred_at: timestamp,
      data,
    });

    return toSession(readRow(db, id) as SessionRow);
  });

  return close();
}

/**
 * What `GET /v1/sessions/:id/transcript` reads, in the column's own words.
 *
 * The names mirror {@link Session}'s, like every other projection in this file;
 * what LEAVES the process is `toWireSessionTranscript`'s output (t232).
 */
export interface SessionTranscript {
  transcricao: string | null;
  truncada: boolean;
  tamanho_original: number | null;
}

/**
 * The raw output of a session, as it was stored (t159, FR4).
 *
 * A route of its own — and not one more field a reader has to fish out of the
 * projection — because this is the one payload of the session that is measured
 * in megabytes: whoever is diagnosing a failure asks for it explicitly.
 *
 * `null`/`false`/`null` is a legitimate answer, not a 404: a session still
 * running has not reported anything yet, and one that finished before this
 * ticket existed never will. Both read back as "no transcript recorded", which
 * is the honest answer. Only a session id that names nothing is a 404.
 *
 * @param db Open handle.
 * @param id Session id.
 * @returns The transcript payload, or `null` if the session does not exist.
 */
export function getSessionTranscript(db: Database, id: number): SessionTranscript | null {
  const row = readRow(db, id);
  if (row === undefined) return null;
  return {
    transcricao: row.transcricao,
    truncada: asBoolean(row.transcricao_truncada),
    tamanho_original: row.transcricao_tamanho_original,
  };
}

/** Body of `POST /v1/sessions/:id/permission-denials`. */
export interface PermissionDenialInput {
  resource?: unknown;
  tool?: unknown;
  reason?: unknown;
  actor?: unknown;
}

/**
 * Records an attempt at a tool the session's permission policy denied
 * (t125, FR9).
 *
 * **Event only: the `session` row does not move.** A denial is an incident, not
 * an outcome — the session goes on, and may be denied again. Writing a status
 * here would turn "it tried a closed door" into "it ended", which is a
 * different fact about a session that is still running.
 *
 * @param db Open handle.
 * @param id Session id.
 * @param input Request body.
 * @returns The session, unchanged, or `null` if it does not exist.
 * @throws {ValidationError} When the resource is outside the enum or a field is missing.
 */
export function recordPermissionDenial(
  db: Database,
  id: number,
  input: PermissionDenialInput,
): Session | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData('session.permission_denied', {
    resource: input.resource,
    tool: input.tool,
    reason: input.reason,
  });
  const actor = resolveActor(input.actor, RUNNER_ACTOR);

  // No transaction: there is a single append and nothing to keep atomic with
  // it. `finishSession` needs one because it also moves the projection row.
  recordEvent(db, {
    type: 'session.permission_denied',
    project_id: sessionProject(db, id),
    execution_id: row.execucao_id,
    entity: { type: 'session', id },
    actor,
    occurred_at: now(),
    data,
  });

  return toSession(row);
}

/**
 * The sessions of one execution, or of one job (FR12; t107 FR2).
 *
 * The slice by job exists because the screen's timeline needs the END of the
 * sessions, and `GET /v1/jobs/:id/events` does not deliver it: the payload of
 * `session.finished` does not carry `job_id`, and the comment in
 * `src/db/events.ts` already said where to send whoever wants that fact —
 * "whoever wants the end of the session asks the session". Only the way to ask
 * was missing.
 *
 * The two filters add up as AND: they are slices, not modes.
 *
 * @param db Open handle.
 * @param filter Optional slices by execution and by job.
 * @returns Sessions in id order.
 */
export function listSessions(
  db: Database,
  filter: { execucao_id?: number; trabalho_id?: number } = {},
): Session[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.execucao_id !== undefined) {
    conditions.push('execution_id = ?');
    values.push(filter.execucao_id);
  }
  if (filter.trabalho_id !== undefined) {
    conditions.push('job_id = ?');
    values.push(filter.trabalho_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM session ${where} ORDER BY id`)
    .all(...values) as SessionRow[];
  return rows.map(toSession);
}
