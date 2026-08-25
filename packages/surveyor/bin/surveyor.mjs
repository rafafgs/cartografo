#!/usr/bin/env node
/**
 * The watcher's command: `cartografo-surveyor`.
 *
 * A thin shell, in the same mould as `packages/cost-surveyor/bin/cost-surveyor.mjs`
 * and `packages/runner/bin/cartografo-runner.mjs`: the executable is `.mjs` (and
 * not `.ts`) so it depends on no Node flag at all — it registers the tsx loader
 * in process and only then imports `src/cli.ts`. Whoever runs
 * `npx cartografo-surveyor` does not have to know that tsx exists.
 *
 * Two things live here and nowhere else, because both genuinely need a process:
 *
 * - **the stop.** `SIGTERM` and `SIGINT` tear the stream connection down and
 *   end the process. There is no drain: a lens already in flight may be cut off
 *   mid-session, and that is safe not because this command is careful but
 *   because t246's deduplication makes the retry non-duplicating. Reproducing
 *   the runner's grace protocol here would be a ticket of its own.
 * - **the exit code.** `runCli` returns it and this file records it in
 *   `process.exitCode` rather than calling `process.exit`, so output in flight
 *   finishes being written — the same choice as the other three bins.
 *
 * Usage: `npx cartografo-surveyor watch --url <url> --token <token>`.
 */

import { register } from 'tsx/esm/api';

register();

const { runCli } = await import(new URL('../src/cli.ts', import.meta.url).href);

// The signal is what a stop looks like from the inside: the consumer sees its
// connection abort, the loop ends, and `runCli` returns. The forced exit right
// after is the "no drain" half — a flow-lens session can be minutes long, and
// waiting it out is what a graceful shutdown would do, not what this one does.
const stopping = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping.abort();
    process.exit(0);
  });
}

try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: stopping.signal });
} catch (error) {
  console.error('cartografo-surveyor: failed to run the command');
  console.error(error);
  process.exitCode = 1;
}
