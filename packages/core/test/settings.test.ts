/**
 * Acceptance tests of the settings repository (t403, FR1/FR2).
 *
 * `setting` is the first project-scoped key/value table in the schema: every
 * other per-project row is a domain entity (`job`, `lease`, `hook_occurrence`),
 * never a plain configuration value. What this file proves is the shape of the
 * three functions the repository exports, with no HTTP in front of them —
 * `test/settings-routes.test.ts` is where the routes are exercised.
 *
 * The module is loaded on demand, behind an `existsSync`, for the same reason
 * as `test/credentials.test.ts`: on the initial red the failure has to NAME the
 * missing artifact instead of blowing up with a module resolution error.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as SettingsModule from '../src/repositories/settings.ts';
import { MIGRATIONS_DIR, requireArtifacts } from './support.ts';

/** Artifacts this file exercises. */
const T403_ARTIFACTS = Object.freeze({
  migration: 'migrations/0026_settings.sql',
  repository: 'src/repositories/settings.ts',
});

/** The slice of `node:test`'s context this file uses. */
interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

/** A migrated, throwaway database — no HTTP: this file is about the repository. */
async function openMigrated(t: TestHook): Promise<Database> {
  requireArtifacts(T403_ARTIFACTS.migration, T403_ARTIFACTS.repository);

  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t403-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return db;
}

async function loadRepository(): Promise<typeof SettingsModule> {
  return await load<typeof SettingsModule>(T403_ARTIFACTS.repository);
}

const DEFAULTS = Object.freeze({
  workspace_root: '/home/operator/.cartografo/workspace',
  worktrees_root: '/home/operator/.cartografo/worktrees',
  engine: 'claude-code',
});

test('t403 AT1 — seedDefaultSettings inserts exactly the given rows, and getSettings reads them flat', async (t) => {
  const db = await openMigrated(t);
  const { seedDefaultSettings, getSettings } = await loadRepository();

  seedDefaultSettings(db, 1, { ...DEFAULTS });

  const rows = db
    .prepare('SELECT project_id, key, value FROM setting WHERE project_id = ? ORDER BY key')
    .all(1) as Array<{ project_id: number; key: string; value: string }>;
  assert.deepEqual(
    rows,
    [
      { project_id: 1, key: 'engine', value: 'claude-code' },
      { project_id: 1, key: 'workspace_root', value: DEFAULTS.workspace_root },
      { project_id: 1, key: 'worktrees_root', value: DEFAULTS.worktrees_root },
    ],
    'exactly the three rows passed in, for the given project_id — nothing more',
  );

  assert.deepEqual(getSettings(db, 1), { ...DEFAULTS }, 'a flat object, not projection rows');
  assert.deepEqual(getSettings(db, 2), {}, 'a project with no rows yet returns {}');
});

test('t403 AT2 — a second seed after updateSettings changed a key leaves the changed value in place', async (t) => {
  const db = await openMigrated(t);
  const { seedDefaultSettings, updateSettings, getSettings } = await loadRepository();

  seedDefaultSettings(db, 1, { ...DEFAULTS });
  updateSettings(db, 1, { engine: 'codex' });

  // Simulates the NEXT startup calling seedDefaultSettings again with the same
  // defaults: INSERT OR IGNORE must never overwrite what PATCH already changed.
  seedDefaultSettings(db, 1, { ...DEFAULTS });

  assert.deepEqual(
    getSettings(db, 1),
    { ...DEFAULTS, engine: 'codex' },
    'the seed is idempotent: a key already present is left untouched',
  );
});

test('t403 AT3 — updateSettings with one unknown key alongside a valid one writes NEITHER', async (t) => {
  const db = await openMigrated(t);
  const { seedDefaultSettings, updateSettings, getSettings } = await loadRepository();

  seedDefaultSettings(db, 1, { ...DEFAULTS });

  assert.throws(
    () => updateSettings(db, 1, { engine: 'codex', nonsense: 'x' }),
    undefined,
    'a patch with an unknown key has to throw before writing anything',
  );

  assert.deepEqual(
    getSettings(db, 1),
    { ...DEFAULTS },
    'the valid key\'s old value is unchanged after the call throws',
  );
});

test('t403 AT4 — updateSettings with only valid keys updates just those, and returns all three current values', async (t) => {
  const db = await openMigrated(t);
  const { seedDefaultSettings, updateSettings, getSettings } = await loadRepository();

  seedDefaultSettings(db, 1, { ...DEFAULTS });
  const before = db
    .prepare('SELECT value, updated_at FROM setting WHERE project_id = 1 AND key = ?')
    .get('workspace_root') as { value: string; updated_at: string };

  const result = updateSettings(db, 1, { engine: 'codex' });

  assert.deepEqual(
    result,
    { ...DEFAULTS, engine: 'codex' },
    'the return value reflects all three current values',
  );
  assert.deepEqual(getSettings(db, 1), { ...DEFAULTS, engine: 'codex' });

  const after = db
    .prepare('SELECT value, updated_at FROM setting WHERE project_id = 1 AND key = ?')
    .get('workspace_root') as { value: string; updated_at: string };
  assert.deepEqual(after, before, 'the untouched key\'s value AND updated_at are left alone');
});

test('t403 — KNOWN_SETTING_KEYS names exactly the three v0 accepts', async () => {
  const { KNOWN_SETTING_KEYS } = await loadRepository();
  assert.deepEqual([...KNOWN_SETTING_KEYS].sort(), ['engine', 'workspace_root', 'worktrees_root']);
});
