/**
 * Acceptance tests for recording the capability a session was asked for
 * (t1282, FR11/FR12).
 *
 * The runner posts `capability` when the node's spec carries one, and the
 * control plane keeps it next to what the session ran on: `capability` is what
 * was ASKED for, `models` (written at finish) is what RAN, and the two are
 * allowed to differ. `null` means nobody asked, which is also what every row
 * from before the column reads as.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyPragmas, openDatabase } from '../src/db/connection.ts';
import { listMigrations, migrate } from '../src/db/migrate.ts';
import { loadEvents, request, startControlPlane, type Session, type TestContext } from './support.ts';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'migrations');

/** The session as this ticket publishes it: the projection, plus the capability. */
interface AskingSession extends Session {
  capability: 'general' | 'advanced' | null;
}

const BODY = {
  execution_id: 9,
  engine: 'claude-code',
  working_dir: '/tmp/cartografo',
  prompt: 'write the note',
};

async function open(
  ctx: TestContext,
  extra: Record<string, unknown>,
): Promise<{ status: number; body: AskingSession }> {
  return await request<AskingSession>(ctx, 'POST', '/v1/sessions', { ...BODY, ...extra });
}

async function listed(ctx: TestContext): Promise<AskingSession[]> {
  const response = await request<{ sessions: AskingSession[] }>(
    ctx,
    'GET',
    '/v1/sessions?execution_id=9',
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.sessions;
}

test('t1282 AT26 — a session opened with a capability carries it in the projection and the event', async (t) => {
  const ctx = await startControlPlane(t);

  const opened = await open(ctx, { capability: 'advanced' });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.capability, 'advanced', 'the answer to the POST');

  const found = (await listed(ctx)).find((session) => session.id === opened.body.id);
  assert.equal(found?.capability, 'advanced', 'GET /v1/sessions');

  const { getEventsByEntity } = await loadEvents();
  const event = getEventsByEntity(ctx.db, 'session', opened.body.id).find(
    (entry) => entry.type === 'session.opened',
  );
  assert.ok(event, 'a session.opened event exists');
  assert.equal((event.data as Record<string, unknown>).capability, 'advanced');
});

test('t1282 AT27 — a session opened without one reads capability null', async (t) => {
  const ctx = await startControlPlane(t);

  const opened = await open(ctx, {});
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.capability, null);

  const found = (await listed(ctx)).find((session) => session.id === opened.body.id);
  assert.equal(found?.capability, null);

  const { getEventsByEntity } = await loadEvents();
  const event = getEventsByEntity(ctx.db, 'session', opened.body.id).find(
    (entry) => entry.type === 'session.opened',
  );
  assert.equal(
    (event?.data as Record<string, unknown>).capability,
    null,
    'an absent optional key normalizes to null in the event, like every other optional field',
  );
});

test('t1282 AT28 — a capability outside the two is refused and writes no row', async (t) => {
  const ctx = await startControlPlane(t);
  const before = (ctx.db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;

  const refused = await open(ctx, { capability: 'turbo' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));

  const after = (ctx.db.prepare('SELECT COUNT(*) AS n FROM session').get() as { n: number }).n;
  assert.equal(after, before, 'no session row was written');
});

test('t1282 AT29 — migration 0039 adds a nullable capability column and old rows read null', (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1282-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const all = listMigrations(MIGRATIONS_DIR);
  const added = all.find((migration) => migration.number === 39);
  assert.ok(added, 'artifact does not exist yet: packages/core/migrations/0039_session_capability.sql');
  assert.match(added.file, /^0039_session_capability\.sql$/);
  const sql = readFileSync(added.path, 'utf8');
  assert.doesNotMatch(sql, /\b(BEGIN|COMMIT|ROLLBACK)\b/i, 'the runner is what transacts');

  const upToPrevious = path.join(base, 'up-to-previous');
  mkdirSync(upToPrevious);
  for (const migration of all.filter((entry) => entry.number < 39)) {
    writeFileSync(path.join(upToPrevious, migration.file), readFileSync(migration.path, 'utf8'));
  }

  const db = openDatabase(path.join(base, 'cartografo.db'));
  t.after(() => db.close());
  applyPragmas(db);
  migrate(db, upToPrevious);

  const columns = (): Array<{ name: string; notnull: number; dflt_value: string | null }> =>
    db.prepare('PRAGMA table_info(session)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
  assert.equal(columns().some((column) => column.name === 'capability'), false, 'not there yet');

  db.prepare(
    `INSERT INTO session (engine, working_dir, prompt, status, opened_at)
     VALUES ('claude-code', '/tmp/old', 'written before 0039', 'completed', '2026-11-01T00:00:00.000Z')`,
  ).run();

  migrate(db, MIGRATIONS_DIR);

  const column = columns().find((entry) => entry.name === 'capability');
  assert.ok(column, 'the column exists after the migration');
  assert.equal(column.notnull, 0, 'nullable');
  assert.equal(column.dflt_value, null, 'no default: nobody asked is not "general"');

  const row = db.prepare('SELECT capability FROM session WHERE prompt = ?').get(
    'written before 0039',
  ) as { capability: string | null };
  assert.equal(row.capability, null, 'a row from before the column reads null, with no backfill');
});

test('t1282 AT30 — the pinned migration counts read thirty-nine', () => {
  const root = path.resolve(import.meta.dirname);
  for (const [file, pattern] of [
    ['migrate.test.ts', /applied\.length,\s*\n?\s*39,/],
    ['migrate.test.ts', /schema_migrations'\),\s*\n?\s*39,/],
    ['startup.test.ts', /migrationsApplied,\s*\n?\s*39,/],
  ] as const) {
    assert.match(readFileSync(path.join(root, file), 'utf8'), pattern, `${file} pins 39`);
  }
  assert.equal(listMigrations(MIGRATIONS_DIR).length, 39, 'and the package ships exactly 39');
});
