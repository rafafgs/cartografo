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
 * - `crash-call` — the process exits with a `tools/call` in flight;
 * - `deliver-fails-twice` — the first two `deliver` calls refuse, the third one
 *   lands (t371: the safe node's ladder);
 * - `deliver-hangs-once` — the first `deliver` call never answers, later ones
 *   land (t371: the unsafe node's timeout, and the retry a person authorises);
 * - `deliver-hangs` — no `deliver` call ever answers.
 *
 * ## The delivery counter (t371)
 *
 * `deliver` is the WRITE direction, and the one property t371's acceptance
 * tests exist to prove is that a step's output crosses the boundary exactly
 * once. So every attempt at it appends one line to the file named by
 * `CARTOGRAFO_FAKE_MCP_CALL_LOG` — `ok`, `error` or `hang`, plus what it was
 * handed — and the count of `ok` lines IS the number of deliveries this server
 * really received. A counter kept in memory would be reset by the client pool
 * closing between two dispatches, which is precisely the window a duplicate
 * write would slip through.
 *
 * It is also a MODULE: the constants and {@link handle} are exported so the
 * HTTP double can serve the identical three messages, and so a test asserting
 * "byte-identical to the fixed output" reads the bytes from here instead of
 * transcribing them.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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

/** The tool a node's declared OUTPUT is delivered through (t371). */
export const DELIVER_TOOL = 'deliver';

/** Every attempt at {@link DELIVER_TOOL}, as one line each, or `[]`. */
export function deliveryLog(logPath) {
  if (logPath === undefined || !existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** Appends one attempt to the log, when the caller asked for one. */
function recordDelivery(logPath, fate, args) {
  if (logPath === undefined || logPath === '') return;
  appendFileSync(logPath, `${JSON.stringify({ fate, args })}\n`);
}

/** The tools this server publishes, in the order `tools/list` gives them. */
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
  {
    name: DELIVER_TOOL,
    description: 'Takes what a step produced and files it away outside.',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string' }, nota: { type: 'string' } },
    },
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
export function handle(message, mode = 'normal', logPath = undefined) {
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

    // The write direction, and the one tool whose history is kept on disk
    // (t371). Every branch below records what it did BEFORE it answers, so a
    // call that hangs is still counted as an attempt — which is exactly the
    // fact the unsafe-node case is about.
    if (asked.name === DELIVER_TOOL) {
      const attempts = deliveryLog(logPath).length;

      if (mode === 'deliver-hangs' || (mode === 'deliver-hangs-once' && attempts === 0)) {
        recordDelivery(logPath, 'hang', args);
        return HANGS;
      }

      if (mode === 'deliver-fails-twice' && attempts < 2) {
        recordDelivery(logPath, 'error', args);
        return {
          jsonrpc: '2.0',
          id: answerTo,
          result: {
            content: [{ type: 'text', text: 'the folder is busy; try again' }],
            isError: true,
          },
        };
      }

      recordDelivery(logPath, 'ok', args);
      return {
        jsonrpc: '2.0',
        id: answerTo,
        result: { content: [{ type: 'text', text: `filed under ${String(args.folder)}` }] },
      };
    }

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
  const logPath = process.env.CARTOGRAFO_FAKE_MCP_CALL_LOG;
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

    const answer = handle(message, mode, logPath);
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
