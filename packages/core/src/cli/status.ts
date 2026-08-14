/**
 * `cartografo status` — what the control plane knows today (t108, FR5).
 *
 * The most important field of this report is the one it does NOT assert:
 * `jobs` and `pendingInputRequests` come out as `null`, never `0`. The `sessao`
 * and `input_request` tables do not exist yet (`migrations/0001_init.sql`,
 * `docs/spec/entidades-versionamento.md` §7), and a `0` there would say "there
 * is no queue" when the honest answer is "this is not tracked yet" — which is
 * exactly the difference that would make someone trust an empty dashboard. The
 * field shows up, with the right value, and becomes a number once the entities
 * exist.
 *
 * `--json` prints a single line, with the keys in a fixed order: it is machine
 * output, and the acceptance test compares it byte for byte, for the same reason
 * `health.test.ts` pins the `/health` body. Like the startup readiness line
 * (t127, FR6), this is a bespoke CLI shape — no migration column, no event
 * taxonomy and no other package parses it — so D18 translates its keys too.
 */

import { NetworkError, serverDownMessage, requestJson } from './url.ts';

/** A registered class, in `status`'s view. */
export interface StatusProject {
  classe: string;
  versao_corrente_id: string | null;
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
  jobs: null;
  pendingInputRequests: null;
}

/** Options of `status`. */
export interface StatusOptions {
  /** Base URL of the control plane. */
  url: string;
  /** Prints the report as a single JSON object. */
  json?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the report by querying `/health` and `/v1/classes`.
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
        classe: String(entry.classe),
        versao_corrente_id:
          typeof entry.versao_corrente_id === 'string' ? entry.versao_corrente_id : null,
      }));
    }
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
  }

  return { report: { server, projects, jobs: null, pendingInputRequests: null }, db };
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
      lines.push(`  - ${project.classe}  ${project.versao_corrente_id ?? 'no current version'}`);
    }
  }

  lines.push('jobs: not tracked yet');
  lines.push('pendingInputRequests: not tracked yet');
  lines.push('');
  lines.push(
    '(jobs and pending input requests are not zero: the session/input_request entities land in a later ticket)',
  );

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
