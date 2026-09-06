/**
 * Acceptance tests of the project entity (t354, FR1).
 *
 * A project stops being a loose integer in an envelope and becomes a row with a
 * name (D25, and Rafael's 2026-09-05 item 1b). Everything else this ticket does
 * — the `project_id` column on `graph`/`graph_version`/`proposal`/`skill`/
 * `hook_secret`, the scope on the wire, the switcher on the screen — hangs off
 * this table existing, so this file is the one that asserts it does.
 *
 * Three properties, and each is a decision rather than a detail:
 *
 * - **row `1` is called `default` and the migration writes it.** Every row that
 *   existed before this ticket is backfilled onto it, so a database that
 *   migrates in place has one project and every artifact inside it — which is
 *   what makes the single-project path keep working with nobody passing a scope;
 * - **a repeated `name` is a `409` and never a second row.** The name is what
 *   the operator switches on at the screen, and two projects sharing one would
 *   make the switcher ambiguous in the one place a person reads it;
 * - **a runner credential is out of scope here.** By omission, like
 *   `POST /v1/skills`: declaring a project is the operator's act, and
 *   `RUNNER_SURFACE` (`src/auth.ts`) deliberately does not list these two paths.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, requireArtifacts, startControlPlane, type TestContext } from './support.ts';

/** Artifacts this ticket creates; every test names them before touching the API. */
const T354_ARTIFACTS = Object.freeze({
  migration: 'migrations/0026_project_partition.sql',
  repository: 'src/repositories/projects.ts',
  routes: 'src/routes/projects.ts',
});

const ARTIFACTS = Object.values(T354_ARTIFACTS);

/** A project, as the API publishes it — the row's own three columns. */
interface Project {
  id: number;
  name: string;
  created_at: string;
}

/** The error envelope of `src/routes/common.ts`. */
interface ErrorBody {
  error?: string;
  message?: string;
  details?: string[];
}

/** Pairs a runner with the operator credential and returns its own token. */
async function pairedRunnerToken(ctx: TestContext, id: string): Promise<string> {
  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', { id });
  assert.equal(paired.status, 201);
  assert.equal(typeof paired.body.token, 'string', 'pairing is where a runner credential comes from');
  return paired.body.token ?? '';
}

/** One request with the credential handed in explicitly, for the gate test. */
async function call<T>(
  ctx: TestContext,
  method: string,
  routePath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${ctx.url}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

test('t354 AT1 — a fresh migrated database holds exactly the default project', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await request<{ projects: Project[] }>(ctx, 'GET', '/v1/projects');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.projects.length, 1, 'the migration writes one row and no more');

  const [first] = response.body.projects;
  assert.equal(first.id, 1);
  assert.equal(first.name, 'default');
  assert.equal(typeof first.created_at, 'string');
  assert.notEqual(first.created_at, '', 'the row carries when it was written');
});

test('t354 AT2 — POST /v1/projects writes a second project, in id order', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const created = await request<Project>(ctx, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.id, 2, 'the default project holds id 1, so the next one is 2');
  assert.equal(created.body.name, 'second');
  assert.equal(typeof created.body.created_at, 'string');

  const listed = await request<{ projects: Project[] }>(ctx, 'GET', '/v1/projects');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.projects.map((project) => [project.id, project.name]),
    [
      [1, 'default'],
      [2, 'second'],
    ],
    'the listing is in id order',
  );
});

test('t354 AT3 — a repeated name is a 409 and writes nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  assert.equal((await request<Project>(ctx, 'POST', '/v1/projects', { name: 'second' })).status, 201);

  const repeated = await request<ErrorBody>(ctx, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.error, 'project_name_already_registered');

  const listed = await request<{ projects: Project[] }>(ctx, 'GET', '/v1/projects');
  assert.equal(listed.body.projects.length, 2, 'the refused call left no third row behind');
});

test('t354 AT4 — a blank name is refused before anything is written', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await request<ErrorBody>(ctx, 'POST', '/v1/projects', { name: '   ' });
  assert.equal(refused.status, 400);

  const listed = await request<{ projects: Project[] }>(ctx, 'GET', '/v1/projects');
  assert.equal(listed.body.projects.length, 1);
});

test('t354 AT5 — a runner credential is out of scope on both project routes', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-a');

  const denied = await call<ErrorBody>(ctx, 'POST', '/v1/projects', token, { name: 'runners-own' });
  assert.equal(denied.status, 403, 'declaring a project is the operator\'s act, not a runner\'s');
  assert.equal(denied.body.error, 'out_of_scope_credential');

  const listing = await call<ErrorBody>(ctx, 'GET', '/v1/projects', token);
  assert.equal(listing.status, 403);
  assert.equal(listing.body.error, 'out_of_scope_credential');

  const rows = ctx.db.prepare('SELECT COUNT(*) AS total FROM project').get() as { total: number };
  assert.equal(rows.total, 1, 'a refused request writes nothing');
});

test('t354 AT6 — writing a project records project.created in the log', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const created = await request<Project>(ctx, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(created.status, 201);

  const row = ctx.db
    .prepare(
      `SELECT type, project_id, entity_type, entity_id, data FROM event
        WHERE type = 'project.created' ORDER BY id DESC LIMIT 1`,
    )
    .get() as
    | { type: string; project_id: number; entity_type: string; entity_id: string; data: string }
    | undefined;

  assert.ok(row !== undefined, 'the write records the fact');
  assert.equal(row.entity_type, 'project');
  assert.equal(Number(row.entity_id), created.body.id);
  assert.equal(row.project_id, created.body.id, 'the project owns its own birth');
  assert.deepEqual(JSON.parse(row.data), { name: 'second' });
});
