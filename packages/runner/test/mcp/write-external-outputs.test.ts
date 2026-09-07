/**
 * Acceptance tests for the way out: delivering a node's declared outputs, once
 * (t371, FR1–FR6; RF-33, RF-35–RF-37).
 *
 * The claim is narrow and the failure modes are not. A step's declared output
 * leaves this machine only after the control plane accepted the step's report;
 * it leaves exactly once, whatever happens to the dispatch that sent it; and a
 * step the map marked `unsafe_to_retry` never sends a second time on its own —
 * it calls a person instead, and that person's answer does not cost the step a
 * whole new session.
 *
 * **Why the client is a double here.** t370's own suite spawns the real fake MCP
 * server over stdio, because what it proves is a network boundary. What THIS
 * module owns is a decision tree — three failure shapes × two node-safety
 * classes × an ordering guarantee — and every branch of it is reached by what
 * the tool answered, never by how the bytes travelled. The end-to-end proof over
 * a real server lives in `test/dispatch/dispatch.test.ts`, where it can watch a
 * counter on the other side; here a fake `ControlPlaneCall` and a fake tool
 * caller are the whole harness, so a case that asks "was the idempotency lookup
 * made BEFORE the call?" costs nothing to write.
 *
 * The control-plane double is not a stub: it keeps the `external_call` rows it
 * is handed and answers the listing out of them, because idempotency is exactly
 * the property a scripted answer would fake.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type { ResolvedNode } from '../../src/dispatch/resolve-node.ts';
import type {
  EngineAdapter,
  McpDiscovery,
  McpServerConnection,
  SessionStatus,
} from '../../src/engine/types.ts';
import type { McpClientLike, McpToolResult } from '../../src/mcp/client.ts';
import type * as WriteModule from '../../src/mcp/write-external-outputs.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/mcp/write-external-outputs.ts';

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this package uses: in the red phase the failure has to
 * read as "the implementation is missing", never as a module resolution stack
 * trace.
 */
async function loadModule(): Promise<typeof WriteModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(
    new URL('../../src/mcp/write-external-outputs.ts', import.meta.url).href
  )) as typeof WriteModule;
}

/* -------------------------------------------------------------------------- */
/* The doubles                                                                 */
/* -------------------------------------------------------------------------- */

/** One row of `external_call`, in the shape `/v1` publishes (t370). */
interface ExternalCall {
  id: number;
  job_id: number;
  node_id: string;
  direction: string;
  name: string;
  server: string;
  tool: string;
  arguments_sha256: string;
  arguments_summary: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  result_summary: string | null;
}

/** One request the fake client was handed. */
interface Sent {
  route: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** What a case wants the control plane to answer beyond the calls it keeps. */
interface PlaneScript {
  /** Rows that are already in the table when the case starts. */
  existing?: Partial<ExternalCall>[];
  /** What `GET /v1/input-requests?…` answers. */
  inputRequests?: Record<string, unknown>[];
  /** What `GET /v1/sessions?job_id=` answers. */
  sessions?: Record<string, unknown>[];
  /** What `GET /v1/graph-versions/:id` answers. */
  snapshot?: Record<string, unknown>;
}

/** A control plane that really keeps its `external_call` rows. */
function plane(script: PlaneScript = {}): {
  sent: Sent[];
  rows: ExternalCall[];
  call: ControlPlaneCall;
} {
  const sent: Sent[] = [];
  const rows: ExternalCall[] = [];
  let nextId = 1;

  for (const seed of script.existing ?? []) {
    rows.push({
      id: nextId++,
      job_id: 7,
      node_id: 'deliver',
      direction: 'output',
      name: 'delivered_proposal',
      server: 'drive',
      tool: 'upload_file',
      arguments_sha256: '0'.repeat(64),
      arguments_summary: '{}',
      started_at: '2026-09-07T11:00:00.000Z',
      finished_at: null,
      outcome: null,
      result_summary: null,
      ...seed,
    });
  }

  const call = async <T>(route: string, method: string, body?: unknown): Promise<T> => {
    const payload = (body ?? undefined) as Record<string, unknown> | undefined;
    sent.push({ route, method, body: payload });

    if (method === 'GET' && route.includes('/external-calls')) {
      const query = new URLSearchParams(route.slice(route.indexOf('?') + 1));
      const matches = rows.filter(
        (row) =>
          (query.get('node_id') === null || row.node_id === query.get('node_id')) &&
          (query.get('name') === null || row.name === query.get('name')) &&
          (query.get('direction') === null || row.direction === query.get('direction')),
      );
      return { external_calls: matches } as T;
    }

    if (method === 'POST' && route.includes('/external-calls')) {
      if (payload !== undefined && 'call_id' in payload) {
        const row = rows.find((candidate) => candidate.id === payload.call_id);
        assert.ok(row !== undefined, `completion for a call nobody opened: ${String(payload.call_id)}`);
        assert.equal(row.outcome, null, 'the first answer stands: a row is completed once');
        row.finished_at = payload.finished_at as string;
        row.outcome = payload.outcome as string;
        row.result_summary = (payload.result_summary ?? null) as string | null;
        return { external_call: row } as T;
      }
      const created: ExternalCall = {
        id: nextId++,
        job_id: 7,
        node_id: payload?.node_id as string,
        direction: (payload?.direction ?? 'input') as string,
        name: payload?.name as string,
        server: payload?.server as string,
        tool: payload?.tool as string,
        arguments_sha256: payload?.arguments_sha256 as string,
        arguments_summary: (payload?.arguments_summary ?? '') as string,
        started_at: payload?.started_at as string,
        finished_at: null,
        outcome: null,
        result_summary: null,
      };
      rows.push(created);
      return { external_call: created } as T;
    }

    if (method === 'GET' && route.startsWith('/v1/input-requests')) {
      return { input_requests: script.inputRequests ?? [] } as T;
    }
    if (method === 'GET' && route.startsWith('/v1/sessions')) {
      return { sessions: script.sessions ?? [] } as T;
    }
    if (method === 'GET' && route.startsWith('/v1/graph-versions/')) {
      return { graph_version: { id: 'sha256:t371', snapshot: script.snapshot } } as T;
    }
    if (method === 'POST' && route === '/v1/input-requests') {
      return { id: 99 } as T;
    }
    return undefined as T;
  };

  return { sent, rows, call };
}

/** What one scripted tool call answers, or throws. */
type ToolAnswer = McpToolResult | Error;

/** A tool caller that answers a queue of scripted results, and counts. */
function toolCaller(answers: ToolAnswer[]): {
  calls: { tool: string; args: Record<string, unknown> }[];
  createClient: () => McpClientLike;
  clients: number;
} {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const state = { clients: 0 };
  let index = 0;

  const client: McpClientLike = {
    initialize: () => Promise.resolve({}),
    listTools: () => Promise.resolve([{ name: 'upload_file' }, { name: 'send_invoice' }]),
    callTool: (tool, args) => {
      calls.push({ tool, args });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
    close: () => Promise.resolve(),
  };

  return {
    calls,
    clients: state.clients,
    createClient: () => {
      state.clients += 1;
      return client;
    },
  };
}

/** The one answer a tool that accepted the delivery gives. */
function accepted(): McpToolResult {
  return { content: [{ type: 'text', text: 'stored as clients/7/proposal.docx' }] };
}

/** ...and the one a tool that refused it gives — a RESULT, not a throw. */
function refused(): McpToolResult {
  return { content: [{ type: 'text', text: 'the folder is read-only' }], isError: true };
}

/**
 * An adapter that answers the two MCP questions and nothing else.
 *
 * Everything about a session throws: this step runs AFTER the session is
 * terminal, so an adapter method reached from here would be a sequencing bug and
 * a polite stub would hide it.
 */
function adapter(servers: string[] = ['drive']): EngineAdapter {
  const unreachable = (name: string): never => {
    throw new Error(`the write step reached ${name}, which is the session's own lifecycle`);
  };

  return {
    engineName: 'fake',
    startSession: () => unreachable('startSession'),
    getStatus: () => unreachable('getStatus') as Promise<SessionStatus>,
    cancel: () => unreachable('cancel'),
    capabilities: () => ({}),
    verifyCli: () => Promise.resolve({ available: true, version: null, authenticated: true }),
    discoverMcpServers: (): Promise<McpDiscovery> =>
      Promise.resolve({
        servers: servers.map((name) => ({ name })),
        origin: 'file',
        resolvedAt: '2026-09-07T12:00:00.000Z',
      }),
    resolveMcpServerConnection: (): Promise<McpServerConnection | null> =>
      Promise.resolve({ transport: 'http', url: 'https://drive.invalid/mcp' }),
  };
}

/** One `external.outputs` entry, in t369's declared shape. */
interface OutputDeclaration {
  name: string;
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  from: string;
}

/** The node the work is standing on, carrying the entries under test. */
function nodeWith(
  outputs: OutputDeclaration[],
  extra: Record<string, unknown> = {},
): ResolvedNode {
  return {
    versionId: 'sha256:t371',
    node: { id: 'deliver', external: { outputs }, ...extra },
    edges: [{ from: 'deliver', to: 'review', condition: 'always' }],
  };
}

/** The job every case below delivers for. */
const JOB = { id: 7, current_node_id: 'deliver' };

/** The single entry most cases declare. */
function oneOutput(overrides: Partial<OutputDeclaration> = {}): OutputDeclaration {
  return {
    name: 'delivered_proposal',
    server: 'drive',
    tool: 'upload_file',
    arguments: { folder: 'clients/{{input.job.id}}' },
    from: 'proposal',
    ...overrides,
  };
}

/** The report the step's session had accepted. */
const REPORT = { proposal: 'the proposal, in full', resultado: 'always' };

/** Wiring with the ladder's waits replaced by a recorder. */
function wiring(
  caller: ReturnType<typeof toolCaller>,
  waited: number[],
  overrides: Partial<WriteModule.ExternalOutputWiring> = {},
): WriteModule.ExternalOutputWiring {
  return {
    adapter: adapter(),
    callTimeoutMs: 5_000,
    createClient: caller.createClient,
    delay: (ms: number) => {
      waited.push(ms);
      return Promise.resolve();
    },
    ...overrides,
  };
}

/** Every request of one route, in the order it was made. */
function routes(sent: Sent[], method: string, fragment: string): Sent[] {
  return sent.filter((one) => one.method === method && one.route.includes(fragment));
}

/* -------------------------------------------------------------------------- */
/* FR2 — resolving one declared output                                         */
/* -------------------------------------------------------------------------- */

test('t371 AT-U1 — the value at `from` is delivered, with the arguments interpolated, bracketed by two rows', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { sent, rows, call } = plane();
  const caller = toolCaller([accepted()]);
  const waited: number[] = [];

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, waited),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.equal(caller.calls.length, 1, 'one declared output is one call');
  assert.equal(caller.calls[0].tool, 'upload_file');
  assert.deepEqual(
    caller.calls[0].args,
    // The declared argument, with `{{input.job.id}}` resolved, plus the value
    // being delivered under the name the declaration gave it — `from` names the
    // property AND the argument it travels in, so one name means one thing.
    { folder: 'clients/7', proposal: 'the proposal, in full' },
  );

  // The record, in two phases and in that order (RF-37).
  const written = routes(sent, 'POST', '/external-calls');
  assert.equal(written.length, 2, 'an intent before the call and a completion after it');
  assert.equal(written[0].body?.direction, 'output');
  assert.equal(written[0].body?.name, 'delivered_proposal');
  assert.equal(written[0].body?.server, 'drive');
  assert.equal(written[0].body?.tool, 'upload_file');
  assert.equal(written[0].body?.node_id, 'deliver');
  assert.match(String(written[0].body?.arguments_sha256), /^[0-9a-f]{64}$/);
  assert.ok(!('call_id' in (written[0].body ?? {})), 'the intent opens the row');
  assert.equal(written[1].body?.outcome, 'ok');
  assert.equal(written[1].body?.call_id, rows[0].id, 'and the completion closes THAT row');

  assert.deepEqual(
    rows.map((row) => [row.direction, row.name, row.outcome]),
    [['output', 'delivered_proposal', 'ok']],
  );

  // Nothing here transitions: the edge is `report.ts`'s to take, after this.
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
});

test('t371 AT-U2 — a declaration that reaches into the report itself carries the value there, and nothing is added', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { call } = plane();
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([
      oneOutput({ arguments: { file: '{{input.output.proposal}}', folder: 'clients/7' } }),
    ]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.deepEqual(
    caller.calls[0].args,
    { file: 'the proposal, in full', folder: 'clients/7' },
    'a declaration that named the report is the whole call: no implicit key is added',
  );
});

test('t371 AT-U3 — a placeholder that does not resolve stops the delivery before any call', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { sent, call } = plane();
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput({ arguments: { folder: 'clients/{{input.output.customer}}' } })]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.equal(step.kind, 'blocked', JSON.stringify(step));
  assert.match(step.kind === 'blocked' ? step.reason : '', /output\.customer/);
  assert.equal(caller.calls.length, 0, 'fail closed: nothing left the machine');
  assert.deepEqual(routes(sent, 'POST', '/external-calls'), [], 'and nothing was recorded either');
  assert.equal(routes(sent, 'POST', '/blocks').length, 1, 'the work stops with a reason');
});

test('t371 AT-U4 — a `from` the accepted report does not carry stops the delivery before any call', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { sent, call } = plane();
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput({ from: 'invoice' })]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.equal(step.kind, 'blocked', JSON.stringify(step));
  assert.match(step.kind === 'blocked' ? step.reason : '', /invoice/);
  assert.equal(caller.calls.length, 0, 'a delivery with nothing to deliver is not a call');
  assert.equal(routes(sent, 'POST', '/blocks').length, 1);
});

test('t371 AT-U5 — a node declaring no outputs, and a dispatch with no MCP window, both write nothing', async () => {
  const { writeExternalOutputs } = await loadModule();

  const bare = plane();
  assert.deepEqual(
    await writeExternalOutputs(bare.call, JOB, nodeWith([]), 41, REPORT, wiring(toolCaller([]), [])),
    { kind: 'written' },
  );
  assert.deepEqual(bare.sent, [], 'the empty declaration reads nothing at all');

  const unwired = plane();
  assert.deepEqual(
    await writeExternalOutputs(unwired.call, JOB, nodeWith([oneOutput()]), 41, REPORT),
    { kind: 'written' },
    'a dispatch wired without the MCP window behaves exactly as it did before this ticket',
  );
  assert.deepEqual(unwired.sent, []);
});

/* -------------------------------------------------------------------------- */
/* FR3 — idempotency                                                           */
/* -------------------------------------------------------------------------- */

test('t371 AT-U6 — the lookup happens BEFORE the call, and an `ok` row skips it', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { sent, rows, call } = plane({
    existing: [{ outcome: 'ok', finished_at: '2026-09-07T11:00:01.000Z' }],
  });
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.equal(caller.calls.length, 0, 'RF-35: a step attempted again does not duplicate the write');

  // The lookup is the FIRST thing this step does for the entry, and it asks the
  // three coordinates that identify one delivery.
  const looked = routes(sent, 'GET', '/external-calls');
  assert.equal(looked.length, 1);
  assert.match(looked[0].route, /node_id=deliver/);
  assert.match(looked[0].route, /name=delivered_proposal/);
  assert.match(looked[0].route, /direction=output/);
  assert.equal(sent[0].route, looked[0].route, 'it is asked before anything is written');

  // The skip is RECORDED, and not as an `ok`: nothing was sent this time.
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['ok', 'skipped_duplicate'],
  );
});

test('t371 AT-U7 — an `error` row is not a delivery, so the entry is attempted again', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { rows, call } = plane({
    existing: [{ outcome: 'error', finished_at: '2026-09-07T11:00:01.000Z' }],
  });
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.equal(caller.calls.length, 1, 'a call that failed left nothing on the far side');
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['error', 'ok'],
  );
});

/* -------------------------------------------------------------------------- */
/* FR4 — the safe node's ladder                                                */
/* -------------------------------------------------------------------------- */

test('t371 AT-U8 — a safe node retries the CALL, waits the declared rungs, and never opens a session', async () => {
  const { writeExternalOutputs, DEFAULT_OUTPUT_WRITE_BACKOFF_MS } = await loadModule();
  const { sent, rows, call } = plane();
  const caller = toolCaller([refused(), refused(), accepted()]);
  const waited: number[] = [];

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, waited),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.equal(caller.calls.length, 3, 'three attempts, and the third one landed');
  assert.deepEqual(waited, [...DEFAULT_OUTPUT_WRITE_BACKOFF_MS], 'one wait between each pair');
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['error', 'error', 'ok'],
    'every attempt has its own row: the log is what happened, not what worked',
  );
  assert.equal(
    routes(sent, 'GET', '/external-calls').length,
    3,
    'and the idempotency lookup is made before EVERY attempt, not once per entry',
  );
  assert.deepEqual(routes(sent, 'POST', '/input-requests'), [], 'a safe node asks nobody');
});

test('t371 AT-U9 — exhausting the ladder stops the work with a reason, and publishes no transition', async () => {
  const { writeExternalOutputs, DEFAULT_MAX_OUTPUT_WRITE_ATTEMPTS } = await loadModule();
  const { sent, rows, call } = plane();
  const caller = toolCaller([refused()]);
  const waited: number[] = [];

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, waited),
  );

  assert.equal(step.kind, 'blocked', JSON.stringify(step));
  const reason = step.kind === 'blocked' ? step.reason : '';
  assert.match(reason, /deliver/, 'the reason names the node');
  assert.match(reason, /delivered_proposal/, 'and the output');
  assert.match(reason, /drive/, 'and the server');
  assert.match(reason, /upload_file/, 'and the tool');
  assert.match(reason, /read-only/, 'and the last thing the far side said');

  assert.equal(caller.calls.length, DEFAULT_MAX_OUTPUT_WRITE_ATTEMPTS);
  assert.equal(caller.calls.length, 3, 'the default ceiling is three attempts in total');
  assert.deepEqual(waited.length, 2, 'two waits between three attempts, never a trailing one');
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['error', 'error', 'error'],
  );

  const blocked = routes(sent, 'POST', '/blocks');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].body?.reason, reason, 'the runner tells the API the story it tells its caller');
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
});

test('t371 AT-U10 — the ceiling and the ladder are overridable, together', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { call } = plane();
  const caller = toolCaller([refused()]);
  const waited: number[] = [];

  await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, waited, { maxAttempts: 2, backoffMs: [10] }),
  );

  assert.equal(caller.calls.length, 2);
  assert.deepEqual(waited, [10]);
});

test('t371 AT-U11 — a second declared output is only attempted once the first one landed', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { rows, call } = plane();
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([
      oneOutput(),
      oneOutput({ name: 'delivered_invoice', tool: 'send_invoice', from: 'resultado' }),
    ]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.deepEqual(
    rows.map((row) => [row.name, row.outcome]),
    [
      ['delivered_proposal', 'ok'],
      ['delivered_invoice', 'ok'],
    ],
    'in declared order, each one bracketed by its own pair of phases',
  );
});

/* -------------------------------------------------------------------------- */
/* FR5 — the unsafe node calls a person                                        */
/* -------------------------------------------------------------------------- */

test('t371 AT-U12 — an unsafe node makes ONE attempt and then asks, whatever the escalation policy says', async () => {
  const { writeExternalOutputs, EXTERNAL_OUTPUT_WRITE_ORIGIN, EXTERNAL_OUTPUT_WRITE_OPTIONS } =
    await loadModule();
  const { sent, rows, call } = plane();
  const caller = toolCaller([refused()]);
  const waited: number[] = [];

  const step = await writeExternalOutputs(
    call,
    JOB,
    // `never` is a node's own business doubts having nobody to ask. This is the
    // PLATFORM asking about a side effect it already attempted, which is not the
    // same question and is the one carve-out this ticket takes.
    nodeWith([oneOutput()], { unsafe_to_retry: true, escalation_policy: 'never' }),
    41,
    REPORT,
    wiring(caller, waited),
  );

  assert.deepEqual(step, { kind: 'asked' });
  assert.equal(caller.calls.length, 1, 'exactly one attempt: repeating is what the flag forbids');
  assert.deepEqual(waited, [], 'and no ladder, so nothing waited');

  const asked = routes(sent, 'POST', '/input-requests');
  assert.equal(asked.length, 1, JSON.stringify(sent));
  const body = asked[0].body ?? {};
  assert.equal(body.job_id, 7);
  assert.equal(body.session_id, 41, 'stamped with the session whose report is already stored');
  assert.equal(body.kind, 'question');
  assert.equal(body.auto_approvable, false, 'an environment fault is never auto-answered');
  assert.equal(body.origin, EXTERNAL_OUTPUT_WRITE_ORIGIN);
  assert.deepEqual(body.options, [...EXTERNAL_OUTPUT_WRITE_OPTIONS]);
  assert.deepEqual(
    [...EXTERNAL_OUTPUT_WRITE_OPTIONS],
    ['retry', 'skip this output', 'mark as done'],
  );
  assert.match(String(body.question), /deliver/);
  assert.match(String(body.question), /writes outside the system/);
  assert.match(String(body.context), /delivered_proposal/, 'the context carries the rows');
  assert.match(String(body.context), /read-only/);

  // No block of its own: the POST is what blocks the job, in the same
  // transaction as the question — two owners for one flag is how a job ends up
  // blocked with nothing pending.
  assert.deepEqual(routes(sent, 'POST', '/blocks'), []);
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['error'],
  );
});

test('t371 AT-U13 — a dangling row on an unsafe node asks WITHOUT calling: a write may already have happened', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { sent, call } = plane({ existing: [{ outcome: null, finished_at: null }] });
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()], { unsafe_to_retry: true }),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'asked' });
  assert.equal(caller.calls.length, 0, 'nobody knows how the first one ended; a second is not free');
  assert.equal(routes(sent, 'POST', '/input-requests').length, 1);
});

test('t371 AT-U14 — a dangling row on a SAFE node is retried, because repeating it costs nothing', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { call } = plane({ existing: [{ outcome: null, finished_at: null }] });
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()]),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'written' });
  assert.equal(caller.calls.length, 1);
});

test('t371 AT-U15 — an unsafe node whose delivery lands transitions like any other', async () => {
  const { writeExternalOutputs } = await loadModule();
  const { sent, rows, call } = plane();
  const caller = toolCaller([accepted()]);

  const step = await writeExternalOutputs(
    call,
    JOB,
    nodeWith([oneOutput()], { unsafe_to_retry: true }),
    41,
    REPORT,
    wiring(caller, []),
  );

  assert.deepEqual(step, { kind: 'written' }, 'unsafe is about REPEATING, not about delivering');
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['ok'],
  );
  assert.deepEqual(routes(sent, 'POST', '/input-requests'), []);
});

/* -------------------------------------------------------------------------- */
/* FR6 — the answer, without re-running the step                               */
/* -------------------------------------------------------------------------- */

/** The graph the settle path reads back when it resolves the node itself. */
const SNAPSHOT = {
  nodes: [{ id: 'deliver' }, { id: 'review' }],
  edges: [{ from: 'deliver', to: 'review', condition: 'always' }],
};

/** The job as the settle path receives it: a position and a version. */
const POSITIONED = { id: 7, current_node_id: 'deliver', graph_version_id: 'sha256:t371' };

/** One answered, origin-tagged question, as `GET /v1/input-requests` projects it. */
function answeredQuestion(answer: string): Record<string, unknown> {
  return {
    id: 99,
    job_id: 7,
    session_id: 41,
    node_id: 'deliver',
    kind: 'question',
    question: 'Step `deliver` writes outside the system and did not finish cleanly',
    status: 'answered',
    answer,
    answered_by: 'rafael',
    origin: 'external_output_write',
  };
}

/** The original session, with the report the control plane accepted and stored. */
const STORED_SESSION = { id: 41, job_id: 7, output: { resultado: 'always', proposal: 'x' } };

test('t371 AT-U16 — no answered question of this origin means an ordinary dispatch', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, call } = plane();

  assert.equal(await settleAnsweredOutputWrite(call, POSITIONED, {}), false);
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
  assert.equal(
    routes(sent, 'GET', '/input-requests').length,
    1,
    'one read, and it names the job, the status and the origin',
  );
  const asked = routes(sent, 'GET', '/input-requests')[0].route;
  assert.match(asked, /job_id=7/);
  assert.match(asked, /status=answered/);
  assert.match(asked, /origin=external_output_write/);
});

test('t371 AT-U17 — `retry` is an ordinary dispatch, with the dangling row closed first', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, rows, call } = plane({
    existing: [{ outcome: null, finished_at: null }],
    inputRequests: [answeredQuestion('retry')],
    snapshot: SNAPSHOT,
    sessions: [STORED_SESSION],
  });

  assert.equal(
    await settleAnsweredOutputWrite(call, POSITIONED, {}),
    false,
    'a person authorised trying again: the session reopens, and the write step runs again',
  );

  // The row nobody closed is closed now, and as an `error` — never as the
  // `unknown` this system reads and never writes. Left open, the write step
  // would read it as "a write may have happened" and ask the same question
  // again, forever.
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['error'],
  );
  assert.match(String(rows[0].result_summary), /retry/i);
  assert.deepEqual(routes(sent, 'POST', '/transitions'), [], 'and nothing moved yet');
});

test('t371 AT-U18 — `skip this output` moves the work with no session and no worktree', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, rows, call } = plane({
    existing: [{ outcome: 'error', finished_at: '2026-09-07T11:00:01.000Z' }],
    inputRequests: [answeredQuestion('skip this output')],
    snapshot: SNAPSHOT,
    sessions: [STORED_SESSION],
  });

  assert.equal(await settleAnsweredOutputWrite(call, POSITIONED, {}), true);

  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['error', 'skipped_by_person'],
    'the decision is recorded as what it was: a person, not a call',
  );

  const moved = routes(sent, 'POST', '/transitions');
  assert.equal(moved.length, 1, 'the transition is published from the ORIGINAL session\'s report');
  assert.equal(moved[0].body?.to_node_id, 'review');

  // The whole point of the carve-out: re-opening the step's session is exactly
  // the repeat `unsafe_to_retry` exists to prevent.
  assert.deepEqual(routes(sent, 'POST', '/sessions'), []);
  assert.deepEqual(routes(sent, 'POST', '/input-requests'), []);
});

test('t371 AT-U19 — `mark as done` moves the work too, and says who said so', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, rows, call } = plane({
    existing: [{ outcome: null, finished_at: null }],
    inputRequests: [answeredQuestion('mark as done')],
    snapshot: SNAPSHOT,
    sessions: [STORED_SESSION],
  });

  assert.equal(await settleAnsweredOutputWrite(call, POSITIONED, {}), true);
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ['marked_done_by_person'],
    'the dangling row IS the delivery a person confirmed; no second row invents one',
  );
  assert.match(String(rows[0].result_summary), /rafael/);
  assert.equal(routes(sent, 'POST', '/transitions').length, 1);
});

test('t371 AT-U20 — a decision already carried out does not fire a second time', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, call } = plane({
    existing: [{ outcome: 'skipped_by_person', finished_at: '2026-09-07T11:00:02.000Z' }],
    inputRequests: [answeredQuestion('skip this output')],
    snapshot: SNAPSHOT,
    sessions: [STORED_SESSION],
  });

  assert.equal(
    await settleAnsweredOutputWrite(call, POSITIONED, {}),
    false,
    'the answer is settled in the CALL LOG, not in the question, so a job that comes ' +
      'back to this node later dispatches normally instead of skipping forever',
  );
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
});

test('t371 AT-U21 — an answer nobody scripted is an ordinary dispatch, never a silent skip', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, call } = plane({
    existing: [{ outcome: 'error', finished_at: '2026-09-07T11:00:01.000Z' }],
    inputRequests: [answeredQuestion('go and look at it yourself')],
    snapshot: SNAPSHOT,
    sessions: [STORED_SESSION],
  });

  assert.equal(await settleAnsweredOutputWrite(call, POSITIONED, {}), false);
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
});

test('t371 AT-U22 — a decision about ANOTHER node is not this node\'s decision', async () => {
  const { settleAnsweredOutputWrite } = await loadModule();
  const { sent, call } = plane({
    existing: [{ outcome: 'error', finished_at: '2026-09-07T11:00:01.000Z' }],
    inputRequests: [{ ...answeredQuestion('skip this output'), node_id: 'review' }],
    snapshot: SNAPSHOT,
    sessions: [STORED_SESSION],
  });

  assert.equal(await settleAnsweredOutputWrite(call, POSITIONED, {}), false);
  assert.deepEqual(routes(sent, 'POST', '/transitions'), []);
});
