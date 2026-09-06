-- 0028_runner_probe — what a paired machine reports about itself, and the
-- operator's request that it report again (t401, FR1/FR4).
--
-- Number provisional in the ticket and kept here: another ticket landing `0028`
-- first is the conflict git does not report, and `src/db/migrate.ts` fails
-- loudly on a repeated number. Renumber at the merge, the way the headers of
-- 0003, 0005, 0017, 0019, 0022, 0026 and 0027 already record.
--
-- `GET /v1/runners` answered pairing and lease health and nothing about whether
-- the paired machine can actually run a session. These two tables are the other
-- half: a runner reports its `CliProbe`, what its MCP discovery found (or the
-- honest "this engine does not implement discovery") and a handful of workspace
-- facts, and an operator can ask a specific machine to refresh that report
-- without restarting its process.
--
-- **No `project_id` on either table**, and D25's own migration
-- (`0026_project_partition.sql`, "Two tables that are deliberately NOT
-- partitioned") already drew this line for `engine_model`: a fact a runner
-- reports about its own machine, before any project is meaningfully in play, is
-- not a per-project entity. A probe is a fact about a machine; a recheck is a
-- request about a machine.
--
-- **One row per runner, replaced whole.** `runner_id` is the PRIMARY KEY, which
-- is what `INSERT ... ON CONFLICT DO UPDATE` upserts against — the same shape
-- `setting` already has. Historizing probes is deliberately out of scope:
-- nothing asks for a probe history, and `engine_model`'s "replaces, never
-- merges" argues against inventing one speculatively.
--
-- **`mcp_supported` is a column of its own, beside `mcp_servers`.** An adapter
-- that does not implement `discoverMcpServers()` is NOT an engine with zero MCP
-- servers (`packages/runner/src/engine/types.ts`), and a schema that stored
-- only the list would have no way left to tell the two apart. `mcp_servers`
-- carries `'[]'` in the unsupported case and the repository never reads it
-- there.
--
-- Booleans are bare `INTEGER NOT NULL` with no `CHECK`, matching `job.blocked`'s
-- own precedent (`0003_trabalho_sessao_evento_pergunta.sql`) rather than
-- inventing a stricter convention nothing else in this schema uses.
--
-- The recheck index is on `(runner_id, served_at)` because every read of that
-- table asks the same question: is there a row for THIS runner that nobody has
-- served yet.
--
-- English top to bottom: the t279 frozen-names rule protects the pre-existing
-- Portuguese migration files, and this one is new (2026-08-18 language mandate).
--
-- No migration opens a transaction of its own: src/db/migrate.ts is what transacts.

CREATE TABLE runner_probe (
  runner_id                 TEXT PRIMARY KEY REFERENCES runner(id),
  cli_available             INTEGER NOT NULL,
  cli_version               TEXT,
  cli_authenticated         INTEGER NOT NULL,
  mcp_supported             INTEGER NOT NULL,
  mcp_servers               TEXT NOT NULL DEFAULT '[]', -- JSON array of {name}
  mcp_origin                TEXT CHECK (mcp_origin IN ('cli', 'file')),
  mcp_resolved_at           TEXT,
  working_dir               TEXT NOT NULL,
  working_dir_resolved      TEXT NOT NULL,
  is_git_repo               INTEGER NOT NULL,
  worktrees_root            TEXT NOT NULL,
  worktrees_root_resolved   TEXT NOT NULL,
  worktrees_root_exists     INTEGER NOT NULL,
  worktrees_root_writable   INTEGER NOT NULL,
  reported_at               TEXT NOT NULL
);

CREATE TABLE runner_recheck (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id    TEXT NOT NULL REFERENCES runner(id),
  requested_at TEXT NOT NULL,
  served_at    TEXT
);

CREATE INDEX idx_runner_recheck_pending ON runner_recheck (runner_id, served_at);
