/**
 * Settings routes (t403, FR4).
 *
 * `GET /v1/settings` and `PATCH /v1/settings` are the operator's, by omission
 * from `auth.ts`'s `RUNNER_SURFACE` — the same convention `GET /v1/engines`
 * already relies on: the caller that needs these routes always holds an
 * operator credential (the up-command ticket), so nothing there changes.
 *
 * `project_id` is a query filter on `GET`, following `GET /v1/leases`'s own
 * convention (`routes/leases.ts`): absent or blank falls back to
 * `DEFAULT_PROJECT`, and a value that is not an integer refuses
 * `400 invalid_filter` naming the field. `PATCH` reads the same default off
 * its own body instead, since a query string has no natural home for a write.
 *
 * `PATCH` validates every key of the patch BEFORE writing any of it, mirroring
 * `readReport` (`routes/engines.ts`): a patch whose second key is unknown must
 * leave the first key's old value in place.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { DEFAULT_PROJECT } from '../repositories/common.ts';
import { getSettings, updateSettings, KNOWN_SETTING_KEYS } from '../repositories/settings.ts';
import { isObject } from '../util/is-object.ts';
import { refusal } from './common.ts';

interface SettingsQuery {
  Querystring: { project_id?: string };
}

/**
 * Reads the project id out of a raw query value, defaulting when absent.
 *
 * @param raw Querystring value, if it came.
 * @returns The project id, or `undefined` when `raw` does not parse as an integer.
 */
function parseProjectId(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROJECT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Reads the settings to write out of a `PATCH` body.
 *
 * Every key other than `project_id` is a setting: checked against
 * {@link KNOWN_SETTING_KEYS} and for a non-empty string value, in the order the
 * body declares them, so the first bad key is the one the refusal names.
 *
 * @param body Already parsed request body (untrusted).
 * @returns The project id and the patch to write, or the refusal to answer with.
 */
function readPatch(
  body: unknown,
):
  | { projectId: number; patch: Record<string, string> }
  | { refusal: { status: number; error: string; message: string } } {
  if (!isObject(body)) {
    return { refusal: { status: 400, error: 'invalid_body', message: 'the body has to be a JSON object' } };
  }

  const { project_id: rawProjectId, ...rest } = body;
  const projectId = parseProjectId(
    rawProjectId === undefined || rawProjectId === null ? undefined : String(rawProjectId),
  );
  if (projectId === undefined) {
    return {
      refusal: {
        status: 400,
        error: 'invalid_filter',
        message: 'project_id has to be an integer',
      },
    };
  }

  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (!KNOWN_SETTING_KEYS.includes(key)) {
      return {
        refusal: {
          status: 400,
          error: 'unknown_setting',
          message: `"${key}" is not a known setting — the only keys v0 accepts are ${KNOWN_SETTING_KEYS.join(', ')}`,
        },
      };
    }
    if (typeof value !== 'string' || value === '') {
      return {
        refusal: {
          status: 400,
          error: 'invalid_setting_value',
          message: `"${key}" has to be a non-empty string`,
        },
      };
    }
    patch[key] = value;
  }

  return { projectId, patch };
}

/**
 * Registers the settings routes in the given scope (already carrying `/v1`).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerSettings(app: FastifyInstance, db: Database): void {
  app.get<SettingsQuery>('/settings', async (request, reply) => {
    const projectId = parseProjectId(request.query.project_id);
    if (projectId === undefined) {
      return refusal(reply, 400, 'invalid_filter', undefined, { field: 'project_id' });
    }

    return { project_id: projectId, ...getSettings(db, projectId) };
  });

  app.patch('/settings', async (request, reply) => {
    const read = readPatch(request.body);
    if ('refusal' in read) {
      const { status, error, message } = read.refusal;
      return refusal(reply, status, error, message);
    }

    return { project_id: read.projectId, ...updateSettings(db, read.projectId, read.patch) };
  });
}
