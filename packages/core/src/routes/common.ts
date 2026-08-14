/**
 * What the domain routes share: translating an error into HTTP.
 *
 * Two failure responses exist in this file, and neither of them is a 500:
 *
 * - **400** when the body does not match the event's contract. The WHOLE list of
 *   problems goes in the body, not only the first — whoever builds a wrong
 *   envelope usually gets more than one field wrong;
 * - **404** when the entity does not exist. In that case nothing is written:
 *   neither a projection row nor an event (FR5, AT7).
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
 * Runs a route body translating `ValidationError` into a 400.
 *
 * @param reply Fastify reply.
 * @param action The route's work.
 * @returns What the action returned, or the 400 body.
 */
export async function withValidation<T>(
  reply: FastifyReply,
  action: () => T | Promise<T>,
): Promise<T | ErrorResponse> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ValidationError) {
      reply.code(400);
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

/** Reads a route's `:id` as an integer. */
export function routeId(params: unknown): number {
  const raw = (params as { id?: string }).id;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError([`id has to be an integer (got: ${String(raw)})`]);
  }
  return parsed;
}
