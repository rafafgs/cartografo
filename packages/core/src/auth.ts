/**
 * The credential gate of the business API (t124, FR3).
 *
 * ONE `onRequest` hook, registered once on the `/v1` scope by `server.ts`, and
 * not a check inside each route file. Eleven route families exist today and the
 * twelfth will be written by somebody who never reads this file: a gate that
 * has to be remembered is a gate that will eventually be forgotten, and the
 * failure mode of forgetting it is an open route nobody notices.
 *
 * `/health` is outside the scope, on purpose (`routes/health.ts`): a supervisor
 * polls liveness before any credential exists, and asking it for one would make
 * the probe useless exactly when it matters most.
 *
 * Two refusals, and the difference between them is the whole reason there are
 * two: `missing_credential` means nothing usable was presented — no header, or
 * a header that is not `Bearer <token>` — and `invalid_credential` means
 * something was presented and it does not resolve. Whoever gets the first knows
 * to set a variable; whoever gets the second knows their token is dead. Both
 * bodies are the `{error, message}` envelope the rest of the API answers with,
 * so the screen and the CLI have one failure format, not two (t226, FR3).
 *
 * Since t143 the hook also authorizes, and the second check is a different
 * question from the first: authentication asks "does this token resolve", and
 * authorization asks "may THIS credential be here". A `usuario` credential is
 * unrestricted, as it always was; a `runner` credential opens only the five
 * routes a runner really calls (FR2) and is refused everywhere else with
 * `out_of_scope_credential` (403) — a third refusal, deliberately distinct
 * from the two 401s, because "your token is dead" and "your token is alive and
 * has no business here" send whoever reads it to opposite places.
 *
 * The allowlist is a literal list of `METHOD /v1/route`, not a prefix rule, and
 * that is the point: a route family born tomorrow under `/v1/leases` is denied
 * to runners until somebody writes it down here. The failure mode of a prefix
 * is silent inclusion; the failure mode of a list is a 403 somebody notices.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Database } from './db/connection.ts';
import { verifyToken, type CredentialRow } from './repositories/credentials.ts';
import type { ErrorResponse } from './routes/common.ts';

/** Error code of a request that presented no usable credential. */
export const MISSING_CREDENTIAL = 'missing_credential';

/** Error code of a request whose credential does not resolve. */
export const INVALID_CREDENTIAL = 'invalid_credential';

/** Error code of a live credential presented outside the routes it may use. */
export const OUT_OF_SCOPE_CREDENTIAL = 'out_of_scope_credential';

/** The `Authorization` scheme this API speaks, and the only one. */
const SCHEME = 'bearer';

/**
 * The whole surface a `runner`-type credential may reach (t143, FR2).
 *
 * It is exactly what `ClienteControle` calls to dispatch
 * (`docs/spec/runner-e-controller.md` §5) minus `POST /v1/runners`: pairing is
 * the operator provisioning a machine, and a runner that could pair would be
 * able to mint itself a second identity — with a credential of its own — the
 * moment the first one is revoked.
 *
 * Everything else is denied by omission, including the routes a runner might
 * plausibly want one day (the event stream, sessions, input requests): widening
 * this list is a decision somebody takes on purpose, in one place.
 */
const RUNNER_SURFACE: ReadonlySet<string> = new Set([
  'GET /v1/jobs',
  'POST /v1/leases',
  'POST /v1/leases/:id/heartbeats',
  'POST /v1/leases/:id/releases',
  'GET /v1/leases',
  // t166. Reporting which models THIS machine's engine offers is a runner
  // telling the control plane what it found — the same act as pairing, and the
  // only route of the discovery pair a runner reaches. `GET /v1/engines` is
  // deliberately NOT here: reading the whole fleet's menu is the operator's,
  // for the reason `GET /v1/runners` already states.
  'POST /v1/engines/:name/models',
]);

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The credential that let this request through.
     *
     * Nothing consumes it yet — the event `ator` stays `sistema`/component
     * (`repositories/common.ts`), because a token proves POSSESSION and not
     * identity, and attaching a person to telemetry is separate work. It is
     * attached here so that whoever needs it does not have to re-resolve it.
     */
    credential?: CredentialRow;
  }
}

/**
 * Reads the token out of an `Authorization` header.
 *
 * @param header Raw header value, if it came.
 * @returns The token, or `null` when the header is absent or not `Bearer <token>`.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;

  const separator = header.indexOf(' ');
  if (separator === -1) return null;
  if (header.slice(0, separator).toLowerCase() !== SCHEME) return null;

  const token = header.slice(separator + 1).trim();
  return token === '' ? null : token;
}

/**
 * The runner a request speaks for, when it speaks for one (t143, FR3).
 *
 * `null` covers two different situations on purpose, and both mean the same
 * thing to a route: an operator credential (which is nobody's runner) and a
 * scope with no gate at all — which is how `test/leases.test.ts` assembles the
 * lease routes with a controlled clock. A route asking this question wants to
 * know whether to narrow itself, and in both cases the answer is no.
 *
 * @param request Request already past the gate.
 * @returns The `runner_id` of a `runner`-type credential, or `null`.
 */
export function credentialRunnerId(request: FastifyRequest): string | null {
  const credential = request.credential;
  return credential !== undefined && credential.type === 'runner' ? credential.runner_id : null;
}

/**
 * Body of the refusal a route sends when a runner reaches for another runner.
 *
 * It lives here, next to the hook that answers the same code for a route out of
 * scope, so the two halves of FR2/FR3 cannot drift into two vocabularies.
 *
 * @param detail What was out of scope, in one clause.
 * @returns The `{error, message}` body, ready to return.
 */
export function outOfScope(detail: string): ErrorResponse {
  return { error: OUT_OF_SCOPE_CREDENTIAL, message: detail };
}

/**
 * Registers the gate on a scope — every route born inside it needs a credential.
 *
 * @param app The `/v1` scope, before any route is registered on it.
 * @param db Open database, where the credentials live.
 */
export function registerAuth(app: FastifyInstance, db: Database): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) {
      await reply.code(401).send({
        error: MISSING_CREDENTIAL,
        message:
          'this route requires `Authorization: Bearer <token>` — use the token printed when the control plane starts (CARTOGRAFO_TOKEN, or --token on the command)',
      } satisfies ErrorResponse);
      return;
    }

    const credential = verifyToken(db, token);
    if (credential === null) {
      await reply.code(401).send({
        error: INVALID_CREDENTIAL,
        message:
          'the credential presented is no longer valid (unknown or revoked) — ask whoever administers this control plane for another one',
      } satisfies ErrorResponse);
      return;
    }

    // Authorization (t143, FR2). `routeOptions.url` is the route's PATTERN —
    // `/v1/leases/:id/heartbeats` — and not the concrete path, which is what
    // makes the list above finite instead of one entry per lease id.
    const route = `${request.method.toUpperCase()} ${request.routeOptions.url ?? request.url}`;
    if (credential.type === 'runner' && !RUNNER_SURFACE.has(route)) {
      await reply.code(403).send(
        outOfScope(
          `a runner credential reaches only ${[...RUNNER_SURFACE].join(', ')} — "${route}" requires a user credential`,
        ),
      );
      return;
    }

    request.credential = credential;
  });
}
