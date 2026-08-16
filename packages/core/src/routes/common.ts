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
 * This envelope is the one error shape D18 does translate (t127, FR7): no other
 * package in the repo parses it, so it is self-contained to core's own tests.
 * The ad-hoc error bodies of the other route files keep their Portuguese keys —
 * those are the wire format the runner reads.
 */

import type { FastifyReply } from 'fastify';

import { ValidationError } from '../db/event-validation.ts';

/** Body of an error response. */
export interface ErrorResponse {
  error: string;
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
 * cannot guarantee: `error` and `details` are the two the three helpers below
 * always build themselves.
 */
export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
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

/** Reads a route's `:id` as an integer. */
export function routeId(params: unknown): number {
  const raw = (params as { id?: string }).id;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError([`id has to be an integer (got: ${String(raw)})`]);
  }
  return parsed;
}
