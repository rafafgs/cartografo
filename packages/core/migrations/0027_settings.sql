-- 0027_settings — a project-scoped key/value surface for the local runner's
-- defaults (t403, RF-08).
--
-- Written as `0026` and renumbered to `0027` at the merge with t354, which took
-- `0026_project_partition.sql` first: two tickets each adding a migration is the
-- conflict git does not report, and `src/db/migrate.ts` fails loudly on a
-- repeated number. Same precedent as the headers of 0003, 0005, 0017, 0019, 0022
-- and 0026.
--
-- Every per-project row that existed before this migration is a domain entity
-- (`job`, `lease`, `hook_occurrence`) — never a plain configuration value. The
-- one-command local startup (a later ticket) needs somewhere to keep the local
-- runner's three defaults — workspace root, worktrees root, engine — so it
-- never has to ask for `--working-dir`/`--worktrees-root` on the terminal, and
-- this table is where those go.
--
-- `project_id` scopes the table to a project rather than to the whole database
-- (D25): `DEFAULT_PROJECT` (`repositories/common.ts`) is the whole system's
-- project default today, which is what makes "project 1" the correct,
-- uncontroversial scope for v0.
--
-- No `CHECK` on `key`, unlike `0017_trabalho_tier.sql`'s closed vocabulary: v0's
-- known-key list (`workspace_root`, `worktrees_root`, `engine`) lives in
-- `src/repositories/settings.ts`'s `KNOWN_SETTING_KEYS`, the same way
-- `MODEL_ORIGINS` lives in `engine-models.ts` rather than in a migration
-- `CHECK` — a fourth key is a code change here, not a migration.
--
-- `PRIMARY KEY (project_id, key)`: one row per key per project, and the same
-- pair `INSERT ... ON CONFLICT` upserts against.
--
-- No foreign key to a `project` table. t354's `0026_project_partition.sql` did
-- create one, and it deliberately left `job`, `lease`, `intake_draft`,
-- `webhook_subscription`, `hook_delivery` and `event` carrying `project_id` as a
-- plain column: only the five tables whose KEYS had to widen got the reference.
-- `setting` is in the first group — its key is already `(project_id, key)` and
-- nothing about it needs the schema to enforce the parent — so it stays where
-- the majority of project-scoped tables are, and adding the reference is a
-- later, deliberate sweep rather than this ticket's business.
--
-- English top to bottom: the t279 frozen-names rule protects the pre-existing
-- Portuguese migration files, and this one is new (2026-08-18 language mandate).
--
-- No migration opens a transaction of its own: src/db/migrate.ts is what transacts.

CREATE TABLE setting (
  project_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
