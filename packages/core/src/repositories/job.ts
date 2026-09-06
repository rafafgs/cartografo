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
 * `criterios_de_aceite` have no row in `docs/spec/glossary-wire.md` §4.2, so
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
import type { ContractProblem, ContractsState, GraphDocument } from '../domain/graph.ts';
import {
  deriveJobState,
  type JobState,
  type JobStateFacts,
} from '../domain/job-state.ts';
import {
  isScalarMap,
  missingRequiredFields,
  type ScalarMap,
} from '../domain/custom-fields.ts';
import { getVersion, getVersionSummary } from './graphs.ts';
import { enqueueHookDeliveries, type ClockOptions } from './hooks.ts';
import { listInputRequests } from './input-request.ts';
import { listLeases } from './leases.ts';
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
   * Derived at read time, never stored — see `hasArrived`. It is the only
   * terminal signal this system has: the log has no `job.completed` event,
   * and "nothing is open right now" is a state a job one event old already
   * satisfies.
   */
  completed: boolean;
  /**
   * What this job is doing right now, in the six words RF-30 defines (t415).
   *
   * Derived at read time and never stored, the same posture as `completed`
   * above — every one of the six is a fact of the log, of the lease table or of
   * the graph version, and a column caching one would go on reporting a state
   * the log no longer supports. The rule itself is `domain/job-state.ts`; what
   * this file does is READ the facts, once for a whole board.
   */
  state: JobState;
  /**
   * When the job entered {@link Job.state} — the instant of the fact that put
   * it there, never an invention.
   *
   * Falls back to `created_at` only where the log carries nothing at all: "in
   * this state since we do not know when" is not something a screen can render.
   */
  state_since: string;
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
  extends Omit<
    Job,
    'blocked' | 'body' | 'acceptance_criteria' | 'fields' | 'completed' | 'state' | 'state_since'
  > {
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
 * because an alias here would invent a schema name `glossary-wire.md` §4.2 does
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
 * The project rides on it since t410 (FR11), off `event.project_id` — the
 * column the announcement already writes. Without it the end of round 7 of one
 * project would be published as the end of round 7 of every other, because
 * `execution_id` is a number an operator chooses and two projects numbering
 * their rounds independently collide as a matter of course.
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
              AND e.project_id = @project_id
            ORDER BY e.id
            LIMIT 1)`;
}

/**
 * "The traveller arrived": the job's node is a final node of ITS version, and
 * that node has nothing left to run (t152, t262).
 *
 * Three things say no. A blocked job is never done, whatever node it is
 * standing on — the flag stops the report of an end the same way it stops
 * everything else. A job with no graph to ask has no terminal state to arrive
 * at, which is what a `null` `finalNodes` means: no `graph_version_id`, an id
 * that no longer resolves (the column is loose text, not a foreign key), or a
 * snapshot that declares nothing. Inventing a completion out of a version
 * nobody can read would be worse than admitting ignorance.
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
 * `JobStateFacts.conformingFinishAt`. A final node that pins nothing is done on
 * arrival, exactly as before. The rule is keyed on `skill_ref` and never on
 * `node_type`: `docs/spec/graph.md` 2 says a gate is "a node whose role is to
 * check", and the minimal example graph's own final node is a gate with a pin.
 *
 * The no-pin branch is defensive, not a supported document shape:
 * `schema/graph.schema.json` makes `skill_ref` mandatory on every node and
 * `node_with_contract` guards it at soundness, so nothing registered through
 * `POST /v1/graphs` reaches it. It exists for the same reason `resolveNode` and
 * `resolveOutputSchema` already treat the pin as optional on the TS side — a
 * malformed or pre-existing snapshot degrades instead of throwing. A node the
 * snapshot no longer carries at all reads the same way: there is no pin to
 * demand a session for.
 *
 * Pure since t415, over the very facts the six states are derived from: it used
 * to run two queries of its own per job, and keeping a second, differently-fed
 * copy of this rule beside the state machine is how the board and the job page
 * would eventually come to disagree about the same traveller. What reads the
 * database is {@link resolveJobStates}, once for a whole list.
 *
 * @param facts What is already known about the job.
 * @returns Whether the job is standing on a final node, unblocked, with that
 *   node's own work already reported.
 */
function hasArrived(facts: JobStateFacts): boolean {
  if (facts.blocked) return false;
  if (facts.finalNodes === null || !facts.finalNodes.includes(facts.currentNodeId)) return false;
  return !facts.currentNodePinsSkill || facts.conformingFinishAt !== null;
}

/** Key of one job's node, for the conforming-finish lookup below. */
function nodeKey(jobId: number, nodeId: string): string {
  return `${jobId} ${nodeId}`;
}

/**
 * A list of ids as named parameters, never as interpolated values.
 *
 * The same rule `announceFinishedExecution` and `db/events.ts` already write:
 * the LIST is built into the SQL (there is no other way to write an `IN`) and
 * every VALUE is bound. It also keeps each query below to a single prepared
 * statement per call, which is what makes the whole resolution cost a fixed
 * number of statements whatever the board holds.
 *
 * @param prefix Name the parameters take, numbered.
 * @param values The ids themselves, in whichever type the column holds.
 * @returns The `IN` list and the object to bind it with.
 */
function boundList(
  prefix: string,
  values: Array<string | number>,
): { list: string; params: Record<string, string | number> } {
  return {
    list: values.map((_, index) => `@${prefix}_${index}`).join(', '),
    params: Object.fromEntries(values.map((value, index) => [`${prefix}_${index}`, value])),
  };
}

/**
 * Every fact the six states — and `completed` — are read from, for a WHOLE list
 * of jobs (t415, FR5).
 *
 * Six statements and a merge in memory, never one query per row. It is the
 * discipline `listRunnersWithHealth` already writes for the fleet page ("small
 * is not a reason to write an N+1 that grows with it"), and here it is also what
 * the board's own guard demands: `test/jobs.test.ts`'s AT17 reads a one-job
 * board and a five-job board and refuses any difference in the number of
 * statements prepared.
 *
 * The six:
 *
 * 1. the project's ACTIVE leases, through `listLeases`'s own filter (t410) — at
 *    most one per job, which `grantLease`'s `job_already_leased` guard makes an
 *    invariant of the table rather than an assumption of this file;
 * 2. the project's PENDING input requests, through `listInputRequests`'s
 *    project join (t411);
 * 3. which of these jobs have a session still open;
 * 4. the latest `job.blocked` and `job.transitioned` of each, off the log. The
 *    scope is `event.project_id` — a real column on that table, unlike
 *    `session` — narrowed to the jobs actually being resolved;
 * 5. the conforming finishes of these jobs, per node, matched in memory against
 *    each job's current node;
 * 6. the snapshots of the versions the jobs cite, in ONE read keyed by the
 *    project (D25: the same content hash may legitimately exist once per
 *    project).
 *
 * The sixth is the one place this departs from the ficha's letter, which asked
 * for `getVersion` once per DISTINCT version id. That is bounded by the number
 * of versions on the board instead of by the number of jobs, but it still makes
 * a five-job board across two versions cost one statement more than a one-job
 * board across one — which AT17 refuses, and rightly: "bounded" that grows with
 * anything the board carries is not bounded. Reading `graph_version` from here
 * is the shape this file already takes for the same kind of question
 * (`resolvesInAnotherProject`).
 *
 * @param db Open handle.
 * @param rows The jobs to resolve — all of them of `projectId`.
 * @param projectId Partition the jobs live in.
 * @param moment The instant the whole list is derived against: one clock read
 *   per board, so two rows of the same page cannot disagree about "now".
 * @returns The facts, keyed by job id — one entry per row handed in.
 */
function resolveJobStates(
  db: Database,
  rows: JobRow[],
  projectId: number,
  moment: string,
): Map<number, JobStateFacts> {
  const facts = new Map<number, JobStateFacts>();
  if (rows.length === 0) return facts;

  const byJob = boundList(
    'job',
    rows.map((row) => row.id),
  );
  // `event.entity_id` is TEXT — one log for five entities, one of them keyed by
  // a hash (D15) — so the ids are bound as the strings that column holds.
  const byEntity = boundList(
    'entity',
    rows.map((row) => String(row.id)),
  );

  const leases = new Map<number, { granted_at: string; expires_at: string }>();
  for (const lease of listLeases(db, { project_id: projectId, status: 'active' })) {
    leases.set(lease.job_id, { granted_at: lease.granted_at, expires_at: lease.expires_at });
  }

  const pending = new Map<number, { created_at: string }>();
  for (const request of listInputRequests(db, { project_id: projectId, status: 'pending' })) {
    // The FIRST one wins, and the listing is in id order: a job with two
    // questions open has been waiting for a person since the older of them.
    if (!pending.has(request.job_id)) {
      pending.set(request.job_id, { created_at: request.created_at });
    }
  }

  const open = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT job_id FROM session
            WHERE status = 'open' AND job_id IN (${byJob.list})`,
        )
        .all(byJob.params) as Array<{ job_id: number }>
    ).map((row) => row.job_id),
  );

  const blockedAt = new Map<number, string>();
  const transitionedAt = new Map<number, string>();
  const stamps = db
    .prepare(
      `SELECT entity_id, type, MAX(occurred_at) AS occurred_at
         FROM event
        WHERE project_id = @project_id
          AND entity_type = 'job'
          AND type IN ('job.blocked', 'job.transitioned')
          AND entity_id IN (${byEntity.list})
        GROUP BY entity_id, type`,
    )
    .all({ project_id: projectId, ...byEntity.params }) as Array<{
    entity_id: string;
    type: string;
    occurred_at: string;
  }>;
  for (const stamp of stamps) {
    const latest = stamp.type === 'job.blocked' ? blockedAt : transitionedAt;
    latest.set(Number(stamp.entity_id), stamp.occurred_at);
  }

  const finishes = new Map<string, string>();
  const finished = db
    .prepare(
      `SELECT job_id, node_id, MAX(finished_at) AS finished_at
         FROM session
        WHERE status = 'completed' AND output IS NOT NULL AND job_id IN (${byJob.list})
        GROUP BY job_id, node_id`,
    )
    .all(byJob.params) as Array<{
    job_id: number;
    node_id: string | null;
    finished_at: string | null;
  }>;
  for (const session of finished) {
    // A session with no node has no node to have finished on, and one with no
    // `finished_at` is a row `finishSession` never closed: neither says anything
    // about the node the job is standing on.
    if (session.node_id === null || session.finished_at === null) continue;
    finishes.set(nodeKey(session.job_id, session.node_id), session.finished_at);
  }

  const versionIds = [
    ...new Set(rows.map((row) => row.graph_version_id).filter((id): id is string => id !== null)),
  ];
  const snapshots = new Map<string, GraphDocument>();
  if (versionIds.length > 0) {
    const byVersion = boundList('version', versionIds);
    const stored = db
      .prepare(
        `SELECT id, snapshot FROM graph_version
          WHERE project_id = @project_id AND id IN (${byVersion.list})`,
      )
      .all({ project_id: projectId, ...byVersion.params }) as Array<{
      id: string;
      snapshot: string;
    }>;
    for (const version of stored) {
      snapshots.set(version.id, JSON.parse(version.snapshot) as GraphDocument);
    }
  }

  for (const row of rows) {
    const snapshot =
      row.graph_version_id === null ? undefined : snapshots.get(row.graph_version_id);
    const node = snapshot?.nodes?.find((candidate) => candidate.id === row.current_node_id);
    const pin = node?.skill_ref;

    facts.set(row.id, {
      blocked: asBoolean(row.blocked),
      currentNodeId: row.current_node_id,
      createdAt: row.created_at,
      now: moment,
      pendingQuestion: pending.get(row.id) ?? null,
      blockedAt: blockedAt.get(row.id) ?? null,
      activeLease: leases.get(row.id) ?? null,
      hasOpenSession: open.has(row.id),
      finalNodes: snapshot?.final_nodes ?? null,
      currentNodePinsSkill: pin !== undefined && pin !== null,
      conformingFinishAt: finishes.get(nodeKey(row.id, row.current_node_id)) ?? null,
      lastTransitionAt: transitionedAt.get(row.id) ?? null,
    });
  }

  return facts;
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
 * No `Database` since t415: the three derived fields all come out of the same
 * `facts`, which somebody else read in one go.
 *
 * @param row The job's row, as it is in the table.
 * @param facts What {@link resolveJobStates} found out about this row.
 * @returns The projection.
 */
function toJob(row: JobRow, facts: JobStateFacts): Job {
  const { corpo: body, criterios_de_aceite: criteria, ...rest } = row;
  return {
    ...rest,
    body,
    acceptance_criteria: jsonOrNull<string[]>(criteria),
    blocked: asBoolean(row.blocked),
    fields: jsonOrNull<ScalarMap>(row.fields),
    completed: hasArrived(facts),
    ...deriveJobState(facts),
  };
}

/**
 * A whole list of rows as {@link Job}, resolved together.
 *
 * @param db Open handle.
 * @param rows The rows, all of them of `projectId`.
 * @param projectId Partition they live in.
 * @returns One projection per row, in the order they came.
 */
function toJobs(db: Database, rows: JobRow[], projectId: number): Job[] {
  const facts = resolveJobStates(db, rows, projectId, now());
  // The cast is the map's own contract: `resolveJobStates` writes one entry per
  // row it was handed, and these are those rows.
  return rows.map((row) => toJob(row, facts.get(row.id) as JobStateFacts));
}

/**
 * One row as {@link Job} — the same resolution, over a list of one.
 *
 * Correctness, not a special case: a second single-row path for the derived
 * fields would be a second answer to the same question, and the one thing this
 * ficha must not leave behind is a board that disagrees with the job page.
 *
 * @param db Open handle.
 * @param row The job's row.
 * @returns The projection.
 */
function toOneJob(db: Database, row: JobRow): Job {
  return toJobs(db, [row], row.project_id)[0];
}

/**
 * The row by id alone, whichever project wrote it.
 *
 * What the four WRITES of this file load (`mutate`), and nothing else: scoping
 * a mutation is a different risk from scoping a read — a wrong scope there
 * refuses or misdirects a live transition instead of merely hiding a row — and
 * it belongs to the write-side slice of the t355 split (t410, Out of Scope).
 */
function readRow(db: Database, id: number): JobRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM job WHERE id = ?`).get(id) as
    | JobRow
    | undefined;
}

/**
 * The row as it is seen from INSIDE one project (t410, FR2).
 *
 * A job of another project reads exactly like a job that was never created —
 * `undefined`, which every caller turns into the same `404 not_found` a
 * nonexistent id gets. That is the non-leaking convention `routes/graphs.ts`
 * already writes for a cross-project `origin_proposal_id`: a boundary must
 * never be distinguishable from an absence, or the refusal itself says which
 * ids are taken elsewhere.
 */
function readScopedRow(db: Database, id: number, projectId: number): JobRow | undefined {
  return db
    .prepare(`SELECT ${COLUMNS} FROM job WHERE project_id = ? AND id = ?`)
    .get(projectId, id) as JobRow | undefined;
}

/**
 * Gets a job by its projection.
 *
 * @param db Open handle.
 * @param id Job id.
 * @param projectId Partition the job lives in (D25). A job of another project
 *   answers `null`, like one that does not exist.
 * @returns The job, or `null` if it does not exist in this project.
 */
export function getJob(db: Database, id: number, projectId: number = DEFAULT_PROJECT): Job | null {
  const row = readScopedRow(db, id, projectId);
  return row === undefined ? null : toOneJob(db, row);
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
 * @param projectId Partition the job lives in (t410, FR9). It is also what
 *   makes `listSessions`/`listInputRequests` safe unscoped on the route: they
 *   are only ever called with a `job_id` this read already confirmed.
 * @returns The seed, or `null` if the job does not exist in this project.
 */
export function jobContextSeed(
  db: Database,
  id: number,
  projectId: number = DEFAULT_PROJECT,
): JobContextSeed | null {
  const row = readScopedRow(db, id, projectId);
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
 * `registrar-travessia` — the final node of `asymmetric-bets` — asks which
 * nodes this crossing executed and when it arrived where it stands, and until
 * this ficha nothing answered: `buildNodeInput` assembles the ticket, the
 * class's config, the `produces` buckets and the answered escalations, and the
 * traversal is none of those. It is a fact about `job.transitioned`, and the
 * control plane is the only thing that has that log (D1) — which is why the
 * second real bets crossing was unblocked by a person typing the two values
 * into `fields` by hand (`notes/2026-08-17-second-bets-run.md`, gap 5).
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
 * @param projectId Partition the job lives in (t410, FR9).
 * @returns The walk, or `null` if the job does not exist in this project.
 */
export function jobTraversal(
  db: Database,
  id: number,
  projectId: number = DEFAULT_PROJECT,
): { nodes_visited: string[]; entered_at: string } | null {
  const row = readScopedRow(db, id, projectId);
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
 * job, every one of them arrived (`Job.completed`, which is `hasArrived` and
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
 * (`notes/2026-08-17-first-bets-run.md`, gap 3).
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
 * `hasArrived` answers `false` for a blocked job whatever node it is standing
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

  // The round of THIS project (t410, FR10): the condition is over the jobs of
  // the project whose job just moved, and a job of another project sharing the
  // execution number is not a reason for this round to stay open.
  const jobs = listJobs(db, { execution_id: executionId }, projectId);
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

  // The guard is scoped too, for the same reason the condition above is: the
  // fact recorded is "round N of THIS project ended", so project 1's
  // announcement must not be read as project 2's round having already been
  // declared over — which would leave that round unable to end at all, while
  // `finishedAtOf` (scoped since t410) correctly went on reporting `null`.
  const alreadyAnnounced =
    db
      .prepare(
        `SELECT 1 FROM event
          WHERE type = 'execution.finished'
            AND entity_type = 'execution'
            AND entity_id = ?
            AND project_id = ?
          LIMIT 1`,
      )
      .get(String(executionId), projectId) !== undefined;
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

/**
 * The version this job names belongs to another project (t410, FR7).
 *
 * Not a `GraphVersionNotReadyError` and not a silent accept, which are the two
 * neighbours it had to be told apart from. It is not a STATE refusal: the
 * version may be perfectly `checked` — over there. And it is not the ordinary
 * "resolves to nothing, so it is free text" path (t283), because the hash DOES
 * resolve; it resolves across a partition, and a reference may never cross one
 * (D25).
 *
 * `routes/graphs.ts` refuses a cross-project `origin_proposal_id` with the same
 * code a nonexistent one gets, deliberately, so that a boundary is never
 * mistakable for a permission leak. This one is loud instead, and the
 * difference is what the id carries: a proposal id is a sequence, so answering
 * "that one exists elsewhere" would leak which numbers are taken in another
 * project; a version id is the hash of the content the caller is already
 * holding, and telling it that the same content lives in another project says
 * nothing it did not put in the request.
 */
export class CrossProjectVersionReferenceError extends Error {
  /** Stable, machine-readable code — it is what the route publishes as `error`. */
  readonly code = 'cross_project_reference' as const;
  /** The version that was named, which is a hash and therefore content. */
  readonly graphVersionId: string;
  /** The project the job would have been born in. */
  readonly projectId: number;

  constructor(graphVersionId: string, projectId: number) {
    super(
      `graph version ${graphVersionId} is not registered in project ${projectId}: it resolves ` +
        'in another project, and a reference may never cross a project boundary (register the ' +
        'graph in this project, or create the job in the one that owns the version)',
    );
    this.name = 'CrossProjectVersionReferenceError';
    this.graphVersionId = graphVersionId;
    this.projectId = projectId;
  }
}

/**
 * Whether this version hash is registered in ANY project other than the given
 * one (t410, FR7).
 *
 * Asked only when the version did not resolve inside the job's own project, and
 * only to tell two absences apart: a hash this database never saw (still the
 * ungated free-text case of t283) and a hash that exists on the other side of a
 * partition (a conflict). Existence alone, at any contract state — a version of
 * another project is out of reach whatever state it is in, so reading its state
 * would be reading a row this project may not use anyway.
 *
 * @param db Open handle.
 * @param graphVersionId The hash the body named.
 * @param projectId The project it failed to resolve in.
 * @returns Whether some other project has that version.
 */
function resolvesInAnotherProject(
  db: Database,
  graphVersionId: string,
  projectId: number,
): boolean {
  return (
    db
      .prepare('SELECT 1 FROM graph_version WHERE id = ? AND project_id <> ? LIMIT 1')
      .get(graphVersionId, projectId) !== undefined
  );
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
 * ## Where that check LOOKS, since t410 (FR6/FR7)
 *
 * In the job's own project, and there only. "Resolves to nothing" therefore
 * splits in two: a hash no project registered is the free-text case above,
 * untouched; a hash some OTHER project registered is a reference crossing a
 * partition, and it is refused with
 * {@link CrossProjectVersionReferenceError} before anything is written.
 *
 * @param db Open handle.
 * @param input Request body.
 * @returns The created job.
 * @throws {ValidationError} When a required field is missing.
 * @throws {GraphVersionNotReadyError} When the named version resolves in this
 *   project and its contracts are not `checked` (t283).
 * @throws {CrossProjectVersionReferenceError} When it resolves only in another
 *   project (t410).
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
    //
    // Inside the job's OWN project since t410 (FR6): the id is a content hash,
    // so the same one may exist once per project (D25), and reading the default
    // project's copy would have gated this job on somebody else's row.
    const version = getVersionSummary(db, graphVersionId, projectId);
    if (version !== undefined && version.contracts.state !== 'checked') {
      throw new GraphVersionNotReadyError(graphVersionId, version.contracts);
    }
    // It did not resolve here. If it resolves NOWHERE, this is still the loose
    // free-text case t283 left alone; if it resolves somewhere else, the job is
    // reaching across a partition and that is refused (FR7/FR8).
    if (version === undefined && resolvesInAnotherProject(db, graphVersionId, projectId)) {
      throw new CrossProjectVersionReferenceError(graphVersionId, projectId);
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

    return toOneJob(db, readRow(db, id) as JobRow);
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
    return toOneJob(db, readRow(db, id) as JobRow);
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
 * the same way `hasArrived` above does, and for the same reason: what is
 * demanded is a property of the VERSION the job runs under, not of the class
 * today.
 *
 * Silent in the same three cases `hasArrived` is: no version, a version that
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

  // The job's own project, for `hasArrived`'s reason (t410, FR5): a demand
  // borrowed from another project's snapshot is a demand nobody could act on.
  const version = getVersion(db, row.graph_version_id, row.project_id);
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
          node_id: data.to_node_id as string,
          job_id: id,
          project_id: row.project_id,
          execution_id: row.execution_id,
          graph_version_id: row.graph_version_id,
          event_id: event.id,
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
          node_id: row.current_node_id,
          job_id: id,
          project_id: row.project_id,
          execution_id: row.execution_id,
          graph_version_id: row.graph_version_id,
          event_id: event.id,
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
 * Silent in the same three cases `requireFieldsOfNode` and `hasArrived` are:
 * no version, a version that no longer resolves, a snapshot that declares
 * nothing. A fourth one is added here — a declared value that is not a positive
 * integer — for the reason the schema alone cannot cover it: `POST /v1/graphs`
 * compiles no ajv against `graph.schema.json` (`domain/graph.ts:222-226`), so a
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

  // The job's own project, for `hasArrived`'s reason (t410, FR5).
  const version = getVersion(db, row.graph_version_id, row.project_id);
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

  // English since t314, like every line this project writes (D24). It names the
  // node and the count because those two are what tells whoever opens the job
  // which sessions to go and read.
  //
  // `input-request.ts` is the precedent for core writing a block reason at all,
  // and its own text is Portuguese still: `aguardando resposta da pergunta N`
  // carries neither a diacritic nor one of the seven stopwords, so every D24
  // sweep runs green straight over it. Left for whoever widens the detector.
  const reason =
    `Node \`${nodeId}\` failed ${String(streak)} sessions in a row, which is the ` +
    'cap for this problem class. The job stopped here instead of going on being ' +
    'leased: every attempt costs a whole session and the last ones all ended the ' +
    'same way. Read the transcripts of those sessions, fix what they point at, ' +
    'and unblock.';

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
    node_id: row.current_node_id,
    job_id: jobId,
    project_id: row.project_id,
    execution_id: row.execution_id,
    graph_version_id: row.graph_version_id,
    event_id: event.id,
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
 * The current board of ONE project: one job per row (FR8; t410, FR3).
 *
 * The execution filter narrows within the scope and never widens it: two
 * projects numbering their rounds independently land on the same
 * `execution_id` as a matter of course, and a list that mixed them would be
 * reporting somebody else's board.
 *
 * @param db Open handle.
 * @param filter Optional slice by execution.
 * @param projectId Partition to list (D25).
 * @returns Jobs in id order.
 */
export function listJobs(
  db: Database,
  filter: { execution_id?: number } = {},
  projectId: number = DEFAULT_PROJECT,
): Job[] {
  const rows = (
    filter.execution_id === undefined
      ? db.prepare(`SELECT ${COLUMNS} FROM job WHERE project_id = ? ORDER BY id`).all(projectId)
      : db
          .prepare(
            `SELECT ${COLUMNS} FROM job WHERE project_id = ? AND execution_id = ? ORDER BY id`,
          )
          .all(projectId, filter.execution_id)
  ) as JobRow[];
  return toJobs(db, rows, projectId);
}

/**
 * The job's timeline (FR9).
 *
 * @param db Open handle.
 * @param id Job id.
 * @param projectId Partition the job lives in (t410, FR1/FR2).
 * @returns Events in id order, or `null` if the job does not exist in this
 *   project.
 */
export function jobTimeline(
  db: Database,
  id: number,
  projectId: number = DEFAULT_PROJECT,
): Event[] | null {
  // The scope is the JOB's, and the events follow it: every event of a job
  // carries that job's own `project_id`, so confirming the job here is what
  // makes the filter below one project's log and not two.
  if (readScopedRow(db, id, projectId) === undefined) return null;
  return listEvents(db, { job_id: id });
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
 * @param projectId Partition the round belongs to (t410, FR4).
 * @returns One row per version, named versions first and `null` last.
 */
export function metricsByVersion(
  db: Database,
  executionId: number,
  projectId: number = DEFAULT_PROJECT,
): MetricByVersion[] {
  const rows = db
    .prepare(
      `SELECT t.graph_version_id,
              COUNT(*) AS jobs,
              COALESCE(SUM((${JOB_EVENTS})), 0) AS events
         FROM job t
        WHERE t.project_id = ? AND t.execution_id = ?
        GROUP BY t.graph_version_id`,
    )
    .all(projectId, executionId) as MetricByVersion[];

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
 * shape exists to carry (`packages/cost-surveyor/src/cost.ts`, whose
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
 * (`notes/2026-08-17-first-bets-run.md`, gap 8) and the cost lens, which
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
 * @param projectId Partition the round belongs to (t410, FR4).
 * @returns One entry per graph version observed, holding its nodes in node
 *   order with `null` last. A version with no session at all is simply absent —
 *   the caller supplies the empty list for it.
 */
export function nodeMetricsByVersion(
  db: Database,
  executionId: number,
  projectId: number = DEFAULT_PROJECT,
): Map<string | null, NodeMetrics[]> {
  // `session` carries no `project_id` and never will: it inherits the partition
  // through `job_id` (`docs/spec/entities-versioning.md` §1), which is the join
  // this query already had — so the scope goes on the job's own column.
  const rows = db
    .prepare(
      `SELECT j.graph_version_id,
              s.node_id,
              s.usage,
              s.opened_at,
              s.finished_at
         FROM session s
         JOIN job j ON j.id = s.job_id
        WHERE j.project_id = ? AND j.execution_id = ?
        ORDER BY s.id`,
    )
    .all(projectId, executionId) as SessionOfExecution[];

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
 * Every count is over the jobs of ONE project (t410, FR4). `input_request`
 * carries no `project_id` of its own and never will — it inherits the partition
 * through `job_id`, which is `NOT NULL REFERENCES job(id)` since migration
 * `0003` — so the pending count reaches its scope through a join instead of a
 * column.
 *
 * @param db Open handle.
 * @param projectId Partition to aggregate (D25).
 * @returns One row per execution, ascending, with the `null` group last — the
 *   same convention as `metricsByVersion`.
 */
export function listExecutions(
  db: Database,
  projectId: number = DEFAULT_PROJECT,
): ExecutionSummary[] {
  const rows = db
    .prepare(
      `SELECT t.execution_id,
              COUNT(*) AS jobs,
              COALESCE(SUM(t.blocked), 0) AS blocked_jobs,
              (SELECT COUNT(*) FROM input_request p
                 JOIN job pj ON pj.id = p.job_id
                WHERE p.status = 'pending'
                  AND p.execution_id IS t.execution_id
                  AND pj.project_id = @project_id)
                                       AS pending_input_requests,
              ${finishedAtOf('t.execution_id')} AS finished_at
         FROM job t
        WHERE t.project_id = @project_id
        GROUP BY t.execution_id`,
    )
    .all({ project_id: projectId }) as ExecutionSummary[];

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
 * @param projectId Partition the round belongs to (t410, FR4); the counts are
 *   the same ones {@link listExecutions} computes, scoped the same way.
 * @returns The summary; zero counts and `finished_at: null` when no job of this
 *   project cites this round.
 */
export function getExecution(
  db: Database,
  id: number,
  projectId: number = DEFAULT_PROJECT,
): ExecutionSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*)                 AS jobs,
              COALESCE(SUM(t.blocked), 0) AS blocked_jobs,
              (SELECT COUNT(*) FROM input_request p
                 JOIN job pj ON pj.id = p.job_id
                WHERE p.status = 'pending'
                  AND p.execution_id = @execution_id
                  AND pj.project_id = @project_id)
                                       AS pending_input_requests,
              ${finishedAtOf('@execution_entity_id')} AS finished_at
         FROM job t
        WHERE t.project_id = @project_id AND t.execution_id = @execution_id`,
    )
    .get({ execution_id: id, execution_entity_id: String(id), project_id: projectId }) as Omit<
    ExecutionSummary,
    'execution_id'
  >;

  return { execution_id: id, ...row };
}

/**
 * An execution id nobody has used yet, in this project (t408, FR4).
 *
 * The first allocator this repository has ever had, and it exists because the
 * one-click demo has nobody to ask: every other caller is HANDED an
 * `execution_id` — `POST /v1/jobs` reads it off the body, the intake copies the
 * one its confirmation carried — because a round is a grouping the operator
 * decides, not a row this database owns (there is no `execution` table, D1's
 * log groups by the column alone).
 *
 * Best effort by design, and named as such in the ficha's Out of Scope: `MAX +
 * 1` is not reserved, so two clicks landing in the same millisecond would be
 * handed the same number. That is a PoC-tier, single-operator trade — the cost
 * of the alternative is a lock or a sequence table, and the damage of the race
 * is two demo jobs sharing a round, which the board renders perfectly well. A
 * genuinely concurrent allocator is its own ticket the day it matters.
 *
 * @param db Open handle.
 * @param projectId Partition to count within; a round is scoped like everything
 *   else since D25.
 * @returns `1` for a project with no job at all, else one past its highest.
 */
export function nextExecutionId(db: Database, projectId: number = DEFAULT_PROJECT): number {
  // `MAX` over an empty set, and over a set that is all NULLs, both answer
  // `NULL` — which is why the coalescing is here and not a `WHERE execution_id
  // IS NOT NULL`: a project whose only jobs were created without a round is the
  // same case as a project with no jobs, and it deserves the same `1`.
  const row = db
    .prepare(`SELECT MAX(execution_id) AS highest FROM job WHERE project_id = ?`)
    .get(projectId) as { highest: number | null };

  return (row.highest ?? 0) + 1;
}
