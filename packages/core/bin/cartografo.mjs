#!/usr/bin/env node
/**
 * Single command of the control plane: `cartografo`.
 *
 * The executable is `.mjs` (and not `.ts`) so it depends on no Node flag: it
 * registers the tsx loader in-process and only then imports `src/cli/index.ts`.
 * In-process, and not through `spawn`, so that the process the supervisor sees
 * is the same one listening on the port — a signal sent to the command reaches
 * whoever needs to shut down.
 *
 * Only the dispatch lives here: the router returns the exit code and this file
 * records it in `process.exitCode` instead of calling `process.exit`. The
 * difference matters — `up` returns with the server running, and an `exit` would
 * kill the control plane at the very moment it became ready.
 *
 * Usage: `npm exec cartografo [subcommand]`, `node packages/core/bin/cartografo.mjs`.
 * Configuration: `CARTOGRAFO_DB_PATH`, `CARTOGRAFO_PORT`, `CARTOGRAFO_URL`.
 */

import { register } from 'tsx/esm/api';

register();

const { runCli } = await import(new URL('../src/cli/index.ts', import.meta.url).href);

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error('cartografo: failed to run the command');
  console.error(error);
  process.exitCode = 1;
}
