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
 * The TABLE and its columns are English since D20's fourth child (t229) and the
 * event-type strings since its second (t227). {@link Session} is English too,
 * and is the object `/v1` publishes: t286 deleted the alias-and-translate layer
 * between the two, which renamed nothing a client could see.
 *
 * Two columns stayed behind, and had to: `transcricao_truncada` and
 * `transcricao_tamanho_original` have no row in `docs/spec/glossario-wire.md`
 * §4.2 — it registers `transcricao` and neither of its siblings — so moving them
 * is a migration, not a rename. They keep their spelling on {@link SessionRow},
 * and {@link toSession} builds `transcript_truncated` and
 * `transcript_original_size` off them by hand.
 */

import type { Database } from '../db/connection.ts';
import { getEventsByEntity, recordEvent } from '../db/events.ts';
import { requireValidData, ValidationError } from '../db/event-validation.ts';
import { validateAgainstJsonSchema } from '../domain/manifest.ts';
import { isObject } from '../util/is-object.ts';
import { getVersion } from './graphs.ts';
import { announceFinishedExecution, blockOnRepeatedFailure } from './job.ts';
import { getSkill } from './skill.ts';
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
  job_id: number | null;
  execution_id: number | null;
  node_id: string | null;
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
  /**
   * The column's value, which is also the wire's word since t227.
   *
   * There is no map either way, and for the OPPOSITE reason there used to be
   * one: the column takes whatever `session.finished`'s `data.status` carries,
   * and since D20's second child that is `completed`, `failed`, `timed_out`, …
   * — so `/finish` accepts the same word it answers, with nothing in between.
   * The column has no `CHECK` (migration `0003`), which is why the value could
   * simply change; the fourth child (t229) renamed identifiers only and moved no
   * stored value.
   */
  status: string;
  exit_code: number | null;
  /** Which watchdog stopped it, when one did (t163). `null` = not applicable. */
  timeout_reason: string | null;
  usage: SessionUsage | null;
  /**
   * Which models the engine reported having run this session (t172).
   *
   * A list because a session runs more than one — a real single-turn run
   * already reported two — and collapsing to "the" model would charge the whole
   * bill to the wrong one. `null` is "the engine named none", which is also
   * what every row from before this column existed reads as; `[]` is not a way
   * to say that and never gets stored.
   */
  models: string[] | null;
  transcript: string | null;
  /**
   * Whether the 1 MiB cap bit (t159, FR2).
   *
   * One of the two fields whose COLUMN is still Portuguese
   * (`transcricao_truncada`), so the name is built by {@link toSession} rather
   * than read straight off the row.
   */
  transcript_truncated: boolean;
  /** Size in bytes before the cap; the other Portuguese-column field. */
  transcript_original_size: number | null;
  /**
   * The node's structured result, as the session reported it at `/finish`
   * (t253).
   *
   * This is the half of the node input projection that WRITES: `domain/context.
   * ts` reads it back out of every completed session of a job and merges it into
   * the object the next node's `input` schema declares. `null` is "nothing
   * structured was reported" — the same reading `usage` and `models` have — and
   * it is ALSO what a report that did not match the skill's `output` schema
   * leaves behind, with the reason recorded in the event instead of here.
   *
   * Published, unlike `output_schema_error`: this is the value the projection is
   * built out of, and a client that wants to know what a node produced has one
   * place to read it. WHY a report was refused is telemetry of the log, not part
   * of the session — see {@link finishSession}.
   */
  output: Record<string, unknown> | null;
  opened_at: string;
  finished_at: string | null;
}

interface SessionRow
  extends Omit<
    Session,
    'usage' | 'models' | 'output' | 'transcript_truncated' | 'transcript_original_size'
  > {
  usage: string | null;
  models: string | null;
  output: string | null;
  /** The column `Session.transcript_truncated` is built from; see {@link COLUMNS}. */
  transcricao_truncada: number;
  /** The column `Session.transcript_original_size` is built from. */
  transcricao_tamanho_original: number | null;
}

/**
 * The columns {@link SessionRow} is made of — every one under its own name (t286).
 *
 * Nothing is aliased any more, the two residual names least of all: an alias
 * over `transcricao_truncada` would invent a schema spelling
 * `glossario-wire.md` §4.2 does not carry, which is what the glossary exists to
 * prevent. {@link toSession} builds the two English names instead.
 */
const COLUMNS = `
  id, job_id, execution_id, node_id,
  engine, engine_session_ref, working_dir,
  prompt, timeout_seconds, silence_seconds, status, exit_code, timeout_reason,
  usage, models, transcript,
  transcricao_truncada, transcricao_tamanho_original, output,
  opened_at, finished_at
`;

/**
 * The row as {@link Session} publishes it.
 *
 * The two residual columns are destructured OUT before the spread, and that is
 * the care this function exists for: a bare `{...row}` would carry
 * `transcricao_truncada` and `transcricao_tamanho_original` out beside the
 * English names built from them, and an extra key on a projection fails nothing
 * — it just reaches `/v1` under a name no client was ever told about.
 * `test/no-leaked-row-keys.test.ts` is the gate that says so.
 *
 * @param row The session's row, as it is in the table.
 * @returns The projection.
 */
function toSession(row: SessionRow): Session {
  const {
    transcricao_truncada: truncated,
    transcricao_tamanho_original: originalSize,
    ...rest
  } = row;
  return {
    ...rest,
    usage: jsonOrNull<SessionUsage>(row.usage),
    // Same JSON-in-a-column convention `usage` above already uses, and the same
    // reading of a NULL: nothing was reported. A row written before t172 lands
    // here as `null` with no backfill and no special case.
    models: jsonOrNull<string[]>(row.models),
    // ...and the third one, for the same two reasons (t253).
    output: jsonOrNull<Record<string, unknown>>(row.output),
    transcript_truncated: asBoolean(truncated),
    transcript_original_size: originalSize,
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
 *   empty string, the same discipline `usage` has had in this file since t102;
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
            'SELECT project_id, execution_id FROM job WHERE id = ?',
          )
          .get(jobId) as
          | { project_id: number; execution_id: number | null }
          | undefined);
  if (jobId !== null && owner === undefined) return null;

  const projectId =
    owner?.project_id ?? integerOrDefault('project_id', input.project_id, DEFAULT_PROJECT);
  const executionId = owner?.execution_id ?? integerOrNull('execution_id', input.execution_id);
  const actor = resolveActor(input.actor, RUNNER_ACTOR);

  const open = db.transaction((): Session => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO session (
           job_id, execution_id, node_id, engine, engine_session_ref, working_dir,
           prompt, timeout_seconds, silence_seconds, status, exit_code, usage,
           opened_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, NULL)`,
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
  /**
   * What KIND of failure this was, when `failed` alone does not say (t265).
   *
   * Today one value, `engine_refusal`: the engine refused the request before
   * working. It rides in the event and in nothing else — no column, no field on
   * `GET /v1/sessions` — because the two consumers it has are the log and the
   * block reason, and promoting it to the projection before a third one exists
   * is how a schema grows fields nobody reads.
   */
  failure_kind?: unknown;
  /** How the engine classified its own refusal, when it did (t265). */
  refusal_category?: unknown;
  usage?: unknown;
  models?: unknown;
  transcript?: unknown;
  /**
   * The node's structured result (t253, FR1).
   *
   * Absent and `null` are the same fact — "nothing structured was reported" —
   * the posture `usage` and `models` above already have. What the object has to
   * look like is not this envelope's business: it is checked against the
   * `output` schema of the skill the node pins, by {@link resolveOutputSchema}
   * below.
   */
  output?: unknown;
  actor?: unknown;
}

/**
 * The `output` JSON Schema this session's node declares, when it declares one.
 *
 * The whole resolution path, and every step of it may honestly end in `null`:
 * session → its node id → its job → the job's `graph_version_id` → that
 * version's snapshot → the node inside it → the node's `skill_ref` → the
 * registry row at that exact `(id, version)` → its `output`.
 *
 * **`null` is not a defect and is never reported as one.** A session with no
 * job (a discovery session, a conversation turn), a job created by hand with no
 * graph, a version the snapshot no longer carries the node of, a node with no
 * pin — all four are ordinary, and all four are what every dispatch looked like
 * before graphs existed. It is the same posture `resolveNode` writes on the
 * runner's side of the same read: the answer is "there is nothing to check this
 * against", never "this is wrong".
 *
 * Reads only, and only tables this package owns. `(id, version)` and never
 * "the latest": the graph is frozen during execution, and resolving forward
 * would judge a report against a schema nobody pinned (D4, D22).
 *
 * @param db Open handle.
 * @param row The session being closed, as it is in the table.
 * @returns The registered skill's `output` schema, or `null` when the chain
 *   does not reach one.
 */
function resolveOutputSchema(db: Database, row: SessionRow): unknown {
  if (row.node_id === null || row.job_id === null) return null;

  const owner = db
    .prepare('SELECT graph_version_id FROM job WHERE id = ?')
    .get(row.job_id) as { graph_version_id: string | null } | undefined;
  if (owner === undefined || owner.graph_version_id === null) return null;

  const version = getVersion(db, owner.graph_version_id);
  if (version === undefined) return null;

  const node = version.snapshot.nodes?.find((candidate) => candidate.id === row.node_id);
  const pin = node === undefined ? undefined : node.skill_ref;
  if (!isObject(pin) || typeof pin.id !== 'string' || typeof pin.version !== 'string') {
    return null;
  }

  const skill = getSkill(db, pin.id, { version: pin.version });
  return skill === null ? null : skill.output;
}

/**
 * The reported object without the routing label, when it carries a usable one
 * (t269, FR1/FR3).
 *
 * `resultado` is the GRAPH's vocabulary, not the skill's: it names the
 * `condition` of the edge the session says its node took
 * (`docs/spec/graph.md`), and it rides inside the report only because the
 * fenced-block protocol has exactly one block (t161, t259,
 * `packages/runner/src/dispatch/parse-node-result.ts`). Holding it against the
 * pinned skill's `output` confused two schemas: a skill that closes its own —
 * `additionalProperties: false`, which `derrubar-tese@1.0.0` declares — refused
 * every conforming report of a routing node, and since t268 a refusal blocks the
 * node instead of passing silently. So the key never reaches the check, and
 * never reaches the row or the log either.
 *
 * The reading of "usable" is `build()`'s in that same parser, verbatim: present,
 * a string, non-empty after `.trim()`. Anything else is a session that did not
 * understand the protocol, and it comes back untouched — a strict schema refuses
 * it exactly as it did before this ficha, because laundering a key nobody can
 * route on would store an object beside a decision no edge can carry.
 *
 * The label itself is read and dropped: the runner decided the route from its
 * OWN parse of the block before `/finish` was called, the edge actually taken is
 * already telemetered by `job.transitioned`, and one that matched no edge rides
 * in the escalation's own question. A column for it would be the premature
 * projection the rule of two consumers exists to refuse.
 *
 * @param reported The object the session reported, as it reported it.
 * @returns The same object without `resultado`, or the object itself when there
 *   is no usable label to take out.
 */
function stripRouteLabel(reported: Record<string, unknown>): Record<string, unknown> {
  const label = reported.resultado;
  if (typeof label !== 'string' || label.trim() === '') return reported;

  const kept = { ...reported };
  delete kept.resultado;
  return kept;
}

/**
 * What closing a session answers: the session, plus the verdict on the report
 * it carried (t268).
 *
 * The verdict exists because the runner asks a question this repository has
 * been able to answer since t253 and never did: it validates a reported
 * `output` against the pinned skill's schema, writes `null` and the reasons
 * when it refuses — and then handed back a session that cannot say any of it,
 * by design ({@link Session.output}'s own comment: WHY a report was refused is
 * telemetry of the log, not part of the session). The runner, with no answer,
 * routed the job from its OWN parse of the same block. So a report this file
 * rejected still moved the work along an edge.
 *
 * A return value and not a column: what the caller needs is synchronous, at the
 * one call that produced it. Nothing durable changes — the doctrine above holds
 * for every OTHER route, and a session still cannot answer "was my report
 * refused" after the fact.
 */
export interface FinishSessionResult {
  /** The closed session, exactly as it always came back. */
  session: Session;
  /**
   * Whether the reported `output` was taken.
   *
   * Set on EVERY close, and `true` in two different situations that are the
   * same one for the caller: nothing was reported (so there was nothing to
   * refuse) and the report matched the schema. `false` only when the pinned
   * skill's own `output` schema refused what was reported.
   */
  output_accepted: boolean;
  /** Why it was refused, when it was — the same list the event carries. */
  output_schema_error?: string[];
}

/**
 * Closes the session and records `session.finished` (FR11).
 *
 * Closing is exactly-once: the `UPDATE` is guarded by `status = 'open'` and a
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
 * ## The node's structured result, and why a bad one does not refuse (t253, FR4)
 *
 * `output` is what the next node's `input` projection is built out of, and it is
 * held against the `output` schema of the skill THIS node pins (D9) —
 * {@link resolveOutputSchema}. The check lives here and not in the runner
 * because core is the sole writer (D1): it is the one place that can look up the
 * registered skill without a second round trip, and the one place that must
 * never accept an event it cannot itself justify.
 *
 * A mismatch never blocks the close. `status`, `exit_code`, `usage`, `models`
 * and `transcript` are written exactly as they always were; the row's `output`
 * gets `null` and the event carries `output_schema_error` in place of the
 * reported value. The reasoning is the one the manifest format already states —
 * a work node's self-report is never evidence, a gate verifies with its own —
 * so losing the SESSION over a malformed self-report would be strictly worse
 * than losing the self-report: it would leave the session `open` forever, with
 * `/finish` answering 409 from then on and no route left to close it.
 *
 * @param db Open handle.
 * @param id Session id.
 * @param input Request body.
 * @returns The closed session and the verdict on its report, or `null` if the
 *   session does not exist.
 * @throws {ValidationError} When the status is outside the enum, `usage`,
 *   `models` or `output` does not match the envelope's own contract, or
 *   `transcript` is present and is not a string.
 * @throws {Error} When the session stopped being open mid-flight.
 */
export function finishSession(
  db: Database,
  id: number,
  input: FinishSessionInput,
): FinishSessionResult | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const data = requireValidData('session.finished', {
    status: input.status,
    exit_code: input.exit_code,
    timeout_reason: input.timeout_reason,
    failure_kind: input.failure_kind,
    refusal_category: input.refusal_category,
    usage: input.usage,
    models: input.models,
    output: input.output,
  });
  const usage = data.usage as SessionUsage | null;
  const models = data.models as string[] | null;
  const transcript = capTranscript(input.transcript);
  const actor = resolveActor(input.actor, RUNNER_ACTOR);
  const projectId = sessionProject(db, id);

  // Nothing reported, nothing to check: an absent `output` skips the lookup
  // entirely, so the ordinary session pays no read for a feature it did not use.
  const reported = data.output as Record<string, unknown> | null;
  const schema = reported === null ? null : resolveOutputSchema(db, row);
  // The routing key comes out only when there IS a schema to hold the rest
  // against (t269, FR2): with nothing to check the report against, there is also
  // nothing to reserve a key from, and t253 AT3's doctrine stands — what was
  // reported is stored exactly as it was reported, `resultado` included.
  const judged = reported === null || schema === null ? reported : stripRouteLabel(reported);
  const problems = judged === null ? [] : validateAgainstJsonSchema(schema, judged);
  const output = problems.length === 0 ? judged : null;
  const accepted = problems.length === 0;
  // Written on every close, including the one where nothing was reported: the
  // event is where a reader reconstructs what happened, and an `output_accepted`
  // that appeared only on the refusal would make "was not checked" and "was not
  // refused" the same silence (t268).
  data.output_accepted = accepted;
  // The log carries what was KEPT, and it is the same object the row keeps:
  // `null` for a refused report, and — since t269 — the accepted one without the
  // routing key, so nobody reading the event later finds in it a field the
  // projection does not have.
  data.output = output;
  if (!accepted) {
    data.output_schema_error = problems;
  }

  const close = db.transaction((): Session => {
    const timestamp = now();
    const effect = db
      .prepare(
        `UPDATE session SET status = ?, exit_code = ?, timeout_reason = ?, usage = ?,
                models = ?, transcript = ?, transcricao_truncada = ?,
                transcricao_tamanho_original = ?, output = ?, finished_at = ?
          WHERE id = ? AND status = 'open'`,
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
        // ...and the same reading a third time (t253): NULL is "nothing
        // structured was reported", and it is also what a report the skill's
        // schema refused leaves behind — the reason travels in the event, so
        // nobody has to guess which of the two a NULL means.
        output === null ? null : JSON.stringify(output),
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
      execution_id: row.execution_id,
      entity: { type: 'session', id },
      actor,
      occurred_at: timestamp,
      data,
    });

    // The third moment a round can end (t262, FR4). Since a final node that
    // pins a skill stops being `concluido` on arrival, the LAST thing that
    // happens in an ordinary traversal is this very closure — a final node has
    // no outgoing edge, so no transition follows it and `transitionJob`'s own
    // announcement can never fire. Without this call `GET /v1/executions`
    // would report `finished_at: null` forever for every real run of both
    // factory bundles.
    //
    // Unconditional, exactly like the two callers in `job.ts`: what decides is
    // `announceFinishedExecution`'s own three guards — no round, no jobs, not
    // every job arrived, or a lease still held — so an ordinary session closing
    // on an intermediate node costs one no-op. What it still cannot see is the
    // lease-release ordering the function's own header documents (t264): the
    // runner releases AFTER reporting, so a round finished by a dispatched
    // session is typically announced only when something else moves. That gap
    // is inherited here as-is (FR7), not closed and not worked around.
    announceFinishedExecution(db, row.execution_id, projectId, timestamp);

    // ...and the other thing a closure can trigger (t265, FR10): a job whose
    // sessions keep failing on the same node stops being re-leased. Here and not
    // in the runner because the streak spans leases and runner processes, and
    // only this side can see it (D1) — inside the same transaction, so a flag
    // never exists without the closure that raised it.
    //
    // Three guards, and each one excludes a different thing. Anything but
    // `failed` is not a failure to count — `timed_out` is a stop of OURS, and
    // `completed` is what resets the streak. A `failure_kind` present means the
    // runner is already blocking this one on its own account, and two owners for
    // one flag is how a job ends up blocked with nothing pending. And a session
    // with no job belongs to no streak at all.
    if (data.status === 'failed' && data.failure_kind === null && row.job_id !== null) {
      blockOnRepeatedFailure(db, row.job_id, row.node_id, timestamp);
    }

    return toSession(readRow(db, id) as SessionRow);
  });

  return {
    session: close(),
    output_accepted: accepted,
    // Only on the refusal, exactly like the event's own field: the caller that
    // has to quote the reasons is the one being told there are some.
    ...(accepted ? {} : { output_schema_error: problems }),
  };
}

/**
 * What `GET /v1/sessions/:id/transcript` answers with (t232).
 *
 * The same three names {@link Session} publishes for the same three facts, and
 * deliberately not a shorter second spelling: `truncated` next to `/finish`'s
 * `transcript_truncated` would be one concept with two names, and a client that
 * reads the end of a session and then its transcript would parse both. Since
 * t286 it is also the object that LEAVES the process — there is no translation
 * step behind it any more.
 */
export interface SessionTranscript {
  transcript: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
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
    transcript: row.transcript,
    transcript_truncated: asBoolean(row.transcricao_truncada),
    transcript_original_size: row.transcricao_tamanho_original,
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
    execution_id: row.execution_id,
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
  filter: { execution_id?: number; job_id?: number } = {},
): Session[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.execution_id !== undefined) {
    conditions.push('execution_id = ?');
    values.push(filter.execution_id);
  }
  if (filter.job_id !== undefined) {
    conditions.push('job_id = ?');
    values.push(filter.job_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM session ${where} ORDER BY id`)
    .all(...values) as SessionRow[];
  return rows.map(toSession);
}
