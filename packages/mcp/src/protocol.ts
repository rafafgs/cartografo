/**
 * The Model Context Protocol, spoken over stdio — JSON-RPC 2.0, one message per
 * line, in and out.
 *
 * **Why this is written out and not imported.** MCP has an official SDK, and
 * this package does not use it. The protocol surface a tool server actually
 * needs is four methods (`initialize`, `notifications/initialized`,
 * `tools/list`, `tools/call`) plus `ping`, and every one of them has been
 * compatible across every revision of the spec since 2024-11-05. Against that,
 * this repository's packages carry one runtime dependency between them — the
 * tsx loader every `bin/*.mjs` registers — and `packages/screen` serves HTTP
 * with `node:http` and no framework for the same reason. A dependency that
 * would earn its place here is one that closes a gap; this one would add a
 * supply chain to save a hundred lines that the tests below pin anyway.
 *
 * The cost is named rather than hidden: a future revision that adds something
 * this server should speak — a new capability, a richer result shape — arrives
 * as work here instead of as an upgrade. {@link SUPPORTED_PROTOCOL_VERSIONS} is
 * where that shows up first.
 *
 * **stdout is the wire.** Nothing in this package writes to stdout except
 * {@link serve}, and everything a human reads goes to stderr. A `console.log`
 * left anywhere under here does not produce noise, it produces a corrupt
 * session: the client is parsing that stream as JSON-RPC.
 *
 * **A failed tool is a RESULT, not a protocol error.** `tools/call` answers
 * `{content, isError: true}` when the control plane refuses, because the model
 * that called is the one who can act on it — it can read the message, fix the
 * argument and call again. A JSON-RPC error is reserved for what the model
 * cannot fix: a method this server does not have, or a message it could not
 * parse.
 */

import { createInterface } from 'node:readline';

import type { ApiClient } from './client.ts';
import { TOOLS, describeFailure, findTool } from './tools.ts';

/** Name this server announces. */
export const SERVER_NAME = 'cartografo';

/** Version this server announces. Kept in step with `package.json` by a test. */
export const SERVER_VERSION = '0.1.0';

/**
 * Protocol revisions this server knows how to speak.
 *
 * Newest last. A client that asks for one of these gets it back; a client that
 * asks for anything else — an older revision this server never spoke, or a
 * newer one it has not been taught — is answered with the newest one here,
 * which is what the spec asks a server to do: state the version it WILL speak
 * and let the client decide whether that is enough.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
]);

/** The revision answered when the client asks for one that is not on the list. */
export const DEFAULT_PROTOCOL_VERSION =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

/**
 * What the client is told this server is, once, at `initialize`.
 *
 * It says the two things a model cannot infer from the tool list: that reading
 * the map is free and driving it is not, and that the two decisions this server
 * refuses to make are refused on purpose (`src/tools.ts` carries the reasoning).
 */
export const INSTRUCTIONS = [
  'cartografo is a work orchestrator: a problem class becomes a graph of gate and work nodes,',
  'jobs travel that graph, agent sessions do the work, and a surveyor proposes changes to the',
  'graph between rounds.',
  '',
  'Read first — `cartografo_status` says whether the control plane is up and what it holds, and',
  '`cartografo_describe_graph` draws the map a job is travelling.',
  '',
  'Two things this server deliberately cannot do. It cannot decide a proposal (approve, apply,',
  'reject, revert): those are a human decision at the screen, and the learning loop depends on',
  'the judge being outside the model. And it cannot move a job across the graph: transitions are',
  'the runner writing down what it actually did, so an invented one would corrupt the record the',
  'surveyor reads. It also starts and stops no processes — the control plane, the runner and the',
  'surveyor are commands an operator runs.',
].join('\n');

/** A JSON-RPC message, as far as this server inspects it. */
interface Incoming {
  jsonrpc?: unknown;
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

/** What goes back on the wire. */
export interface Outgoing {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC's own codes, in the four shapes this server produces. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

function ok(id: string | number | null, result: unknown): Outgoing {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): Outgoing {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The tool list, as `tools/list` publishes it — the handlers stay behind. */
export function publishedTools(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

/** A `tools/call` result: text content, plus whether it is a failure. */
function toolResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Runs one tool call and turns whatever happens into a result.
 *
 * Never throws: a tool that refuses an argument, a control plane that is down,
 * a route that answers 404 — all three come back as `isError: true` with the
 * one line {@link describeFailure} produces, because all three are things the
 * caller can act on.
 *
 * @param client Client of the control plane.
 * @param params The `tools/call` params, unvalidated.
 * @returns The result object to put in the response.
 */
export async function callTool(client: ApiClient, params: unknown): Promise<Record<string, unknown>> {
  const asked = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof asked.name === 'string' ? asked.name : '';
  const tool = findTool(name);
  if (tool === undefined) {
    return toolResult(
      `no tool named "${name}" on this server; call tools/list for what there is`,
      true,
    );
  }

  const args =
    typeof asked.arguments === 'object' && asked.arguments !== null && !Array.isArray(asked.arguments)
      ? (asked.arguments as Record<string, unknown>)
      : {};

  try {
    const answer = await tool.run(client, args);
    return toolResult(JSON.stringify(answer, null, 2));
  } catch (error) {
    return toolResult(describeFailure(error, client.baseUrl), true);
  }
}

/**
 * Answers one message.
 *
 * @param message Whatever was on the line, already parsed.
 * @param client Client of the control plane.
 * @returns The response to write, or `null` for a notification — which by
 *   JSON-RPC's own rule is answered with silence, not with an empty result.
 */
export async function handleMessage(message: unknown, client: ApiClient): Promise<Outgoing | null> {
  if (Array.isArray(message)) {
    // Batching left the protocol with the 2025-06-18 revision, and this server
    // never spoke it. An array is refused whole, with no id to answer against.
    return fail(null, INVALID_REQUEST, 'batched requests are not supported');
  }
  if (typeof message !== 'object' || message === null) {
    return fail(null, INVALID_REQUEST, 'a message has to be a JSON object');
  }

  const { id, method, params } = message as Incoming;
  const isNotification = id === undefined;
  const answerTo = id ?? null;

  if (typeof method !== 'string') {
    return isNotification ? null : fail(answerTo, INVALID_REQUEST, '"method" has to be a string');
  }

  try {
    switch (method) {
      case 'initialize': {
        const asked = (params ?? {}) as { protocolVersion?: unknown };
        const version =
          typeof asked.protocolVersion === 'string' &&
          SUPPORTED_PROTOCOL_VERSIONS.includes(asked.protocolVersion)
            ? asked.protocolVersion
            : DEFAULT_PROTOCOL_VERSION;

        return ok(answerTo, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }

      // The handshake's third leg and the cancellations a client may send: all
      // notifications, all answered with silence.
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return isNotification ? null : ok(answerTo, {});

      case 'tools/list':
        return isNotification ? null : ok(answerTo, { tools: publishedTools() });

      case 'tools/call':
        return isNotification ? null : ok(answerTo, await callTool(client, params));

      default:
        return isNotification ? null : fail(answerTo, METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  } catch (error) {
    // Nothing above is expected to throw — `callTool` swallows its own failures
    // — so this is the guard that stops one bad message from taking the process
    // down and hanging the client on a request it will never see answered.
    return isNotification
      ? null
      : fail(answerTo, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
  }
}

/** How {@link serve} is wired up. */
export interface ServeOptions {
  /** Client of the control plane every tool call goes through. */
  client: ApiClient;
  /** Where messages come from. Default `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** Where responses go. Default `process.stdout`. */
  output?: NodeJS.WritableStream;
}

/**
 * Reads messages until the input closes, answering each one.
 *
 * Line-delimited, which is what stdio transport means: one JSON object per
 * line, and a blank line is nothing at all rather than a parse error.
 *
 * The calls are dispatched CONCURRENTLY and the responses go out whenever they
 * are ready. JSON-RPC answers are matched by id, not by order, and the
 * alternative — awaiting each call before reading the next line — would let one
 * slow transcript read stall every other tool the client asked for.
 *
 * @param options Client, and the two streams.
 * @returns Resolves when the input has closed and every call in flight has
 *   answered.
 */
export async function serve(options: ServeOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const inFlight: Promise<void>[] = [];

  const send = (response: Outgoing): void => {
    output.write(`${JSON.stringify(response)}\n`);
  };

  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const text = line.trim();
    if (text === '') continue;

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      send(fail(null, PARSE_ERROR, 'the line was not valid JSON'));
      continue;
    }

    inFlight.push(
      handleMessage(message, options.client).then((response) => {
        if (response !== null) send(response);
      }),
    );
  }

  await Promise.all(inFlight);
}
