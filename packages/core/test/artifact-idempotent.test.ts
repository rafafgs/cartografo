/**
 * Acceptance tests of the idempotent artifact upload (t1338, AT1–AT9).
 *
 * The same session + `x-artifact-name` + content sha256 is one artifact: a
 * repeat answers `200` with the existing record, a new combination answers
 * `201`. The plane set-up mirrors `artifact-store.test.ts`: `createApp` over a
 * throwaway database and a `LocalArtifactStore`, with raw `fetch` uploads.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import {
  MIGRATIONS_DIR,
  request,
  requireArtifacts,
  type Session,
  type TestContext,
  type TestHook,
} from './support.ts';

/** The store, in the slice this suite builds. */
interface ArtifactStore {
  put(
    source: Buffer,
    meta: { name: string; mediaType: string },
  ): Promise<{ ref: string; sha256: string; size: number }>;
}

interface LocalStoreModule {
  LocalArtifactStore: new (root: string) => ArtifactStore;
}

interface CredentialsModule {
  issueCredential: (
    db: Database,
    data: { type: string; runnerId?: string | null },
  ) => { id: number; token: string };
}

interface ServerModule {
  createApp: (options: { db: Database; artifactStore?: ArtifactStore }) => FastifyInstance;
}

interface Artifact {
  id: number;
  session_id: number;
  name: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at: string;
}

interface RepositoryModule {
  createArtifact: (
    db: Database,
    sessionId: number,
    input: { name: string; mediaType: string; buffer: Buffer },
    store: ArtifactStore,
  ) => Promise<Artifact | null>;
}

interface Plane extends TestContext {
  store: ArtifactStore;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

async function startPlane(t: TestHook): Promise<Plane> {
  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');
  const { createApp } = await load<ServerModule>('src/server.ts');
  const { issueCredential } = await load<CredentialsModule>('src/repositories/credentials.ts');
  const { LocalArtifactStore } = await load<LocalStoreModule>('src/artifacts/local-store.ts');

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1338-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const { token } = issueCredential(db, { type: 'user' });
  const store = new LocalArtifactStore(path.join(base, 'artifacts'));
  const app = createApp({ db, artifactStore: store });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db, url, token, store };
}

async function upload(
  plane: Plane,
  sessionId: number,
  body: Buffer,
  name: string | null = 'report.txt',
  mediaType = 'text/plain',
): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${plane.token}`,
    'content-type': mediaType,
  };
  if (name !== null) headers['x-artifact-name'] = name;
  const response = await fetch(`${plane.url}/v1/sessions/${sessionId}/artifacts`, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

async function openSession(plane: Plane): Promise<Session> {
  const response = await request<Session>(plane, 'POST', '/v1/sessions', {
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'do something and leave the evidence behind',
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function listOf(plane: Plane, sessionId: number): Promise<Artifact[]> {
  const response = await request<{ artifacts: Artifact[] }>(
    plane,
    'GET',
    `/v1/sessions/${sessionId}/artifacts`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.artifacts;
}

function keysOf(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort();
}

const BYTES = Buffer.from('the same file, sent more than once\n');

test('t1338 AT1 — the same bytes and name twice answer 201 then 200 with one row', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);

  const first = await upload(plane, session.id, BYTES);
  const second = await upload(plane, session.id, BYTES);

  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.id, first.body.id);
  assert.deepEqual(keysOf(second.body), keysOf(first.body));
  assert.ok(!('storage_ref' in first.body) && !('storage_ref' in second.body));
  assert.equal((await listOf(plane, session.id)).length, 1);
});

test('t1338 AT2 — the same name with different bytes is a new row', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);

  const first = await upload(plane, session.id, BYTES);
  const second = await upload(plane, session.id, Buffer.from('other content'));

  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.id, first.body.id);
  assert.equal((await listOf(plane, session.id)).length, 2);
});

test('t1338 AT3 — the same bytes under a different name is a new row', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);

  const first = await upload(plane, session.id, BYTES, 'a.txt');
  const second = await upload(plane, session.id, BYTES, 'b.txt');

  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.id, first.body.id);
  const list = await listOf(plane, session.id);
  assert.equal(list.length, 2);
  assert.equal(list[0]?.sha256, list[1]?.sha256);
});

test('t1338 AT4 — the same name and bytes on another session is a new row there', async (t) => {
  const plane = await startPlane(t);
  const one = await openSession(plane);
  const two = await openSession(plane);

  const first = await upload(plane, one.id, BYTES);
  const second = await upload(plane, two.id, BYTES);

  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.notEqual(second.body.id, first.body.id);
  const listOne = await listOf(plane, one.id);
  assert.equal(listOne.length, 1);
  assert.equal(listOne[0]?.id, first.body.id);
  assert.equal((await listOf(plane, two.id)).length, 1);
});

test('t1338 AT5 — a repeat under another content-type returns the first media_type', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);

  const first = await upload(plane, session.id, BYTES, 'report.txt', 'text/plain');
  const second = await upload(plane, session.id, BYTES, 'report.txt', 'application/octet-stream');

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.media_type, 'text/plain');
  const stored = await request<Artifact>(plane, 'GET', `/v1/artifacts/${String(first.body.id)}`);
  assert.equal(stored.body.media_type, 'text/plain');
});

test('t1338 AT6 — two identical uploads fired together leave one row', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);

  const [a, b] = await Promise.all([
    upload(plane, session.id, BYTES),
    upload(plane, session.id, BYTES),
  ]);

  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.id, b.body.id);
  assert.equal((await listOf(plane, session.id)).length, 1);
});

test('t1338 AT7 — existing duplicates answer the lowest id and stay as they are', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);

  const stored = await plane.store.put(BYTES, { name: 'report.txt', mediaType: 'text/plain' });
  const insert = plane.db.prepare(
    `INSERT INTO artifact (session_id, name, media_type, size, sha256, storage_ref, created_at)
     VALUES (?, 'report.txt', 'text/plain', ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
  );
  const low = Number(insert.run(session.id, stored.size, stored.sha256, stored.ref).lastInsertRowid);
  insert.run(session.id, stored.size, stored.sha256, stored.ref);

  const repeat = await upload(plane, session.id, BYTES);

  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  assert.equal(repeat.body.id, low);
  assert.equal((await listOf(plane, session.id)).length, 2);
});

test('t1338 AT8 — an unknown session is still 404 and a missing name still 400', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);
  await upload(plane, session.id, BYTES);

  assert.equal((await upload(plane, 999999, BYTES)).status, 404);
  assert.equal((await upload(plane, session.id, BYTES, null)).status, 400);
});

test('t1338 AT9 — createArtifact twice with the same input returns one artifact', async (t) => {
  const plane = await startPlane(t);
  const session = await openSession(plane);
  const { createArtifact } = await load<RepositoryModule>('src/repositories/artifacts.ts');

  const input = { name: 'transcript', mediaType: 'text/plain', buffer: BYTES };
  const first = await createArtifact(plane.db, session.id, input, plane.store);
  const second = await createArtifact(plane.db, session.id, input, plane.store);

  assert.ok(first !== null && second !== null);
  assert.equal(second.id, first.id);
  assert.equal(first.sha256, createHash('sha256').update(BYTES).digest('hex'));
  const count = plane.db
    .prepare('SELECT count(*) AS n FROM artifact WHERE session_id = ?')
    .get(session.id) as { n: number };
  assert.equal(count.n, 1);
});
