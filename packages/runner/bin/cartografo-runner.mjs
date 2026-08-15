#!/usr/bin/env node
/**
 * The runner's command: `cartografo-runner`.
 *
 * A thin shell, in the same mould as `packages/core/bin/cartografo.mjs` and
 * `packages/tela/bin/tela.mjs`: the executable is `.mjs` (and not `.ts`) so it
 * depends on no Node flag at all — it registers the tsx loader in process and
 * only then imports `src/cli/index.ts`. That is the whole of gap #5 of the
 * first dogfood (`notas/2026-08-15-primeira-execucao.md:53-55`): parameter
 * properties in this package's TypeScript break Node's strip-only mode, so
 * every consumer used to have to know to pass `--import tsx`. Whoever runs
 * `npx cartografo-runner` now knows nothing about tsx.
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

import { register } from 'tsx/esm/api';

register();

const { runRunnerCli } = await import(new URL('../src/cli/index.ts', import.meta.url).href);

try {
  process.exitCode = await runRunnerCli(process.argv.slice(2));
} catch (error) {
  console.error('cartografo-runner: failed to run the command');
  console.error(error);
  process.exitCode = 1;
}
