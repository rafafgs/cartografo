/**
 * Acceptance tests for `POST /v1/graphs/validate` (t460, FR1–FR3).
 *
 * The route is a QUERY over `validateGraph`, and every test below is written
 * against that one word. It answers 200 for a sound document and 200 for a
 * broken one — "invalid" is the answer, not a failure — it writes nothing, and
 * what it says about a document is the same thing, field for field, that the
 * `422 invalid_graph` of `POST /v1/proposals/:id/apply` says about the same
 * document.
 *
 * That last one (AT5) is the test worth keeping: the point of the route is that
 * a map still being drawn can be shown the refusal it WOULD get, and a report
 * that drifted from the one the register path actually produces would be a page
 * confidently naming problems nobody is going to be stopped by. The two are
 * pinned to each other here, over the same resulting document, so the drift
 * cannot happen silently.
 *
 * The harness is `proposal-routes.test.ts`'s, narrowed to what these five cases
 * need: a real control plane on a temporary database, reached over HTTP with a
 * credential, and every fixture read from `schema/examples/`.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type * as CredentialsModule from '../src/repositories/credentials.ts';
import type { GraphDocument } from '../src/domain/graph.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as OperationsModule from '../src/domain/operations.ts';
import type * as ServerModule from '../src/server.ts';
import { authorizeGlobalFetch } from './authorized-fetch.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');
const MINIMAL_EXAMPLE = path.join(EXAMPLES_DIR, 'graph-valid-minimal.json');
const EDGE_COUNTEREXAMPLE = path.join(EXAMPLES_DIR, 'graph-invalid-edge-without-condition.json');

/** The route under test, in one place. */
const ROUTE = '/v1/graphs/validate';

/** Minimal test context used by the helpers in this file. */
interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** The whole 200 body — `GraphReport` as it crosses the wire. */
interface Report {
  valid: boolean;
  structure: { valid: boolean; errors: Array<{ code: string; message: string; target: unknown }> };
  soundness: { valid: boolean; violations: Array<{ rule: string; target: unknown }> };
}

interface Graph {
  id: string;
  class: string;
  current_version_id: string | null;
}

interface GraphVersion {
  id: string;
  graph_id: string;
}

interface Proposal {
  id: number;
  status: string;
}

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;
let operationsCache: typeof OperationsModule | null = null;

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

async function loadOperations(): Promise<typeof OperationsModule> {
  operationsCache ??= (await import(
    new URL('../src/domain/operations.ts', import.meta.url).href
  )) as typeof OperationsModule;
  return operationsCache;
}

async function startApp(t: TestHook): Promise<string> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'routes', 'graphs.ts')),
    'artifact does not exist yet: packages/core/src/routes/graphs.ts',
  );

  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp } = await loadServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t460-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const { issueCredential } = (await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  )) as typeof CredentialsModule;
  const { token } = issueCredential(db, { type: 'user' });

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

/** Asks the route, asserting the one status it is allowed to answer. */
async function validate(address: string, document: unknown): Promise<Report> {
  const response = await post(address, ROUTE, document);
  const body = await jsonBody<Report>(response);
  assert.equal(response.status, 200, `the route answers 200 always: ${JSON.stringify(body)}`);
  return body;
}

function readExample(file: string): GraphDocument {
  return JSON.parse(readFileSync(file, 'utf8')) as GraphDocument;
}

/** The two ends of the counterexample's single edge, as the report names them. */
const COUNTEREXAMPLE_EDGE = { from: 'coletar_fontes', to: 'resumir_fontes' };

/**
 * The counterexample of `edge_with_condition`, with the label made `null`.
 *
 * `null` and not the fixture's own `""` because that is the shape job 5's live
 * draft carried, and it is the one this ticket exists for: an interview that
 * never asked for the label leaves the key at `null`.
 */
function edgeWithoutCondition(): GraphDocument {
  const document = readExample(EDGE_COUNTEREXAMPLE);
  const edges = document.edges as unknown as Array<Record<string, unknown>>;
  edges[0].condition = null;
  return document;
}

test('t460 AT1 — a sound document validates as valid, with both reports empty', async (t) => {
  const address = await startApp(t);

  const report = await validate(address, readExample(MINIMAL_EXAMPLE));

  assert.deepEqual(report, {
    valid: true,
    structure: { valid: true, errors: [] },
    soundness: { valid: true, violations: [] },
  });
});

test('t460 AT2 — an edge with condition null comes back as one edge_with_condition violation', async (t) => {
  const address = await startApp(t);

  const report = await validate(address, edgeWithoutCondition());

  assert.equal(report.valid, false);
  assert.deepEqual(report.soundness.violations, [
    { rule: 'edge_with_condition', target: COUNTEREXAMPLE_EDGE },
  ]);
  assert.equal(report.soundness.valid, false);
});

test('t460 AT3 — a document with no "nodes" comes back as a structure failure', async (t) => {
  const address = await startApp(t);

  const document = readExample(MINIMAL_EXAMPLE) as unknown as Record<string, unknown>;
  delete document.nodes;

  const report = await validate(address, document);

  assert.equal(report.structure.valid, false);
  assert.ok(report.structure.errors.length > 0, 'a refusal with no error names nothing');
  assert.ok(
    report.structure.errors.every(
      (error) => typeof error.code === 'string' && typeof error.message === 'string',
    ),
    `every error keeps its code and its message on the wire: ${JSON.stringify(report.structure.errors)}`,
  );
});

test('t460 AT4 — validating writes nothing at all', async (t) => {
  const address = await startApp(t);

  // Something to count: a lineage and its first version, plus a proposal over it.
  const document = readExample(MINIMAL_EXAMPLE);
  const registered = await post(address, '/v1/graphs', document);
  assert.equal(registered.status, 201, await registered.text());

  const countGraphs = async (): Promise<number> =>
    (await jsonBody<{ graphs: unknown[] }>(await fetch(`${address}/v1/graphs`))).graphs.length;
  const countProposals = async (): Promise<number> =>
    (await jsonBody<{ proposals: unknown[] }>(await fetch(`${address}/v1/proposals`))).proposals
      .length;

  const graphsBefore = await countGraphs();
  const proposalsBefore = await countProposals();

  // One document that would register cleanly, and one that would be refused:
  // neither may leave a trace.
  await validate(address, { ...document, problem_class: 'another-class-entirely' });
  await validate(address, edgeWithoutCondition());

  assert.equal(await countGraphs(), graphsBefore, 'no lineage was written');
  assert.equal(await countProposals(), proposalsBefore, 'no proposal was written');
});

test('t460 AT5 — the report is the same one apply would refuse with, field for field', async (t) => {
  const address = await startApp(t);
  const { applyOperations } = await loadOperations();

  const document = readExample(MINIMAL_EXAMPLE);
  const registered = await post(address, '/v1/graphs', document);
  const base = await jsonBody<{ graph: Graph; graph_version: GraphVersion }>(registered);
  assert.equal(registered.status, 201, JSON.stringify(base));

  // The same rework cycle `proposal-routes.test.ts`'s AT16 builds: a legitimate
  // edge, with no label on the transition.
  const operations: OperationsModule.Operation[] = [
    {
      type: 'add_edge',
      edge: { from: 'revisar', to: 'redigir', condition: '' },
      inverse: { type: 'remove_edge', edge: { from: 'revisar', to: 'redigir' } },
    },
  ];

  const created = await post(address, '/v1/proposals', {
    graph_id: base.graph.id,
    target_version: base.graph_version.id,
    operations,
    evidence: { fonte: 'telemetry', observacao: 'two crossings with rework after the review' },
    // The hypothesis blob keeps its own Portuguese vocabulary, which
    // `proposal-routes.test.ts` pins as a deliberate exemption — copied, not
    // invented here.
    expected_metric: { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 },
  });
  const proposal = (await jsonBody<{ proposal: Proposal }>(created)).proposal;
  assert.equal(created.status, 201, JSON.stringify(proposal));

  const approved = await post(address, `/v1/proposals/${proposal.id}/approve`, {});
  assert.equal(approved.status, 200, await approved.text());

  const applied = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const refusal = await jsonBody<{ error: string } & Report>(applied);
  assert.equal(applied.status, 422, JSON.stringify(refusal));
  assert.equal(refusal.error, 'invalid_graph');

  // The very document apply judged: its target's snapshot with the operations
  // on top, which is what `routes/proposals.ts` hands to `validateGraph`.
  const query = await validate(address, applyOperations(document, operations));

  assert.deepEqual(query.structure, refusal.structure, 'the structure report is the same one');
  assert.deepEqual(query.soundness, refusal.soundness, 'and so is the soundness report');
});
