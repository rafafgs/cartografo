/**
 * The screen's own HTTP server: static page in front, proxy behind, and — since
 * the observability half landed — server-rendered views alongside them.
 *
 * There is no database here, no import from `packages/core`, and no SQLite
 * driver in this package's manifest: the D11 boundary is the reason this
 * package exists, and `test/no-privileged-access.test.ts` keeps it honest.
 *
 * The routing itself lives in `router.ts`, which is the single handler both
 * halves of the screen share; this module is the process shell around it. It
 * exists separately because `npm start` and the readiness contract were written
 * against this file, and because the configuration is read from the
 * environment here while `router.ts` takes it as an argument.
 *
 * Startup mirrors the control plane's: resolve the configuration, listen, print
 * one JSON readiness line to stdout. A supervisor — or a person with two
 * terminals open — should be able to tell the screen is up, on which port, and
 * against which control plane, from that single line.
 */

import type { Server } from 'node:http';

import { parsePortFromEnv, resolveControlPlaneUrl } from './proxy.ts';
import { createScreenRouter, READY_EVENT } from './router.ts';

export { INDEX_FILE, PUBLIC_DIR, resolveStaticFile } from './static.ts';

/** Environment variable that overrides the screen's port. */
export const SCREEN_PORT_ENV = 'CARTOGRAFO_TELA_PORT';

/** Default screen port — the control plane's 4317, plus one. */
export const DEFAULT_SCREEN_PORT = 4318;

/**
 * Listening address. Loopback, like the control plane: the screen has no
 * authentication (`t124`) and proxies to the only writer in the system, so
 * exposing it on an external interface is a decision for the ticket that brings
 * authorization, not for this one.
 */
export const SCREEN_HOST = '127.0.0.1';

/**
 * Name of the readiness event printed on stdout, next to `cartografo.ready`.
 *
 * Defined in `router.ts` and re-exported here: the screen is one process on one
 * port, so both entry points — `npx cartografo-tela` and this module — have to
 * announce themselves with the same name.
 */
export { READY_EVENT };

/** The screen, up. */
export interface Screen {
  server: Server;
  /** Base URL of the screen itself. */
  url: string;
  /** Port actually bound (relevant when the configured port is `0`). */
  port: number;
  /** Control plane this screen proxies to. */
  controlPlaneUrl: string;
  /** Stops listening. */
  close: () => Promise<void>;
}

/**
 * Resolves the screen's listening port.
 *
 * @param env Environment to read `CARTOGRAFO_TELA_PORT` from.
 * @returns A valid port.
 */
export function resolveScreenPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePortFromEnv(env, SCREEN_PORT_ENV, DEFAULT_SCREEN_PORT);
}

/**
 * Builds the HTTP server without listening.
 *
 * @param controlPlaneUrl Control plane base URL.
 * @returns A server ready to `listen`.
 */
export function createScreenServer(controlPlaneUrl: string): Server {
  return createScreenRouter({ controlPlaneUrl });
}

/**
 * Starts the screen.
 *
 * @param env Environment with `CARTOGRAFO_TELA_PORT` and `CARTOGRAFO_URL`.
 * @returns The screen, up, with what it takes to shut it down.
 */
export async function startScreen(env: NodeJS.ProcessEnv = process.env): Promise<Screen> {
  const controlPlaneUrl = resolveControlPlaneUrl(env);
  const port = resolveScreenPort(env);
  const server = createScreenServer(controlPlaneUrl);

  const bound = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, SCREEN_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`the screen could not listen on ${SCREEN_HOST}:${port}`));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    server,
    url: `http://${SCREEN_HOST}:${bound}`,
    port: bound,
    controlPlaneUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/**
 * Entry point of `npm start --workspace @cartografo/tela`.
 *
 * Prints one JSON readiness line, in the same spirit as `cartografo.ready`:
 * where the screen is, and which control plane it is showing.
 */
export async function main(): Promise<void> {
  const screen = await startScreen();

  process.stdout.write(
    `${JSON.stringify({
      event: READY_EVENT,
      url: screen.url,
      controlPlane: screen.controlPlaneUrl,
    })}\n`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void screen
        .close()
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((cause: unknown) => {
    process.exitCode = 1;
    process.stderr.write(
      `cartografo-tela: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
  });
}
