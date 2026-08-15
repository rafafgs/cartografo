#!/usr/bin/env node
/**
 * `synthesize` — the copilot synthesizer, invoked by hand (t115, FR1/FR9).
 *
 * A command a person types, like the surveyor's (`src/surveyor/cli.mjs`) and
 * for the same reason: D10 makes the synthesizer a copilot in the MVP, and a
 * copilot nobody asked for is just an autopilot. Nothing in the graph runs this,
 * and wiring it into anything is a decision, not a refactor.
 *
 * This file is wiring and nothing else — argument parsing, the whole flow and
 * every decision live in `synthesize.ts`, where they are reachable by a test
 * that does not have to spawn a process. What is here is what genuinely needs a
 * process: the engine, the scratch directory, stdout and the exit code.
 *
 * Exit codes are the contract, because this is what a person reads:
 *
 * - `0` — a draft was written; its path is the first line of stdout;
 * - `1` — it ran and could not finish (class already registered, session
 *   failed, no usable block). Nothing was written;
 * - `2` — the command was typed wrong. Nothing ran.
 *
 * Usage:
 *   npm run synthesize --workspace @cartografo/runner -- \
 *     `"<declaração>" --classe <nome> [--url <url>] [--saida <caminho>]` \
 *     `[--timeout <seg>] [--token <token>]`
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCodeAdapter } from '../engine/claude-code-adapter.ts';
import { createControlPlaneReader } from './control-plane-client.ts';
import { HELP, USAGE_EXIT_CODE, parseArguments, runSynthesis } from './synthesize.ts';

async function main() {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.kind === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (parsed.kind === 'usage') {
    process.stderr.write(`synthesize: ${parsed.message}\n`);
    process.stderr.write('synthesize: run `--help` for the whole flow.\n');
    return USAGE_EXIT_CODE;
  }

  const adapter = new ClaudeCodeAdapter();
  const probe = await adapter.verifyCli();
  if (!probe.available) {
    process.stderr.write(
      'synthesize: the `claude` CLI did not answer --version — install it before synthesizing\n',
    );
    return 1;
  }

  // A scratch directory the session runs in. Nothing is written there by us:
  // the answer comes back through the session's own output, and the draft goes
  // where the person is working, not into a temporary folder they will not find.
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-synthesize-'));

  return await runSynthesis({
    declaration: parsed.options.declaration,
    className: parsed.options.className,
    client: createControlPlaneReader(parsed.options.url, { token: parsed.options.token }),
    adapter,
    workingDir,
    outputPath: parsed.options.outputPath,
    timeoutSeconds: parsed.options.timeoutSeconds,
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`synthesize: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
