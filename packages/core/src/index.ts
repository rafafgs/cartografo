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
import { acquireLock } from './db/lock.ts';
import { migrate } from './db/migrate.ts';
import { hasLiveCredential, issueCredential } from './repositories/credentials.ts';
import { DEFAULT_LEASE_CAP_PROJECT, DEFAULT_LEASE_CAP_RUNNER } from './routes/leases.ts';
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

/** Environment variable that overrides the per-runner lease ceiling (t157, FR1). */
export const ENV_LEASE_CAP_RUNNER = 'CARTOGRAFO_LEASE_CAP_RUNNER';

/** Environment variable that overrides the per-project lease ceiling (t157, FR1). */
export const ENV_LEASE_CAP_PROJECT = 'CARTOGRAFO_LEASE_CAP_PROJECT';

/** Environment variable that overrides the log level (t197, FR1). */
export const ENV_LOG_LEVEL = 'CARTOGRAFO_LOG_LEVEL';

/**
 * Level the control plane logs at when nobody says otherwise.
 *
 * `info` and not `false`: a production control plane that logs nothing is one
 * whose dispatchers already call `app.log.error` on a failed tick
 * (`util/polling-dispatcher.ts`) into a void, and whose 500s leave no trace at
 * all. Tests stay silent by another route — they omit `logger` entirely, and
 * `createApp`'s own default is still off.
 */
export const DEFAULT_LOG_LEVEL = 'info';

/**
 * The levels pino names, plus the one that means "none of them".
 *
 * A closed list because the failure of an open one is silent: pino takes an
 * unknown level as a custom one and then never emits anything at it, so
 * `CARTOGRAFO_LOG_LEVEL=verbose` would produce a control plane that looks
 * configured and logs nothing.
 */
export const LOG_LEVELS: readonly string[] = Object.freeze([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
]);

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
 * Resolves a positive-integer setting out of the environment (t157, FR1).
 *
 * Same shape as `serverPort`, including where it fails: a value that is not a
 * positive integer stops the startup instead of quietly becoming a default. A
 * ceiling nobody chose is worse than no server — the operator who typed
 * `CARTOGRAFO_LEASE_CAP_RUNNER=oito` would go on believing the number in the
 * environment is the one being enforced.
 *
 * @param env Environment to read from.
 * @param variable Name of the variable, used in the error message.
 * @param fallback Value when the variable is unset or blank.
 * @returns The configured ceiling, or the default.
 */
function leaseCap(env: NodeJS.ProcessEnv, variable: string, fallback: number): number {
  const configured = env[variable]?.trim();
  if (configured === undefined || configured === '') return fallback;

  const cap = Number(configured);
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`invalid ${variable}: "${configured}" (expected an integer >= 1)`);
  }
  return cap;
}

/**
 * Resolves the per-runner lease ceiling (t157, FR1).
 *
 * @param env Environment to read `CARTOGRAFO_LEASE_CAP_RUNNER` from.
 * @returns The ceiling the server enforces per runner.
 */
export function leaseCapRunner(env: NodeJS.ProcessEnv = process.env): number {
  return leaseCap(env, ENV_LEASE_CAP_RUNNER, DEFAULT_LEASE_CAP_RUNNER);
}

/**
 * Resolves the per-project lease ceiling (t157, FR1).
 *
 * @param env Environment to read `CARTOGRAFO_LEASE_CAP_PROJECT` from.
 * @returns The ceiling the server enforces per project.
 */
export function leaseCapProject(env: NodeJS.ProcessEnv = process.env): number {
  return leaseCap(env, ENV_LEASE_CAP_PROJECT, DEFAULT_LEASE_CAP_PROJECT);
}

/**
 * Resolves the level the control plane logs at (t197, FR1).
 *
 * Same shape as `serverPort` and `leaseCap`, failure included: unset or blank
 * keeps the default, a level pino knows comes through as it is, and anything
 * else stops the startup naming the variable and the value. Falling back to
 * `info` on a typo would be the worst of the three outcomes — the operator who
 * asked for `debug` to chase a bug would get `info` and no sign that the
 * request was ignored.
 *
 * @param env Environment to read `CARTOGRAFO_LOG_LEVEL` from.
 * @returns One of {@link LOG_LEVELS}.
 */
export function logLevel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ENV_LOG_LEVEL]?.trim();
  if (configured === undefined || configured === '') return DEFAULT_LOG_LEVEL;

  if (!LOG_LEVELS.includes(configured)) {
    throw new Error(
      `invalid ${ENV_LOG_LEVEL}: "${configured}" (expected one of ${LOG_LEVELS.join(', ')})`,
    );
  }
  return configured;
}

/**
 * Brings the whole control plane up.
 *
 * @param env Environment to read the configuration from.
 * @returns The control plane running, with what is needed to shut it down.
 */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<ControlPlane> {
  const file = databasePath(env);

  // BEFORE the database is even opened, and that ordering is the requirement
  // (t209, FR3): a second control plane over the same file has to find out that
  // it is second while it still has not migrated anything nor minted anything.
  // Below this line, everything that follows assumes one single writer — the
  // `hasLiveCredential`/`issueCredential` pair further down is a plain
  // check-then-act, and two startups reaching it together would each announce
  // their own token as if it were the only one (D1).
  const lock = acquireLock(file);

  const db = openDatabase(file);

  const host = serverHost(env);

  let app: FastifyInstance;
  let migrationsApplied: string[];
  try {
    applyPragmas(db);
    migrationsApplied = migrate(db, MIGRATIONS_DIR);
    // Inside the `try`, like `serverPort`: a misconfigured ceiling — or a
    // misconfigured level — stops the startup, and the handle opened above is
    // closed on the way out.
    app = createApp({
      db,
      // This is the ONE caller that turns logging on (t197, FR2). Every test
      // omits the option and keeps `createApp`'s silent default, so a suite
      // does not have to opt out of the production configuration.
      logger: { level: logLevel(env) },
      leaseCeilings: { runner: leaseCapRunner(env), projeto: leaseCapProject(env) },
    });
    await app.listen({ port: serverPort(env), host });
  } catch (error) {
    db.close();
    lock.release();
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
    bootstrapToken = hasLiveCredential(db, 'user')
      ? null
      : issueCredential(db, { type: 'user' }).token;
  } catch (error) {
    await app.close();
    db.close();
    lock.release();
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
      // Last, and after the handle is closed: while the database can still be
      // written the lock has not stopped being true.
      lock.release();
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
