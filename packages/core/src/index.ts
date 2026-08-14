/**
 * Startup of the control plane, in a single command.
 *
 * The order is fixed and has no manual step: open/create the database → apply
 * the pending migrations → bring HTTP up → print the readiness line. It is the
 * quality non-negotiable recorded in
 * `notas/2026-08-14-extensao-e-qualidade.md` ("one-command start", "automatic
 * migrations").
 */

import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { openDatabase, applyPragmas, databasePath, type Database } from './db/connection.ts';
import { migrate } from './db/migrate.ts';
import { createApp } from './server.ts';

/** Default port of the control plane. */
export const DEFAULT_PORT = 4317;

/** Environment variable that overrides the default port. */
export const ENV_PORT = 'CARTOGRAFO_PORT';

/**
 * Listening address. Fixed on loopback: the control plane owns the database (D1)
 * and has no authentication in this phase — exposing the external interface is
 * the decision of the ticket that brings authorization, not of this one.
 */
export const DEFAULT_HOST = '127.0.0.1';

/** Migrations directory of the package. */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'migrations');

/** Event name of the readiness line printed on stdout. */
export const READY_EVENT = 'cartografo.ready';

/** The control plane, running. */
export interface ControlPlane {
  app: FastifyInstance;
  db: Database;
  /** Absolute path of the database file in use. */
  databasePath: string;
  /** Ids of the migrations applied IN THIS startup (empty when already up to date). */
  migrationsApplied: string[];
  /** Base URL of the server. */
  url: string;
  /** Closes HTTP and the database, in that order. */
  shutdown: () => Promise<void>;
}

/**
 * Resolves the listening port.
 *
 * @param env Environment to read `CARTOGRAFO_PORT` from.
 * @returns A valid port.
 */
export function serverPort(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env[ENV_PORT]?.trim();
  if (configured === undefined || configured === '') return DEFAULT_PORT;

  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid ${ENV_PORT}: "${configured}" (expected an integer from 0 to 65535)`);
  }
  return port;
}

/**
 * Brings the whole control plane up.
 *
 * @param env Environment to read the configuration from.
 * @returns The control plane running, with what is needed to shut it down.
 */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<ControlPlane> {
  const file = databasePath(env);
  const db = openDatabase(file);

  let app: FastifyInstance;
  let migrationsApplied: string[];
  try {
    applyPragmas(db);
    migrationsApplied = migrate(db, MIGRATIONS_DIR);
    app = createApp({ db });
    await app.listen({ port: serverPort(env), host: DEFAULT_HOST });
  } catch (error) {
    db.close();
    throw error;
  }

  const address = app.server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : serverPort(env);

  return {
    app,
    db,
    databasePath: file,
    migrationsApplied,
    url: `http://${DEFAULT_HOST}:${port}`,
    shutdown: async () => {
      await app.close();
      db.close();
    },
  };
}

/**
 * Entry point of the `cartografo` command.
 *
 * Prints a JSON readiness line on stdout — it is what a supervisor (or the
 * startup acceptance test) uses to know the server is up and how many migrations
 * this startup applied.
 */
export async function main(): Promise<void> {
  const controlPlane = await start();

  process.stdout.write(
    `${JSON.stringify({
      event: READY_EVENT,
      database: controlPlane.databasePath,
      migrationsApplied: controlPlane.migrationsApplied.length,
      url: controlPlane.url,
    })}\n`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void controlPlane
        .shutdown()
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}
