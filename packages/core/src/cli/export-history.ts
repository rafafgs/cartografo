/**
 * `cartografo export-history` — a traversal leaves the machine (t372, RF-41).
 *
 * Writes a job's, or a whole round's, history as JSON Lines: a header line with
 * the map version's summary, then one line per fact in `id` order. What makes
 * the file worth the command is that a reader needs nothing but `JSON.parse`
 * and a loop over the lines — `docs/spec/history-export.md` is the contract,
 * and it is self-sufficient by design.
 *
 * An HTTP client like every other subcommand (D1, D11): it opens no database
 * and adds no route. Every read it makes already exists on `/v1`, and the MERGE
 * — the part with a decision in it — is `domain/history.ts`, pure and unit
 * tested without a server. What lives here is the fetching and the writing.
 *
 * Two rules this file keeps, both inherited from `cli/export.ts`. A bad answer
 * is a MESSAGE and an exit code, never a stack trace. And a failed export
 * leaves NO file: every read happens before the output is opened, so there is
 * no state in which half a history sits on disk under the name of a whole one.
 *
 * Export only, by the decision of 2026-09-05: the log is append-only with
 * server-assigned ids, and importing one installation's history into another
 * would mean inventing how to merge two logs — with D1 keeping the control
 * plane the only author of either.
 */

import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

import { isObject } from '../util/is-object.ts';
import {
  buildHistoryHeader,
  mergeHistoryLines,
  pinnedGraphVersionId,
  type FetchedGraphVersion,
  type HistoryEvent,
  type HistoryInputRequest,
  type HistorySession,
  type HistorySubject,
} from '../domain/history.ts';
import { DEFAULT_PROJECT_ID, UsageError, requestJson } from './url.ts';

/** Options of `export-history`, as the router hands them over. */
export interface ExportHistoryOptions {
  /** Value of `--job`, verbatim off the command line. */
  job?: string;
  /** Value of `--execution`, verbatim off the command line. */
  execution?: string;
  /** Base URL of the control plane. */
  url: string;
  /** Output file; defaults to `./<scope>-<id>.history.jsonl`. */
  output?: string;
  /** Project the scope is read from, already resolved to an id by the router. */
  projectId?: number;
}

/** What one run is about: a job, or a round. */
export interface HistoryScope {
  kind: 'job' | 'execution';
  id: number;
}

/** The one answer this file gives to a control plane that said no. */
class RefusedError extends Error {}

/**
 * Reads `--job`/`--execution` as a scope, or refuses the command line (FR1).
 *
 * Exactly one of the two, and an integer: neither is a command with nothing to
 * export, both is a command with two answers, and `--job quatro` is the same
 * mistake `register-skill --job` already refuses. All three are wrong command
 * lines and cost the server nothing — this runs before the first request, which
 * is also why the router calls it once more before it resolves `--project`.
 *
 * @param options The two raw values.
 * @returns The scope to export.
 * @throws {UsageError} On none, both, or an id that is not an integer.
 */
export function historyScope(options: { job?: string; execution?: string }): HistoryScope {
  const declared = (['job', 'execution'] as const).filter(
    (kind) => options[kind] !== undefined,
  );

  if (declared.length === 0) {
    throw new UsageError('export-history needs --job <id> or --execution <id>');
  }
  if (declared.length === 2) {
    throw new UsageError('export-history takes --job or --execution, never both');
  }

  const kind = declared[0];
  const raw = options[kind] as string;
  const id = Number(raw);
  // The emptiness is checked apart from the integrality because `Number('')` is
  // `0` — an integer, and a job id nobody has: `--job ""` would otherwise be a
  // 404 about a job that cannot exist instead of the wrong command line it is.
  if (raw.trim() === '' || !Number.isInteger(id)) {
    throw new UsageError(`--${kind} has to be an integer (got: "${raw}")`);
  }
  return { kind, id };
}

/** One `label  value` line of the success output, same shape as `export`'s. */
function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${value}\n`;
}

/**
 * Runs `cartografo export-history`.
 *
 * @param options Scope, base URL, output file and project.
 * @returns Process exit code.
 * @throws {UsageError} On a command line that names no scope, or two.
 */
export async function runExportHistory(options: ExportHistoryOptions): Promise<number> {
  const scope = historyScope(options);
  const projectId = options.projectId ?? DEFAULT_PROJECT_ID;
  const base = `${options.url}/v1`;
  const query = `project_id=${projectId}`;

  /**
   * One read, or the refusal that ends the command.
   *
   * @param route Path under `/v1`, query included.
   * @param what What is being looked up, for the message.
   * @returns The parsed body.
   */
  const read = async (route: string, what: string): Promise<Record<string, unknown>> => {
    const response = await requestJson(`${base}${route}`);
    const body = isObject(response.body) ? response.body : {};

    if (response.status === 404) {
      const refused = typeof body.error === 'string' ? body.error : `unknown_${what}`;
      throw new RefusedError(
        `cartografo: ${refused} — no ${what} ${scope.id} in project ${projectId} at ${options.url}`,
      );
    }
    if (response.status !== 200) {
      throw new RefusedError(
        `cartografo: the control plane answered HTTP ${response.status} while reading ${route.split('?')[0]}`,
      );
    }
    return body;
  };

  /** A list off a response envelope, under the key the route publishes it as. */
  const listed = <T>(body: Record<string, unknown>, key: string): T[] =>
    Array.isArray(body[key]) ? (body[key] as T[]) : [];

  try {
    const subject = await readSubject(scope, read, query);
    const events = listed<HistoryEvent>(
      await read(
        scope.kind === 'job'
          ? `/jobs/${scope.id}/events?${query}`
          : `/executions/${scope.id}/events?${query}`,
        scope.kind,
      ),
      'events',
    );
    const filter = `${scope.kind === 'job' ? 'job_id' : 'execution_id'}=${scope.id}`;
    const sessions = listed<HistorySession>(
      await read(`/sessions?${filter}&${query}`, scope.kind),
      'sessions',
    );
    const inputRequests = listed<HistoryInputRequest>(
      await read(`/input-requests?${filter}&${query}`, scope.kind),
      'input_requests',
    );

    const project = await readProject(read, projectId, options.url);
    const graph = await readGraphVersion(subject, base, query);

    const header = buildHistoryHeader({
      exported_at: new Date().toISOString(),
      project,
      subject,
      graph,
    });
    const lines = mergeHistoryLines({
      events,
      sessions,
      input_requests: inputRequests,
    });

    const destination = path.resolve(
      options.output ?? `${scope.kind}-${scope.id}.history.jsonl`,
    );
    write(destination, [header, ...lines]);

    process.stdout.write('history exported\n');
    process.stdout.write(line(scope.kind, String(scope.id)));
    process.stdout.write(line('lines', String(lines.length + 1)));
    process.stdout.write(line('file', destination));
    return 0;
  } catch (error) {
    if (!(error instanceof RefusedError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

/** How every read of this command is made; see `read` inside {@link runExportHistory}. */
type Read = (route: string, what: string) => Promise<Record<string, unknown>>;

/**
 * The job, or the round and the jobs that decide its map (FR2).
 *
 * A round is never a 404: `execution_id` is an opaque grouper and not a row, so
 * an id nobody wrote a job under is a round with zero jobs
 * (`repositories/job.ts`). Its export is therefore a legal, nearly empty file,
 * and this command does not invent a refusal the API does not make.
 *
 * @param scope What is being exported.
 * @param read One read of the control plane.
 * @param query The project scope every route carries.
 * @returns The subject, ready for the header.
 */
async function readSubject(scope: HistoryScope, read: Read, query: string): Promise<HistorySubject> {
  if (scope.kind === 'job') {
    return { kind: 'job', job: await read(`/jobs/${scope.id}?${query}`, 'job') };
  }

  const execution = await read(`/executions/${scope.id}?${query}`, 'execution');
  const jobs = await read(`/jobs?execution_id=${scope.id}&${query}`, 'execution');
  return {
    kind: 'execution',
    execution,
    jobs: Array.isArray(jobs.jobs) ? (jobs.jobs as Record<string, unknown>[]) : [],
  };
}

/**
 * The project's own name, for the header.
 *
 * The router resolved `--project` to an id (`cli/index.ts`), and the header
 * publishes both: an id alone identifies nothing on the machine the file is
 * read on, where project 3 is somebody else's project 3.
 *
 * @param read One read of the control plane.
 * @param projectId The resolved scope.
 * @param url Base URL, for the message.
 * @returns The id and the name.
 */
async function readProject(
  read: Read,
  projectId: number,
  url: string,
): Promise<{ id: number; name: string }> {
  const body = await read('/projects', 'project');
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const match = projects
    .filter(isObject)
    .find((project) => project.id === projectId);

  if (match === undefined || typeof match.name !== 'string') {
    throw new RefusedError(
      `cartografo: unknown_project — no project ${projectId} at ${url}`,
    );
  }
  return { id: projectId, name: match.name };
}

/**
 * The two reads behind the header's map, when the scope pins one version.
 *
 * The only reads of this command that TOLERATE a refusal, and deliberately so:
 * a pinned version that no longer resolves is `null`, not a failure. That is
 * the "no graph at all" reading `nodeInputOf` already gives the same case
 * (`routes/jobs.ts`), and an export refused because a lineage was renamed would
 * withhold a whole history over a field nobody reads to find their way around
 * it. The history is the point; the map is context on top of it.
 *
 * @param subject The job, or the round and its jobs.
 * @param base The control plane's `/v1`.
 * @param query The project scope every route carries.
 * @returns The version and its lineage, or `null`.
 */
async function readGraphVersion(
  subject: HistorySubject,
  base: string,
  query: string,
): Promise<FetchedGraphVersion | null> {
  const pin = pinnedGraphVersionId(subject);
  if (pin === null) return null;

  const fromVersion = await requestJson(
    `${base}/graph-versions/${encodeURIComponent(pin)}?${query}`,
  );
  if (fromVersion.status !== 200) return null;
  const versionBody = isObject(fromVersion.body) ? fromVersion.body : {};
  const version = isObject(versionBody.graph_version) ? versionBody.graph_version : null;
  if (version === null) return null;

  // The class lives on the lineage and nowhere else: a version knows its
  // `graph_id` and its parent, never the name a person gave the family.
  const graphId = version.graph_id;
  if (typeof graphId !== 'string' || graphId === '') return { version, lineage: null };

  const fromLineage = await requestJson(
    `${base}/graphs/${encodeURIComponent(graphId)}?${query}`,
  );
  const lineageBody = isObject(fromLineage.body) ? fromLineage.body : {};
  const lineage =
    fromLineage.status === 200 && isObject(lineageBody.graph) ? lineageBody.graph : null;

  return { version, lineage };
}

/**
 * Writes the file, one line at a time (FR4).
 *
 * One `writeSync` per line, and never one string holding the whole history: a
 * line split across two writes is precisely the file that cannot be read to its
 * last complete line, which is the guarantee this format sells. A failure
 * mid-write takes the half-written file with it — a partial history under the
 * name of a whole one is the one outcome worse than no file.
 *
 * @param destination Absolute path of the output file.
 * @param lines The header, then every line of the body.
 */
function write(destination: string, lines: unknown[]): void {
  mkdirSync(path.dirname(destination), { recursive: true });
  const handle = openSync(destination, 'w');
  try {
    for (const entry of lines) writeSync(handle, `${JSON.stringify(entry)}\n`);
  } catch (failure) {
    closeSync(handle);
    unlinkSync(destination);
    throw failure;
  }
  closeSync(handle);
}
