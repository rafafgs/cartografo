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
 * The request and response field names are the migration's columns, so they
 * stay in Portuguese (t127, FR8). The two values of `origem` stay English:
 * they are the `EngineAdapter`'s vocabulary, produced by the adapter, on the
 * same terms as `timeout_reason`'s `wall_clock`/`silence`.
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

interface NameParam {
  Params: { name: string };
}

/** A refusal, in the `erro`/`mensagem` shape the rest of the API answers with. */
interface Refusal {
  erro: string;
  mensagem: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  const declared = isObject(body) ? body.modelos : undefined;
  if (!Array.isArray(declared)) {
    return {
      refusal: {
        erro: 'modelos_obrigatorio',
        mensagem: 'a report declares "modelos" as a list — an empty list is how an engine says it offers nothing',
      },
    };
  }

  const models: ReportedModel[] = [];
  for (const [index, entry] of declared.entries()) {
    if (!isObject(entry) || !isFilledText(entry.modelo_id)) {
      return {
        refusal: {
          erro: 'modelo_invalido',
          mensagem: `model #${index}: "modelo_id" has to be a non-empty string — it is what goes after the engine's model flag`,
        },
      };
    }
    if (typeof entry.origem !== 'string' || !MODEL_ORIGINS.includes(entry.origem as ModelOrigin)) {
      return {
        refusal: {
          erro: 'origem_invalida',
          mensagem: `model #${index}: "origem" has to be one of ${MODEL_ORIGINS.join(', ')} — the difference between "the engine confirmed it" and "the adapter believes it" is not a detail`,
        },
      };
    }
    if (entry.rotulo !== undefined && entry.rotulo !== null && typeof entry.rotulo !== 'string') {
      return {
        refusal: {
          erro: 'modelo_invalido',
          mensagem: `model #${index}: "rotulo", when sent, has to be a string`,
        },
      };
    }

    models.push({
      modelo_id: entry.modelo_id.trim(),
      rotulo: typeof entry.rotulo === 'string' ? entry.rotulo : null,
      origem: entry.origem as ModelOrigin,
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
      reply.code(400);
      return {
        erro: 'motor_invalido',
        mensagem: 'the engine names itself: :name has to be a non-empty string',
      } satisfies Refusal;
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

  app.get('/engines', async () => ({ motores: listEngineCatalogs(db) }));
}
