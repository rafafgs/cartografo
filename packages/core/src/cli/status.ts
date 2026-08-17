/**
 * `cartografo status` — what the control plane knows today (t108, FR5).
 *
 * Four fields, and each one is a count of something that exists:
 *
 * - `server` — whether the control plane answered `/health` at all;
 * - `projects` — the classes registered, from `GET /v1/classes`;
 * - `jobs` — how many jobs the queue holds, from `GET /v1/jobs`;
 * - `pendingInputRequests` — how many questions still wait for a human, from
 *   `GET /v1/input-requests?status=pending`.
 *
 * The last two used to be the literal `null`, with a comment claiming the
 * entities did not exist yet. Both halves of that were wrong (t199, FR1): the
 * table is `pergunta`, not `input_request`, and `trabalho`/`sessao`/`pergunta`
 * have existed since `migrations/0003_trabalho_sessao_evento_pergunta.sql`,
 * delivered by t102. What survives of the old care is the distinction the whole
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
import { NetworkError, serverDownMessage, requestJson } from './url.ts';

/** A registered class, in `status`'s view. */
export interface StatusProject {
  class: string;
  current_version_id: string | null;
}

/**
 * The whole report. Key order is part of the `--json` contract.
 *
 * `projects: null` means "could not be queried" (server down), which is
 * different from `[]`, "no class registered".
 */
export interface StatusReport {
  server: 'ok' | 'error' | 'unavailable';
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
      report: { server: 'unavailable', projects: null, jobs: null, pendingInputRequests: null },
      db: null,
    };
  }

  let projects: StatusProject[] | null = null;
  try {
    const classes = await requestJson(`${url}/v1/classes`);
    const body = isObject(classes.body) ? classes.body : {};
    if (classes.status === 200 && Array.isArray(body.classes)) {
      projects = body.classes.filter(isObject).map((entry) => ({
        class: String(entry.class),
        current_version_id:
          typeof entry.current_version_id === 'string' ? entry.current_version_id : null,
      }));
    }
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
  }

  const jobs = await countFrom(`${url}/v1/jobs`, 'jobs');
  const pendingInputRequests = await countFrom(
    `${url}/v1/input-requests?status=pending`,
    'input_requests',
  );

  return { report: { server, projects, jobs, pendingInputRequests }, db };
}

/** Formats the report for a human to read. */
function asTable(report: StatusReport, db: string | null, url: string): string {
  const lines: string[] = [];

  const serverDetail =
    report.server === 'unavailable' ? ` (${url})` : db === null ? '' : ` (db: ${db})`;
  lines.push(`server: ${report.server}${serverDetail}`);

  if (report.projects === null) {
    lines.push('projects: not queried');
  } else {
    lines.push(`projects: ${report.projects.length}`);
    for (const project of report.projects) {
      lines.push(`  - ${project.class}  ${project.current_version_id ?? 'no current version'}`);
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
  const { report, db } = await collectStatus(options.url);

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
