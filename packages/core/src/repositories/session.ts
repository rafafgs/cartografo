/**
 * Session repository — the run of an agent by an EngineAdapter.
 *
 * In flowpilot this was a mutable row born `pending` and updated until
 * `completed`. Here there are TWO facts (`sessao.aberta`, `sessao.finalizada`)
 * and a projection derived from them — consequence 2 of the taxonomy's
 * append-only rule.
 *
 * The care that runs through the file: an absent `uso` is `null`, never zero.
 * Zero tokens is a measurement; absence is the engine not having reported
 * anything, and collapsing the two destroys the only cost metric the PoC will
 * have.
 *
 * The projection's field names, the table/column names and the event-type
 * strings mirror the untouched migration and the event taxonomy, so they stay in
 * Portuguese (t127, FR8).
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
  status: string;
  exit_code: number | null;
  uso: SessionUsage | null;
  transcricao: string | null;
  transcricao_truncada: boolean;
  transcricao_tamanho_original: number | null;
  aberta_em: string;
  finalizada_em: string | null;
}

interface SessionRow extends Omit<Session, 'uso' | 'transcricao_truncada'> {
  uso: string | null;
  transcricao_truncada: number;
}

const COLUMNS = `
  id, trabalho_id, execucao_id, no_id, engine, engine_session_ref, working_dir,
  prompt, timeout_seconds, status, exit_code, uso, transcricao,
  transcricao_truncada, transcricao_tamanho_original, aberta_em, finalizada_em
`;

function toSession(row: SessionRow): Session {
  return {
    ...row,
    uso: jsonOrNull<SessionUsage>(row.uso),
    transcricao_truncada: asBoolean(row.transcricao_truncada),
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
 * `sessao.finalizada` contract and never enters the event log, so its own type
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
    throw new ValidationError(['transcricao has to be a string, or absent']);
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
  return db.prepare(`SELECT ${COLUMNS} FROM sessao WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
}

/**
 * The project this session was opened under (t157, FR3/FR4).
 *
 * The `sessao` table has no `projeto_id` column: `openSession` resolves the
 * project — the served job's, or the one declared in the body — and records it
 * in the envelope of `sessao.aberta`, and that event is where it lives. Every
 * later event of the session reads it from there.
 *
 * Deriving it again from `trabalho` (which is what this file did until t157)
 * quietly loses the answer for a session with no job — a discovery session, a
 * conversation turn, the very case `sessao.aberta`'s contract calls out: the
 * join finds nothing and the end of the session gets filed under
 * `DEFAULT_PROJECT`, whatever project it actually opened under. The log already
 * knew; nobody was asking it.
 *
 * Read-only, over the `evento` table: the append-only rule is untouched.
 *
 * @param db Open handle.
 * @param id Session id.
 * @returns The project of the opening event; `DEFAULT_PROJECT` only for a
 *   session with no opening event, which `openSession`'s transaction makes
 *   unreachable in practice.
 */
function sessionProject(db: Database, id: number): number {
  const opening = getEventsByEntity(db, 'sessao', id).find(
    (event) => event.tipo === 'sessao.aberta',
  );
  return opening?.projeto_id ?? DEFAULT_PROJECT;
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
  trabalho_id?: unknown;
  no_id?: unknown;
  engine?: unknown;
  engine_session_ref?: unknown;
  working_dir?: unknown;
  prompt?: unknown;
  timeout_seconds?: unknown;
  execucao_id?: unknown;
  projeto_id?: unknown;
  ator?: unknown;
}

/**
 * Opens the session and records `sessao.aberta` (FR10).
 *
 * `execucao_id` and `projeto_id` are inherited from the job served when there is
 * one — the session belongs to the job's round, and asking the caller to repeat
 * that would invite divergence. Without a job (a discovery session, a
 * conversation turn), what came in the body holds.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The open session, or `null` if the given `trabalho_id` does not exist.
 * @throws {ValidationError} When a required field is missing.
 */
export function openSession(db: Database, input: OpenSessionInput): Session | null {
  const data = requireValidData('sessao.aberta', {
    trabalho_id: input.trabalho_id,
    no_id: input.no_id,
    engine: input.engine,
    engine_session_ref: input.engine_session_ref,
    working_dir: input.working_dir,
    prompt: input.prompt,
    timeout_seconds: input.timeout_seconds,
  });

  const jobId = data.trabalho_id as number | null;
  const owner =
    jobId === null
      ? undefined
      : (db.prepare('SELECT projeto_id, execucao_id FROM trabalho WHERE id = ?').get(jobId) as
          | { projeto_id: number; execucao_id: number | null }
          | undefined);
  if (jobId !== null && owner === undefined) return null;

  const projectId = owner?.projeto_id ?? integerOrDefault('projeto_id', input.projeto_id, DEFAULT_PROJECT);
  const executionId = owner?.execucao_id ?? integerOrNull('execucao_id', input.execucao_id);
  const actor = resolveActor(input.ator, RUNNER_ACTOR);

  const open = db.transaction((): Session => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO sessao (
           trabalho_id, execucao_id, no_id, engine, engine_session_ref, working_dir,
           prompt, timeout_seconds, status, exit_code, uso, aberta_em, finalizada_em
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', NULL, NULL, ?, NULL)`,
      )
      .run(
        jobId,
        executionId,
        data.no_id as string | null,
        data.engine as string,
        data.engine_session_ref as string | null,
        data.working_dir as string,
        data.prompt as string,
        data.timeout_seconds as number | null,
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      tipo: 'sessao.aberta',
      projeto_id: projectId,
      execucao_id: executionId,
      entidade: { tipo: 'sessao', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toSession(readRow(db, id) as SessionRow);
  });

  return open();
}

/** Body of `PATCH /v1/sessions/:id/finish`. */
export interface FinishSessionInput {
  status?: unknown;
  exit_code?: unknown;
  uso?: unknown;
  transcricao?: unknown;
  ator?: unknown;
}

/**
 * Closes the session and records `sessao.finalizada` (FR11).
 *
 * Closing is exactly-once: the `UPDATE` is guarded by `status = 'aberta'` and a
 * lost claim throws before anything is appended, the same shape the sibling
 * repositories already use (t149). A second finish would rewrite the terminal
 * status and NULL the `uso` this whole file exists to protect — so it is refused
 * with a 409 by the route, and never silently applied.
 *
 * The transcript (t159) rides in the SAME transaction, and there is no second
 * endpoint for it: one write, one caller. It is the raw stream the engine
 * printed, capped by {@link capTranscript} — and it goes to the row only, never
 * into `dados`, because the event schema does not know it exists.
 *
 * @param db Open handle.
 * @param id Session id.
 * @param input Request body.
 * @returns The closed session, or `null` if it does not exist.
 * @throws {ValidationError} When the status is outside the enum, `uso` does not
 *   match, or `transcricao` is present and is not a string.
 * @throws {Error} When the session stopped being open mid-flight.
 */
export function finishSession(
  db: Database,
  id: number,
  input: FinishSessionInput,
): Session | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData('sessao.finalizada', {
    status: input.status,
    exit_code: input.exit_code,
    uso: input.uso,
  });
  const usage = data.uso as SessionUsage | null;
  const transcript = capTranscript(input.transcricao);
  const actor = resolveActor(input.ator, RUNNER_ACTOR);
  const projectId = sessionProject(db, id);

  const close = db.transaction((): Session => {
    const timestamp = now();
    const effect = db
      .prepare(
        `UPDATE sessao SET status = ?, exit_code = ?, uso = ?, transcricao = ?,
                transcricao_truncada = ?, transcricao_tamanho_original = ?, finalizada_em = ?
          WHERE id = ? AND status = 'aberta'`,
      )
      .run(
        data.status as string,
        data.exit_code as number | null,
        // An absent `uso` writes a real NULL, never an object of zeros.
        usage === null ? null : JSON.stringify(usage),
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
    // `sessao.finalizada` out of the log.
    if (effect.changes !== 1) {
      throw new Error(`session ${id} stopped being open during the finish`);
    }

    recordEvent(db, {
      tipo: 'sessao.finalizada',
      projeto_id: projectId,
      execucao_id: row.execucao_id,
      entidade: { tipo: 'sessao', id },
      ator: actor,
      ocorrido_em: timestamp,
      dados: data,
    });

    return toSession(readRow(db, id) as SessionRow);
  });

  return close();
}

/** Body of `GET /v1/sessions/:id/transcript`. */
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
  recurso?: unknown;
  ferramenta?: unknown;
  motivo?: unknown;
  ator?: unknown;
}

/**
 * Records an attempt at a tool the session's permission policy denied
 * (t125, FR9).
 *
 * **Event only: the `sessao` row does not move.** A denial is an incident, not
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

  const data = requireValidData('sessao.permissao_negada', {
    recurso: input.recurso,
    ferramenta: input.ferramenta,
    motivo: input.motivo,
  });
  const actor = resolveActor(input.ator, RUNNER_ACTOR);

  // No transaction: there is a single append and nothing to keep atomic with
  // it. `finishSession` needs one because it also moves the projection row.
  recordEvent(db, {
    tipo: 'sessao.permissao_negada',
    projeto_id: sessionProject(db, id),
    execucao_id: row.execucao_id,
    entidade: { tipo: 'sessao', id },
    ator: actor,
    ocorrido_em: now(),
    dados: data,
  });

  return toSession(row);
}

/**
 * The sessions of one execution, or of one job (FR12; t107 FR2).
 *
 * The slice by job exists because the screen's timeline needs the END of the
 * sessions, and `GET /v1/jobs/:id/events` does not deliver it: the payload of
 * `sessao.finalizada` does not carry `trabalho_id`, and the comment in
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
    conditions.push('execucao_id = ?');
    values.push(filter.execucao_id);
  }
  if (filter.trabalho_id !== undefined) {
    conditions.push('trabalho_id = ?');
    values.push(filter.trabalho_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM sessao ${where} ORDER BY id`)
    .all(...values) as SessionRow[];
  return rows.map(toSession);
}
