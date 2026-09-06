-- 0032_external_calls — every call this system makes to an MCP server, and what
-- came back (t370, FR6; RF-37, input half).
--
-- Number checked against the queue rather than assumed: `0029_delivery_claim`
-- is claimed by ticket-359, `0030_artifacts` by t422 and
-- `0031_transcript_artifact` by t424, each in its own ticket's declared conflict
-- surface. `0032` is the next nobody has spoken for. Renumber at the merge if
-- one of those three lands differently — `src/db/migrate.ts` fails loudly on a
-- repeated number, which is the check this comment exists to survive.
--
-- **One row per call, updated once.** The intent is written BEFORE the call and
-- completed after it, and that is the crash-safety property the whole shape
-- exists for: a runner that dies mid-call leaves `finished_at`, `outcome` and
-- `result_summary` NULL, and "unknown" is what a READER concludes from three
-- NULLs well after `started_at`. Nothing in this system ever writes that string.
-- Append-only in `lease`'s sense — never deleted — and not in the stricter sense
-- of never updated, which no table of this schema has ever meant.
--
-- **No `project_id`.** The partition is inherited through `job`, which carries
-- it directly (D25, `0026_project_partition.sql`); the same posture t422 takes
-- for `artifact.session_id` and `session` has always taken for its own rows.
--
-- **`direction` carries both values from the start.** This ticket only ever
-- writes `'input'` — fetching what a node declared it needs. Writing a node's
-- OUTPUT back to a server is t371, and having the value in the CHECK now is what
-- spares that ticket a migration whose only content would be widening a
-- constraint. It may still need one to widen `outcome`, which is noted here for
-- that ticket's own refinement rather than guessed at now.
--
-- **The summaries are summaries.** RF-37 asks for "what arguments, what
-- summarised result", never the payload: `arguments_sha256` is what identifies a
-- call exactly, and the two `*_summary` columns are truncated by the route
-- before the write. A schema that could hold the whole result would eventually
-- hold a credential somebody put in an argument.
--
-- Two indexes. `job_id` is the listing route's, and it is the only read this
-- ticket performs. `(job_id, node_id, name, direction)` is t371's idempotency
-- lookup — declared now because the column shape is frozen now, and adding an
-- index to a table that already has rows costs a migration nobody wanted.
--
-- No paired event: the table IS the record (RF-37), the same posture
-- `runner_probe` took in t401.
--
-- English top to bottom (2026-08-18 language mandate); the t279 frozen-names
-- rule protects the pre-existing Portuguese migrations, and this one is new.
--
-- No migration opens a transaction of its own: src/db/migrate.ts is what transacts.

CREATE TABLE external_call (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  node_id           TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  name              TEXT NOT NULL,
  server            TEXT NOT NULL,
  tool              TEXT NOT NULL,
  arguments_sha256  TEXT NOT NULL,
  arguments_summary TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  outcome           TEXT CHECK (outcome IN ('ok', 'error')),
  result_summary    TEXT
);

CREATE INDEX idx_external_call_job ON external_call (job_id);

CREATE INDEX idx_external_call_lookup ON external_call (job_id, node_id, name, direction);
