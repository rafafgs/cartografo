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
