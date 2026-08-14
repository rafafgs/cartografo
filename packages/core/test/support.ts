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
 * The JSON field names below stay in Portuguese on purpose: they mirror the
 * untouched migration columns, and the D18 rename does not translate wire
 * fields that are a direct passthrough of a column (t127, FR8).
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
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade: { tipo: string; id: number | string };
  ator: { tipo: string; ref: string };
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** Job projection, as the API returns it. */
export interface Job {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
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
  trabalho_id: number | null;
  execucao_id: number | null;
  no_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  timeout_seconds: number | null;
  status: string;
  exit_code: number | null;
  uso: SessionUsage | null;
  aberta_em: string;
  finalizada_em: string | null;
}

/** Input-request projection, as the API returns it. */
export interface InputRequest {
  id: number;
  trabalho_id: number;
  sessao_id: number | null;
  execucao_id: number | null;
  tipo: string;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  auto_aprovavel: boolean;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
  criada_em: string;
  respondida_em: string | null;
}

/** One row of `GET /v1/executions/:id/metrics-by-version`. */
export interface MetricByVersion {
  grafo_versao_id: string | null;
  trabalhos: number;
  eventos: number;
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

  const { token } = issueCredential(db, { tipo: 'usuario' });

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
  getEventsByEntity: (db: Database, tipo: string, id: number | string) => Event[];
}

/** Loads `src/db/events.ts` on demand (named initial red). */
export async function loadEvents(): Promise<EventsModule> {
  return await load<EventsModule>(T102_ARTIFACTS.events);
}

/** How many events exist in the log, in total. */
export function countEvents(ctx: TestContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS total FROM evento').get() as { total: number };
  return row.total;
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
