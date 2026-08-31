/**
 * Entry point of `cartografo-mcp`: resolve where the control plane is, resolve
 * what credential to present, and hand the two to {@link serve}.
 *
 * All of the configuration is read from the ENVIRONMENT, and the credential
 * only from there. An MCP client starts this process from a configuration file
 * (`.mcp.json` and its equivalents) that lives in a repository and is read by
 * whoever opens it; a `--token` flag would put the operator's credential in
 * that file and in the process table of the machine, and the token this one
 * carries opens every `/v1/*` route. So the address takes a flag, because an
 * address is not a secret, and the credential takes none.
 *
 * Precedence mirrors the screen's, deliberately (`packages/screen/src/proxy.ts`):
 * `--url` > `CARTOGRAFO_URL` > `http://127.0.0.1:CARTOGRAFO_PORT` > the default
 * port, and `CARTOGRAFO_MCP_TOKEN` > `CARTOGRAFO_TOKEN`. A single-operator setup
 * exports `CARTOGRAFO_TOKEN` once and everything works; whoever later gives this
 * server a credential of its own does it without touching the terminal where
 * the CLI runs.
 *
 * Nothing here writes to stdout. That stream belongs to the protocol.
 */

import { ApiClient } from './client.ts';
import { serve } from './protocol.ts';

/** Where the control plane listens when nobody says otherwise. */
export const DEFAULT_CONTROL_PLANE_HOST = '127.0.0.1';

/** Port the control plane listens on when nobody says otherwise. */
export const DEFAULT_CONTROL_PLANE_PORT = 4317;

/** Environment variable that overrides the control plane's base URL. */
export const CONTROL_PLANE_URL_ENV = 'CARTOGRAFO_URL';

/** Environment variable that moves the control plane's port. */
export const CONTROL_PLANE_PORT_ENV = 'CARTOGRAFO_PORT';

/** This server's own credential, when it has been given one. */
export const MCP_TOKEN_ENV = 'CARTOGRAFO_MCP_TOKEN';

/** The credential the CLI and the runner already share. */
export const SHARED_TOKEN_ENV = 'CARTOGRAFO_TOKEN';

/** What `--help` prints, on stderr, because stdout is the protocol's. */
export const USAGE = [
  'cartografo-mcp — the cartografo as MCP tools, over stdio.',
  '',
  'Usage: cartografo-mcp [--url http://127.0.0.1:4317]',
  '',
  'It speaks JSON-RPC on stdin/stdout and is meant to be STARTED BY an MCP',
  'client, not run by hand. Configuration comes from the environment:',
  '',
  `  ${CONTROL_PLANE_URL_ENV}         control plane to drive (or --url)`,
  `  ${CONTROL_PLANE_PORT_ENV}        its port, when the URL is left at the default host`,
  `  ${MCP_TOKEN_ENV}   credential for this server, checked first`,
  `  ${SHARED_TOKEN_ENV}       the shared credential, used when the one above is unset`,
  '',
  'The credential is deliberately not a flag: an MCP client starts this command',
  'from a configuration file, and a token written there is a token published.',
].join('\n');

/**
 * Reads `--url <address>` from the arguments.
 *
 * @param args Arguments after the command name.
 * @returns The address asked for, or `undefined`.
 */
export function urlFromArgs(args: string[]): string | undefined {
  const inline = args.find((argument) => argument.startsWith('--url='));
  if (inline !== undefined) return inline.slice('--url='.length);

  const index = args.indexOf('--url');
  if (index === -1) return undefined;

  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) throw new Error('--url needs an address');
  return value;
}

/**
 * Resolves the control plane's address.
 *
 * The message names the SOURCE of a bad value: "CARTOGRAFO_URL invalid" for
 * something typed after `--url` sends whoever reads it to the wrong file.
 *
 * @param env Environment to read from.
 * @param override Address given on the command line, when there was one. Blank
 *   counts as absent.
 * @returns Base URL with no trailing slash.
 */
export function resolveControlPlaneUrl(
  env: NodeJS.ProcessEnv = process.env,
  override?: string,
): string {
  const explicit = override?.trim();
  const configured = env[CONTROL_PLANE_URL_ENV]?.trim();

  const [source, chosen] =
    explicit !== undefined && explicit !== ''
      ? ['--url', explicit]
      : configured !== undefined && configured !== ''
        ? [CONTROL_PLANE_URL_ENV, configured]
        : [
            CONTROL_PLANE_URL_ENV,
            `http://${DEFAULT_CONTROL_PLANE_HOST}:${portFromEnv(env)}`,
          ];

  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new Error(`${source} invalid: "${chosen}" (expected something like http://127.0.0.1:4317)`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${source} has to be http or https: "${chosen}"`);
  }

  return chosen.replace(/\/+$/, '');
}

/** The control plane's port, from the environment, or the default. */
function portFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env[CONTROL_PLANE_PORT_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_CONTROL_PLANE_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${CONTROL_PLANE_PORT_ENV} invalid: "${raw}" (expected a port number)`);
  }
  return port;
}

/**
 * Resolves the credential this server presents.
 *
 * @param env Environment to read from.
 * @returns The token, or `undefined` when there is none — in which case every
 *   `/v1/*` call comes back refused, and `describeFailure` says so with the
 *   variable to set.
 */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const own = env[MCP_TOKEN_ENV]?.trim();
  if (own !== undefined && own !== '') return own;

  const shared = env[SHARED_TOKEN_ENV]?.trim();
  return shared === undefined || shared === '' ? undefined : shared;
}

/**
 * Keeps the process alive through an unhandled rejection, on stderr.
 *
 * A stdio server that dies mid-session takes the client's whole connection with
 * it, and Node's default for an unhandled rejection is to die. Same reasoning as
 * the screen's crash guard; the difference is only where the line goes.
 *
 * @returns A function that removes the listener again.
 */
export function installCrashGuard(): () => void {
  const onRejection = (reason: unknown): void => {
    console.error(
      `cartografo-mcp: unhandled rejection — ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
    );
  };
  process.on('unhandledRejection', onRejection);
  return () => process.off('unhandledRejection', onRejection);
}

/**
 * Entry point of the `cartografo-mcp` command.
 *
 * @param args Arguments after the command name.
 * @param env Environment to read the configuration from.
 */
export async function runMcpCli(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.error(USAGE);
    return;
  }

  installCrashGuard();

  const client = new ApiClient({
    baseUrl: resolveControlPlaneUrl(env, urlFromArgs(args)),
    token: resolveToken(env),
  });

  // On stderr, once, so whoever is reading the client's server log can see
  // which control plane this process was pointed at. The credential is not in
  // it, and never will be.
  console.error(`cartografo-mcp: serving ${client.baseUrl}`);

  await serve({ client });
}
