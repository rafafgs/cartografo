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
 *
 * ## The probe and the re-check (t401)
 *
 * Three more routes, on the two sides of the credential gate the model-catalog
 * pair already sits on:
 *
 * - **`POST /v1/runners/:id/probes`** is the runner's, by one explicit line in
 *   `auth.ts`, because reporting what THIS machine is is exactly what a runner
 *   credential is for. Inside it the credential still holds for ONE identity:
 *   another runner's `:id` is `403 out_of_scope_credential`, the same check
 *   `POST /v1/leases` makes against the `runner_id` it was handed.
 * - **`GET /v1/runners/:id/rechecks`** is the runner's too, and scoped the same
 *   way: a machine asking whether anybody wants it to report again.
 * - **`POST /v1/runners/:id/rechecks`** is the operator's, by OMISSION — the
 *   reasoning `GET /v1/engines` already wrote down. Ordering another machine to
 *   re-probe is the operator's job, and a runner credential that could do it
 *   would be one compromised machine reaching into the rest of the fleet.
 *
 * There is deliberately no fourth route acknowledging a re-check. Storing a
 * probe is what serves whatever was pending, in the repository's own
 * transaction: a fresh report IS the answer to the request, whether an operator
 * asked for it or the runner was simply starting up.
 *
 * `GET /v1/runners` embeds each runner's latest probe, and the merge is done
 * HERE rather than inside `listRunnersWithHealth`: the fleet's liveness comes
 * out of the `lease` table and the probe out of `runner_probe`, and keeping the
 * two repositories independent is what lets either one change without the
 * other. Who may call that route did not move.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { credentialRunnerId, outOfScope } from '../auth.ts';
import type { Database } from '../db/connection.ts';
import { issueCredential, revokeRunnerCredentials } from '../repositories/credentials.ts';
import {
  MCP_ORIGINS,
  getPendingRunnerRecheck,
  listRunnerProbes,
  reportRunnerProbe,
  requestRunnerRecheck,
  type McpOrigin,
  type ProbeReport,
} from '../repositories/runner-probes.ts';
import { getRunner, listRunnersWithHealth, registerRunner } from '../repositories/runners.ts';
import { isObject } from '../util/is-object.ts';
import { refusal, type ErrorResponse } from './common.ts';

interface IdParam {
  Params: { id: string };
}

/** A refusal, in the one envelope the rest of the API answers with. */
interface Refusal {
  /** Dotted path of what was wrong — `cli.available`, `workspace.working_dir`. */
  field: string;
  message: string;
}

/**
 * Reads a probe report out of a request body.
 *
 * Every field is checked BEFORE anything is written, and that ordering is the
 * whole guarantee — the same one `readReport` states in `routes/engines.ts`: a
 * report whose `workspace` is malformed leaves the previous probe exactly as it
 * was, instead of replacing it with two thirds of a new one.
 *
 * The `mcp` half is read as a discriminated union and not as an object with
 * nullable fields, because that is what it IS: `{supported: false}` says the
 * adapter does not implement discovery at all, and an empty `servers` list in
 * its place would tell an operator a lie about their own machine
 * (`packages/runner/src/engine/types.ts`, `discoverMcpServers?()`).
 *
 * @param body Already parsed request body (untrusted).
 * @returns The report to store, or the refusal to answer with.
 */
function readProbeReport(body: unknown): { report: ProbeReport } | { refusal: Refusal } {
  const root = isObject(body) ? body : {};

  const cli = isObject(root.cli) ? root.cli : undefined;
  if (cli === undefined) {
    return { refusal: { field: 'cli', message: 'a report declares "cli": the engine preflight' } };
  }
  for (const key of ['available', 'authenticated'] as const) {
    if (typeof cli[key] !== 'boolean') {
      return {
        refusal: {
          field: `cli.${key}`,
          message: `cli.${key} has to be a boolean — "the CLI did not answer" is itself a fact worth reporting, never an omission`,
        },
      };
    }
  }
  if (cli.version !== undefined && cli.version !== null && typeof cli.version !== 'string') {
    return { refusal: { field: 'cli.version', message: 'cli.version, when sent, has to be a string' } };
  }

  const mcp = isObject(root.mcp) ? root.mcp : undefined;
  if (mcp === undefined || typeof mcp.supported !== 'boolean') {
    return {
      refusal: {
        field: 'mcp.supported',
        message:
          'mcp.supported has to be a boolean — an engine with no discovery and an engine that found nothing are different facts',
      },
    };
  }

  let discovery: ProbeReport['mcp'] = { supported: false };
  if (mcp.supported) {
    if (!Array.isArray(mcp.servers)) {
      return {
        refusal: {
          field: 'mcp.servers',
          message: 'mcp.servers has to be a list when mcp.supported is true — an empty one is how an engine says it sees none',
        },
      };
    }
    const servers: Array<{ name: string }> = [];
    for (const [index, entry] of mcp.servers.entries()) {
      if (!isObject(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
        return {
          refusal: {
            field: 'mcp.servers',
            message: `mcp.servers #${index}: "name" has to be a non-empty string — the name is the only thing both engines agree on`,
          },
        };
      }
      servers.push({ name: entry.name.trim() });
    }

    if (typeof mcp.origin !== 'string' || !MCP_ORIGINS.includes(mcp.origin as McpOrigin)) {
      return {
        refusal: {
          field: 'mcp.origin',
          message: `mcp.origin has to be one of ${MCP_ORIGINS.join(', ')} — "the engine answered" and "its files were read" can disagree`,
        },
      };
    }
    if (
      mcp.resolved_at !== undefined &&
      mcp.resolved_at !== null &&
      typeof mcp.resolved_at !== 'string'
    ) {
      return {
        refusal: { field: 'mcp.resolved_at', message: 'mcp.resolved_at, when sent, has to be a string' },
      };
    }

    discovery = {
      supported: true,
      servers,
      origin: mcp.origin as McpOrigin,
      resolved_at: typeof mcp.resolved_at === 'string' ? mcp.resolved_at : null,
    };
  }

  const workspace = isObject(root.workspace) ? root.workspace : undefined;
  if (workspace === undefined) {
    return {
      refusal: {
        field: 'workspace',
        message: 'a report declares "workspace": what the machine\'s own directories look like',
      },
    };
  }
  for (const key of ['working_dir', 'working_dir_resolved', 'worktrees_root', 'worktrees_root_resolved'] as const) {
    if (typeof workspace[key] !== 'string' || (workspace[key] as string).trim() === '') {
      return {
        refusal: { field: `workspace.${key}`, message: `workspace.${key} has to be a non-empty string` },
      };
    }
  }
  for (const key of ['is_git_repo', 'worktrees_root_exists', 'worktrees_root_writable'] as const) {
    if (typeof workspace[key] !== 'boolean') {
      return { refusal: { field: `workspace.${key}`, message: `workspace.${key} has to be a boolean` } };
    }
  }

  return {
    report: {
      // Cast at the assembly and not narrowed in place: the checks above run in
      // a loop over the field names, which is what keeps one message per field
      // from being seven copies of the same three lines — and a loop is exactly
      // what a control-flow narrowing cannot follow out of.
      cli: {
        available: cli.available as boolean,
        version: typeof cli.version === 'string' ? cli.version : null,
        authenticated: cli.authenticated as boolean,
      },
      mcp: discovery,
      workspace: {
        working_dir: workspace.working_dir as string,
        working_dir_resolved: workspace.working_dir_resolved as string,
        is_git_repo: workspace.is_git_repo as boolean,
        worktrees_root: workspace.worktrees_root as string,
        worktrees_root_resolved: workspace.worktrees_root_resolved as string,
        worktrees_root_exists: workspace.worktrees_root_exists as boolean,
        worktrees_root_writable: workspace.worktrees_root_writable as boolean,
      },
    },
  };
}

/**
 * The `403` a runner credential gets for another runner's `:id`.
 *
 * Copied in shape from `routes/leases.ts`, which asks the identical question of
 * `POST /v1/leases` and of both lease routes that take an `:id`: a credential is
 * good for ONE identity, and reaching past it is a different refusal from
 * reaching outside the allowlist even though both answer the same code.
 *
 * @param request Request already past the gate.
 * @param runnerId The `:id` the route was called for.
 * @param action What the caller was trying to do, for the message.
 * @returns The refusal body, or `null` when the caller may proceed.
 */
function outOfScopeForRunner(
  request: FastifyRequest,
  runnerId: string,
  action: string,
): ErrorResponse | null {
  const caller = credentialRunnerId(request);
  if (caller === null || caller === runnerId) return null;
  return outOfScope(
    `the credential of runner "${caller}" does not ${action} for "${runnerId}": it is good for one identity only`,
  );
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
  app.get('/runners', async () => {
    // Two queries and a join in memory, the shape `listRunnersWithHealth`
    // already uses for its own two: reading the probes one runner at a time
    // would be an N+1 that grows with the fleet.
    const probes = listRunnerProbes(db);
    return {
      runners: listRunnersWithHealth(db).map((runner) => ({
        ...runner,
        // `null` for a runner that never reported, and it is a real answer: a
        // machine that has said nothing about itself is a different state from
        // one that reported a CLI it could not find.
        probe: probes.get(runner.id) ?? null,
      })),
    };
  });

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

  app.post<IdParam>('/runners/:id/probes', async (request, reply) => {
    const { id } = request.params;

    // Before the body is even looked at: whether the caller may speak for this
    // runner is a question about the credential, and it does not become more or
    // less true depending on `mcp.origin` being spelled right (FR2).
    const refused = outOfScopeForRunner(request, id, 'report a probe');
    if (refused !== null) {
      reply.code(403);
      return refused;
    }

    if (getRunner(db, id) === undefined) {
      return refusal(reply, 404, 'unknown_runner', undefined, { runner_id: id });
    }

    const read = readProbeReport(request.body);
    if ('refusal' in read) {
      return refusal(reply, 400, 'invalid_body', read.refusal.message, { field: read.refusal.field });
    }

    // Storing it is also what serves a pending re-check, in the repository's own
    // transaction (FR6): a fresh probe IS the answer to the request.
    return { probe: reportRunnerProbe(db, id, read.report) };
  });

  // The operator's half of the pair, and operator-only by omission — the same
  // reasoning `GET /v1/engines` already wrote down. Asking a machine to report
  // again is fleet management, and a runner credential that could do it for
  // another `:id` would turn one compromised machine into a lever on the rest.
  app.post<IdParam>('/runners/:id/rechecks', async (request, reply) => {
    const { id } = request.params;

    if (getRunner(db, id) === undefined) {
      return refusal(reply, 404, 'unknown_runner', undefined, { runner_id: id });
    }

    // Idempotent while the last request is pending: `200` with the row that was
    // already there, never a second one. An impatient operator clicking twice
    // must not queue two re-checks — same posture `POST /v1/runners` has on
    // re-pairing (D5).
    const { recheck, created } = requestRunnerRecheck(db, id);
    reply.code(created ? 201 : 200);
    return { recheck };
  });

  app.get<IdParam>('/runners/:id/rechecks', async (request, reply) => {
    const { id } = request.params;

    const refused = outOfScopeForRunner(request, id, 'ask about a re-check');
    if (refused !== null) {
      reply.code(403);
      return refused;
    }

    if (getRunner(db, id) === undefined) {
      return refusal(reply, 404, 'unknown_runner', undefined, { runner_id: id });
    }

    return { recheck: getPendingRunnerRecheck(db, id) };
  });
}
