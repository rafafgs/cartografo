/**
 * Acceptance tests for the denied-attempt tracker (t125, FR6).
 *
 * The tracker reads the raw `stream-json` frames and correlates a `tool_use`
 * with the `tool_result` that answers it — structure, never the engine's prose.
 * That is a decision recorded in the ticket's refinement log: the sentence the
 * CLI writes to explain a refusal changes between versions, while `id` /
 * `tool_use_id` / `is_error` are the frame contract
 * (`dispatch.ts:204-210` already decomposes the same blocks).
 *
 * Two properties matter as much as the detection itself:
 *
 * - **no false positive.** Only a name THIS session denied is even looked at,
 *   so an unrelated tool error never becomes a permission incident;
 * - **it never throws.** Bad frames are the normal case in a stream that mixes
 *   structured output with a dying scream in plain text, and a tracker that
 *   raises would take a whole dispatch down with it.
 *
 * The module is imported behind an `existsSync` check, same discipline as
 * `parse-input-request.test.ts`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as TrackerModule from '../../src/dispatch/parse-permission-denial.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/parse-permission-denial.ts';

let cache: typeof TrackerModule | null = null;

async function loadTracker(): Promise<typeof TrackerModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/parse-permission-denial.ts', import.meta.url).href
  )) as typeof TrackerModule;
  return cache;
}

/** What this session denied, as the policy resolved it. */
const DENIED = ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'Bash(curl *)'];

/** The assistant frame that announces a tool call. */
function toolUse(id: string, name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    session_id: 'cc-session',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

/** ...and the user frame that answers it. */
function toolResult(id: string, isError: boolean, content: unknown = 'nothing to say'): string {
  return JSON.stringify({
    type: 'user',
    session_id: 'cc-session',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }],
    },
  });
}

test('a denied tool that errors becomes one denial, with the resource it belongs to', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  assert.deepEqual(tracker.observe(toolUse('toolu_1', 'WebFetch', { url: 'https://example.com' })), []);
  const found = tracker.observe(
    toolResult('toolu_1', true, 'Claude requested permissions to use WebFetch, but you have not granted it.'),
  );

  assert.equal(found.length, 1);
  assert.equal(found[0].recurso, 'rede');
  assert.equal(found[0].ferramenta, 'WebFetch');
  assert.ok(
    found[0].motivo.includes('WebFetch'),
    `the reason has to keep what the engine said: ${found[0].motivo}`,
  );
});

test('a writing tool denied lands on the filesystem resource', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  tracker.observe(toolUse('toolu_2', 'Write', { file_path: '/tmp/x', content: 'x' }));
  const found = tracker.observe(toolResult('toolu_2', true));

  assert.equal(found.length, 1);
  assert.equal(found[0].recurso, 'filesystem');
  assert.equal(found[0].ferramenta, 'Write');
});

test('a denied pattern matches on the command, not only on the tool name', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  tracker.observe(toolUse('toolu_3', 'Bash', { command: 'curl -sS https://example.com' }));
  const found = tracker.observe(toolResult('toolu_3', true));

  assert.equal(found.length, 1);
  assert.equal(found[0].recurso, 'rede');
  assert.equal(
    found[0].ferramenta,
    'Bash(curl *)',
    'the entry recorded is the rule the adapter passed to the engine, not the bare tool',
  );
});

test('a Bash call outside the denied pattern is not a denial', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  tracker.observe(toolUse('toolu_4', 'Bash', { command: 'ls -la' }));

  assert.deepEqual(tracker.observe(toolResult('toolu_4', true, 'ls: no such file')), []);
});

test('an error from a tool nobody denied is ignored', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  tracker.observe(toolUse('toolu_5', 'Read', { file_path: '/tmp/missing' }));

  assert.deepEqual(
    tracker.observe(toolResult('toolu_5', true, 'File does not exist')),
    [],
    'a tool error unrelated to the policy must never become a permission incident',
  );
});

test('a denied tool that SUCCEEDS is not a denial', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  tracker.observe(toolUse('toolu_6', 'WebFetch', { url: 'https://example.com' }));

  assert.deepEqual(tracker.observe(toolResult('toolu_6', false, 'body')), []);
});

test('the correlation is by id: an unknown tool_use_id yields nothing', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  tracker.observe(toolUse('toolu_7', 'WebFetch'));

  assert.deepEqual(tracker.observe(toolResult('toolu_OTHER', true)), []);
  // ...and the pending call is still there for its own result.
  assert.equal(tracker.observe(toolResult('toolu_7', true)).length, 1);
});

test('an empty denied list can never produce a denial', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker([]);

  tracker.observe(toolUse('toolu_8', 'WebFetch'));

  assert.deepEqual(tracker.observe(toolResult('toolu_8', true)), []);
});

test('nothing the stream can carry makes the tracker throw', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  const garbage = [
    '',
    '   ',
    'dying scream in plain text, not JSON at all',
    '{ not json at all',
    'null',
    '[]',
    '{}',
    '{"type":"assistant"}',
    '{"type":"assistant","message":null}',
    '{"type":"assistant","message":{"content":"not a list"}}',
    '{"type":"assistant","message":{"content":[null,42,"text"]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":7,"is_error":"yes"}]}}',
    JSON.stringify({ type: 'result', result: 'all done' }),
  ];

  for (const line of garbage) {
    assert.deepEqual(tracker.observe(line), [], `this line produced a denial: ${line}`);
  }
});

test('several denials in one stream all come out, each exactly once', async () => {
  const { PermissionDenialTracker } = await loadTracker();
  const tracker = new PermissionDenialTracker(DENIED);

  const found = [
    ...tracker.observe(toolUse('a', 'Edit', { file_path: '/tmp/x' })),
    ...tracker.observe(toolUse('b', 'WebFetch', { url: 'https://example.com' })),
    ...tracker.observe(toolResult('b', true)),
    ...tracker.observe(toolResult('a', true)),
    // The same result arriving twice must not double the incident.
    ...tracker.observe(toolResult('a', true)),
  ];

  assert.deepEqual(
    found.map((denial) => denial.ferramenta),
    ['WebFetch', 'Edit'],
  );
});
