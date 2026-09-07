/**
 * MCP over a spawned child: line-delimited JSON-RPC, one object per line
 * (t370, FR2).
 *
 * The same wire discipline `packages/mcp/src/protocol.ts` implements from the
 * server side, read from this one. stdout is the wire and nothing else: the
 * child's stderr is drained and dropped, because a server that logs to stderr
 * is ordinary and a pipe nobody reads is a child that eventually blocks.
 *
 * **The process opens lazily and closes once.** Building a transport spawns
 * nothing, which is what lets `resolve-external-inputs.ts` refuse an entry —
 * for an argument that does not resolve, say — with no server ever having run.
 * From the first request there is a process, and `close()` is what ends it;
 * that call is in a `finally` up there, so no child survives one dispatch.
 *
 * **A child that dies with messages in flight rejects them all.** The
 * alternative is the failure mode this class exists to avoid: a promise nobody
 * will ever settle, holding a dispatch open until the runner is killed. The
 * rejection is a `McpCallError` and never a timeout — the process is gone,
 * which is a fact, where a deadline is only an absence of one.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { McpServerConnection } from '../engine/types.ts';
import { McpCallError, McpTimeoutError, type McpTransport } from './client.ts';

/** A message this transport is waiting for an answer to. */
interface Pending {
  readonly method: string;
  readonly settle: (result: unknown) => void;
  readonly refuse: (error: Error) => void;
  /** Detaches the deadline, so a settled call cannot be timed out afterwards. */
  readonly disarm: () => void;
}

/** The stdio half of the connection union. */
type StdioConnection = Extract<McpServerConnection, { transport: 'stdio' }>;

export class StdioTransport implements McpTransport {
  readonly #connection: StdioConnection;
  readonly #pending = new Map<number, Pending>();

  #child: ChildProcessWithoutNullStreams | null = null;
  #buffer = '';
  #nextId = 1;
  #closed = false;
  /** Why the child is no longer usable, once it is not. */
  #dead: string | null = null;

  constructor(connection: StdioConnection) {
    this.#connection = connection;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.#open();
    const id = this.#nextId++;

    return await new Promise<unknown>((resolve, reject) => {
      // `AbortSignal.timeout` rather than a bare `setTimeout`, so both
      // transports express a deadline the same way and a reader comparing them
      // finds one mechanic instead of two.
      const signal = AbortSignal.timeout(timeoutMs);
      const onAbort = (): void => {
        this.#pending.delete(id);
        reject(new McpTimeoutError(method, timeoutMs));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      this.#pending.set(id, {
        method,
        settle: resolve,
        refuse: reject,
        disarm: () => signal.removeEventListener('abort', onAbort),
      });

      this.#write(child, { jsonrpc: '2.0', id, method, params });
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    // No `id`, so no answer is expected and none is waited for — JSON-RPC's own
    // rule, and the reason the handshake's third leg costs nothing.
    this.#write(this.#open(), { jsonrpc: '2.0', method, params });
    return await Promise.resolve();
  }

  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    this.#child = null;

    this.#failPending('the MCP client closed the connection');

    if (child !== null && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    return await Promise.resolve();
  }

  /** Spawns the server, once, and wires its streams. */
  #open(): ChildProcessWithoutNullStreams {
    if (this.#closed) throw new McpCallError('this MCP transport is already closed');
    if (this.#dead !== null) throw new McpCallError(this.#dead);
    if (this.#child !== null) return this.#child;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#connection.command, [...this.#connection.args], {
        // The DECLARED keys override the inherited environment, and the rest of
        // the runner's own is kept: that is what lets a configuration write
        // `"command": "npx"` and have `PATH` resolve it. It is also the one
        // place the MCP credential exists in this process — it goes into a
        // child's environment and nowhere else (RF-34).
        env: { ...process.env, ...this.#connection.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new McpCallError(
        `could not start the MCP server \`${this.#connection.command}\``,
        { cause: error },
      );
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#pump(chunk));
    // Drained and dropped: a server that logs is ordinary, and an unread pipe
    // is a child that blocks once the buffer fills.
    child.stderr.resume();

    child.on('error', (error: Error) => {
      this.#die(`the MCP server \`${this.#connection.command}\` failed: ${error.message}`);
    });
    child.on('exit', (code, signal) => {
      this.#die(
        `the MCP server \`${this.#connection.command}\` exited (` +
          `${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}` +
          ') with a call in flight',
      );
    });

    this.#child = child;
    return child;
  }

  /** Writes one message as a single line. */
  #write(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Splits the stream into lines, keeping the `\n`-less tail for the next chunk. */
  #pump(chunk: string): void {
    this.#buffer += chunk;

    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== '') this.#deliver(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  /** Matches one answer to the request that is waiting for it, by id. */
  #deliver(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // A line that is not JSON is not an answer to anything: some servers
      // print a banner on stdout before they behave. Dropping it is what keeps
      // one stray line from failing a call that is still coming.
      return;
    }

    const { id, result, error } = (message ?? {}) as {
      id?: unknown;
      result?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    if (typeof id !== 'number') return;

    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    pending.disarm();

    if (error !== undefined && error !== null) {
      const detail = typeof error.message === 'string' ? error.message : JSON.stringify(error);
      pending.refuse(
        new McpCallError(`the MCP server refused \`${pending.method}\`: ${detail}`),
      );
      return;
    }

    pending.settle(result);
  }

  /** The child is gone: nothing in flight can be answered any more. */
  #die(reason: string): void {
    if (this.#dead === null) this.#dead = reason;
    this.#child = null;
    this.#failPending(reason);
  }

  /** Refuses everything still waiting, with the same reason. */
  #failPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.disarm();
      pending.refuse(new McpCallError(reason));
    }
  }
}
