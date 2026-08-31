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
