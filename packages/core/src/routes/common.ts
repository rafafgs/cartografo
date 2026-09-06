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
 * (`docs/spec/glossary-wire.md` §1.4) and the answer is `{error, message?,
 * details?}` with the route's own context as SIBLING properties — `id`,
 * `status`, `class` — never folded into `details`. `refusal` below is how the
 * files that used to build the second shape write the first one.
 *
 * ## The asymmetry that lived here between t226 and t227, and why it is gone
 *
 * For one ticket four entities answered English on the way out and still
 * demanded Portuguese on the way in: **job**, **session**, **input request**
 * and the intake `/confirmations` route. It was never an oversight.
 *
 * Their write bodies do not stop here — they go straight into `validateEvent`
 * (`src/db/event-validation.ts`), which checks the `data.*` contract of
 * `job.created`, `session.opened`, `input_request.created` and friends. That
 * vocabulary is the EVENT surface, and D20 gave it to the SECOND child ticket:
 * translating those bodies during the FIRST one would have made a validator
 * that still spoke Portuguese reject every legitimate write.
 *
 * The events child landed, so both halves speak the same words now —
 * `POST /jobs`, `POST /jobs/:id/{transitions,blocks,unblocks}`,
 * `PATCH /jobs/:id`, `POST /sessions`, `PATCH /sessions/:id/finish`,
 * `POST /sessions/:id/permission-denials`, `POST /input-requests`,
 * `PATCH /input-requests/:id/{answer,auto-resolution}` and
 * `POST /intake/:id/confirmations` included.
 *
 * What is still Portuguese underneath is not the DATABASE — D20's FOURTH child
 * (t229) renamed it to `job`, `entity_type`, `created_at` — but the repository
 * layer's own field names, which that ticket kept by aliasing every renamed
 * column back onto them. The intake's items used to be listed here as the second
 * half of that sentence, on the grounds that `{ref, titulo, corpo, …}` was
 * `domain/intake.ts`'s own document format; t255 read D20 the other way and
 * moved them, because they are the body of `POST /v1/intake` (§1.1).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.ts';
import { ValidationError } from '../db/event-validation.ts';
import { DEFAULT_PROJECT } from '../repositories/common.ts';
import { getProject, type Project } from '../repositories/projects.ts';
import { isObject } from '../util/is-object.ts';

/**
 * Body of an error response.
 *
 * `message` is one sentence for a person; `details` is the machine-readable list
 * of everything wrong at once. A refusal carries either, both or neither — what
 * it always carries is `error`, the code from `glossary-wire.md` §1.4.
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
 * @param error Code from `docs/spec/glossary-wire.md` §1.4.
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

/* -------------------------------------------------------------------------- */
/* t354 — the scope of a request, resolved in one place.                       */
/* -------------------------------------------------------------------------- */

/**
 * The name of the scope, on the query string and in a body alike.
 *
 * One spelling, and it is the one `POST /v1/jobs` and `POST /v1/leases` have
 * used since the envelope existed: this ticket extends a convention rather than
 * inventing one.
 */
export const PROJECT_FIELD = 'project_id';

/**
 * Reads the scope a request declared, WITHOUT deciding whether it exists.
 *
 * The query string is read before the body, and both are read on every route,
 * because the shape of a body varies and the question does not. Two routes make
 * that matter: `POST /v1/graphs` takes the pure graph document as its body and
 * `POST /v1/skills` takes the raw manifest, so neither has an envelope to hold
 * a scope — a caller says it on the query string there, or in the body and lets
 * the route strip it before hashing (see {@link withoutProject}).
 *
 * Absent is the DEFAULT and not an error: every call that omitted the scope
 * before this ticket keeps meaning project 1, which is what makes the
 * single-project path survive the partition unchanged.
 *
 * On the wire a scope is always an ID. Resolving a NAME is the CLI's affair —
 * `cli/index.ts` turns `--project second` into `2` against `GET /v1/projects`
 * before any other call goes out — because a route that took both would make
 * one request mean two things the day somebody names a project `2`.
 *
 * @param request The incoming request.
 * @returns The id the caller said, or `DEFAULT_PROJECT`.
 * @throws {ValidationError} When something came and it is not an integer — a
 *   filter that is wrong is a `400`, never a filter quietly ignored.
 */
export function declaredProject(request: FastifyRequest): number {
  const query = isObject(request.query) ? request.query : {};
  const fromQuery = query[PROJECT_FIELD];
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== '') {
    return readScope(fromQuery);
  }

  const body = isObject(request.body) ? request.body : {};
  const fromBody = body[PROJECT_FIELD];
  if (fromBody !== undefined && fromBody !== null) return readScope(fromBody);

  return DEFAULT_PROJECT;
}

/**
 * A scope has to be an integer; anything else is a `400`.
 *
 * A query string carries text, so a digit run coming from there is coerced —
 * `?project_id=2` and a body's `"project_id": 2` are the same request said two
 * ways. `Number()` is not used on its own because it reads `''` as `0` and
 * `'2abc'` as `NaN`, and both would become a filter nobody wrote.
 */
function readScope(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
  throw new ValidationError([
    `${PROJECT_FIELD} has to be a project id (an integer); got ${JSON.stringify(value)}`,
  ]);
}

/**
 * What a route got when it asked which project it is working in.
 *
 * Exactly one of the two is set. It is a result and not a `Project | undefined`
 * because a route has to RETURN the refusal body, and a bare `undefined` would
 * make every call site rebuild it — which is how two spellings of one refusal
 * appear.
 */
export interface ResolvedScope {
  /** The project, when one answered to the scope. */
  project?: Project;
  /** The body to return, when none did; `reply` is already marked `404`. */
  refusal?: ErrorResponse & Record<string, unknown>;
}

/**
 * The project a request is scoped to, or the `404` that says there is none.
 *
 * Called by every route before it touches a partitioned table. An unknown
 * project is a refusal and never an empty result: "there is nothing here" and
 * "there is no here" are different answers, and answering the first for the
 * second turns a typo into a wrong conclusion.
 *
 * `project_id` rides on the refusal as a SIBLING property, like every other
 * route context in this file: a client reads it with one lookup instead of
 * parsing a sentence.
 *
 * @param db Open database.
 * @param request The incoming request.
 * @param reply Fastify reply, marked with the status when it refuses.
 * @returns The project, or the refusal to hand back.
 */
export function requireProject(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
): ResolvedScope {
  const declared = declaredProject(request);
  const project = getProject(db, declared);
  if (project !== undefined) return { project };

  return {
    refusal: refusal(reply, 404, 'unknown_project', 'no project answers to this scope', {
      [PROJECT_FIELD]: declared,
    }),
  };
}

/**
 * The same body, without the scope field.
 *
 * `POST /v1/graphs` and `POST /v1/skills` take a raw document as their body —
 * a graph, a manifest — and both are CONTENT-ADDRESSED: the version id is the
 * hash of the whole document, and the skill pin is the hash of the manifest's
 * content fields. So a `project_id` the caller put in the body has to come back
 * out before anything is validated or hashed, or the same document would get a
 * different id in each project and `cartografo export` would stop round-tripping.
 *
 * The scope is not a field of the document. It is where the document is being
 * put.
 *
 * @param body Whatever came in.
 * @returns The same value, minus `project_id` when it was an object carrying one.
 */
export function withoutProject(body: unknown): unknown {
  if (!isObject(body) || !(PROJECT_FIELD in body)) return body;
  const { [PROJECT_FIELD]: _scope, ...rest } = body;
  return rest;
}
