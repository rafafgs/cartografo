/**
 * The document proved by USE (t171, FR8).
 *
 * `openapi.test.ts` checks the document's shape. This file checks the only
 * thing that really matters about it: that somebody who has never read
 * `packages/core/src` can drive the control plane from it alone. The client
 * below writes no URL, no method and no path parameter of its own — it is
 * handed the fetched document, and everything it sends is resolved out of it
 * (`servers` for the base address, the path template for `{id}`).
 *
 * That is D11's premise turned into a test: the screen is a client of the
 * public API, and the public API is now an artifact and not a reading of the
 * route files.
 *
 * The flow is the raw ticket's own acceptance criterion — register a graph,
 * create a job, answer an input request — and it is deliberately the shortest
 * path that crosses three different route families.
 *
 * `openapi-client-axios` is a devDependency and stays one: what ships is the
 * document, not a client package (Out of Scope).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HttpMethod,
  OpenAPIClientAxios,
  type Document,
  type OpenAPIClient,
  type UnknownOperationMethod,
} from 'openapi-client-axios';

import { PACKAGE_ROOT, requireArtifacts, request, startControlPlane, type TestContext } from './support.ts';

/** Artifacts this ticket touches; the initial red names them instead of blowing up. */
const ARTIFACTS = ['src/server.ts', 'src/routes/common.ts'];

/** The smallest sound graph in the repository — the same one `jobs.test.ts` feeds in raw. */
const MINIMAL_GRAPH = path.join(
  PACKAGE_ROOT,
  '..',
  '..',
  'schema',
  'examples',
  'graph-valid-minimal.json',
);

/** What `POST /v1/graphs` answers, in the slice this flow needs. */
interface GraphRegistration {
  graph: { id: string };
  graph_version: { id: string };
}

/** What `POST /v1/jobs` answers, in the slice this flow needs. */
interface JobProjection {
  id: number;
  current_node_id: string;
  blocked: boolean;
}

/** What the input-request routes answer, in the slice this flow needs. */
interface InputRequestProjection {
  id: number;
  status: string;
  answer: string | null;
  answered_by: string | null;
}

/**
 * Builds the client from the document the running app just served.
 *
 * The base address is composed here and nowhere else: the ORIGIN comes from the
 * test's own instance (an ephemeral port), and the PATH comes from the
 * document's `servers` entry. Hardcoding `/v1` would quietly excuse the
 * document from declaring where its operations live.
 *
 * @param ctx Control plane running.
 * @returns The client, already carrying the suite's credential.
 */
async function clientFromDocument(ctx: TestContext) {
  const fetched = await request<Document>(ctx, 'GET', '/openapi.json');
  assert.equal(fetched.status, 200, 'GET /openapi.json has to answer before anything else');
  const document = fetched.body;

  const declared = document.servers?.[0]?.url;
  assert.ok(declared !== undefined, 'the document declares no server; a client cannot address it');

  const api = new OpenAPIClientAxios({
    definition: document,
    axiosConfigDefaults: {
      headers: { authorization: `Bearer ${ctx.token}` },
      // The flow asserts each status itself; axios throwing on 4xx would turn a
      // documented refusal into an unreadable stack.
      validateStatus: () => true,
    },
  });
  api.withServer({ url: new URL(declared, ctx.url).toString() });
  return await api.init();
}

/**
 * The call the document declares for one address, or a failure that names it.
 *
 * The lookup is the point, not a formality: `client.paths` is built by the
 * library out of the fetched document, so an operation missing from the
 * document is simply not callable — and this is what turns that into a legible
 * assertion instead of "cannot read property 'post' of undefined".
 *
 * @param client Client already initialized from the document.
 * @param route Path template, exactly as the document spells it.
 * @param method Verb of the operation.
 * @returns The bound call.
 */
function operation(
  client: OpenAPIClient,
  route: string,
  method: HttpMethod,
): UnknownOperationMethod {
  const item = client.paths[route];
  assert.ok(item !== undefined, `the document declares no path "${route}"`);
  const call = item[method];
  assert.ok(call !== undefined, `the document declares no ${method.toUpperCase()} "${route}"`);
  return call;
}

test('t171 AT5 — a client built only from /openapi.json runs the basic flow end to end', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);
  const client = await clientFromDocument(ctx);

  // 1. Register a base graph — the document goes in raw, with no envelope.
  const document = JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as unknown;
  const registered = await operation(client, '/graphs', HttpMethod.Post)(undefined, document);
  assert.equal(
    registered.status,
    201,
    `POST /graphs answered ${registered.status}: ${JSON.stringify(registered.data)}`,
  );
  const graph = registered.data as GraphRegistration;
  assert.equal(graph.graph.id, 'nota-curta');
  assert.ok(typeof graph.graph_version.id === 'string' && graph.graph_version.id.length > 0);

  // 2. Create a job under the version that was just born.
  const created = await operation(client, '/jobs', HttpMethod.Post)(undefined, {
    title: 'first note',
    entry_node_id: 'redigir',
    grafo_versao_id: graph.graph_version.id,
  });
  assert.equal(
    created.status,
    201,
    `POST /jobs answered ${created.status}: ${JSON.stringify(created.data)}`,
  );
  const job = created.data as JobProjection;
  assert.equal(job.current_node_id, 'redigir');
  assert.equal(job.blocked, false);

  // 3. The job asks, and the answer comes back through the templated path — the
  //    one call of the three that makes the client fill `{id}` from the document.
  const asked = await operation(client, '/input-requests', HttpMethod.Post)(undefined, {
    job_id: job.id,
    kind: 'question',
    question: 'Does the note speak of the stated theme?',
    context: 'First crossing of the minimal graph.',
    options: ['Yes', 'No'],
    recommendation: 'Sim',
    default_answer: 'Sim',
    auto_approvable: false,
  });
  assert.equal(
    asked.status,
    201,
    `POST /input-requests answered ${asked.status}: ${JSON.stringify(asked.data)}`,
  );
  const question = asked.data as InputRequestProjection;
  assert.equal(question.status, 'pending');

  const answered = await operation(client, '/input-requests/{id}/answer', HttpMethod.Patch)(
    { id: question.id },
    { answer: 'Sim', answered_by: 'rafael' },
  );
  assert.equal(
    answered.status,
    200,
    `PATCH /input-requests/{id}/answer answered ${answered.status}: ${JSON.stringify(answered.data)}`,
  );
  const settled = answered.data as InputRequestProjection;
  assert.equal(settled.status, 'answered');
  assert.equal(settled.answer, 'Sim');
  assert.equal(settled.answered_by, 'rafael');

  // The answer really landed on the control plane, and not only on the client:
  // the job it was blocking is back in the queue.
  const reread = await request<JobProjection>(ctx, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(reread.status, 200);
  assert.equal(reread.body.blocked, false, 'answering through the generated client unblocked it');
});
