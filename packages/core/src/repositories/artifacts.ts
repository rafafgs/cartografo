/**
 * Artifact repository — the reference to a file a session produced (t422, FR5).
 *
 * The row and the bytes are two different stores and this module is the seam:
 * the content goes to an {@link ArtifactStore} (`src/artifacts/store.ts`), which
 * answers an opaque `ref`, and the row keeps that ref beside the facts a client
 * asks about — name, media type, size, digest. Nothing here knows what a
 * directory is, and the store knows nothing about a session.
 *
 * ## `storage_ref` never reaches the wire
 *
 * It is the one column {@link Artifact} does not carry. Publishing it would tie
 * `/v1`'s contract to whichever `ArtifactStore` happens to be configured — a
 * client that learned to read a sha256 out of it would break the day a second
 * implementation answers a URL or an object key. A client asks for
 * `GET /v1/artifacts/:id/content`; where that content lives is the server's
 * business (RF-38).
 *
 * ## Scoping, and why it is a foreign key and not a column
 *
 * `artifact` has no `project_id`. It inherits the partition through
 * `session_id`, which is D25's own rule for a table that hangs off a partitioned
 * one, and the project of a session is what {@link sessionProject} reads off its
 * `session.opened` event (t157) — never a join through a job the session may not
 * have. So every read here takes an optional `projectId` and answers `null` when
 * the owning session belongs to somebody else: the SAME `null` an unknown id
 * gets, because a reference may not cross a project boundary and a distinct code
 * would leak which ids are taken elsewhere (t411, `routes/sessions.ts`).
 *
 * ## Append-only, with no verb for the other direction
 *
 * There is no update and no delete, and there never will be (RF-42): an artifact
 * is evidence of what a session did. `docs/spec/artifacts.md` says so where
 * somebody looking for the missing function will find it.
 */

import type { Readable } from 'node:stream';

import type { ArtifactStore } from '../artifacts/store.ts';
import type { Database } from '../db/connection.ts';
import { now } from './common.ts';
import { sessionProject } from './session.ts';

/** The stored artifact, and exactly what `/v1` publishes. */
export interface Artifact {
  id: number;
  session_id: number;
  /** The name the producer gave the file — `report.md`, `screenshot.png`. */
  name: string;
  /** Media type as declared on the way in; nothing here interprets it. */
  media_type: string;
  /** Size in bytes, as stored. */
  size: number;
  /** Hex sha256 of the content — a fact about the file, unlike `storage_ref`. */
  sha256: string;
  created_at: string;
}

/** The row, which is {@link Artifact} plus the column that stays home. */
interface ArtifactRow extends Artifact {
  storage_ref: string;
}

/** Everything the wire gets, in the order the migration declares it. */
const PUBLIC_COLUMNS = 'id, session_id, name, media_type, size, sha256, created_at';

/** ...and the read that also needs to reach the bytes. */
const ROW_COLUMNS = `${PUBLIC_COLUMNS}, storage_ref`;

/** What `POST /v1/sessions/:id/artifacts` hands over. */
export interface CreateArtifactInput {
  name: string;
  mediaType: string;
  buffer: Buffer;
}

/** The bytes of an artifact, with what the response needs to describe them. */
export interface ArtifactContent {
  stream: Readable;
  media_type: string;
  size: number;
}

/**
 * Stores the bytes and records the reference to them.
 *
 * The store is written to BEFORE the row exists, and that order is deliberate:
 * content with no row is an orphan file nobody can reach, which the next
 * identical upload silently adopts (the store is content-addressed, so it costs
 * one entry and no duplication); a row with no content is a `/content` route
 * that 500s forever. Between the two failure modes only one is recoverable, and
 * this is it.
 *
 * @param db Open handle.
 * @param sessionId Session that produced the file.
 * @param input Name, media type and the whole content.
 * @param store Where the bytes go.
 * @returns The stored artifact, or `null` if the session does not exist.
 */
export async function createArtifact(
  db: Database,
  sessionId: number,
  input: CreateArtifactInput,
  store: ArtifactStore,
): Promise<Artifact | null> {
  const session = db.prepare('SELECT id FROM session WHERE id = ?').get(sessionId) as
    | { id: number }
    | undefined;
  if (session === undefined) return null;

  const stored = await store.put(input.buffer, { name: input.name, mediaType: input.mediaType });

  const inserted = db
    .prepare(
      `INSERT INTO artifact (session_id, name, media_type, size, sha256, storage_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, input.name, input.mediaType, stored.size, stored.sha256, stored.ref, now());

  const artifact = getArtifact(db, Number(inserted.lastInsertRowid));
  if (artifact === null) throw new Error(`the artifact of session ${sessionId} was not written`);
  return artifact;
}

/**
 * Reads an artifact's metadata.
 *
 * @param db Open handle.
 * @param id Artifact id.
 * @param projectId Scope of the caller; omitted, any project answers.
 * @returns The artifact, or `null` if it does not exist in the scope asked for.
 */
export function getArtifact(db: Database, id: number, projectId?: number): Artifact | null {
  const row = db.prepare(`SELECT ${PUBLIC_COLUMNS} FROM artifact WHERE id = ?`).get(id) as
    | Artifact
    | undefined;
  if (row === undefined) return null;
  return inScope(db, row.session_id, projectId) ? row : null;
}

/**
 * Opens an artifact's bytes.
 *
 * `media_type` and `size` come back with the stream because the route needs both
 * headers and the store deliberately knows neither: what it holds is content,
 * and the content of two identical uploads is one file with two names.
 *
 * @param db Open handle.
 * @param id Artifact id.
 * @param store Where the bytes are.
 * @param projectId Scope of the caller; omitted, any project answers.
 * @returns The stream and its two headers, or `null` under the same scoping as
 *   {@link getArtifact}.
 */
export function getArtifactContent(
  db: Database,
  id: number,
  store: ArtifactStore,
  projectId?: number,
): ArtifactContent | null {
  const row = db.prepare(`SELECT ${ROW_COLUMNS} FROM artifact WHERE id = ?`).get(id) as
    | ArtifactRow
    | undefined;
  if (row === undefined) return null;
  if (!inScope(db, row.session_id, projectId)) return null;

  return { stream: store.open(row.storage_ref), media_type: row.media_type, size: row.size };
}

/**
 * Every artifact of one session, oldest first.
 *
 * `null` and `[]` are different answers, exactly as `getSessionTranscript`
 * already distinguishes them: a session that exists and uploaded nothing has an
 * empty list, and a session that does not exist — or exists in another project —
 * has no list at all. Collapsing the two would turn a typo, or a boundary, into
 * the conclusion that a session produced nothing.
 *
 * @param db Open handle.
 * @param sessionId Session to list.
 * @param projectId Scope of the caller; omitted, any project answers.
 * @returns The artifacts, or `null` when the session is not there to be listed.
 */
export function listSessionArtifacts(
  db: Database,
  sessionId: number,
  projectId?: number,
): Artifact[] | null {
  const session = db.prepare('SELECT id FROM session WHERE id = ?').get(sessionId) as
    | { id: number }
    | undefined;
  if (session === undefined) return null;
  if (!inScope(db, sessionId, projectId)) return null;

  return db
    .prepare(`SELECT ${PUBLIC_COLUMNS} FROM artifact WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as Artifact[];
}

/**
 * Does the session that owns this row belong to the caller's project?
 *
 * @param db Open handle.
 * @param sessionId The owning session.
 * @param projectId Scope of the caller; `undefined` means "any", which is what
 *   an internal caller with no request behind it gets.
 * @returns Whether the read may go through.
 */
function inScope(db: Database, sessionId: number, projectId?: number): boolean {
  return projectId === undefined || sessionProject(db, sessionId) === projectId;
}
