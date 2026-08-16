/**
 * Factory of the control plane's HTTP app.
 *
 * It receives the already-open database instead of opening it: whoever decides
 * the file path and when to migrate is the startup (`src/index.ts`), and that is
 * what lets the tests bring the app up against an arbitrary database — including
 * one corrupted on purpose, to prove `/health` really checks.
 */

import { readFileSync } from 'node:fs';

import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerAuth } from './auth.ts';
import type { Database } from './db/connection.ts';
import { registerEngines } from './routes/engines.ts';
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
import { registerHookDispatcher } from './hooks/dispatcher.ts';
import { registerWebhookDispatcher } from './webhooks/dispatcher.ts';

/**
 * Prefix of the business routes. Every domain route is born inside it;
 * `/health` stays outside, because it is an infrastructure probe (t100, FR10).
 */
export const API_PREFIX = '/v1';

/** Title the public document carries; it is the API's name to a third party. */
export const OPENAPI_TITLE = 'cartografo control plane API';

/**
 * Version the document publishes, read from this package's own manifest (t171,
 * FR1).
 *
 * Read, and not written down a second time: a hardcoded version drifts the
 * moment somebody bumps the package, and a document that lies about which
 * control plane it describes is worse than no document. `package.json` travels
 * in every tarball regardless of the `files` list, so this resolves the same way
 * installed as it does in the repository.
 */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

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

  // The public contract of the API (t171), and D11's missing artifact: until it
  // existed, the only way to know the shape of `/v1` was to read the route
  // files. It is GENERATED and not written — `@fastify/swagger` listens on
  // `onRoute`, so a route family added below cannot fail to appear in it, which
  // is what makes "the document diverging from the code" a state the app cannot
  // reach instead of a rule somebody has to keep.
  //
  // Both endpoints sit OUTSIDE the versioned scope, next to `/health` and
  // unauthenticated for the same reason it is (`routes/health.ts`): a schema and
  // a static page are not data, so the single-writer/credential boundary (D1,
  // t124) has nothing to guard here.
  //
  // The plugin has to come BEFORE the versioned scope, and that order is
  // load-bearing: `onRoute` fires as each route is DECLARED, so a hook installed
  // afterwards sees nothing that already exists.
  //
  // The same rule is what keeps `/openapi.json` and `/health` out of the
  // document, with no `schema.hide` anywhere: both are declared straight on this
  // instance, which runs their `onRoute` hooks synchronously, while `register`
  // is lazy and only loads the plugin when the app is readied. Their absence is
  // not an oversight — `servers` below says every documented path hangs off
  // `/v1`, and neither of those two does, so documenting them would publish an
  // address no client can call.
  app.get('/openapi.json', async () => app.swagger());

  app.register(fastifySwagger, {
    openapi: {
      info: { title: OPENAPI_TITLE, version: PACKAGE_VERSION },
      // The declared server IS the existing prefix, so `servers` + path is the
      // address a client really calls, and the documented paths stay free of a
      // version somebody would otherwise have to strip by hand.
      servers: [{ url: API_PREFIX }],
    },
  });

  app.register(fastifySwaggerUi, { routePrefix: '/docs' });

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
      scope.register(async (inner) => registerEngines(inner, options.db));
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

  // Neither dispatcher is a route family: they are background ticks, and their
  // `onReady`/`onClose` hooks go on the whole app — outside the versioned scope,
  // so they fire exactly once — for the same reason `registerHealth` does.
  // They share no state: one sweeps registered subscriptions, the other only
  // ever reads the deliveries a graph's own hooks already queued (t169).
  registerWebhookDispatcher(app, options.db);
  registerHookDispatcher(app, options.db);

  return app;
}
