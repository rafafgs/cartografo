/**
 * Unit tests of the JSON-RPC layer — the part this package wrote by hand
 * instead of importing, and therefore the part that owes the most evidence.
 *
 * A fake `fetch` and two in-memory streams, in the same shape
 * `packages/screen/test/client.test.ts` uses: what is pinned here is the
 * FRAMING, and none of it needs a control plane.
 *
 * The rules under test are the ones an MCP client depends on and a hand-written
 * server gets wrong: a notification is answered with silence, an unknown method
 * is a protocol error while a failed tool is a result, a version this server
 * does not speak is answered with one it does, and a line that is not JSON does
 * not take the session down.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { ApiClient } from '../src/client.ts';
import {
  DEFAULT_PROTOCOL_VERSION,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  SERVER_VERSION,
  handleMessage,
  publishedTools,
  serve,
} from '../src/protocol.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** A client nothing in this file lets reach the network. */
function offlineClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'http://127.0.0.1:9',
    token: 'unused',
    doFetch: async () => {
      throw new Error('this test must not make a request');
    },
  });
}

test('the version this server announces is the one in its manifest', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  assert.equal(
    SERVER_VERSION,
    manifest.version,
    'serverInfo.version is what a client logs; two sources for it means one of them is stale',
  );
});

test('initialize echoes a supported revision and substitutes one it does not speak', async () => {
  const client = offlineClient();

  const known = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    client,
  );
  assert.equal(
    (known?.result as { protocolVersion: string }).protocolVersion,
    '2024-11-05',
    'a revision on the list comes back as it was asked for',
  );

  const unknown = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    client,
  );
  assert.equal(
    (unknown?.result as { protocolVersion: string }).protocolVersion,
    DEFAULT_PROTOCOL_VERSION,
    'anything else is answered with the newest revision this server speaks, and the client decides',
  );

  const capabilities = (unknown?.result as { capabilities: Record<string, unknown> }).capabilities;
  assert.deepEqual(
    Object.keys(capabilities),
    ['tools'],
    'this server declares tools and nothing else — announcing a capability it does not serve is a lie a client acts on',
  );
});

test('a notification is answered with silence', async () => {
  const client = offlineClient();

  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, client), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled' }, client), null);
  assert.equal(
    await handleMessage({ jsonrpc: '2.0', method: 'tools/list' }, client),
    null,
    'even a known method, sent with no id, is a notification and gets no response',
  );
});

test('an unknown method is a protocol error; a failed tool call is a result', async () => {
  const client = offlineClient();

  const unknownMethod = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read' }, client);
  assert.equal(unknownMethod?.error?.code, METHOD_NOT_FOUND);

  const unknownTool = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cartografo_nope' } },
    client,
  );
  assert.equal(unknownTool?.error, undefined, 'the call itself succeeded; what failed is inside it');
  const result = unknownTool?.result as { isError: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no tool named/);
});

test('a message that is not a request is refused with no id to answer against', async () => {
  const client = offlineClient();

  const batched = await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], client);
  assert.equal(batched?.error?.code, INVALID_REQUEST);
  assert.equal(batched?.id, null);

  const scalar = await handleMessage('ping', client);
  assert.equal(scalar?.error?.code, INVALID_REQUEST);

  const methodless = await handleMessage({ jsonrpc: '2.0', id: 3 }, client);
  assert.equal(methodless?.error?.code, INVALID_REQUEST);
  assert.equal(methodless?.id, 3, 'a request with an id is answered against that id, however broken');
});

test('every published tool carries a name, a description, a schema and its hints', () => {
  for (const tool of publishedTools()) {
    const schema = tool.inputSchema as { type: string; additionalProperties: boolean };
    assert.equal(typeof tool.name, 'string');
    assert.ok(String(tool.description).length > 40, `${String(tool.name)} needs a usable description`);
    assert.equal(schema.type, 'object');
    assert.equal(
      schema.additionalProperties,
      false,
      `${String(tool.name)} refuses arguments it does not declare, so a typo is an error and not a silent no-op`,
    );
    assert.equal(typeof (tool.annotations as { readOnlyHint: boolean }).readOnlyHint, 'boolean');
    assert.equal(
      tool.run,
      undefined,
      'the handler stays on this side of the wire; only its description crosses',
    );
  }
});

test('serve reads line by line, survives a bad line and matches answers by id', async () => {
  const input = new PassThrough();
  const output = new PassThrough();

  const written: string[] = [];
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => written.push(chunk));

  const running = serve({ client: offlineClient(), input, output });

  input.write('\n');
  input.write('this is not JSON\n');
  input.write('{"jsonrpc":"2.0","id":7,"method":"ping"}\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('{"jsonrpc":"2.0","id":8,"method":"tools/list"}\n');
  input.end();

  await running;

  const answers = written
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { id: number | null; error?: { code: number } });

  assert.equal(answers.length, 3, 'the blank line and the notification produced nothing');
  assert.equal(answers[0].error?.code, PARSE_ERROR);
  assert.equal(answers[0].id, null);
  assert.ok(
    answers.some((answer) => answer.id === 7),
    'the ping after the bad line was still answered',
  );
  assert.ok(answers.some((answer) => answer.id === 8));
});
