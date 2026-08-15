/**
 * Runner pairing and decommissioning routes (t103, FR4; t143, FR1/FR4).
 *
 * Pairing is idempotent: `201` when the id shows up for the first time, `200`
 * when it was already known. The distinction exists for the operator (knowing
 * whether a runner is new is information), never for the runner — which treats
 * both as success and moves on to the queue.
 *
 * Since t143 the `201` also carries `token`: the runner's own credential, raw
 * and exactly once, on the same terms as the bootstrap token of `src/index.ts`.
 * The `200` carries `token: null` and mints nothing — re-pairing is what a
 * runner does on every restart, and a route that minted a credential per
 * restart would leave a trail of live tokens nobody can count. It also says
 * NOTHING about whether a live credential already exists: "is this machine
 * still credentialed" is not a question an unauthenticated-by-that-credential
 * caller gets answered for free. The price is spelled out in Out of Scope —
 * a runner whose token was revoked or lost pairs under a NEW id.
 *
 * Both routes are the operator's, enforced in `auth.ts` and not here: neither
 * `POST /v1/runners` nor `POST /v1/runners/:id/revocations` is in the runner
 * allowlist, so a `runner`-type credential — including the one being revoked —
 * gets a `403` before this file runs.
 *
 * The request/response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { issueCredential, revokeRunnerCredentials } from '../repositories/credentials.ts';
import { getRunner, registerRunner } from '../repositories/runners.ts';

interface IdParam {
  Params: { id: string };
}

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

    // AFTER the runner row exists, and it has to be: `credencial.runner_id`
    // references `runner(id)`, so minting first would be a foreign-key error
    // dressed up as a 500.
    const token = created ? issueCredential(db, { tipo: 'runner', runnerId: runner.id }).token : null;

    reply.code(created ? 201 : 200);
    return { runner, token };
  });

  app.post<IdParam>('/runners/:id/revocations', async (request, reply) => {
    const { id } = request.params;

    // An id nobody ever paired is not "zero revoked": it is a typo, and telling
    // the two apart is the difference between "done" and "you decommissioned
    // nothing". Same vocabulary `leases.ts` answers for the same condition.
    if (getRunner(db, id) === undefined) {
      reply.code(404);
      return { erro: 'runner_desconhecido', runner_id: id };
    }

    return { revogadas: revokeRunnerCredentials(db, id) };
  });
}
