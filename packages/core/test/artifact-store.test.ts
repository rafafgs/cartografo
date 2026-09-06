/**
 * Acceptance tests of the content-addressed artifact store and its HTTP surface
 * (t422, AT1–AT17).
 *
 * Two halves, and they are deliberately in one file because they are one
 * feature: the store on its own (AT1–AT5), exercised as a plain object against a
 * temporary directory, and the four routes that hand it work (AT6–AT17),
 * exercised through a real control plane.
 *
 * The harness is local instead of `support.ts`'s `startControlPlane` for one
 * reason: this is the suite that has to CHOOSE what the app is built with — an
 * `ArtifactStore` rooted where the test can inspect it, and a size cap small
 * enough that a case can go over it without moving 32 MiB through a socket. That
 * choice is FR3's own claim ("a second implementation is a different constructor
 * argument"), so making it here is also what proves it.
 *
 * The interfaces below are hand-written and not imported from `src/`, the same
 * rule `support.ts` states for its own: they ARE the contract these tests demand,
 * and a contract that imports itself from the implementation demands nothing.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';

import type { FastifyInstance } from 'fastify';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import {
  MIGRATIONS_DIR,
  PACKAGE_ROOT,
  request,
  requireArtifacts,
  type Session,
  type TestContext,
  type TestHook,
} from './support.ts';

/** Every artifact this ticket ships; each case requires the ones it exercises. */
const T422_ARTIFACTS = Object.freeze({
  store: 'src/artifacts/store.ts',
  localStore: 'src/artifacts/local-store.ts',
  repository: 'src/repositories/artifacts.ts',
  routes: 'src/routes/artifacts.ts',
  migration: 'migrations/0030_artifacts.sql',
  auth: 'src/auth.ts',
});

/** The whole set, for the route cases — they cross every one of them. */
const ROUTE_ARTIFACTS = Object.values(T422_ARTIFACTS);

/** What `put` answers with (FR1). */
interface StoredArtifact {
  ref: string;
  sha256: string;
  size: number;
}

/** The storage interface, as FR1 declares it. */
interface ArtifactStore {
  put(source: Buffer, meta: { name: string; mediaType: string }): Promise<StoredArtifact>;
  open(ref: string): Readable;
  exists(ref: string): boolean;
}

/** The one implementation this ticket ships (FR2). */
interface LocalStoreModule {
  LocalArtifactStore: new (root: string) => ArtifactStore;
}

/** The app factory, in the slice this suite builds (FR3, FR7). */
interface ServerModule {
  createApp: (options: {
    db: Database;
    artifactStore?: ArtifactStore;
    artifactSizeCapBytes?: number;
  }) => FastifyInstance;
}

/** The public shape of an artifact — every key, and `storage_ref` is not one (FR5). */
interface Artifact {
  id: number;
  session_id: number;
  name: string;
  media_type: string;
  size: number;
  sha256: string;
  created_at: string;
}

/** The keys AT8, AT12 and AT15 all compare against. */
const ARTIFACT_KEYS = Object.freeze([
  'id',
  'session_id',
  'name',
  'media_type',
  'size',
  'sha256',
  'created_at',
]);

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

/** The sha256 of a buffer, in the hex the store is supposed to use as its ref. */
function digestOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** A `LocalArtifactStore` over a directory this test owns and cleans up. */
async function makeStore(t: TestHook): Promise<{ store: ArtifactStore; root: string }> {
  const { LocalArtifactStore } = await load<LocalStoreModule>(T422_ARTIFACTS.localStore);
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t422-store-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const root = path.join(base, 'artifacts');
  return { store: new LocalArtifactStore(root), root };
}

/** Reads a whole readable stream into one buffer. */
async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A control plane built with a store and a cap this suite chose. */
interface ArtifactPlane extends TestContext {
  /** Root the store writes under, so a case can look at the files themselves. */
  storeRoot: string;
}

/**
 * Brings the whole control plane up over a throwaway database AND a throwaway
 * store root.
 *
 * @param t Test context, used to register the shutdown.
 * @param options `sizeCapBytes` is the ceiling of the upload route (FR7).
 * @returns The running plane, ready for `request()` and for `upload()`.
 */
async function startArtifactPlane(
  t: TestHook,
  options: { sizeCapBytes?: number } = {},
): Promise<ArtifactPlane> {
  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');
  const { createApp } = await load<ServerModule>('src/server.ts');
  const { issueCredential } = await load<typeof CredentialsModule>(
    'src/repositories/credentials.ts',
  );
  const { LocalArtifactStore } = await load<LocalStoreModule>(T422_ARTIFACTS.localStore);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t422-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const { token } = issueCredential(db, { type: 'user' });

  const storeRoot = path.join(base, 'artifacts');
  const app = createApp({
    db,
    artifactStore: new LocalArtifactStore(storeRoot),
    artifactSizeCapBytes: options.sizeCapBytes,
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db, url, token, storeRoot };
}

/** The headers a well-formed upload carries. */
function uploadHeaders(name: string, mediaType: string): Record<string, string> {
  return { 'content-type': mediaType, 'x-artifact-name': name };
}

/** A raw-body upload: this is the one route in the app that is not JSON. */
async function upload(
  plane: ArtifactPlane,
  sessionId: number,
  body: Buffer,
  headers: Record<string, string> = uploadHeaders('report.txt', 'text/plain'),
  token: string = plane.token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${plane.url}/v1/sessions/${sessionId}/artifacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...headers },
    body: new Uint8Array(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

/** Opens a session, with whatever the case needs on top of the usual body. */
async function openSession(
  plane: ArtifactPlane,
  body: Record<string, unknown> = {},
): Promise<Session> {
  const response = await request<Session>(plane, 'POST', '/v1/sessions', {
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'do something and leave the evidence behind',
    ...body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

/** Declares a second project, the way t411's own cases do. */
async function declareSecondProject(plane: ArtifactPlane): Promise<number> {
  const created = await request<{ id: number }>(plane, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id;
}

/** The keys of an object, sorted — an unordered comparison written once. */
function keysOf(value: unknown): string[] {
  assert.ok(value !== null && typeof value === 'object', `not an object: ${JSON.stringify(value)}`);
  return Object.keys(value as Record<string, unknown>).sort();
}

/* -------------------------------------------------------------------------- */
/* The store on its own (AT1–AT5)                                              */
/* -------------------------------------------------------------------------- */

test('t422 AT1 — put answers the content address and writes it two levels down', async (t) => {
  const { store, root } = await makeStore(t);

  const content = Buffer.from('the evidence a session left behind\n');
  const stored = await store.put(content, { name: 'report.txt', mediaType: 'text/plain' });

  const sha256 = digestOf(content);
  assert.equal(stored.sha256, sha256);
  assert.equal(stored.ref, sha256, 'the ref IS the content address, never a filesystem path');
  assert.equal(stored.size, content.byteLength);

  const written = path.join(root, sha256.slice(0, 2), sha256);
  assert.deepEqual(
    readFileSync(written),
    content,
    `nothing was written at ${written}; the layout is <root>/<sha256[0:2]>/<sha256>`,
  );
});

test('t422 AT2 — putting the same content twice dedupes into one file', async (t) => {
  const { store, root } = await makeStore(t);

  const content = Buffer.from('two sessions, one identical log line');
  const first = await store.put(content, { name: 'first.log', mediaType: 'text/plain' });
  const second = await store.put(content, { name: 'second.log', mediaType: 'text/plain' });

  assert.deepEqual(second, first, 'the same bytes are the same artifact, whatever they are called');

  const bucket = path.join(root, first.sha256.slice(0, 2));
  assert.deepEqual(
    readdirSync(bucket),
    [first.sha256],
    'the second put has to find the file and leave it alone (free dedupe, RF-38)',
  );
});

test('t422 AT3 — open streams back exactly the bytes that were put', async (t) => {
  const { store } = await makeStore(t);

  // Bytes, not text: an artifact is a file and the store may never assume UTF-8.
  const content = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0xfe]);
  const stored = await store.put(content, { name: 'blob.bin', mediaType: 'application/octet-stream' });

  assert.deepEqual(await drain(store.open(stored.ref)), content);
});

test('t422 AT4 — exists is false before the put and true after it', async (t) => {
  const { store } = await makeStore(t);

  const content = Buffer.from('nothing is here yet');
  const ref = digestOf(content);
  assert.equal(store.exists(ref), false);

  await store.put(content, { name: 'note.txt', mediaType: 'text/plain' });
  assert.equal(store.exists(ref), true);
});

test('t422 AT5 — a ref that is not 64 lowercase hex characters is refused', async (t) => {
  const { store } = await makeStore(t);

  const valid = digestOf(Buffer.from('anything'));
  const refused = [
    '',
    '..',
    '../../etc/passwd',
    `${valid.slice(0, 62)}/x`,
    valid.slice(0, 63),
    `${valid}0`,
    valid.toUpperCase(),
    `${valid}\n`,
  ];

  for (const ref of refused) {
    assert.throws(
      () => store.open(ref),
      `open(${JSON.stringify(ref)}) has to throw: a ref only ever comes from this module's own hash`,
    );
    assert.throws(() => store.exists(ref), `exists(${JSON.stringify(ref)}) has to throw`);
  }
});

/* -------------------------------------------------------------------------- */
/* The upload route (AT6–AT10)                                                 */
/* -------------------------------------------------------------------------- */

test('t422 AT6 — uploading to a session that does not exist is a 404', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);

  const refused = await upload(plane, 4242, Buffer.from('an orphan artifact'));
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'not_found');
});

test('t422 AT7 — an upload with no x-artifact-name header is a 400', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const session = await openSession(plane);

  const refused = await upload(plane, session.id, Buffer.from('a nameless file'), {
    'content-type': 'text/plain',
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
});

test('t422 AT8 — an upload under the cap answers 201 with the public shape', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const session = await openSession(plane);

  const content = Buffer.from('the report the session wrote\n');
  const created = await upload(
    plane,
    session.id,
    content,
    uploadHeaders('report.md', 'text/markdown'),
  );

  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(
    keysOf(created.body),
    [...ARTIFACT_KEYS].sort(),
    'the wire carries exactly these keys, and `storage_ref` is deliberately not one (FR5)',
  );
  assert.equal(created.body.storage_ref, undefined);

  const artifact = created.body as unknown as Artifact;
  assert.ok(Number.isInteger(artifact.id));
  assert.equal(artifact.session_id, session.id);
  assert.equal(artifact.name, 'report.md');
  assert.equal(artifact.media_type, 'text/markdown');
  assert.equal(artifact.size, content.byteLength);
  assert.equal(artifact.sha256, digestOf(content));

  // ...and the bytes really did reach the store this plane was built with.
  const written = path.join(plane.storeRoot, artifact.sha256.slice(0, 2), artifact.sha256);
  assert.deepEqual(readFileSync(written), content);
});

test('t422 AT9 — an upload over the configured cap is a 413', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t, { sizeCapBytes: 64 });
  const session = await openSession(plane);

  const refused = await upload(plane, session.id, Buffer.alloc(1024, 0x61));
  assert.equal(
    refused.status,
    413,
    `the route's bodyLimit has to be the configured cap; got ${JSON.stringify(refused.body)}`,
  );

  // The cap is a ceiling and not a shutdown: what fits still goes through.
  const accepted = await upload(plane, session.id, Buffer.from('small enough'));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

test('t422 AT10 — the raw parser stays inside the artifacts scope', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);

  // A JSON route registered beside the artifacts scope, called AFTER the raw
  // content-type parser exists: if that parser had leaked out of its own
  // encapsulation, `request.body` here would be a Buffer and the route would
  // refuse its own contract.
  const session = await openSession(plane);
  const artifact = await upload(plane, session.id, Buffer.from('proof the scope is raw'));
  assert.equal(artifact.status, 201, JSON.stringify(artifact.body));

  const second = await request<Session>(plane, 'POST', '/v1/sessions', {
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'a perfectly ordinary JSON body',
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.prompt, 'a perfectly ordinary JSON body');

  const listed = await request<{ sessions: Session[] }>(plane, 'GET', '/v1/sessions');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
});

/* -------------------------------------------------------------------------- */
/* The read routes, scoped through the owning session (AT11–AT16)              */
/* -------------------------------------------------------------------------- */

/** A session of a second project, with one artifact already uploaded to it. */
async function artifactOfAnotherProject(
  plane: ArtifactPlane,
  content: Buffer,
): Promise<{ artifact: Artifact; project: number; session: Session }> {
  const project = await declareSecondProject(plane);
  const session = await openSession(plane, { project_id: project });
  const created = await upload(
    plane,
    session.id,
    content,
    uploadHeaders('theirs.txt', 'text/plain'),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { artifact: created.body as unknown as Artifact, project, session };
}

test('t422 AT11 — GET /v1/artifacts/:id of another project is the same 404', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const { artifact, project } = await artifactOfAnotherProject(plane, Buffer.from('their evidence'));

  const refused = await request<{ error: string }>(
    plane,
    'GET',
    `/v1/artifacts/${artifact.id}?project_id=1`,
  );
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(
    refused.body.error,
    'not_found',
    'a boundary answers the refusal an unknown id answers, never a distinct code (t411)',
  );

  const undeclared = await request<{ error: string }>(plane, 'GET', `/v1/artifacts/${artifact.id}`);
  assert.equal(undeclared.status, 404, 'an absent scope is the default project, not "any"');

  // ...and from its own project it is perfectly readable.
  const theirs = await request<Artifact>(
    plane,
    'GET',
    `/v1/artifacts/${artifact.id}?project_id=${project}`,
  );
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.equal(theirs.body.id, artifact.id);
});

test('t422 AT12 — GET /v1/artifacts/:id in scope answers metadata and nothing else', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const session = await openSession(plane);

  const content = Buffer.from('# the note\n');
  const created = await upload(
    plane,
    session.id,
    content,
    uploadHeaders('note.md', 'text/markdown'),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const artifact = created.body as unknown as Artifact;

  const response = await fetch(`${plane.url}/v1/artifacts/${artifact.id}`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/json/,
    'the metadata route answers JSON — the bytes are the OTHER route (FR8/FR9)',
  );

  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(keysOf(body), [...ARTIFACT_KEYS].sort());
  assert.deepEqual(body, { ...artifact } as unknown as Record<string, unknown>);
  assert.equal(body.storage_ref, undefined);

  // A metadata read is not a content read, whatever it says about the media.
  assert.notEqual(response.headers.get('content-type'), 'text/markdown');
});

test('t422 AT13 — GET /v1/artifacts/:id/content answers the exact bytes', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const session = await openSession(plane);

  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const created = await upload(
    plane,
    session.id,
    content,
    uploadHeaders('screenshot.png', 'image/png'),
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const artifact = created.body as unknown as Artifact;

  const response = await fetch(`${plane.url}/v1/artifacts/${artifact.id}/content`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(content.byteLength));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
});

test('t422 AT14 — GET /v1/artifacts/:id/content of another project is a 404', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const content = Buffer.from('their bytes, and not mine');
  const { artifact, project } = await artifactOfAnotherProject(plane, content);

  const refused = await fetch(`${plane.url}/v1/artifacts/${artifact.id}/content?project_id=1`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  assert.equal(refused.status, 404);
  assert.equal(((await refused.json()) as { error: string }).error, 'not_found');

  const theirs = await fetch(
    `${plane.url}/v1/artifacts/${artifact.id}/content?project_id=${project}`,
    { headers: { authorization: `Bearer ${plane.token}` } },
  );
  assert.equal(theirs.status, 200);
  assert.deepEqual(Buffer.from(await theirs.arrayBuffer()), content);
});

test('t422 AT15 — GET /v1/sessions/:id/artifacts lists what that session uploaded', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const session = await openSession(plane);
  const other = await openSession(plane);

  const first = await upload(
    plane,
    session.id,
    Buffer.from('the first one'),
    uploadHeaders('first.txt', 'text/plain'),
  );
  const second = await upload(
    plane,
    session.id,
    Buffer.from('the second one'),
    uploadHeaders('second.txt', 'text/plain'),
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));

  // A neighbour's upload, so the listing has something to leave out.
  await upload(plane, other.id, Buffer.from('somebody else entirely'));

  const listed = await request<{ artifacts: Artifact[] }>(
    plane,
    'GET',
    `/v1/sessions/${session.id}/artifacts`,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(
    listed.body.artifacts.map((artifact) => artifact.name),
    ['first.txt', 'second.txt'],
  );
  for (const artifact of listed.body.artifacts) {
    assert.deepEqual(keysOf(artifact), [...ARTIFACT_KEYS].sort());
  }

  // A session that exists and uploaded nothing is an empty list, never a 404.
  const empty = await openSession(plane);
  const nothing = await request<{ artifacts: Artifact[] }>(
    plane,
    'GET',
    `/v1/sessions/${empty.id}/artifacts`,
  );
  assert.equal(nothing.status, 200, JSON.stringify(nothing.body));
  assert.deepEqual(nothing.body.artifacts, []);
});

test('t422 AT16 — listing a session out of scope is a 404, not an empty list', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);
  const plane = await startArtifactPlane(t);
  const { session, project } = await artifactOfAnotherProject(plane, Buffer.from('their evidence'));

  const refused = await request<{ error: string; artifacts?: unknown[] }>(
    plane,
    'GET',
    `/v1/sessions/${session.id}/artifacts?project_id=1`,
  );
  assert.equal(refused.status, 404, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'not_found');
  assert.equal(
    refused.body.artifacts,
    undefined,
    '"there is nothing here" and "there is no here" are different answers',
  );

  const theirs = await request<{ artifacts: Artifact[] }>(
    plane,
    'GET',
    `/v1/sessions/${session.id}/artifacts?project_id=${project}`,
  );
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.equal(theirs.body.artifacts.length, 1);

  // An unknown session id is the same 404 the boundary answers.
  const unknown = await request<{ error: string }>(plane, 'GET', '/v1/sessions/4242/artifacts');
  assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
});

/* -------------------------------------------------------------------------- */
/* The credential surface (AT17)                                               */
/* -------------------------------------------------------------------------- */

test('t422 AT17 — the upload route is not on the runner allowlist', async (t) => {
  requireArtifacts(...ROUTE_ARTIFACTS);

  // Read first: `RUNNER_SURFACE` is a literal list, and FR11 is about what is
  // written in it — a runner that needs to upload gets that decision taken on
  // purpose, in child 2, and not inherited from this ticket.
  const auth = readFileSync(path.join(PACKAGE_ROOT, T422_ARTIFACTS.auth), 'utf8');
  const surface = auth.slice(auth.indexOf('RUNNER_SURFACE'), auth.indexOf('declare module'));
  assert.ok(surface.length > 0, 'RUNNER_SURFACE is not where this assertion expects it');
  assert.ok(
    !surface.includes('/artifacts'),
    'no artifact route belongs on RUNNER_SURFACE until the ticket that wires the caller says so (FR11)',
  );

  // ...and the gate really does refuse one.
  const plane = await startArtifactPlane(t);
  const { issueCredential } = await load<typeof CredentialsModule>(
    'src/repositories/credentials.ts',
  );
  const session = await openSession(plane);
  const { token } = issueCredential(plane.db, { type: 'runner', runnerId: 'runner-1' });

  const refused = await upload(
    plane,
    session.id,
    Buffer.from('a runner trying to upload'),
    uploadHeaders('runner.txt', 'text/plain'),
    token,
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'out_of_scope_credential');
});
