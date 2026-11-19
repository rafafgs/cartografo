/**
 * Repair command: close the sessions a failed tick left open (t1313, FR9).
 *
 * Before t1313, a dispatch that threw after its engine ended (an artifact
 * upload, a decode, a release) never closed its session, and the row stayed
 * `open` with `finished_at = null` forever. The runner closes such sessions on
 * its own now. This command closes the ones that were already stuck, through
 * the public API and never the database (D1): each one gets
 * `PATCH /v1/sessions/:id/finish` as `failed`, with an operator error that says
 * why.
 *
 * **The one precondition the operator owns: no runner may still be driving any
 * of these sessions.** Stop the runner before running this with `--yes`. A
 * session a live runner is about to close would get this closure first, and
 * the runner's own closure would then be refused with a 409.
 *
 * Dry run is the default: without `--yes` it prints what it would close and
 * writes nothing. It closes, and only that. It never deletes anything and
 * never edits a job.
 *
 * Same shape as `scripts/check-screen-retired.mjs`: exported functions plus a
 * thin CLI, zero dependencies.
 *
 * CLI use:
 *
 *   CARTOGRAFO_URL=http://127.0.0.1:4317 CARTOGRAFO_TOKEN=... \
 *     node scripts/close-stuck-sessions.mjs --job <id> [--session <id> ...] [--project <id>] [--yes]
 *
 * Exit codes: 0 done (or nothing to do), 1 a request failed, 2 refused before
 * any write (bad arguments, incomplete environment, a `--session` that is not
 * an open session of the job).
 */

/** The environment variables `cartografo up` exports to its children (`packages/core/src/cli/up.ts`). */
export const URL_ENV = 'CARTOGRAFO_URL';
export const TOKEN_ENV = 'CARTOGRAFO_TOKEN';

/** The error every operator closure carries in `session.finished`. */
export const OPERATOR_ERROR =
  'closed by operator: session left open by a tick that failed after the engine ended';

const USAGE =
  'usage: node scripts/close-stuck-sessions.mjs --job <id> [--session <id> ...] [--project <id>] [--yes]';

/**
 * Reads a positive integer id, or `null` when the text is not one.
 *
 * @param {string | undefined} text
 * @returns {number | null}
 */
function positiveId(text) {
  if (text === undefined || !/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * @typedef {object} Options
 * @property {number} jobId
 * @property {number[]} sessionIds Empty means every open session of the job.
 * @property {number | null} projectId
 * @property {boolean} yes
 * @property {string} url
 * @property {string} token
 */

/**
 * Parses the command line and the environment.
 *
 * @param {string[]} argv Arguments after the script's path.
 * @param {Record<string, string | undefined>} env
 * @returns {{ ok: true, options: Options } | { ok: false, message: string }}
 */
export function parseArguments(argv, env) {
  let jobId = null;
  const sessionIds = [];
  let projectId = null;
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--yes') {
      yes = true;
      continue;
    }
    if (flag === '--job' || flag === '--session' || flag === '--project') {
      const id = positiveId(argv[index + 1]);
      if (id === null) {
        return { ok: false, message: `${flag} needs a positive integer id. ${USAGE}` };
      }
      index += 1;
      if (flag === '--job') jobId = id;
      else if (flag === '--session') sessionIds.push(id);
      else projectId = id;
      continue;
    }
    return { ok: false, message: `unknown argument ${flag}. ${USAGE}` };
  }

  if (jobId === null) return { ok: false, message: `--job is required. ${USAGE}` };

  const url = env[URL_ENV];
  const token = env[TOKEN_ENV];
  if (url === undefined || url === '') {
    return { ok: false, message: `${URL_ENV} is not set: point it at the control plane` };
  }
  if (token === undefined || token === '') {
    return { ok: false, message: `${TOKEN_ENV} is not set: an operator credential is required` };
  }

  return {
    ok: true,
    options: { jobId, sessionIds, projectId, yes, url: url.replace(/\/+$/, ''), token },
  };
}

/**
 * Chooses the sessions to close: the job's open ones, narrowed to `sessionIds`
 * when any were given. All or nothing: one named id that is not an open
 * session of the job refuses the whole run.
 *
 * @param {Array<{ id: number, job_id: number | null, status: string }>} sessions
 * @param {number} jobId
 * @param {number[]} sessionIds
 * @returns {{ ok: true, selected: Array<{ id: number }> } | { ok: false, message: string }}
 */
export function selectSessions(sessions, jobId, sessionIds) {
  const open = sessions.filter((session) => session.job_id === jobId && session.status === 'open');
  if (sessionIds.length === 0) return { ok: true, selected: open };

  const openIds = new Set(open.map((session) => session.id));
  const unknown = sessionIds.filter((id) => !openIds.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      message: `session ${unknown.join(', ')} is not an open session of job ${String(jobId)}; nothing was closed`,
    };
  }
  const wanted = new Set(sessionIds);
  return { ok: true, selected: open.filter((session) => wanted.has(session.id)) };
}

/**
 * The body of each closure: `failed`, no exit code, no watchdog, an empty
 * transcript (the session's output is not this command's to know) and the
 * operator error.
 *
 * @returns {Record<string, unknown>}
 */
export function closureBody() {
  return {
    status: 'failed',
    exit_code: null,
    timeout_reason: null,
    transcript: '',
    error: OPERATOR_ERROR,
  };
}

/**
 * @typedef {object} Io
 * @property {typeof fetch} [fetchImpl]
 * @property {(line: string) => void} [out]
 * @property {(line: string) => void} [err]
 */

/**
 * The whole command, with its I/O injectable.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @param {Io} [io]
 * @returns {Promise<number>} The exit code.
 */
export async function run(argv, env, io = {}) {
  const fetchImpl = io.fetchImpl ?? fetch;
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));

  const parsed = parseArguments(argv, env);
  if (!parsed.ok) {
    err(`close-stuck-sessions: ${parsed.message}`);
    return 2;
  }
  const { jobId, sessionIds, projectId, yes, url, token } = parsed.options;
  const authorization = `Bearer ${token}`;

  const query = new URLSearchParams({ job_id: String(jobId) });
  if (projectId !== null) query.set('project_id', String(projectId));
  const listing = await fetchImpl(`${url}/v1/sessions?${query.toString()}`, {
    headers: { authorization },
  });
  const listingText = await listing.text();
  if (!listing.ok) {
    err(`close-stuck-sessions: GET /v1/sessions answered ${String(listing.status)}: ${listingText}`);
    return 1;
  }
  const sessions = /** @type {{ sessions?: unknown }} */ (JSON.parse(listingText)).sessions;
  if (!Array.isArray(sessions)) {
    err(`close-stuck-sessions: GET /v1/sessions answered without a sessions list: ${listingText}`);
    return 1;
  }

  const selection = selectSessions(sessions, jobId, sessionIds);
  if (!selection.ok) {
    err(`close-stuck-sessions: ${selection.message}`);
    return 2;
  }
  const { selected } = selection;

  if (selected.length === 0) {
    out(`job ${String(jobId)} has no open session to close`);
    return 0;
  }

  if (!yes) {
    for (const session of selected) {
      out(
        `would close session ${String(session.id)} (node ${String(session.node_id ?? '-')}, opened ${String(session.opened_at ?? '-')})`,
      );
    }
    out(
      `dry run: ${String(selected.length)} session(s) of job ${String(jobId)} would be closed as failed. ` +
        'Stop the runner, then rerun with --yes to close them.',
    );
    return 0;
  }

  let failed = false;
  for (const session of selected) {
    const route = `/v1/sessions/${String(session.id)}/finish`;
    try {
      const response = await fetchImpl(`${url}${route}`, {
        method: 'PATCH',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(closureBody()),
      });
      if (response.ok) {
        out(`closed session ${String(session.id)} as failed`);
        continue;
      }
      failed = true;
      err(`could not close session ${String(session.id)}: PATCH ${route} answered ${String(response.status)}: ${await response.text()}`);
    } catch (error) {
      failed = true;
      err(`could not close session ${String(session.id)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
