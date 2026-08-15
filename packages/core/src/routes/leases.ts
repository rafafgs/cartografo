/**
 * Lease routes (t103, FR5–FR9) — D5's dispatch queue, seen from the server.
 *
 * Four verbs cover the whole cycle: ask, beat a heartbeat, release and look. The
 * life cycle is the same on every path — `ativa` → `liberada` (the owner
 * finished) or `ativa` → `expirada` (the owner went quiet) — and no row
 * disappears.
 *
 * Two contract choices worth explaining:
 *
 * - **A refusal is not an error.** A cap reached and a job that already has an
 *   owner return `200` with `{lease: null, motivo}`, not `409`. From the
 *   runner's point of view that is "not now, try the next one", and it is the
 *   common case of a healthy pool — not the exception. Errors are left for what
 *   is an error: an invalid body (`400`), an unknown runner (`404`), a
 *   heartbeat/release over a lease that is no longer active (`409`).
 * - **Reconciling is part of asking**, never a separate sweep (FR9): whoever
 *   asks for work is whoever discovers that a lease died, in the same
 *   transaction that replaces it. An independent sweep route only makes sense
 *   once there is a concrete consumer (the screen, a project whose runners are
 *   all idle).
 *
 * Since t143 these four verbs are the only ones a `runner`-type credential may
 * reach (`auth.ts`), and inside them it may act **only as itself** (FR3): being
 * on the allowlist says which routes, and the checks below say which runner.
 * Without the second half the first is nearly worthless — one live runner token
 * could grant leases as any other runner, kill their heartbeats and release
 * their work, which is exactly the blast radius issuing one credential per
 * runner exists to shrink.
 *
 * `runner_id` is compared and never inferred: the body keeps declaring it, so
 * an operator credential (and the clock-injected assembly in the tests, which
 * has no gate at all) behaves exactly as it did before.
 *
 * `trabalho_id` is an opaque integer here: the `trabalho` table belongs to t102
 * and this route does not read it. Whoever filters eligibility is the
 * controller, through `GET /v1/jobs`.
 *
 * The request/response field names and the status/reason values stay in
 * Portuguese: they mirror the untouched migration columns and are the wire shape
 * the runner parses (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import { credentialRunnerId, outOfScope } from '../auth.ts';
import type { Database } from '../db/connection.ts';
import {
  getLease,
  grantLease,
  releaseLease,
  listLeases,
  renewLease,
  type LeaseFilters,
  type LeaseStatus,
} from '../repositories/leases.ts';
import { getRunner } from '../repositories/runners.ts';

interface IdParam {
  Params: { id: string };
}

interface ListQuery {
  Querystring: { projeto_id?: string; runner_id?: string; status?: string };
}

const VALID_STATUSES: LeaseStatus[] = ['ativa', 'liberada', 'expirada'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Resolves the route's `:id`; a non-numeric id is a 404, not a 500. */
function routeId(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Registers the lease routes in the given scope (already carrying the /v1 prefix).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 * @param options Injectable clock, passed on to the repositories. In production
 *   it is empty; it exists so the expiration tests can control time without a
 *   `sleep`.
 */
export function registerLeases(
  app: FastifyInstance,
  db: Database,
  options: { now?: () => string } = {},
): void {
  app.post('/leases', async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};

    const runnerId = body.runner_id;
    if (typeof runnerId !== 'string' || runnerId.trim() === '') {
      reply.code(400);
      return { erro: 'corpo_invalido', campo: 'runner_id' };
    }

    // Before the rest of the body is even looked at: whether the caller may
    // speak for this runner is a question about the credential, and it does not
    // become more or less true depending on the TTL being an integer (FR3).
    const caller = credentialRunnerId(request);
    if (caller !== null && caller !== runnerId) {
      reply.code(403);
      return outOfScope(
        `credencial do runner "${caller}" não pede lease para "${runnerId}": ela vale por uma identidade só`,
      );
    }

    for (const field of ['projeto_id', 'trabalho_id', 'teto_runner', 'teto_projeto'] as const) {
      if (!isInteger(body[field])) {
        reply.code(400);
        return { erro: 'corpo_invalido', campo: field, mensagem: `${field} precisa ser inteiro` };
      }
    }

    if (!isInteger(body.ttl_segundos) || body.ttl_segundos <= 0) {
      reply.code(400);
      return {
        erro: 'corpo_invalido',
        campo: 'ttl_segundos',
        mensagem: 'ttl_segundos precisa ser inteiro positivo: lease sem prazo não expira',
      };
    }

    // A lease is the right of a paired runner. An unknown id is not a capacity
    // refusal — it is a runner that does not exist for the control plane.
    if (getRunner(db, runnerId) === undefined) {
      reply.code(404);
      return { erro: 'runner_desconhecido', runner_id: runnerId };
    }

    const result = grantLease(
      db,
      {
        runner_id: runnerId,
        projeto_id: body.projeto_id as number,
        trabalho_id: body.trabalho_id as number,
        teto_runner: body.teto_runner as number,
        teto_projeto: body.teto_projeto as number,
        ttl_segundos: body.ttl_segundos,
      },
      options,
    );

    if (result.lease === null) return result;

    reply.code(201);
    return { lease: result.lease };
  });

  app.post<IdParam>('/leases/:id/heartbeats', async (request, reply) => {
    const id = routeId(request.params.id);
    const lease = id === undefined ? undefined : getLease(db, id);
    if (lease === undefined) {
      reply.code(404);
      return { erro: 'lease_desconhecida', id: request.params.id };
    }

    const beating = credentialRunnerId(request);
    if (beating !== null && beating !== lease.runner_id) {
      reply.code(403);
      return outOfScope(
        `lease ${lease.id} é do runner "${lease.runner_id}"; a credencial apresentada é do runner "${beating}"`,
      );
    }

    if (lease.status !== 'ativa') {
      reply.code(409);
      return {
        erro: 'lease_nao_ativa',
        mensagem: `só lease ativa recebe heartbeat; esta está "${lease.status}"`,
        status: lease.status,
      };
    }

    const body = isObject(request.body) ? request.body : {};
    const ttl = body.ttl_segundos;
    if (ttl !== undefined && (!isInteger(ttl) || ttl <= 0)) {
      reply.code(400);
      return { erro: 'corpo_invalido', campo: 'ttl_segundos' };
    }

    return { lease: renewLease(db, { id: lease.id, ttl_segundos: ttl }, options) };
  });

  app.post<IdParam>('/leases/:id/releases', async (request, reply) => {
    const id = routeId(request.params.id);
    const lease = id === undefined ? undefined : getLease(db, id);
    if (lease === undefined) {
      reply.code(404);
      return { erro: 'lease_desconhecida', id: request.params.id };
    }

    const releasing = credentialRunnerId(request);
    if (releasing !== null && releasing !== lease.runner_id) {
      reply.code(403);
      return outOfScope(
        `lease ${lease.id} é do runner "${lease.runner_id}"; a credencial apresentada é do runner "${releasing}"`,
      );
    }

    if (lease.status !== 'ativa') {
      reply.code(409);
      return {
        erro: 'lease_nao_ativa',
        mensagem: `só lease ativa pode ser liberada; esta está "${lease.status}"`,
        status: lease.status,
      };
    }

    return { lease: releaseLease(db, lease.id, options) };
  });

  app.get<ListQuery>('/leases', async (request, reply) => {
    const { projeto_id: project, runner_id: runner, status } = request.query;
    const filters: LeaseFilters = {};

    if (project !== undefined) {
      const parsed = Number(project);
      if (!Number.isInteger(parsed)) {
        reply.code(400);
        return { erro: 'filtro_invalido', campo: 'projeto_id' };
      }
      filters.projeto_id = parsed;
    }

    // A runner listing leases lists its OWN: an omitted filter is filled in
    // silently (there is only one answer it could have wanted), and naming
    // somebody else is refused instead of quietly rewritten — a listing that
    // answers a question different from the one asked is worse than a 403.
    const looking = credentialRunnerId(request);
    if (looking !== null && runner !== undefined && runner !== looking) {
      reply.code(403);
      return outOfScope(
        `credencial do runner "${looking}" não lista leases de "${runner}": ela vale por uma identidade só`,
      );
    }

    if (looking !== null) filters.runner_id = looking;
    else if (runner !== undefined) filters.runner_id = runner;

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status as LeaseStatus)) {
        reply.code(400);
        return { erro: 'filtro_invalido', campo: 'status', esperado: VALID_STATUSES };
      }
      filters.status = status as LeaseStatus;
    }

    return { leases: listLeases(db, filters) };
  });
}
