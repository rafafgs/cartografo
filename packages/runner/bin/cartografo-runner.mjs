#!/usr/bin/env node
/**
 * The runner's command: `cartografo-runner`.
 *
 * A thin shell, in the same mould as `packages/core/bin/cartografo.mjs` and
 * `packages/screen/bin/screen.mjs`: the executable is `.mjs` (and not `.ts`) so it
 * depends on no Node flag at all — it imports `src/cli/index.ts` and Node
 * strips the types itself. That is the whole of gap #5 of the first dogfood
 * (`notes/2026-08-15-first-execution.md:54-56`), which used to make every
 * consumer pass a loader flag: the one parameter property that broke Node's
 * strip-only mode is gone since t248, so this file needs no loader at all.
 *
 * Reached through the published `cartografo` package instead, the hook that
 * `packages/core/bin/register-typescript.mjs` installs is already in force —
 * Node will not strip types under `node_modules`, and an installed package is
 * nothing but. Neither path is this file's business.
 *
 * In process, and not through `spawn`, so that the process the supervisor sees
 * is the same one holding the leases — a signal sent to the command reaches
 * whoever has to give them back.
 *
 * Only the dispatch lives here: the router returns the exit code and this file
 * records it in `process.exitCode` instead of calling `process.exit`. The
 * difference is not cosmetic — a stop waits for the session in flight to
 * settle, and an `exit` would kill it at exactly the moment it was finishing.
 *
 * Usage: `npx cartografo-runner --url <url> --token <token>`.
 * Configuration: `CARTOGRAFO_URL`, `CARTOGRAFO_TOKEN`.
 */

const { runRunnerCli } = await import(new URL('../src/cli/index.ts', import.meta.url).href);

try {
  process.exitCode = await runRunnerCli(process.argv.slice(2));
} catch (error) {
  console.error('cartografo-runner: failed to run the command');
  console.error(error);
  process.exitCode = 1;
}
