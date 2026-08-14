/**
 * Factory of the control plane's HTTP app.
 *
 * It receives the already-open database instead of opening it: whoever decides
 * the file path and when to migrate is the startup (`src/index.ts`), and that is
 * what lets the tests bring the app up against an arbitrary database — including
 * one corrupted on purpose, to prove `/health` really checks.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import { registerAuth } from './auth.ts';
import type { Database } from './db/connection.ts';
import { registerExecutions } from './routes/executions.ts';
import { registerGraphs } from './routes/graphs.ts';
import { registerHealth } from './routes/health.ts';
import { registerIntake } from './routes/intake.ts';
import { registerLeases } from './routes/leases.ts';
import { registerInputRequests } from './routes/input-requests.ts';
import { registerProposals } from './routes/proposals.ts';
import { registerRunners } from './routes/runners.ts';
import { registerSessions } from './routes/sessions.ts';
import { registerSkills } from './routes/skills.ts';
import { registerJobs } from './routes/jobs.ts';

/**
 * Prefix of the business routes. Every domain route is born inside it;
 * `/health` stays outside, because it is an infrastructure probe (t100, FR10).
 */
export const API_PREFIX = '/v1';

/** Options of the app factory. */
export interface AppOptions {
  /** Already open database; the app never opens its own. */
  db: Database;
  /** Fastify log level. `false` turns it off (the default in silent tests). */
  logger?: boolean;
}

/**
 * Assembles the app with the health route and the versioned scope.
 *
 * @param options Open database and log configuration.
 * @returns A Fastify instance ready to `listen`.
 */
export function createApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  registerHealth(app, options.db);

  // Versioned scope: every business route is born inside it, and so does the
  // credential gate (t124) — ONE `onRequest` hook, before the first route, is
  // what makes "no route under /v1 answers without a credential" a property of
  // this file instead of a habit each route file has to keep.
  //
  // One `register` line per route family — that way two tickets registering
  // routes in parallel touch different lines of this file, and not the same one.
  app.register(
    async (scope) => {
      registerAuth(scope, options.db);

      scope.register(async (inner) => registerGraphs(inner, options.db));
      scope.register(async (inner) => registerProposals(inner, options.db));
      scope.register(async (inner) => registerJobs(inner, options.db));
      scope.register(async (inner) => registerSessions(inner, options.db));
      scope.register(async (inner) => registerInputRequests(inner, options.db));
      scope.register(async (inner) => registerExecutions(inner, options.db));
      scope.register(async (inner) => registerRunners(inner, options.db));
      scope.register(async (inner) => registerLeases(inner, options.db));
      scope.register(async (inner) => registerIntake(inner, options.db));
      scope.register(async (inner) => registerSkills(inner, options.db));
    },
    { prefix: API_PREFIX },
  );

  return app;
}
