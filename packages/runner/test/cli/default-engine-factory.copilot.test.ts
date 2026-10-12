/**
 * What `defaultEngineFactory('copilot')` decodes with (t676, FR1).
 *
 * t675 shipped the route with a raw passthrough, so `--engine copilot` ran a
 * session whose escalation block could never parse: Copilot prints JSONL
 * frames and the block's quotes and newlines arrive escaped. This pins the
 * route to the frame decoder over the same REAL capture the decoder's own
 * tests read.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseInputRequest } from '../../src/dispatch/parse-input-request.ts';
import { decodeCopilotSessionText } from '../../src/dispatch/session-text.ts';
import { defaultEngineFactory } from '../../src/cli/run.ts';

function fixtureLines(): string[] {
  const file = fileURLToPath(new URL('../fixtures/copilot-frames.jsonl', import.meta.url));
  assert.ok(existsSync(file), `artifact does not exist yet: ${path.relative(process.cwd(), file)}`);
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

test('t676 — the copilot route decodes frames, it does not join them', () => {
  const route = defaultEngineFactory('copilot');
  const lines = fixtureLines();

  assert.equal(route.adapter.engineName, 'copilot');
  assert.equal(route.decodeSessionText(lines), decodeCopilotSessionText(lines));
  assert.notEqual(route.decodeSessionText(lines), lines.join('\n'), 'not the raw join');

  const request = parseInputRequest(route.decodeSessionText(lines));
  assert.ok(request !== null, 'an escalation from a real Copilot session reaches the parser');
});

test('t676 — the other two routes keep their own decoders', () => {
  const frame = JSON.stringify({ type: 'assistant.message', data: { content: 'x' } });

  // A Copilot-shaped frame is NOT text for the other two engines' decoders: it
  // is recognized-and-textless for Codex (it has a string `type`) and for Claude
  // Code, so neither of them returns the Copilot route's answer.
  assert.equal(defaultEngineFactory('copilot').decodeSessionText([frame]), 'x');
  assert.notEqual(defaultEngineFactory('codex').decodeSessionText([frame]), 'x');
  assert.notEqual(defaultEngineFactory('claude-code').decodeSessionText([frame]), 'x');
});
