/**
 * A fake MCP server, spoken from the side this repository had never spoken
 * (t370).
 *
 * `packages/mcp` is cartografo AS a server, and its tests drive it from the
 * outside. This ticket writes the opposite direction — a CLIENT — so what it
 * needs to test against is a server it fully controls: fixed bytes, a tool that
 * is not there, a call that never answers, a process that dies mid-request.
 * None of those is a thing a real server can be asked to be on demand.
 *
 * **Line-delimited JSON-RPC, one object per line**, which is what the stdio
 * transport means and what `packages/mcp/src/protocol.ts` already implements
 * from the other side. stdout is the wire: nothing here writes to it that is
 * not a response.
 *
 * The behaviours are chosen by `CARTOGRAFO_FAKE_MCP_MODE`, so one fixture
 * serves every case the suite needs without a second file per fault:
 *
 * - unset / `normal` — answers everything;
 * - `silent` — never answers anything at all, `initialize` included;
 * - `silent-call` — the handshake and the listing work, `tools/call` hangs;
 * - `error-call` — `tools/call` answers `{isError: true}`, which is a RESULT
 *   and not a protocol error (the same distinction the server half draws);
 * - `crash-call` — the process exits with a `tools/call` in flight.
 *
 * It is also a MODULE: the constants and {@link handle} are exported so the
 * HTTP double can serve the identical three messages, and so a test asserting
 * "byte-identical to the fixed output" reads the bytes from here instead of
 * transcribing them.
 */

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** The suffix every `read_file` answer carries, whatever it was asked for. */
export const FIXED_TEXT = 'the report this tool always returns, byte for byte.\n';

/**
 * The bytes `read_blob` hands back, base64 inside a `resource` entry.
 *
 * Deliberately not valid UTF-8 (`0x80`, `0xff`): a client that decoded the blob
 * as text on the way through would corrupt exactly these and pass every test
 * written over ASCII.
 */
export const FIXED_BLOB = Buffer.from([0x00, 0x01, 0x80, 0xff, 0x0a, 0x7f, 0x42]);

/** What `read_file` answers for a given `path` argument. */
export function readFileText(path) {
  return `read_file(${String(path)})\n${FIXED_TEXT}`;
}

/** The two tools this server publishes, in the order `tools/list` gives them. */
export const TOOLS = [
  {
    name: 'read_file',
    description: 'Reads a file and answers with its text.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'read_blob',
    description: 'Reads a file and answers with its bytes, as a resource.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

/** The revision this fake speaks — the newest the server half supports. */
export const PROTOCOL_VERSION = '2025-06-18';

/** The sentinel {@link handle} answers with when the mode is to say nothing. */
export const HANGS = Symbol.for('cartografo.fake-mcp.hangs');

/**
 * Answers one message.
 *
 * @param {unknown} message Whatever was on the line, already parsed.
 * @param {string} mode One of the modes named at the top of this file.
 * @returns {object|null|symbol} The response, `null` for a notification
 *   (JSON-RPC answers those with silence), or {@link HANGS} for the modes whose
 *   whole point is that nothing ever comes back.
 */
export function handle(message, mode = 'normal') {
  if (mode === 'silent') return HANGS;

  const { id, method, params } = message ?? {};
  const answerTo = id ?? null;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: answerTo,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cartografo-fake-mcp', version: '0.0.0' },
      },
    };
  }

  if (typeof method === 'string' && method.startsWith('notifications/')) return null;

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id: answerTo, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    if (mode === 'silent-call' || mode === 'crash-call') return HANGS;

    const asked = params ?? {};
    const args = asked.arguments ?? {};

    if (mode === 'error-call') {
      return {
        jsonrpc: '2.0',
        id: answerTo,
        result: {
          content: [{ type: 'text', text: 'the tool refused: the path is outside the sandbox' }],
          isError: true,
        },
      };
    }

    if (asked.name === 'read_file') {
      return {
        jsonrpc: '2.0',
        id: answerTo,
        result: { content: [{ type: 'text', text: readFileText(args.path) }] },
      };
    }

    if (asked.name === 'read_blob') {
      return {
        jsonrpc: '2.0',
        id: answerTo,
        result: {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'cartografo://fixture.bin',
                mimeType: 'application/octet-stream',
                blob: FIXED_BLOB.toString('base64'),
              },
            },
          ],
        },
      };
    }

    // A tool nobody published. It is a RESULT and not a protocol error, exactly
    // as the server half answers it — the caller is what can act on it.
    return {
      jsonrpc: '2.0',
      id: answerTo,
      result: {
        content: [{ type: 'text', text: `no tool named "${String(asked.name)}" on this server` }],
        isError: true,
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id: answerTo,
    error: { code: -32601, message: `unknown method: ${String(method)}` },
  };
}

/** Reads lines until stdin closes, answering each one. */
function serve() {
  const mode = process.env.CARTOGRAFO_FAKE_MCP_MODE ?? 'normal';
  const lines = createInterface({ input: process.stdin });

  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
      );
      return;
    }

    const answer = handle(message, mode);
    if (mode === 'crash-call' && message?.method === 'tools/call') {
      // The TDD exception this ticket records: a scripted death with a message
      // in flight, not a genuine fault injected into a real server.
      process.exit(7);
    }
    if (answer === null || answer === HANGS) return;
    process.stdout.write(`${JSON.stringify(answer)}\n`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve();
