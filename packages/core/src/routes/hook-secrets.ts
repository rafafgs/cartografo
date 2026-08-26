/**
 * Hook secret routes (t194, FR2–FR5).
 *
 * The operator half of the reference model: a hook's `destination.secret_ref`
 * names a key, and this is where the key is put. Three verbs and no fourth —
 * register-or-rotate, list, revoke — for the same reason
 * `src/routes/webhooks.ts` has three: there is nothing to PATCH in a credential,
 * and a new value is a new registration, not an edit of the old one.
 *
 * `PUT` and not `POST` because the name IS the address: `PUT` on the same path
 * twice is the rotation this ticket wants (the second one replaces what the
 * name means), while `POST /hook-secrets` would read as "create another one" and
 * leave the caller to invent an id for something that already has a name.
 *
 * Two things this file guarantees, and neither depends on anybody remembering:
 *
 * - **The value never comes back.** Not because a field is stripped here, but
 *   because the type these routes return (`HookSecret`) has no place to put it
 *   (`src/repositories/hook-secrets.ts`). The caller supplies it, and from then
 *   on the API has no read path for it.
 * - **Only an operator may reach these.** By omission, not by a check: the gate
 *   in `src/auth.ts` refuses any route outside `RUNNER_SURFACE` with
 *   `out_of_scope_credential`, and this family is deliberately not on that
 *   list. A runner dispatches sessions; it has no business registering keys.
 *
 * Since t226 the request and response field names are English
 * (`docs/spec/glossary-wire.md` §1): the path segment is `:name`, the body
 * carries `value`, and what comes back is `{name, created_at, revoked_at}` —
 * what `repositories/hook-secrets.ts` returns, handed back untouched (t289).
 * There used to be a `toHookSecret` wrapper around every read there, translating
 * a Portuguese-spelled row into those names; the COLUMNS have been English since
 * D20's fourth child (t229), so the row spells them itself now and the wrapper
 * had nothing left to rename.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { ValidationError } from '../db/event-validation.ts';
import {
  listHookSecretNames,
  revokeHookSecret,
  setHookSecret,
} from '../repositories/hook-secrets.ts';
import { notFound, withValidation } from './common.ts';

/** Route parameters of the two routes addressed by name. */
interface NameParam {
  Params: { name: string };
}

/**
 * The charset a name may use — the same one a node id has.
 *
 * Two constraints meet at exactly this pattern, which is why it is one rule and
 * not two: the name is a path segment, so it has to round-trip through a URL
 * without encoding, and it is what `secret_ref` is constrained to in
 * `schema/graph.schema.json`. A name the document could carry but the route
 * could not address would be a trap discovered at delivery time.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Reads the name out of the path, or says why it is not one. */
function readName(params: unknown): string {
  const raw = (params as { name?: string }).name ?? '';
  if (!NAME_PATTERN.test(raw)) {
    throw new ValidationError([
      `name has to match ${NAME_PATTERN.source} — the same charset as a node id (got: ${raw})`,
    ]);
  }
  return raw;
}

/** Reads the caller-supplied value; the server never generates one. */
function readValue(raw: unknown): string {
  const value = (raw as { value?: unknown } | null)?.value;
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError(['value has to be a non-empty string']);
  }
  return value;
}

/**
 * Registers the hook secret routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerHookSecrets(app: FastifyInstance, db: Database): void {
  // `201` only the first time a name is ever registered. A name that was
  // revoked is still a resource this API lists, so registering under it again
  // is a rotation of something that exists — a `201` there would claim a
  // creation the `GET` does not agree with.
  app.put<NameParam>('/hook-secrets/:name', async (request, reply) =>
    withValidation(reply, () => {
      const name = readName(request.params);
      const value = readValue(request.body);

      const { secret, rotated } = setHookSecret(db, { name, value });
      reply.code(rotated ? 200 : 201);
      return { name: secret.name, created_at: secret.created_at };
    }),
  );

  app.get('/hook-secrets', async (_request, reply) =>
    withValidation(reply, () => ({ secrets: listHookSecretNames(db) })),
  );

  // `DELETE` and not `POST /hook-secrets/:name/revocations`: this is the end of
  // the resource seen from the outside, like `DELETE /v1/webhooks/:id`. What the
  // verb does NOT mean is a row leaving the database (D15/D2).
  app.delete<NameParam>('/hook-secrets/:name', async (request, reply) =>
    withValidation(reply, () => {
      const revoked = revokeHookSecret(db, readName(request.params));
      return revoked ?? notFound(reply, 'hook secret');
    }),
  );
}
