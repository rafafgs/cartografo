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
 * - **The runner declares its caps; the server decides them** (t157, FR1). The
 *   body keeps carrying `teto_runner`/`teto_projeto` — a runner knows things
 *   about itself the control plane does not — but what `grantLease` enforces is
 *   `min(declared, ceiling)`, and the ceiling comes from this process's
 *   configuration. Without that half, a request would be declaring AND deciding
 *   its own concurrency, which is exactly the split D1 exists to keep.
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

/**
 * Ceiling of simultaneous active leases per runner, when nothing is configured
 * (t157, FR1).
 *
 * Generous on purpose: it is a backstop against a runner that declares an absurd
 * number, not a capacity policy. A real policy — per project, per runner, out of
 * the database — is a later ticket, and only once a second consumer asks for one
 * (rule of two consumers).
 */
export const DEFAULT_LEASE_CAP_RUNNER = 50;

/** Ceiling of simultaneous active leases per project, when nothing is configured. */
export const DEFAULT_LEASE_CAP_PROJECT = 50;

/** The two ceilings this process enforces, whatever the request declares. */
export interface LeaseCeilings {
  runner: number;
  projeto: number;
}

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
 * @param options Injectable clock, passed on to the repositories (in production
 *   it is empty; it exists so the expiration tests can control time without a
 *   `sleep`), and the ceilings this process enforces — resolved from the
 *   environment by `start()` and falling back to the two defaults above.
 */
export function registerLeases(
  app: FastifyInstance,
  db: Database,
  options: { now?: () => string; leaseCeilings?: LeaseCeilings } = {},
): void {
  const ceilings: LeaseCeilings = options.leaseCeilings ?? {
    runner: DEFAULT_LEASE_CAP_RUNNER,
    projeto: DEFAULT_LEASE_CAP_PROJECT,
  };

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
        `the credential of runner "${caller}" does not ask for a lease for "${runnerId}": it is good for one identity only`,
      );
    }

    for (const field of ['projeto_id', 'trabalho_id', 'teto_runner', 'teto_projeto'] as const) {
      if (!isInteger(body[field])) {
        reply.code(400);
        return { erro: 'corpo_invalido', campo: field, mensagem: `${field} has to be an integer` };
      }
    }

    if (!isInteger(body.ttl_segundos) || body.ttl_segundos <= 0) {
      reply.code(400);
      return {
        erro: 'corpo_invalido',
        campo: 'ttl_segundos',
        mensagem: 'ttl_segundos has to be a positive integer: a lease with no deadline never expires',
      };
    }

    // A lease is the right of a paired runner. An unknown id is not a capacity
    // refusal — it is a runner that does not exist for the control plane.
    if (getRunner(db, runnerId) === undefined) {
      reply.code(404);
      return { erro: 'runner_desconhecido', runner_id: runnerId };
    }

    // The clamp, and not a refusal: a declaration above the ceiling is not a
    // malformed request, it is a runner asking for more than this control plane
    // hands out. It gets what there is, and the refusal that follows is the
    // ordinary `{lease: null, motivo}` — same contract as any other full cap.
    const result = grantLease(
      db,
      {
        runner_id: runnerId,
        projeto_id: body.projeto_id as number,
        trabalho_id: body.trabalho_id as number,
        teto_runner: Math.min(body.teto_runner as number, ceilings.runner),
        teto_projeto: Math.min(body.teto_projeto as number, ceilings.projeto),
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
        `lease ${lease.id} belongs to runner "${lease.runner_id}"; the credential presented belongs to runner "${beating}"`,
      );
    }

    if (lease.status !== 'ativa') {
      reply.code(409);
      return {
        erro: 'lease_nao_ativa',
        mensagem: `only an active lease takes a heartbeat; this one is "${lease.status}"`,
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
        `lease ${lease.id} belongs to runner "${lease.runner_id}"; the credential presented belongs to runner "${releasing}"`,
      );
    }

    if (lease.status !== 'ativa') {
      reply.code(409);
      return {
        erro: 'lease_nao_ativa',
        mensagem: `only an active lease can be released; this one is "${lease.status}"`,
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
        `the credential of runner "${looking}" does not list leases of "${runner}": it is good for one identity only`,
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
