-- 0001_init — control table of the migration runner itself.
--
-- The only table of this scaffold: the domain schema (graph, graph_version,
-- proposal, event, session, input_request) arrives with the tickets that
-- follow, in D6's order.
--
-- No migration opens a transaction of its own: what transacts is
-- `src/db/migrate.ts`, one transaction per migration.

CREATE TABLE schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
