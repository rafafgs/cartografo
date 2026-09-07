/**
 * Access to `external_call` — the record of every MCP call this system makes
 * (t370, FR6; RF-37, input half).
 *
 * The control plane does not know what MCP is, and nothing here learns: this is
 * a RELAY, the same standing `engine-models.ts` and `runner-probes.ts` already
 * have. A runner called a server on a node's behalf and wrote down which, when,
 * with what arguments and with what summarised result. Nothing in this module
 * validates a server name, resolves a tool or judges an outcome.
 *
 * **Two phases, one row.** {@link createExternalCallIntent} writes the row
 * BEFORE the call, with `finished_at`, `outcome` and `result_summary` NULL;
 * {@link completeExternalCall} fills those three in afterwards. That is what
 * makes a crashed runner legible: three NULLs well after `started_at` is a call
 * whose fate nobody recorded, and "unknown" is the READER's conclusion rather
 * than a value anybody stored.
 *
 * **Completing twice is refused, and it is not a not-found.** A second
 * completion is a conflict — the first answer stands, and overwriting it would
 * lose the only record of what really happened. It comes back as the
 * {@link ALREADY_COMPLETED} sentinel rather than as an exception, because the
 * route above turns it into a `409` and every other refusal in this family is a
 * return value too.
 *
 * **A row of ANOTHER job is `null`, exactly like a row that does not exist.**
 * The convention t411 and t422 already set: a boundary a client can tell apart
 * from an absence is a boundary that reports which ids are taken elsewhere.
 *
 * Like every other repository it receives the already-open database and never
 * touches the driver (D1). English throughout.
 */

import type { Database } from '../db/connection.ts';

/** Which way a call went: fetching a node's input, or writing its output back. */
export type ExternalCallDirection = 'input' | 'output';

/** How a call ended, once it has ended. */
export type ExternalCallOutcome = 'ok' | 'error';

/** The two values `direction` accepts, as the migration's CHECK spells them. */
export const EXTERNAL_CALL_DIRECTIONS: readonly ExternalCallDirection[] = ['input', 'output'];

/** ...and the two `outcome` accepts. */
export const EXTERNAL_CALL_OUTCOMES: readonly ExternalCallOutcome[] = ['ok', 'error'];

/**
 * The ceiling on either summary, in characters.
 *
 * 1 KiB of text, applied by the ROUTE before the write and never trusted from
 * the caller: RF-37 asks for a summary, and a column that could hold the whole
 * payload is a column that eventually holds a credential somebody passed as an
 * argument. Characters rather than bytes because the summaries this system
 * writes are ASCII — a digest, a byte count, an error sentence — and cutting a
 * multi-byte character in half to honour an exact byte count would be trading a
 * readable record for an arithmetic one.
 */
export const SUMMARY_CAP = 1_024;

/** The sentinel a completion of an already-completed call answers with. */
export const ALREADY_COMPLETED = 'already_completed';

/** One row of `external_call`: the record AND what `/v1` publishes. */
export interface ExternalCall {
  id: number;
  job_id: number;
  node_id: string;
  direction: ExternalCallDirection;
  name: string;
  server: string;
  tool: string;
  arguments_sha256: string;
  arguments_summary: string;
  started_at: string;
  /** `null` while nobody has said how it ended — see the module's header. */
  finished_at: string | null;
  outcome: ExternalCallOutcome | null;
  result_summary: string | null;
}

/** What opening a call's record needs. */
export interface ExternalCallIntent {
  node_id: string;
  direction: ExternalCallDirection;
  name: string;
  server: string;
  tool: string;
  arguments_sha256: string;
  arguments_summary: string;
  started_at: string;
}

/** ...and what closing it needs. */
export interface ExternalCallCompletion {
  finished_at: string;
  outcome: ExternalCallOutcome;
  result_summary: string | null;
}

const COLUMNS =
  'id, job_id, node_id, direction, name, server, tool, arguments_sha256, arguments_summary,' +
  ' started_at, finished_at, outcome, result_summary';

/** Cuts a summary to {@link SUMMARY_CAP}, wherever it came from. */
export function summarize(text: string): string {
  return text.length <= SUMMARY_CAP ? text : text.slice(0, SUMMARY_CAP);
}

/** Does this job exist? The one question this module asks about one. */
function jobExists(db: Database, jobId: number): boolean {
  return db.prepare('SELECT 1 FROM job WHERE id = ?').get(jobId) !== undefined;
}

/** Reads one row back, by id, scoped through its job. */
function readCall(db: Database, callId: number, jobId: number): ExternalCall | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM external_call WHERE id = ? AND job_id = ?`)
    .get(callId, jobId) as ExternalCall | undefined;
  return row ?? null;
}

/**
 * Opens the record of a call, before it is made (t370, FR6).
 *
 * @param db Open database.
 * @param jobId The job the call is made for.
 * @param intent What is known before the call: which server, which tool, with
 *   what arguments, from when.
 * @returns The row, with all three completion columns `null`; `null` when
 *   `jobId` names no job.
 */
export function createExternalCallIntent(
  db: Database,
  jobId: number,
  intent: ExternalCallIntent,
): ExternalCall | null {
  if (!jobExists(db, jobId)) return null;

  const inserted = db
    .prepare(
      `INSERT INTO external_call
         (job_id, node_id, direction, name, server, tool, arguments_sha256,
          arguments_summary, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      intent.node_id,
      intent.direction,
      intent.name,
      intent.server,
      intent.tool,
      intent.arguments_sha256,
      summarize(intent.arguments_summary),
      intent.started_at,
    );

  return readCall(db, Number(inserted.lastInsertRowid), jobId);
}

/**
 * Closes the record of a call, after it is made (t370, FR6).
 *
 * @param db Open database.
 * @param callId The row {@link createExternalCallIntent} answered with.
 * @param jobId The job it has to belong to.
 * @param completion How it ended, when, and in one summarised line.
 * @returns The completed row; `null` for an id that names nothing OR belongs to
 *   another job; {@link ALREADY_COMPLETED} for one that already has an outcome.
 */
export function completeExternalCall(
  db: Database,
  callId: number,
  jobId: number,
  completion: ExternalCallCompletion,
): ExternalCall | typeof ALREADY_COMPLETED | null {
  const existing = readCall(db, callId, jobId);
  if (existing === null) return null;
  // The first answer stands. Completing twice is not this contract, and an
  // overwrite would replace the record of what happened with the record of a
  // second opinion about it.
  if (existing.outcome !== null) return ALREADY_COMPLETED;

  db.prepare(
    'UPDATE external_call SET finished_at = ?, outcome = ?, result_summary = ? WHERE id = ?',
  ).run(
    completion.finished_at,
    completion.outcome,
    completion.result_summary === null ? null : summarize(completion.result_summary),
    callId,
  );

  return readCall(db, callId, jobId);
}

/**
 * Every call recorded for one job, oldest first.
 *
 * Scoped through the job exactly as `listSessions` and `getSessionTranscript`
 * are: `external_call` carries no `project_id` of its own and inherits the
 * partition through its foreign key (D25), so the scope is applied by confirming
 * the JOB first — which is what the route does before it calls this.
 *
 * @param db Open database.
 * @param jobId The job to list.
 * @returns The rows, in insertion order.
 */
export function listExternalCalls(db: Database, jobId: number): ExternalCall[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM external_call WHERE job_id = ? ORDER BY id`)
    .all(jobId) as ExternalCall[];
}
