/**
 * OpenAPI acceptance tests (t171, FR1–FR3 and FR7).
 *
 * D11 says the screen is an unprivileged client of the public API. Until this
 * ticket there was no public ARTIFACT saying what that API is: `packages/tela`,
 * or any third party, had to read the route files. What is pinned here is the
 * document that closes the gap, and the two properties that keep it honest.
 *
 * The count/set assertion is the whole point of "generated from code". Fastify's
 * `onRoute` cannot miss a registered route, so the document cannot silently fall
 * behind the app — but a route family added to `server.ts` and forgotten by
 * everything else would still slip by unnoticed, and this file is what turns
 * that into a red test.
 *
 * HEAD is excluded on BOTH sides of the comparison, never on one: Fastify
 * derives a HEAD route from every GET (`exposeHeadRoutes`), so counting it as a
 * registered route while the document may or may not carry it would compare two
 * different things.
 *
 * The document's own interfaces are hand-written below instead of imported from
 * `openapi-types`: they ARE the shape this suite demands, and a contract that
 * imports itself from the producer demands nothing (same reason `support.ts`
 * hand-writes the projections).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyPragmas, openDatabase } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import { API_PREFIX, createApp } from '../src/server.ts';
import { MIGRATIONS_DIR, PACKAGE_ROOT, requireArtifacts, request, startControlPlane } from './support.ts';

/** Artifacts this ticket touches; the initial red names them instead of blowing up. */
const ARTIFACTS = ['src/server.ts', 'src/routes/common.ts'];

/** A JSON Schema, as it travels inside the document — opaque here on purpose. */
type SchemaObject = Record<string, unknown>;

/** One media type of a request body or a response. */
interface MediaTypeObject {
  schema?: SchemaObject;
}

/** One documented operation. */
interface OperationObject {
  operationId?: string;
  parameters?: Array<{ name: string; in: string }>;
  requestBody?: { content?: Record<string, MediaTypeObject> };
  responses?: Record<string, { content?: Record<string, MediaTypeObject> }>;
}

/** The document, in the slice this suite reads. */
interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, OperationObject>>;
}

/**
 * Verbs that are an operation in a path item.
 *
 * `head` is deliberately absent — see the file header. Everything else a path
 * item may carry (`$ref`, `summary`, `description`, `servers`, `parameters`) is
 * skipped by not being on this list.
 */
const OPERATION_METHODS = Object.freeze([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'patch',
  'trace',
]);

/** Version of `packages/core`, which FR1 makes the document's own version. */
function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

/** Fetches the public document from a running control plane. */
async function fetchDocument(url: string): Promise<OpenApiDocument> {
  const response = await fetch(`${url}/openapi.json`);
  assert.equal(response.status, 200, 'GET /openapi.json has to answer');
  return (await response.json()) as OpenApiDocument;
}

/**
 * `METHOD /path` for every operation the document declares under its server.
 *
 * The server prefix is read from the document itself, and not hardcoded: what
 * FR1 promises is `servers` + path = the address a client really calls, and
 * composing them here is what makes the comparison test that promise too.
 *
 * @param document The fetched document.
 * @returns The set of full addresses, with OpenAPI-style `{id}` parameters.
 */
function documentedOperations(document: OpenApiDocument): Set<string> {
  const base = document.servers[0]?.url ?? '';
  const operations = new Set<string>();
  for (const [route, item] of Object.entries(document.paths)) {
    for (const method of Object.keys(item)) {
      if (!OPERATION_METHODS.includes(method)) continue;
      operations.add(`${method.toUpperCase()} ${base}${route}`);
    }
  }
  return operations;
}

/**
 * `METHOD /path` for every `/v1` route `createApp` really registers.
 *
 * The `onRoute` hook is attached to the instance AFTER `createApp` returns and
 * BEFORE `ready()`, which is exactly the window where it sees everything: every
 * business family is born inside an `app.register(...)` (`server.ts:72`), and
 * those plugins only boot when the instance is readied.
 *
 * @returns The set of addresses, with Fastify's `:id` rewritten as `{id}`.
 */
async function registeredOperations(): Promise<Set<string>> {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t171-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const app = createApp({ db });
  const routes = new Set<string>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      if (!route.url.startsWith(`${API_PREFIX}/`)) continue;
      routes.add(`${method} ${route.url.replace(/:([^/]+)/g, '{$1}')}`);
    }
  });

  await app.ready();
  await app.close();
  db.close();
  rmSync(base, { recursive: true, force: true });
  return routes;
}

/** Reads one operation out of the document by the full address a client calls. */
function operationAt(
  document: OpenApiDocument,
  method: string,
  fullPath: string,
): OperationObject {
  const base = document.servers[0]?.url ?? '';
  assert.ok(fullPath.startsWith(base), `${fullPath} is not under the declared server ${base}`);
  const route = fullPath.slice(base.length);
  const item = document.paths[route];
  assert.ok(item !== undefined, `the document has no path ${route} (server ${base})`);
  const operation = item[method];
  assert.ok(operation !== undefined, `the document has no ${method.toUpperCase()} ${route}`);
  return operation;
}

/** Asserts that a media map carries a JSON schema with something in it. */
function assertJsonSchema(
  content: Record<string, MediaTypeObject> | undefined,
  what: string,
): void {
  assert.ok(content !== undefined, `${what}: no content declared`);
  const media = content['application/json'];
  assert.ok(media !== undefined, `${what}: no application/json media type`);
  assert.ok(media.schema !== undefined, `${what}: the media type declares no schema`);
  assert.ok(Object.keys(media.schema).length > 0, `${what}: the schema is empty`);
}

test('t171 AT1 — GET /openapi.json serves a parseable OpenAPI 3.x document', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const response = await fetch(`${ctx.url}/openapi.json`);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /application\/json/,
    'the document is served as JSON, not as a download',
  );

  const document = (await response.json()) as OpenApiDocument;
  assert.match(document.openapi, /^3\./, `expected OpenAPI 3.x, got "${document.openapi}"`);
  assert.ok(
    Object.keys(document.paths).length > 0,
    'a document with an empty "paths" describes nothing',
  );

  // FR1: the title is fixed and the version tracks the package, so the document
  // cannot drift into claiming a version nobody publishes.
  assert.equal(document.info.title, 'cartografo control plane API');
  assert.equal(document.info.version, packageVersion());
  assert.deepEqual(
    document.servers,
    [{ url: API_PREFIX }],
    'the declared server is the existing API_PREFIX, so path + server is the real address',
  );
});

test('t171 AT2 — every /v1 route createApp registers is in the document, and nothing else', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const document = await fetchDocument(ctx.url);
  const documented = documentedOperations(document);
  const registered = await registeredOperations();

  assert.ok(registered.size > 0, 'the probe found no /v1 route; it is not walking the app');

  const missing = [...registered].filter((route) => !documented.has(route)).sort();
  assert.deepEqual(missing, [], 'these registered routes are absent from /openapi.json');

  const extra = [...documented].filter((route) => !registered.has(route)).sort();
  assert.deepEqual(extra, [], 'these documented operations match no registered route');

  // FR7 literally: the counts agree. Kept next to the set comparison above
  // because it is the assertion that fails when a route family is added to
  // `server.ts` and nothing else in the suite notices.
  assert.equal(
    documented.size,
    registered.size,
    'documented /v1 operations and registered /v1 routes have to be the same number',
  );
});

test('t171 AT3 — the three routes of the basic flow carry request and response schemas', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const document = await fetchDocument(ctx.url);

  // FR4: one response entry per status code the handler already returns.
  const expected = [
    { method: 'post', route: '/v1/graphs', statuses: ['201', '400', '409', '422'] },
    { method: 'post', route: '/v1/jobs', statuses: ['201', '400'] },
    {
      method: 'patch',
      route: '/v1/input-requests/{id}/answer',
      statuses: ['200', '400', '404', '409'],
    },
  ];

  for (const { method, route, statuses } of expected) {
    const operation = operationAt(document, method, route);
    const label = `${method.toUpperCase()} ${route}`;

    assert.ok(operation.requestBody !== undefined, `${label}: no requestBody declared`);
    assertJsonSchema(operation.requestBody.content, `${label} requestBody`);

    assert.ok(operation.responses !== undefined, `${label}: no responses declared`);
    for (const status of statuses) {
      const response = operation.responses[status];
      assert.ok(response !== undefined, `${label}: status ${status} is not documented`);
      assertJsonSchema(response.content, `${label} response ${status}`);
    }
  }

  // The one route of the three that takes a path parameter says so, or a client
  // built from the document has no way to fill `{id}`.
  const answer = operationAt(document, 'patch', '/v1/input-requests/{id}/answer');
  assert.ok(
    (answer.parameters ?? []).some((item) => item.name === 'id' && item.in === 'path'),
    'PATCH /v1/input-requests/{id}/answer does not declare its path parameter',
  );
});

test('t171 AT4 — /openapi.json and /docs answer with no credential, and /v1 still does not', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  // FR2: a schema and a static UI are not data, so the credential gate that
  // guards every `/v1` route (t124) does not apply to them — same reasoning
  // `/health` already carries.
  const document = await fetch(`${ctx.url}/openapi.json`);
  assert.equal(document.status, 200, 'the document is public, like /health');

  const docs = await fetch(`${ctx.url}/docs`);
  assert.equal(docs.status, 200, 'the browsable UI is public too');
  assert.match(
    docs.headers.get('content-type') ?? '',
    /text\/html/,
    '/docs serves a page, not JSON',
  );

  // And the exemption did not leak: the business API is as closed as it was.
  const guarded = await fetch(`${ctx.url}${API_PREFIX}/graphs`);
  assert.equal(guarded.status, 401, 'documenting the API did not open it');

  // The suite's own credential still works, so the gate was not merely inverted.
  const authorized = await request<{ grafos: unknown[] }>(ctx, 'GET', `${API_PREFIX}/graphs`);
  assert.equal(authorized.status, 200);
});
