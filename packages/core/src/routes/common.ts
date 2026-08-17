/**
 * What the domain routes share: translating an error into HTTP.
 *
 * Three failure responses exist in this file, and none of them is a 500:
 *
 * - **400** when the body does not match the event's contract. The WHOLE list of
 *   problems goes in the body, not only the first — whoever builds a wrong
 *   envelope usually gets more than one field wrong. One route asks for `422`
 *   instead (`PATCH /v1/jobs/:id`, t157) and says so at its own call site;
 * - **404** when the entity does not exist. In that case nothing is written:
 *   neither a projection row nor an event (FR5, AT7);
 * - **409** when the entity exists but has already left the state the operation
 *   needs — an input request that was answered, a session that has ended
 *   (t149). Nothing is written here either: the second attempt is a conflict,
 *   never an overwrite of the first.
 *
 * Since t226 this is the ONE error envelope of the whole `/v1` surface. Two
 * competed until D20: this `{error, details}` and the `{erro, mensagem, …}` the
 * domain routes wrote by hand. The glossary left the choice to this ticket
 * (`docs/spec/glossario-wire.md` §1.4) and the answer is `{error, message?,
 * details?}` with the route's own context as SIBLING properties — `id`,
 * `status`, `class` — never folded into `details`. `refusal` below is how the
 * files that used to build the second shape write the first one.
 *
 * ## The asymmetry that is deliberate, and that a later ticket must not "fix"
 *
 * Four entities answer English on the way out and still demand Portuguese on the
 * way in: **job**, **session**, **input request** and the intake
 * `/confirmations` route. It is not an oversight and it is not half a migration.
 *
 * Their write bodies do not stop here — they go straight into `validateEvent`
 * (`src/db/event-validation.ts`), which checks the `dados.*` contract of
 * `trabalho.criado`, `sessao.aberta`, `pergunta.criada` and friends. That
 * vocabulary is the EVENT surface, and D20 gives it to the second child ticket,
 * not to this one. Translating those bodies here would make a validator that
 * still speaks Portuguese reject every legitimate write.
 *
 * So, concretely, until the events child lands:
 *
 * - `POST /jobs`, `POST /jobs/:id/{transitions,blocks,unblocks}`,
 *   `PATCH /jobs/:id`, `POST /sessions`, `PATCH /sessions/:id/finish`,
 *   `POST /sessions/:id/permission-denials`, `POST /input-requests`,
 *   `PATCH /input-requests/:id/{answer,auto-resolution}` and
 *   `POST /intake/:id/confirmations` keep taking the body they always took;
 * - everything those same routes RETURN — a projection, never an event — is
 *   translated by its repository's `toX` mapper like every other entity.
 *
 * The tests pin both halves on purpose (`test/jobs.test.ts`,
 * `test/sessions.test.ts`, `test/input-requests.test.ts`): each asserts the
 * English response AND that the Portuguese request body is still accepted.
 */

import type { FastifyReply } from 'fastify';

import { ValidationError } from '../db/event-validation.ts';

/**
 * Body of an error response.
 *
 * `message` is one sentence for a person; `details` is the machine-readable list
 * of everything wrong at once. A refusal carries either, both or neither — what
 * it always carries is `error`, the code from `glossario-wire.md` §1.4.
 */
export interface ErrorResponse {
  error: string;
  message?: string;
  details?: string[];
}

/**
 * The envelope above, as a response schema for the public document (t171, FR4).
 *
 * `additionalProperties: true` is not decoration and must not be tightened: a
 * Fastify `response` schema is a SERIALIZATION filter (fast-json-stringify), so
 * a narrower whitelist would silently drop fields from the wire instead of
 * merely failing to document them — a behaviour change disguised as
 * documentation (FR6). For the same reason nothing here declares a type it
 * cannot guarantee: `error`, `message` and `details` are the three the helpers
 * below always build themselves.
 */
export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    details: { type: 'array', items: { type: 'string' } },
  },
  required: ['error'],
  additionalProperties: true,
} as const;

/**
 * A body this ticket documents by PRESENCE and not by shape (t171, FR5/FR6).
 *
 * Used for the request bodies and the success responses of the three routes the
 * basic flow crosses. It says "a JSON object goes here" and stops: on the
 * request side anything narrower would put Fastify's ajv in front of handlers
 * that validate by hand today — which is exactly the draft-2020-12/draft-07
 * conflict `routes/graphs.ts` already documents — and on the response side
 * anything narrower would strip fields. Writing the real contract of each
 * endpoint is a follow-up, grouped by route family.
 */
export const OPEN_OBJECT_SCHEMA = { type: 'object', additionalProperties: true } as const;

/**
 * Runs a route body translating `ValidationError` into an invalid-body status.
 *
 * `invalidStatus` is a parameter and not a constant because of exactly one
 * route: `PATCH /v1/jobs/:id` answers `422` (t157, FR2). Everywhere else the
 * default keeps the `400` this file has always written — the divergence is one
 * route's contract, not a new convention.
 *
 * @param reply Fastify reply.
 * @param action The route's work.
 * @param invalidStatus Status for a body that does not match the contract.
 * @returns What the action returned, or the refusal body.
 */
export async function withValidation<T>(
  reply: FastifyReply,
  action: () => T | Promise<T>,
  invalidStatus = 400,
): Promise<T | ErrorResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ValidationError) {
      reply.code(invalidStatus);
      return { error: 'validation_failed', details: error.errors };
    }
    throw error;
  }
}

/**
 * Marks the response as a 404.
 *
 * @param reply Fastify reply.
 * @param entity Name of the entity that was not found.
 * @returns The 404 body.
 */
export function notFound(reply: FastifyReply, entity: string): ErrorResponse {
  reply.code(404);
  return { error: 'not_found', details: [`${entity} does not exist`] };
}

/**
 * Marks the response as a 409.
 *
 * The detail is the whole explanation the caller gets, so it names the state
 * that refused the operation: "already answered" is actionable, "conflict" on
 * its own only says that something went wrong.
 *
 * @param reply Fastify reply.
 * @param detail What state made the operation impossible.
 * @returns The 409 body.
 */
export function conflict(reply: FastifyReply, detail: string): ErrorResponse {
  reply.code(409);
  return { error: 'conflict', details: [detail] };
}

/**
 * Builds a refusal in the one envelope, with the route's own context beside it.
 *
 * This is what the six files that used to write `{erro, mensagem, …}` by hand
 * call instead (t226, FR3). The context goes in as SIBLING properties and is
 * never folded into `details`: `{error: 'invalid_variant', message: '…',
 * lineage_type: 'base'}` is one flat object a client reads with two lookups,
 * and pushing `lineage_type` into a string array would be losing a field to
 * make a shape tidier.
 *
 * `extra` is spread FIRST so the envelope's own three keys can never be shot
 * off by a context field that happens to share a name.
 *
 * @param reply Fastify reply, marked with the status.
 * @param status HTTP status of the refusal.
 * @param error Code from `docs/spec/glossario-wire.md` §1.4.
 * @param message One sentence for whoever has to fix the call.
 * @param extra Route-specific context, as sibling properties.
 * @returns The body to return.
 */
export function refusal(
  reply: FastifyReply,
  status: number,
  error: string,
  message?: string,
  extra: Record<string, unknown> = {},
): ErrorResponse & Record<string, unknown> {
  reply.code(status);
  return { ...extra, error, ...(message === undefined ? {} : { message }) };
}

/** Reads a route's `:id` as an integer. */
export function routeId(params: unknown): number {
  const raw = (params as { id?: string }).id;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError([`id has to be an integer (got: ${String(raw)})`]);
  }
  return parsed;
}
