/**
 * Access to `runner_probe` and `runner_recheck` (t401, FR1/FR4/FR6).
 *
 * The control plane still does not know what a CLI, an MCP server or a git
 * checkout is. What it keeps here is a RELAY, exactly as `engine-models.ts`
 * already is: a runner started, asked its own machine three questions, and
 * reported the answers. Nothing in this module validates, resolves or enforces
 * any of it — a probe is discovery on the same terms `listModels` and
 * `discoverMcpServers` already are, and the only thing that ever refuses a bad
 * machine is a session that fails to open on it.
 *
 * **A report REPLACES, never merges.** One row per runner, upserted on the
 * primary key ({@link reportRunnerProbe}) — the shape `updateSettings` already
 * has, and not the delete-then-insert `reportEngineModels` needs for its
 * one-to-many. A probe merged with an older probe is a machine nobody can
 * describe, and historizing is deliberately out of scope: nothing today asks
 * for a probe history.
 *
 * **`mcp.supported: false` is not an empty list, and this module is where the
 * distinction survives storage.** t400 made `discoverMcpServers?()` optional on
 * the MEMBER and wrote down why: an adapter that never implemented discovery is
 * not an engine with zero MCP servers. The row carries `mcp_supported` beside
 * `mcp_servers` for exactly that reason, and {@link toProbe} refuses to
 * assemble a `servers` key when the flag is off.
 *
 * **Serving a recheck is a consequence of reporting, not a fourth verb.**
 * {@link reportRunnerProbe} stamps `served_at` on whatever was pending for that
 * runner, in the same transaction as the upsert. That is what closes the loop
 * without an endpoint whose only job is to say "done": a fresh probe IS the
 * answer to the request, whether an operator asked for it or the runner was
 * simply starting up. In one transaction because the pair has to be atomic —
 * a recheck served by a probe nobody stored would be a request answered with
 * nothing.
 *
 * Like every other repository it receives the already-open database and never
 * touches the driver (D1). English throughout (2026-08-18 language mandate).
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** Where an MCP listing came from: the engine answered, or its files were read. */
export type McpOrigin = 'cli' | 'file';

/** The two values `mcp_origin` accepts, as the migration's CHECK spells them. */
export const MCP_ORIGINS: readonly McpOrigin[] = ['cli', 'file'];

/** One MCP server, by name and nothing else — the runner's own `McpServerRef`. */
export interface McpServerRef {
  name: string;
}

/** The engine preflight, as `CliProbe` produced it on the machine. */
export interface ProbeCli {
  available: boolean;
  version: string | null;
  /**
   * Best effort, never a guarantee — the adapter's own words for it.
   *
   * Stored as reported and never re-derived: there is an engine whose
   * credential failure only shows up in the middle of the first session, and
   * the control plane knows strictly less about that than the runner does.
   */
  authenticated: boolean;
}

/**
 * What the machine's MCP discovery found, or the fact that it cannot answer.
 *
 * Two shapes and not one with nullable fields: `{supported: false}` says the
 * adapter does not implement discovery at all, and it must not be readable as
 * an engine that found nothing.
 */
export type ProbeMcp =
  | { supported: false }
  | {
      supported: true;
      servers: McpServerRef[];
      origin: McpOrigin;
      resolved_at: string | null;
    };

/** The two directories a runner was pointed at, as they really are on disk. */
export interface ProbeWorkspace {
  working_dir: string;
  working_dir_resolved: string;
  is_git_repo: boolean;
  worktrees_root: string;
  worktrees_root_resolved: string;
  worktrees_root_exists: boolean;
  /**
   * Could this runner create the root, whether or not it exists yet.
   *
   * The runner walks up to the first ancestor that exists and asks about that
   * one: the root is created lazily on the first `acquire()`
   * (`packages/runner/src/dispatch/session-worktree.ts`), so "does not exist
   * yet" is an ordinary state and never an error.
   */
  worktrees_root_writable: boolean;
}

/** What a runner reports about itself, already shape-checked by the route. */
export interface ProbeReport {
  cli: ProbeCli;
  mcp: ProbeMcp;
  workspace: ProbeWorkspace;
}

/** The stored probe: the row AND what `/v1` publishes. */
export interface RunnerProbe extends ProbeReport {
  runner_id: string;
  reported_at: string;
}

/** An operator's request that one runner report again. */
export interface RunnerRecheck {
  id: number;
  runner_id: string;
  requested_at: string;
  /** When a probe answered it; `null` while it is still pending. */
  served_at: string | null;
}

/** The flat row, as the columns spell it. */
interface ProbeRow {
  runner_id: string;
  cli_available: number;
  cli_version: string | null;
  cli_authenticated: number;
  mcp_supported: number;
  mcp_servers: string;
  mcp_origin: McpOrigin | null;
  mcp_resolved_at: string | null;
  working_dir: string;
  working_dir_resolved: string;
  is_git_repo: number;
  worktrees_root: string;
  worktrees_root_resolved: string;
  worktrees_root_exists: number;
  worktrees_root_writable: number;
  reported_at: string;
}

const PROBE_COLUMNS =
  'runner_id, cli_available, cli_version, cli_authenticated, mcp_supported, mcp_servers,' +
  ' mcp_origin, mcp_resolved_at, working_dir, working_dir_resolved, is_git_repo,' +
  ' worktrees_root, worktrees_root_resolved, worktrees_root_exists, worktrees_root_writable,' +
  ' reported_at';

const RECHECK_COLUMNS = 'id, runner_id, requested_at, served_at';

/** SQLite has no boolean; the column is an INTEGER and the wire is a boolean. */
function asBoolean(value: number): boolean {
  return value !== 0;
}

/**
 * Reassembles the nested wire shape out of the flat row.
 *
 * By hand, the same way `listRunnersWithHealth` already assembles
 * `last_expiration`: the storage is flat because SQLite is, and the API is
 * nested because that is the shape the fact has.
 *
 * `mcp_servers` is only parsed when `mcp_supported` says there is a listing to
 * parse. An unsupported engine's row carries the column's `'[]'` default and
 * nothing reads it — which is what keeps "not implemented" from leaking out as
 * "found nothing".
 */
function toProbe(row: ProbeRow): RunnerProbe {
  return {
    runner_id: row.runner_id,
    cli: {
      available: asBoolean(row.cli_available),
      version: row.cli_version,
      authenticated: asBoolean(row.cli_authenticated),
    },
    mcp: asBoolean(row.mcp_supported)
      ? {
          supported: true,
          servers: JSON.parse(row.mcp_servers) as McpServerRef[],
          origin: row.mcp_origin ?? 'cli',
          resolved_at: row.mcp_resolved_at,
        }
      : { supported: false },
    workspace: {
      working_dir: row.working_dir,
      working_dir_resolved: row.working_dir_resolved,
      is_git_repo: asBoolean(row.is_git_repo),
      worktrees_root: row.worktrees_root,
      worktrees_root_resolved: row.worktrees_root_resolved,
      worktrees_root_exists: asBoolean(row.worktrees_root_exists),
      worktrees_root_writable: asBoolean(row.worktrees_root_writable),
    },
    reported_at: row.reported_at,
  };
}

/**
 * Stores a runner's latest probe, and serves whatever recheck was pending.
 *
 * One transaction for both halves, and it has to be: a recheck marked served by
 * a probe that was never written is a request answered with nothing, and a
 * probe written without serving the request that asked for it would leave the
 * runner re-probing on every loop iteration for ever.
 *
 * @param db Open database.
 * @param runnerId The runner the report is about — already known to exist.
 * @param report What it said, already shape-checked by the route.
 * @returns The probe as it now stands.
 */
export function reportRunnerProbe(
  db: Database,
  runnerId: string,
  report: ProbeReport,
): RunnerProbe {
  const timestamp = now();
  const mcp = report.mcp;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO runner_probe (${PROBE_COLUMNS})
       VALUES (@runner_id, @cli_available, @cli_version, @cli_authenticated, @mcp_supported,
               @mcp_servers, @mcp_origin, @mcp_resolved_at, @working_dir, @working_dir_resolved,
               @is_git_repo, @worktrees_root, @worktrees_root_resolved, @worktrees_root_exists,
               @worktrees_root_writable, @reported_at)
       ON CONFLICT(runner_id) DO UPDATE SET
         cli_available = excluded.cli_available,
         cli_version = excluded.cli_version,
         cli_authenticated = excluded.cli_authenticated,
         mcp_supported = excluded.mcp_supported,
         mcp_servers = excluded.mcp_servers,
         mcp_origin = excluded.mcp_origin,
         mcp_resolved_at = excluded.mcp_resolved_at,
         working_dir = excluded.working_dir,
         working_dir_resolved = excluded.working_dir_resolved,
         is_git_repo = excluded.is_git_repo,
         worktrees_root = excluded.worktrees_root,
         worktrees_root_resolved = excluded.worktrees_root_resolved,
         worktrees_root_exists = excluded.worktrees_root_exists,
         worktrees_root_writable = excluded.worktrees_root_writable,
         reported_at = excluded.reported_at`,
    ).run({
      runner_id: runnerId,
      cli_available: report.cli.available ? 1 : 0,
      cli_version: report.cli.version,
      cli_authenticated: report.cli.authenticated ? 1 : 0,
      mcp_supported: mcp.supported ? 1 : 0,
      // The unsupported case writes the column's own default rather than a
      // `NULL`: there is no listing, and `'[]'` is the one value `toProbe` is
      // guaranteed never to read back for it.
      mcp_servers: mcp.supported ? JSON.stringify(mcp.servers) : '[]',
      mcp_origin: mcp.supported ? mcp.origin : null,
      mcp_resolved_at: mcp.supported ? mcp.resolved_at : null,
      working_dir: report.workspace.working_dir,
      working_dir_resolved: report.workspace.working_dir_resolved,
      is_git_repo: report.workspace.is_git_repo ? 1 : 0,
      worktrees_root: report.workspace.worktrees_root,
      worktrees_root_resolved: report.workspace.worktrees_root_resolved,
      worktrees_root_exists: report.workspace.worktrees_root_exists ? 1 : 0,
      worktrees_root_writable: report.workspace.worktrees_root_writable ? 1 : 0,
      reported_at: timestamp,
    });

    // Every pending request of this runner, not only the newest: the create is
    // idempotent so there should never be two, and an UPDATE that closed only
    // one would turn a hypothetical duplicate into a runner that re-probes for
    // ever.
    db.prepare(
      'UPDATE runner_recheck SET served_at = ? WHERE runner_id = ? AND served_at IS NULL',
    ).run(timestamp, runnerId);
  })();

  const stored = getRunnerProbe(db, runnerId);
  if (stored === null) throw new Error(`the probe of runner "${runnerId}" was not written`);
  return stored;
}

/**
 * @param db Open database.
 * @param runnerId Runner to read.
 * @returns Its latest probe, or `null` if it never reported one.
 */
export function getRunnerProbe(db: Database, runnerId: string): RunnerProbe | null {
  const row = db
    .prepare(`SELECT ${PROBE_COLUMNS} FROM runner_probe WHERE runner_id = ?`)
    .get(runnerId) as ProbeRow | undefined;
  return row === undefined ? null : toProbe(row);
}

/**
 * Every stored probe, by runner id.
 *
 * One query and a group in memory, and not `getRunnerProbe` in a loop: the same
 * reasoning `listRunnersWithHealth` writes down two files away — a fleet is
 * small, but "small" is not a reason to write an N+1 that grows with it. This is
 * what `GET /v1/runners` merges into its rows.
 *
 * @param db Open database.
 * @returns A map from `runner_id` to that runner's latest probe.
 */
export function listRunnerProbes(db: Database): Map<string, RunnerProbe> {
  const rows = db.prepare(`SELECT ${PROBE_COLUMNS} FROM runner_probe`).all() as ProbeRow[];
  return new Map(rows.map((row) => [row.runner_id, toProbe(row)]));
}

/**
 * Asks a runner to report again — idempotent while the last request is pending.
 *
 * Asking twice is what an impatient operator does, and it must not queue two
 * re-checks: the second call finds the pending row and hands it back. The
 * `created` flag is what separates `201` from `200` in the route, the same way
 * `registerRunner` already reports its own idempotence.
 *
 * The read and the insert are in one transaction because the pair is a
 * check-then-act: two concurrent requests that both read "nothing pending"
 * would otherwise both insert.
 *
 * @param db Open database.
 * @param runnerId Runner to ask — already known to exist.
 * @returns The pending request, and whether THIS call is what created it.
 */
export function requestRunnerRecheck(
  db: Database,
  runnerId: string,
): { recheck: RunnerRecheck; created: boolean } {
  return db.transaction(() => {
    const pending = getPendingRunnerRecheck(db, runnerId);
    if (pending !== null) return { recheck: pending, created: false };

    const inserted = db
      .prepare('INSERT INTO runner_recheck (runner_id, requested_at, served_at) VALUES (?, ?, NULL)')
      .run(runnerId, now());

    const recheck = db
      .prepare(`SELECT ${RECHECK_COLUMNS} FROM runner_recheck WHERE id = ?`)
      .get(Number(inserted.lastInsertRowid)) as RunnerRecheck | undefined;
    if (recheck === undefined) throw new Error(`the recheck of runner "${runnerId}" was not written`);

    return { recheck, created: true };
  })();
}

/**
 * @param db Open database.
 * @param runnerId Runner to read.
 * @returns Its pending recheck, or `null` when nothing is waiting.
 */
export function getPendingRunnerRecheck(db: Database, runnerId: string): RunnerRecheck | null {
  const row = db
    .prepare(
      `SELECT ${RECHECK_COLUMNS} FROM runner_recheck
        WHERE runner_id = ? AND served_at IS NULL
        ORDER BY id
        LIMIT 1`,
    )
    .get(runnerId) as RunnerRecheck | undefined;
  return row ?? null;
}
