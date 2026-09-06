#!/usr/bin/env node
/**
 * The MCP server's command: `cartografo-mcp`.
 *
 * A thin shell, in the same mould as `packages/screen/bin/screen.mjs`: the
 * executable is `.mjs` (and not `.ts`) so it depends on no Node flag at all —
 * it imports `src/index.ts` and Node strips the types itself, or, when this is
 * reached through the published package, the hook installed by
 * `packages/core/bin/register-typescript.mjs` already has (t248).
 *
 * In process, and not through `spawn`, so the process the MCP client started IS
 * the process holding the pipe it writes to.
 *
 * Its OWN command, rather than a subcommand of `cartografo`, for the same
 * reason the screen has one (D11): this is another process with no privilege
 * over the control plane, and a separate binary is what that boundary looks
 * like from the outside.
 *
 * **stdout belongs to the protocol.** An MCP client parses this process's
 * stdout as a stream of JSON-RPC messages, so a stray `console.log` anywhere
 * under here corrupts the session. Everything a human is meant to read — the
 * failure below included — goes to stderr.
 *
 * Usage: `npx cartografo-mcp [--url http://127.0.0.1:4317]`.
 * Configuration: `CARTOGRAFO_URL`, `CARTOGRAFO_PORT`, `CARTOGRAFO_MCP_TOKEN`,
 * `CARTOGRAFO_TOKEN`.
 */

const { runMcpCli } = await import(new URL('../src/index.ts', import.meta.url).href);

try {
  await runMcpCli(process.argv.slice(2));
} catch (error) {
  console.error('cartografo-mcp: could not start the MCP server');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
