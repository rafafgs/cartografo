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
 *   owner return `200` with `{lease: null, reason}`, not `409`. From the
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
 *   body keeps carrying `runner_cap`/`project_cap` — a runner knows things
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
 * `job_id` is an opaque integer here: these four verbs never look the job up,
 * and the column carries no foreign key (`migrations/0004_runner_lease.sql`).
 * A lease is about who holds WHAT, not about whether the what is eligible —
 * that judgement belongs to the controller, which filters through
 * `GET /v1/jobs` before it ever asks for one.
 *
 * Since t226 every field and every status/reason value on this wire is English
 * (`docs/spec/glossario-wire.md` §1.5/§1.6). The columns are not: the
 * translation is `repositories/leases.ts`'s `toLease`/`toGrantResult` on the way
 * out and `leaseStatusColumn` plus the body reads below on the way in, and the
 * comparisons in this file keep reading the ROW (`lease.status !== 'ativa'`)
 * because the migration is D20's fourth child.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { credentialRunnerId, outOfScope } from '../auth.ts';
import type { Database } from '../db/connection.ts';
import {
  getLease,
  grantLease,
  leaseStatusColumn,
  releaseLease,
  listLeases,
  renewLease,
  toGrantResult,
  toLease,
  LEASE_STATUSES,
  type LeaseFilters,
  type LeaseRow,
} from '../repositories/leases.ts';
import { getRunner } from '../repositories/runners.ts';
import { isObject } from '../util/is-object.ts';
import { refusal } from './common.ts';

interface IdParam {
  Params: { id: string };
}

interface ListQuery {
  Querystring: { project_id?: string; runner_id?: string; status?: string };
}

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
      return refusal(reply, 400, 'invalid_body', undefined, { field: 'runner_id' });
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

    for (const field of ['project_id', 'job_id', 'runner_cap', 'project_cap'] as const) {
      if (!isInteger(body[field])) {
        return refusal(reply, 400, 'invalid_body', `${field} has to be an integer`, { field });
      }
    }

    if (!isInteger(body.ttl_seconds) || body.ttl_seconds <= 0) {
      return refusal(
        reply,
        400,
        'invalid_body',
        'ttl_seconds has to be a positive integer: a lease with no deadline never expires',
        { field: 'ttl_seconds' },
      );
    }

    // A lease is the right of a paired runner. An unknown id is not a capacity
    // refusal — it is a runner that does not exist for the control plane.
    if (getRunner(db, runnerId) === undefined) {
      return refusal(reply, 404, 'unknown_runner', undefined, { runner_id: runnerId });
    }

    // The clamp, and not a refusal: a declaration above the ceiling is not a
    // malformed request, it is a runner asking for more than this control plane
    // hands out. It gets what there is, and the refusal that follows is the
    // ordinary `{lease: null, reason}` — same contract as any other full cap.
    const result = grantLease(
      db,
      {
        runner_id: runnerId,
        projeto_id: body.project_id as number,
        trabalho_id: body.job_id as number,
        teto_runner: Math.min(body.runner_cap as number, ceilings.runner),
        teto_projeto: Math.min(body.project_cap as number, ceilings.projeto),
        ttl_segundos: body.ttl_seconds,
      },
      options,
    );

    const granted = toGrantResult(result);
    if (granted.lease === null) return granted;

    reply.code(201);
    return granted;
  });

  app.post<IdParam>('/leases/:id/heartbeats', async (request, reply) => {
    const id = routeId(request.params.id);
    const lease = id === undefined ? undefined : getLease(db, id);
    if (lease === undefined) {
      return refusal(reply, 404, 'unknown_lease', undefined, { id: request.params.id });
    }

    const beating = credentialRunnerId(request);
    if (beating !== null && beating !== lease.runner_id) {
      reply.code(403);
      return outOfScope(
        `lease ${lease.id} belongs to runner "${lease.runner_id}"; the credential presented belongs to runner "${beating}"`,
      );
    }

    if (lease.status !== 'ativa') return notActive(reply, lease, 'takes a heartbeat');

    const body = isObject(request.body) ? request.body : {};
    const ttl = body.ttl_seconds;
    if (ttl !== undefined && (!isInteger(ttl) || ttl <= 0)) {
      return refusal(reply, 400, 'invalid_body', undefined, { field: 'ttl_seconds' });
    }

    return { lease: toLease(renewLease(db, { id: lease.id, ttl_segundos: ttl }, options)) };
  });

  app.post<IdParam>('/leases/:id/releases', async (request, reply) => {
    const id = routeId(request.params.id);
    const lease = id === undefined ? undefined : getLease(db, id);
    if (lease === undefined) {
      return refusal(reply, 404, 'unknown_lease', undefined, { id: request.params.id });
    }

    const releasing = credentialRunnerId(request);
    if (releasing !== null && releasing !== lease.runner_id) {
      reply.code(403);
      return outOfScope(
        `lease ${lease.id} belongs to runner "${lease.runner_id}"; the credential presented belongs to runner "${releasing}"`,
      );
    }

    if (lease.status !== 'ativa') return notActive(reply, lease, 'can be released');

    return { lease: toLease(releaseLease(db, lease.id, options)) };
  });

  app.get<ListQuery>('/leases', async (request, reply) => {
    const { project_id: project, runner_id: runner, status } = request.query;
    const filters: LeaseFilters = {};

    if (project !== undefined) {
      const parsed = Number(project);
      if (!Number.isInteger(parsed)) {
        return refusal(reply, 400, 'invalid_filter', undefined, { field: 'project_id' });
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
      const column = leaseStatusColumn(status);
      if (column === undefined) {
        return refusal(reply, 400, 'invalid_filter', undefined, {
          field: 'status',
          expected: LEASE_STATUSES,
        });
      }
      filters.status = column;
    }

    const leases = listLeases(db, filters);
    return { leases: leases.map(toLease) };
  });
}

/**
 * The 409 the heartbeat and the release share: this lease is no longer active.
 *
 * @param reply Fastify reply, marked 409.
 * @param lease The lease, still in its row form.
 * @param what What only an active lease does, as the sentence continues.
 * @returns The refusal body.
 */
function notActive(reply: FastifyReply, lease: LeaseRow, what: string): Record<string, unknown> {
  const status = toLease(lease).status;
  return refusal(reply, 409, 'lease_not_active', `only an active lease ${what}; this one is "${status}"`, {
    status,
  });
}
