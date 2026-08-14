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
import { hasLiveCredential, issueCredential } from './repositories/credentials.ts';
import { createApp } from './server.ts';

/** Default port of the control plane. */
export const DEFAULT_PORT = 4317;

/** Environment variable that overrides the default port. */
export const ENV_PORT = 'CARTOGRAFO_PORT';

/**
 * Default listening address: loopback, as it always was.
 *
 * It stopped being the ONLY possible address in t124 — every `/v1` route now
 * demands a credential, which is what makes exposing an external interface a
 * configuration decision instead of a hole. The default did not move: a tool
 * that starts listening on the network because someone typed `npx cartografo`
 * would be deciding for its user.
 */
export const DEFAULT_HOST = '127.0.0.1';

/** Environment variable that overrides the listening address. */
export const ENV_HOST = 'CARTOGRAFO_HOST';

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
  /**
   * The operator credential, when THIS startup is the one that minted it, and
   * `null` on every startup against a database that already had one (FR4).
   *
   * It is the single path in the whole system by which a raw user token ever
   * becomes visible: the table keeps only its digest, so a startup that does not
   * print it has nothing left to print.
   */
  bootstrapToken: string | null;
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
 * Resolves the listening address (FR5).
 *
 * Same shape as `serverPort`: unset or blank keeps the default, and what comes
 * in goes to `listen` as it is — the operating system is what decides whether an
 * address is bindable, and reimplementing that judgement here would only produce
 * a second, worse, error message.
 *
 * @param env Environment to read `CARTOGRAFO_HOST` from.
 * @returns Address to bind.
 */
export function serverHost(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ENV_HOST]?.trim();
  return configured === undefined || configured === '' ? DEFAULT_HOST : configured;
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

  const host = serverHost(env);

  let app: FastifyInstance;
  let migrationsApplied: string[];
  try {
    applyPragmas(db);
    migrationsApplied = migrate(db, MIGRATIONS_DIR);
    app = createApp({ db });
    await app.listen({ port: serverPort(env), host });
  } catch (error) {
    db.close();
    throw error;
  }

  // AFTER `listen`, and the order is the whole point: a credential is minted
  // once and printed once, so a startup that mints one and then dies before
  // announcing it leaves a token nobody can ever use — and, worse, leaves the
  // NEXT startup announcing `null`, with no way back short of deleting the
  // database. The common way to die right there is the port being busy, which
  // is exactly what happens to whoever left another control plane running.
  //
  // Minting late opens no window: until the credential exists the gate denies
  // every request, because there is nothing for a token to resolve to.
  let bootstrapToken: string | null;
  try {
    bootstrapToken = hasLiveCredential(db, 'usuario')
      ? null
      : issueCredential(db, { tipo: 'usuario' }).token;
  } catch (error) {
    await app.close();
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
    url: `http://${host}:${port}`,
    bootstrapToken,
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
 *
 * On the first startup against a new database the line also carries the
 * operator credential, in the clear and exactly once (FR4). Printing a secret is
 * a deliberate choice, and the alternatives are worse: a login flow is a whole
 * product this project does not have, and a secret provisioned by config file is
 * one more thing to lose. It is the same shape k3s and Grafana use on first run.
 */
export async function main(): Promise<void> {
  const controlPlane = await start();

  process.stdout.write(
    `${JSON.stringify({
      event: READY_EVENT,
      database: controlPlane.databasePath,
      migrationsApplied: controlPlane.migrationsApplied.length,
      url: controlPlane.url,
      bootstrapToken: controlPlane.bootstrapToken,
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
