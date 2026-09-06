#!/usr/bin/env node
/**
 * The `cartografo-mcp` command, as the single published package ships it (t248, D23).
 *
 * A delegator and nothing else. The real command is `packages/mcp/bin/mcp.mjs`,
 * which owns its own dispatch, its exit code and — where it has any — its signal
 * handling; re-implementing any of that here would give the product two copies
 * of one command that drift apart, which is exactly the shape D23 exists
 * against.
 *
 * The import goes through the PACKAGE NAME rather than a relative path, and that
 * is what makes the same line work in both worlds: inside this monorepo
 * `@cartografo/mcp` is a workspace symlink, and inside the published
 * tarball it is a real directory that `bundledDependencies` put under
 * `node_modules/`. Neither case knows about the other.
 *
 * D23 changes the packaging and nothing else: this is still a separate process
 * from the control plane, with no privilege over it (D1, D11). One tarball, six
 * commands, six processes.
 */

// The loader hook first: from inside an installed tarball the sibling's own
// bin cannot import its `.ts` entry point without it.
import './register-typescript.mjs';

await import('@cartografo/mcp/bin/mcp');
