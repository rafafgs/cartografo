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
import { registerEvents } from './routes/events.ts';
import { registerExecutions } from './routes/executions.ts';
import { registerGraphs } from './routes/graphs.ts';
import { registerHealth } from './routes/health.ts';
import { registerIntake } from './routes/intake.ts';
import { registerLeases, type LeaseCeilings } from './routes/leases.ts';
import { registerInputRequests } from './routes/input-requests.ts';
import { registerProposals } from './routes/proposals.ts';
import { registerRunners } from './routes/runners.ts';
import { registerSessions } from './routes/sessions.ts';
import { registerSkills } from './routes/skills.ts';
import { registerJobs } from './routes/jobs.ts';
import { registerWebhooks } from './routes/webhooks.ts';
import { registerWebhookDispatcher } from './webhooks/dispatcher.ts';

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
  /**
   * Ceilings of simultaneous active leases this process enforces (t157, FR1).
   *
   * Resolved from the environment by `start()`; omitted here, the lease routes
   * fall back to their own `DEFAULT_LEASE_CAP_*`. It is configuration of the
   * control plane, never of the request.
   */
  leaseCeilings?: LeaseCeilings;
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
  // this file instead of a habit each route file has to keep. The stream (t123)
  // is a route family like any other, so it is gated like any other.
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
      scope.register(async (inner) =>
        registerLeases(inner, options.db, { leaseCeilings: options.leaseCeilings }),
      );
      scope.register(async (inner) => registerIntake(inner, options.db));
      scope.register(async (inner) => registerSkills(inner, options.db));
      scope.register(async (inner) => registerEvents(inner, options.db));
      scope.register(async (inner) => registerWebhooks(inner, options.db));
    },
    { prefix: API_PREFIX },
  );

  // The dispatcher is not a route family: it is a background tick, and its
  // `onReady`/`onClose` hooks go on the whole app — outside the versioned scope,
  // so they fire exactly once — for the same reason `registerHealth` does.
  registerWebhookDispatcher(app, options.db);

  return app;
}
