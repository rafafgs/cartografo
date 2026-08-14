/**
 * The credential gate of the business API (t124, FR3).
 *
 * ONE `onRequest` hook, registered once on the `/v1` scope by `server.ts`, and
 * not a check inside each route file. Ten route families exist today and the
 * eleventh will be written by somebody who never reads this file: a gate that
 * has to be remembered is a gate that will eventually be forgotten, and the
 * failure mode of forgetting it is an open route nobody notices.
 *
 * `/health` is outside the scope, on purpose (`routes/health.ts`): a supervisor
 * polls liveness before any credential exists, and asking it for one would make
 * the probe useless exactly when it matters most.
 *
 * Two refusals, and the difference between them is the whole reason there are
 * two: `credencial_ausente` means nothing usable was presented — no header, or
 * a header that is not `Bearer <token>` — and `credencial_invalida` means
 * something was presented and it does not resolve. Whoever gets the first knows
 * to set a variable; whoever gets the second knows their token is dead. Both
 * bodies are the `erro`/`mensagem` shape the rest of the API answers with, so
 * the screen and the CLI have one failure format, not two (t127, FR8).
 *
 * What this hook does NOT do is authorization: a valid token opens the whole
 * `/v1` surface. Scoping a credential to a subset of routes is what the runner
 * pairing ticket needs, and it is deferred there together with the runner
 * credential itself.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Database } from './db/connection.ts';
import { verifyToken, type CredentialRow } from './repositories/credentials.ts';

/** Error code of a request that presented no usable credential. */
export const MISSING_CREDENTIAL = 'credencial_ausente';

/** Error code of a request whose credential does not resolve. */
export const INVALID_CREDENTIAL = 'credencial_invalida';

/** The `Authorization` scheme this API speaks, and the only one. */
const SCHEME = 'bearer';

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
        erro: MISSING_CREDENTIAL,
        mensagem:
          'esta rota exige `Authorization: Bearer <token>` — use o token impresso na partida do control plane (CARTOGRAFO_TOKEN, ou --token no comando)',
      });
      return;
    }

    const credential = verifyToken(db, token);
    if (credential === null) {
      await reply.code(401).send({
        erro: INVALID_CREDENTIAL,
        mensagem:
          'a credencial apresentada não vale mais (desconhecida ou revogada) — peça outra a quem administra este control plane',
      });
      return;
    }

    request.credential = credential;
  });
}
