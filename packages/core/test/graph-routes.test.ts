/**
 * Graph route acceptance tests (t101, FR5/FR6).
 *
 * The central test is AT6: the `grafo.json` of factory bundle 1 (t105) goes in
 * through the API **with no editing at all**. It is the integration proof of
 * D16's "graph living as data in the database" criterion — a synthetic fixture
 * would not prove that.
 *
 * Since t226 the JSON is English, per `docs/spec/glossario-wire.md` §1: the
 * migration columns are still `classe`/`linhagem_tipo`/`criado_em` (renaming
 * them is D20's fourth child), and `repositories/graphs.ts`'s `toGraph` is the
 * boundary between the two. What is asserted here is the wire, so the
 * expectations below are the English side of that boundary.
 *
 * The `estrutura`/`soundness` report riding inside the 422 is NOT translated,
 * and the assertions on it are the pin: it is the graph validator's own
 * vocabulary, which D20 hands to its fifth child (routes, flags and report).
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

interface Graph {
  id: string;
  class: string;
  lineage_type: string;
  base_class: string | null;
  origin_proposal_id: number | null;
  current_version_id: string | null;
  created_at: string;
}

interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
}

interface ValidationReport {
  error: string;
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
  const body = await jsonBody<{ graph: Graph; graph_version: GraphVersion }>(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.graph.id, 'desenvolvimento-de-software');
  assert.equal(body.graph.class, 'desenvolvimento-de-software');
  assert.equal(body.graph.lineage_type, 'base');
  assert.equal(body.graph.base_class, null);

  assert.equal(
    body.graph_version.id,
    hashSnapshot(document),
    'the version id is the sha256 of the WHOLE canonicalized document',
  );
  assert.match(body.graph_version.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(body.graph_version.parent_version, null, 'the first version of the lineage has no parent');
  assert.equal(body.graph_version.source, 'manual');
  assert.equal(body.graph_version.graph_id, 'desenvolvimento-de-software');

  // Bootstrapping a new lineage is the only situation in which registering moves
  // the pointer in the same call: there is no previous "current" to preserve.
  assert.equal(body.graph.current_version_id, body.graph_version.id);

  // The stored snapshot is the whole document, recoverable byte for byte in value.
  const version = await fetch(
    `${address}/v1/graph-versions/${encodeURIComponent(body.graph_version.id)}`,
  );
  assert.equal(version.status, 200);
  const versionBody = await jsonBody<{ graph_version: GraphVersion & { snapshot: unknown } }>(version);
  assert.deepEqual(versionBody.graph_version.snapshot, document);
});

test('AT7 — registering the same class twice returns 409 on the second', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  assert.equal((await post(address, '/v1/graphs', document)).status, 201);

  const second = await post(address, '/v1/graphs', document);
  assert.equal(second.status, 409);
  const body = await jsonBody<{ error: string }>(second);
  assert.equal(body.error, 'class_already_registered');
});

test('AT8 — registering a variant returns 400 (D13/t118 are out of this ticket)', async (t) => {
  const address = await startApp(t);

  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));
  document.problem_class = 'nota-curta-do-projeto';
  document.lineage = { type: 'variante', base_class: 'nota-curta' };

  const response = await post(address, '/v1/graphs', document);
  assert.equal(response.status, 400);
  assert.equal((await jsonBody<{ error: string }>(response)).error, 'lineage_not_base');
});

test('AT9 — a graph that breaks soundness returns 422 with the validator report', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-invalido-no-inalcancavel.json'));

  const response = await post(address, '/v1/graphs', document);
  assert.equal(response.status, 422);

  const body = await jsonBody<ValidationReport>(response);
  assert.equal(body.error, 'invalid_graph');
  assert.equal(body.valido, false);
  assert.deepEqual(
    body.soundness.violacoes,
    [{ regra: 'alcançável', alvo: 'revisar_lote' }],
    'the report has to be the same one as scripts/validar-grafo.mjs',
  );

  // Nothing was written: a graph that fails the gate does not become a lineage.
  const graphs = await jsonBody<{ graphs: Graph[] }>(await fetch(`${address}/v1/graphs`));
  assert.deepEqual(graphs.graphs, []);
});

test('t153 — a graph whose ids are not filled strings returns 422 and registers nothing', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  // The whole document is the minimal example, except that every place naming a
  // node names the NUMBER 1. Nothing else is wrong with it: before t153 the
  // validator dropped each of those ids out of scope instead of refusing it, so
  // soundness passed over an empty topology and this very body came back 201.
  const nodes = document.nodes as Array<Record<string, unknown>>;
  const edges = document.edges as Array<Record<string, unknown>>;
  nodes[0].id = 1;
  document.nodes = [nodes[0]];
  edges[0].de = 1;
  edges[0].para = 1;
  document.initial_node = 1;
  document.final_nodes = [1];

  const response = await post(address, '/v1/graphs', document);
  const body = await jsonBody<ValidationReport>(response);
  assert.equal(response.status, 422, JSON.stringify(body));
  assert.equal(body.error, 'invalid_graph');
  assert.equal(body.valido, false);
  assert.ok(
    body.estrutura.erros.some((item) => item.codigo === 'id_invalido'),
    `the report has to name the invalid ids: ${JSON.stringify(body.estrutura.erros)}`,
  );

  // Nothing was written: a document that fails the gate does not become a lineage.
  const graphs = await jsonBody<{ graphs: Graph[] }>(await fetch(`${address}/v1/graphs`));
  assert.deepEqual(graphs.graphs, []);
});

test('AT10 — the reads reflect the freshly registered graph and 404 on what does not exist', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  const creation = await post(address, '/v1/graphs', document);
  assert.equal(creation.status, 201);
  const { graph_version: version } = await jsonBody<{ graph_version: GraphVersion }>(creation);

  const byId = await fetch(`${address}/v1/graphs/nota-curta`);
  assert.equal(byId.status, 200);
  const byIdBody = await jsonBody<{ graph: Graph }>(byId);
  assert.equal(byIdBody.graph.id, 'nota-curta');
  assert.equal(byIdBody.graph.current_version_id, version.id);

  const list = await jsonBody<{ graphs: Graph[] }>(await fetch(`${address}/v1/graphs`));
  assert.deepEqual(
    list.graphs.map((graph) => graph.id),
    ['nota-curta'],
  );

  const classes = await jsonBody<{ classes: Array<{ class: string; graph_id: string }> }>(
    await fetch(`${address}/v1/classes`),
  );
  assert.deepEqual(classes.classes.map((entry) => entry.class), ['nota-curta']);
  assert.equal(classes.classes[0].graph_id, 'nota-curta');

  const versions = await jsonBody<{ versions: GraphVersion[] }>(
    await fetch(`${address}/v1/graphs/nota-curta/versions`),
  );
  assert.deepEqual(
    versions.versions.map((row) => row.id),
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
  const { graph_version: version } = await jsonBody<{ graph_version: GraphVersion }>(creation);

  assert.equal((await post(address, '/v1/grafos', document)).status, 404);
  assert.equal((await fetch(`${address}/v1/grafos`)).status, 404);
  assert.equal((await fetch(`${address}/v1/grafos/nota-curta`)).status, 404);
  assert.equal((await fetch(`${address}/v1/grafos/nota-curta/versoes`)).status, 404);
  assert.equal(
    (await fetch(`${address}/v1/grafo-versoes/${encodeURIComponent(version.id)}`)).status,
    404,
  );
});

test('t180 — the register guards refuse in English, quoting the class', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));

  const first = await post(address, '/v1/graphs', document);
  assert.equal(first.status, 201, JSON.stringify(await jsonBody(first)));

  const again = await post(address, '/v1/graphs', document);
  assert.equal(again.status, 409);
  const taken = await jsonBody<{ error: string; message: string }>(again);
  assert.equal(taken.error, 'class_already_registered', 'the code is frozen (FR2)');
  assert.equal(
    taken.message,
    `class "${String(document.problem_class)}" already has a base graph; a new version over an existing lineage is the proposal flow`,
  );

  const asVariant = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-minimo.json'));
  asVariant.problem_class = 'outra-classe';
  asVariant.lineage = { type: 'variante', base_class: String(document.problem_class) };
  const refused = await post(address, '/v1/graphs', asVariant);
  assert.equal(refused.status, 400);
  const notBase = await jsonBody<{ error: string; message: string }>(refused);
  assert.equal(notBase.error, 'lineage_not_base');
  assert.equal(
    notBase.message,
    'this route registers only a base graph; a variant is born from POST /v1/graphs/:id/fork (D13)',
  );
});

/*
 * t194 — the leak check at the API boundary.
 *
 * A graph version is content-addressed and served whole, so anything the
 * document carries is readable by every client that can read the version. This
 * is that property turned into a test: the hook's key is registered through
 * `PUT /v1/hook-secrets/:nome`, the document carries only the NAME, and the two
 * routes that serve version data are grepped for the raw value.
 *
 * The assertion is on the raw JSON text and not on a parsed field, for the same
 * reason `webhooks-routes.test.ts` does it: a nested copy would slip past a
 * lookup by key, and "the secret is nowhere in this response" is the claim.
 */
test('t194 — a hook secret never comes back out of the version routes', async (t) => {
  const address = await startApp(t);
  const document = readJson(path.join(EXAMPLES_DIR, 'grafo-valido-com-ganchos.json'));

  const hooks = document.hooks as Array<{ destination: { secret_ref: string } }>;
  assert.ok(hooks.length > 0, 'the fixture has to declare hooks');

  const registered = new Map<string, string>();
  for (const hook of hooks) {
    const reference = hook.destination.secret_ref;
    assert.equal(typeof reference, 'string', 'the document carries a reference, never a value');
    const value = `chave-hmac-de-${reference}`;
    registered.set(reference, value);

    const response = await fetch(`${address}/v1/hook-secrets/${reference}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    assert.ok(
      response.status === 201 || response.status === 200,
      `registering ${reference} answered ${response.status}`,
    );
  }

  const creation = await post(address, '/v1/graphs', document);
  const created = await jsonBody<{ graph_version: GraphVersion }>(creation);
  assert.equal(creation.status, 201, JSON.stringify(created));
  const { graph_version: version } = created;

  const listed = await jsonBody(
    await fetch(`${address}/v1/graphs/${String(document.problem_class)}/versions`),
  );
  const byId = await jsonBody<{ graph_version: GraphVersion & { snapshot: unknown } }>(
    await fetch(`${address}/v1/graph-versions/${encodeURIComponent(version.id)}`),
  );

  for (const [what, body] of [
    ['GET /v1/graphs/:id/versions', listed],
    ['GET /v1/graph-versions/:id', byId],
  ] as const) {
    const text = JSON.stringify(body);
    for (const [reference, value] of registered) {
      assert.ok(!text.includes(value), `${what} leaked the secret of "${reference}": ${text}`);
    }
  }

  // And the document that comes back is still the whole document: what was
  // removed is the value, not the declaration.
  const snapshot = JSON.stringify(byId.graph_version.snapshot);
  assert.ok(!snapshot.includes('"secret"'), 'no snapshot carries a plaintext secret field');
  for (const reference of registered.keys()) {
    assert.ok(
      snapshot.includes(`"secret_ref":"${reference}"`),
      `the snapshot still names "${reference}", which is what the enqueue resolves`,
    );
  }
});
