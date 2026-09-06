/**
 * Access to the `setting` table (t403, FR1/FR2).
 *
 * The first project-scoped key/value surface in the schema: every other
 * per-project row is a domain entity (`job`, `lease`, `hook_occurrence`), never
 * a plain configuration value. What lives here is the local runner's three
 * defaults — workspace root, worktrees root, engine — so a later one-command
 * startup never has to ask for `--working-dir`/`--worktrees-root` on the
 * terminal (RF-08).
 *
 * `KNOWN_SETTING_KEYS` is where v0's closed vocabulary lives, the same way
 * `MODEL_ORIGINS` lives in `engine-models.ts` rather than in a migration
 * `CHECK`: a fourth key (the check-screen ticket) is a code change here, not a
 * migration.
 *
 * Like every other repository it receives the already-open database and never
 * touches the driver (D1).
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** The only three keys v0 accepts anywhere. */
export const KNOWN_SETTING_KEYS: readonly string[] = Object.freeze([
  'workspace_root',
  'worktrees_root',
  'engine',
]);

/**
 * Seeds a project's defaults, without ever overwriting a key already there.
 *
 * One `INSERT OR IGNORE` per key of `defaults`, so a key already present —
 * inserted by an earlier startup, or since changed by `PATCH /v1/settings` —
 * is left untouched. Idempotent by construction: a second call with the same
 * `defaults` after the first key has changed leaves the change in place, which
 * is exactly what a restart's re-seed depends on.
 *
 * @param db Open database.
 * @param projectId Project the settings belong to (D25).
 * @param defaults One value per key to seed, when the key does not exist yet.
 */
export function seedDefaultSettings(
  db: Database,
  projectId: number,
  defaults: Record<string, string>,
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO setting (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
  );
  const timestamp = now();
  for (const [key, value] of Object.entries(defaults)) {
    insert.run(projectId, key, value, timestamp);
  }
}

/**
 * Every setting of one project, as a flat object.
 *
 * @param db Open database.
 * @param projectId Project to read.
 * @returns `{key: value, ...}` for every row of that project — `{}` when the
 *   project has none yet.
 */
export function getSettings(db: Database, projectId: number): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM setting WHERE project_id = ?')
    .all(projectId) as Array<{ key: string; value: string }>;

  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

/**
 * Updates a project's settings, all-or-nothing.
 *
 * Every key of `patch` is checked against {@link KNOWN_SETTING_KEYS} BEFORE
 * anything is written — the same ordering discipline as `readReport`
 * (`routes/engines.ts`): a patch whose second key is unknown must leave the
 * first key's old value in place, so validating up front is what makes that
 * true instead of leaving it to which key an upsert loop happens to reach
 * first.
 *
 * @param db Open database.
 * @param projectId Project to update.
 * @param patch One value per key to write.
 * @returns The project's settings after the write ({@link getSettings}).
 * @throws {Error} On the first key of `patch` that is not in
 *   {@link KNOWN_SETTING_KEYS}.
 */
export function updateSettings(
  db: Database,
  projectId: number,
  patch: Record<string, string>,
): Record<string, string> {
  for (const key of Object.keys(patch)) {
    if (!KNOWN_SETTING_KEYS.includes(key)) {
      throw new Error(`unknown setting key: "${key}" (known keys: ${KNOWN_SETTING_KEYS.join(', ')})`);
    }
  }

  const upsert = db.prepare(
    `INSERT INTO setting (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const timestamp = now();
  for (const [key, value] of Object.entries(patch)) {
    upsert.run(projectId, key, value, timestamp);
  }

  return getSettings(db, projectId);
}
