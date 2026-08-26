-- 0003 — job, session, event and input_request.
--
-- Numbered 0003, not 0002: t101 (graph/graph_version/proposal) landed on main
-- first and took 0002. `src/db/migrate.ts` fails loudly on a repeated number,
-- so renumbering at the merge is mandatory, not cosmetic.
--
-- `event` is the source of truth (t98): append-only, no update and no delete.
-- The other three tables are a PROJECTION — current state, always rebuildable
-- from the log by `specs/events/reducers/reconstruct-state.mjs`.
-- When the two disagree, the one that is wrong is the projection.
--
-- Two absences on purpose:
--
-- - there is no "execution" table. `execution_id` is an opaque INTEGER
--   grouper; the taxonomy never listed execution as a valid `entity.type`
--   (`specs/events/schemas/envelope.schema.json:41`);
-- - `job.graph_version_id` has no FK. The `graph_version` table belongs to
--   t101, which runs in parallel, and its id is a hash (string, D15) — pinning
--   the FK here would couple the build order of the two tickets and gain
--   nothing.
--
-- Two columns of `job` are born in Portuguese and stay that way: `corpo` and
-- `criterios_de_aceite` (0006) have no row in §4.2 of the glossary, and
-- inventing a name outside the glossary is the opposite of what t213 exists to
-- do. Closing them means adding those rows there plus a short migration — a
-- ticket of its own.
--
-- No migration opens a transaction of its own: what transacts is
-- `src/db/migrate.ts`, one transaction per migration.

CREATE TABLE event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  project_id  INTEGER NOT NULL,
  execution_id INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job','session','input_request','lease','graph_version')),
  entity_id   TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_ref   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX idx_event_entity     ON event (entity_type, entity_id);
CREATE INDEX idx_event_execution  ON event (execution_id);
CREATE INDEX idx_event_project    ON event (project_id);

CREATE TABLE job (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  execution_id      INTEGER,
  title             TEXT NOT NULL,
  entry_node_id     TEXT NOT NULL,
  current_node_id   TEXT NOT NULL,
  blocked           INTEGER NOT NULL DEFAULT 0,
  block_reason      TEXT,
  graph_version_id  TEXT, -- loose on purpose: graph_version is t101's, no FK so the build order stays uncoupled
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_job_execution ON job (execution_id);
CREATE INDEX idx_job_project   ON job (project_id);

CREATE TABLE session (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER REFERENCES job(id),
  execution_id       INTEGER,
  node_id            TEXT,
  engine             TEXT NOT NULL,
  engine_session_ref TEXT,
  working_dir        TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  timeout_seconds    INTEGER,
  -- No CHECK: the terminal values come from `session.finished`, whose
  -- vocabulary belongs to the event taxonomy and not to this table. `open` is
  -- the only one born here, and it is the same English as the `session.opened`
  -- event (glossary §1.6).
  status             TEXT NOT NULL DEFAULT 'open',
  exit_code          INTEGER,
  usage              TEXT, -- JSON; NULL != recording zeros
  opened_at          TEXT NOT NULL,
  finished_at        TEXT
);
CREATE INDEX idx_session_job        ON session (job_id);
CREATE INDEX idx_session_execution  ON session (execution_id);

CREATE TABLE input_request (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES job(id),
  session_id      INTEGER REFERENCES session(id),
  execution_id    INTEGER,
  kind            TEXT NOT NULL CHECK (kind IN ('question','approval')),
  question        TEXT NOT NULL,
  context         TEXT,
  options         TEXT, -- JSON array
  recommendation  TEXT,
  default_answer  TEXT,
  auto_approvable INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  answer          TEXT,
  answered_by     TEXT,
  source          TEXT CHECK (source IN ('user','auto')),
  created_at      TEXT NOT NULL,
  answered_at     TEXT
);
CREATE INDEX idx_input_request_job              ON input_request (job_id);
CREATE INDEX idx_input_request_execution_status ON input_request (execution_id, status);
