-- 0038_job_relations — the parent link and the cancellation of a job (t636).
--
-- Two facts the core could not record until now, each in a table of its own and
-- neither as a column on `job`: a column would widen `JobRow`, `COLUMNS` and the
-- residual-column guard for something most jobs never carry, and both facts are
-- written once and never updated, which is what a row of their own says.
--
-- - `job_parent`. Which job opened this one, from which node, and in which
--   position among that parent's children (1-based, assigned by the control
--   plane in the creation transaction). One row per child at most: the job's id
--   is the primary key. The CHECK forbids the self-reference; the unique index
--   makes two children sharing one position impossible rather than unlikely.
-- - `job_cancellation`. The job was cancelled, why, and — for a cancel that
--   cascaded down from a parent — which job cascaded to it. The primary key on
--   `job_id` is what makes a second cancellation of one job impossible.
--
-- Nothing derived is stored here: whether a job is HELD (an open dependency, an
-- open child, a cancellation) is computed at read time in `domain/job-state.ts`.
-- Existing jobs get no row in either table. No backfill.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE job_parent (
  job_id           INTEGER PRIMARY KEY REFERENCES job(id),
  parent_job_id    INTEGER NOT NULL REFERENCES job(id),
  parent_node_id   TEXT NOT NULL,
  sibling_position INTEGER NOT NULL CHECK (sibling_position >= 1),
  created_at       TEXT NOT NULL,
  CHECK (job_id != parent_job_id)
);
CREATE UNIQUE INDEX idx_job_parent_position ON job_parent (parent_job_id, sibling_position);

CREATE TABLE job_cancellation (
  job_id                  INTEGER PRIMARY KEY REFERENCES job(id),
  reason                  TEXT,
  cascaded_from_job_id    INTEGER REFERENCES job(id),
  cancelled_at            TEXT NOT NULL
);
