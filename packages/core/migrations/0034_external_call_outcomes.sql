-- 0034_external_call_outcomes — how a delivery ends, in more words than two
-- (t371, FR3/FR5/FR6; RF-35, RF-36).
--
-- t370 declared `outcome TEXT CHECK (outcome IN ('ok','error'))` and wrote in
-- its own header that widening it might be t371's to do. It is: the way OUT
-- has three endings that are neither of those two, and reading any of them as
-- `ok` would make the log claim a call that never left this machine.
--
-- * `skipped_duplicate` — an identical delivery for this job, this node and this
--   name already succeeded, so nothing was sent (RF-35). The row exists because
--   the DECISION is a fact worth having: "nobody called anybody" and "somebody
--   looked, found the delivery already made, and stood down" are different
--   things to read six weeks later.
-- * `skipped_by_person` — an `unsafe_to_retry` step did not finish cleanly, and
--   the person who was asked said to abandon this output (RF-36).
-- * `marked_done_by_person` — same question, and the person said the delivery
--   had in fact landed. The row it closes is the attempt itself: no second row
--   invents a call nobody made.
--
-- **A rebuild, and it could not be anything else.** SQLite cannot ALTER a
-- CHECK, so the table is recreated, copied, dropped and renamed — the shape
-- `0010`, `0019`, `0022` and `0026` already use in this schema. `PRAGMA
-- foreign_keys` is OFF for the whole migration run (`applyPragmas` then
-- `migrate`, `src/index.ts`), which is what makes a `DROP TABLE` of a
-- referenced table safe here and nowhere else.
--
-- **And the constraint does not come back.** The vocabulary is validated in
-- `src/repositories/external-calls.ts` from now on, which is `setting.key`'s
-- own posture: a value list in SQL is a value list that costs a table rebuild
-- every time somebody adds a word to it, and this is the second ticket in a row
-- to pay for that. `direction` keeps its CHECK — that one is a closed axis
-- (something comes in, or something goes out) and no third value is coming.
--
-- Both indexes are recreated, and that is not housekeeping: t371's whole
-- idempotency story is one lookup on
-- `(job_id, node_id, name, direction)` per attempt, and a rebuild that dropped
-- it would degrade the check into a table scan nobody would notice until a job
-- had a thousand calls behind it.
--
-- Nothing is deleted and nothing is rewritten: every existing row is copied
-- column for column, and `ok`/`error` still mean exactly what they meant.
--
-- English top to bottom (2026-08-18 language mandate).
--
-- No migration opens a transaction of its own: src/db/migrate.ts is what transacts.

CREATE TABLE external_call_new (
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
  outcome           TEXT,
  result_summary    TEXT
);

INSERT INTO external_call_new
  (id, job_id, node_id, direction, name, server, tool, arguments_sha256,
   arguments_summary, started_at, finished_at, outcome, result_summary)
SELECT
   id, job_id, node_id, direction, name, server, tool, arguments_sha256,
   arguments_summary, started_at, finished_at, outcome, result_summary
FROM external_call;

DROP TABLE external_call;

ALTER TABLE external_call_new RENAME TO external_call;

CREATE INDEX idx_external_call_job ON external_call (job_id);

CREATE INDEX idx_external_call_lookup ON external_call (job_id, node_id, name, direction);
