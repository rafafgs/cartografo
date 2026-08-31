/**
 * End-to-end tests of the MCP server: the real command, the real control plane,
 * and nothing faked in between.
 *
 * What each test is actually for:
 *
 * - **The catalogue** needs no control plane at all — `tools/list` is answered
 *   out of `src/tools.ts` — so it runs against an address nothing is listening
 *   on. That is deliberate: it is also the test that pins the two ABSENCES this
 *   server's boundary is made of (no deciding a proposal, no moving a job), and
 *   those have to hold whether or not anything is up.
 * - **The round trip** boots the control plane, imports the factory bundle with
 *   the real CLI, and then drives the map only through tools — checking the
 *   result through the public API, never through the tool that wrote it.
 * - **The two failures** are the ones an operator meets on day one: nothing
 *   running, and no credential. Both have to come back as a line with the next
 *   step in it, because a model reading `fetch failed` guesses.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { CORE_BIN, bootCore } from '@cartografo/test-support';

import { REPO_ROOT, api, handshake, startMcp } from './support.ts';

/** A port nothing in this suite listens on. */
const NOWHERE = 'http://127.0.0.1:9';

/** The bundle the round trip works with. */
const BUNDLE = 'factory-graphs/software-development';

/** The class that bundle registers. */
const CLASS = 'software-development';

/** Names no tool on this server may carry, and the reason each is absent. */
const REFUSED_VERBS = Object.freeze([
  ['approve', 'deciding a proposal is a human decision at the gate (principle 5)'],
  ['apply', 'applying a proposal is a human decision at the gate (principle 5)'],
  ['reject', 'rejecting a proposal is a human decision at the gate (principle 5)'],
  ['revert', 'reverting a version is a human decision at the gate (principle 5)'],
  ['transition', "moving a job is the runner writing down what it did, not an operator's write"],
]);

test('the catalogue: a handshake, the tools, and the writes this server refuses', async (t) => {
  const mcp = startMcp(t, { url: NOWHERE, token: 'unused' });

  const initialized = await handshake(mcp);
  assert.equal(
    initialized.protocolVersion,
    '2025-06-18',
    'a revision this server supports comes back as it was asked for',
  );
  assert.deepEqual(initialized.serverInfo, { name: 'cartografo', version: '0.1.0' });
  assert.match(String(initialized.instructions), /cannot decide a proposal/);

  const listed = await mcp.request('tools/list');
  const tools = (listed.result as { tools: { name: string; inputSchema: unknown }[] }).tools;

  assert.ok(tools.length > 0, 'the server publishes tools');
  for (const tool of tools) {
    assert.match(tool.name, /^cartografo_/, 'every tool is prefixed, because a client sees many servers');
    assert.ok(tool.inputSchema !== undefined, `${tool.name} publishes an input schema`);
  }

  const names = tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'no two tools share a name');

  for (const [verb, why] of REFUSED_VERBS) {
    assert.ok(
      !names.some((name) => name.includes(verb)),
      `no tool may be named "*${verb}*": ${why}`,
    );
  }

  const unknown = await mcp.request('resources/list');
  assert.equal(
    (unknown.error as { code: number }).code,
    -32601,
    'a method this server does not have is a protocol error, not a tool failure',
  );
});

test('the round trip: status, the map, a job created and read back through the API', async (t) => {
  const cp = await bootCore(t);

  const imported = spawnSync(process.execPath, [CORE_BIN, 'import', BUNDLE], {
    cwd: REPO_ROOT,
    env: { ...process.env, CARTOGRAFO_URL: cp.url, CARTOGRAFO_TOKEN: cp.token },
    encoding: 'utf8',
  });
  assert.equal(
    imported.status,
    0,
    `the bundle did not import:\n${imported.stdout ?? ''}${imported.stderr ?? ''}`,
  );

  const mcp = startMcp(t, cp);
  await handshake(mcp);

  const status = await mcp.call('cartografo_status');
  assert.equal(status.isError, false, status.text);
  const reported = JSON.parse(status.text) as {
    control_plane: { url: string; health: { status: string } };
    classes: { class: string }[];
    jobs: { total: number };
  };
  assert.equal(reported.control_plane.health.status, 'ok');
  assert.deepEqual(
    reported.classes.map((row) => row.class),
    [CLASS],
  );
  assert.equal(reported.jobs.total, 0, 'a fresh control plane holds no jobs');

  const map = await mcp.call('cartografo_describe_graph', { class: CLASS });
  assert.equal(map.isError, false, map.text);
  const described = JSON.parse(map.text) as {
    initial_node: string;
    contracts: { state: string };
    nodes: { id: string }[];
    edges: { from: string; to: string }[];
  };
  assert.equal(described.contracts.state, 'checked');
  assert.equal(described.initial_node, 'refine');
  assert.ok(described.nodes.length >= 5, 'the map carries the bundle’s nodes');
  assert.ok(described.edges.length >= 4, 'and its edges');

  // The registry the map's pins point into. The contract comes only when it is
  // asked for, which is the whole reason the flag exists: five skills' input and
  // output schemas are larger than the map they belong to.
  const registry = await mcp.call('cartografo_list_skills');
  assert.equal(registry.isError, false, registry.text);
  const skills = (JSON.parse(registry.text) as { skills: Record<string, unknown>[] }).skills;
  assert.ok(skills.length >= 5, 'the bundle registered its skills');
  assert.equal(skills[0].input, undefined, 'no contract unless it was asked for');
  assert.equal(skills[0].instructions, undefined, 'the prompt body never travels');

  const withContract = await mcp.call('cartografo_list_skills', {
    id: String(skills[0].id),
    include_contract: true,
  });
  const oneLineage = (JSON.parse(withContract.text) as { skills: Record<string, unknown>[] }).skills;
  assert.ok(oneLineage.every((skill) => skill.id === skills[0].id), 'the id narrows to one lineage');
  assert.ok(oneLineage[0].input !== undefined, 'and the contract comes when it is asked for');

  // The one write of this test, and the entry node comes from the class rather
  // than from the caller: that shortcut is the reason `create_job` resolves a
  // version at all, so it is what gets checked.
  const created = await mcp.call('cartografo_create_job', {
    title: 'A job opened through MCP',
    body: 'the request, in full',
    class: CLASS,
  });
  assert.equal(created.isError, false, created.text);
  const job = (JSON.parse(created.text) as { created: { id: number; node: string } }).created;
  assert.equal(job.node, 'refine', 'the job starts at the graph’s initial node');

  // Read back through the API and not through `cartografo_get_job`: a tool that
  // confirmed its own write would prove only that it is self-consistent.
  const persisted = await api<{ id: number; current_node_id: string; graph_version_id: string }>(
    cp,
    'GET',
    `/v1/jobs/${job.id}`,
  );
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.current_node_id, 'refine');
  assert.ok(
    persisted.body.graph_version_id.startsWith('sha256:'),
    'the job is pinned to the version that was in force when it was created',
  );

  // A question raised by a session, answered through the tool, checked on the API.
  const question = await api<{ id: number }>(cp, 'POST', '/v1/input-requests', {
    job_id: job.id,
    kind: 'question',
    question: 'which database?',
    auto_approvable: false,
    options: ['sqlite', 'postgres'],
  });
  assert.equal(question.status, 201, JSON.stringify(question.body));

  const answered = await mcp.call('cartografo_answer_input_request', {
    input_request_id: question.body.id,
    answer: 'sqlite',
  });
  assert.equal(answered.isError, false, answered.text);

  const settled = await api<{ input_requests: { status: string; answered_by: string }[] }>(
    cp,
    'GET',
    `/v1/input-requests?job_id=${job.id}`,
  );
  assert.equal(settled.body.input_requests[0].status, 'answered');
  assert.equal(
    settled.body.input_requests[0].answered_by,
    'mcp',
    'the log says a model answered, because a model did',
  );

  // Blocking and unblocking, the two operator facts this server does expose.
  const blocked = await mcp.call('cartografo_block_job', {
    job_id: job.id,
    reason: 'waiting on the operator',
  });
  assert.equal(blocked.isError, false, blocked.text);
  const whileBlocked = await api<{ blocked: boolean; block_reason: string }>(
    cp,
    'GET',
    `/v1/jobs/${job.id}`,
  );
  assert.equal(whileBlocked.body.blocked, true);
  assert.equal(whileBlocked.body.block_reason, 'waiting on the operator');

  const released = await mcp.call('cartografo_unblock_job', { job_id: job.id });
  assert.equal(released.isError, false, released.text);
  const afterwards = await api<{ blocked: boolean }>(cp, 'GET', `/v1/jobs/${job.id}`);
  assert.equal(afterwards.body.blocked, false);

  // And the timeline, which is what makes `get_job` the "why is it stuck" tool.
  const read = await mcp.call('cartografo_get_job', { job_id: job.id });
  assert.equal(read.isError, false, read.text);
  const digest = JSON.parse(read.text) as {
    input_requests: unknown[];
    timeline: { type: string }[];
  };
  assert.equal(digest.input_requests.length, 1);
  assert.deepEqual(
    digest.timeline.map((event) => event.type),
    [
      'job.created',
      // Raising a question blocks the job; answering it is what releases it.
      // Neither of those two facts is written by this server — they are the
      // control plane's, and they show up here because the timeline is the log
      // and not a summary of what the caller did.
      'input_request.created',
      'job.blocked',
      'job.unblocked',
      // These two are this server's, through `block_job` and `unblock_job`.
      'job.blocked',
      'job.unblocked',
    ],
    'the timeline is the log, in order',
  );

  // Same control plane, no credential: the failure an operator meets when the
  // MCP client's configuration forgot the token.
  const anonymous = startMcp(t, { url: cp.url });
  await handshake(anonymous);
  const refused = await anonymous.call('cartografo_status');
  assert.equal(refused.isError, true);
  assert.match(refused.text, /refused the credential/);
  assert.match(refused.text, /CARTOGRAFO_MCP_TOKEN/, 'the message names what to set');
  assert.ok(
    !refused.text.includes(cp.token),
    'a failure never carries the credential back to the model',
  );
});

test('nothing running: the failure says what to start', async (t) => {
  const mcp = startMcp(t, { url: NOWHERE, token: 'unused' });
  await handshake(mcp);

  const status = await mcp.call('cartografo_status');
  assert.equal(status.isError, true, 'a control plane that is down is a tool failure, not a crash');
  assert.match(status.text, /did not answer/);
  assert.match(status.text, /npx cartografo/, 'the message names the command that fixes it');

  // Still alive, still answering: one failed call must not end the session.
  const listed = await mcp.request('tools/list');
  assert.ok(Array.isArray((listed.result as { tools: unknown[] }).tools));
});
