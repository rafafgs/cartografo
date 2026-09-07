-- 0030_artifacts — the reference the database keeps to a file a session
-- produced (t422, FR4; RF-38/RF-42, D25 wave 3 item 4).
--
-- Number 0030 and not the numerically next 0029: branch `ticket-359` already
-- claims `0029_delivery_claim.sql`, and `src/db/migrate.ts` fails loudly on a
-- repeated number. Renumber at the merge if the order moved, the way the headers
-- of 0003, 0005, 0017, 0019, 0022, 0026, 0027 and 0028 already record.
--
-- **The bytes are not here.** The row carries `storage_ref`, an opaque content
-- address an `ArtifactStore` produced (`src/artifacts/store.ts`), and nothing
-- else about where the file is: a BLOB column would put megabytes in the way of
-- every `SELECT *` this schema has, and a path column would freeze one
-- implementation's layout into the data. `storage_ref` is also the ONE column
-- that never reaches `/v1` — see `src/repositories/artifacts.ts`.
--
-- **No `project_id`, deliberately.** D25 drew this line in
-- `0026_project_partition.sql`: a table that inherits the partition through a
-- foreign key is filtered through its owner and never gains the column. An
-- artifact belongs to a session, and a session's project lives on its own
-- `session.opened` event (`sessionProject`, t157) — the same resolution
-- `GET /v1/sessions/:id/transcript` already makes.
--
-- **No paired event**, and for a different reason than `runner_probe`'s (which
-- is replaced rather than historized): this table is append-only by
-- construction. Nothing updates a row and nothing deletes one, ever (RF-42), so
-- there is no state transition left for an event to record. The fact that an
-- artifact was created IS the row.
--
-- Two indexes, one per question anybody asks: every artifact of a session (the
-- listing route) and every row with a given digest (the dedupe lookup a caller
-- makes before deciding whether it already has this content).
--
-- English top to bottom (2026-08-18 language mandate). No migration opens a
-- transaction of its own: src/db/migrate.ts is what transacts.

CREATE TABLE artifact (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES session(id),
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_artifact_session ON artifact (session_id);

CREATE INDEX idx_artifact_sha256 ON artifact (sha256);
