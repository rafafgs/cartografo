/**
 * Engine model-discovery routes (t166, FR13).
 *
 * Two routes on opposite sides of the credential gate, and the split is the
 * point:
 *
 * - **`POST /v1/engines/:name/models`** is the runner's. It is one explicit
 *   line in `auth.ts`'s allowlist, because reporting what THIS machine can run
 *   is exactly what a runner credential is for, and because widening that list
 *   is a decision somebody takes on purpose, in one place.
 * - **`GET /v1/engines`** is the operator's, and by omission — the same
 *   reasoning `GET /v1/runners` already wrote down. A runner has no operational
 *   need to read what the rest of the fleet can run, and a credential that
 *   could would turn one compromised machine into a map of every other one.
 *
 * "Refresh" is restarting the runner process. There is no polling loop, no TTL
 * and no cache to invalidate: a runner that comes back reports what is true
 * now, exactly as `POST /v1/runners` already treats re-pairing.
 *
 * Since t226 the request and response field names are English
 * (`docs/spec/glossario-wire.md` §1): a report declares `models`, each with
 * `model_id`, `label` and `source`. The two VALUES of `source` were already
 * English and stay so — they are the `EngineAdapter`'s vocabulary, produced by
 * the adapter, on the same terms as `timeout_reason`'s `wall_clock`/`silence`.
 * The columns behind all of it are untouched (D20's fourth child), and since
 * t290 so is every field name between here and them: `ReportedModel` declares
 * the three words the body already used.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import {
  listEngineCatalogs,
  reportEngineModels,
  MODEL_ORIGINS,
  type ModelOrigin,
  type ReportedModel,
} from '../repositories/engine-models.ts';
import { isObject } from '../util/is-object.ts';
import { refusal, type ErrorResponse } from './common.ts';

interface NameParam {
  Params: { name: string };
}

/** A refusal, in the one envelope the rest of the API answers with. */
type Refusal = ErrorResponse;

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Reads the reported catalog out of a request body.
 *
 * Every entry is checked BEFORE anything is written, and that ordering is the
 * whole guarantee: a report whose fourth model is malformed leaves the previous
 * catalog exactly as it was, instead of replacing it with three quarters of a
 * new one.
 *
 * @param body Already parsed request body (untrusted).
 * @returns The models to store, or the refusal to answer with.
 */
function readReport(body: unknown): { models: ReportedModel[] } | { refusal: Refusal } {
  const declared = isObject(body) ? body.models : undefined;
  if (!Array.isArray(declared)) {
    return {
      refusal: {
        error: 'models_required',
        message: 'a report declares "models" as a list — an empty list is how an engine says it offers nothing',
      },
    };
  }

  const models: ReportedModel[] = [];
  for (const [index, entry] of declared.entries()) {
    if (!isObject(entry) || !isFilledText(entry.model_id)) {
      return {
        refusal: {
          error: 'invalid_model',
          message: `model #${index}: "model_id" has to be a non-empty string — it is what goes after the engine's model flag`,
        },
      };
    }
    if (typeof entry.source !== 'string' || !MODEL_ORIGINS.includes(entry.source as ModelOrigin)) {
      return {
        refusal: {
          error: 'invalid_source',
          message: `model #${index}: "source" has to be one of ${MODEL_ORIGINS.join(', ')} — the difference between "the engine confirmed it" and "the adapter believes it" is not a detail`,
        },
      };
    }
    if (entry.label !== undefined && entry.label !== null && typeof entry.label !== 'string') {
      return {
        refusal: {
          error: 'invalid_model',
          message: `model #${index}: "label", when sent, has to be a string`,
        },
      };
    }

    models.push({
      model_id: entry.model_id.trim(),
      label: typeof entry.label === 'string' ? entry.label : null,
      source: entry.source as ModelOrigin,
    });
  }

  return { models };
}

/**
 * Registers the engine routes in the given scope (already carrying `/v1`).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerEngines(app: FastifyInstance, db: Database): void {
  app.post<NameParam>('/engines/:name/models', async (request, reply) => {
    const name = request.params.name.trim();
    if (name === '') {
      return refusal(
        reply,
        400,
        'invalid_engine',
        'the engine names itself: :name has to be a non-empty string',
      );
    }

    const read = readReport(request.body);
    if ('refusal' in read) {
      reply.code(400);
      return read.refusal;
    }

    // The whole catalog goes in one call, replacing what was there. The engine
    // it just wrote is echoed back because it is the ONLY place an emptied
    // catalog stays visible — with no model row, `GET /v1/engines` has nothing
    // left to carry the name.
    return reportEngineModels(db, name, read.models);
  });

  app.get('/engines', async () => ({ engines: listEngineCatalogs(db) }));
}
