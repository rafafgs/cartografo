#!/usr/bin/env node
/**
 * A scripted, dependency-free stand-in for an OpenAI-compatible provider (t676).
 *
 * Manual-proof tooling, NOT a CI fixture: it exists so a REAL `copilot` binary
 * can run a whole session with no GitHub credential. `copilot help environment`
 * says of BYOK (`COPILOT_PROVIDER_BASE_URL`) that "GitHub authentication is not
 * required", and measured against `@github/copilot@1.0.95` that held: the stub
 * only has to answer `POST /v1/chat/completions` with Server-Sent Events —
 * `chat.completion.chunk` deltas, a `finish_reason`, then `data: [DONE]` — and
 * `GET /v1/models`. The CLI sent `stream: true`, two messages and 18 tool
 * definitions on the first turn.
 *
 * The script is a JSON file, one entry per model turn, consumed in order by
 * every `POST /v1/chat/completions` (a request past the last entry answers the
 * last one's text, or "OK" when that was a tool call, so a loop that asks once
 * too often still ends):
 *
 *   { "turns": [
 *       { "text": "…" },
 *       { "tool_calls": [ { "name": "create", "arguments": { "path": "…", "file_text": "…" } } ] }
 *   ] }
 *
 * - `text` becomes `delta.content` chunks and `finish_reason: "stop"`.
 * - `tool_calls` becomes `delta.tool_calls` and `finish_reason: "tool_calls"`;
 *   the CLI runs the tool and posts the result as the next request, which takes
 *   the next entry. Which tool names exist is in the request's own `tools`, and
 *   the stub prints them (`--log-tools`) so a script is written against what
 *   this CLI version really offers instead of a guess.
 *
 * Usage:
 *   node stub-openai-provider.mjs --script turns.json [--port 0] [--log-tools]
 *
 * It prints one JSON line when it is up — `{"listening":"http://127.0.0.1:<port>/v1"}` —
 * and one line per request on stderr. Stop it with SIGTERM.
 *
 * Importable: `startStubProvider({ turns, port })` returns `{ url, requests, close }`
 * and is what `spike-real-session-copilot.mjs` uses in `stub` mode.
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

/** One SSE `data:` line. */
const sse = (payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

function chunk(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** The SSE body for one scripted turn. */
function renderTurn(turn, model, sequence) {
  const id = `chatcmpl-stub-${sequence}`;
  const events = [chunk(id, model, { role: 'assistant', content: '' }, null)];

  if (Array.isArray(turn.tool_calls) && turn.tool_calls.length > 0) {
    turn.tool_calls.forEach((call, index) => {
      events.push(
        chunk(
          id,
          model,
          {
            tool_calls: [
              {
                index,
                id: `call_stub_${sequence}_${index}`,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
              },
            ],
          },
          null,
        ),
      );
    });
    events.push(chunk(id, model, {}, 'tool_calls'));
  } else {
    const text = typeof turn.text === 'string' ? turn.text : 'OK';
    // Several deltas, so the CLI emits `assistant.message_delta` frames and a
    // decoder that concatenated them on top of `assistant.message` is caught.
    const middle = Math.max(1, Math.floor(text.length / 2));
    for (const part of [text.slice(0, middle), text.slice(middle)]) {
      if (part !== '') events.push(chunk(id, model, { content: part }, null));
    }
    events.push(chunk(id, model, {}, 'stop'));
  }

  events.push(
    {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
    '[DONE]',
  );
  return events.map(sse).join('');
}

/**
 * Starts the stub on 127.0.0.1.
 *
 * @param {{ turns: Array<object>, port?: number, logTools?: boolean }} options
 */
export async function startStubProvider({ turns, port = 0, logTools = false }) {
  const requests = [];
  let consumed = 0;

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (piece) => chunks.push(piece));
    request.on('end', () => {
      const path = (request.url ?? '').split('?')[0];

      if (request.method === 'GET' && path.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }));
        return;
      }

      if (request.method === 'POST' && path.endsWith('/chat/completions')) {
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* a body that is not JSON is answered like an empty one */
        }
        const toolNames = Array.isArray(body.tools)
          ? body.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
          : [];
        requests.push({ messages: Array.isArray(body.messages) ? body.messages.length : 0, toolNames });
        if (logTools) process.stderr.write(`[stub] tools: ${toolNames.join(', ')}\n`);

        const turn = turns[Math.min(consumed, turns.length - 1)] ?? { text: 'OK' };
        const sequence = consumed;
        consumed += 1;
        process.stderr.write(`[stub] POST ${path} -> turn ${sequence}\n`);

        // A repeated tool call would loop the CLI forever; past the script the
        // answer is plain text.
        const effective = sequence >= turns.length && Array.isArray(turn.tool_calls) ? { text: 'OK' } : turn;

        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.end(renderTurn(effective, typeof body.model === 'string' ? body.model : 'stub-model', sequence));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `stub: no route for ${request.method} ${path}` } }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const { port: boundPort } = server.address();
  return {
    url: `http://127.0.0.1:${boundPort}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** `--flag value` and bare `--flag` out of argv. */
function parseArgs(argv) {
  const out = { script: null, port: 0, logTools: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--script') out.script = argv[(i += 1)];
    else if (argv[i] === '--port') out.port = Number(argv[(i += 1)]);
    else if (argv[i] === '--log-tools') out.logTools = true;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.script === null) {
    process.stderr.write('usage: stub-openai-provider.mjs --script turns.json [--port N] [--log-tools]\n');
    process.exit(2);
  }
  const { turns } = JSON.parse(readFileSync(args.script, 'utf8'));
  const stub = await startStubProvider({ turns, port: args.port, logTools: args.logTools });
  process.stdout.write(`${JSON.stringify({ listening: stub.url })}\n`);
  process.on('SIGTERM', () => void stub.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void stub.close().then(() => process.exit(0)));
}
