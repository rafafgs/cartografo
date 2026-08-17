/**
 * Job repository — the "traveller" that walks the graph.
 *
 * Every write here records the projection AND the corresponding event in the
 * SAME SQLite transaction (FR18). It is not excessive zeal: the projection is
 * derived from the log, and a state that exists without the fact that produced it
 * is a state the replay does not reproduce — exactly what
 * `test/replay-consistency.test.ts` demands.
 *
 * The functions return `null` when the job does not exist; translating that into
 * a 404 is the route's job.
 *
 * The TABLE and its columns are English since D20's fourth child (t229); the
 * projection's field names are not, because `routes/*.ts`, `intake.ts` and the
 * dispatch path read them and those are outside that ticket's surface — so every
 * `SELECT` aliases the renamed column back onto the field it already fed (t229,
 * FR4). The event-type strings went English with the second child (t227).
 */

import type { Database } from '../db/connection.ts';
import { listEvents, recordEvent } from '../db/events.ts';
import {
  ValidationError,
  requireValidData,
  type Actor,
  type Event,
} from '../db/event-validation.ts';
import {
  isScalarMap,
  missingRequiredFields,
  type ScalarMap,
} from '../domain/custom-fields.ts';
import { getVersion } from './graphs.ts';
import { enqueueHookDeliveries, type ClockOptions } from './hooks.ts';
import {
  API_ACTOR,
  DEFAULT_PROJECT,
  now,
  asBoolean,
  asInteger,
  integerOrNull,
  integerOrDefault,
  jsonOrNull,
  resolveActor,
  textOrNull,
} from './common.ts';

/** Job projection, as the API returns it. */
export interface Job {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  /** Body of the job; `null` when it was born with a title and nothing else (t122). */
  corpo: string | null;
  /**
   * Preliminary acceptance criteria; `null` when none was declared (t122).
   *
   * `null` is not `[]`: the node that refines has to be able to tell "nobody
   * wrote any yet" from "it was declared that there are none".
   */
  criterios_de_aceite: string[] | null;
  /**
   * Values of the fields the CLASS declares in its graph (t168); `null` when the
   * job carries none.
   *
   * The keys are the class's, not this package's: what may appear here is
   * `custom_fields` of the job's graph version, and that is also what the
   * transition gate reads to decide whether the job may leave a node.
   */
  campos: ScalarMap | null;
  /**
   * What this work costs to RUN, as the intake triaged it (t175); `null` when
   * nobody classified it.
   *
   * It never decides which edge the job takes out of a node — the graph stays
   * frozen during execution, and the only in-flight decisions are gate
   * verdicts. What reads this is the runner, once per dispatch, to pick a
   * cheaper model for trivial work on whichever engine that node resolved to.
   *
   * `null` is not `'trivial'`. Every job born before this field existed reads
   * `null`, and collapsing the two would silently downgrade the model of all of
   * them — a choice nobody made, with nothing failing to reveal it.
   */
  tier: 'trivial' | 'standard' | null;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  /** Graph version the job runs under. Loose: `graph_version` belongs to t101 (D15). */
  grafo_versao_id: string | null;
  /**
   * The job arrived: its current node is a final node of its graph version
   * (t152).
   *
   * Derived at read time, never stored — see `isAtFinalNode`. It is the only
   * terminal signal this system has: the log has no `trabalho.concluido` event,
   * and "nothing is open right now" is a state a job one event old already
   * satisfies.
   */
  concluido: boolean;
  criado_em: string;
  atualizado_em: string;
}

/** One row of the version × telemetry grouping (FR17). */
export interface MetricByVersion {
  grafo_versao_id: string | null;
  trabalhos: number;
  eventos: number;
}

/** One row of `GET /v1/executions` — the summary of a round (t107, FR1). */
export interface ExecutionSummary {
  execucao_id: number | null;
  trabalhos: number;
  trabalhos_bloqueados: number;
  perguntas_pendentes: number;
}

interface JobRow
  extends Omit<Job, 'bloqueado' | 'criterios_de_aceite' | 'campos' | 'concluido'> {
  bloqueado: number;
  /** JSON in a TEXT column, like `session.usage` and `input_request.options`. */
  criterios_de_aceite: string | null;
  /** JSON in a TEXT column too, for the same reason (t168). */
  campos: string | null;
}

/**
 * The row, read back into {@link Job}'s spelling (t229, FR4).
 *
 * `corpo` and `criterios_de_aceite` carry no alias because they carry no new
 * name: `glossario-wire.md` §4.2 has no row for either, and inventing one is
 * exactly what the glossary exists to prevent. Closing that gap is the sixth
 * child's, or a ficha of its own.
 */
const COLUMNS = `
  id, project_id AS projeto_id, execution_id AS execucao_id, title AS titulo,
  corpo, criterios_de_aceite, fields AS campos, tier,
  entry_node_id AS no_entrada_id, current_node_id AS no_atual,
  blocked AS bloqueado, block_reason AS motivo_bloqueio,
  graph_version_id AS grafo_versao_id,
  created_at AS criado_em, updated_at AS atualizado_em
`;

/**
 * Predicate for "this event talks about this job", in SQL.
 *
 * It is the same rule as the timeline (FR9), here as a subquery so it can count
 * without materializing. Pure read: whoever WRITES to `event` is still only
 * `src/db/events.ts`.
 *
 * The three quoted values stay Portuguese on purpose: D20's fourth child renamed
 * identifiers only, and `entity_type`'s vocabulary is pinned by the `CHECK` of
 * migration `0003` (founder decision, 2026-08-17).
 */
const JOB_EVENTS = `
  SELECT COUNT(*) FROM event e
   WHERE (e.entity_type = 'job' AND e.entity_id = CAST(t.id AS TEXT))
      OR (e.entity_type IN ('session','input_request')
          AND json_extract(e.data, '$.job_id') = t.id)
`;

/**
 * "The traveller arrived": the job's node is a final node of ITS version (t152).
 *
 * Three things say no before the graph is even read. A blocked job is never
 * done, whatever node it is standing on — the flag stops the report of an end
 * the same way it stops everything else. A job with no `grafo_versao_id` has no
 * graph to ask, and so has no terminal state to arrive at. And a version id that
 * no longer resolves is treated as no graph at all: `job.graph_version_id`
 * is loose text, not a foreign key (a job created with `'v1'` in hand is an
 * ordinary case here), and inventing a completion out of a version nobody can
 * read would be worse than admitting ignorance.
 *
 * One lookup per job, on purpose: the value is derived on read and never cached,
 * so a job cannot go on reporting a conclusion its version no longer declares.
 * On `listJobs` that is a query per row — correctness first; batching by
 * `graph_version_id` is the follow-up if a board ever grows enough to feel it.
 *
 * @param db Open handle.
 * @param row The job's row, as it is in the table.
 * @returns Whether the job is standing on a final node, unblocked.
 */
function isAtFinalNode(db: Database, row: JobRow): boolean {
  if (asBoolean(row.bloqueado)) return false;
  if (row.grafo_versao_id === null) return false;

  const version = getVersion(db, row.grafo_versao_id);
  if (version === undefined) return false;

  return version.snapshot.final_nodes.includes(row.no_atual);
}

function toJob(db: Database, row: JobRow): Job {
  return {
    ...row,
    bloqueado: asBoolean(row.bloqueado),
    criterios_de_aceite: jsonOrNull<string[]>(row.criterios_de_aceite),
    campos: jsonOrNull<ScalarMap>(row.campos),
    concluido: isAtFinalNode(db, row),
  };
}

/* -------------------------------------------------------------------------- */
/* The row → wire boundary (t226, FR1).                                        */
/*                                                                             */
/* `Job` above stays the INTERNAL projection, spelled like the columns: the     */
/* dispatch path, `intake.ts` and the transition gate all read it. `WireJob` is */
/* what a `/v1` GET returns.                                                   */
/*                                                                             */
/* Only the READ side crosses this boundary. `POST /v1/jobs` and the three      */
/* sub-resources still take their Portuguese body, because it goes straight to  */
/* `validateEvent` — the event surface is D20's second child, and `routes/      */
/* common.ts` explains the asymmetry in full.                                  */
/* -------------------------------------------------------------------------- */

/** A job, as `/v1` publishes it. */
export interface WireJob {
  id: number;
  project_id: number;
  execution_id: number | null;
  title: string;
  body: string | null;
  acceptance_criteria: string[] | null;
  /** The class's own field values; the KEYS inside are the class's, not ours. */
  fields: ScalarMap | null;
  tier: 'trivial' | 'standard' | null;
  entry_node_id: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  graph_version_id: string | null;
  completed: boolean;
  created_at: string;
  updated_at: string;
}

/** Projection to wire: the one place the job's column names meet the API's. */
export function toWireJob(job: Job): WireJob {
  return {
    id: job.id,
    project_id: job.projeto_id,
    execution_id: job.execucao_id,
    title: job.titulo,
    body: job.corpo,
    acceptance_criteria: job.criterios_de_aceite,
    fields: job.campos,
    tier: job.tier,
    entry_node_id: job.no_entrada_id,
    current_node_id: job.no_atual,
    blocked: job.bloqueado,
    block_reason: job.motivo_bloqueio,
    graph_version_id: job.grafo_versao_id,
    completed: job.concluido,
    created_at: job.criado_em,
    updated_at: job.atualizado_em,
  };
}

/** One row of the version × telemetry grouping, as `/v1` publishes it. */
export interface WireMetricByVersion {
  graph_version_id: string | null;
  jobs: number;
  events: number;
}

/** Metric row to wire. */
export function toWireMetricByVersion(row: MetricByVersion): WireMetricByVersion {
  return { graph_version_id: row.grafo_versao_id, jobs: row.trabalhos, events: row.eventos };
}

/** One row of `GET /v1/executions`, as `/v1` publishes it. */
export interface WireExecutionSummary {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
}

/** Execution summary to wire. */
export function toWireExecutionSummary(row: ExecutionSummary): WireExecutionSummary {
  return {
    execution_id: row.execucao_id,
    jobs: row.trabalhos,
    blocked_jobs: row.trabalhos_bloqueados,
    pending_input_requests: row.perguntas_pendentes,
  };
}

function readRow(db: Database, id: number): JobRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM job WHERE id = ?`).get(id) as
    | JobRow
    | undefined;
}

/**
 * Gets a job by its projection.
 *
 * @param db Open handle.
 * @param id Job id.
 * @returns The job, or `null` if it does not exist.
 */
export function getJob(db: Database, id: number): Job | null {
  const row = readRow(db, id);
  return row === undefined ? null : toJob(db, row);
}

/** Body of `POST /v1/jobs`. */
export interface CreateJobInput {
  title?: unknown;
  /** Optional body (t122): manual creation still only needs a title. */
  body?: unknown;
  /** Optional preliminary acceptance criteria (t122). */
  acceptance_criteria?: unknown;
  /** Optional values of the class's declared fields (t168). */
  fields?: unknown;
  /**
   * Optional cost triage (t175), for jobs created outside the intake.
   *
   * Absent means "unclassified", the behaviour every caller written before this
   * field had — which is why it is validated by the event contract and not
   * defaulted here.
   */
  tier?: unknown;
  entry_node_id?: unknown;
  execution_id?: unknown;
  project_id?: unknown;
  graph_version_id?: unknown;
  actor?: unknown;
}

/**
 * Creates the job on the entry node and records `job.created` (FR4).
 *
 * `graph_version_id` goes into the PROJECTION and not into the event payload:
 * the `job.created` schema does not declare it, and a log carrying a field
 * outside its contract is a log no consumer can validate. `body`,
 * `acceptance_criteria`, `fields` and `tier` go into BOTH, because the schema
 * does declare them (t122, t168, t175) — a job that is born with content, or
 * already triaged, has that as part of the fact.
 *
 * A job created by hand with no `graph_version_id` is NOT cross-checked against
 * any class's `custom_fields`: there is no graph to ask, exactly as there is
 * none for `entry_node_id`, which is free text here for the same reason. The
 * gate lives where the graph is known — the transition route.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The created job.
 * @throws {ValidationError} When a required field is missing.
 */
export function createJob(db: Database, input: CreateJobInput): Job {
  // Validate BEFORE opening the transaction: an invalid request must not even
  // consume an id from the sequence (FR3).
  const data = requireValidData('job.created', {
    title: input.title,
    entry_node_id: input.entry_node_id,
    body: input.body,
    acceptance_criteria: input.acceptance_criteria,
    fields: input.fields,
    tier: input.tier,
  });
  const projectId = integerOrDefault('project_id', input.project_id, DEFAULT_PROJECT);
  const executionId = integerOrNull('execution_id', input.execution_id);
  const graphVersionId = textOrNull('graph_version_id', input.graph_version_id);
  const actor = resolveActor(input.actor, API_ACTOR);
  const entryNode = data.entry_node_id as string;
  const criteria = data.acceptance_criteria as string[] | null;
  const fields = data.fields as ScalarMap | null;
  // Already normalized by `requireValidData`: absent came back as an explicit
  // `null`, and anything outside the two values threw before this line.
  const tier = data.tier as Job['tier'];

  const create = db.transaction((): Job => {
    const timestamp = now();
    const result = db
      .prepare(
        `INSERT INTO job (
           project_id, execution_id, title, corpo, criterios_de_aceite, fields, tier,
           entry_node_id, current_node_id, blocked, block_reason, graph_version_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      )
      .run(
        projectId,
        executionId,
        data.title as string,
        data.body as string | null,
        criteria === null ? null : JSON.stringify(criteria),
        fields === null ? null : JSON.stringify(fields),
        tier,
        entryNode,
        entryNode,
        graphVersionId,
        timestamp,
        timestamp,
      );

    const id = Number(result.lastInsertRowid);
    recordEvent(db, {
      type: 'job.created',
      project_id: projectId,
      execution_id: executionId,
      entity: { type: 'job', id },
      actor,
      occurred_at: timestamp,
      data,
    });

    return toJob(db, readRow(db, id) as JobRow);
  });

  return create();
}

/**
 * Records an event about a job that already exists and updates the projection.
 *
 * The template of FR5–FR7: load the row (a 404 becomes `null` without writing
 * anything), validate the payload, and only then open the transaction in which
 * projection and event land together.
 *
 * `announce` runs inside that same transaction, right after the event exists —
 * it is where a fact turns into the reactions the GRAPH declared for it (t169).
 * Inside and not after, so that a rolled-back transition takes its queued hooks
 * down with it; and queuing only, never delivering, so that the write path
 * cannot wait on anybody's socket.
 */
function mutate(
  db: Database,
  id: number,
  type: string,
  actor: unknown,
  defaultActor: Actor,
  build: (row: JobRow) => {
    data: Record<string, unknown>;
    sql: string;
    values: unknown[];
  },
  announce?: (row: JobRow, data: Record<string, unknown>, event: Event) => void,
): Job | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const { data: raw, sql, values } = build(row);
  const data = requireValidData(type, raw);
  const finalActor = resolveActor(actor, defaultActor);

  const apply = db.transaction((): Job => {
    const timestamp = now();
    db.prepare(`UPDATE job SET ${sql}, updated_at = ? WHERE id = ?`).run(
      ...values,
      timestamp,
      id,
    );
    const event = recordEvent(db, {
      type,
      project_id: row.projeto_id,
      execution_id: row.execucao_id,
      entity: { type: 'job', id },
      actor: finalActor,
      occurred_at: timestamp,
      data,
    });
    announce?.(row, data, event);
    return toJob(db, readRow(db, id) as JobRow);
  });

  return apply();
}

/** Body of `POST /v1/jobs/:id/transitions`. */
export interface TransitionInput {
  to_node_id?: unknown;
  actor?: unknown;
}

/**
 * The class's mandatory fields, checked against the node the job is leaving
 * (t168).
 *
 * This is the deterministic gate D9 asks for wherever judgement is not needed:
 * no session, no runner, no template engine — a comparison between what the
 * class declared and what the ticket carries. It reads the job's graph version
 * the same way `isAtFinalNode` above does, and for the same reason: what is
 * demanded is a property of the VERSION the job runs under, not of the class
 * today.
 *
 * Silent in the same three cases `isAtFinalNode` is: no version, a version that
 * no longer resolves, a snapshot that declares nothing. Inventing a demand out
 * of a graph nobody can read would block a job for a reason nobody could act on.
 *
 * @param db Open handle.
 * @param row The job's row, as it is in the table.
 * @throws {ValidationError} Naming every field the node demands and the job
 *   does not carry.
 */
function requireFieldsOfNode(db: Database, row: JobRow): void {
  if (row.grafo_versao_id === null) return;

  const version = getVersion(db, row.grafo_versao_id);
  if (version === undefined) return;

  const missing = missingRequiredFields(
    version.snapshot.custom_fields,
    row.no_atual,
    jsonOrNull<ScalarMap>(row.campos),
  );
  if (missing.length === 0) return;

  throw new ValidationError(
    missing.map(
      (name) =>
        `campos.${name} is required to leave node "${row.no_atual}" (declared in custom_fields of the job's graph version)`,
    ),
  );
}

/**
 * Moves the job across nodes and records `job.transitioned` (FR5).
 *
 * `from_node_id` is `null` on the FIRST transition — the job leaving the entry node
 * for the first time — and the current node from then on. What answers "first?"
 * is the log, not the projection: a job can come back to the entry node later,
 * and then `no_atual == no_entrada_id` no longer distinguishes anything.
 *
 * This is also the only place a job's position in the graph changes, mirrored by
 * nothing — which is what makes it the one place a gate over the class's
 * mandatory fields can stand (t168). The check runs inside `build`, so a job
 * that does not exist is still a 404 and a refusal writes nothing: no projection
 * row, no event.
 *
 * It is also where a `node_entered` hook fires (t169): the node the job ARRIVED
 * at is the match key, which is why a hook on `initial_node` structurally never
 * fires — that placement is a `job.created`, never a transition. The hook is
 * enqueued from `announce`, downstream of the t168 gate: a transition the gate
 * refuses never happened, so it fires nothing.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @param options The injected clock; default: the real clock. It is forwarded to
 *   the enqueue, so a test that freezes the dispatcher's clock stamps the
 *   delivery with the same instant the due-query reads.
 * @returns The updated job, or `null` if it does not exist.
 * @throws {ValidationError} When the node being left demands a field the job
 *   does not carry.
 */
export function transitionJob(
  db: Database,
  id: number,
  input: TransitionInput,
  options: ClockOptions = {},
): Job | null {
  const alreadyWalked =
    db
      .prepare(
        `SELECT 1 FROM event
          WHERE type = 'job.transitioned' AND entity_type = 'job' AND entity_id = ?
          LIMIT 1`,
      )
      .get(String(id)) !== undefined;

  return mutate(
    db,
    id,
    'job.transitioned',
    input.actor,
    API_ACTOR,
    (row) => {
      requireFieldsOfNode(db, row);
      return {
        data: {
          from_node_id: alreadyWalked ? row.no_atual : null,
          to_node_id: input.to_node_id,
        },
        sql: 'current_node_id = ?',
        values: [input.to_node_id],
      };
    },
    // The node comes from the VALIDATED payload, so what the hook matches on is
    // the same string the log records — never the raw request body.
    (row, data, event) => {
      enqueueHookDeliveries(
        db,
        {
          trigger: 'node_entered',
          no_id: data.to_node_id as string,
          trabalho_id: id,
          projeto_id: row.projeto_id,
          execucao_id: row.execucao_id,
          grafo_versao_id: row.grafo_versao_id,
          evento_id: event.id,
        },
        options,
      );
    },
  );
}

/** Body of `POST /v1/jobs/:id/blocks`. */
export interface BlockInput {
  reason?: unknown;
  actor?: unknown;
}

/**
 * Raises the blocked flag and records `job.blocked` (FR6).
 *
 * Blocking is a flag fact, not a movement fact: the job does not leave the node.
 * That is exactly why a `node_blocked` hook matches on `no_atual` (t169): the
 * node the job is standing on when the flag goes up is the node it blocked on.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @param options The injected clock; default: the real clock. Forwarded to the
 *   enqueue, for the same reason `transitionJob` forwards it.
 * @returns The updated job, or `null` if it does not exist.
 */
export function blockJob(
  db: Database,
  id: number,
  input: BlockInput,
  options: ClockOptions = {},
): Job | null {
  return mutate(
    db,
    id,
    'job.blocked',
    input.actor,
    API_ACTOR,
    () => ({
      data: { reason: input.reason },
      sql: 'blocked = ?, block_reason = ?',
      values: [asInteger(true), input.reason],
    }),
    (row, _data, event) => {
      enqueueHookDeliveries(
        db,
        {
          trigger: 'node_blocked',
          no_id: row.no_atual,
          trabalho_id: id,
          projeto_id: row.projeto_id,
          execucao_id: row.execucao_id,
          grafo_versao_id: row.grafo_versao_id,
          evento_id: event.id,
        },
        options,
      );
    },
  );
}

/** Body of `POST /v1/jobs/:id/unblocks`. */
export interface UnblockInput {
  actor?: unknown;
}

/**
 * Lowers the flag and records `job.unblocked` (FR6).
 *
 * The event has no payload: the fact is the fall of the flag itself.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @returns The updated job, or `null` if it does not exist.
 */
export function unblockJob(db: Database, id: number, input: UnblockInput): Job | null {
  return mutate(db, id, 'job.unblocked', input.actor, API_ACTOR, () => ({
    data: {},
    sql: 'blocked = ?, block_reason = NULL',
    values: [asInteger(false)],
  }));
}

/** Body of `PATCH /v1/jobs/:id`. */
export interface AmendInput {
  title?: unknown;
  /** New values for the class's declared fields (t168). */
  fields?: unknown;
  actor?: unknown;
}

/**
 * Amends the job's content and records `job.amended` (FR7).
 *
 * The event carries the NAMES of the changed fields and never the new content:
 * this is an audit record, not a version history. Whoever wants the new text
 * reads the job.
 *
 * That is also why the title is validated HERE and not by `requireValidData`:
 * the payload is the hardcoded `{changed_fields: ['title']}`, which is
 * well-formed whatever the body carries, so the type's contract has nothing to
 * say about the one value actually being written (t157, FR2). Without this
 * check the `UPDATE` bound `undefined` and the driver threw — a 500 for what is
 * plainly a malformed request.
 *
 * The check lives inside `build`, which `mutate` only reaches after loading the
 * row: a job that does not exist is still a 404, and the order between "does it
 * exist" and "is the body any good" does not change.
 *
 * Since t168 there are TWO amendable fields, and the rule stayed the one t157
 * wrote: what is written is what has to be validated. A body carrying neither is
 * unusable — not a no-op — because an amendment that changes nothing would still
 * record a `job.amended` claiming something was touched.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param input Request body.
 * @returns The updated job, or `null` if it does not exist.
 * @throws {ValidationError} When neither field is usable.
 */
export function amendJob(db: Database, id: number, input: AmendInput): Job | null {
  return mutate(db, id, 'job.amended', input.actor, API_ACTOR, () => {
    const changed: string[] = [];
    const assignments: string[] = [];
    const values: unknown[] = [];

    if (input.title !== undefined && input.title !== null) {
      if (typeof input.title !== 'string' || input.title.length === 0) {
        throw new ValidationError(['title has to be a non-empty string']);
      }
      changed.push('title');
      assignments.push('title = ?');
      values.push(input.title);
    }

    if (input.fields !== undefined && input.fields !== null) {
      if (!isScalarMap(input.fields)) {
        throw new ValidationError([
          'fields has to be an object of string, number or boolean values',
        ]);
      }
      // Replaced whole, never merged: without that, a field somebody filled by
      // mistake could never be taken back out, and "send me the fields you
      // want" is a simpler contract than a patch language over a map — the same
      // reasoning `amendDraft` wrote for the intake's item list.
      changed.push('fields');
      assignments.push('fields = ?');
      values.push(JSON.stringify(input.fields));
    }

    if (changed.length === 0) {
      throw new ValidationError([
        'at least one of title or fields has to be present, and usable',
      ]);
    }

    return { data: { changed_fields: changed }, sql: assignments.join(', '), values };
  });
}

/**
 * The current board: one job per row (FR8).
 *
 * @param db Open handle.
 * @param filter Optional slice by execution.
 * @returns Jobs in id order.
 */
export function listJobs(
  db: Database,
  filter: { execucao_id?: number } = {},
): Job[] {
  const rows = (
    filter.execucao_id === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM job ORDER BY id`).all()
      : db
          .prepare(`SELECT ${COLUMNS} FROM job WHERE execution_id = ? ORDER BY id`)
          .all(filter.execucao_id)
  ) as JobRow[];
  return rows.map((row) => toJob(db, row));
}

/**
 * The job's timeline (FR9).
 *
 * @param db Open handle.
 * @param id Job id.
 * @returns Events in id order, or `null` if the job does not exist.
 */
export function jobTimeline(db: Database, id: number): Event[] | null {
  if (readRow(db, id) === undefined) return null;
  return listEvents(db, { trabalho_id: id });
}

/**
 * Graph version × telemetry, for one execution (FR17).
 *
 * It is the join the topographer will need after the PoC: without counting jobs
 * AND events PER version, "v2 is better than v1" is no more than an opinion
 * (D15). Jobs with no declared version fall into a `null` group instead of
 * disappearing — a report that hides what it cannot classify lies about the
 * total.
 *
 * @param db Open handle.
 * @param executionId Execution to group.
 * @returns One row per version, named versions first and `null` last.
 */
export function metricsByVersion(db: Database, executionId: number): MetricByVersion[] {
  const rows = db
    .prepare(
      `SELECT t.graph_version_id          AS grafo_versao_id,
              COUNT(*)                    AS trabalhos,
              COALESCE(SUM((${JOB_EVENTS})), 0) AS eventos
         FROM job t
        WHERE t.execution_id = ?
        GROUP BY t.graph_version_id`,
    )
    .all(executionId) as MetricByVersion[];

  return rows.sort((a, b) => {
    if (a.grafo_versao_id === null) return 1;
    if (b.grafo_versao_id === null) return -1;
    return a.grafo_versao_id.localeCompare(b.grafo_versao_id);
  });
}

/**
 * The executions that exist, one row per round (t107, FR1).
 *
 * There is no "execution" entity in this v1 — `execution_id` is an opaque
 * grouper, and this list is an AGGREGATION over `job`, not a table. It
 * exists because without it the screen has no way to DISCOVER which rounds
 * exist: until here one could only query an execution already knowing its id,
 * which serves whoever already knows and nobody else. D11 calls that a bug of
 * the API, and this is where it closes.
 *
 * The three counts are the ones that answer "where to look first": size of the
 * round, how much of it is stuck, and how many people are being waited on.
 * `perguntas_pendentes` comes from a correlated subquery with `IS` (equality
 * that sees `NULL`), so that the group without an execution counts its own
 * input requests instead of silently zeroing.
 *
 * @param db Open handle.
 * @returns One row per execution, ascending, with the `null` group last — the
 *   same convention as `metricsByVersion`.
 */
export function listExecutions(db: Database): ExecutionSummary[] {
  const rows = db
    .prepare(
      `SELECT t.execution_id           AS execucao_id,
              COUNT(*)                 AS trabalhos,
              COALESCE(SUM(t.blocked), 0) AS trabalhos_bloqueados,
              (SELECT COUNT(*) FROM input_request p
                WHERE p.status = 'pending' AND p.execution_id IS t.execution_id)
                                       AS perguntas_pendentes
         FROM job t
        GROUP BY t.execution_id`,
    )
    .all() as ExecutionSummary[];

  return rows.sort((a, b) => {
    if (a.execucao_id === null) return 1;
    if (b.execucao_id === null) return -1;
    return a.execucao_id - b.execucao_id;
  });
}
