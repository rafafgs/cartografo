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
import Fastify, { LogController, type FastifyInstance } from 'fastify';

import { registerAuth } from './auth.ts';
import type { Database } from './db/connection.ts';
import type { ErrorResponse } from './routes/common.ts';
import { registerEngines } from './routes/engines.ts';
import { registerEvents } from './routes/events.ts';
import { registerExecutions } from './routes/executions.ts';
import { registerGraphs } from './routes/graphs.ts';
import { registerHealth } from './routes/health.ts';
import { registerHookSecrets } from './routes/hook-secrets.ts';
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

/**
 * Body of an unexpected failure, and the only thing a client ever learns of one.
 *
 * Two fixed strings and an id, and nothing derived from the error: a `message`
 * copied off the throw is how `repositories/leases.ts`'s own sentence about a
 * lease that "stopped being active" ends up on the wire, and a `stack` is a map
 * of the server's filesystem. `request_id` is what replaces them — it says
 * nothing on its own and it is exactly enough to find the log line that says
 * everything (t197, FR4).
 */
export const INTERNAL_ERROR_CODE = 'internal_error';

/** The one sentence the generic 500 carries; it describes nothing on purpose. */
export const INTERNAL_ERROR_MESSAGE = 'an unexpected error occurred';

/** Error code of a body that is not parseable JSON (t256, FR10). */
export const INVALID_JSON_CODE = 'invalid_json';

/**
 * Error code of a body that parses but does not match the route's contract.
 *
 * The same word `routes/leases.ts` already answers by hand for a field of the
 * wrong type: from a client's side "the body is wrong" is one refusal, whether
 * the shape was caught by Fastify's ajv or by a handler reading the object.
 */
export const INVALID_BODY_CODE = 'invalid_body';

/** Error code of an address no route claims (t197, FR5). */
export const ROUTE_NOT_FOUND_CODE = 'not_found';

/** The sentence that goes with it. */
export const ROUTE_NOT_FOUND_MESSAGE = 'route not found';

/**
 * What the OpenAPI document says about the status of an unusable body (FR6).
 *
 * Prose and not a per-route schema: writing the real contract of each endpoint
 * is still t171's Out of Scope. What a client genuinely cannot guess from the
 * paths is the ONE exception, so the exception is what this names.
 */
export const OPENAPI_DESCRIPTION =
  'Every /v1 route answers 400 when the request body fails its contract, with the single exception of PATCH /v1/jobs/{id}, which answers 422 because it edits the content of an entity that already exists (t157). An unexpected failure answers 500 with {error, message, request_id}; the request_id is the reqId of the corresponding log line.';

/** Options of the app factory. */
export interface AppOptions {
  /** Already open database; the app never opens its own. */
  db: Database;
  /**
   * Fastify log configuration. `false` turns it off (the default in silent
   * tests).
   *
   * The object form is pino's own options, narrowed to the two anybody here
   * sets: `start()` sets `level` out of `CARTOGRAFO_LOG_LEVEL` (t197, FR2), and
   * `test/error-envelope.test.ts` sets `stream` to read back what the app
   * logged instead of letting it reach a terminal.
   */
  logger?: boolean | { level?: string; stream?: { write: (line: string) => void } };
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
  const app = Fastify({
    logger: options.logger ?? false,
    // Unconditionally, and it is not the same switch as the one above (t197,
    // FR3): what this turns off is the automatic line-per-request, which nobody
    // asked for and which would bury the two things that DO have to be seen —
    // a dispatcher tick that failed and the error handler below. Every one of
    // `LogController`'s automatic lines is gated on it; an explicit
    // `log.error` call is not, which is the whole distinction.
    //
    // Through `logController` and not the top-level `disableRequestLogging`
    // the ticket names: fastify 5.12 deprecates that spelling (FSTDEP023) and
    // drops it in 6, so passing it would print a deprecation warning on stderr
    // at every startup — noise, in the one ticket whose subject is a control
    // plane you can read. Same behaviour, same single flag, no warning.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // The catch-all, and the ONE place in the package that answers a 500 (t197,
  // FR4). Everything a route MEANS to refuse already has an envelope of its own
  // in `routes/common.ts`, and none of those ever gets here: Fastify only runs
  // this for a throw nobody caught, which by definition is a failure whose
  // message was written for whoever maintains the server, not for the client.
  //
  // An error that already carries a `statusCode` is Fastify's own — a payload
  // over the limit, a header the parser refused — and is handed straight back:
  // `reply.send(error)` re-enters the chain one link down, at the default
  // handler, which is the behaviour every client already sees for those.
  //
  // With ONE exception, and t256 is it: the two commonest client mistakes also
  // arrive here carrying a `statusCode` of 400 — a body that is not JSON
  // (`FST_ERR_CTP_INVALID_JSON_BODY`, from the content-type parser) and a body
  // that is JSON but not the shape the route declares (`FST_ERR_VALIDATION`,
  // e.g. an array where `OPEN_OBJECT_SCHEMA` wants an object). Both used to
  // serialize as `{statusCode, error: 'Bad Request', message}`: an extra key and
  // an English PHRASE where every other refusal on `/v1` carries a snake_case
  // code (`routes/common.ts`'s `refusal`). So a 400 — and only a 400 — is
  // rewritten into the house envelope. The `message` is Fastify's own: it
  // describes the shape problem to whoever has to fix the call and carries
  // nothing about the server.
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number') {
      if (status === 400) {
        // `message` and not `message?`: whatever else it carries, what got here
        // is an Error, and Fastify's own sentence is the only description of the
        // problem the client is going to get.
        const failure = error as { code?: string; message: string };
        void reply.code(400).send({
          error:
            failure.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
              ? INVALID_JSON_CODE
              : INVALID_BODY_CODE,
          message: failure.message,
        } satisfies ErrorResponse);
        return;
      }
      void reply.code(status).send(error);
      return;
    }

    // `request.log` and not `app.log`: Fastify binds `reqId` on every
    // request-scoped child logger, and that binding is the whole reason the
    // `request_id` below is worth anything to an operator.
    request.log.error({ err: error }, 'unhandled error');

    void reply.code(500).send({
      error: INTERNAL_ERROR_CODE,
      message: INTERNAL_ERROR_MESSAGE,
      request_id: request.id,
    });
  });

  // And an address nobody claims answers in the same shape (t197, FR5), instead
  // of the router's `{statusCode, error, message}` — one failure format for a
  // client to parse, whether it got the path wrong or the server broke.
  app.setNotFoundHandler((_request, reply) => {
    void reply
      .code(404)
      .send({ error: ROUTE_NOT_FOUND_CODE, message: ROUTE_NOT_FOUND_MESSAGE } satisfies ErrorResponse);
  });

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
      info: {
        title: OPENAPI_TITLE,
        version: PACKAGE_VERSION,
        description: OPENAPI_DESCRIPTION,
      },
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
      scope.register(async (inner) => registerHookSecrets(inner, options.db));
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
