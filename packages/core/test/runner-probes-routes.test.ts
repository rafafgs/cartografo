/**
 * The runner-probe and re-check routes (t401, AT1–AT14).
 *
 * `GET /v1/runners` has always answered pairing and lease health, and nothing
 * about whether the paired machine can actually run a session. What these three
 * routes add is the missing half: a runner reports its own `CliProbe`, what its
 * MCP discovery found (or the honest "this engine does not implement it") and a
 * handful of workspace facts, the control plane keeps the LATEST one, and an
 * operator can ask a specific machine to refresh that report without restarting
 * its process.
 *
 * Three claims carry the ticket, and each has a plausible opposite:
 *
 * - **`mcp: {supported: false}` is a fact, not an empty list.** `t400` made
 *   `discoverMcpServers?()` optional on the MEMBER and wrote down why: an
 *   adapter that does not implement discovery is NOT an engine with zero MCP
 *   servers. A wire shape that collapsed the two would erase that discipline one
 *   layer up, so it is pinned here (AT2).
 * - **A report REPLACES the one before it.** One row per runner, latest wins —
 *   the same posture `engine_model` already has, and for the same reason: a
 *   probe merged with an older probe is a machine nobody can describe.
 * - **The three routes sit on two sides of the credential gate.** The two the
 *   runner needs — reporting a probe, asking whether a re-check is pending — are
 *   two explicit lines in `auth.ts`. `POST /v1/runners/:id/rechecks` is the
 *   operator's by OMISSION, the reasoning `GET /v1/engines` already wrote down:
 *   a runner that could order another machine to re-probe would be doing the
 *   operator's job with a machine credential.
 *
 * Inside the runner routes the credential also holds for ONE identity, exactly
 * as it does on `POST /v1/leases`: another runner's `:id` is a `403`, never a
 * silent write into somebody else's row.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { request, requireArtifacts, startControlPlane, type TestContext } from './support.ts';

/** The artifacts this suite exercises; the initial red names the missing one. */
const T401_ARTIFACTS = Object.freeze({
  migration: 'migrations/0028_runner_probe.sql',
  repository: 'src/repositories/runner-probes.ts',
  routes: 'src/routes/runners.ts',
  auth: 'src/auth.ts',
});

/** The `cli` half of a report, as the wire carries it. */
interface ProbeCli {
  available: boolean;
  version: string | null;
  authenticated: boolean;
}

/** The `mcp` half: an engine that cannot answer, or one that did. */
type ProbeMcp =
  | { supported: false }
  | {
      supported: true;
      servers: Array<{ name: string }>;
      origin: 'cli' | 'file';
      resolved_at: string;
    };

/** What the machine's own directories look like from inside the runner. */
interface ProbeWorkspace {
  working_dir: string;
  working_dir_resolved: string;
  is_git_repo: boolean;
  worktrees_root: string;
  worktrees_root_resolved: string;
  worktrees_root_exists: boolean;
  worktrees_root_writable: boolean;
}

interface StoredProbe {
  runner_id: string;
  cli: ProbeCli;
  mcp: ProbeMcp;
  workspace: ProbeWorkspace;
  reported_at: string;
}

interface StoredRecheck {
  id: number;
  runner_id: string;
  requested_at: string;
  served_at: string | null;
}

interface RunnerRow {
  id: string;
  probe: StoredProbe | null;
}

interface ErrorBody {
  error?: string;
  message?: string;
}

/** A request built header by header — this suite needs credentials of its own. */
async function call<T>(
  ctx: TestContext,
  method: string,
  routePath: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${ctx.url}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T };
}

/** Pairs a runner with the operator credential and returns its own token. */
async function pairedRunnerToken(ctx: TestContext, id: string): Promise<string> {
  const paired = await request<{ token: string | null }>(ctx, 'POST', '/v1/runners', { id });
  assert.equal(paired.status, 201);
  assert.equal(typeof paired.body.token, 'string', 'pairing is where a runner credential comes from');
  return paired.body.token ?? '';
}

/** A well-formed report, with whatever this case wants to vary. */
function report(overrides: {
  cli?: Partial<ProbeCli>;
  mcp?: ProbeMcp;
  workspace?: Partial<ProbeWorkspace>;
} = {}): Record<string, unknown> {
  return {
    cli: { available: true, version: '2.1.263', authenticated: true, ...overrides.cli },
    mcp: overrides.mcp ?? {
      supported: true,
      servers: [{ name: 'cartografo' }, { name: 'flowpilot' }],
      origin: 'cli',
      resolved_at: '2026-09-06T12:00:00.000Z',
    },
    workspace: {
      working_dir: '/home/op/cartografo',
      working_dir_resolved: '/home/op/cartografo',
      is_git_repo: true,
      worktrees_root: '/home/op/worktrees',
      worktrees_root_resolved: '/home/op/worktrees',
      worktrees_root_exists: false,
      worktrees_root_writable: true,
      ...overrides.workspace,
    },
  };
}

/** Every runner the operator can see, with whatever probe it reported. */
async function fleet(ctx: TestContext): Promise<RunnerRow[]> {
  const response = await request<{ runners: RunnerRow[] }>(ctx, 'GET', '/v1/runners');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.runners;
}

test('t401 AT1 — a runner reports its own probe and gets the stored shape back', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at1');

  const stored = await call<{ probe: StoredProbe }>(
    ctx,
    'POST',
    '/v1/runners/runner-at1/probes',
    token,
    report(),
  );

  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.deepEqual(stored.body.probe.cli, {
    available: true,
    version: '2.1.263',
    authenticated: true,
  });
  assert.deepEqual(stored.body.probe.mcp, {
    supported: true,
    servers: [{ name: 'cartografo' }, { name: 'flowpilot' }],
    origin: 'cli',
    resolved_at: '2026-09-06T12:00:00.000Z',
  });
  assert.equal(stored.body.probe.workspace.working_dir, '/home/op/cartografo');
  assert.equal(stored.body.probe.workspace.is_git_repo, true);
  assert.equal(stored.body.probe.workspace.worktrees_root_exists, false);
  assert.equal(stored.body.probe.workspace.worktrees_root_writable, true);
  assert.equal(
    typeof stored.body.probe.reported_at,
    'string',
    'a probe with no date cannot be judged stale — the same reason `ModelCatalog.resolvedAt` exists',
  );
});

test('t401 AT2 — `mcp: {supported: false}` survives the round trip as itself', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at2');

  const stored = await call<{ probe: StoredProbe }>(
    ctx,
    'POST',
    '/v1/runners/runner-at2/probes',
    token,
    report({ mcp: { supported: false } }),
  );
  assert.equal(stored.status, 200, JSON.stringify(stored.body));

  // Exactly this object, and no `servers` key beside it: an adapter that does
  // not implement discovery is NOT an engine with zero MCP servers, and an
  // empty list in this slot would tell an operator a lie about their machine
  // (`engine/types.ts`, `discoverMcpServers?()`).
  assert.deepEqual(stored.body.probe.mcp, { supported: false });

  const [runner] = await fleet(ctx);
  assert.deepEqual(runner?.probe?.mcp, { supported: false }, 'and the read side agrees with the write');
});

test('t401 AT3 — a second report replaces the first; the fleet never shows both', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at3');

  await call(ctx, 'POST', '/v1/runners/runner-at3/probes', token, report({ cli: { version: '2.1.263' } }));
  await call(ctx, 'POST', '/v1/runners/runner-at3/probes', token, report({ cli: { version: '2.2.0' } }));

  const runners = await fleet(ctx);
  assert.equal(runners.length, 1, 'a second report is not a second runner');
  assert.equal(
    runners[0]?.probe?.cli.version,
    '2.2.0',
    'latest wins: one row per runner, replaced whole, exactly as `engine_model` already is',
  );
});

test('t401 AT4 — a runner credential cannot report for another runner', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const mine = await pairedRunnerToken(ctx, 'runner-at4-mine');
  await pairedRunnerToken(ctx, 'runner-at4-other');

  const refused = await call<ErrorBody>(
    ctx,
    'POST',
    '/v1/runners/runner-at4-other/probes',
    mine,
    report(),
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'out_of_scope_credential');

  const other = (await fleet(ctx)).find((runner) => runner.id === 'runner-at4-other');
  assert.equal(other?.probe, null, 'a refused report writes nothing into the runner it named');
});

test('t401 AT5 — a probe for a runner that never paired is a 404', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);

  // The operator credential, so the refusal can only be about the id: a runner
  // credential would be out of scope for a name that is not its own first.
  const missing = await request<ErrorBody>(
    ctx,
    'POST',
    '/v1/runners/runner-that-never-was/probes',
    report(),
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.error, 'unknown_runner');
});

test('t401 AT6 — a malformed report is refused by field, and writes nothing', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at6');

  const good = report({ cli: { version: '2.1.263' } });
  await call(ctx, 'POST', '/v1/runners/runner-at6/probes', token, good);

  const malformed: Array<[string, Record<string, unknown>]> = [
    ['cli.available', { ...report(), cli: { version: '9', authenticated: true } }],
    ['mcp.supported', { ...report(), mcp: { supported: 'yes' } }],
    ['workspace.working_dir', { ...report(), workspace: { ...(report().workspace as object), working_dir: undefined } }],
  ];

  for (const [field, body] of malformed) {
    const refused = await call<ErrorBody>(
      ctx,
      'POST',
      '/v1/runners/runner-at6/probes',
      token,
      body,
    );
    assert.equal(refused.status, 400, `${field} should have been refused: ${JSON.stringify(refused.body)}`);
    assert.ok(
      (refused.body.message ?? '').includes(field),
      `a refusal names the offending field ("${field}"); got ${JSON.stringify(refused.body)}`,
    );
  }

  const runners = await fleet(ctx);
  assert.equal(
    runners[0]?.probe?.cli.version,
    '2.1.263',
    'all-or-nothing: a refused report leaves the previous probe exactly as it was',
  );
});

test('t401 AT7 — GET /v1/runners carries `probe: null` until one is reported', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  await pairedRunnerToken(ctx, 'runner-at7-quiet');
  const loud = await pairedRunnerToken(ctx, 'runner-at7-loud');

  const before = await fleet(ctx);
  assert.equal(before.length, 2);
  for (const runner of before) {
    assert.equal(runner.probe, null, `${runner.id} reported nothing, so it publishes nothing`);
  }

  await call(ctx, 'POST', '/v1/runners/runner-at7-loud/probes', loud, report());

  const after = await fleet(ctx);
  assert.equal(after.find((runner) => runner.id === 'runner-at7-quiet')?.probe, null);
  assert.equal(
    after.find((runner) => runner.id === 'runner-at7-loud')?.probe?.cli.available,
    true,
    'and the one that DID report publishes what it said',
  );
});

test('t401 AT8 — asking for a re-check twice while it is pending is idempotent', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  await pairedRunnerToken(ctx, 'runner-at8');

  const first = await request<{ recheck: StoredRecheck }>(
    ctx,
    'POST',
    '/v1/runners/runner-at8/rechecks',
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.recheck.runner_id, 'runner-at8');
  assert.equal(first.body.recheck.served_at, null, 'a fresh request is pending by definition');

  const again = await request<{ recheck: StoredRecheck }>(
    ctx,
    'POST',
    '/v1/runners/runner-at8/rechecks',
  );
  assert.equal(again.status, 200, 'the second call matched what was already pending, it did not create');
  assert.equal(
    again.body.recheck.id,
    first.body.recheck.id,
    'the SAME row comes back: asking twice must not queue two re-checks',
  );
});

test('t401 AT9 — ordering a re-check is the operator\'s, never a runner\'s', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at9');

  // Its OWN id, so nothing about identity can be what refuses it: the route is
  // simply not in the runner allowlist, the way `GET /v1/engines` is not.
  const refused = await call<ErrorBody>(ctx, 'POST', '/v1/runners/runner-at9/rechecks', token);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'out_of_scope_credential');
});

test('t401 AT10 — a re-check for a runner that never paired is a 404', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);

  const missing = await request<ErrorBody>(ctx, 'POST', '/v1/runners/nobody/rechecks');
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body.error, 'unknown_runner');
});

test('t401 AT11 — a runner reads its own pending re-check, and `null` when there is none', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at11');

  const quiet = await call<{ recheck: StoredRecheck | null }>(
    ctx,
    'GET',
    '/v1/runners/runner-at11/rechecks',
    token,
  );
  assert.equal(quiet.status, 200, JSON.stringify(quiet.body));
  assert.equal(quiet.body.recheck, null, 'nothing pending is `null`, never an empty object');

  const ordered = await request<{ recheck: StoredRecheck }>(
    ctx,
    'POST',
    '/v1/runners/runner-at11/rechecks',
  );
  assert.equal(ordered.status, 201);

  const pending = await call<{ recheck: StoredRecheck | null }>(
    ctx,
    'GET',
    '/v1/runners/runner-at11/rechecks',
    token,
  );
  assert.deepEqual(pending.body.recheck, {
    id: ordered.body.recheck.id,
    runner_id: 'runner-at11',
    requested_at: ordered.body.recheck.requested_at,
    served_at: null,
  });
});

test('t401 AT12 — a runner cannot read another runner\'s re-check', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const mine = await pairedRunnerToken(ctx, 'runner-at12-mine');
  await pairedRunnerToken(ctx, 'runner-at12-other');
  await request(ctx, 'POST', '/v1/runners/runner-at12-other/rechecks');

  const refused = await call<ErrorBody>(
    ctx,
    'GET',
    '/v1/runners/runner-at12-other/rechecks',
    mine,
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'out_of_scope_credential');
});

test('t401 AT13 — reporting a probe IS what serves the pending re-check', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at13');

  await request(ctx, 'POST', '/v1/runners/runner-at13/rechecks');
  const pending = await call<{ recheck: StoredRecheck | null }>(
    ctx,
    'GET',
    '/v1/runners/runner-at13/rechecks',
    token,
  );
  assert.notEqual(pending.body.recheck, null, 'the precondition: something IS pending');

  await call(ctx, 'POST', '/v1/runners/runner-at13/probes', token, report());

  const served = await call<{ recheck: StoredRecheck | null }>(
    ctx,
    'GET',
    '/v1/runners/runner-at13/rechecks',
    token,
  );
  assert.equal(
    served.body.recheck,
    null,
    'a fresh probe is the answer to the request; there is no third endpoint to acknowledge it',
  );

  // ...and a NEW request after that one is pending again, so serving is per
  // request and never a switch that stays off.
  const again = await request<{ recheck: StoredRecheck }>(
    ctx,
    'POST',
    '/v1/runners/runner-at13/rechecks',
  );
  assert.equal(again.status, 201, 'the served row is not what the next call deduplicates against');
});

test('t401 AT14 — a runner credential still cannot read the fleet', async (t) => {
  requireArtifacts(...Object.values(T401_ARTIFACTS));
  const ctx = await startControlPlane(t);
  const token = await pairedRunnerToken(ctx, 'runner-at14');

  const refused = await call<ErrorBody>(ctx, 'GET', '/v1/runners', token);
  assert.equal(
    refused.status,
    403,
    'embedding the probe in this route must not have widened who may call it',
  );
  assert.equal(refused.body.error, 'out_of_scope_credential');
});
