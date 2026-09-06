/**
 * Unit tests of the catalogue: the digesting, the argument gate and the
 * failures — everything a tool decides before or after the one HTTP call it
 * makes.
 *
 * A fake `fetch` throughout. The end-to-end suite next door already proves the
 * tools work against a real control plane; what needs a fake is the handful of
 * answers a real one will not produce on demand: a transcript longer than the
 * ceiling, a 500 with a body, a 401.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ApiClient } from '../src/client.ts';
import { callTool } from '../src/protocol.ts';
import {
  CLIP_CHARS,
  TOOLS,
  TRANSCRIPT_MAX_CHARS,
  clipStrings,
  proposalDigest,
} from '../src/tools.ts';
import type { Proposal } from '../src/client.ts';

/** The credential this file checks never comes back out. */
const TOKEN = 'a-secret-that-must-not-travel';

/** Tools that write. Everything else in the catalogue only reads. */
const WRITERS = Object.freeze([
  'cartografo_create_job',
  'cartografo_answer_input_request',
  'cartografo_block_job',
  'cartografo_unblock_job',
  'cartografo_register_graph',
]);

/** A client whose every request is answered by `answer`. */
function clientAnswering(answer: (path: string) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'http://127.0.0.1:4317',
    token: TOKEN,
    // Decoded, because the client percent-encodes an id and `sha256:abc`
    // arrives as `sha256%3Aabc`; a fake that compared the raw path would answer
    // the wrong route and call it a network failure.
    doFetch: async (input) => answer(decodeURIComponent(new URL(String(input)).pathname)),
  });
}

/** JSON, with a status. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Runs a tool through the protocol layer, the way a client reaches it. */
async function call(
  client: ApiClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const result = (await callTool(client, { name, arguments: args })) as {
    content: { text: string }[];
    isError: boolean;
  };
  return { text: result.content[0].text, isError: result.isError };
}

/**
 * A client that records every request's method and full URL (path + query),
 * in call order — for pinning that `project_id` was threaded onto the right
 * calls and left off the rest (t418).
 */
function recordingClient(
  handler: (path: string, method: string, body: unknown) => Response,
): { client: ApiClient; requests: string[] } {
  const requests: string[] = [];
  const client = new ApiClient({
    baseUrl: 'http://127.0.0.1:4317',
    token: TOKEN,
    doFetch: async (input, init) => {
      const url = new URL(String(input));
      const path = `${decodeURIComponent(url.pathname)}${url.search}`;
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push(`${method} ${path}`);
      return handler(path, method, body);
    },
  });
  return { client, requests };
}

/** A minimal-but-complete class row, reused across the project_id tests below. */
const CLASS_ROW = Object.freeze({
  class: 'demo',
  graph_id: 'demo',
  current_version_id: 'sha256:v1',
  created_at: 'now',
});

/** A minimal-but-complete graph version envelope, keyed by whatever id is asked for. */
function graphVersionBody(id: string): Record<string, unknown> {
  return {
    graph_version: {
      id,
      graph_id: 'demo',
      parent_version: null,
      source: 'manual',
      proposal_id: null,
      created_at: 'now',
      snapshot: { problem_class: 'demo', initial_node: 'triage', nodes: [], edges: [] },
      contracts: { state: 'checked', problems: [] },
    },
  };
}

/** A minimal-but-complete job, reused across the project_id tests below. */
const JOB_FIXTURE = Object.freeze({
  id: 1,
  project_id: 1,
  execution_id: null,
  title: 'x',
  body: null,
  acceptance_criteria: null,
  fields: null,
  tier: null,
  entry_node_id: 'triage',
  current_node_id: 'triage',
  blocked: false,
  block_reason: null,
  graph_version_id: null,
  completed: false,
  created_at: 'now',
  updated_at: 'now',
});

test('the hints match the surface: exactly five tools write, and none is destructive', () => {
  for (const tool of TOOLS) {
    const writes = WRITERS.includes(tool.name);
    assert.equal(
      tool.annotations.readOnlyHint,
      !writes,
      `${tool.name} is declared ${tool.annotations.readOnlyHint ? 'read-only' : 'a write'} and is not`,
    );
    assert.equal(
      tool.annotations.destructiveHint,
      false,
      `${tool.name}: nothing on this server deletes or overwrites — the log is append-only`,
    );
  }

  for (const name of WRITERS) {
    assert.ok(
      TOOLS.some((tool) => tool.name === name),
      `${name} is listed as a writer but is not in the catalogue`,
    );
  }
});

test('the package page lists every tool, in the order the catalogue publishes them', () => {
  // A drifting page is the failure this repository already wrote a gate against
  // (`scripts/check-package-readmes.mjs` requires a page; nothing requires it to
  // be true). A tool added without a row is a tool a reader of the file view
  // never learns about.
  const page = readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8');
  const listed = [...page.matchAll(/\| `(cartografo_[a-z_]+)` \|/g)].map((match) => match[1]);

  assert.deepEqual(
    listed,
    TOOLS.map((tool) => tool.name),
    'the table in README.md and the catalogue in src/tools.ts have to say the same thing',
  );
});

test('a clipped string says how much was clipped', () => {
  const long = 'x'.repeat(CLIP_CHARS + 42);
  const clipped = clipStrings({ deep: [{ text: long }] }) as { deep: { text: string }[] };

  assert.equal(clipped.deep[0].text.length, CLIP_CHARS + '…(+42 chars)'.length);
  assert.match(clipped.deep[0].text, /…\(\+42 chars\)$/);
  assert.deepEqual(clipStrings({ short: 'kept' }), { short: 'kept' }, 'a short string is left alone');
  assert.deepEqual(clipStrings({ n: 1, b: true, nothing: null }), { n: 1, b: true, nothing: null });
});

test('read_transcript returns the tail, names both truncations and holds the ceiling', async () => {
  const whole = `${'a'.repeat(TRANSCRIPT_MAX_CHARS)}THE-END`;
  const client = clientAnswering(() =>
    json({ transcript: whole, transcript_truncated: true, transcript_original_size: 10_000_000 }),
  );

  const tail = await call(client, 'cartografo_read_transcript', { session_id: 1, max_chars: 20 });
  const digest = JSON.parse(tail.text) as {
    transcript: string;
    total_chars: number;
    returned_chars: number;
    stored_truncated: boolean;
    stored_original_size: number;
  };
  assert.equal(digest.transcript, whole.slice(-20), 'the tail is where a failure is');
  assert.equal(digest.total_chars, whole.length);
  assert.equal(
    digest.stored_truncated,
    true,
    "the control plane's own truncation is a different fact from this tool's slice, and both are reported",
  );
  assert.equal(digest.stored_original_size, 10_000_000);

  const uncapped = await call(client, 'cartografo_read_transcript', {
    session_id: 1,
    max_chars: 10_000_000,
  });
  assert.equal(
    (JSON.parse(uncapped.text) as { returned_chars: number }).returned_chars,
    TRANSCRIPT_MAX_CHARS,
    'the ceiling holds whatever the caller asks for',
  );

  const head = await call(client, 'cartografo_read_transcript', {
    session_id: 1,
    max_chars: 5,
    from: 'start',
  });
  assert.equal((JSON.parse(head.text) as { transcript: string }).transcript, whole.slice(0, 5));
});

test('an argument the tool refuses never becomes a request', async () => {
  let requests = 0;
  const client = clientAnswering(() => {
    requests += 1;
    return json({});
  });

  const noId = await call(client, 'cartografo_get_job', {});
  assert.equal(noId.isError, true);
  assert.match(noId.text, /"job_id" is required/);

  const wrongType = await call(client, 'cartografo_get_job', { job_id: 'seven' });
  assert.equal(wrongType.isError, true);

  const both = await call(client, 'cartografo_create_job', {
    title: 'x',
    class: 'software-development',
    graph_version_id: 'sha256:whatever',
  });
  assert.equal(both.isError, true);
  assert.match(both.text, /not both/);

  const badStatus = await call(client, 'cartografo_list_proposals', { status: 'maybe' });
  assert.equal(badStatus.isError, true, 'a status the API would silently answer with [] is refused here');
  assert.match(badStatus.text, /has to be one of/);

  assert.equal(requests, 0, 'not one of the four reached the control plane');
});

test('a refusal from the control plane comes back readable, and without the credential', async () => {
  const client = clientAnswering(() =>
    json({ error: 'validation_failed', details: ['data.title is required'] }, 400),
  );

  const refused = await call(client, 'cartografo_create_job', {
    title: 'x',
    entry_node_id: 'refine',
  });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /validation_failed/, "the server's own body is what makes it fixable");
  assert.match(refused.text, /400/);
  assert.ok(!refused.text.includes(TOKEN), 'the credential is in a header, never in a message');
  assert.ok(!refused.text.toLowerCase().includes('bearer'));
});

test('a proposal digest names its operations instead of pasting them', () => {
  const proposal: Proposal = {
    id: 4,
    graph_id: 'software-development',
    target_version: 'sha256:abc',
    operations: [
      { type: 'add_node', node: { id: 'write_tests', contract: { input_schema: {} } } },
      { type: 'add_edge', edge: { from: 'develop', to: 'write_tests' } },
      { type: 'change_node_field', node_id: 'test', field: 'description' },
    ],
    evidence: { lens: 'flow', queue: 'develop' },
    expected_metric: 'fewer rework cycles',
    status: 'pending',
    applied_version_id: null,
    rejection_reason: null,
    revert_reason: null,
    result: null,
    created_at: '2026-08-26T10:00:00.000Z',
    updated_at: '2026-08-26T10:00:00.000Z',
  };

  const digest = proposalDigest(proposal) as { lens: string; operations: string[] };
  assert.equal(digest.lens, 'flow', 'the lens is read out of the evidence, where it lives');
  assert.deepEqual(digest.operations, [
    'add_node write_tests',
    'add_edge develop -> write_tests',
    'change_node_field test.description',
  ]);
});

test('create_job takes the entry node from the class when it is not given one', async () => {
  const posted: Record<string, unknown>[] = [];
  const client = new ApiClient({
    baseUrl: 'http://127.0.0.1:4317',
    token: TOKEN,
    doFetch: async (input, init) => {
      const route = decodeURIComponent(new URL(String(input)).pathname);
      if (route === '/v1/classes') {
        return json({
          classes: [
            { class: 'demo', graph_id: 'demo', current_version_id: 'sha256:v1', created_at: 'now' },
          ],
        });
      }
      if (route === '/v1/graph-versions/sha256:v1') {
        return json({
          graph_version: {
            id: 'sha256:v1',
            graph_id: 'demo',
            parent_version: null,
            source: 'manual',
            proposal_id: null,
            created_at: 'now',
            snapshot: { problem_class: 'demo', initial_node: 'triage', nodes: [], edges: [] },
            contracts: { state: 'checked', problems: [] },
          },
        });
      }
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        id: 12,
        project_id: 1,
        execution_id: null,
        title: 'x',
        body: null,
        acceptance_criteria: null,
        fields: null,
        tier: null,
        entry_node_id: 'triage',
        current_node_id: 'triage',
        blocked: false,
        block_reason: null,
        graph_version_id: 'sha256:v1',
        completed: false,
        created_at: 'now',
        updated_at: 'now',
      });
    },
  });

  const created = await call(client, 'cartografo_create_job', { title: 'x', class: 'demo' });
  assert.equal(created.isError, false, created.text);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].entry_node_id, 'triage');
  assert.equal(posted[0].graph_version_id, 'sha256:v1', 'the job is pinned to the version in force');
  assert.deepEqual(
    posted[0].actor,
    { type: 'agent', ref: 'mcp' },
    'a write made by a model is recorded as an agent, never as a person',
  );
});

/* -------------------------------------------------------------------------- */
/* project_id threading (t418)                                                */
/* -------------------------------------------------------------------------- */

test('AT1: describe_graph via class threads project_id into the class lookup and the version lookup', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path.startsWith('/v1/classes')) return json({ classes: [CLASS_ROW] });
    if (path.startsWith('/v1/graph-versions/')) return json(graphVersionBody('sha256:v1'));
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_describe_graph', { class: 'demo', project_id: 2 });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [
    'GET /v1/classes?project_id=2',
    'GET /v1/graph-versions/sha256:v1?project_id=2',
  ]);
});

test('AT2: describe_graph via graph_id threads project_id into the graph lookup and the version lookup', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path.startsWith('/v1/graphs')) {
      return json({
        graphs: [
          {
            id: 'demo',
            class: 'demo',
            lineage_type: 'base',
            base_class: null,
            origin_proposal_id: null,
            current_version_id: 'sha256:v1',
            created_at: 'now',
          },
        ],
      });
    }
    if (path.startsWith('/v1/graph-versions/')) return json(graphVersionBody('sha256:v1'));
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_describe_graph', { graph_id: 'demo', project_id: 2 });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [
    'GET /v1/graphs?project_id=2',
    'GET /v1/graph-versions/sha256:v1?project_id=2',
  ]);
});

test('AT3: describe_graph via version_id threads project_id straight into the graph-versions lookup', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path.startsWith('/v1/graph-versions/')) return json(graphVersionBody('sha256:abc'));
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_describe_graph', {
    version_id: 'sha256:abc',
    project_id: 2,
  });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, ['GET /v1/graph-versions/sha256:abc?project_id=2']);
});

test('AT4: create_job with class and project_id resolves the class/version lookups in that project, and posts it on the job', async () => {
  const posted: Record<string, unknown>[] = [];
  const { client, requests } = recordingClient((path, _method, body) => {
    if (path.startsWith('/v1/classes')) return json({ classes: [CLASS_ROW] });
    if (path.startsWith('/v1/graph-versions/')) return json(graphVersionBody('sha256:v1'));
    posted.push(body as Record<string, unknown>);
    return json({ ...JOB_FIXTURE, id: 12, project_id: 2, graph_version_id: 'sha256:v1' });
  });

  const created = await call(client, 'cartografo_create_job', {
    title: 'x',
    class: 'demo',
    project_id: 2,
  });
  assert.equal(created.isError, false, created.text);
  assert.deepEqual(requests.slice(0, 2), [
    'GET /v1/classes?project_id=2',
    'GET /v1/graph-versions/sha256:v1?project_id=2',
  ]);
  assert.equal(requests[2], 'POST /v1/jobs');
  assert.equal(posted[0].project_id, 2, 'the final POST still carries the caller\'s own project_id');
});

test('AT5: create_job with no project_id makes no project_id query param, and posts none either (no regression)', async () => {
  const posted: Record<string, unknown>[] = [];
  const { client, requests } = recordingClient((path, _method, body) => {
    if (path.startsWith('/v1/classes')) return json({ classes: [CLASS_ROW] });
    if (path.startsWith('/v1/graph-versions/')) return json(graphVersionBody('sha256:v1'));
    posted.push(body as Record<string, unknown>);
    return json({ ...JOB_FIXTURE, id: 12, graph_version_id: 'sha256:v1' });
  });

  const created = await call(client, 'cartografo_create_job', { title: 'x', class: 'demo' });
  assert.equal(created.isError, false, created.text);
  assert.deepEqual(requests.slice(0, 2), ['GET /v1/classes', 'GET /v1/graph-versions/sha256:v1']);
  assert.equal(posted[0].project_id, undefined, 'omitted, letting the server default to project 1');
});

test('AT6: status threads project_id into classes/executions/jobs/input-requests, but not runners or proposals', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path === '/health') return json({ status: 'ok', db: 'ok' });
    if (path.startsWith('/v1/classes')) return json({ classes: [] });
    if (path.startsWith('/v1/runners')) return json({ runners: [] });
    if (path.startsWith('/v1/executions')) return json({ executions: [] });
    if (path.startsWith('/v1/jobs')) return json({ jobs: [] });
    if (path.startsWith('/v1/input-requests')) return json({ input_requests: [] });
    if (path.startsWith('/v1/proposals')) return json({ proposals: [] });
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_status', { project_id: 2 });
  assert.equal(result.isError, false, result.text);

  assert.ok(requests.includes('GET /v1/classes?project_id=2'));
  assert.ok(requests.includes('GET /v1/executions?project_id=2'));
  assert.ok(requests.includes('GET /v1/jobs?project_id=2'));
  const inputRequestsCall = requests.find((r) => r.startsWith('GET /v1/input-requests'));
  assert.match(inputRequestsCall ?? '', /status=pending/);
  assert.match(inputRequestsCall ?? '', /project_id=2/);

  assert.ok(requests.includes('GET /v1/runners'), 'runner pairing has no project scope');
  const proposalsCall = requests.find((r) => r.startsWith('GET /v1/proposals'));
  assert.ok(proposalsCall !== undefined, 'status still reads pending proposals');
  assert.ok(!proposalsCall!.includes('project_id'), 'proposals are not yet scoped (Out of Scope)');
});

test('AT7: list_graphs threads project_id into both the classes and graphs lookups', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path.startsWith('/v1/classes')) return json({ classes: [] });
    if (path.startsWith('/v1/graphs')) return json({ graphs: [] });
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_list_graphs', { project_id: 3 });
  assert.equal(result.isError, false, result.text);
  assert.ok(requests.includes('GET /v1/classes?project_id=3'));
  assert.ok(requests.includes('GET /v1/graphs?project_id=3'));
});

test('AT8: list_skills threads project_id, alone and combined with id', async () => {
  const { client, requests } = recordingClient(() => json({ skills: [] }));

  await call(client, 'cartografo_list_skills', { project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/skills?project_id=3');

  await call(client, 'cartografo_list_skills', { id: 'x', project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/skills?id=x&project_id=3');
});

test('AT9: list_jobs with project_id and no execution_id scopes the read', async () => {
  const { client, requests } = recordingClient(() => json({ jobs: [] }));
  await call(client, 'cartografo_list_jobs', { project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/jobs?project_id=3');
});

test('AT10: get_job threads project_id into the job and its events, but not into sessions/input-requests', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path.startsWith('/v1/jobs/7/events')) return json({ events: [] });
    if (path.startsWith('/v1/jobs/7')) return json({ ...JOB_FIXTURE, id: 7 });
    if (path.startsWith('/v1/sessions')) return json({ sessions: [] });
    if (path.startsWith('/v1/input-requests')) return json({ input_requests: [] });
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_get_job', { job_id: 7, project_id: 3 });
  assert.equal(result.isError, false, result.text);
  assert.ok(requests.includes('GET /v1/jobs/7?project_id=3'));
  assert.ok(requests.includes('GET /v1/jobs/7/events?project_id=3'));
  assert.ok(requests.includes('GET /v1/sessions?job_id=7'), 'job_id alone disambiguates already');
  assert.ok(requests.includes('GET /v1/input-requests?job_id=7'));
});

test('AT11: get_job for a job that lives in another project throws ToolError and calls nothing else', async () => {
  const { client, requests } = recordingClient((path) => {
    if (path.startsWith('/v1/jobs/7')) return json({}, 404);
    return json({}, 404);
  });

  const result = await call(client, 'cartografo_get_job', { job_id: 7, project_id: 3 });
  assert.equal(result.isError, true);
  assert.match(result.text, /no job with id 7/);
  assert.deepEqual(requests, ['GET /v1/jobs/7?project_id=3']);
});

test('AT12: list_executions threads project_id', async () => {
  const { client, requests } = recordingClient(() => json({ executions: [] }));
  await call(client, 'cartografo_list_executions', { project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/executions?project_id=3');
});

test('AT13: list_sessions threads project_id', async () => {
  const { client, requests } = recordingClient(() => json({ sessions: [] }));
  await call(client, 'cartografo_list_sessions', { project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/sessions?project_id=3');
});

test('AT14: read_transcript threads project_id into the transcript route (the corrected premise)', async () => {
  const { client, requests } = recordingClient(() =>
    json({ transcript: 'x', transcript_truncated: false, transcript_original_size: null }),
  );
  await call(client, 'cartografo_read_transcript', { session_id: 1, project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/sessions/1/transcript?project_id=3');
});

test('AT15: read_transcript with no project_id makes no query string (no regression)', async () => {
  const { client, requests } = recordingClient(() =>
    json({ transcript: 'x', transcript_truncated: false, transcript_original_size: null }),
  );
  await call(client, 'cartografo_read_transcript', { session_id: 1 });
  assert.equal(requests[requests.length - 1], 'GET /v1/sessions/1/transcript');
});

test('AT16: list_input_requests threads project_id', async () => {
  const { client, requests } = recordingClient(() => json({ input_requests: [] }));
  await call(client, 'cartografo_list_input_requests', { project_id: 3 });
  assert.equal(requests[requests.length - 1], 'GET /v1/input-requests?project_id=3');
});

test('AT17: register_graph puts project_id on the URL, never inside the content-addressed document', async () => {
  const { client, requests } = recordingClient((_path, _method, body) => {
    assert.deepEqual(
      body,
      { problem_class: 'demo' },
      'no project_id key leaks into the document a hash is taken over',
    );
    return json({ graph: {}, graph_version: {} }, 201);
  });

  const result = await call(client, 'cartografo_register_graph', {
    document: { problem_class: 'demo' },
    project_id: 3,
  });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, ['POST /v1/graphs?project_id=3']);
});

test('AT18: answer_input_request, block_job and unblock_job take no project_id, whether or not one is passed', () => {
  for (const name of [
    'cartografo_answer_input_request',
    'cartografo_block_job',
    'cartografo_unblock_job',
  ]) {
    const tool = TOOLS.find((entry) => entry.name === name)!;
    assert.ok(
      !('project_id' in tool.inputSchema.properties),
      `${name} must not declare project_id — its route is genuinely project-blind`,
    );
  }
});

test('AT18b: answer_input_request, block_job and unblock_job put no project_id on the wire even if one is passed', async () => {
  const { client: answerClient, requests: answerRequests } = recordingClient(() =>
    json({
      id: 1,
      job_id: 1,
      session_id: null,
      execution_id: null,
      node_id: null,
      kind: 'question',
      question: 'q',
      context: null,
      options: null,
      recommendation: null,
      default_answer: null,
      auto_approvable: false,
      status: 'answered',
      answer: 'a',
      answered_by: 'mcp',
      source: null,
      created_at: 'now',
      answered_at: 'now',
    }),
  );
  await call(answerClient, 'cartografo_answer_input_request', {
    input_request_id: 1,
    answer: 'a',
    project_id: 3,
  });
  assert.deepEqual(answerRequests, ['PATCH /v1/input-requests/1/answer']);

  const { client: blockClient, requests: blockRequests } = recordingClient(() => json(JOB_FIXTURE));
  await call(blockClient, 'cartografo_block_job', { job_id: 1, reason: 'r', project_id: 3 });
  assert.deepEqual(blockRequests, ['POST /v1/jobs/1/blocks']);

  const { client: unblockClient, requests: unblockRequests } = recordingClient(() => json(JOB_FIXTURE));
  await call(unblockClient, 'cartografo_unblock_job', { job_id: 1, project_id: 3 });
  assert.deepEqual(unblockRequests, ['POST /v1/jobs/1/unblocks']);
});

test('AT19: list_proposals stays unscoped: no project_id in its schema, and none on the wire', async () => {
  const tool = TOOLS.find((entry) => entry.name === 'cartografo_list_proposals')!;
  assert.ok(
    !('project_id' in tool.inputSchema.properties),
    'GET /v1/proposals does not accept project_id yet — Out of Scope',
  );

  const { client, requests } = recordingClient(() => json({ proposals: [] }));
  await call(client, 'cartografo_list_proposals', { status: 'pending', project_id: 3 });
  assert.deepEqual(requests, ['GET /v1/proposals?status=pending']);
});
