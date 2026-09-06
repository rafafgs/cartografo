/**
 * `cartografo status` — what the control plane knows today (t108, FR5).
 *
 * Five fields, and each one is a count of something that exists:
 *
 * - `server` — whether the control plane answered `/health` at all;
 * - `classes` — the graph classes registered in the project being reported,
 *   from `GET /v1/classes`;
 * - `projects` — the projects that exist, from `GET /v1/projects` (t354);
 * - `jobs` — how many jobs the queue holds, from `GET /v1/jobs`;
 * - `pendingInputRequests` — how many questions still wait for a human, from
 *   `GET /v1/input-requests?status=pending`.
 *
 * The first of those two used to be called `projects` and held the CLASSES —
 * a name that was merely loose while there was no such thing as a project, and
 * that became a collision the moment D25 made one (t354). It is renamed here, in
 * the same delivery that gives the name to what it really describes; `--json` is
 * machine output, so this is a contract change and belongs in the ticket that
 * makes it necessary rather than in a tidy-up afterwards.
 *
 * The last two used to be the literal `null`, with a comment claiming the
 * entities did not exist yet. That was wrong (t199, FR1): `job`, `session` and
 * `input_request` have existed since
 * `migrations/0003_trabalho_sessao_evento_pergunta.sql`, delivered by t102 —
 * under the Portuguese names D20's fourth child (t229) has since renamed. What
 * survives of the old care is the distinction the whole
 * report is built on: `null` means "could not be queried" and `0` means "queried,
 * and empty". A server that is down answers `null` on everything, because
 * claiming an empty queue nobody looked at is exactly how a dashboard earns
 * trust it has not got.
 *
 * `--json` prints a single line, with the keys in a fixed order: it is machine
 * output, and the acceptance test compares it byte for byte, for the same reason
 * `health.test.ts` pins the `/health` body. Like the startup readiness line
 * (t127, FR6), this is a bespoke CLI shape — no migration column, no event
 * taxonomy and no other package parses it — so D18 translates its keys too.
 */

import { isObject } from '../util/is-object.ts';
import { DEFAULT_PROJECT_ID, NetworkError, serverDownMessage, requestJson } from './url.ts';

/** A registered graph class, in `status`'s view. */
export interface StatusClass {
  class: string;
  current_version_id: string | null;
}

/**
 * A project, in `status`'s view — id and name, and deliberately not `created_at`.
 *
 * The `--json` shape is pinned byte for byte by the acceptance test, and a
 * timestamp cannot be pinned. What the report is for is telling an operator
 * which projects exist and which id to pass to `--project`, and those are the
 * two fields that answer it.
 */
export interface StatusProject {
  id: number;
  name: string;
}

/**
 * The whole report. Key order is part of the `--json` contract.
 *
 * `null` means "could not be queried" (server down), which is different from
 * `[]` — "queried, and there is nothing".
 */
export interface StatusReport {
  server: 'ok' | 'error' | 'unavailable';
  classes: StatusClass[] | null;
  projects: StatusProject[] | null;
  jobs: number | null;
  pendingInputRequests: number | null;
}

/** Options of `status`. */
export interface StatusOptions {
  /** Base URL of the control plane. */
  url: string;
  /** Prints the report as a single JSON object. */
  json?: boolean;
  /**
   * Project whose classes are reported, already resolved to an id by the router
   * (t354). The PROJECT list is never scoped: "which projects exist" is the
   * question `--project` is answered with.
   */
  projectId?: number;
}

/**
 * Counts the entries of one list route, or answers `null` when it cannot.
 *
 * Same try/catch shape as the `/v1/classes` call below, and for the same reason:
 * a `NetworkError` is a state this report knows how to say, and anything else is
 * a bug that must not be swallowed into a plausible-looking zero.
 *
 * @param url Full URL of the list route.
 * @param field Name of the array in the response body.
 * @returns How many entries came back, or `null` when the route did not answer.
 */
async function countFrom(url: string, field: string): Promise<number | null> {
  try {
    const response = await requestJson(url);
    const body = isObject(response.body) ? response.body : {};
    const entries = body[field];
    return response.status === 200 && Array.isArray(entries) ? entries.length : null;
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return null;
  }
}

/**
 * Builds the report by querying `/health`, `/v1/classes`, `/v1/jobs` and
 * `/v1/input-requests?status=pending`.
 *
 * A server that is down is not an exception here: it is a state the report knows
 * how to say. That is why `NetworkError` is caught instead of propagated —
 * whoever runs `status` is precisely asking whether the server answers.
 *
 * @param url Base URL of the control plane.
 * @returns The report and the database sub-status, when there is one.
 */
export async function collectStatus(
  url: string,
  projectId: number = DEFAULT_PROJECT_ID,
): Promise<{ report: StatusReport; db: string | null }> {
  let server: StatusReport['server'];
  let db: string | null;

  try {
    const health = await requestJson(`${url}/health`);
    const body = isObject(health.body) ? health.body : {};
    db = typeof body.db === 'string' ? body.db : null;
    server = health.status === 200 && body.status === 'ok' ? 'ok' : 'error';
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return {
      report: {
        server: 'unavailable',
        classes: null,
        projects: null,
        jobs: null,
        pendingInputRequests: null,
      },
      db: null,
    };
  }

  let classes: StatusClass[] | null = null;
  try {
    const answered = await requestJson(`${url}/v1/classes?project_id=${projectId}`);
    const body = isObject(answered.body) ? answered.body : {};
    if (answered.status === 200 && Array.isArray(body.classes)) {
      classes = body.classes.filter(isObject).map((entry) => ({
        class: String(entry.class),
        current_version_id:
          typeof entry.current_version_id === 'string' ? entry.current_version_id : null,
      }));
    }
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
  }

  let projects: StatusProject[] | null = null;
  try {
    const answered = await requestJson(`${url}/v1/projects`);
    const body = isObject(answered.body) ? answered.body : {};
    if (answered.status === 200 && Array.isArray(body.projects)) {
      projects = body.projects
        .filter(isObject)
        .map((entry) => ({ id: Number(entry.id), name: String(entry.name) }));
    }
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
  }

  const jobs = await countFrom(`${url}/v1/jobs`, 'jobs');
  const pendingInputRequests = await countFrom(
    `${url}/v1/input-requests?status=pending`,
    'input_requests',
  );

  return { report: { server, classes, projects, jobs, pendingInputRequests }, db };
}

/** Formats the report for a human to read. */
function asTable(report: StatusReport, db: string | null, url: string): string {
  const lines: string[] = [];

  const serverDetail =
    report.server === 'unavailable' ? ` (${url})` : db === null ? '' : ` (db: ${db})`;
  lines.push(`server: ${report.server}${serverDetail}`);

  if (report.classes === null) {
    lines.push('classes: not queried');
  } else {
    lines.push(`classes: ${report.classes.length}`);
    for (const entry of report.classes) {
      lines.push(`  - ${entry.class}  ${entry.current_version_id ?? 'no current version'}`);
    }
  }

  if (report.projects === null) {
    lines.push('projects: not queried');
  } else {
    lines.push(`projects: ${report.projects.length}`);
    for (const project of report.projects) {
      lines.push(`  - ${project.id}  ${project.name}`);
    }
  }

  lines.push(`jobs: ${report.jobs ?? 'not queried'}`);
  lines.push(`pendingInputRequests: ${report.pendingInputRequests ?? 'not queried'}`);

  return `${lines.join('\n')}\n`;
}

/**
 * Runs `cartografo status`.
 *
 * @param options Base URL and output format.
 * @returns Exit code: 0 only when the control plane answers healthy.
 */
export async function runStatus(options: StatusOptions): Promise<number> {
  const { report, db } = await collectStatus(options.url, options.projectId);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(asTable(report, db, options.url));
  }

  if (report.server === 'unavailable') {
    process.stderr.write(`${serverDownMessage(options.url)}\n`);
  }

  return report.server === 'ok' ? 0 : 1;
}
