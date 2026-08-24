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
 * The TABLE and its columns are English since D20's fourth child (t229), the
 * values they store since its fifth (t235), and the event-type strings since its
 * second (t227). {@link Job} below is English too, and is the object `/v1`
 * publishes: t286 deleted the alias-and-translate layer that used to sit between
 * them, because it renamed nothing a client could see while hiding the column's
 * real name from everything above it.
 *
 * Two columns did not come along, and could not: `corpo` and
 * `criterios_de_aceite` have no row in `docs/spec/glossario-wire.md` §4.2, so
 * renaming them is a migration and a glossary entry rather than a rename. They
 * keep their spelling on {@link JobRow}, and {@link toJob} is the one place that
 * translates — two fields in one direction, where the alias used to do fourteen
 * in two.
 */

import type { Database } from '../db/connection.ts';
import { listEvents, recordEvent } from '../db/events.ts';
import {
  ValidationError,
  requireValidData,
  type Actor,
  type Event,
} from '../db/event-validation.ts';
import type { ProjectedJob } from '../domain/context.ts';
import type { ContractProblem, ContractsState } from '../domain/graph.ts';
import {
  isScalarMap,
  missingRequiredFields,
  type ScalarMap,
} from '../domain/custom-fields.ts';
import { getVersion, getVersionSummary } from './graphs.ts';
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
  project_id: number;
  execution_id: number | null;
  title: string;
  /**
   * Body of the job; `null` when it was born with a title and nothing else (t122).
   *
   * One of the two fields whose COLUMN is still Portuguese (`corpo`), so this
   * name is built by {@link toJob} instead of read straight off the row.
   */
  body: string | null;
  /**
   * Preliminary acceptance criteria; `null` when none was declared (t122).
   *
   * `null` is not `[]`: the node that refines has to be able to tell "nobody
   * wrote any yet" from "it was declared that there are none".
   *
   * The other field with a Portuguese column behind it (`criterios_de_aceite`).
   */
  acceptance_criteria: string[] | null;
  /**
   * Values of the fields the CLASS declares in its graph (t168); `null` when the
   * job carries none.
   *
   * The keys are the class's, not this package's: what may appear here is
   * `custom_fields` of the job's graph version, and that is also what the
   * transition gate reads to decide whether the job may leave a node.
   */
  fields: ScalarMap | null;
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
  entry_node_id: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  /** Graph version the job runs under. Loose: `graph_version` belongs to t101 (D15). */
  graph_version_id: string | null;
  /**
   * The job arrived: its current node is a final node of its graph version
   * (t152).
   *
   * Derived at read time, never stored — see `isAtFinalNode`. It is the only
   * terminal signal this system has: the log has no `job.completed` event,
   * and "nothing is open right now" is a state a job one event old already
   * satisfies.
   */
  completed: boolean;
  created_at: string;
  updated_at: string;
}

/** One row of the version × telemetry grouping (FR17). */
export interface MetricByVersion {
  graph_version_id: string | null;
  jobs: number;
  events: number;
}

/** One row of `GET /v1/executions` — the summary of a round (t107, FR1). */
export interface ExecutionSummary {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
  /**
   * When the control plane declared this round over; `null` while it has not
   * (t245, D21).
   *
   * Derived at read time from the `execution.finished` event and never stored,
   * the same posture as `Job.completed` — a projection that cached it could go
   * on reporting an end the log does not carry.
   *
   * It was already English while its three neighbours were not, because it has
   * no column behind it and no caller from before the glossary; t286 brought the
   * other three across, so the row is now one vocabulary throughout.
   */
  finished_at: string | null;
}

interface JobRow
  extends Omit<Job, 'blocked' | 'body' | 'acceptance_criteria' | 'fields' | 'completed'> {
  blocked: number;
  /** The column `Job.body` is built from; see {@link COLUMNS}. */
  corpo: string | null;
  /**
   * The column `Job.acceptance_criteria` is built from — JSON in a TEXT column,
   * like `session.usage` and `input_request.options`.
   */
  criterios_de_aceite: string | null;
  /** JSON in a TEXT column too, for the same reason (t168). */
  fields: string | null;
}

/**
 * The columns {@link JobRow} is made of — every one under its own name (t286).
 *
 * There is nothing left to alias: {@link Job} spells each field the way the
 * column does, so the list IS the column list. The two names the glossary never
 * mapped — `corpo` and `criterios_de_aceite` — are not aliased either;
 * {@link toJob} builds `body` and `acceptance_criteria` off them explicitly,
 * because an alias here would invent a schema name `glossario-wire.md` §4.2 does
 * not carry, which is the one thing the glossary exists to prevent. Closing that
 * gap belongs to a migration, not to this file.
 */
const COLUMNS = `
  id, project_id, execution_id, title,
  corpo, criterios_de_aceite, fields, tier,
  entry_node_id, current_node_id,
  blocked, block_reason,
  graph_version_id,
  created_at, updated_at
`;

/**
 * Predicate for "this event talks about this job", in SQL.
 *
 * It is the same rule as the timeline (FR9), here as a subquery so it can count
 * without materializing. Pure read: whoever WRITES to `event` is still only
 * `src/db/events.ts`.
 *
 * The three quoted values are the English the column really holds: D20's fourth
 * child (t229) renamed `entity_type` and left its vocabulary alone, and its fifth
 * (t235) rewrote migration `0003` so the `CHECK` itself spells
 * `('job','session','input_request','lease','graph_version')`.
 */
const JOB_EVENTS = `
  SELECT COUNT(*) FROM event e
   WHERE (e.entity_type = 'job' AND e.entity_id = CAST(t.id AS TEXT))
      OR (e.entity_type IN ('session','input_request')
          AND json_extract(e.data, '$.job_id') = t.id)
`;

/**
 * "When this round was declared over", in SQL (t245, FR6).
 *
 * A scalar subquery over the log and not a column: `finished_at` is derived on
 * read like `Job.completed`, so nothing can go on reporting an end the log does
 * not carry. `LIMIT 1` after `ORDER BY e.id` is belt and braces — the writer
 * guards against a second announcement — and it costs nothing to be honest
 * about which one would win if the guard ever failed: the FIRST, because the
 * end of a round happened once.
 *
 * `CAST` because `event.entity_id` is TEXT (one log for six entities, and one
 * of them has a hash for an id — D15). A `NULL` subject casts to `NULL`, which
 * matches nothing: the group of jobs with no execution has no end to report.
 *
 * The cast is for a COLUMN, and a bound parameter must not lean on it: the
 * driver hands a JS number to SQLite as a float, so `CAST(@id AS TEXT)` of
 * `2450` is the string `'2450.0'` and matches nothing at all. Whoever binds
 * instead of correlating binds `String(id)` — which is what the column holds
 * anyway — and the cast around it is then a no-op.
 *
 * @param subject SQL expression naming the execution id — a column of the outer
 *   query, or a bound parameter. Never anything a request controls.
 * @returns The subquery, parenthesized and ready to be aliased.
 */
function finishedAtOf(subject: string): string {
  return `(SELECT e.occurred_at
             FROM event e
            WHERE e.type = 'execution.finished'
              AND e.entity_type = 'execution'
              AND e.entity_id = CAST(${subject} AS TEXT)
            ORDER BY e.id
            LIMIT 1)`;
}

/**
 * Whether a session of this job, on this node, closed with a report that stood.
 *
 * `status = 'completed'` AND `output IS NOT NULL` is one condition and not two:
 * `finishSession` writes the reported object only when it validated against the
 * `output` schema of the skill the node pins, and stores a NULL for a report
 * the schema refused — with the reason in the event, never in the column
 * (`session.ts`, t253). So this single `SELECT` asks exactly what D9 asks: did
 * the pinned capability run and produce what its contract declares?
 *
 * @param db Open handle.
 * @param jobId The traveller.
 * @param nodeId The node it is standing on.
 * @returns Whether that node has a conforming finish on its account.
 */
function hasConformingFinish(db: Database, jobId: number, nodeId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM session
          WHERE job_id = ? AND node_id = ? AND status = 'completed' AND output IS NOT NULL
          LIMIT 1`,
      )
      .get(jobId, nodeId) !== undefined
  );
}

/**
 * "The traveller arrived": the job's node is a final node of ITS version, and
 * that node has nothing left to run (t152, t262).
 *
 * Three things say no before the graph is even read. A blocked job is never
 * done, whatever node it is standing on — the flag stops the report of an end
 * the same way it stops everything else. A job with no `graph_version_id` has no
 * graph to ask, and so has no terminal state to arrive at. And a version id that
 * no longer resolves is treated as no graph at all: `job.graph_version_id`
 * is loose text, not a foreign key (a job created with `'v1'` in hand is an
 * ordinary case here), and inventing a completion out of a version nobody can
 * read would be worse than admitting ignorance.
 *
 * ## Arriving is not finishing, when the node pins a skill (t262)
 *
 * Until t262 the last line was the whole answer, and it read "final" as "there
 * is nothing left to do". Those are different claims, and the difference is a
 * whole step of the graph: `registro-monitoramento` of the bets bundle and
 * `implantar` of the software one are final nodes that pin a real `work` skill
 * — D14's own "registro e monitoramento" step — and a job declared done on
 * ARRIVAL never gets a session on them, because the controller's candidate list
 * drops a `completed` job before the runner sees it
 * (`packages/runner/src/controller/cliente-controle.ts`). t198's first real
 * crossing found exactly that, and found it as silence: no failure, no event,
 * just a skill that never ran.
 *
 * So a final node that PINS a skill is done when that skill reported — see
 * {@link hasConformingFinish}. A final node that pins nothing is done on
 * arrival, exactly as before. The rule is keyed on `skill_ref` and never on
 * `node_type`: `docs/spec/grafo.md` §2 says a portão is "nó como qualquer
 * outro", and the minimal example graph's own final node is a gate with a pin.
 *
 * The no-pin branch is defensive, not a supported document shape:
 * `schema/grafo.schema.json` makes `skill_ref` mandatory on every node and
 * `node_with_contract` guards it at soundness, so nothing registered through
 * `POST /v1/graphs` reaches it. It exists for the same reason `resolveNode` and
 * `resolveOutputSchema` already treat the pin as optional on the TS side — a
 * malformed or pre-existing snapshot degrades instead of throwing. A node the
 * snapshot no longer carries at all reads the same way: there is no pin to
 * demand a session for.
 *
 * One lookup per job, on purpose: the value is derived on read and never cached,
 * so a job cannot go on reporting a conclusion its version no longer declares.
 * On `listJobs` that is a query per row — correctness first; batching by
 * `graph_version_id` is the follow-up if a board ever grows enough to feel it.
 *
 * @param db Open handle.
 * @param row The job's row, as it is in the table.
 * @returns Whether the job is standing on a final node, unblocked, with that
 *   node's own work already reported.
 */
function isAtFinalNode(db: Database, row: JobRow): boolean {
  if (asBoolean(row.blocked)) return false;
  if (row.graph_version_id === null) return false;

  const version = getVersion(db, row.graph_version_id);
  if (version === undefined) return false;

  if (!version.snapshot.final_nodes.includes(row.current_node_id)) return false;

  const node = version.snapshot.nodes?.find((candidate) => candidate.id === row.current_node_id);
  const pin = node === undefined ? undefined : node.skill_ref;
  if (pin === undefined || pin === null) return true;

  return hasConformingFinish(db, row.id, row.current_node_id);
}

/**
 * The row as {@link Job} publishes it.
 *
 * The two residual columns are destructured OUT before the spread, and that is
 * the whole care of this function: a bare `{...row}` would carry `corpo` and
 * `criterios_de_aceite` onto the object beside the `body` and
 * `acceptance_criteria` built from them, and an extra key on a projection fails
 * nothing — it simply rides out to `/v1` under a name no client was ever told
 * about. `test/no-leaked-row-keys.test.ts` is the gate that says so.
 *
 * @param db Open handle; `completed` is derived on read and needs the graph.
 * @param row The job's row, as it is in the table.
 * @returns The projection.
 */
function toJob(db: Database, row: JobRow): Job {
  const { corpo: body, criterios_de_aceite: criteria, ...rest } = row;
  return {
    ...rest,
    body,
    acceptance_criteria: jsonOrNull<string[]>(criteria),
    blocked: asBoolean(row.blocked),
    fields: jsonOrNull<ScalarMap>(row.fields),
    completed: isAtFinalNode(db, row),
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

/** What the node input projection needs off the job itself (t253, FR7). */
export interface JobContextSeed {
  /** The ticket, as `input.job` publishes it plus the class's own fields. */
  job: ProjectedJob;
  /** The version whose snapshot carries `project` and the nodes' `produces`. */
  graph_version_id: string | null;
  /** The round the job belongs to, which narrows the sessions that count. */
  execution_id: number | null;
  /**
   * When the job was born (t270).
   *
   * Carried so that the route can stay total without a second read: a job that
   * never transitioned entered its node the instant it was created, and
   * {@link jobTraversal} says the same thing from the other side.
   */
  created_at: string;
}

/**
 * The job's own contribution to the projection, in one read (t253, FR7).
 *
 * A read of its own rather than `getJob` because the two answer different
 * questions. `getJob` builds the whole projection, `completed` included, and
 * that is a fact about where the traveller is standing — which a skill's `input`
 * has no business carrying. What the projection seeds with is the ticket: what
 * it is called, what was asked for, the values of the fields the class declared,
 * and the two ids the caller needs to go read the rest.
 *
 * `type` is deliberately not filled: the `job` table has no such column, and
 * `domain/context.ts` reads an absent one as absent rather than as `null`.
 *
 * @param db Open handle.
 * @param id Job id.
 * @returns The seed, or `null` if the job does not exist.
 */
export function jobContextSeed(db: Database, id: number): JobContextSeed | null {
  const row = readRow(db, id);
  if (row === undefined) return null;
  return {
    job: {
      id: row.id,
      title: row.title,
      body: row.corpo,
      fields: jsonOrNull<ScalarMap>(row.fields),
    },
    graph_version_id: row.graph_version_id,
    execution_id: row.execution_id,
    created_at: row.created_at,
  };
}

/**
 * The job's own walk through the graph, derived from the log (t270).
 *
 * `registrar-travessia` — the final node of `bets-assimetricas` — asks which
 * nodes this crossing executed and when it arrived where it stands, and until
 * this ficha nothing answered: `buildNodeInput` assembles the ticket, the
 * class's config, the `produces` buckets and the answered escalations, and the
 * traversal is none of those. It is a fact about `job.transitioned`, and the
 * control plane is the only thing that has that log (D1) — which is why the
 * second real bets crossing was unblocked by a person typing the two values
 * into `fields` by hand (`notas/2026-08-17-segunda-execucao-bets.md`, gap 5).
 *
 * ## The one rule worth stating: the LAST transition is not a visit
 *
 * A transition records where the job WENT, so the `to_node_id` of the last one
 * is the node the job is standing on right now — and a node about to run has
 * not executed. Counting it would make `red_team_executado` answer `true` for a
 * crossing that had merely arrived at `red-team` and reported nothing, which is
 * the exact self-report the manifest's own check exists to refuse.
 *
 * So the walk is the entry node plus every intermediate arrival, and zero
 * transitions is an empty walk: a job standing on the node it was born on has
 * executed nothing at all.
 *
 * The read is `entity_type = 'job'` and `entity_id = String(id)` — the job's own
 * events and not the session's, and the id bound as TEXT because that is what
 * the column holds (one log for five entities, one of them keyed by a hash).
 *
 * @param db Open handle.
 * @param id Job id.
 * @returns The walk, or `null` if the job does not exist.
 */
export function jobTraversal(
  db: Database,
  id: number,
): { nodes_visited: string[]; entered_at: string } | null {
  const row = readRow(db, id);
  if (row === undefined) return null;

  const walked = db
    .prepare(
      `SELECT occurred_at, data FROM event
        WHERE type = 'job.transitioned' AND entity_type = 'job' AND entity_id = ?
        ORDER BY id`,
    )
    .all(String(id)) as Array<{ occurred_at: string; data: string }>;

  if (walked.length === 0) {
    return { nodes_visited: [], entered_at: row.created_at };
  }

  // Every arrival except the last one, which is where the job is standing.
  const arrivals = walked.slice(0, -1).map((event) => {
    const data = JSON.parse(event.data) as { to_node_id?: unknown };
    return typeof data.to_node_id === 'string' ? data.to_node_id : '';
  });

  return {
    nodes_visited: [row.entry_node_id, ...arrivals.filter((node) => node !== '')],
    entered_at: walked[walked.length - 1].occurred_at,
  };
}

/**
 * The end of a round, recorded once and only by the control plane (t245, D21).
 *
 * "Finished" is three conditions and never two: the execution has AT LEAST ONE
 * job, every one of them arrived (`Job.completed`, which is `isAtFinalNode` and
 * therefore also refuses a blocked job), and no `lease` row with `status =
 * 'active'` still holds any of them. Zero jobs is not vacuously finished — an
 * execution nobody put work into is not a round that ended.
 *
 * It is written in the SAME transaction as the mutation that made the condition
 * true, and guarded against a second write exactly like `transitionJob` guards
 * `alreadyWalked`: the log is asked whether the fact is already in it. Once,
 * ever — a job that leaves the final node and comes back does not produce a
 * second announcement, because "the round ended" is not a state that toggles,
 * it is a fact that happened.
 *
 * The actor is always `API_ACTOR`. This is the control plane asserting
 * something about ITSELF (D1, D21) — the observer that reads it (D21's third
 * child) needs to know the assertion came from the only writer there is, not
 * from whoever happened to drive the last job.
 *
 * Exported since t262, for the third moment a job can become `completed`: a
 * session finishing on a final node it will never transition away from, because
 * a final node has no outgoing edge. `finishSession` calls it from inside its
 * own transaction, exactly as the two callers below do — without that, every
 * ordinary run of both factory bundles would report `finished_at: null` forever
 * (t245, D21), which is a regression and not a gap.
 *
 * ## The fourth moment, which is not a job moving at all (t264)
 *
 * Until t264 this ran on the JOB path only — the two callers here, and
 * `finishSession` — and that left the commonest real ending unannounced. The
 * runner releases the lease strictly AFTER reporting the terminal transition
 * (`packages/runner/src/controller/controller.ts`, the `finally` around
 * `#dispatch`), so at the instant the last job of a round arrives, its own lease
 * is typically still `active` and the third guard below refuses — correctly.
 * Nothing looked again when that lease cleared a moment later, so the round
 * stayed open until some job of it happened to move again. t198's first real
 * crossing measured exactly that
 * (`notas/2026-08-17-primeira-execucao-bets.md`, gap 3).
 *
 * The fix is the fourth caller, and it is `routes/leases.ts` and not
 * `repositories/leases.ts`: that repository treats `job_id` as an opaque integer
 * on purpose and the taxonomy has no `lease.released` to hang an observer off,
 * while the ROUTE already holds both the lease and the job. It calls this same
 * function, with these same guards, in a transaction of its own. A lease that
 * clears by EXPIRING instead is still uncovered — a bulk `UPDATE` over many
 * leases is a differently shaped problem, and it is not what t198 hit.
 *
 * ## A job blocked forever keeps its round open forever, by design
 *
 * `isAtFinalNode` answers `false` for a blocked job whatever node it is standing
 * on, so `jobs.every(job => job.completed)` cannot pass while any job of the
 * round is blocked, and this function stays a no-op for as long as that lasts.
 * That is the intended reading: a round waiting on a human has not ended, and
 * announcing otherwise would put a fact in the append-only log that a later
 * unblock could not take back.
 *
 * It is not silent either. `blocked_jobs` on `GET /v1/executions` and on
 * `GET /v1/executions/:id` counts exactly those jobs, and `pending_input_requests`
 * beside it names how many people are being waited on — which is the report a
 * person reads to tell "this round is still working" from "this round is stuck".
 *
 * @param db Open handle, inside the mutation's own transaction.
 * @param executionId Round the mutated job belongs to; `null` is a no-op —
 *   there is no round to declare finished.
 * @param projectId Project of the mutated job, which is the event's own.
 * @param occurredAt The instant of the mutation that triggered the check, so
 *   the fact is stamped with the moment it became true.
 */
export function announceFinishedExecution(
  db: Database,
  executionId: number | null,
  projectId: number,
  occurredAt: string,
): void {
  if (executionId === null) return;

  const jobs = listJobs(db, { execution_id: executionId });
  if (jobs.length === 0) return;
  if (!jobs.every((job) => job.completed)) return;

  // One named parameter per id, never interpolation — the same rule
  // `db/events.ts` writes for its type filter.
  const held =
    db
      .prepare(
        `SELECT 1 FROM lease
          WHERE status = 'active'
            AND job_id IN (${jobs.map((_, index) => `@job_${index}`).join(', ')})
          LIMIT 1`,
      )
      .get(Object.fromEntries(jobs.map((job, index) => [`job_${index}`, job.id]))) !== undefined;
  if (held) return;

  const alreadyAnnounced =
    db
      .prepare(
        `SELECT 1 FROM event
          WHERE type = 'execution.finished'
            AND entity_type = 'execution'
            AND entity_id = ?
          LIMIT 1`,
      )
      .get(String(executionId)) !== undefined;
  if (alreadyAnnounced) return;

  recordEvent(db, {
    type: 'execution.finished',
    project_id: projectId,
    execution_id: executionId,
    entity: { type: 'execution', id: executionId },
    actor: API_ACTOR,
    occurred_at: occurredAt,
    data: {},
  });
}

/**
 * The version this job would run against is not in a state that may run (t283).
 *
 * Not a `ValidationError`: the request is well formed and every field of it is
 * legal. What refuses it is the STATE of a resource it references — the same
 * reading behind `class_already_registered` and `graph_without_current_version`
 * in `routes/graphs.ts`, and the reason the route answers `409` and not `400`.
 *
 * The two codes are one distinction and it matters to whoever has to fix the
 * call: `graph_version_unchecked` says the check never ran, and the way out is
 * registering the manifests the report names — after which the version moves on
 * its own. `graph_version_contracts_failed` says it ran and refused, and the way
 * out is a new version of the graph.
 */
export class GraphVersionNotReadyError extends Error {
  /** Stable, machine-readable code — it is what the route publishes as `error`. */
  readonly code: 'graph_version_unchecked' | 'graph_version_contracts_failed';
  /** The version that refused the job. */
  readonly graphVersionId: string;
  /** Its stored state and report, as context for the refusal. */
  readonly contracts: { state: ContractsState; problems: ContractProblem[] };

  constructor(
    graphVersionId: string,
    contracts: { state: ContractsState; problems: ContractProblem[] },
  ) {
    super(
      contracts.state === 'unchecked'
        ? `graph version ${graphVersionId} was never contract-checked: its skill pins do not all ` +
            'resolve in the registry, so no job may run against it (register the missing ' +
            'manifests and the version is re-checked on its own)'
        : `graph version ${graphVersionId} failed the contract check: a node requires input no ` +
            'path into it supplies, so no job may run against it',
    );
    this.name = 'GraphVersionNotReadyError';
    this.code =
      contracts.state === 'unchecked'
        ? 'graph_version_unchecked'
        : 'graph_version_contracts_failed';
    this.graphVersionId = graphVersionId;
    this.contracts = contracts;
  }
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
 * ## The one thing a named version is now checked for (t283)
 *
 * A `graph_version_id` that RESOLVES has to be `checked`. This is the single
 * enforcement point of the ficha, and it is here rather than on the route
 * because this function is the only writer of a job row: intake, the CLI and
 * whatever comes next inherit the gate by calling it.
 *
 * What is unchanged is everything the paragraph above says. No
 * `graph_version_id` at all, or one that resolves to nothing, is still the
 * ordinary loose-text case — a job may cite a version this database never saw,
 * and inventing a refusal for it would break the manual and imported flows for
 * a fact the control plane cannot check anyway.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The created job.
 * @throws {ValidationError} When a required field is missing.
 * @throws {GraphVersionNotReadyError} When the named version resolves and its
 *   contracts are not `checked` (t283).
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

  // Before the transaction, like the validation above it: a job refused for the
  // state of its version must not consume an id from the sequence either.
  if (graphVersionId !== null) {
    // The SUMMARY and not `getVersion`: what the gate reads is a status column,
    // and the whole-version read would parse a graph document — tens of
    // kilobytes for the factory bundles — on every job created.
    const version = getVersionSummary(db, graphVersionId);
    if (version !== undefined && version.contracts_state !== 'checked') {
      throw new GraphVersionNotReadyError(graphVersionId, {
        state: version.contracts_state,
        problems: version.contracts_report,
      });
    }
  }

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

    // A job can be BORN standing on a final node — a one-node graph, or a class
    // whose `entry_node_id` is terminal — and then this creation is the fact
    // that ends the round. Without the check here that round would stay
    // unfinished forever, because nothing else would ever look at it again.
    announceFinishedExecution(db, executionId, projectId, timestamp);

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
      project_id: row.project_id,
      execution_id: row.execution_id,
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
  if (row.graph_version_id === null) return;

  const version = getVersion(db, row.graph_version_id);
  if (version === undefined) return;

  const missing = missingRequiredFields(
    version.snapshot.custom_fields,
    row.current_node_id,
    jsonOrNull<ScalarMap>(row.fields),
  );
  if (missing.length === 0) return;

  throw new ValidationError(
    missing.map(
      (name) =>
        `fields.${name} is required to leave node "${row.current_node_id}" (declared in custom_fields of the job's graph version)`,
    ),
  );
}

/**
 * Moves the job across nodes and records `job.transitioned` (FR5).
 *
 * `from_node_id` is `null` on the FIRST transition — the job leaving the entry node
 * for the first time — and the current node from then on. What answers "first?"
 * is the log, not the projection: a job can come back to the entry node later,
 * and then `current_node_id == entry_node_id` no longer distinguishes anything.
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
          from_node_id: alreadyWalked ? row.current_node_id : null,
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
          projeto_id: row.project_id,
          execucao_id: row.execution_id,
          grafo_versao_id: row.graph_version_id,
          evento_id: event.id,
        },
        options,
      );

      // This is the transition that may have landed the LAST traveller of the
      // round on a final node (t245). It reads the projection the `UPDATE`
      // above already wrote, inside the same transaction, so a rolled-back
      // transition takes the declaration down with it.
      announceFinishedExecution(db, row.execution_id, row.project_id, event.occurred_at);
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
 * That is exactly why a `node_blocked` hook matches on `current_node_id` (t169): the
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
          no_id: row.current_node_id,
          trabalho_id: id,
          projeto_id: row.project_id,
          execucao_id: row.execution_id,
          grafo_versao_id: row.graph_version_id,
          evento_id: event.id,
        },
        options,
      );
    },
  );
}

/**
 * How many failed sessions in a row stop a job whose graph declares no ceiling.
 *
 * Three, and not one: a session dies for reasons that are nobody's fault and do
 * not repeat — a machine that slept, a network that blinked, a CLI that crashed
 * once. One failure is noise, and blocking on it would put a person in the loop
 * for something the next attempt fixes. Three in a row on the SAME node is a
 * pattern, and the fourth attempt is buying the same answer again.
 *
 * A class that disagrees says so in its own document (`max_consecutive_failures`
 * at the graph root), which is where a per-class number belongs — versioned and
 * proposable with the graph (D2, D15), never as a flag on a process.
 */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * The ceiling the job's graph version declares, or the default.
 *
 * Silent in the same three cases `requireFieldsOfNode` and `isAtFinalNode` are:
 * no version, a version that no longer resolves, a snapshot that declares
 * nothing. A fourth one is added here — a declared value that is not a positive
 * integer — for the reason the schema alone cannot cover it: `POST /v1/graphs`
 * compiles no ajv against `grafo.schema.json` (`domain/graph.ts:222-226`), so a
 * `0` or a `"três"` can reach a snapshot. Falling back is the only safe
 * direction: a ceiling of zero would block every job on its first session, and a
 * ceiling of `NaN` would never block anything.
 *
 * @param db Open handle.
 * @param row The job's row, as it is in the table.
 * @returns A positive integer.
 */
function resolveFailureCeiling(db: Database, row: JobRow): number {
  if (row.graph_version_id === null) return DEFAULT_MAX_CONSECUTIVE_FAILURES;

  const version = getVersion(db, row.graph_version_id);
  if (version === undefined) return DEFAULT_MAX_CONSECUTIVE_FAILURES;

  const declared = version.snapshot.max_consecutive_failures;
  return typeof declared === 'number' && Number.isInteger(declared) && declared >= 1
    ? declared
    : DEFAULT_MAX_CONSECUTIVE_FAILURES;
}

/**
 * Stops a job whose sessions keep failing on the same node (t265, FR9).
 *
 * The half of this ficha that only the control plane can do. The runner already
 * blocks what it can decide alone — the five pre-session failures (t252), a
 * refusal the engine declared (t265) — but a STREAK is not visible from inside
 * one dispatch: the three sessions that came before this one may have run under
 * three different leases, in three different runner processes, one of which
 * died. The history lives here, and only here (D1).
 *
 * Called from `finishSession`, inside its transaction and right after the
 * `session.finished` event exists, so the flag and the fact that raised it land
 * together or neither does — the same rule `announceFinishedExecution` runs
 * under, and the reason this writes the row directly instead of calling
 * {@link blockJob}: that one opens a transaction of its own.
 *
 * Three things it deliberately does not do:
 *
 * - **It does not count a refusal.** A session closed with `failure_kind` is
 *   the runner's to stop, on the first occurrence, and counting it here as well
 *   would put two owners on one flag — which is how a job ends up blocked with
 *   nothing pending. The guard is at the call site, where the payload is.
 * - **It does not touch a job that is already blocked.** Whatever stopped it
 *   first is what a person is reading, and overwriting that reason with this one
 *   would hide the real cause behind a symptom of it.
 * - **It counts the TRAILING streak.** Most-recent-first, stopping at the first
 *   session that did not fail: a node that failed twice, worked, and failed
 *   again has one failure behind it, not three. `LIMIT` the ceiling, because
 *   nothing past it can change the answer.
 *
 * @param db Open handle, inside the finish's own transaction.
 * @param jobId The job whose session just failed.
 * @param nodeId The node it ran on; `null` is a no-op — a session with no node
 *   belongs to no streak.
 * @param occurredAt The instant of the closure, so the flag is stamped with the
 *   moment it went up.
 */
export function blockOnRepeatedFailure(
  db: Database,
  jobId: number,
  nodeId: string | null,
  occurredAt: string,
): void {
  if (nodeId === null) return;

  const row = readRow(db, jobId);
  if (row === undefined) return;
  if (asBoolean(row.blocked)) return;

  const ceiling = resolveFailureCeiling(db, row);

  const recent = db
    .prepare(
      `SELECT status FROM session
        WHERE job_id = ? AND node_id = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(jobId, nodeId, ceiling) as Array<{ status: string }>;

  let streak = 0;
  for (const session of recent) {
    if (session.status !== 'failed') break;
    streak += 1;
  }
  if (streak < ceiling) return;

  // Portuguese, like every other block reason a person reads first
  // (`input-request.ts:316` is the precedent for core writing one). It names the
  // node and the count because those two are what tells whoever opens the job
  // which sessions to go and read.
  const reason =
    `O nó \`${nodeId}\` falhou ${String(streak)} sessões seguidas, que é o teto ` +
    'desta classe de problema. O trabalho parou aqui em vez de continuar sendo ' +
    'arrendado: cada tentativa custa uma sessão inteira e as últimas terminaram ' +
    'todas do mesmo jeito. Leia a transcrição dessas sessões, corrija o que elas ' +
    'apontam e desbloqueie.';

  db.prepare('UPDATE job SET blocked = ?, block_reason = ?, updated_at = ? WHERE id = ?').run(
    asInteger(true),
    reason,
    occurredAt,
    jobId,
  );

  // `API_ACTOR`, like `announceFinishedExecution`: this is the control plane
  // asserting something about the history IT owns, not the runner reporting
  // what a session did.
  const event = recordEvent(db, {
    type: 'job.blocked',
    project_id: row.project_id,
    execution_id: row.execution_id,
    entity: { type: 'job', id: jobId },
    actor: API_ACTOR,
    occurred_at: occurredAt,
    data: { reason, consecutive_failures: streak },
  });

  // The same reaction `blockJob` fires, matched on the node the job is STANDING
  // on: a block is a flag fact, not a movement fact (t169).
  enqueueHookDeliveries(db, {
    trigger: 'node_blocked',
    no_id: row.current_node_id,
    trabalho_id: jobId,
    projeto_id: row.project_id,
    execucao_id: row.execution_id,
    grafo_versao_id: row.graph_version_id,
    evento_id: event.id,
  });
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
  filter: { execution_id?: number } = {},
): Job[] {
  const rows = (
    filter.execution_id === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM job ORDER BY id`).all()
      : db
          .prepare(`SELECT ${COLUMNS} FROM job WHERE execution_id = ? ORDER BY id`)
          .all(filter.execution_id)
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
      `SELECT t.graph_version_id,
              COUNT(*) AS jobs,
              COALESCE(SUM((${JOB_EVENTS})), 0) AS events
         FROM job t
        WHERE t.execution_id = ?
        GROUP BY t.graph_version_id`,
    )
    .all(executionId) as MetricByVersion[];

  return rows.sort((a, b) => {
    if (a.graph_version_id === null) return 1;
    if (b.graph_version_id === null) return -1;
    return a.graph_version_id.localeCompare(b.graph_version_id);
  });
}

/**
 * Token totals of one `(version, node)` pair, summed over the sessions that
 * reported them (t264, FR7).
 *
 * The four subkeys are `session.usage`'s own, shortened: the prefix and the
 * suffix say nothing here that the surrounding object does not already say.
 */
export interface NodeTokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

/**
 * What one node cost, under one graph version, in one execution (t264, FR7).
 *
 * It was English before {@link MetricByVersion} and {@link QuestionsByNode}
 * were, because nothing here mirrors a column — every field is a count or a sum
 * this function computes, so there was never an alias to preserve nor a
 * translation step to write. t286 brought the other two across; the three now
 * read the same way.
 *
 * Two counters instead of one, twice over, and that is the discipline this
 * shape exists to carry (`packages/topografo-custo/src/cost.ts`, whose
 * `aggregateCost` computes exactly this client-side): an absent `usage` is the
 * engine having reported NOTHING, never a measurement of zero, and a session
 * still open is a duration nobody knows, never an instant one. `sessions` minus
 * `sessions_with_usage` is how much of `tokens` cannot be believed.
 */
export interface NodeMetrics {
  /** The node the sessions ran on; `null` groups the ones that named none. */
  node_id: string | null;
  sessions: number;
  sessions_with_usage: number;
  tokens: NodeTokenTotals;
  sessions_with_duration: number;
  /** Sum of `finished_at - opened_at`, only over the sessions with both. */
  agent_ms: number;
}

/** `session.usage`, in the subset this fold reads. */
interface ReportedUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

/** One session of the execution, joined to the version its job declares. */
interface SessionOfExecution {
  graph_version_id: string | null;
  node_id: string | null;
  usage: string | null;
  opened_at: string;
  finished_at: string | null;
}

/** A subkey of `usage` as a number; anything else contributes nothing. */
function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Duration of a session in milliseconds, or `null` when there is no knowing.
 *
 * An absent or unparseable stamp is ignorance, and ignorance is counted out of
 * `sessions_with_duration` — never added to `agent_ms` as a zero.
 */
function sessionDurationMs(row: SessionOfExecution): number | null {
  if (row.finished_at === null) return null;
  const start = Date.parse(row.opened_at);
  const end = Date.parse(row.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

/** Text first, `null` last — the order of `metricsByVersion`. */
function nodeIdOrder(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/**
 * Sessions, tokens and agent time per `(graph version, node)`, for one
 * execution (t264, FR7).
 *
 * The level below {@link metricsByVersion}, and the one its two callers were
 * already computing by hand: the flow surveyor's note
 * (`notas/2026-08-17-primeira-execucao-bets.md`, gap 8) and the cost lens, which
 * pulls `GET /v1/sessions` and `GET /v1/jobs` and joins them in the runner
 * process. "v2 is more expensive than v1" is an opinion until it says WHICH node
 * became expensive, and the join that answers that belongs on the side that owns
 * both tables (D1).
 *
 * The `session` table is read straight from here, as `hasConformingFinish`
 * already does, rather than through `repositories/session.ts`: the question is
 * about a JOB's version, and reaching into the other repository to ask it would
 * put the join in the file that has no business knowing about jobs.
 *
 * The grouping is done in JS and not by `GROUP BY`, for one reason: `usage` is
 * a JSON document in a column (`migrations/0003`, "JSON; NULL != gravar zeros"),
 * and summing its subkeys in SQL would mean depending on the JSON1 extension for
 * a fold of a few dozen rows. What SQL does here is the join and the filter,
 * which is what SQL is for.
 *
 * The `INNER JOIN` is not a silent drop: a session with no `job_id` belongs to
 * no job, and therefore to no execution — there is no round for it to be
 * missing from. What DOES get a group of its own is a session with no
 * `node_id`, and a job that declares no `graph_version_id`; both fall under
 * `null` and are ordered last, the same convention {@link metricsByVersion} and
 * `questionsByNode` follow.
 *
 * @param db Open handle.
 * @param executionId Execution to group.
 * @returns One entry per graph version observed, holding its nodes in node
 *   order with `null` last. A version with no session at all is simply absent —
 *   the caller supplies the empty list for it.
 */
export function nodeMetricsByVersion(
  db: Database,
  executionId: number,
): Map<string | null, NodeMetrics[]> {
  const rows = db
    .prepare(
      `SELECT j.graph_version_id,
              s.node_id,
              s.usage,
              s.opened_at,
              s.finished_at
         FROM session s
         JOIN job j ON j.id = s.job_id
        WHERE j.execution_id = ?
        ORDER BY s.id`,
    )
    .all(executionId) as SessionOfExecution[];

  const byVersion = new Map<string | null, Map<string | null, NodeMetrics>>();

  for (const row of rows) {
    let nodes = byVersion.get(row.graph_version_id);
    if (nodes === undefined) {
      nodes = new Map<string | null, NodeMetrics>();
      byVersion.set(row.graph_version_id, nodes);
    }

    let metrics = nodes.get(row.node_id);
    if (metrics === undefined) {
      metrics = {
        node_id: row.node_id,
        sessions: 0,
        sessions_with_usage: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        sessions_with_duration: 0,
        agent_ms: 0,
      };
      nodes.set(row.node_id, metrics);
    }

    metrics.sessions += 1;

    const usage = jsonOrNull<ReportedUsage>(row.usage);
    if (usage !== null) {
      metrics.sessions_with_usage += 1;
      metrics.tokens.input += tokenCount(usage.input_tokens);
      metrics.tokens.output += tokenCount(usage.output_tokens);
      metrics.tokens.cache_read += tokenCount(usage.cache_read_input_tokens);
      metrics.tokens.cache_creation += tokenCount(usage.cache_creation_input_tokens);
    }

    const duration = sessionDurationMs(row);
    if (duration !== null) {
      metrics.sessions_with_duration += 1;
      // An interval that runs backwards is a clock disagreement, not negative
      // time — the same reading the flow lens's fold gives one.
      metrics.agent_ms += Math.max(0, duration);
    }
  }

  return new Map(
    [...byVersion].map(([version, nodes]) => [
      version,
      [...nodes.values()].sort((a, b) => nodeIdOrder(a.node_id, b.node_id)),
    ]),
  );
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
 * `pending_input_requests` comes from a correlated subquery with `IS` (equality
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
      `SELECT t.execution_id,
              COUNT(*) AS jobs,
              COALESCE(SUM(t.blocked), 0) AS blocked_jobs,
              (SELECT COUNT(*) FROM input_request p
                WHERE p.status = 'pending' AND p.execution_id IS t.execution_id)
                                       AS pending_input_requests,
              ${finishedAtOf('t.execution_id')} AS finished_at
         FROM job t
        GROUP BY t.execution_id`,
    )
    .all() as ExecutionSummary[];

  return rows.sort((a, b) => {
    if (a.execution_id === null) return 1;
    if (b.execution_id === null) return -1;
    return a.execution_id - b.execution_id;
  });
}

/**
 * One execution, by its id (t245, FR7).
 *
 * The same three counts of the list plus the end of the round, for whoever
 * already knows which round they are asking about — the observer of D21's third
 * child polls exactly this.
 *
 * It never answers "does not exist", and returning `null` here would be the
 * wrong shape for the same reason the other two `/:id` routes of this family
 * already answer `200`: `execution_id` is an opaque grouper, not a row, so an
 * id nobody wrote a job under is a round with zero jobs — which is also, by
 * FR1, a round that is not finished. The aggregate below has no `GROUP BY` on
 * purpose: over zero rows it still answers one row, with the zeros in it.
 *
 * @param db Open handle.
 * @param id Execution id.
 * @returns The summary; zero counts and `finished_at: null` when no job cites
 *   this round.
 */
export function getExecution(db: Database, id: number): ExecutionSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*)                 AS jobs,
              COALESCE(SUM(t.blocked), 0) AS blocked_jobs,
              (SELECT COUNT(*) FROM input_request p
                WHERE p.status = 'pending' AND p.execution_id = @execution_id)
                                       AS pending_input_requests,
              ${finishedAtOf('@execution_entity_id')} AS finished_at
         FROM job t
        WHERE t.execution_id = @execution_id`,
    )
    .get({ execution_id: id, execution_entity_id: String(id) }) as Omit<
    ExecutionSummary,
    'execution_id'
  >;

  return { execution_id: id, ...row };
}
