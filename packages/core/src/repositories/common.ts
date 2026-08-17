/**
 * What the three domain repositories share.
 *
 * Nothing here is business logic: these are the boundary conversions between
 * SQLite (which has neither a native boolean nor native JSON) and the API's
 * JSON, plus the envelope defaults v0 has nowhere else to get.
 *
 * About the `actor` defaults: t124 authenticated the API, but a token proves
 * POSSESSION and not identity — the control plane still has no way of knowing
 * WHO is on the other side. Instead of inventing a user, it honestly records
 * `system` + the component that acted, and accepts an explicit `actor` in the
 * body for when the caller knows more than it does — which is the case of the
 * runner (t103) and of the screen (t107).
 */

import { ValidationError, type Actor } from '../db/event-validation.ts';

/**
 * Project owning the events when the caller does not say which.
 *
 * v1 has neither a "project" entity nor multi-tenancy: the field exists in the
 * envelope since t98 so that telemetry is born partitionable, and a single
 * project is the honest reading of what the PoC runs.
 */
export const DEFAULT_PROJECT = 1;

/** Default actor of a write coming from the API with no declared owner. */
export const API_ACTOR: Actor = Object.freeze({ type: 'system', ref: 'control-plane' });

/** Default actor of a session: whoever dispatches is the runner (D5). */
export const RUNNER_ACTOR: Actor = Object.freeze({ type: 'system', ref: 'runner' });

/** Actor of the auto-approval gate — never `user`, for audit reasons. */
export const AUTO_APPROVAL_ACTOR: Actor = Object.freeze({
  type: 'system',
  ref: 'portao-auto-aprovacao',
});

/**
 * Actor of the automatic block that is born together with an input request (t106).
 *
 * Only the BLOCK uses this constant. The unblock carries the actor of whoever
 * answered — `user` when it was a person, the automatic gate when it was not —
 * because "who unblocked this job?" is an audit question and the answer cannot
 * always be "the system".
 */
export const ESCALATION_ACTOR: Actor = Object.freeze({
  type: 'system',
  ref: 'escalacao-humana',
});

/**
 * Instant of the fact, ISO 8601 — the same format the migration runner writes.
 *
 * The one clock of every write in this package (t210). `repositories/graphs.ts`
 * used to carry a second, byte-identical definition, which three repositories
 * imported from THERE — so "what time is it" had two answers and the graph
 * repository was an accidental dependency of modules that have nothing to do
 * with graphs.
 */
export const now = (): string => new Date().toISOString();

/** SQLite stores a boolean as 0/1. */
export const asBoolean = (value: number): boolean => value !== 0;

/** ...and the way back. */
export const asInteger = (value: boolean): number => (value ? 1 : 0);

/**
 * The actor given by the caller, or the path's default.
 *
 * The given value passes straight through: what validates it is `validateEvent`,
 * and duplicating the check here would only create two error messages for the
 * same problem.
 *
 * @param given What came in the body, if it came.
 * @param fallback Actor of the path.
 * @returns The actor to record.
 */
export function resolveActor(given: unknown, fallback: Actor): Actor {
  return given === undefined || given === null ? fallback : (given as Actor);
}

/** Reads an optional integer from a request body. */
export function integerOrNull(name: string, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) throw new ValidationError([`${name} has to be an integer`]);
  return value as number;
}

/** Reads an optional integer with a default. */
export function integerOrDefault(name: string, value: unknown, fallback: number): number {
  return integerOrNull(name, value) ?? fallback;
}

/** Reads an optional non-empty string from a request body. */
export function textOrNull(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError([`${name} has to be a non-empty string`]);
  }
  return value;
}

/**
 * Reads an integer from a route parameter or from a query string.
 *
 * An invalid filter becomes a 400, never a filter silently ignored: "nothing
 * came" and "something wrong came" are different questions and deserve different
 * answers.
 */
export function integerFromQuery(name: string, value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ValidationError([`${name} has to be an integer (got: ${String(value)})`]);
  }
  return parsed;
}

/** Decodes a column that stores JSON, preserving the difference between null and empty. */
export function jsonOrNull<T>(raw: string | null): T | null {
  return raw === null ? null : (JSON.parse(raw) as T);
}
