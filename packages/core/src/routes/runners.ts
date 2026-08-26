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
 * Since t226 the request and response field names are English
 * (`docs/spec/glossary-wire.md` §1): the pairing body declares `name`, and what
 * comes back is the repository's own row. Since t290 there is nothing between
 * the two — `registerRunner` returns a `Runner` spelled exactly the way the
 * columns are, so this file hands it back untouched instead of through a
 * `toRunner` that renamed two fields.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { issueCredential, revokeRunnerCredentials } from '../repositories/credentials.ts';
import { getRunner, listRunnersWithHealth, registerRunner } from '../repositories/runners.ts';
import { isObject } from '../util/is-object.ts';
import { refusal } from './common.ts';

interface IdParam {
  Params: { id: string };
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
      return refusal(
        reply,
        400,
        'id_required',
        'a runner declares its own identity: id has to be a non-empty string',
      );
    }

    const name = body.name;
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return refusal(reply, 400, 'invalid_name', 'name, when sent, has to be a string');
    }

    const { runner, created } = registerRunner(db, { id, name: name ?? null });

    // AFTER the runner row exists, and it has to be: `credencial.runner_id`
    // references `runner(id)`, so minting first would be a foreign-key error
    // dressed up as a 500.
    const token = created ? issueCredential(db, { type: 'runner', runnerId: runner.id }).token : null;

    reply.code(created ? 201 : 200);
    return { runner, token };
  });

  // The fleet, with the liveness the lease table already recorded (t164, FR1).
  // Operator-only, and by omission: it is not in `auth.ts`'s runner allowlist,
  // exactly like `GET /v1/executions` and `GET /v1/sessions` — a runner has no
  // operational need to read how the rest of the fleet is doing, and a
  // credential that could would turn one compromised machine into a map of
  // every other one.
  app.get('/runners', async () => ({ runners: listRunnersWithHealth(db) }));

  app.post<IdParam>('/runners/:id/revocations', async (request, reply) => {
    const { id } = request.params;

    // An id nobody ever paired is not "zero revoked": it is a typo, and telling
    // the two apart is the difference between "done" and "you decommissioned
    // nothing". Same vocabulary `leases.ts` answers for the same condition.
    if (getRunner(db, id) === undefined) {
      return refusal(reply, 404, 'unknown_runner', undefined, { runner_id: id });
    }

    return { revoked: revokeRunnerCredentials(db, id) };
  });
}
