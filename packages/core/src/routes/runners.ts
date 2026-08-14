/**
 * Runner pairing route (t103, FR4).
 *
 * One verb only, and it is idempotent: `201` when the id shows up for the first
 * time, `200` when it was already known. The distinction exists for the operator
 * (knowing whether a runner is new is information), never for the runner — which
 * treats both as success and moves on to the queue.
 *
 * Authenticating the pairing is t124: in this phase the id is declared by the
 * runner itself, like the rest of the pre-authorization API (the same cut as
 * t101/t102).
 *
 * The request/response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { registerRunner } from '../repositories/runners.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Registers the runner routes in the given scope (already carrying the /v1 prefix).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerRunners(app: FastifyInstance, db: Database): void {
  app.post('/runners', async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};

    const id = body.id;
    if (typeof id !== 'string' || id.trim() === '') {
      reply.code(400);
      return {
        erro: 'id_obrigatorio',
        mensagem: 'runner declara a própria identidade: id precisa ser uma string não vazia',
      };
    }

    const name = body.nome;
    if (name !== undefined && name !== null && typeof name !== 'string') {
      reply.code(400);
      return { erro: 'nome_invalido', mensagem: 'nome, quando enviado, precisa ser string' };
    }

    const { runner, created } = registerRunner(db, { id, nome: name ?? null });
    reply.code(created ? 201 : 200);
    return { runner };
  });
}
