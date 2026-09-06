/**
 * Access to the `project` table (t354, FR1).
 *
 * The smallest repository in the package, and the one every other partitioned
 * read now depends on. Before this ticket `project_id` was a constant —
 * `DEFAULT_PROJECT` in `repositories/common.ts` — travelling in the event
 * envelope so telemetry would be born partitionable; there was no row to point
 * at, and `graph` gave the CLASS an index unique across the whole database,
 * which is what D25 (2026-09-05) closes: a class is unique per project, not per
 * database.
 *
 * Three things live here and nothing else does:
 *
 * - **the row is created and listed, never renamed and never removed.** Both
 *   are out of scope by name, and neither is an oversight: the name is what the
 *   screen's switcher and `cartografo --project <name>` address, so moving it is
 *   a decision with consequences outside this file;
 * - **{@link resolveProject} takes an id OR a name**, because the CLI accepts
 *   both and the wire accepts an id. One resolver, so `--project 2` and
 *   `--project second` cannot disagree about which project they mean;
 * - **a duplicate name is the caller's answer, not an exception.**
 *   {@link ProjectNameTaken} carries the name, and `routes/projects.ts` turns it
 *   into the `409` the ficha names. The uniqueness itself is the schema's
 *   (`migrations/0026_project_partition.sql`), so two calls racing cannot both
 *   win — this class is how the loser is told.
 *
 * Like every repository here it receives the already-open database and never
 * touches the driver (D1).
 */

import type { Database } from '../db/connection.ts';
import { recordEvent } from '../db/events.ts';
import { API_ACTOR, now } from './common.ts';

/** A project, as the API publishes it — the row's own three columns. */
export interface Project {
  id: number;
  /** Unique, and what a person switches on. */
  name: string;
  created_at: string;
}

/**
 * The name is already taken.
 *
 * A class of its own rather than a `null` return, because "this name exists" is
 * a different fact from "nothing was written" and the route answers a `409` to
 * exactly one of them.
 */
export class ProjectNameTaken extends Error {
  /** The name that was refused. Not `name`: that one is `Error`'s own. */
  readonly projectName: string;

  constructor(projectName: string) {
    super(`a project named "${projectName}" is already registered`);
    this.name = 'ProjectNameTaken';
    this.projectName = projectName;
  }
}

const COLUMNS = 'id, name, created_at';

/**
 * @param db Open database.
 * @param id Project id.
 * @returns The project, or `undefined` when there is none.
 */
export function getProject(db: Database, id: number): Project | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM project WHERE id = ?`).get(id) as Project | undefined;
}

/**
 * @param db Open database.
 * @param name Project name, exactly as it was registered.
 * @returns The project, or `undefined`.
 */
export function getProjectByName(db: Database, name: string): Project | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM project WHERE name = ?`).get(name) as
    | Project
    | undefined;
}

/**
 * @param db Open database.
 * @returns Every project, in id order — which is also declaration order.
 */
export function listProjects(db: Database): Project[] {
  return db.prepare(`SELECT ${COLUMNS} FROM project ORDER BY id`).all() as Project[];
}

/**
 * The project a raw scope names, whether it came as an id or as a name.
 *
 * The two are told apart by SHAPE and not by trying one and falling back to the
 * other: a project literally named `2` would otherwise be reachable by accident
 * from a caller that meant the id, and the ambiguity would only show up the day
 * somebody chose that name. A run of digits is an id; anything else is a name.
 *
 * @param db Open database.
 * @param raw What the caller said: a number, a numeric string or a name.
 * @returns The project, or `undefined` when nothing answers to it.
 */
export function resolveProject(db: Database, raw: number | string): Project | undefined {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? getProject(db, raw) : undefined;
  }
  return /^[0-9]+$/.test(raw) ? getProject(db, Number(raw)) : getProjectByName(db, raw);
}

/**
 * Writes a project, and the fact that it was written, in one transaction.
 *
 * The event's `project_id` is the NEW project's own id, not the default: a
 * project's birth belongs to the project that was born, which is what keeps
 * `GET /v1/events?project_id=2` a complete account of project 2 rather than an
 * account missing its first line.
 *
 * @param db Open database.
 * @param name Name, already trimmed and known non-empty by the route.
 * @returns The project as it was written.
 * @throws {ProjectNameTaken} When the name is already registered.
 */
export function createProject(db: Database, name: string): Project {
  if (getProjectByName(db, name) !== undefined) throw new ProjectNameTaken(name);

  const createdAt = now();

  const id = db.transaction((): number => {
    const result = db
      .prepare('INSERT INTO project (name, created_at) VALUES (?, ?)')
      .run(name, createdAt);
    const written = Number(result.lastInsertRowid);

    recordEvent(db, {
      type: 'project.created',
      project_id: written,
      execution_id: null,
      entity: { type: 'project', id: written },
      actor: API_ACTOR,
      occurred_at: createdAt,
      data: { name },
    });

    return written;
  })();

  const project = getProject(db, id);
  if (project === undefined) throw new Error(`project "${name}" was not written`);
  return project;
}
