/**
 * Intake repository — the breakdown of work into travellers (t122).
 *
 * D3 splits the meta-process in two acts: synthesizing topology produces NODES
 * (once per class) and breaking work down produces TICKETS (every execution).
 * This module is the second one, in two phases: a DRAFT that proposes the
 * breakdown over the class's already registered graph, and a CONFIRMATION that
 * is the human gate turning that proposal into `job` rows.
 *
 * Three boundaries that are the whole point of the design:
 *
 * - **The draft emits no event.** Creating, amending and discarding a draft are
 *   work in progress, not facts of audit. The log only gains a line when a
 *   traveller really is born — which is why the projection here can be updated
 *   in place without breaking the replay: nothing in `intake_draft` is
 *   reconstructed from the log, because nothing about it was ever recorded.
 * - **Confirming never touches the graph.** It READS the class's current
 *   pointer, and no path from here reaches `registerBaseGraph`, `insertVersion`
 *   or `movePointer`. It is D3's "the path stays frozen" applied to the intake.
 * - **One transaction for the whole batch.** Every job, every dependency and
 *   every event land together or none does — the same discipline as `createJob`,
 *   nested here as a savepoint.
 *
 * The TABLE and its columns are English since D20's fourth child (t229) and the
 * event-type strings since its second (t227). {@link Draft} is English too, and
 * is the object `/v1` publishes: t286 deleted the alias-and-translate layer
 * between the two. Like the input request and unlike the job and the session,
 * no column of this table was left behind by the glossary — every field here is
 * the column, read under its own name.
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import type { Actor } from '../db/event-validation.ts';
import type { DraftItem } from '../domain/intake.ts';
import { now, jsonOrNull } from './common.ts';
import { createJob, type Job } from './job.ts';

/** The three states of a draft, as the migration's CHECK spells them. */
export type DraftStatus = 'pending' | 'confirmed' | 'discarded';

/**
 * Actor of a confirmation that arrives without one.
 *
 * The gate is human by design, and t124 authenticated the route — but a token
 * proves possession, not which person holds it. Rather than inventing a user,
 * the log honestly records the component that acted, and a caller that knows who
 * is on the other side sends `actor` in the body — the same convention as every
 * other write of this API.
 */
export const INTAKE_ACTOR: Actor = Object.freeze({ type: 'system', ref: 'intake' });

/** Draft projection, as the API returns it. */
export interface Draft {
  id: number;
  project_id: number;
  execution_id: number | null;
  /** Class whose registered graph the breakdown runs over. */
  class: string;
  /** The request in natural language, as it arrived. */
  request: string;
  /**
   * The proposed breakdown, passed through byte for byte.
   *
   * The item's own keys (`ref`, `title`, `depends_on`, …) went English with t255,
   * and the note that used to sit here — that no child of D20 renames them and
   * the glossary maps none of them — is what t255 removed: they are fields of the
   * JSON of `POST /v1/intake`, which is exactly what D20's text migrates. They
   * are mapped in `glossary-wire.md` §1.1 and §1.4 now.
   */
  items: DraftItem[];
  status: DraftStatus;
  /** `ref` → real `job.id`; only after the confirmation. */
  created_jobs: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

interface DraftRow extends Omit<Draft, 'items' | 'created_jobs'> {
  /** JSON in a TEXT column, like every other list this package stores. */
  items: string;
  created_jobs: string | null;
}

/** The columns {@link DraftRow} is made of, each under its own name (t286). */
const COLUMNS = `
  id, project_id, execution_id, class,
  request, items, status,
  created_jobs, created_at,
  updated_at
`;

/**
 * The three statuses a `?status=` filter may name (`glossary-wire.md` §1.6).
 *
 * `migrations/0006_intake.sql` holds them in a `CHECK`, and since D20's fifth
 * child (t235) that `CHECK` is already English — so the list validates a filter
 * and translates nothing.
 */
export const DRAFT_STATUSES: readonly DraftStatus[] = Object.freeze([
  'pending',
  'confirmed',
  'discarded',
]);

/**
 * The `status` a request declared, if the column can hold it.
 *
 * @param value What the query string said.
 * @returns The same word, or `undefined` when the column has no such state.
 */
export function draftStatusColumn(value: string): DraftStatus | undefined {
  return DRAFT_STATUSES.find((status) => status === value);
}

function toDraft(row: DraftRow): Draft {
  return {
    ...row,
    items: JSON.parse(row.items) as DraftItem[],
    created_jobs: jsonOrNull<Record<string, number>>(row.created_jobs),
  };
}

function readRow(db: Database, id: number): DraftRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM intake_draft WHERE id = ?`).get(id) as
    | DraftRow
    | undefined;
}

/**
 * Gets a draft by its projection.
 *
 * @param db Open handle.
 * @param id Draft id.
 * @returns The draft, or `null` if it does not exist.
 */
export function getDraft(db: Database, id: number): Draft | null {
  const row = readRow(db, id);
  return row === undefined ? null : toDraft(row);
}

/** What `createDraft` needs, already validated by the route. */
export interface CreateDraftData {
  project_id: number;
  execution_id: number | null;
  class: string;
  request: string;
  items: DraftItem[];
}

/**
 * Opens a pending draft (FR1).
 *
 * No event and no transaction: one insert, and nothing else in the database
 * depends on it. A draft is a proposal — until somebody confirms it, no
 * traveller exists.
 *
 * @param db Open handle.
 * @param data Class, request and the already normalized items.
 * @returns The draft as it was written.
 */
export function createDraft(db: Database, data: CreateDraftData): Draft {
  const timestamp = now();
  const result = db
    .prepare(
      `INSERT INTO intake_draft (
         project_id, execution_id, class, request, items, status,
         created_jobs, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    )
    .run(
      data.project_id,
      data.execution_id,
      data.class,
      data.request,
      JSON.stringify(data.items),
      timestamp,
      timestamp,
    );

  const draft = getDraft(db, Number(result.lastInsertRowid));
  if (draft === null) throw new Error('the draft was not written');
  return draft;
}

/** Slice of `GET /v1/intake`. */
export interface DraftFilter {
  status?: string;
  class?: string;
  project_id?: number;
}

/**
 * The drafts that exist, in id order (FR6).
 *
 * @param db Open handle.
 * @param filter Optional slices; they add up as AND.
 * @returns Drafts from oldest to newest.
 */
export function listDrafts(db: Database, filter: DraftFilter = {}): Draft[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.status !== undefined) {
    conditions.push('status = ?');
    values.push(filter.status);
  }
  if (filter.class !== undefined) {
    conditions.push('class = ?');
    values.push(filter.class);
  }
  if (filter.project_id !== undefined) {
    conditions.push('project_id = ?');
    values.push(filter.project_id);
  }

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM intake_draft ${where} ORDER BY id`)
    .all(...values) as DraftRow[];
  return rows.map(toDraft);
}

/**
 * Replaces the items of a draft that is still pending (FR5).
 *
 * The list is REPLACED, never merged: an intake that merged would have no way of
 * removing an item somebody gave up on, and "send me the breakdown you want" is
 * a simpler contract than a patch language over a list.
 *
 * @param db Open handle.
 * @param id Draft id.
 * @param itens Already normalized items.
 * @returns The updated draft, or `null` when it stopped being pending.
 */
export function amendDraft(db: Database, id: number, items: DraftItem[]): Draft | null {
  const effect = db
    .prepare(
      `UPDATE intake_draft SET items = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(JSON.stringify(items), now(), id);

  return effect.changes === 1 ? getDraft(db, id) : null;
}

/**
 * Closes the draft without creating anything (FR7).
 *
 * @param db Open handle.
 * @param id Draft id.
 * @returns The discarded draft, or `null` when it stopped being pending.
 */
export function discardDraft(db: Database, id: number): Draft | null {
  const effect = db
    .prepare(
      `UPDATE intake_draft SET status = 'discarded', updated_at = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(now(), id);

  return effect.changes === 1 ? getDraft(db, id) : null;
}

/** What `confirmDraft` needs: the pending draft and the graph as it stands now. */
export interface ConfirmDraftData {
  draft: Draft;
  /** Entry node of the version in force — read by the route from the pointer. */
  initial_node: string;
  /** Version in force, frozen into every job of the batch. */
  graph_version_id: string;
  /** Who confirmed; the human gate's caller when it identifies itself. */
  actor: Actor;
}

/** What a confirmation produces: the closed draft and every job it created. */
export interface Confirmation {
  draft: Draft;
  jobs: Job[];
}

/**
 * The human confirmation gate: one job per item, one row and one event per
 * declared dependency, all in a single transaction (FR9–FR12).
 *
 * The order inside the transaction is not decoration: every job is created
 * FIRST, because a dependency can only be recorded once both ends have real ids
 * — a `ref` is local to the batch and dies here.
 *
 * The dependency is registered and nothing else: the dependent job is NOT
 * blocked (FR14). Enforcing the order of execution is another ticket's problem,
 * and a block nobody knows how to lower would be worse than no block at all.
 *
 * @param db Open handle.
 * @param data Pending draft, entry node and version in force, and the actor.
 * @returns The confirmed draft and the jobs, in the order of the items.
 */
export function confirmDraft(db: Database, data: ConfirmDraftData): Confirmation {
  const { draft } = data;

  const confirm = db.transaction((): Confirmation => {
    const timestamp = now();
    const created: Record<string, number> = {};
    const jobs: Job[] = [];

    for (const item of draft.items) {
      const job = createJob(db, {
        title: item.title,
        body: item.body,
        acceptance_criteria: item.acceptance_criteria,
        // The class's declared fields, filled in at intake (t168). They ride
        // straight through: `validateItems` already judged their shape, and
        // whether the class demands one is the transition gate's question, not
        // the confirmation's — a ticket may perfectly well be born on the entry
        // node with a field the node it later leaves will demand.
        fields: item.fields,
        // The triage the intake session did for free (t175). It rides through
        // the same way `fields` does: `validateItems` already closed the set of
        // values, and what the tier COSTS is the runner's question, one layer
        // out — nothing here translates it into a model.
        tier: item.tier,
        entry_node_id: data.initial_node,
        project_id: draft.project_id,
        execution_id: draft.execution_id,
        graph_version_id: data.graph_version_id,
        actor: data.actor,
      });
      created[item.ref] = job.id;
      jobs.push(job);
    }

    for (const item of draft.items) {
      for (const dependency of item.depends_on) {
        const dependent = created[item.ref];
        const dependedOn = created[dependency];
        db.prepare(
          `INSERT INTO job_dependency (job_id, depends_on_job_id, created_at)
           VALUES (?, ?, ?)`,
        ).run(dependent, dependedOn, timestamp);

        // The subject of the event is the DEPENDENT job: "this one waits for
        // that one" is a fact about whoever waits, and it is in that job's
        // timeline that somebody will look for the reason it has not moved.
        recordEvent(db, {
          type: 'job.dependency_declared',
          project_id: draft.project_id,
          execution_id: draft.execution_id,
          entity: { type: 'job', id: dependent },
          actor: data.actor,
          occurred_at: timestamp,
          data: { depends_on_job_id: dependedOn },
        });
      }
    }

    const effect = db
      .prepare(
        `UPDATE intake_draft SET status = 'confirmed', created_jobs = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(created), timestamp, draft.id);

    // The whole transaction falls if the draft stopped being pending between the
    // route's check and this UPDATE: confirming twice is a 409, never two
    // batches of jobs (FR12/AT14).
    if (effect.changes !== 1) {
      throw new Error(`draft ${draft.id} stopped being pending during the confirmation`);
    }

    return { draft: toDraft(readRow(db, draft.id) as DraftRow), jobs: jobs };
  });

  return confirm();
}
