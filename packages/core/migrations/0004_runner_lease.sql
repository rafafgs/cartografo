-- 0004_runner_lease — D5's runner/lease pair.
--
-- "Dispatched work carries a lease; a dead runner expires and the work goes
-- back to the queue. Idempotent writes on the API" (D5). runner is the identity
-- of the process that executes; lease is a runner's temporary right over one
-- job, with a deadline of its own (expires_at) renewed by heartbeat.
--
-- The lease state lives on the server because only the control plane writes to
-- the database (D1): the runner is a pure HTTP client and never opens this
-- file. That is what makes the concurrency cap hold for the whole project
-- rather than per process.
--
-- job_id is deliberately LOOSE, with no FK. The original reason was build order
-- (the `job` table is t102's delivery, which has landed in 0003 by now), but
-- the cut still holds for the design reason: this route treats job_id as an
-- opaque integer and never reads the `job` table. What decides whether a job is
-- eligible is GET /v1/jobs, queried by the controller BEFORE it asks for the
-- lease; this table only records who took what, and until when. Tightening the
-- FK is additive and belongs to the ticket that wires the two sides together.
--
-- The column names copy the event schemas already specified under
-- specs/events/schemas/lease.*.schema.json (runner_id, job_id,
-- expires_at, reason), so that wiring telemetry up is a direct mapping rather
-- than a translation. This migration does NOT create the event table: that one
-- belongs to t102 (0003).
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE runner (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  registered_at TEXT NOT NULL
);

CREATE TABLE lease (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id         TEXT NOT NULL REFERENCES runner(id),
  job_id            INTEGER NOT NULL, -- loose on purpose: `job` is t102's
  project_id        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released', 'expired')),
  ttl_seconds       INTEGER NOT NULL,
  granted_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT,
  expiration_reason TEXT CHECK (expiration_reason IN ('heartbeat_lost', 'ttl_elapsed'))
);

-- The three indexes are the three hot read paths of dispatch: counting a
-- runner's active leases (runner_cap), counting a project's (project_cap) and
-- finding out whether the job already has an owner.
CREATE INDEX idx_lease_runner_status  ON lease (runner_id, status);
CREATE INDEX idx_lease_project_status ON lease (project_id, status);
CREATE INDEX idx_lease_job_status     ON lease (job_id, status);
