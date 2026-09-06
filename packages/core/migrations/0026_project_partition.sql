-- 0026_project_partition — a project becomes a row, and a class becomes unique
-- inside one (D25, t354, RF-05 part 1).
--
-- Numbered 0026 provisionally: 0025 is HEAD today and other tickets run in
-- parallel, so renumbering at the merge is mandatory rather than cosmetic —
-- `src/db/migrate.ts` fails loudly on a repeated number, the same precedent
-- recorded in the headers of 0003, 0005, 0017, 0019 and 0022.
--
-- ## What this migration is for
--
-- Until now `project_id` was a LABEL. Six tables carried the column (`job`,
-- `lease`, `intake_draft`, `webhook_subscription`, `hook_delivery`, `event`),
-- nothing referenced a project, and no project existed to reference: the value
-- was the constant `1` from `src/repositories/common.ts`. Meanwhile `graph`
-- was born with `id = class` under a UNIQUE index on `(class)`, which made the
-- class a name of the DATABASE. Two projects could not both hold
-- `software-development`, and no amount of filtering later would have fixed
-- that — it is a key, not a query.
--
-- D25 (2026-09-05, Rafael) closes it: a class is unique per project, not per
-- database. So this file does two things and they are one thing:
--
-- 1. `project` exists, with a name a person can switch on at the screen, and
--    row `1` is called `default`;
-- 2. `graph`, `graph_version`, `proposal`, `skill` and `hook_secret` carry
--    `project_id`, every existing row is backfilled onto project `1`, and the
--    keys that used to be global become composite.
--
-- ## Two tables that are deliberately NOT partitioned
--
-- `credential` and `engine_model` stay exactly as they are, and the omission is
-- a decision rather than an oversight:
--
-- - a credential is either the operator's one bearer or a runner's pairing, and
--   `docs/spec/runner-and-controller.md` §1 says plainly that "the runner is not
--   scoped to a project; pairing is identity alone". A `project_id NOT NULL`
--   here would make the thing that PROVES pairing carry a fixed project, and
--   would give the operator one token per project, which nothing asks for;
-- - `engine_model` is written by a runner reporting which models its own engine
--   exposes, at discovery time, before any project is ever declared. It is a
--   fact about a machine.
--
-- `session`, `input_request`, `webhook_delivery` and `job_dependency` are not
-- here either, for the opposite reason: they inherit the partition through a
-- foreign key and resolve it by reading their owner, which is D25's own rule.
--
-- ## Why the keys are COMPOSITE and not surrogate
--
-- `graph.id` keeps meaning exactly what it means today — the class, for a base
-- lineage; the caller's chosen string, for a variant — and `graph_version.id`
-- stays the snapshot hash (`docs/spec/graph.md` §2). What widens is the KEY:
-- `(project_id, id)`. A surrogate integer was rejected because `graph_id` and
-- `target_version` are already written into the append-only event log as
-- strings (`specs/events/taxonomy.md`, "Graph version"), and a type change on a
-- field that is already history is worse than a widening D20 would have
-- recreated a database for.
--
-- Every foreign key between the three tables carries `project_id` with it, so a
-- reference can never cross a project boundary silently — a version's parent,
-- a proposal's target and a lineage's current pointer are all inside the
-- project that owns them. Two of those the ficha did not name and the schema
-- forces: `graph.current_version_id` and the rest of the pointers referenced
-- `graph_version(id)`, which stops being a unique key the moment the primary
-- key widens, so SQLite would answer `foreign key mismatch` on the first write.
-- They become composite for the same reason as the rest.
--
-- `skill`'s key goes from `(id, version)` to `(project_id, id, version)`: two
-- projects importing the same factory bundle must both be able to register
-- `refine-ticket@1.0.0`, and D4's "one version never names two bodies" is a
-- rule about a registry, which is now per project.
--
-- `hook_secret` needs no key change — its primary key is already a surrogate
-- autoincrement — but its PARTIAL UNIQUE INDEX does: "at most one live secret
-- per name" becomes "per name, per project", or project 2 registering a name
-- would be refused by project 1's row. `proposal_dedupe_key_pending_unique`
-- moves for the same reason: a repeated signal strengthens the pending proposal
-- of ITS project (D21), never somebody else's.
--
-- ## Why the rebuild is shaped like this
--
-- SQLite alters neither a PRIMARY KEY nor a foreign key: the only path is
-- create → copy → drop → rename. `graph`, `graph_version` and `proposal`
-- reference each other in a CYCLE, and the control plane turns foreign keys ON
-- before migrating (`applyPragmas` then `migrate`, in `src/index.ts`), so a
-- naive drop performs an implicit DELETE that violates the other two. 0010
-- found out the hard way that `PRAGMA defer_foreign_keys` does not save this:
-- it is a no-op inside a transaction, and what transacts is the runner.
--
-- So the whole cycle is emptied before any table is dropped: the rows are
-- stashed in TEMP tables, the nullable cross-pointers are released, and the
-- three tables are cleared child-first. With nobody pointing at anything, the
-- drops are free. Repopulating runs the same way in reverse — parents first,
-- pointers restored last — which is the only order that satisfies every
-- reference at the instant it is written.
--
-- `AUTOINCREMENT` survives on `proposal` because the ids are copied explicitly:
-- `sqlite_sequence` follows the maximum written, and `graph_version.proposal_id`
-- points at those ids.
--
-- `event.entity_type` gains `'project'`, the same one-CHECK rebuild 0022 did
-- for `'execution'`. Nothing references `event`, so that one is the short path.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

-- ---------------------------------------------------------------------------
-- 1. The project itself.
-- ---------------------------------------------------------------------------

CREATE TABLE project (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,   -- what the operator switches on at the screen
  created_at  TEXT NOT NULL
);

-- Row 1 is `default`, and every row that existed before this migration lands on
-- it. The instant is the migration's own, which is the honest answer to "when
-- did this project come into being" for a database that always had exactly one.
INSERT INTO project (id, name, created_at)
VALUES (1, 'default', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- ---------------------------------------------------------------------------
-- 2. hook_secret — a column, a real reference and a re-scoped index.
-- ---------------------------------------------------------------------------

-- The ficha called for `ALTER TABLE ... ADD COLUMN project_id INTEGER NOT NULL
-- REFERENCES project(id) DEFAULT 1`, and SQLite refuses it outright: "Cannot
-- add a REFERENCES column with non-NULL default value". The choice is between
-- a column with no foreign key at all and the rebuild every other table here
-- already does, and the rebuild wins — the reference is the point, and this is
-- the short version of it, because nothing references `hook_secret` (0019 and
-- 0022 took the same path for the same reason).
--
-- The column carries NO default afterwards, which is the same posture `job` and
-- `lease` have: what a write means is the caller's to say, not the schema's to
-- guess (`src/repositories/hook-secrets.ts` states it on every insert).
CREATE TABLE hook_secret_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES project(id),
  name        TEXT NOT NULL,   -- the name destination.secret_ref references
  value       TEXT NOT NULL,   -- the raw HMAC key; reused on every delivery
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

INSERT INTO hook_secret_new (id, project_id, name, value, created_at, revoked_at)
SELECT id, 1, name, value, created_at, revoked_at FROM hook_secret;

DROP TABLE hook_secret;

ALTER TABLE hook_secret_new RENAME TO hook_secret;

-- At most one LIVE secret per name PER PROJECT. Without the project in here,
-- two projects could never hold the same `secret_ref`, and the very first thing
-- a second project does — import the same factory bundle — would be refused.
CREATE UNIQUE INDEX idx_hook_secret_name_alive
  ON hook_secret (project_id, name) WHERE revoked_at IS NULL;

CREATE INDEX idx_hook_secret_project ON hook_secret (project_id);

-- ---------------------------------------------------------------------------
-- 3. skill — the key widens; nobody references this table.
-- ---------------------------------------------------------------------------

CREATE TABLE skill_new (
  project_id     INTEGER NOT NULL REFERENCES project(id),
  id             TEXT NOT NULL,
  version        TEXT NOT NULL,
  hash           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('work', 'gate')),
  description    TEXT NOT NULL,
  input          TEXT NOT NULL,   -- JSON
  output         TEXT NOT NULL,   -- JSON
  preconditions  TEXT NOT NULL,   -- JSON array
  checks         TEXT NOT NULL,   -- JSON array
  permissions    TEXT NOT NULL,   -- JSON
  instructions   TEXT NOT NULL,
  command        TEXT,            -- JSON: {argv, env_allowlist?}; NULL = not a shell skill
  source         TEXT NOT NULL,   -- JSON: {type, repo?, ref?, imported_by?, imported_at?, reviewed_by?}
  registered_at  TEXT NOT NULL,
  deprecated_at  TEXT,            -- NULL = a live version; first write wins
  PRIMARY KEY (project_id, id, version)
);

INSERT INTO skill_new (project_id, id, version, hash, role, description, input, output,
                       preconditions, checks, permissions, instructions, command, source,
                       registered_at, deprecated_at)
SELECT 1, id, version, hash, role, description, input, output,
       preconditions, checks, permissions, instructions, command, source,
       registered_at, deprecated_at
  FROM skill;

DROP TABLE skill;

ALTER TABLE skill_new RENAME TO skill;

CREATE INDEX idx_skill_project ON skill (project_id);

-- ---------------------------------------------------------------------------
-- 4. The cycle: graph -> graph_version -> proposal -> graph.
-- ---------------------------------------------------------------------------

-- 4a. Everything is stashed BEFORE anything is released, because releasing is
-- what destroys the values these copies restore.
CREATE TEMP TABLE stash_graph AS SELECT * FROM graph;
CREATE TEMP TABLE stash_graph_version AS SELECT * FROM graph_version;
CREATE TEMP TABLE stash_proposal AS SELECT * FROM proposal;

-- 4b. Release every nullable cross-pointer, so the deletes below violate nothing.
UPDATE graph SET current_version_id = NULL, origin_proposal_id = NULL;
UPDATE graph_version SET parent_version = NULL, proposal_id = NULL;
UPDATE proposal SET applied_version_id = NULL;

-- 4c. Empty the cycle child-first. What is left NOT NULL — `graph_version.graph_id`,
-- `proposal.graph_id`, `proposal.target_version` — is satisfied at every step
-- because the table holding the reference is emptied before its parent is.
DELETE FROM proposal;
DELETE FROM graph_version;
DELETE FROM graph;

DROP TABLE proposal;
DROP TABLE graph_version;
DROP TABLE graph;

-- 4d. The three tables again, with the project in every key and in every
-- reference between them.
CREATE TABLE graph (
  project_id          INTEGER NOT NULL REFERENCES project(id),
  id                  TEXT NOT NULL,              -- class, for the base lineage (D8)
  class               TEXT NOT NULL,
  lineage_type        TEXT NOT NULL CHECK (lineage_type IN ('base', 'variant')),
  base_class          TEXT,                       -- variant only (D13)
  origin_proposal_id  INTEGER REFERENCES proposal(id),
  current_version_id  TEXT,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, current_version_id) REFERENCES graph_version(project_id, id),
  CHECK (
    (lineage_type = 'base' AND base_class IS NULL)
    OR (lineage_type = 'variant' AND base_class IS NOT NULL)
  )
);

-- A class has at most ONE base graph INSIDE A PROJECT (D25). Variants of the
-- same class are left out of the index on purpose, as they always were.
CREATE UNIQUE INDEX graph_class_base_unique
  ON graph (project_id, class) WHERE lineage_type = 'base';

CREATE INDEX idx_graph_project ON graph (project_id);

CREATE TABLE graph_version (
  project_id      INTEGER NOT NULL REFERENCES project(id),
  id              TEXT NOT NULL,          -- sha256:<64 hex> of the canonical snapshot
  graph_id        TEXT NOT NULL,
  parent_version  TEXT,
  snapshot        TEXT NOT NULL,          -- the whole graph document, canonicalized
  source          TEXT NOT NULL CHECK (source IN ('manual', 'synthesizer', 'proposal')),
  proposal_id     INTEGER REFERENCES proposal(id),
  created_at      TEXT NOT NULL,
  contracts_state TEXT NOT NULL DEFAULT 'unchecked'
                    CHECK (contracts_state IN ('checked', 'unchecked', 'failed')),
  contracts_report TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, graph_id) REFERENCES graph(project_id, id),
  -- A version's parent is always in the same project: forking and applying
  -- never cross one. The parenthood may still cross LINEAGES, which is what
  -- makes a D13 fork a branch rather than a copy.
  FOREIGN KEY (project_id, parent_version) REFERENCES graph_version(project_id, id)
);

CREATE INDEX graph_version_by_graph ON graph_version (project_id, graph_id);

CREATE INDEX idx_graph_version_project ON graph_version (project_id);

CREATE TABLE proposal (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES project(id),
  graph_id            TEXT NOT NULL,
  target_version      TEXT NOT NULL,
  operations          TEXT NOT NULL,   -- JSON: Operation[] (src/domain/operations.ts)
  evidence            TEXT NOT NULL,   -- JSON
  expected_metric     TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'applied', 'reverted', 'rejected')),
  applied_version_id  TEXT,
  revert_reason       TEXT,
  rejection_reason    TEXT,            -- only the human gate writes here (t165)
  result              TEXT,            -- JSON; the soundness gate's report, or the hypothesis verdict
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  dedupe_key          TEXT,
  FOREIGN KEY (project_id, graph_id) REFERENCES graph(project_id, id),
  FOREIGN KEY (project_id, target_version) REFERENCES graph_version(project_id, id),
  FOREIGN KEY (project_id, applied_version_id) REFERENCES graph_version(project_id, id)
);

CREATE INDEX proposal_by_graph ON proposal (project_id, graph_id);

CREATE INDEX idx_proposal_project ON proposal (project_id);

-- Deduplication is scoped to a pending proposal OF ITS PROJECT: the same signal
-- reaching two projects opens two hypotheses, because they are about two
-- different graphs that happen to share a name.
CREATE UNIQUE INDEX proposal_dedupe_key_pending_unique
  ON proposal (project_id, dedupe_key)
  WHERE status = 'pending';

-- 4e. Repopulate, parents first and pointers last, which is the only order in
-- which every reference is already satisfiable when it is written.
INSERT INTO graph (project_id, id, class, lineage_type, base_class,
                   origin_proposal_id, current_version_id, created_at)
SELECT 1, id, class, lineage_type, base_class, NULL, NULL, created_at
  FROM stash_graph;

INSERT INTO graph_version (project_id, id, graph_id, parent_version, snapshot, source,
                           proposal_id, created_at, contracts_state, contracts_report)
SELECT 1, id, graph_id, NULL, snapshot, source, NULL, created_at,
       contracts_state, contracts_report
  FROM stash_graph_version;

INSERT INTO proposal (id, project_id, graph_id, target_version, operations, evidence,
                      expected_metric, status, applied_version_id, revert_reason,
                      rejection_reason, result, created_at, updated_at, dedupe_key)
SELECT id, 1, graph_id, target_version, operations, evidence,
       expected_metric, status, NULL, revert_reason,
       rejection_reason, result, created_at, updated_at, dedupe_key
  FROM stash_proposal;

UPDATE graph_version
   SET parent_version = (SELECT parent_version FROM stash_graph_version
                          WHERE stash_graph_version.id = graph_version.id),
       proposal_id    = (SELECT proposal_id FROM stash_graph_version
                          WHERE stash_graph_version.id = graph_version.id);

UPDATE proposal
   SET applied_version_id = (SELECT applied_version_id FROM stash_proposal
                              WHERE stash_proposal.id = proposal.id);

UPDATE graph
   SET current_version_id = (SELECT current_version_id FROM stash_graph
                              WHERE stash_graph.id = graph.id),
       origin_proposal_id = (SELECT origin_proposal_id FROM stash_graph
                              WHERE stash_graph.id = graph.id);

-- 4f. The scaffolding does not survive the migration.
DROP TABLE stash_graph;
DROP TABLE stash_graph_version;
DROP TABLE stash_proposal;

-- ---------------------------------------------------------------------------
-- 5. The log admits the new subject.
-- ---------------------------------------------------------------------------

CREATE TABLE event_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  project_id  INTEGER NOT NULL,
  execution_id INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job','session','input_request','lease','graph_version','execution','project')),
  entity_id   TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_ref   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data        TEXT NOT NULL
);

INSERT INTO event_new (id, type, project_id, execution_id, entity_type, entity_id,
                       actor_type, actor_ref, occurred_at, data)
SELECT id, type, project_id, execution_id, entity_type, entity_id,
       actor_type, actor_ref, occurred_at, data
  FROM event;

DROP TABLE event;

ALTER TABLE event_new RENAME TO event;

CREATE INDEX idx_event_entity     ON event (entity_type, entity_id);
CREATE INDEX idx_event_execution  ON event (execution_id);
CREATE INDEX idx_event_project    ON event (project_id);
