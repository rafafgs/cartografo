-- 0002_grafo_versao_proposta — D15's git-like versioning in three tables.
--
-- graph is the LINEAGE (class, lineage type, pointer to the current version);
-- graph_version is the immutable snapshot, addressed by the hash of its own
-- content; proposal is the hypothesis: typed semantic operations with an
-- inverse, evidence and the metric it is expected to move.
--
-- Append-only by construction: no code path deletes or overwrites a row of
-- graph_version. Reverting moves graph.current_version_id; the abandoned
-- version stays right here, which is what keeps the history whole and makes
-- the version x telemetry join possible later (D15).
--
-- The column names (graph_id, parent_version, source, proposal_id, reason)
-- copy verbatim the event schemas already specified under
-- specs/events/schemas/, so that emitting telemetry (t102) is a direct
-- mapping rather than a translation. This migration does NOT create the event
-- table: that one belongs to t102.
--
-- The file NAME stays in Portuguese and the CONTENT speaks English: t235
-- rewrote the eighteen migrations in place (D20 recreates the development
-- database, it does not migrate it) and left the file names where they were,
-- because a dozen tests and `test/support.ts` cite the migration by name and
-- renaming it brings the schema closer to nothing.
--
-- The references between the three tables are circular (graph -> graph_version ->
-- proposal -> graph). SQLite does not require the referenced table to exist
-- already at CREATE TABLE, so the order below is documentation. No migration
-- opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE graph (
  id                  TEXT PRIMARY KEY,          -- class, for the base lineage (D8)
  class               TEXT NOT NULL,
  lineage_type        TEXT NOT NULL CHECK (lineage_type IN ('base', 'variant')),
  base_class          TEXT,                       -- variant only (D13, t118 — not exercised in this ticket)
  origin_proposal_id  INTEGER REFERENCES proposal(id),
  current_version_id  TEXT REFERENCES graph_version(id),
  created_at          TEXT NOT NULL,
  CHECK (
    (lineage_type = 'base' AND base_class IS NULL)
    OR (lineage_type = 'variant' AND base_class IS NOT NULL)
  )
);

-- A class has at most ONE base graph; variants of the same class (t118) are
-- left out of the index on purpose.
CREATE UNIQUE INDEX graph_class_base_unique ON graph (class) WHERE lineage_type = 'base';

CREATE TABLE graph_version (
  id              TEXT PRIMARY KEY,       -- sha256:<64 hex> of the canonical snapshot
  graph_id        TEXT NOT NULL REFERENCES graph(id),
  parent_version  TEXT REFERENCES graph_version(id),
  snapshot        TEXT NOT NULL,          -- the whole graph document, canonicalized
  source          TEXT NOT NULL CHECK (source IN ('manual', 'synthesizer', 'proposal')),
  proposal_id     INTEGER REFERENCES proposal(id),
  created_at      TEXT NOT NULL
);

CREATE INDEX graph_version_by_graph ON graph_version (graph_id);

CREATE TABLE proposal (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            TEXT NOT NULL REFERENCES graph(id),
  target_version      TEXT NOT NULL REFERENCES graph_version(id),
  operations          TEXT NOT NULL,   -- JSON: Operation[] (src/domain/operations.ts)
  evidence            TEXT NOT NULL,   -- JSON
  expected_metric     TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'applied', 'reverted', 'rejected')),
  applied_version_id  TEXT REFERENCES graph_version(id),
  revert_reason       TEXT,
  result              TEXT,            -- JSON; the rejection report here, the hypothesis result in t112
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX proposal_by_graph ON proposal (graph_id);
