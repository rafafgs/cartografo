/**
 * MCP over HTTP: one POST per JSON-RPC message (t370, FR2).
 *
 * Deliberately the simplest thing that speaks the protocol — a request goes out
 * as a JSON body and the answer is expected as a single JSON body back. **No
 * SSE and no streaming** (Out of Scope): the streamable-HTTP transport lets a
 * server answer with an event stream, and reading one is a state machine with a
 * reconnection story of its own. Nothing this ticket does needs it — a
 * `tools/call` that returns a file's contents answers once — and building it
 * unasked would be inventing a protocol surface with no consumer to keep it
 * honest.
 *
 * There is no connection to open and none to close: `close()` is a no-op, which
 * is what makes the caller's `finally` uniform across the two transports.
 *
 * The credential, when there is one, is a header of the connection — resolved
 * from the runner's own environment before it ever gets here
 * (`mcp-discovery.ts`), and going no further than this request.
 */

import type { McpServerConnection } from '../engine/types.ts';
import { McpCallError, McpTimeoutError, type McpTransport } from './client.ts';

/** The http half of the connection union. */
type HttpConnection = Extract<McpServerConnection, { transport: 'http' }>;

/** Deadline of the notification leg, which no caller parameterizes. */
const NOTIFY_TIMEOUT_MS = 10_000;

export class HttpTransport implements McpTransport {
  readonly #connection: HttpConnection;
  readonly #doFetch: typeof fetch;

  constructor(connection: HttpConnection, doFetch: typeof fetch = fetch) {
    this.#connection = connection;
    this.#doFetch = doFetch;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = 1;
    const response = await this.#post(
      { jsonrpc: '2.0', id, method, params },
      method,
      timeoutMs,
    );

    const text = await response.text();
    if (!response.ok) {
      throw new McpCallError(
        `the MCP server answered ${String(response.status)} to \`${method}\`: ${text.slice(0, 500)}`,
      );
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch (error) {
      throw new McpCallError(
        `the MCP server answered \`${method}\` with something that is not JSON`,
        { cause: error },
      );
    }

    const { result, error } = (message ?? {}) as {
      result?: unknown;
      error?: { message?: unknown };
    };
    if (error !== undefined && error !== null) {
      const detail = typeof error.message === 'string' ? error.message : JSON.stringify(error);
      throw new McpCallError(`the MCP server refused \`${method}\`: ${detail}`);
    }

    return result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    // A notification is answered with silence by JSON-RPC's own rule, so
    // whatever comes back — a 202, an empty body, nothing at all — is fine, and
    // only a transport-level failure is worth reporting.
    await this.#post({ jsonrpc: '2.0', method, params }, method, NOTIFY_TIMEOUT_MS);
  }

  async close(): Promise<void> {
    // Nothing was opened: one POST per message is the whole transport.
    return await Promise.resolve();
  }

  /** One POST, with the deadline and the connection's own headers. */
  async #post(
    message: Record<string, unknown>,
    method: string,
    timeoutMs: number,
  ): Promise<Response> {
    try {
      return await this.#doFetch(this.#connection.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.#connection.headers,
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // `AbortSignal.timeout` aborts with a `TimeoutError`, and that is the one
      // failure of this call that is not the server refusing: it accepted the
      // message and said nothing, which a person fixes somewhere else entirely.
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new McpTimeoutError(method, timeoutMs);
      }
      throw new McpCallError(
        `could not reach the MCP server at ${this.#connection.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
}
