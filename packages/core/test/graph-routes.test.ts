/**
 * Graph route acceptance tests (t101, FR5/FR6).
 *
 * The central test is AT6: the `grafo.json` of factory bundle 1 (t105) goes in
 * through the API **with no editing at all**. It is the integration proof of
 * D16's "graph living as data in the database" criterion — a synthetic fixture
 * would not prove that.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are in
 * English.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as HashModule from '../src/domain/hash.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as ServerModule from '../src/server.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'exemplos');
const FACTORY_GRAPH = path.join(
  REPO_ROOT,
  'grafos-de-fabrica',
  'desenvolvimento-de-software',
  'grafo.json',
);

/** Minimal test context used by the helpers in this file. */
interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface GraphRow {
  id: string;
  classe: string;
  linhagem_tipo: string;
  base_classe: string | null;
  origem_proposta_id: number | null;
  versao_corrente_id: string | null;
  criado_em: string;
}

interface VersionRow {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  criado_em: string;
}

interface ValidationReport {
  erro: string;
  valido: boolean;
  estrutura: { valido: boolean; erros: Array<{ codigo: string; alvo: unknown }> };
  soundness: { valido: boolean; violacoes: Array<{ regra: string; alvo: unknown }> };
}

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;
let hashCache: typeof HashModule | null = null;

async function loadConnection(): Promise<typeof ConnectionModule> {
  connectionCache ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  return connectionCache;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  migrateCache ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  return migrateCache;
}

async function loadServer(): Promise<typeof ServerModule> {
  serverCache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ServerModule;
  return serverCache;
}

async function loadHash(): Promise<typeof HashModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'domain', 'hash.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/domain/hash.ts');
  hashCache ??= (await import(
    new URL('../src/domain/hash.ts', import.meta.url).href
  )) as typeof HashModule;
  return hashCache;
}

/** Starts a whole control plane against a temporary database and returns the URL. */
async function startApp(t: TestHook): Promise<string> {
  assert.ok(
    existsSync(path.join(MIGRATIONS_DIR, '0002_grafo_versao_proposta.sql')),
    'artifact does not exist yet: packages/core/migrations/0002_grafo_versao_proposta.sql',
  );
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'routes', 'graphs.ts')),
    'artifact does not exist yet: packages/core/src/routes/graphs.ts',
  );

  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp } = await loadServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t101-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  // Every `/v1` route demands a credential since t124; this suite is about
  // the routes, so the harness issues one and presents it on every call.
  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
  const { token } = issueCredential(db, { tipo: 'usuario' });

  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  authorizeGlobalFetch(t, { baseUrl: address, token });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return address;
}

async function post(address: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${address}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

test('AT6 — factory graph 1 goes in through the API unedited, hashing the whole snapshot', async (t) => {
  const address = await startApp(t);
  const { hashSnapshot } = await loadHash();

  assert.ok(existsSync(FACTORY_GRAPH), 'factory bundle 1 (t105) has to be in the repo');
  const document = readJson(FACTORY_GRAPH);

  const response = await post(address, '/v1/graphs', document);
  const body = await jsonBody<{ grafo: GraphRow; grafo_versao: VersionRow }>(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.grafo.id, 'desenvolvimento-de-software');
  assert.equal(body.grafo.classe, 'desenvolvimento-de-software');
  assert.equal(body.grafo.linhagem_tipo, 'base');
  assert.equal(body.grafo.base_classe, null);

  assert.equal(
    body.grafo_versao.id,
    hashSnapshot(document),
    'the version id is the sha256 of the WHOLE canonicalized document',
  );
  assert.match(body.grafo_versao.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(body.grafo_versao.versao_pai, null, 'the first version of the lineage has no parent');
  assert.equal(body.grafo_versao.origem, 'manual');
  assert.equal(body.grafo_versao.grafo_id, 'desenvolvimento-de-software');

  // Bootstrapping a new lineage is the only situation in which registering moves
  // the pointer in the same call: there is no previous "current" to preserve.
  assert.equal(body.grafo.versao_corrente_id, body.grafo_versao.id);

  // The stored snapshot is the whole document, recoverable byte for byte in value.
  const version = await fetch(
    `${address}/v1/graph-versions/${encodeURIComponent(body.grafo_versao.id)}`,
  );
  assert.equal(version.status, 200);
  const versionBody = await jsonBody<{ grafo_versao: VersionRow & { snapshot: unknown } }>(version);
  assert.deepEqual(versionBody.grafo_versao.snapshot, document);
});

test('AT7 — registering the same class twice returns 409 on the second', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  assert.equal((await post(address, '/v1/graphs', document)).status, 201);

  const second = await post(address, '/v1/graphs', document);
  assert.equal(second.status, 409);
  const body = await jsonBody<{ erro: string }>(second);
  assert.equal(body.erro, 'classe_ja_registrada');
});

test('AT8 — registering a variant returns 400 (D13/t118 are out of this ticket)', async (t) => {
  const address = await startApp(t);

  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));
  document.classe = 'nota-curta-do-projeto';
  document.linhagem = { tipo: 'variante', base_classe: 'nota-curta' };

  const response = await post(address, '/v1/graphs', document);
  assert.equal(response.status, 400);
  assert.equal((await jsonBody<{ erro: string }>(response)).erro, 'linhagem_nao_base');
});

test('AT9 — a graph that breaks soundness returns 422 with the validator report', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-invalido-no-inalcancavel.json'));

  const response = await post(address, '/v1/graphs', document);
  assert.equal(response.status, 422);

  const body = await jsonBody<ValidationReport>(response);
  assert.equal(body.erro, 'grafo_invalido');
  assert.equal(body.valido, false);
  assert.deepEqual(
    body.soundness.violacoes,
    [{ regra: 'alcançável', alvo: 'revisar_lote' }],
    'the report has to be the same one as scripts/validar-grafo.mjs',
  );

  // Nothing was written: a graph that fails the gate does not become a lineage.
  const graphs = await jsonBody<{ grafos: GraphRow[] }>(await fetch(`${address}/v1/graphs`));
  assert.deepEqual(graphs.grafos, []);
});

test('t153 — a graph whose ids are not filled strings returns 422 and registers nothing', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  // The whole document is the minimal example, except that every place naming a
  // node names the NUMBER 1. Nothing else is wrong with it: before t153 the
  // validator dropped each of those ids out of scope instead of refusing it, so
  // soundness passed over an empty topology and this very body came back 201.
  const nodes = document.nos as Array<Record<string, unknown>>;
  const edges = document.arestas as Array<Record<string, unknown>>;
  nodes[0].id = 1;
  document.nos = [nodes[0]];
  edges[0].de = 1;
  edges[0].para = 1;
  document.no_inicial = 1;
  document.nos_finais = [1];

  const response = await post(address, '/v1/graphs', document);
  const body = await jsonBody<ValidationReport>(response);
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.equal(body.erro, 'grafo_invalido');
  assert.equal(body.valido, false);
  assert.ok(
    body.estrutura.erros.some((item) => item.codigo === 'id_invalido'),
    `the report has to name the invalid ids: ${JSON.stringify(body.estrutura.erros)}`,
  );

  // Nothing was written: a document that fails the gate does not become a lineage.
  const graphs = await jsonBody<{ grafos: GraphRow[] }>(await fetch(`${address}/v1/graphs`));
  assert.deepEqual(graphs.grafos, []);
});

test('AT10 — the reads reflect the freshly registered graph and 404 on what does not exist', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  const creation = await post(address, '/v1/graphs', document);
  assert.equal(creation.status, 201);
  const { grafo_versao: version } = await jsonBody<{ grafo_versao: VersionRow }>(creation);

  const byId = await fetch(`${address}/v1/graphs/nota-curta`);
  assert.equal(byId.status, 200);
  const byIdBody = await jsonBody<{ grafo: GraphRow }>(byId);
  assert.equal(byIdBody.grafo.id, 'nota-curta');
  assert.equal(byIdBody.grafo.versao_corrente_id, version.id);

  const list = await jsonBody<{ grafos: GraphRow[] }>(await fetch(`${address}/v1/graphs`));
  assert.deepEqual(
    list.grafos.map((graph) => graph.id),
    ['nota-curta'],
  );

  const classes = await jsonBody<{ classes: Array<{ classe: string; grafo_id: string }> }>(
    await fetch(`${address}/v1/classes`),
  );
  assert.deepEqual(classes.classes.map((entry) => entry.classe), ['nota-curta']);
  assert.equal(classes.classes[0].grafo_id, 'nota-curta');

  const versions = await jsonBody<{ versoes: VersionRow[] }>(
    await fetch(`${address}/v1/graphs/nota-curta/versions`),
  );
  assert.deepEqual(
    versions.versoes.map((row) => row.id),
    [version.id],
  );

  assert.equal((await fetch(`${address}/v1/graphs/inexistente`)).status, 404);
  assert.equal((await fetch(`${address}/v1/graphs/inexistente/versions`)).status, 404);
  assert.equal((await fetch(`${address}/v1/graph-versions/sha256:naoexiste`)).status, 404);
});

test('t127 — the old Portuguese graph paths no longer exist', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  const creation = await post(address, '/v1/graphs', document);
  assert.equal(creation.status, 201);
  const { grafo_versao: version } = await jsonBody<{ grafo_versao: VersionRow }>(creation);

  assert.equal((await post(address, '/v1/grafos', document)).status, 404);
  assert.equal((await fetch(`${address}/v1/grafos`)).status, 404);
  assert.equal((await fetch(`${address}/v1/grafos/nota-curta`)).status, 404);
  assert.equal((await fetch(`${address}/v1/grafos/nota-curta/versoes`)).status, 404);
  assert.equal(
    (await fetch(`${address}/v1/grafo-versoes/${encodeURIComponent(version.id)}`)).status,
    404,
  );
});
