/**
 * Makes the published package able to read its own TypeScript (t248, D23).
 *
 * ## Why this file has to exist
 *
 * Every command in this repository is a `.mjs` shell that imports a `.ts`
 * entry point, so that whoever types `cartografo` needs no Node flag and no
 * build step. Inside the monorepo Node's own type stripping covers that for
 * free: the workspace packages live under `packages/`, and the `node_modules`
 * entries pointing at them are symlinks that resolve straight back out again.
 *
 * A PUBLISHED package has no such luck. Node refuses to strip types from any
 * file under a `node_modules` directory — `node --help` says so in as many
 * words, and the failure is `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — and
 * `npm install` puts everything it installs under exactly that directory. So
 * the six commands worked perfectly from a checkout and died on their first
 * import for anyone who installed the tarball, which is the whole of what D23
 * is trying to stop being true.
 *
 * The floor of `>=22.18.0` in `engines` is therefore necessary and NOT
 * sufficient: it buys native stripping for development, and nothing at all for
 * the artifact that ships.
 *
 * ## Why amaro, and not tsx
 *
 * `amaro` is the very stripper Node vendors to implement the native behaviour,
 * published as an ordinary package — so the tarball is stripped by the same
 * code that would have stripped it natively, and `strip-only` keeps the rule
 * that only erasable syntax is allowed (which is why `UnknownSessionError` in
 * `packages/runner/src/engine/types.ts` no longer uses a parameter property).
 *
 * It replaces `tsx`, which this repository carried for the same job until t248,
 * for two measured reasons: `tsx` pulls `fsevents`, a native optional
 * dependency whose `node-gyp` build fails outright on macOS with a current Node,
 * taking the whole `npm install -g cartografo` down with it; and it is an order
 * of magnitude larger, since it carries esbuild. `amaro` has no dependencies at
 * all and nothing to compile.
 *
 * ## Why only `packages/core/bin` imports it
 *
 * A loader hook is process-wide, and these six shells are the only entry points
 * the published package has: each sibling's own `bin/*.mjs` is reached THROUGH
 * one of them, by which time the hook is already installed. Run directly out of
 * the checkout — which is what `packages/runner/test/bin.e2e.test.ts` does, and
 * what every package's `npm start` does — those same files are not under
 * `node_modules` and Node strips them natively. Neither path needs a preamble of
 * its own, and neither knows this file exists.
 *
 * Importing this module is the whole of its API; it registers on load.
 */

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import { transformSync } from 'amaro';

/**
 * Strips types from `.ts` files that Node itself would have refused.
 *
 * Synchronous (`registerHooks`, not `register`) so it runs in this very thread
 * and is in force for the `await import(...)` on the next line of whichever
 * command loaded it — an off-thread loader would race that import.
 *
 * Everything that is not a local `.ts` file is handed straight on: `.mjs`,
 * `.js`, JSON, `node:` builtins and anything a dependency loads all keep Node's
 * own behaviour, so this hook can only ever add the one case it exists for.
 */
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);

    const source = readFileSync(fileURLToPath(url), 'utf8');
    // `strip-only` blanks types out in place instead of rewriting them, so line
    // and column numbers survive into stack traces — the same trade Node makes
    // natively, and the reason a crash in the published package still points at
    // a real line of the `.ts` file it came from.
    const { code } = transformSync(source, { mode: 'strip-only' });

    return { format: 'module', source: code, shortCircuit: true };
  },
});
