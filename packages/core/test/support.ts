/**
 * Shared support for the domain-entity acceptance tests (t102).
 *
 * This is not a test file (the package glob is `test/*.test.ts`): it is the
 * repeated part of six test files — starting the control plane against a
 * throwaway database and speaking HTTP to it.
 *
 * The `src/` modules are loaded on demand, behind an `existsSync`, for the same
 * reason as `test/health.test.ts:27-36`: on the initial red the failure has to
 * NAME the missing artifact, instead of blowing up with a module resolution
 * error that looks like any other bug.
 *
 * The interfaces here are deliberately hand-written instead of imported from
 * `src/`: they ARE the contract the tests demand of the API, and a contract
 * that imports itself from the implementation demands nothing.
 *
 * The JSON field names below are English on every surface since t227: the API
 * child (t226) translated the reads and the events child translated the writes,
 * so nothing here mirrors a migration column's spelling any more.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as ServerModule from '../src/server.ts';

/** Root of the `packages/core` package. */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Migrations directory of the package. */
export const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');

/** Artifacts this suite creates; every test requires the ones it exercises. */
export const T102_ARTIFACTS = Object.freeze({
  migration: 'migrations/0003_trabalho_sessao_evento_pergunta.sql',
  events: 'src/db/events.ts',
  validation: 'src/db/event-validation.ts',
  jobRepository: 'src/repositories/job.ts',
  sessionRepository: 'src/repositories/session.ts',
  inputRequestRepository: 'src/repositories/input-request.ts',
  jobRoutes: 'src/routes/jobs.ts',
  sessionRoutes: 'src/routes/sessions.ts',
  inputRequestRoutes: 'src/routes/input-requests.ts',
  executionRoutes: 'src/routes/executions.ts',
});

/**
 * Fails naming the missing file, instead of letting the import blow up.
 *
 * @param relatives Paths relative to the root of `packages/core`.
 */
export function requireArtifacts(...relatives: string[]): void {
  for (const relative of relatives) {
    assert.ok(
      existsSync(path.join(PACKAGE_ROOT, relative)),
      `artifact does not exist yet: packages/core/${relative}`,
    );
  }
}

/** Event envelope, as the taxonomy (t98) defines it. */
export interface Event {
  id: number;
  type: string;
  project_id: number;
  execution_id: number | null;
  entity: { type: string; id: number | string };
  actor: { type: string; ref: string };
  occurred_at: string;
  data: Record<string, unknown>;
}

/**
 * Job projection, as the API returns it.
 *
 * English on both sides since t227: the response went English with the API
 * child (t226), and what `createJob` below SENDS followed with the events
 * child, because that body goes straight into `validateEvent` and
 * `job.created`'s contract is what D20's second child renamed.
 */
export interface Job {
  id: number;
  project_id: number;
  execution_id: number | null;
  title: string;
  entry_node_id: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  graph_version_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Token totals of a session; `null` when the engine reported nothing. */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Session projection, as the API returns it. */
export interface Session {
  id: number;
  job_id: number | null;
  execution_id: number | null;
  node_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  timeout_seconds: number | null;
  /** Inactivity budget the session was opened with; null = no policy (t163). */
  silence_seconds: number | null;
  status: string;
  exit_code: number | null;
  /** Which watchdog stopped it, when one did (t163). */
  timeout_reason: string | null;
  usage: SessionUsage | null;
  /**
   * Which models the engine reported having run this session (t172).
   *
   * `null` is "the engine named none", and it is what every row from before
   * this column existed reads as. An empty list would be a different claim, and
   * one nobody has ever measured.
   */
  models: string[] | null;
  transcript: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
  opened_at: string;
  finished_at: string | null;
}

/** Input-request projection, as the API returns it. */
export interface InputRequest {
  id: number;
  job_id: number;
  session_id: number | null;
  execution_id: number | null;
  kind: string;
  /** The node the job was standing on when it asked; `null` if it had none (t167). */
  node_id: string | null;
  question: string;
  context: string | null;
  options: string[] | null;
  recommendation: string | null;
  default_answer: string | null;
  auto_approvable: boolean;
  status: string;
  answer: string | null;
  answered_by: string | null;
  /** Where the decision came from — `user` or `auto` since t227. */
  source: string | null;
  created_at: string;
  answered_at: string | null;
}

/** One row of `GET /v1/executions/:id/metrics-by-version`. */
export interface MetricByVersion {
  graph_version_id: string | null;
  jobs: number;
  events: number;
}

/** Control plane running, against a throwaway database. */
export interface TestContext {
  /** Database handle — the tests only READ through it; the API is the writer. */
  db: Database;
  /** Base URL of the server. */
  url: string;
  /**
   * Operator credential of this control plane (t124).
   *
   * Issued by the harness, because `createApp` does not mint one — that is the
   * startup's job (`src/index.ts`), and these tests bring the app up without it.
   * `request()` attaches it by default, which is what keeps every other suite in
   * the package passing unmodified now that `/v1/*` denies anonymous requests.
   */
  token: string;
}

/** The slice of `node:test`'s `TestContext` this support file uses. */
export interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

/**
 * Starts the whole control plane against a database in a temporary directory.
 *
 * @param t Test context, used to register the shutdown.
 * @returns Open database and base URL.
 */
export async function startControlPlane(t: TestHook): Promise<TestContext> {
  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>(
    'src/db/connection.ts',
  );
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');
  const { createApp } = await load<typeof ServerModule>('src/server.ts');
  const { issueCredential } = await load<typeof CredentialsModule>(
    'src/repositories/credentials.ts',
  );

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t102-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const { token } = issueCredential(db, { tipo: 'user' });

  const app = createApp({ db });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });

  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { db, url, token };
}

/** An HTTP response, already decoded. */
export interface HttpResponse<T> {
  status: number;
  body: T;
}

/**
 * Speaks HTTP/JSON with the control plane.
 *
 * Every request carries the context's credential (t124): what these suites are
 * about is the routes' behaviour, and re-proving the gate on each of them would
 * only make the gate's own test file redundant. The suite that exercises the
 * gate — `test/auth.test.ts` — builds its requests header by header instead.
 *
 * @param ctx Control plane running.
 * @param method HTTP verb.
 * @param routePath Path, already carrying the `/v1` prefix.
 * @param body JSON body, when there is one.
 * @returns Status and decoded body.
 */
export async function request<T>(
  ctx: TestContext,
  method: string,
  routePath: string,
  body?: unknown,
): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${ctx.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${ctx.url}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? undefined : JSON.parse(text)) as T,
  };
}

/** The log-reading surface the tests use (FR2). */
export interface EventsModule {
  recordEvent: unknown;
  listEvents: (db: Database) => Event[];
  getEventsByEntity: (db: Database, type: string, id: number | string) => Event[];
}

/** Loads `src/db/events.ts` on demand (named initial red). */
export async function loadEvents(): Promise<EventsModule> {
  return await load<EventsModule>(T102_ARTIFACTS.events);
}

/** How many events exist in the log, in total. */
export function countEvents(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM event').get() as { total: number };
  return row.total;
}

/* -------------------------------------------------------------------------- */
/* Making a document's pins resolvable (t283)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Registers a permissive manifest for every pin of a document that resolves to
 * nothing, rewriting those pins in place.
 *
 * Why every suite that registers a graph AND creates a job against it needs
 * this: `POST /v1/jobs` refuses a version whose contracts were never checked
 * (t283), and a version is `unchecked` exactly while some pin of it resolves to
 * nothing. The committed fixtures pin ids like `cartografo/redigir-nota`, which
 * the registry's kebab-case `ID_PATTERN` can never accept — so the pin as
 * written could not be registered even in principle, and the suites that used to
 * post those documents raw now have to say which capability each node stands
 * for.
 *
 * What it does NOT do is touch a pin that already resolves. A suite that
 * registered its own manifest — a gate with a real `outcome` schema, a skill
 * whose `output` a test asserts against — has already answered for that node,
 * and this helper stepping over it would swap a meaningful contract for an empty
 * one. The ids it invents carry a `-fixture` suffix for the same reason: they
 * must never collide with a manifest a suite registers on its own terms.
 *
 * The manifests it writes are deliberately EMPTY schemas: this exists so a
 * version can be `checked`, not so it can be interesting. A test that cares
 * about what a skill declares registers its own before calling here.
 *
 * @param ctx Control plane running.
 * @param document Graph document, mutated in place.
 * @returns The same document, with every pin resolvable.
 */
export async function resolvePins(
  ctx: TestContext,
  document: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return resolvePinsOver(document, {
    get: (routePath) => request(ctx, 'GET', routePath),
    post: (routePath, body) => request(ctx, 'POST', routePath, body),
  });
}

/**
 * {@link resolvePins}, for the suites that speak to the API through their own
 * harness instead of through `request()`.
 *
 * Three files start the control plane themselves and talk to it with a bare
 * `fetch` over `authorizeGlobalFetch` (`graph-routes`, `proposal-routes`,
 * `leases`). They need the same fixture capabilities, and a second copy of this
 * function in each of them is exactly what `no-duplicate-helpers.test.ts`
 * exists to prevent — so the HTTP calls come in as a parameter.
 *
 * @param document Graph document, mutated in place.
 * @param api How to reach the control plane: a GET and a POST, both decoded.
 * @returns The same document, with every pin resolvable.
 */
export async function resolvePinsOver(
  document: Record<string, unknown>,
  api: {
    get: (routePath: string) => Promise<{ status: number }>;
    post: (routePath: string, body: unknown) => Promise<{ status: number }>;
  },
): Promise<Record<string, unknown>> {
  const { manifestHash } = (await import(
    new URL('../src/domain/manifest.ts', import.meta.url).href
  )) as { manifestHash: (manifest: unknown) => string };

  const nodes = Array.isArray(document.nodes) ? document.nodes : [];
  for (const raw of nodes) {
    const node = raw as Record<string, unknown>;
    const pin = node.skill_ref as { id?: unknown; version?: unknown } | undefined;
    if (pin === undefined || typeof pin.id !== 'string') continue;
    const version = typeof pin.version === 'string' ? pin.version : '1.0.0';

    const known = await api.get(
      `/v1/skills/${encodeURIComponent(pin.id)}?version=${encodeURIComponent(version)}`,
    );
    if (known.status === 200) continue;

    const id = `${pin.id.split('/').pop() ?? pin.id}-fixture`;
    const manifest: Record<string, unknown> = {
      id,
      version,
      hash: '',
      role: 'work',
      description: `fixture capability standing in for the pin "${pin.id}"`,
      input: { type: 'object' },
      output: { type: 'object' },
      preconditions: [],
      checks: [
        {
          id: 'fixture-check',
          type: 'deterministic',
          description: 'The fixture declares a check, because every manifest owes one.',
          command: 'true',
        },
      ],
      permissions: { filesystem: { read: [], write: [] }, network: { allowed: false } },
      instructions: `Fixture capability for "${pin.id}".`,
      origin: { type: 'native' },
    };
    manifest.hash = manifestHash(manifest);

    const registered = await api.post('/v1/skills', manifest);
    assert.ok(
      registered.status === 201 || registered.status === 200,
      `registering the fixture manifest "${id}" answered ${registered.status}`,
    );

    node.skill_ref = { id, version, hash: manifest.hash };
  }

  return document;
}

/** Shortcut: creates a job and returns the projection. */
export async function createJob(
  ctx: TestContext,
  body: Record<string, unknown>,
): Promise<Job> {
  const response = await request<Job>(ctx, 'POST', '/v1/jobs', body);
  assert.equal(response.status, 201, `POST /v1/jobs returned ${response.status}`);
  return response.body;
}

/* -------------------------------------------------------------------------- */
/* The public OpenAPI document (t200, FR4)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything below came out of `test/openapi.test.ts`, where t171 wrote it for
 * the three routes of the basic flow.
 *
 * It moved here because it stopped being one file's business: t200 documents the
 * graphs + proposals family and t240–t244 document the five that are left, one
 * family per ticket, each asserting the same two things about its own operations.
 * A helper living in a `*.test.ts` file cannot be imported by another one without
 * dragging that file's tests into the importer's run, so `support.ts` — this
 * package's existing home for what more than one suite needs — is where it goes.
 *
 * The interfaces stay hand-written rather than imported from `openapi-types`, for
 * the same reason as the projections above: they ARE the shape the suites demand
 * of the document, and a contract that imports itself from the producer demands
 * nothing.
 */

/** A JSON Schema, as it travels inside the document — opaque here on purpose. */
export type SchemaObject = Record<string, unknown>;

/** One media type of a request body or a response. */
export interface MediaTypeObject {
  schema?: SchemaObject;
}

/**
 * One documented operation.
 *
 * `description` and a parameter's `schema` are the two fields t200 added to what
 * t171 wrote: FR3 puts the graph document's real contract in the operation's own
 * description, and the family's `:id` has to be readable as a STRING to guard the
 * coercion hazard `routes/proposals.ts` documents.
 */
export interface OperationObject {
  operationId?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; schema?: SchemaObject }>;
  requestBody?: { content?: Record<string, MediaTypeObject> };
  responses?: Record<string, { content?: Record<string, MediaTypeObject> }>;
}

/** The document, in the slice these suites read. */
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, OperationObject>>;
}

/** Fetches the public document from a running control plane. */
export async function fetchDocument(url: string): Promise<OpenApiDocument> {
  const response = await fetch(`${url}/openapi.json`);
  assert.equal(response.status, 200, 'GET /openapi.json has to answer');
  return (await response.json()) as OpenApiDocument;
}

/** Reads one operation out of the document by the full address a client calls. */
export function operationAt(
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
export function assertJsonSchema(
  content: Record<string, MediaTypeObject> | undefined,
  what: string,
): void {
  assert.ok(content !== undefined, `${what}: no content declared`);
  const media = content['application/json'];
  assert.ok(media !== undefined, `${what}: no application/json media type`);
  assert.ok(media.schema !== undefined, `${what}: the media type declares no schema`);
  assert.ok(Object.keys(media.schema).length > 0, `${what}: the schema is empty`);
}

/**
 * What one operation of a route family has to declare.
 *
 * `statuses` is every status the handler can answer TODAY — the list is read off
 * the handler, not wished for — and `hasRequestBody` is false by default because
 * an operation that never reads `request.body` must not document one: a client
 * generated from the document would then offer a payload the route ignores.
 */
export interface OperationExpectation {
  method: string;
  route: string;
  statuses: string[];
  hasRequestBody?: boolean;
}

/**
 * Asserts that a whole route family carries real request/response schemas.
 *
 * This is the assertion t200 wrote for graphs + proposals and that t240–t244
 * reuse for the five families that are left; its shape is fixed here so the five
 * do not each invent their own. It checks PRESENCE of a schema per declared
 * status and per request body, never the shape inside — the bodies of this
 * surface are deliberately open (`OPEN_OBJECT_SCHEMA`), and asserting a shape
 * here would be asking the routes to narrow what they accept and serialize.
 *
 * @param document The fetched public document.
 * @param expectations One entry per operation of the family.
 */
export function assertOperationSchemas(
  document: OpenApiDocument,
  expectations: OperationExpectation[],
): void {
  for (const { method, route, statuses, hasRequestBody } of expectations) {
    const operation = operationAt(document, method, route);
    const label = `${method.toUpperCase()} ${route}`;

    if (hasRequestBody === true) {
      assert.ok(operation.requestBody !== undefined, `${label}: no requestBody declared`);
      assertJsonSchema(operation.requestBody.content, `${label} requestBody`);
    }

    assert.ok(operation.responses !== undefined, `${label}: no responses declared`);
    for (const status of statuses) {
      const response = operation.responses[status];
      assert.ok(response !== undefined, `${label}: status ${status} is not documented`);
      assertJsonSchema(response.content, `${label} response ${status}`);
    }
  }
}
