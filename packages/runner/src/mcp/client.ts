/**
 * The Model Context Protocol, spoken as a CLIENT (t370, FR2).
 *
 * `packages/mcp` is cartografo AS a server. This is the opposite direction and
 * it shares no code with it — the two halves share a WIRE FORMAT, not an
 * implementation, and importing one into the other would tie the runner's
 * ability to call a third-party server to a module whose subject is publishing
 * this system's own tools.
 *
 * **Why it is written out and not imported.** The same argument
 * `packages/mcp/src/protocol.ts` makes, read from the other side: the surface a
 * caller actually needs is `initialize` plus the `notifications/initialized`
 * that closes the handshake, `tools/list` and `tools/call`, and every one of
 * them has been compatible across every revision of the spec since 2024-11-05.
 * The runner declares no runtime dependency (D17, and `package.json` still has
 * none). A dependency that would earn its place here is one that closes a gap;
 * an SDK would add a supply chain — reviewed at no gate, pinned by no hash — to
 * save a few hundred lines the tests pin anyway. The cost is named rather than
 * hidden: a revision that adds something this client should speak arrives as
 * work here instead of as an upgrade.
 *
 * **Two transports, one client.** The difference between a spawned child and an
 * HTTP endpoint is entirely inside {@link McpTransport}; nothing above this
 * line knows which one it is holding, which is what lets the acceptance tests
 * hold both to the identical assertions.
 *
 * **Every call has a deadline, and a deadline is its own failure.** A server
 * that accepted the message and went quiet is not the same fact as a server
 * that refused, and `resolve-external-inputs.ts` reports them as two different
 * reasons because a person fixes them in two different places.
 */

import type { McpServerConnection } from '../engine/types.ts';
import { HttpTransport } from './transport-http.ts';
import { StdioTransport } from './transport-stdio.ts';

/** The revision this client asks for. Newest of the three the server half speaks. */
export const PROTOCOL_VERSION = '2025-06-18';

/** How this client introduces itself at `initialize`. */
export const CLIENT_INFO = Object.freeze({ name: 'cartografo-runner', version: '0.1.0' });

/** Deadline of the handshake and the listing, when the caller names none. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Anything this client refuses with. Never thrown directly. */
export class McpError extends Error {}

/**
 * The call failed: the server refused it, the connection broke, the child died.
 *
 * Everything that is NOT silence past the deadline, which is
 * {@link McpTimeoutError}'s. The two are siblings rather than parent and child
 * on purpose: a caller distinguishing them with `instanceof` must not have one
 * quietly satisfy the other's check.
 */
export class McpCallError extends McpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpCallError';
  }
}

/** The call was accepted and nothing came back inside the deadline. */
export class McpTimeoutError extends McpError {
  /** The deadline that ran out, in milliseconds. */
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`the MCP server did not answer \`${method}\` within ${String(timeoutMs)}ms`);
    this.name = 'McpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * One way of carrying JSON-RPC messages to a server and back.
 *
 * A request expects an answer matched by id; a notification is answered with
 * silence, by JSON-RPC's own rule. `close` has to be safe to call twice and on
 * a transport that never opened anything — the resolution above calls it in a
 * `finally`, on the success path and on every failure path alike.
 */
export interface McpTransport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  close(): Promise<void>;
}

/** One tool, as `tools/list` publishes it. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/**
 * What `tools/call` answers, verbatim.
 *
 * `isError: true` is a RESULT and not a protocol error — the server half says
 * so in its own words, and this side has to preserve the distinction: a tool
 * that refused an argument is something the caller can act on, and collapsing
 * it into a thrown error would lose the message that says how.
 */
export interface McpToolResult {
  readonly content: readonly unknown[];
  readonly isError?: boolean;
}

/**
 * The three-plus-one method surface, which is the whole of what is used here.
 *
 * Declared as an interface beside the class so a caller can be handed a double:
 * `resolveExternalInputs` takes a factory, and the case that proves "one client
 * per server, not one per entry" needs to count `initialize` calls without a
 * process on the other side.
 */
export interface McpClientLike {
  initialize(): Promise<unknown>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpToolResult>;
  close(): Promise<void>;
}

/** Reads a JSON-RPC `result` as an object, whatever the server sent. */
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** How this client is wired. */
export interface McpClientOptions {
  /**
   * Deadline of the handshake and the listing.
   *
   * The CALL's deadline is a parameter of `callTool` instead, because that is
   * the one the node's dispatch configures (`mcpCallTimeoutMs`) and the one a
   * person tunes: a tool that reads a large file is slow for a reason the
   * handshake never is.
   */
  readonly requestTimeoutMs?: number;
}

export class McpClient implements McpClientLike {
  readonly #transport: McpTransport;
  readonly #requestTimeoutMs: number;

  constructor(transport: McpTransport, options: McpClientOptions = {}) {
    this.#transport = transport;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * The handshake, both legs of it.
   *
   * `initialize` and then the `notifications/initialized` the spec requires
   * before any other request: a server is entitled to refuse everything until
   * it has been told the client is ready, and skipping the notification is the
   * kind of omission that works against a lenient server and fails against a
   * correct one.
   */
  async initialize(): Promise<unknown> {
    const result = await this.#transport.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      this.#requestTimeoutMs,
    );

    await this.#transport.notify('notifications/initialized', {});
    return result;
  }

  /**
   * Which tools the server publishes.
   *
   * Entries without a string `name` are dropped rather than reported: the one
   * consumer asks "is this tool here", and a nameless entry cannot answer that
   * question either way.
   */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = asObject(
      await this.#transport.request('tools/list', {}, this.#requestTimeoutMs),
    );
    const tools = result.tools;
    if (!Array.isArray(tools)) return [];

    return tools
      .map((tool) => asObject(tool))
      .filter((tool): tool is Record<string, unknown> & { name: string } =>
        typeof tool.name === 'string' && tool.name !== '',
      )
      .map((tool) => tool as unknown as McpToolDescriptor);
  }

  /**
   * Calls one tool and hands back what came, unedited.
   *
   * `content` is normalized to an array only so a caller may index it without
   * checking; everything inside it is the server's own, down to the byte. What
   * this client must never do is interpret it — deciding which entry shape is
   * usable is `resolve-external-inputs.ts`'s, where the refusal has a reason
   * and a node to name.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<McpToolResult> {
    const result = asObject(
      await this.#transport.request('tools/call', { name, arguments: args }, timeoutMs),
    );

    return {
      content: Array.isArray(result.content) ? (result.content as readonly unknown[]) : [],
      ...(result.isError === true ? { isError: true } : {}),
    };
  }

  async close(): Promise<void> {
    await this.#transport.close();
  }
}

/**
 * Builds the client for a resolved connection, transport and all.
 *
 * The one place the union is read: everything above this line takes a
 * {@link McpTransport}, so adding a third transport is a case here and a file
 * beside the other two, and no change at all to the client or its caller.
 *
 * @param connection Where the server is and how to talk to it.
 * @param options Deadline of the handshake and the listing.
 * @returns A client that has not connected to anything yet — the transports
 *   below open lazily, so building one costs nothing and closing one that was
 *   never used is a no-op.
 */
export function createMcpClient(
  connection: McpServerConnection,
  options: McpClientOptions = {},
): McpClient {
  const transport =
    connection.transport === 'stdio'
      ? new StdioTransport(connection)
      : new HttpTransport(connection);

  return new McpClient(transport, options);
}
