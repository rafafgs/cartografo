-- 0006_intake — the two-phase intake: draft, confirmation, dependency.
--
-- Renumbered from 0005 to 0006 at the merge: 0005_skill (t117/t135) reached
-- main first, and `src/db/migrate.ts` fails loudly on a repeated number. No
-- dependency order between the two — this one only touches `job` and creates
-- tables of its own.
--
-- D3 separates two acts of the meta-process: synthesizing a topology produces
-- NODES (once per class) and breaking work down produces TICKETS (once per
-- execution). This migration is the second half: a breakdown draft that exists
-- before any `job` does, and that only becomes work after a human confirms it
-- (README, principle 5, applied to the breakdown of work — never to the graph).
--
-- Three changes, and the reason for each:
--
-- - `job.corpo` and `job.criterios_de_aceite`. The event taxonomy already
--   anticipated a job with content (the `job.amended` example cites fields
--   0003 never created). The criteria the intake records are PRELIMINARY: what
--   really produces them is factory graph 1's `refinar` node, out of the raw
--   request. NULL and [] are different things — "nobody has written a
--   criterion yet" is not "I declared that there is none".
--   The two names stay in Portuguese because §4.2 of the glossary does not
--   record them, and t235 does not invent vocabulary outside the glossary.
-- - `job_dependency`. An edge between two jobs of the same batch, declared at
--   confirmation. RECORD only: nothing here blocks the dependent job while the
--   dependency is open (t122, FR14). The CHECK forbids the self-reference the
--   domain validator already rejects earlier — two lines of defence against
--   the same absurdity.
-- - `intake_draft`. Storage for work in progress, not an audit fact: no event
--   is emitted when the draft is created, edited or discarded. The log only
--   gains a row when the `job` rows are actually born.
--
-- `items` and `created_jobs` are JSON in a TEXT column, as `session.usage` and
-- `input_request.options` already are: the item's format has not frozen yet
-- (the rule of two consumers) and normalizing it into a table would cost one
-- migration per new draft field.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

ALTER TABLE job ADD COLUMN corpo TEXT;
ALTER TABLE job ADD COLUMN criterios_de_aceite TEXT; -- JSON: string[]; NULL != []

CREATE TABLE job_dependency (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  depends_on_job_id INTEGER NOT NULL REFERENCES job(id),
  created_at        TEXT NOT NULL,
  CHECK (job_id != depends_on_job_id)
);
CREATE UNIQUE INDEX idx_job_dependency_pair ON job_dependency (job_id, depends_on_job_id);
CREATE INDEX idx_job_dependency_job ON job_dependency (job_id);

CREATE TABLE intake_draft (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  execution_id  INTEGER,
  class         TEXT NOT NULL,
  request       TEXT NOT NULL,
  items         TEXT NOT NULL, -- JSON: {ref, title, body?, acceptance_criteria?, depends_on?}[]
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'discarded')),
  created_jobs  TEXT,          -- JSON: {[ref]: job_id}, only after the confirmation
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_intake_draft_status  ON intake_draft (status);
CREATE INDEX idx_intake_draft_project ON intake_draft (project_id);
