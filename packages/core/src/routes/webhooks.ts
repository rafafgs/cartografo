/**
 * Webhook subscription routes (t142, FR1–FR3).
 *
 * Three verbs and no fourth: register, list, deactivate. There is no `PATCH`
 * because a subscription has nothing worth editing — a new URL or a new secret
 * is a new contract with the consumer, and re-registering makes that explicit
 * instead of silently redirecting deliveries that are already in flight.
 *
 * Two things this file guarantees, and neither depends on anybody remembering:
 *
 * - **The secret never comes back.** Not because a field is stripped here, but
 *   because the type these routes return (`Subscription`) has no place to put
 *   it (`src/repositories/webhooks.ts`). The caller supplies it, and from then
 *   on the API has no read path for it.
 * - **Nothing is validated after something is written.** URL, secret and types
 *   are checked before the first write, and the whole list of problems goes in
 *   the 400 — whoever builds a wrong body usually gets more than one field
 *   wrong (`src/routes/common.ts`).
 *
 * `tipo` validation is not re-declared here either: `KNOWN_TYPES` already is the
 * taxonomy's catalogue, and it is the same check the stream's `?tipo=` does
 * (`src/routes/events.ts:104-120`). One catalogue, two consumers.
 *
 * Since t226 the request and response field names are English
 * (`docs/spec/glossary-wire.md` §1): the body declares `project_id`, `url`,
 * `secret` and `filter_types`, and since t290 the columns, the repository's
 * `NewSubscription` and those four words are all the same four words.
 *
 * `tipo` inside `filter_types` is NOT translated: those are taxonomy event-type
 * names (`trabalho.criado`), which are D20's second child.
 *
 * ## The two reads take the project, and the `DELETE` may not do without it
 *
 * Since t412 both `GET /webhooks` and `DELETE /webhooks/:id` open with
 * `requireProject` (D25). The `DELETE` is the one where it is load-bearing
 * rather than tidy: it used to deactivate by numeric id alone, so any valid
 * credential could silence another project's consumer just by guessing an id.
 * A subscription of another project now answers the same `404` an unknown id
 * already answered, because from inside this project it is not a subscription
 * that exists.
 *
 * The `GET` changed meaning, not merely mechanism: an omitted `?project_id=`
 * used to leave the filter ABSENT, which listed every project at once. It is
 * now the default project, like every other scoped listing in this package —
 * "not said" has one meaning on this wire, and it is project 1
 * (`routes/common.ts`, `declaredProject`).
 *
 * `POST /webhooks` is deliberately untouched: its `readProject` still accepts
 * any integer, including one no project answers to. Closing that write-side gap
 * is a ticket of its own, and doing it here would have widened a read fix into
 * a change to what registrations are accepted.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { KNOWN_TYPES, ValidationError } from '../db/event-validation.ts';
import { DEFAULT_PROJECT } from '../repositories/common.ts';
import {
  createSubscription,
  deactivateSubscription,
  listSubscriptions,
  type NewSubscription,
} from '../repositories/webhooks.ts';
import { notFound, requireProject, routeId, withValidation } from './common.ts';

/** Schemes a delivery can be sent over. */
const SCHEMES = ['http:', 'https:'];

/**
 * Reads the target URL, or says why it is not one.
 *
 * An absolute `http(s)` URL is the whole rule: a relative path has no host to
 * deliver to, and any other scheme is something this dispatcher cannot speak.
 * Where that URL points is deliberately NOT checked — loopback and private
 * ranges are the same trust boundary as every other `/v1` route today, and a
 * valid credential already opens the whole API.
 */
function readUrl(value: unknown, problems: string[]): string {
  if (typeof value !== 'string' || value === '') {
    problems.push('url has to be a non-empty string');
    return '';
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    problems.push(`url has to be an absolute URL (got: ${value})`);
    return '';
  }

  if (!SCHEMES.includes(parsed.protocol)) {
    problems.push(`url has to use http or https (got: ${parsed.protocol})`);
  }
  return value;
}

/** Reads the caller-supplied secret; the server never generates one. */
function readSecret(value: unknown, problems: string[]): string {
  if (typeof value !== 'string' || value === '') {
    problems.push('secret has to be a non-empty string');
    return '';
  }
  return value;
}

/**
 * Reads the type filter against the taxonomy's catalogue.
 *
 * An empty list becomes `null` — "every type", never "no event". An empty filter
 * that silently delivers nothing is a trap, not a feature (the same reading
 * `EventFilter.tipos` already documents).
 */
function readTypes(value: unknown, problems: string[]): string[] | null {
  if (value === undefined || value === null) return null;

  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    problems.push('filter_types has to be a list of taxonomy type strings');
    return null;
  }

  const asked = (value as string[]).filter((item) => item !== '');
  const strangers = asked.filter((item) => !KNOWN_TYPES.includes(item));
  if (strangers.length > 0) {
    problems.push(
      ...strangers.map((item) => `tipo "${item}" is not in the taxonomy (see KNOWN_TYPES)`),
    );
    return null;
  }

  return asked.length === 0 ? null : asked;
}

/** Reads the project, defaulting to the only one v1 has. */
function readProject(value: unknown, problems: string[]): number {
  if (value === undefined || value === null) return DEFAULT_PROJECT;
  if (!Number.isInteger(value)) {
    problems.push('project_id has to be an integer');
    return DEFAULT_PROJECT;
  }
  return value as number;
}

/** Reads the whole body, reporting every problem at once (FR1). */
function readSubscription(raw: unknown): NewSubscription {
  const body = (raw ?? {}) as Record<string, unknown>;
  const problems: string[] = [];

  const declared: NewSubscription = {
    project_id: readProject(body.project_id, problems),
    url: readUrl(body.url, problems),
    secret: readSecret(body.secret, problems),
    filter_types: readTypes(body.filter_types, problems),
  };

  if (problems.length > 0) throw new ValidationError(problems);
  return declared;
}

/**
 * Registers the webhook routes in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 */
export function registerWebhooks(app: FastifyInstance, db: Database): void {
  app.post('/webhooks', async (request, reply) =>
    withValidation(reply, () => {
      const subscription = createSubscription(db, readSubscription(request.body));
      reply.code(201);
      return subscription;
    }),
  );

  app.get('/webhooks', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;
      return { webhooks: listSubscriptions(db, { project_id: scope.project.id }) };
    }),
  );

  // `DELETE` and not `POST /webhooks/:id/deactivations`: unlike a job's blocks
  // and transitions, this is not a fact of the log that has to be told apart
  // from its neighbours — it is the end of the resource, seen from the outside.
  // What the verb does NOT mean is a row leaving the database (FR3).
  app.delete('/webhooks/:id', async (request, reply) =>
    withValidation(reply, () => {
      const scope = requireProject(db, request, reply);
      if (scope.project === undefined) return scope.refusal;

      const subscription = deactivateSubscription(db, routeId(request.params), scope.project.id);
      return subscription ?? notFound(reply, 'webhook');
    }),
  );
}
