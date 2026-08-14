#!/usr/bin/env node
/**
 * The screen's command: `cartografo-tela`.
 *
 * A thin shell, in the same mould as `packages/core/bin/cartografo.mjs`: the
 * executable is `.mjs` (and not `.ts`) so it depends on no Node flag at all —
 * it registers the tsx loader in process and only then imports `src/router.ts`.
 * In process, and not through `spawn`, so that the process the supervisor sees
 * is the same one listening on the port.
 *
 * Its OWN command, rather than a subcommand of `cartografo`, because the screen
 * is another process, on another port, with no privilege over the control plane
 * (D11): two binaries is what that boundary looks like from the outside.
 *
 * Usage: `npx cartografo-tela [--url http://127.0.0.1:4317]`.
 * Configuration: `CARTOGRAFO_TELA_PORT` (the screen's port, default 4318),
 * `CARTOGRAFO_URL` (control plane, default `http://127.0.0.1:4317`).
 */

import { register } from 'tsx/esm/api';

register();

const { runScreenCli } = await import(new URL('../src/router.ts', import.meta.url).href);

try {
  await runScreenCli(process.argv.slice(2));
} catch (error) {
  console.error('cartografo-tela: could not start the screen');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
