/**
 * Acceptance tests of the ENQUEUE half of graph-declared hooks (t169, AT4–AT7).
 *
 * The split between this file and `test/hooks-dispatch.test.ts` is the ticket's
 * central guarantee turned into two suites: enqueuing is synchronous and
 * transactional with the fact that triggered it, and DELIVERING is not. Here
 * nothing is ever delivered — no dispatcher runs in the first four tests, and
 * the assertions read the `entrega_gancho` table straight. What a hook does with
 * a socket is the other file's problem, and that separation is the point.
 *
 * The repositories are called DIRECTLY rather than through the API, for the same
 * reason `test/webhooks-dispatch.test.ts` writes its facts with `recordEvent`:
 * the subject is what `transitionJob`/`blockJob` leave in the database, and
 * going through a route would only add a moving part between the claim and the
 * proof. The one test that does need the HTTP boundary — "the write path never
 * waits on delivery" — brings up a bare app carrying the job routes and the
 * dispatcher, and nothing else.
 *
 * The graph documents come from `schema/exemplos/`: the fixture the JSON Schema
 * validates is the same document the control plane reads back out of
 * `grafo_versao.snapshot`, and a hook that only ever existed in a test object
 * would prove nothing about the format.
 *
 * The column and JSON names stay in Portuguese: they mirror the migration and
 * the taxonomy's envelope (t127, FR8).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';

import { applyPragmas, openDatabase, type Database } from '../src/db/connection.ts';
import { migrate } from '../src/db/migrate.ts';
import type { GraphDocument } from '../src/domain/graph.ts';
import { registerBaseGraph } from '../src/repositories/graphs.ts';
import { blockJob, createJob, transitionJob, type Job } from '../src/repositories/job.ts';
import { registerJobs } from '../src/routes/jobs.ts';
import { MIGRATIONS_DIR, PACKAGE_ROOT, requireArtifacts, type TestHook } from './support.ts';

/** Artifacts this ticket creates; every test requires the ones it exercises. */
const T169_ARTIFACTS = Object.freeze({
  migration: 'migrations/0014_gancho.sql',
  repository: 'src/repositories/hooks.ts',
  dispatcher: 'src/hooks/dispatcher.ts',
});

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'exemplos');

/** The two hooks the fixture declares, named here so the assertions can read. */
const ON_ENTER = 'avisar-revisao';
const ON_BLOCK = 'avisar-bloqueio';

/** One row of `entrega_gancho`, read straight from the table. */
interface HookDelivery {
  id: number;
  projeto_id: number;
  execucao_id: number | null;
  trabalho_id: number;
  gancho_id: string;
  no_id: string;
  grafo_versao_id: string | null;
  evento_id: number;
  url: string;
  segredo: string;
  status: string;
  tentativas: number;
  proxima_tentativa_em: string;
  criada_em: string;
  entregue_em: string | null;
  ultimo_erro: string | null;
}

/** The slice of `fetch` the dispatcher is allowed to use. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

/** The surface `src/hooks/dispatcher.ts` has to expose. */
interface HookDispatcherModule {
  registerHookDispatcher: (
    app: FastifyInstance,
    db: Database,
    options?: { tickIntervalMs?: number; now?: () => string; fetchImpl?: FetchLike },
  ) => void;
}

/** Reads a graph fixture from `schema/exemplos/`. */
function readExample(name: string): GraphDocument {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as GraphDocument;
}

/** Opens a throwaway database, already migrated. */
function openWorld(t: TestHook): Database {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t169-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return db;
}

/**
 * Registers a graph document and returns the id of the version born with it.
 *
 * @param db Open database.
 * @param document Already valid graph document.
 * @returns The version hash a job cites in `grafo_versao_id`.
 */
function registerGraph(db: Database, document: GraphDocument): string {
  return registerBaseGraph(db, document).version.id;
}

/** Creates a job standing on `redigir`, optionally tied to a graph version. */
function newJob(db: Database, graphVersionId: string | null): Job {
  return createJob(db, {
    titulo: 'a nota que dispara ganchos',
    no_entrada_id: 'redigir',
    grafo_versao_id: graphVersionId ?? undefined,
  });
}

/** Every hook delivery in the table, oldest first. */
function hookDeliveries(db: Database): HookDelivery[] {
  return db
    .prepare(
      `SELECT id, projeto_id, execucao_id, trabalho_id, gancho_id, no_id, grafo_versao_id,
              evento_id, url, segredo, status, tentativas, proxima_tentativa_em,
              criada_em, entregue_em, ultimo_erro
         FROM entrega_gancho ORDER BY id`,
    )
    .all() as HookDelivery[];
}

/** The one delivery of a table that is supposed to have exactly one. */
function only(rows: HookDelivery[]): HookDelivery {
  assert.equal(rows.length, 1, `expected exactly one hook delivery, got ${rows.length}`);
  return rows[0];
}

test('AT4 — entering a node with a matching node_entered hook enqueues one delivery', async (t) => {
  requireArtifacts(T169_ARTIFACTS.migration, T169_ARTIFACTS.repository);
  const db = openWorld(t);

  const document = readExample('grafo-valido-com-ganchos.json');
  const versionId = registerGraph(db, document);
  const job = newJob(db, versionId);

  const moved = transitionJob(db, job.id, { para_no_id: 'revisar' });
  assert.equal(moved?.no_atual, 'revisar', 'the traversal itself is untouched');

  const enqueued = only(hookDeliveries(db));
  assert.equal(enqueued.gancho_id, ON_ENTER);
  assert.equal(enqueued.no_id, 'revisar');
  assert.equal(enqueued.trabalho_id, job.id);
  assert.equal(enqueued.projeto_id, job.projeto_id);
  assert.equal(enqueued.grafo_versao_id, versionId);
  assert.equal(enqueued.status, 'pendente');
  assert.equal(enqueued.tentativas, 0);
  assert.equal(enqueued.entregue_em, null);
  assert.equal(enqueued.ultimo_erro, null);

  // URL and secret are carried from the graph document, which is what makes the
  // reaction versioned with it instead of registered out of band.
  const declared = document.hooks?.find((hook) => hook.id === ON_ENTER);
  assert.ok(declared !== undefined, 'the fixture has to declare the node_entered hook');
  assert.equal(enqueued.url, declared.destination.url);
  assert.equal(enqueued.segredo, declared.destination.secret);

  // And the delivery points at the very event that triggered it.
  const trigger = db
    .prepare(
      `SELECT id, tipo FROM evento
        WHERE entidade_tipo = 'trabalho' AND entidade_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(String(job.id)) as { id: number; tipo: string };
  assert.equal(trigger.tipo, 'trabalho.transicao');
  assert.equal(enqueued.evento_id, trigger.id);
});

test('AT5 — blocking fires only the node_blocked hook of the node it blocked on', async (t) => {
  requireArtifacts(T169_ARTIFACTS.migration, T169_ARTIFACTS.repository);
  const db = openWorld(t);

  const versionId = registerGraph(db, readExample('grafo-valido-com-ganchos.json'));

  // Blocked on `redigir`, which is exactly where the node_blocked hook points.
  const stuck = newJob(db, versionId);
  const blocked = blockJob(db, stuck.id, { motivo: 'a redação parou esperando o tema' });
  assert.equal(blocked?.bloqueado, true);

  const enqueued = only(hookDeliveries(db));
  assert.equal(enqueued.gancho_id, ON_BLOCK);
  assert.equal(enqueued.no_id, 'redigir');
  assert.equal(enqueued.status, 'pendente');

  // A block on `revisar` matches nothing: its only hook is a node_entered one,
  // and a trigger is half of the match, never a detail of it.
  const walking = newJob(db, versionId);
  transitionJob(db, walking.id, { para_no_id: 'revisar' });
  const afterMoving = hookDeliveries(db).length;

  blockJob(db, walking.id, { motivo: 'a revisão parou' });

  assert.equal(
    hookDeliveries(db).length,
    afterMoving,
    'blocking on a node whose only hook is node_entered enqueues nothing',
  );
});

test('AT6 — a job with no graph version enqueues nothing, and raises nothing', async (t) => {
  requireArtifacts(T169_ARTIFACTS.migration, T169_ARTIFACTS.repository);
  const db = openWorld(t);

  const job = newJob(db, null);
  assert.equal(job.grafo_versao_id, null);

  const moved = transitionJob(db, job.id, { para_no_id: 'revisar' });
  assert.equal(moved?.no_atual, 'revisar');
  const blocked = blockJob(db, job.id, { motivo: 'sem grafo, e mesmo assim travado' });
  assert.equal(blocked?.bloqueado, true);

  assert.deepEqual(hookDeliveries(db), [], 'nothing to look hooks up in is not an error');
});

test('AT7 — a graph version with no hooks key enqueues nothing, and raises nothing', async (t) => {
  requireArtifacts(T169_ARTIFACTS.migration, T169_ARTIFACTS.repository);
  const db = openWorld(t);

  const document = readExample('grafo-valido-minimo.json');
  assert.ok(!Object.hasOwn(document, 'hooks'), 'the minimal fixture is the "absent" case');

  const job = newJob(db, registerGraph(db, document));
  transitionJob(db, job.id, { para_no_id: 'revisar' });
  blockJob(db, job.id, { motivo: 'a revisão parou' });

  assert.deepEqual(
    hookDeliveries(db),
    [],
    'every graph written before this ticket keeps walking exactly as it did',
  );
});

test('AT7 — the write path answers 200 even when the hook destination rejects', async (t) => {
  requireArtifacts(
    T169_ARTIFACTS.migration,
    T169_ARTIFACTS.repository,
    T169_ARTIFACTS.dispatcher,
  );
  const { registerHookDispatcher } = (await import(
    '../src/hooks/dispatcher.ts'
  )) as HookDispatcherModule;

  const db = openWorld(t);
  const versionId = registerGraph(db, readExample('grafo-valido-com-ganchos.json'));
  const job = newJob(db, versionId);

  let attempts = 0;
  const app = Fastify({ logger: false });
  app.register(async (scope) => registerJobs(scope, db), { prefix: '/v1' });
  registerHookDispatcher(app, db, {
    tickIntervalMs: 10,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('consumidor do gancho fora do ar');
    },
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
  });

  const response = await fetch(`${url}/v1/jobs/${job.id}/transitions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ para_no_id: 'revisar' }),
  });
  const body = (await response.json()) as Job;

  assert.equal(response.status, 200, 'a hook failure is never the traveller\'s problem');
  assert.equal(body.id, job.id);
  assert.equal(body.no_atual, 'revisar');
  assert.equal(body.bloqueado, false);

  // The delivery exists and is retried in the background; the response above did
  // not wait for a single one of those attempts.
  assert.equal(only(hookDeliveries(db)).gancho_id, ON_ENTER);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(attempts >= 1, 'and the dispatcher does attempt it, after the answer went out');
  assert.equal(only(hookDeliveries(db)).status, 'pendente', 'a failed attempt is not terminal');
});
