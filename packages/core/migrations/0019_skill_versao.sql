-- 0019_skill_versao — a skill becomes a lineage, like the graph (D22, D15).
--
-- Numbered 0019 provisionally: other tickets run in parallel and
-- `src/db/migrate.ts` fails loudly on a repeated number, so renumbering at the
-- merge is mandatory, not cosmetic — the same precedent recorded in the headers
-- of 0003, 0005 and 0017 (which tells of the third time it happened). No
-- dependency order: this one only touches `skill`.
--
-- 0005 wrote down, in its own header, what this migration comes to undo:
-- "Registration is create-only in this ticket — a second POST on the same id is
-- a 409. Reimport, diff and skill version history (the equivalent of the
-- graph/graph_version pair) wait until two consumers exist, by the rule of two
-- consumers." The two consumers turned up — improving the instructions of a
-- factory skill, and reimporting an already-registered bundle — and D22
-- recorded the decision: "a skill has a stable id and versions (semver plus a
-- content hash)... a node stays pinned by hash (D4) and never resolves 'the
-- latest one'".
--
-- ## What changes, and what deliberately does not
--
-- - the PRIMARY KEY goes from `id` to `(id, version)`. That is the whole
--   change: a lineage is the set of rows that share an `id`, the same way
--   `graph_version` is the set of versions that share a `graph_id`;
-- - `deprecated_at` arrives nullable, without backfill. NULL = a live version,
--   and it is the truth for every row older than this migration: nobody retired
--   anything. First write wins, the same posture as `registered_at` — retiring
--   twice does not rewrite when it happened;
-- - `hash` does NOT gain a uniqueness constraint, and the absence is a
--   decision. The content hash excludes `id` and `version` on purpose
--   (`src/domain/manifest.ts`: renaming a skill does not change what it does),
--   so two rows with DIFFERENT (id, version) may legitimately carry the same
--   hash — a new version with identical content is useless, but it is not
--   illegal, and policing that is human judgement, not a database invariant.
--   What the registry refuses is the opposite: DIFFERENT content under an
--   unchanged version, and that refusal lives in `src/repositories/skill.ts`,
--   where there is room to explain why.
--
-- ## Why the table is recreated
--
-- SQLite does not alter an existing table's PRIMARY KEY — only by rebuilding it
-- (create the new one → copy → drop the old → rename), the same path 0010
-- opened to change a CHECK. Here it is shorter than there for a concrete
-- reason: nobody references `skill`. There is no foreign key pointing at it
-- (the node's pin lives INSIDE `graph_version`'s snapshot, as JSON, which is
-- exactly what keeps the graph version readable after anything at all happens
-- in the registry), so there is no step of saving and restoring child
-- references, the one 0010 had to find out the hard way. No index falls along
-- with it: 0005 created none.
--
-- The copy changes no value at all: every row already has an `id` and a
-- `version`, and the one new column is born NULL.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE skill_new (
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
  source         TEXT NOT NULL,   -- JSON: {type, repo?, ref?, imported_by?, imported_at?, reviewed_by?}
  registered_at  TEXT NOT NULL,
  deprecated_at  TEXT,            -- NULL = a live version; first write wins
  PRIMARY KEY (id, version)
);

INSERT INTO skill_new (id, version, hash, role, description, input, output, preconditions,
                       checks, permissions, instructions, source, registered_at, deprecated_at)
SELECT id, version, hash, role, description, input, output, preconditions,
       checks, permissions, instructions, source, registered_at, NULL
  FROM skill;

DROP TABLE skill;

ALTER TABLE skill_new RENAME TO skill;
