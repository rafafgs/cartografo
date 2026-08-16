#!/usr/bin/env node
/**
 * The cost lens's command: `topografo-custo`.
 *
 * A thin shell, in the same mould as `packages/runner/bin/cartografo-runner.mjs`
 * and `packages/tela/bin/tela.mjs`: the executable is `.mjs` (and not `.ts`) so
 * it depends on no Node flag at all — it registers the tsx loader in process and
 * only then imports `src/cli.ts`. Whoever runs `npx topografo-custo` does not
 * have to know that tsx exists, which is exactly what was missing while the only
 * path was `node --import tsx src/cli.ts avaliar …`.
 *
 * The command's name is the one the package's own usage text has documented
 * since t180 (`src/cli.ts`): `topografo-custo avaliar …`. Naming it anything
 * else here would be a second instance of the very mismatch t199 exists to
 * close.
 *
 * Only the dispatch lives here: `runCli` returns the exit code and this file
 * records it in `process.exitCode` instead of calling `process.exit` — the same
 * choice as the other two bins, so that output in flight finishes being written
 * before the process ends.
 *
 * Usage: `npx topografo-custo avaliar --url <url> --execucao <id> [options]`.
 * Configuration: `CARTOGRAFO_TOKEN` (control plane credential).
 */

import { register } from 'tsx/esm/api';

register();

const { runCli } = await import(new URL('../src/cli.ts', import.meta.url).href);

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error('topografo-custo: failed to run the command');
  console.error(error);
  process.exitCode = 1;
}
