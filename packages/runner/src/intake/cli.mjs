#!/usr/bin/env node
/**
 * `intake` — a request in plain language becomes a draft breakdown (t144, FR5/FR7).
 *
 * A command a person types, like the surveyor's and the synthesizer's, and for
 * the same reason: nothing in the graph runs this, and wiring it into the
 * dispatch loop is a decision, not a refactor (README, principle 5).
 *
 * What it does: refuses an unregistered class before spending anything, opens
 * ONE agent session to decompose the request, and posts the result as a draft.
 * The draft lands `pendente`. No ticket exists until a human confirms it, and
 * confirming is a route this command does not call and this client does not have.
 *
 * Exit codes are the contract, because this is what a person (or a script) reads:
 *
 * - `0` — a draft was proposed; its id is printed;
 * - `1` — it ran and could not finish: the class is not registered, the session
 *   failed, what it wrote was unusable, or the control plane refused the write.
 *   Nothing was posted;
 * - `2` — the command was typed wrong. Nothing ran.
 *
 * This file is wiring and nothing else: argv, the environment, the credential
 * and the messages live in `command-line.ts`, and the flow lives in
 * `generate.ts`, where a test reaches both without spawning a process. What
 * stays here is what genuinely needs a process — the engine, the scratch
 * directory, stdout and the exit code.
 *
 * Usage:
 *   npm run intake --workspace @cartografo/runner -- \
 *     "<request>" --classe <name> [--url <url>] [--dir <path>] [--token <token>]
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import {
  HELP,
  USAGE_EXIT_CODE,
  createClient,
  createReader,
  deniedMessage,
  isDenied,
  parseArguments,
} from './command-line.ts';
import { IntakeError, generateIntakeDraft } from './generate.ts';

/**
 * The engine, probed the first time a session is actually opened.
 *
 * Lazily and not up front, which is the whole point: the class check refuses
 * before any session, and probing the engine ahead of it would make a typo in
 * `--classe` depend on having the CLI installed. The probe still happens before
 * the only session there is, so the message a missing binary gets is the one that
 * says what to do about it.
 */
function probedEngine() {
  const engine = new ClaudeCodeAdapter();
  return {
    engineName: engine.engineName,
    async startSession(spec, listener) {
      const probe = await engine.verifyCli();
      if (!probe.available) {
        throw new Error(
          'the `claude` CLI did not answer --version — install it before generating a draft',
        );
      }
      return await engine.startSession(spec, listener);
    },
    async getStatus(sessionId) {
      return await engine.getStatus(sessionId);
    },
    async cancel(sessionId, status) {
      await engine.cancel(sessionId, status);
    },
    capabilities() {
      return engine.capabilities();
    },
    async verifyCli() {
      return await engine.verifyCli();
    },
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.kind === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (parsed.kind === 'usage') {
    process.stderr.write(`intake: ${parsed.message}\n`);
    process.stderr.write('intake: run `--help` for the whole flow.\n');
    return USAGE_EXIT_CODE;
  }

  const { url } = parsed.options;
  const workingDir = parsed.options.workingDir ?? mkdtempSync(join(tmpdir(), 'cartografo-intake-'));

  let draft;
  try {
    draft = await generateIntakeDraft({
      reader: createReader(parsed.options),
      client: createClient(parsed.options),
      adapter: probedEngine(),
      request: parsed.options.request,
      className: parsed.options.className,
      workingDir,
      log: (message) => process.stdout.write(`intake: ${message}\n`),
    });
  } catch (error) {
    // A 401 is never a domain answer here: no route this command calls means
    // anything by it, and the person reading the failure has exactly one thing
    // to do about it.
    if (isDenied(error)) {
      process.stderr.write(`intake: ${deniedMessage(url)}\n`);
      return 1;
    }
    if (error instanceof IntakeError) {
      process.stderr.write(`intake: ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`  - ${detail}\n`);
      return 1;
    }
    throw error;
  }

  process.stdout.write(`${draft.id}\n`);
  process.stdout.write(
    `intake: draft ${draft.id} is "${draft.status}" with ${draft.itens.length} item(s) over ${draft.classe}\n`,
  );
  process.stdout.write(
    `intake: review it, then confirm by hand — POST /v1/intake/${draft.id}/confirmations. ` +
      'No ticket exists until you do.\n',
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`intake: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
