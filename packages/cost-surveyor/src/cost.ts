/**
 * Cost aggregation by `(graph version, node)` — the surveyor's cost lens
 * (t114, FR2).
 *
 * `GET /v1/executions/:id/metrics-by-version` already crosses version ×
 * telemetry, but it only counts jobs and events per `grafo_versao_id`. Here the
 * join goes down one level: the pair `(grafo_versao_id, no_id)` is the unit in
 * which a cost policy can point at a target — "v2 is more expensive than v1" is
 * an opinion until it says WHICH node became expensive.
 *
 * Two conventions inherited from the core, and neither of them is a detail:
 *
 * - **an absent `uso` is never worth zero**
 *   (`packages/core/src/repositories/session.ts:9-11`). Zero tokens is a
 *   measurement; absence is the engine not having reported anything. The two
 *   become separate counters (`sessoes_com_uso`/`sessoes_sem_uso`), and it is
 *   the second one that says how much of the total can be believed. The same
 *   holds for time: a session still open is unknown, not instantaneous.
 * - **Nothing disappears.** A session with no job (discovery, a conversation
 *   turn) or a job with no declared version falls into a group of its own,
 *   ordered last — the same choice as `metricsByVersion`
 *   (`packages/core/src/repositories/job.ts:386-410`): a report that hides what
 *   it cannot classify lies about the total.
 *
 * This module is pure arithmetic: it receives what the API returned and talks to
 * nobody. `client.ts` is what fetches.
 */

/** Token totals frozen at the end of the session's life. */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * A session as `GET /v1/sessions` returns it, in the subset the lens reads.
 *
 * A deliberate subset of the projection in
 * `packages/core/src/repositories/session.ts`: declaring only what is consumed
 * is what lets this lens survive new fields in the core without changing a line.
 */
export interface ObservedSession {
  job_id: number | null;
  node_id: string | null;
  usage: SessionUsage | null;
  opened_at: string;
  finished_at: string | null;
}

/** Which graph version each job belongs to (`trabalho.grafo_versao_id`). */
export type VersionByJob = ReadonlyMap<number, string | null>;

/** One row of the cost × version × node grouping. */
export interface CostRow {
  grafo_versao_id: string | null;
  no_id: string | null;
  /** Sum of the four subkeys of `uso`, only of the sessions that reported. */
  tokens_total: number;
  sessoes_com_uso: number;
  sessoes_sem_uso: number;
  /** Sum of `finalizada_em - aberta_em`, only of sessions with both stamps. */
  tempo_total_segundos: number;
  sessoes_com_tempo: number;
  sessoes_sem_tempo: number;
}

/**
 * A row whose pair `(version, node)` is identified.
 *
 * Only these serve as the target of an operation: without both fields there is
 * no node to point at, nor a snapshot in which to look for it.
 */
export interface IdentifiedCostRow extends CostRow {
  grafo_versao_id: string;
  no_id: string;
}

/** Sums the four subkeys. It is the whole definition of "tokens" in this lens. */
function totalTokens(usage: SessionUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  );
}

/**
 * Duration of a session in milliseconds, or `null` when there is no knowing.
 *
 * An absent or unparseable stamp is ignorance, and ignorance counts in
 * `sessoes_sem_tempo` — never as zero.
 */
function durationMs(session: ObservedSession): number | null {
  if (session.finished_at === null || session.opened_at === null) return null;
  const start = Date.parse(session.opened_at);
  const end = Date.parse(session.finished_at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

/** Grouping key that tells `null` apart from the text "null". */
function key(graphVersionId: string | null, nodeId: string | null): string {
  return JSON.stringify([graphVersionId, nodeId]);
}

/** Text first, `null` last — the order of `metricsByVersion`. */
function compareNullLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/**
 * Aggregates the sessions of an execution by `(graph version, node)` (FR2).
 *
 * @param sessions Sessions as `GET /v1/sessions?execution_id=` returned them.
 * @param versionByJob Map `job id -> graph_version_id`, built from
 *   `GET /v1/jobs?execution_id=`. A job absent from the map is treated as an
 *   unknown version, not as an error.
 * @returns One row per distinct pair observed; identified pairs first, the group
 *   with `null` on either end last.
 */
export function aggregateCost(
  sessions: readonly ObservedSession[],
  versionByJob: VersionByJob,
): CostRow[] {
  const byPair = new Map<string, CostRow>();

  for (const session of sessions) {
    const graphVersionId =
      session.job_id === null ? null : (versionByJob.get(session.job_id) ?? null);
    const nodeId = session.node_id;

    let row = byPair.get(key(graphVersionId, nodeId));
    if (row === undefined) {
      row = {
        grafo_versao_id: graphVersionId,
        no_id: nodeId,
        tokens_total: 0,
        sessoes_com_uso: 0,
        sessoes_sem_uso: 0,
        tempo_total_segundos: 0,
        sessoes_com_tempo: 0,
        sessoes_sem_tempo: 0,
      };
      byPair.set(key(graphVersionId, nodeId), row);
    }

    if (session.usage === null) {
      row.sessoes_sem_uso += 1;
    } else {
      row.sessoes_com_uso += 1;
      row.tokens_total += totalTokens(session.usage);
    }

    const duration = durationMs(session);
    if (duration === null) {
      row.sessoes_sem_tempo += 1;
    } else {
      row.sessoes_com_tempo += 1;
      // Accumulates in ms and divides once at the end: adding fractions of a
      // second per session would keep piling floating-point noise on the total.
      row.tempo_total_segundos += duration;
    }
  }

  const rows = [...byPair.values()].map((row) => ({
    ...row,
    tempo_total_segundos: row.tempo_total_segundos / 1000,
  }));

  return rows.sort((a, b) => {
    const aIdentified = isIdentified(a);
    const bIdentified = isIdentified(b);
    if (aIdentified !== bIdentified) return aIdentified ? -1 : 1;

    const byVersion = compareNullLast(a.grafo_versao_id, b.grafo_versao_id);
    return byVersion !== 0 ? byVersion : compareNullLast(a.no_id, b.no_id);
  });
}

/** Does the row have a version AND a node? That is what makes it a possible target. */
export function isIdentified(row: CostRow): row is IdentifiedCostRow {
  return row.grafo_versao_id !== null && row.no_id !== null;
}

/**
 * Narrows to the identified rows only, which are the ones `evaluatePolicies` takes.
 *
 * @param rows Output of `aggregateCost`.
 * @returns The rows with version and node filled in, in the same order.
 */
export function identifiedRows(rows: readonly CostRow[]): IdentifiedCostRow[] {
  return rows.filter(isIdentified);
}
