-- 0010_proposta_aprovada — the human gate enters the vocabulary (t165).
--
-- The screen has offered Approve/Reject since `t111`
-- (`packages/tela/src/public/actions.js`), and it only offers Apply on
-- `approved`. The database did not know that state: `0002`'s CHECK admitted
-- only ('pending', 'applied', 'reverted', 'rejected'), and the apply route
-- demanded `pending`. The result was an unusable inbox — the Apply button
-- appeared in an unreachable state. This migration is the database half of
-- closing that contract:
--
--   pending ──approve──▶ approved ──apply──▶ applied ──revert──▶ reverted
--      │
--      └──reject──▶ rejected
--
-- Two changes, and nothing more:
--
-- - `status` gains `'approved'` in the CHECK;
-- - `proposal` gains `rejection_reason TEXT` (nullable), the justification
--   written by whoever rejected it. It does NOT live in `result`: that column
--   already carries two stories that never coexist — the report of the
--   soundness gate that failed the proposal and the hypothesis verdict
--   (`t112`) — and all three have to stay distinguishable by WHICH column
--   tells the story.
--
-- No backfill, on purpose. The `rejected` rows that already exist came from the
-- soundness gate, not from a person: `rejection_reason = NULL` on them is the
-- truth, and their story stays in `result`, where it always was.
--
-- ## Why the whole table is rebuilt, and why in SIX steps
--
-- SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`: a CHECK only changes by
-- rebuilding the table (create the new one → copy → drop the old → rename).
-- This is the first time this repository does it, and the naive path does NOT
-- work here — it had to be found out the hard way:
--
-- `graph.origin_proposal_id` and `graph_version.proposal_id` reference
-- `proposal`. The control plane turns foreign keys on BEFORE migrating
-- (`applyPragmas` and then `migrate`, in `src/index.ts`), so the `DROP TABLE`
-- performs an implicit DELETE that violates both references. `PRAGMA
-- foreign_keys` does not help: it is a no-op inside a transaction, and what
-- transacts is `src/db/migrate.ts`. And `PRAGMA defer_foreign_keys = ON` — the
-- obvious remedy, and what this migration tried first — does NOT solve it
-- either: the deferred-violation counter goes up on the implicit DELETE and the
-- `RENAME` does not bring it down (it inserts no row at all), so the
-- transaction simply dies at the close instead of dying halfway. A database
-- with a single already-applied proposal would not migrate.
--
-- Hence the two extra steps: the child references are kept in temporary tables
-- and cleared BEFORE the drop, and restored after the rename. With nobody
-- pointing at the table at the instant of the drop, there is no violation to
-- defer and none to resolve. The `graph`/`graph_version` rows end up with
-- exactly the value they had (the ids are copied, not regenerated), which keeps
-- D15's append-only honest: none of them tells a different story at the end of
-- the migration.
--
-- The `proposal_by_graph` index falls with the table and is therefore
-- recreated. The `AUTOINCREMENT` is preserved: with the ids copied explicitly,
-- `sqlite_sequence` carries on from where it stopped, and a new proposal never
-- reuses an old one's id — which matters because `graph_version.proposal_id`
-- points at them.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

-- 1. record who points at a proposal, and release the pointers
CREATE TEMP TABLE reference_graph_version AS
  SELECT id, proposal_id FROM graph_version WHERE proposal_id IS NOT NULL;
CREATE TEMP TABLE reference_graph AS
  SELECT id, origin_proposal_id FROM graph WHERE origin_proposal_id IS NOT NULL;

UPDATE graph_version SET proposal_id = NULL WHERE proposal_id IS NOT NULL;
UPDATE graph SET origin_proposal_id = NULL WHERE origin_proposal_id IS NOT NULL;

-- 2. the new table, with the new vocabulary and the new column
CREATE TABLE proposal_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            TEXT NOT NULL REFERENCES graph(id),
  target_version      TEXT NOT NULL REFERENCES graph_version(id),
  operations          TEXT NOT NULL,   -- JSON: Operation[] (src/domain/operations.ts)
  evidence            TEXT NOT NULL,   -- JSON
  expected_metric     TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'applied', 'reverted', 'rejected')),
  applied_version_id  TEXT REFERENCES graph_version(id),
  revert_reason       TEXT,
  rejection_reason    TEXT,            -- only the human gate writes here (t165)
  result              TEXT,            -- JSON; the soundness gate's report, or the hypothesis verdict
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 3. the copy, with the ids preserved
INSERT INTO proposal_new (id, graph_id, target_version, operations, evidence, expected_metric,
                          status, applied_version_id, revert_reason, rejection_reason,
                          result, created_at, updated_at)
SELECT id, graph_id, target_version, operations, evidence, expected_metric,
       status, applied_version_id, revert_reason, NULL,
       result, created_at, updated_at
  FROM proposal;

-- 4. the swap
DROP TABLE proposal;

ALTER TABLE proposal_new RENAME TO proposal;

CREATE INDEX proposal_by_graph ON proposal (graph_id);

-- 5. the references go back to exactly where they were
UPDATE graph_version
   SET proposal_id = (SELECT proposal_id FROM reference_graph_version
                       WHERE reference_graph_version.id = graph_version.id)
 WHERE id IN (SELECT id FROM reference_graph_version);

UPDATE graph
   SET origin_proposal_id = (SELECT origin_proposal_id FROM reference_graph
                              WHERE reference_graph.id = graph.id)
 WHERE id IN (SELECT id FROM reference_graph);

-- 6. and the support tables do not survive the migration
DROP TABLE reference_graph_version;
DROP TABLE reference_graph;
