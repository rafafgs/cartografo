/**
 * The screen's five server-rendered views (t107, FR5–FR8, FR10).
 *
 * No framework, no bundler, no build step: each page is assembled on the
 * request, out of what `client.ts` has just read from the public API. It is a
 * choice of SCALE, not of taste — the screen is a read-only HTTP client with
 * one form, and a front-end pipeline here would cost more maintenance than the
 * whole thing it serves. The only JavaScript that reaches the browser is the
 * eight lines that copy an option into the answer field; without it, the form
 * still works by typing.
 *
 * ## The `data-*` markers are a contract
 *
 * `data-no-atual`, `data-trabalho`, `data-execucao`, `data-campo`,
 * `data-sessao`, `data-pergunta` and `data-segmento` exist so the acceptance
 * tests can assert about STRUCTURE — what is inside which group, in what order
 * — without freezing the whole markup. They are documented in
 * `docs/spec/screen.md`; changing one of them changes the contract, not the CSS.
 * They keep their Portuguese spelling for exactly that reason (t133,
 * exception 10), and so do the CSS class names beside them.
 *
 * The COPY does not. Every page title, nav link, table header, status word and
 * message this file renders is English since t310 — the screen is the only
 * package a person opens, and it reads in the project's language like
 * everything else. The two vocabularies were one exception until then and are
 * two now: what a person reads moved, what a test and a stylesheet select on
 * stayed. The three bucket labels `totalsHtml` writes are the one leftover, and
 * they are not copy either: they are `timeline.ts`'s `SegmentCategory` values,
 * which are also the `data-segmento` contract.
 *
 * ## Escaping is not a detail
 *
 * A job title, a question text and a block reason are outside data: they were
 * written by an agent, through an API whose credential (t124) says nothing about
 * the CONTENT it carries. Everything that goes into HTML passes through
 * `escapeHtml`, with no exception.
 */

import type {
  ApiClient,
  Example,
  ExecutionSummary,
  Job,
  JobState,
  Project,
  Question,
  RunnerHealth,
  RunnerProbe,
  Session,
  Settings,
} from './client.ts';
import { buildTimeline, type Segment, type Timeline } from './timeline.ts';

/** A page ready to go to the browser. */
export interface Page {
  status: number;
  html: string;
}

/**
 * Who is recorded as the author of an answer, given that the screen holds one
 * service credential and asks the browser for none (t124, D11).
 *
 * Deliberately honest: recording "tela" is saying the answer came through this
 * door, which is all the system actually knows. Inventing a user would be worse
 * than admitting the gap — the `input_request.answered` event is an audit trail.
 *
 * The value stays Portuguese while the rest of this file goes English (t310),
 * and not by omission: it is already written into an append-only log (D15), so
 * renaming it would make new rows disagree with old ones about who answered.
 * t303 read it the same way and left it alone.
 */
export const DEFAULT_ANSWERED_BY = 'tela';

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem 2rem 4rem; }
  header.topo { display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  header.topo h1 { font-size: 1.1rem; margin: 0; letter-spacing: .02em; }
  nav a { margin-right: 1rem; }
  form.project-switcher { display: flex; align-items: baseline; gap: .4rem; font-size: .8rem; margin-left: auto; }
  form.project-switcher label { opacity: .6; letter-spacing: .02em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; opacity: .7; margin: 1.75rem 0 .6rem; }
  .quadro { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
  .grupo { flex: 1 1 16rem; min-width: 15rem; }
  .cartao { border: 1px solid currentColor; border-radius: 6px; padding: .6rem .7rem; margin-bottom: .5rem; opacity: .95; }
  .cartao .id { font-size: .75rem; opacity: .6; }
  .bloqueado { border-width: 2px; }
  .motivo { font-size: .8rem; margin-top: .35rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid currentColor; font-variant-numeric: tabular-nums; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
  .pergunta { border: 1px solid currentColor; border-radius: 6px; padding: .8rem 1rem; margin-bottom: 1rem; max-width: 52rem; }
  .pergunta dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .8rem; margin: .5rem 0; font-size: .9rem; }
  .pergunta dt { opacity: .6; }
  .pergunta dd { margin: 0; }
  form textarea { width: 100%; min-height: 3.5rem; font: inherit; padding: .4rem; }
  form label[for] { display: block; font-size: .8rem; letter-spacing: .02em; opacity: .7; margin-bottom: .2rem; }
  form .opcoes { display: flex; gap: .4rem; flex-wrap: wrap; margin: .4rem 0; }
  form.action { margin-top: .5rem; max-width: 52rem; }
  form.action p { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; margin: .4rem 0 0; font-size: .8rem; }
  .linha-do-tempo { list-style: none; padding: 0; max-width: 52rem; }
  .segmento { display: grid; grid-template-columns: 11rem 1fr; gap: .8rem; padding: .35rem 0; border-bottom: 1px solid currentColor; }
  .segmento .balde { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  .vazio { opacity: .6; font-style: italic; }
  .verificacao { border: 1px solid currentColor; border-radius: 6px; padding: .7rem .9rem; margin-bottom: .6rem; max-width: 52rem; }
  .verificacao[data-estado="met"] { opacity: .7; }
  .verificacao[data-estado="unmet"] { border-width: 2px; }
  .verificacao .titulo { margin: 0; font-weight: 600; }
  .verificacao p { margin: .4rem 0 0; font-size: .9rem; }
  .verificacao pre { overflow-x: auto; margin: .5rem 0 0; padding: .5rem .6rem; border: 1px dashed currentColor; border-radius: 4px; }
  .verificacao code { font: .82rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
  .verificacao form { margin-top: .5rem; }
  .verificacao form input { font: inherit; padding: .3rem .4rem; min-width: 20rem; max-width: 100%; }
  .pronto { border: 2px solid currentColor; border-radius: 6px; padding: 1rem 1.2rem; max-width: 52rem; }
  .suporte { margin-top: 2.5rem; font-size: .85rem; opacity: .7; }
  .attention { border-left-width: 4px; padding-left: .55rem; }
  tr.attention td:first-child { border-left: 4px solid currentColor; padding-left: .45rem; }
  .demo-badge { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; opacity: .75; border: 1px solid currentColor; border-radius: 3px; padding: .05rem .3rem; margin-left: .4rem; }
`;

/** Everything that goes into HTML passes through here. With no exception. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * What project a page is showing, and what the switcher may switch to (t354).
 *
 * The screen holds NO state of its own beyond the `cartografo_project` cookie
 * the router reads (D11 unchanged): this object is built per request out of
 * that cookie plus one `GET /v1/projects`, and it dies with the response.
 *
 * `projects` is allowed to be empty, and the switcher then draws nothing. That
 * is the honest answer for a control plane too old to know the route, and it
 * keeps a listing failure from turning every page of the screen into a 502.
 */
export interface ProjectScope {
  /** The project every read of this page is scoped to. */
  projectId: number;
  /** Every project that exists, for the switcher. */
  projects: Project[];
}

/** The single-project reading, for a page that was not given a scope. */
export const DEFAULT_SCOPE: ProjectScope = Object.freeze({ projectId: 1, projects: [] });

/**
 * The switcher's markup, in the nav every page carries.
 *
 * The class name is English, unlike the `.quadro`/`.pergunta` beside it: those
 * are a DOM contract the acceptance tests and the stylesheet already select on
 * and t133's exception 10 froze, and this one is new — nothing is born in
 * Portuguese (D24).
 *
 * A plain form and no script: it POSTs to `/project`, the router sets the
 * cookie and sends the browser back where it was. `onchange` submits it so the
 * common case is one click, and the submit button is what keeps it usable with
 * scripting off — the same posture the answer form on the questions page takes.
 *
 * Nothing is drawn while there is only one project: a switcher with one option
 * is furniture, and the screen has no room for furniture.
 *
 * @param scope The project in force and the ones that exist.
 * @returns The `<form>`, or an empty string.
 */
function projectSwitcher(scope: ProjectScope): string {
  if (scope.projects.length < 2) return '';

  const options = scope.projects
    .map(
      (project) =>
        `<option value="${project.id}"${project.id === scope.projectId ? ' selected' : ''}>${escapeHtml(project.name)}</option>`,
    )
    .join('');

  return `<form class="project-switcher" method="post" action="/project">
    <label for="project_id">project</label>
    <select id="project_id" name="project_id" onchange="this.form.submit()">${options}</select>
    <button type="submit">switch</button>
  </form>`;
}

/**
 * The shared shell: same navigation on every page, so there is no dead end.
 *
 * @param title Page title.
 * @param body Already-escaped page body.
 * @param scope Which project is in force; the switcher is drawn from it (t354).
 * @param autoRefresh Draws `<meta http-equiv="refresh" content="30">` — `/board`
 *   ALONE sets this (t416, FR9). Every other page leaves it `false`, since a
 *   form on a page that reloads itself can lose what someone is mid-typing —
 *   the reason `/input-requests` and the rest keep today's behaviour.
 * @returns The whole document.
 */
function layout(
  title: string,
  body: string,
  scope: ProjectScope = DEFAULT_SCOPE,
  autoRefresh = false,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${autoRefresh ? '<meta http-equiv="refresh" content="30">\n' : ''}<title>${escapeHtml(title)} · cartografo</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topo">
  <h1>cartografo</h1>
  <nav>
    <a href="/">check</a>
    <a href="/board">board</a>
    <a href="/examples">examples</a>
    <a href="/executions">executions</a>
    <a href="/input-requests">questions</a>
    <a href="/runners">runners</a>
    <a href="/inbox">proposals</a>
    <a href="/graph-editor.html">graph</a>
  </nav>
  ${projectSwitcher(scope)}
</header>
${body}
</body>
</html>
`;
}

/** Readable duration: what matters is the order of magnitude, not the ms. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'still open';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}min`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
/**
 * The block-reason line a card carries when `job.blocked` (t107, t310).
 *
 * Factored out so the six-state board (t416) reuses the exact same fallback
 * text instead of duplicating it — `job.blocked` decides this line
 * independently of which state band the job landed in (a job can be
 * `awaiting_you` and still carry a block reason, RF-30's ambiguity 1).
 */
function blockReasonHtml(job: Job): string {
  if (!job.blocked) return '';
  return job.block_reason !== null
    ? `<p class="motivo">⛔ ${escapeHtml(job.block_reason)}</p>`
    : '<p class="motivo">⛔ blocked, with no reason declared</p>';
}

/**
 * The form behind a job's blocked flag — one action, a reason, and a name (t339).
 *
 * The same shape for both halves, because they are the same decision seen from
 * either side: state why, say who, submit. Which one a surface offers is decided
 * by the flag alone, never by the form — a blocked job gets `unblock` and
 * nothing else, a healthy one gets `block` and nothing else. Offering an action
 * the control plane would refuse is the failure mode `resolveActionsForStatus`
 * exists to prevent on the inbox, and it is avoided here the same way.
 *
 * The reason field carries a visible `<label>` tied by `for`/`id`, the same rule
 * `questionCard` follows and for the same reason: it is the required field of
 * the form, and a placeholder is not a reliable accessible name. The id is
 * qualified by the action as well as the job, because `/jobs/:id` renders one of
 * these on a page that also has a header with the same job's id.
 *
 * `actor_ref` defaults to {@link DEFAULT_ANSWERED_BY} for the reason that
 * constant records: the screen holds one service credential and asks the browser
 * for nothing, so "tela" is honestly all the system knows when nobody types a
 * name. What it must NOT do is send nothing — an absent actor makes the control
 * plane record its own identity, and the audit would then say the system blocked
 * what a person blocked.
 *
 * @param job The job the action is about.
 * @param action `block` or `unblock` — the route, the button and the id prefix.
 * @param prompt The label over the reason field.
 * @returns The form, ready to go into a card or a page.
 */
function flagForm(job: Job, action: 'block' | 'unblock', prompt: string): string {
  const field = `reason-${action}-${job.id}`;
  return `<form class="action" method="post" action="/jobs/${job.id}/${action}">
      <label for="${field}">${escapeHtml(prompt)}</label>
      <textarea id="${field}" name="reason" required placeholder="in one sentence, so the log says why"></textarea>
      <p>
        <label>who is doing this <input name="actor_ref" value="${escapeHtml(DEFAULT_ANSWERED_BY)}"></label>
        <button type="submit">${action}</button>
      </p>
    </form>`;
}

/**
 * The door out of a held job, drawn wherever that job is shown (t339).
 *
 * Shared by `/executions/:id`'s cards ({@link jobCard}) and by the board's own
 * state cards and rows (t416), so the release form does not depend on which of
 * the two shapes the reader is looking at: a job past the row-mode threshold is
 * still a job somebody has to let through.
 */
function releaseFormHtml(job: Job): string {
  return job.blocked ? flagForm(job, 'unblock', 'why it can move again') : '';
}

/**
 * A job on an execution's board — and, when it is being held, the door out of
 * it (t339).
 *
 * Unblock lives on the card and not on `/jobs/:id` because releasing is done to
 * a queue: the standing consumer files every rule promotion as a job born
 * blocked, and the human gate is walking the held column and letting them
 * through. Block is the opposite act — deliberate, one at a time — and lives on
 * the job's own page, so the grid does not carry a form on every card.
 */
function jobCard(job: Job): string {
  const classes = job.blocked ? 'cartao bloqueado' : 'cartao';
  return `<article class="${classes}" data-trabalho="${job.id}">
      <div class="id">#${job.id}</div>
      <a href="/jobs/${job.id}">${escapeHtml(job.title)}</a>
      ${blockReasonHtml(job)}
      ${releaseFormHtml(job)}
    </article>`;
}

/**
 * The board: one column per occupied node, cards inside.
 *
 * Grouping by `no_atual` is what turns a list into a board — the question the
 * screen exists to answer is "where is work getting stuck?", and it only shows
 * up once the columns exist. The label is the node's RAW id: taking
 * `papel`/`descricao` from the graph snapshot is additive and stayed out of
 * scope.
 */
function jobBoard(jobs: Job[]): string {
  if (jobs.length === 0) return '<p class="vazio">No jobs here yet.</p>';

  const byNode = new Map<string, Job[]>();
  for (const job of jobs) {
    const group = byNode.get(job.current_node_id) ?? [];
    group.push(job);
    byNode.set(job.current_node_id, group);
  }

  const columns = [...byNode.entries()]
    .sort(([one], [other]) => one.localeCompare(other))
    .map(
      ([node, inNode]) => `<section class="grupo" data-no-atual="${escapeHtml(node)}">
    <h2>${escapeHtml(node)} <span class="id">(${inNode.length})</span></h2>
    ${inNode.map(jobCard).join('\n    ')}
  </section>`,
    );

  return `<div class="quadro">\n  ${columns.join('\n  ')}\n</div>`;
}

/* ------------------------------------------------------- the board (t416) */

/**
 * The six states, in RF-30's attention priority — and the exact order
 * `deriveJobState` checks them in on the control plane (t415). A board sorted
 * any other way would answer a different question than "is anything waiting
 * on me?".
 */
const STATE_ORDER: readonly JobState[] = [
  'awaiting_you',
  'blocked_unasked',
  'running',
  'unowned',
  'completed',
  'queued',
];

/** Board-wide job count past which a band becomes a table instead of cards (FR4/FR5). */
const ROW_MODE_THRESHOLD = 12;

/** The two states a person is actually waiting on (FR7) — the left-edge bar. */
function isAttentionState(state: JobState): boolean {
  return state === 'awaiting_you' || state === 'blocked_unasked';
}

/** A job whose `fields.demo` reads truthy, by plain JS truthiness (FR8). */
function isDemoJob(job: Job): boolean {
  return Boolean(job.fields?.demo);
}

function demoBadgeHtml(job: Job): string {
  return isDemoJob(job) ? '<span class="demo-badge">demo</span>' : '';
}

/**
 * The duration/anchor pair every card and row carries (FR6): how long the job
 * has been in its current state, next to the SAME instant the whole page was
 * rendered against — never a fresh clock read per job, so the numbers on one
 * page always add up against one one truth.
 */
function jobMetaHtml(job: Job, now: number, renderedAt: string): string {
  const words = job.state.replaceAll('_', ' ');
  const duration = formatDuration(now - Date.parse(job.state_since));
  return `<p class="motivo">${escapeHtml(words)} · <span class="id">@${escapeHtml(job.current_node_id)}</span> · for ${escapeHtml(duration)} · as of ${escapeHtml(renderedAt)}</p>`;
}

/**
 * One job, as a card — the shape a band takes at {@link ROW_MODE_THRESHOLD} or
 * under.
 *
 * Carries the release form of a held job ({@link releaseFormHtml}, t339) for
 * the same reason `jobCard` does: the board is where a queue of held jobs is
 * walked and let through, and banding it by state (t416) moved the cards
 * without moving that door.
 */
function stateCard(job: Job, now: number, renderedAt: string): string {
  const classes = ['cartao', job.blocked ? 'bloqueado' : null, isAttentionState(job.state) ? 'attention' : null]
    .filter((one): one is string => one !== null)
    .join(' ');
  return `<article data-trabalho="${job.id}" class="${classes}">
      <div class="id">#${job.id}</div>
      <a href="/jobs/${job.id}">${escapeHtml(job.title)}</a>${demoBadgeHtml(job)}
      ${jobMetaHtml(job, now, renderedAt)}
      ${blockReasonHtml(job)}
      ${releaseFormHtml(job)}
    </article>`;
}

/**
 * One job, as a table row — the shape a band takes past
 * {@link ROW_MODE_THRESHOLD}.
 *
 * The note column carries the block reason AND the release form (t339): a board
 * past a dozen jobs is exactly the one whose held column most needs walking, so
 * row mode must not be the shape where the way out quietly disappears.
 */
function stateRow(job: Job, now: number, renderedAt: string): string {
  const rowClass = isAttentionState(job.state) ? ' class="attention"' : '';
  const words = job.state.replaceAll('_', ' ');
  const duration = formatDuration(now - Date.parse(job.state_since));
  return `<tr data-trabalho="${job.id}"${rowClass}>
      <td>#${job.id}</td>
      <td><a href="/jobs/${job.id}">${escapeHtml(job.title)}</a>${demoBadgeHtml(job)}</td>
      <td>${escapeHtml(words)}</td>
      <td>${escapeHtml(job.current_node_id)}</td>
      <td>for ${escapeHtml(duration)} · as of ${escapeHtml(renderedAt)}</td>
      <td>${blockReasonHtml(job)}${releaseFormHtml(job)}</td>
    </tr>`;
}

/** A band's jobs, still grouped by node — card mode's shape, unchanged from {@link jobBoard} (FR4). */
function cardBand(jobs: Job[], now: number, renderedAt: string): string {
  const byNode = new Map<string, Job[]>();
  for (const job of jobs) {
    const group = byNode.get(job.current_node_id) ?? [];
    group.push(job);
    byNode.set(job.current_node_id, group);
  }

  const columns = [...byNode.entries()]
    .sort(([one], [other]) => one.localeCompare(other))
    .map(
      ([node, inNode]) => `<section class="grupo" data-no-atual="${escapeHtml(node)}">
    <h2>${escapeHtml(node)} <span class="id">(${inNode.length})</span></h2>
    ${inNode.map((job) => stateCard(job, now, renderedAt)).join('\n    ')}
  </section>`,
    );

  return `<div class="quadro">\n  ${columns.join('\n  ')}\n</div>`;
}

/** A band's jobs, flat and sorted — row mode's shape: time-order, not node-order (FR5). */
function rowBand(jobs: Job[], now: number, renderedAt: string): string {
  const rows = jobs.map((job) => stateRow(job, now, renderedAt));
  return `<table>
  <thead><tr><th>job</th><th>title</th><th>state</th><th>node</th><th>time</th><th>note</th></tr></thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>`;
}

/** Jobs of one band, in attention order (FR3): oldest wait first, id as the tie-break. */
function sortByStateSince(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const bySince = Date.parse(a.state_since) - Date.parse(b.state_since);
    return bySince !== 0 ? bySince : a.id - b.id;
  });
}

/**
 * The board's six state bands (t416, FR2-FR6): every job grouped into the
 * state it derived to, in RF-30's attention order, each band sorted by how
 * long it has been waiting — and only drawn at all when it holds a job, the
 * same way `jobBoard` never drew an empty node column.
 *
 * `now`/`renderedAt` are captured ONCE by the caller and threaded through
 * every card and row on the page — not one clock read per job.
 */
function stateBoard(jobs: Job[], now: number, renderedAt: string): string {
  if (jobs.length === 0) return '<p class="vazio">No jobs here yet.</p>';

  const rowMode = jobs.length > ROW_MODE_THRESHOLD;
  const byState = new Map<JobState, Job[]>();
  for (const job of jobs) {
    const group = byState.get(job.state) ?? [];
    group.push(job);
    byState.set(job.state, group);
  }

  const bands = STATE_ORDER.filter((state) => (byState.get(state)?.length ?? 0) > 0).map((state) => {
    const inState = sortByStateSince(byState.get(state) as Job[]);
    const body = rowMode ? rowBand(inState, now, renderedAt) : cardBand(inState, now, renderedAt);
    return `<section data-state="${state}">
  <h2>${escapeHtml(state.replaceAll('_', ' '))} <span class="id">(${inState.length})</span></h2>
  ${body}
</section>`;
  });

  return bands.join('\n');
}

/**
 * The sessions of a round, one row each.
 *
 * The last cell is a raw link to `/v1/sessions/:id/transcript` — the API's own
 * route, reached through the verbatim `/v1/*` proxy, so the screen gains no
 * route and no privilege (D11). It is deliberately not a rendered view:
 * decoding `stream-json` on the screen is another ticket, and until it exists
 * the raw output is still the difference between diagnosing a dead session and
 * re-running it (t159).
 *
 * Every row gets the link, including the sessions still open: the route answers
 * for them too, and a link that only appears after the fact is a link nobody
 * looks for.
 *
 * The link carries the page's OWN project (t411). `GET /v1/sessions/:id/
 * transcript` resolves the session's project through its `session.opened` and
 * refuses one opened elsewhere, so a bare link would 404 for every project but
 * the default one — the fix to the leak breaking the link the same day. The
 * proxy forwards the query string verbatim, so nothing else has to change.
 *
 * @param sessions The sessions of the page, in the order they are shown.
 * @param projectId The project the page is being read under.
 * @returns The table, or the empty-state paragraph.
 */
function sessionsTable(sessions: Session[], projectId: number): string {
  if (sessions.length === 0) return '<p class="vazio">No sessions in this execution.</p>';

  const rows = sessions.map((session) => {
    const usage =
      session.usage === null
        ? '—'
        : `${session.usage.input_tokens} in / ${session.usage.output_tokens} out`;
    return `<tr data-sessao="${session.id}">
      <td>#${session.id}</td>
      <td>${session.job_id === null ? '—' : `<a href="/jobs/${session.job_id}">#${session.job_id}</a>`}</td>
      <td>${escapeHtml(session.engine)}</td>
      <td>${escapeHtml(session.status)}</td>
      <td>${escapeHtml(session.opened_at)}</td>
      <td>${session.finished_at === null ? '<span class="vazio">in progress</span>' : escapeHtml(session.finished_at)}</td>
      <td>${escapeHtml(usage)}</td>
      <td><a data-transcricao="${session.id}" href="/v1/sessions/${session.id}/transcript?project_id=${projectId}">see output</a></td>
    </tr>`;
  });

  return `<table>
  <thead><tr><th>session</th><th>job</th><th>engine</th><th>status</th><th>opened at</th><th>finished at</th><th>usage</th><th>transcript</th></tr></thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>`;
}

/** A question in read mode — the version with a form lives at `/input-requests`. */
function questionSummary(question: Question): string {
  return `<article class="pergunta" data-pergunta="${question.id}">
  <strong>${escapeHtml(question.question)}</strong>
  <p class="motivo">job <a href="/jobs/${question.job_id}">#${question.job_id}</a> · since ${escapeHtml(question.created_at)} · <a href="/input-requests">answer</a></p>
</article>`;
}

/**
 * A question with the inline form.
 *
 * The card carries EVERYTHING the API stored — context, options, recommendation
 * and default answer — because the criterion is the same as
 * `GET /v1/input-requests`: whoever answers has to be able to decide without
 * opening the repository.
 *
 * The answer field carries a visible `<label>` tied by `for`/`id`, not just a
 * placeholder: a placeholder is a hint, it disappears at the first character
 * typed and it is not a reliable accessible name — and this is the only
 * required field of the page. The id comes from the question's own id, which is
 * already the card's unique key (`data-pergunta`, the form's `action`) and
 * arrives whole from the API, leaving no room to break the `for`/`id` pair.
 * Pinned by `packages/screen/test/questions-answer-field.test.ts`; it is the same
 * fix `t128` made on the inbox's reason field.
 */
function questionCard(question: Question): string {
  const field = (label: string, value: string | null): string =>
    value === null || value === '' ? '' : `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;

  const options =
    question.options === null || question.options.length === 0
      ? ''
      : `<div class="opcoes">${question.options
          .map(
            (option) =>
              `<button type="button" data-opcao="${escapeHtml(option)}">${escapeHtml(option)}</button>`,
          )
          .join('\n      ')}</div>`;

  return `<article class="pergunta" data-pergunta="${question.id}">
  <strong>${escapeHtml(question.question)}</strong>
  <dl>
    <dt>job</dt><dd><a href="/jobs/${question.job_id}">#${question.job_id}</a></dd>
    ${field('created at', question.created_at)}
    ${field('context', question.context)}
    ${field('recommendation', question.recommendation)}
    ${field('default answer', question.default_answer)}
  </dl>
  <form method="post" action="/input-requests/${question.id}/answer">
    ${options}
    <label for="resposta-${question.id}">your answer</label>
    <textarea id="resposta-${question.id}" name="resposta" required placeholder="the answer, as you would give it to a person">${escapeHtml(question.default_answer ?? '')}</textarea>
    <p>
      <label>who is answering <input name="respondido_por" value="${escapeHtml(DEFAULT_ANSWERED_BY)}"></label>
      <button type="submit">answer</button>
    </p>
  </form>
</article>`;
}

/**
 * The only JavaScript the screen sends: copy the clicked option into the field.
 *
 * Real progressive enhancement — without it, typing the answer keeps working,
 * and no other screen depends on any script at all.
 */
const OPTIONS_SCRIPT = `<script>
document.addEventListener('click', function (event) {
  var target = event.target;
  if (target === null || target.dataset === undefined || target.dataset.opcao === undefined) return;
  var form = target.closest('form');
  var field = form === null ? null : form.querySelector('textarea[name="resposta"]');
  if (field !== null) { field.value = target.dataset.opcao; field.focus(); }
});
</script>`;

function segmentHtml(segment: Segment): string {
  const label = segment.category.replaceAll('_', ' ');
  const detail = segment.detail === null ? '' : ` — ${escapeHtml(segment.detail)}`;
  const node = segment.nodeId === null ? '' : ` <span class="id">@${escapeHtml(segment.nodeId)}</span>`;
  const end = segment.end === null ? 'now' : escapeHtml(segment.end);
  return `  <li class="segmento" data-segmento="${segment.category}" data-inicio="${escapeHtml(segment.start)}" data-fim="${segment.end === null ? '' : escapeHtml(segment.end)}">
    <span class="balde">${escapeHtml(label)}</span>
    <span>${escapeHtml(formatDuration(segment.durationMs))}${node}${detail}<br><span class="id">${escapeHtml(segment.start)} → ${end}</span></span>
  </li>`;
}

function totalsHtml(timeline: Timeline): string {
  return `<table>
  <thead><tr><th>bucket</th><th>closed time</th></tr></thead>
  <tbody>
    <tr><td>fila</td><td>${escapeHtml(formatDuration(timeline.totals.fila))}</td></tr>
    <tr><td>agente trabalhando</td><td>${escapeHtml(formatDuration(timeline.totals.agente_trabalhando))}</td></tr>
    <tr><td>esperando humano</td><td>${escapeHtml(formatDuration(timeline.totals.esperando_humano))}</td></tr>
  </tbody>
</table>`;
}

/* ------------------------------------------------------ the check page (t402) */

/**
 * Where support goes when the page cannot say what is wrong (FR7).
 *
 * Drawn once, in every state including the ready one: the person who opens this
 * screen for the first time is the person least able to tell "not configured"
 * from "broken", and a check page with no way out for the second case is a dead
 * end at exactly the moment one is most expensive.
 */
const SUPPORT_ADDRESS = 'hello@agentsmaestro.dev';

/** The MCP server the check looks for, by the name `.mcp.json` already uses. */
const MCP_SERVER_NAME = 'cartografo';

/**
 * The command an MCP client is registered with, in the shape
 * `packages/mcp/README.md` gives for driving cartografo from another project.
 *
 * Absolute and a placeholder, exactly as that README writes it: an MCP client
 * starts the server from a configuration file that is not this repository, so
 * there is no relative path that would work from where it is read.
 */
const MCP_ENTRYPOINT = 'node /absolute/path/to/cartografo/packages/mcp/bin/mcp.mjs';

/** Control plane the fix actions quote, matching every other default in the docs. */
const CONTROL_PLANE_HINT = 'http://127.0.0.1:4317';

/** What to put where the credential goes, since this screen never learns it. */
const TOKEN_HINT = '<the token printed when the control plane started>';

/** Stand-ins for the two roots when no setting records them yet (FR2). */
const WORKING_DIR_PLACEHOLDER = '<the repository the sessions work in>';
const WORKTREES_ROOT_PLACEHOLDER = '<a sibling directory, never inside it>';

/** The engine the runner takes when nothing recorded one (`settings.engine`). */
const DEFAULT_ENGINE = 'claude-code';

/**
 * Everything the fix actions need to know about one engine.
 *
 * Every field below is READ OFF this repository and nothing else — the binary
 * name each adapter spawns, the credential variables each adapter's preflight
 * checks, the credential file each preflight reads, the `mcp add` shape each
 * engine's own measured `--help` gives. That restriction is the point: this is
 * the page whose entire premise is "nothing is asked that the system can
 * discover", and a command asserted here from general knowledge would carry the
 * same authority as the ones that were measured, while being worth much less.
 *
 * Which is why `claude-code` has no install command and says so instead: no npm
 * package name for that CLI is evidenced anywhere in this repository, and
 * inventing one on this page would be the exact failure above.
 */
interface EngineProfile {
  /** The binary the adapter really spawns. */
  binary: string;
  /** How to get it, in this engine's own terms; `null` when nothing is evidenced. */
  installCommand: string | null;
  /** The variables THIS engine's adapter reads as a credential. */
  credentialVariables: readonly string[];
  /** The file this CLI's own interactive login writes, as the preflight reads it. */
  credentialsFile: string | null;
  /** The command that registers {@link MCP_SERVER_NAME} with this engine. */
  mcpAddCommand: string | null;
}

/**
 * The two adapters this product ships, and the honest answer for anything else.
 *
 * An unrecognized `engine` setting is not a failure to render: the setting is
 * free text the operator wrote, and a page that broke on it would be less
 * useful than one that says which two names it knows how to help with.
 *
 * @param engine The `engine` setting, or the default when none is recorded.
 * @returns What the fix actions for that engine may say.
 */
function engineProfile(engine: string): EngineProfile {
  if (engine === 'claude-code') {
    return {
      // `CLAUDE_BINARY`, packages/runner/src/engine/command.ts.
      binary: 'claude',
      installCommand: null,
      // `CREDENTIAL_VARIABLES`, packages/runner/src/engine/claude-code-adapter.ts.
      credentialVariables: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
      credentialsFile: '~/.claude.json',
      // packages/mcp/README.md, verbatim but for the placeholders.
      mcpAddCommand: `claude mcp add ${MCP_SERVER_NAME} \\
  -e CARTOGRAFO_URL=${CONTROL_PLANE_HINT} \\
  -e CARTOGRAFO_MCP_TOKEN=${TOKEN_HINT} \\
  -- ${MCP_ENTRYPOINT}`,
    };
  }

  if (engine === 'codex') {
    return {
      // `CODEX_BINARY`, packages/runner/src/engine/codex-command.ts.
      binary: 'codex',
      // docs/formats/engine-adapter.md: the whole codex evidence was gathered
      // through this command, on a machine where the CLI was not installed.
      installCommand: 'npx --yes @openai/codex@latest',
      // `CODEX_CREDENTIAL_VARIABLES`, packages/runner/src/engine/codex-adapter.ts.
      credentialVariables: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
      credentialsFile: '$CODEX_HOME/auth.json (~/.codex/auth.json by default)',
      // `codex mcp add <name> -- <command>` is the measured shape, and it
      // documents no `-e`: the credential is exported in the shell the client
      // starts the server from, which is what packages/mcp/README.md already
      // says is the whole of the setup.
      mcpAddCommand: `export CARTOGRAFO_URL=${CONTROL_PLANE_HINT}
export CARTOGRAFO_MCP_TOKEN=${TOKEN_HINT}
codex mcp add ${MCP_SERVER_NAME} -- ${MCP_ENTRYPOINT}`,
    };
  }

  return {
    binary: engine,
    installCommand: null,
    credentialVariables: [],
    credentialsFile: null,
    mcpAddCommand: null,
  };
}

/** One check of one runner, already decided. */
interface CheckLine {
  /** The `data-campo` marker, and the contract the acceptance tests read. */
  field: 'engine' | 'credential' | 'mcp' | 'workspace';
  met: boolean;
  /** The one line a person reads: what is true, or what is missing. */
  headline: string;
  /** What to do about it, already escaped; empty when there is nothing to do. */
  fix: string;
}

/** A copyable command block — the only shape a fix action ever takes. */
function commandBlock(command: string): string {
  return `<pre><code>${escapeHtml(command)}</code></pre>`;
}

/** One sentence of a fix action. */
function fixText(text: string): string {
  return `<p>${escapeHtml(text)}</p>`;
}

/**
 * "Check again": the only control an unmet line always carries (FR5).
 *
 * It writes for real (`POST /v1/runners/:id/rechecks`) and comes back to this
 * page. What it does NOT do is wait: the runner serves the request on its next
 * loop tick, and reloading is how the new probe becomes visible — the same
 * posture every other view of this screen takes, since none of them polls.
 */
function recheckForm(runnerId: string): string {
  return `<form method="post" action="/runners/${encodeURIComponent(runnerId)}/rechecks">
    <button type="submit">check again</button>
  </form>`;
}

/**
 * The two roots, as a form that writes them (FR6).
 *
 * Prefilled from the PROBE first and the settings second, because they answer
 * different questions: the probe says what this runner was actually pointed at,
 * the settings say what it would be pointed at next time. When the two disagree,
 * the one worth correcting is the one that is broken right now.
 */
function workspaceForm(runnerId: string, workingDir: string, worktreesRoot: string): string {
  const key = escapeHtml(runnerId);
  return `<form method="post" action="/settings">
    <p><label for="workspace_root-${key}">workspace root</label>
    <input id="workspace_root-${key}" name="workspace_root" value="${escapeHtml(workingDir)}"></p>
    <p><label for="worktrees_root-${key}">worktrees root</label>
    <input id="worktrees_root-${key}" name="worktrees_root" value="${escapeHtml(worktreesRoot)}"></p>
    <button type="submit">save</button>
  </form>`;
}

/** The engine line: is the CLI this runner dispatches through even there? */
function engineLine(probe: RunnerProbe, profile: EngineProfile): CheckLine {
  if (probe.cli.available) {
    return {
      field: 'engine',
      met: true,
      headline: `engine found — ${profile.binary} ${probe.cli.version ?? '(version unknown)'}`,
      fix: '',
    };
  }

  const install =
    profile.installCommand === null
      ? fixText(
          `Install the \`${profile.binary}\` CLI on this machine — its own installation documentation is the source of truth, and this repository records no package name for it.`,
        )
      : `${fixText(`Install the \`${profile.binary}\` CLI on this machine, or run it with no install at all:`)}${commandBlock(profile.installCommand)}`;

  return {
    field: 'engine',
    met: false,
    headline: `engine not found — the runner could not run \`${profile.binary}\``,
    fix: install,
  };
}

/** The credential line: would a session this runner opens be able to authenticate? */
function credentialLine(probe: RunnerProbe, profile: EngineProfile): CheckLine {
  if (probe.cli.authenticated) {
    return { field: 'credential', met: true, headline: 'model credential found', fix: '' };
  }

  if (profile.credentialVariables.length === 0) {
    return {
      field: 'credential',
      met: false,
      headline: 'no model credential — the CLI reported none',
      fix: fixText(
        `This runner is configured with the engine \`${profile.binary}\`, which is neither of the two adapters this product ships, so nothing here knows which variables it reads. Authenticate its CLI the way its own documentation says.`,
      ),
    };
  }

  const exports = profile.credentialVariables
    .map((variable) => `export ${variable}=…`)
    .join('\n');

  return {
    field: 'credential',
    met: false,
    headline: 'no model credential — the CLI reported none',
    fix: `${fixText(
      "Export any one of these in the shell the runner starts from — they are the variables this engine's own adapter checks:",
    )}${commandBlock(`# any one of the three\n${exports}`)}${fixText(
      profile.credentialsFile === null
        ? `Or log in with the \`${profile.binary}\` CLI itself.`
        : `Or log in with the \`${profile.binary}\` CLI itself, which writes the credential file the runner also reads: ${profile.credentialsFile}.`,
    )}`,
  };
}

/**
 * The MCP line: is the model driving this browser on the same map as its reader?
 *
 * Specifically "is the `cartografo` server registered", and not "does this
 * engine support MCP at all". The second is not something a command fixes; the
 * first is the whole reason RF-10 lists this check.
 *
 * `{supported: false}` is its own answer and never a failure: t400 made
 * `discoverMcpServers?()` optional precisely because an adapter that never
 * implemented discovery is not an engine with zero MCP servers, and a page that
 * collapsed the two would report a machine as broken for a gap in our code.
 */
function mcpLine(probe: RunnerProbe, profile: EngineProfile): CheckLine {
  if (!probe.mcp.supported) {
    return {
      field: 'mcp',
      met: false,
      headline: `MCP servers — this engine's adapter can't be checked automatically`,
      fix: fixText(
        `The \`${profile.binary}\` adapter implements no MCP discovery, so nothing here can say whether the ${MCP_SERVER_NAME} server is registered. Ask the engine itself; there is nothing to react to here.`,
      ),
    };
  }

  if (probe.mcp.servers.some((server) => server.name === MCP_SERVER_NAME)) {
    return {
      field: 'mcp',
      met: true,
      headline: `MCP servers — ${MCP_SERVER_NAME} is registered`,
      fix: '',
    };
  }

  return {
    field: 'mcp',
    met: false,
    headline: `MCP servers — ${MCP_SERVER_NAME} is not registered with this engine`,
    fix:
      profile.mcpAddCommand === null
        ? fixText(
            `Register the ${MCP_SERVER_NAME} server with \`${profile.binary}\` the way its own documentation says: it runs ${MCP_ENTRYPOINT}, with CARTOGRAFO_URL and CARTOGRAFO_MCP_TOKEN in its environment.`,
          )
        : `${fixText("Register it with the engine's own command:")}${commandBlock(profile.mcpAddCommand)}`,
  };
}

/** The workspace line: can a session actually be cut on this machine? */
function workspaceLine(probe: RunnerProbe, settings: Settings): CheckLine {
  const { workspace } = probe;
  if (workspace.is_git_repo && workspace.worktrees_root_writable) {
    return {
      field: 'workspace',
      met: true,
      headline: `workspace usable — ${workspace.working_dir_resolved}`,
      fix: '',
    };
  }

  const problems = [
    workspace.is_git_repo ? null : `${workspace.working_dir_resolved} is not a git repository`,
    workspace.worktrees_root_writable
      ? null
      : `${workspace.worktrees_root_resolved} cannot be created by this runner`,
  ].filter((problem): problem is string => problem !== null);

  return {
    field: 'workspace',
    met: false,
    headline: `workspace unusable — ${problems.join('; ')}`,
    fix: `${fixText('Point this project at directories that work; the runner picks these up when it is started without --working-dir/--worktrees-root.')}${workspaceForm(
      probe.runner_id,
      workspace.working_dir || settings.workspace_root || '',
      workspace.worktrees_root || settings.worktrees_root || '',
    )}`,
  };
}

/**
 * The four lines of one runner that has never said anything about itself.
 *
 * Deliberately NOT four diagnoses: with no probe there is nothing known to
 * react to, and drawing an install command against a machine that may well have
 * everything would be the page inventing a failure. The only action offered is
 * the one that changes the situation — ask for a report.
 */
function waitingLines(): CheckLine[] {
  const fields: CheckLine['field'][] = ['engine', 'credential', 'mcp', 'workspace'];
  return fields.map((field) => ({
    field,
    met: false,
    headline: "waiting for this runner's first report",
    fix: '',
  }));
}

/** One line, drawn: the verdict, the fix and the way to ask again. */
function checkLineHtml(line: CheckLine, runnerId: string): string {
  const action = line.met ? '' : `${line.fix}${recheckForm(runnerId)}`;
  return `<div class="verificacao" data-campo="${line.field}" data-estado="${line.met ? 'met' : 'unmet'}">
    <p class="titulo">${line.met ? '✓' : '✗'} ${escapeHtml(line.headline)}</p>
    ${action}
  </div>`;
}

/**
 * The four checks of one runner, decided against what it reported.
 *
 * @param runner The runner and its latest probe.
 * @param settings The project's recorded defaults, for the engine and the roots.
 * @returns The four lines, in the order RF-10 lists them.
 */
function runnerLines(runner: RunnerHealth, settings: Settings): CheckLine[] {
  const probe = runner.probe ?? null;
  if (probe === null) return waitingLines();

  const profile = engineProfile(settings.engine ?? DEFAULT_ENGINE);
  return [
    engineLine(probe, profile),
    credentialLine(probe, profile),
    mcpLine(probe, profile),
    workspaceLine(probe, settings),
  ];
}

/** The command that pairs the first runner, built from whatever is recorded. */
function pairingCommand(projectId: number, settings: Settings): string {
  return [
    'npx cartografo-runner',
    `--project ${projectId}`,
    `--working-dir ${settings.workspace_root ?? WORKING_DIR_PLACEHOLDER}`,
    `--worktrees-root ${settings.worktrees_root ?? WORKTREES_ROOT_PLACEHOLDER}`,
    `--engine ${settings.engine ?? DEFAULT_ENGINE}`,
  ].join(' ');
}

/**
 * `GET /` — the check that runs itself (t402, RF-10 to RF-12).
 *
 * The first page a person opens is not a form: it is two reads the API already
 * publishes — the fleet with t401's embedded probe, and t403's per-project
 * settings — turned into either "everything this machine needs is ready" or the
 * exact list of what is missing, one fix each. No new privilege and no new core
 * route (D11): every fact on it was reported by a runner about its own machine,
 * and everything this page can change it changes through `PATCH /v1/settings`
 * and `POST /v1/runners/:id/rechecks`.
 *
 * **Per runner, not per fleet.** A single global verdict would let one working
 * machine hide a broken one, which is precisely the failure a readiness page
 * exists to prevent. The common case — one runner — degrades to one group, at
 * no visible cost.
 *
 * **The fleet read is unscoped and the settings read is not**, and the asymmetry
 * is the data's: pairing is identity alone (`listRunners`), while where a runner
 * works is a per-project decision.
 *
 * @param client Client of the public API.
 * @param scope Which project is in force; the settings read is scoped to it.
 * @returns The check page.
 */
export async function checkPage(
  client: ApiClient,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const [runners, settings] = await Promise.all([
    client.listRunners(),
    client.getSettings({ project_id: scope.projectId }),
  ]);

  const support = `<p class="suporte">Something here wrong, or missing? <a href="mailto:${SUPPORT_ADDRESS}">${SUPPORT_ADDRESS}</a></p>`;

  if (runners.length === 0) {
    const body = `<h2>check</h2>
<div class="verificacao" data-campo="runner" data-estado="unmet">
  <p class="titulo">✗ no runner paired — nothing on this machine is going to pick work up</p>
  ${fixText("Start one in another terminal, with the control plane's token in the environment:")}
  ${commandBlock(pairingCommand(scope.projectId, settings))}
</div>
${support}`;
    return { status: 200, html: layout('check', body, scope) };
  }

  const groups = runners.map((runner) => ({ runner, lines: runnerLines(runner, settings) }));

  if (groups.every((group) => group.lines.every((line) => line.met))) {
    const body = `<h2>check</h2>
<section class="pronto" data-pronto="${groups.length}">
  <p>Everything this machine needs is ready.</p>
  <p><a href="/board">open the board</a></p>
</section>
${support}`;
    return { status: 200, html: layout('check', body, scope) };
  }

  const drawn = groups
    .map(
      (group) => `<section data-runner="${escapeHtml(group.runner.id)}">
  <h2>${escapeHtml(group.runner.id)}</h2>
  ${group.lines.map((line) => checkLineHtml(line, group.runner.id)).join('\n  ')}
</section>`,
    )
    .join('\n');

  return { status: 200, html: layout('check', `<h2>check</h2>\n${drawn}\n${support}`, scope) };
}

/**
 * `GET /board` — the whole board, sorted by attention (t107 FR5; t416).
 *
 * Every job lands in one of the six states t415 derives, banded in RF-30's
 * attention priority — `awaiting_you` and `blocked_unasked` first — and, past
 * a dozen jobs board-wide, every band collapses from cards into one flat,
 * time-sorted table (`stateBoard`). This is also the one page on the whole
 * screen that auto-refreshes (`layout`'s fourth argument): the only page
 * carrying a live clock is the only one allowed to show relative time, and
 * the two together are what `docs/spec/screen.md` §1/§7 amend for `/board`
 * alone.
 *
 * @param client Client of the public API.
 * @returns The board page.
 */
export async function boardPage(
  client: ApiClient,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const jobs = await client.listJobs({ project_id: scope.projectId });
  // Captured ONCE, and reused for every job on the page (FR6) — the anchor
  // every relative duration reads against has to be one honest instant, not
  // one clock read per job.
  const now = Date.now();
  const renderedAt = new Date(now).toISOString();
  return {
    status: 200,
    html: layout(
      'board',
      `<h2>board · ${jobs.length} job(s)</h2>\n${stateBoard(jobs, now, renderedAt)}`,
      scope,
      true,
    ),
  };
}

/**
 * `GET /examples` — the bundles the control plane can demonstrate (t408, FR6).
 *
 * One card per entry of `GET /v1/examples`, each with a plain form and a submit
 * button: no JavaScript, no progress indicator, no confirmation step. The run
 * is one synchronous request in the same latency class as `cartografo import`,
 * and a spinner over it would be the screen pretending to know something about
 * a call it is only waiting on.
 *
 * `registered` is drawn because it changes what the click MEANS — the first one
 * registers a bundle this project has never seen, the second only opens another
 * job — and the button says the same thing in both cases because the route is
 * the same route.
 *
 * `data-exemplo` follows the `data-trabalho`/`data-pergunta` convention of this
 * file, Portuguese spelling included: those markers are a structural contract
 * the tests and the stylesheet select on (t133, exception 10), and a new marker
 * in a second vocabulary would leave the contract half in each.
 *
 * @param client Client of the public API.
 * @param scope Which project is in force.
 * @returns The examples page.
 */
export async function examplesPage(
  client: ApiClient,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const examples = await client.listExamples({ project_id: scope.projectId });

  const card = (example: Example): string => `<article class="cartao" data-exemplo="${escapeHtml(example.class)}">
  <div class="id">${escapeHtml(example.bundle)}</div>
  <strong>${escapeHtml(example.demo_title)}</strong>
  <p class="motivo">class <strong>${escapeHtml(example.class)}</strong> · ${
    example.registered ? 'already registered' : 'not registered yet'
  }</p>
  <form method="post" action="/examples/${encodeURIComponent(example.class)}/run">
    <button type="submit">run this example</button>
  </form>
</article>`;

  const body =
    examples.length === 0
      ? '<p class="vazio">No example bundle here. The control plane looks for them under its examples root (CARTOGRAFO_EXAMPLES_ROOT, factory-graphs/ by default).</p>'
      : `<div class="quadro">\n  <section class="grupo">\n  ${examples.map(card).join('\n  ')}\n  </section>\n</div>`;

  return {
    status: 200,
    html: layout('examples', `<h2>examples · ${examples.length}</h2>\n${body}`, scope),
  };
}

/**
 * `GET /executions` — the list of rounds (FR6).
 *
 * @param client Client of the public API.
 * @returns The executions list page.
 */
export async function executionsPage(
  client: ApiClient,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const executions = await client.listExecutions({ project_id: scope.projectId });

  const row = (execution: ExecutionSummary): string => {
    const label =
      execution.execution_id === null
        ? '<span class="vazio">no execution</span>'
        : `<a href="/executions/${execution.execution_id}">#${execution.execution_id}</a>`;
    return `<tr data-execucao="${execution.execution_id ?? ''}">
      <td>${label}</td>
      <td data-campo="trabalhos">${execution.jobs}</td>
      <td data-campo="trabalhos_bloqueados">${execution.blocked_jobs}</td>
      <td data-campo="perguntas_pendentes">${execution.pending_input_requests}</td>
    </tr>`;
  };

  const body =
    executions.length === 0
      ? '<p class="vazio">No executions yet.</p>'
      : `<table>
  <thead><tr><th>execution</th><th>jobs</th><th>blocked</th><th>pending questions</th></tr></thead>
  <tbody>
    ${executions.map(row).join('\n    ')}
  </tbody>
</table>`;

  return { status: 200, html: layout('executions', `<h2>executions</h2>\n${body}`, scope) };
}

/**
 * `GET /runners` — who is paired, and how alive each one looks (t164, FR3).
 *
 * The three derived columns come from the lease table on the other side of the
 * HTTP door, and are shown RAW: the instant as the control plane wrote it, with
 * no "3 minutes ago" arithmetic. It is the same convention every other
 * timestamp on this screen follows, and it is deliberate — a relative label
 * computed at render time on a page with no auto-refresh starts lying the
 * moment it is drawn.
 *
 * A runner that never held a lease shows three placeholders, and that is the
 * honest answer: this screen has no liveness signal beyond the leases, so
 * "never seen" and "down" look the same here (declared in `docs/spec/screen.md`).
 *
 * @param client Client of the public API.
 * @returns The fleet page.
 */
export async function runnersPage(
  client: ApiClient,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  // Unscoped on purpose: the fleet is not partitioned (see `listRunners`). The
  // scope reaches here only so the page carries the same switcher as every
  // other one — a nav that disappeared on one page would be a dead end.
  const runners = await client.listRunners();

  const missing = (what: string): string => `<span class="vazio">${escapeHtml(what)}</span>`;

  const row = (runner: RunnerHealth): string => {
    const expiration =
      runner.last_expiration === null
        ? missing('none')
        : escapeHtml(
            `job #${runner.last_expiration.job_id} (${
              runner.last_expiration.expiration_reason ?? 'no reason declared'
            }) at ${runner.last_expiration.expires_at}`,
          );

    return `<tr data-runner="${escapeHtml(runner.id)}">
      <td>${escapeHtml(runner.id)}</td>
      <td data-campo="nome">${runner.name === null ? missing('no name') : escapeHtml(runner.name)}</td>
      <td data-campo="leases_ativas">${runner.active_leases}</td>
      <td data-campo="ultimo_heartbeat">${runner.last_heartbeat === null ? missing('never') : escapeHtml(runner.last_heartbeat)}</td>
      <td data-campo="ultima_expiracao">${expiration}</td>
    </tr>`;
  };

  const body =
    runners.length === 0
      ? '<p class="vazio">No runner paired yet.</p>'
      : `<table>
  <thead><tr><th>runner</th><th>name</th><th>active leases</th><th>last heartbeat</th><th>last expiration</th></tr></thead>
  <tbody>
    ${runners.map(row).join('\n    ')}
  </tbody>
</table>`;

  return {
    status: 200,
    html: layout('runners', `<h2>runners · ${runners.length}</h2>\n${body}`, scope),
  };
}

/**
 * `GET /executions/:id` — board, sessions and questions of one round (FR7).
 *
 * An execution is an opaque grouper, not an entity: a round with nothing in it
 * answers 200 with an empty page, never 404 — the same reading the control
 * plane already makes in `GET /v1/executions/:id/metrics-by-version`.
 *
 * @param client Client of the public API.
 * @param executionId Execution id.
 * @returns The execution page.
 */
export async function executionPage(
  client: ApiClient,
  executionId: number,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const project_id = scope.projectId;
  const [jobs, sessions, questions] = await Promise.all([
    client.listJobs({ execution_id: executionId, project_id }),
    client.listSessions({ execution_id: executionId, project_id }),
    client.listQuestions({ execution_id: executionId, status: 'pending', project_id }),
  ]);

  const questionQueue =
    questions.length === 0
      ? '<p class="vazio">Nobody waiting for an answer in this execution.</p>'
      : questions.map(questionSummary).join('\n');

  return {
    status: 200,
    html: layout(
      `execution ${executionId}`,
      `<h2>execution #${executionId} · ${jobs.length} job(s)</h2>
${jobBoard(jobs)}
<h2>sessions</h2>
${sessionsTable(sessions, project_id)}
<h2>pending questions</h2>
${questionQueue}`,
      scope,
    ),
  };
}

/**
 * `GET /input-requests` — the escalation inbox, with inline answering (FR8).
 *
 * @param client Client of the public API.
 * @returns The question queue page.
 */
export async function questionsPage(
  client: ApiClient,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const questions = await client.listQuestions({
    status: 'pending',
    project_id: scope.projectId,
  });

  const body =
    questions.length === 0
      ? '<p class="vazio">Nobody waiting for an answer. 🎉</p>'
      : `${questions.map(questionCard).join('\n')}\n${OPTIONS_SCRIPT}`;

  return {
    status: 200,
    html: layout('questions', `<h2>pending questions · ${questions.length}</h2>\n${body}`, scope),
  };
}

/**
 * `GET /jobs/:id` — the timeline in three buckets (FR10).
 *
 * The three calls go out in parallel and the reconstruction happens in
 * `timeline.ts`; here it is only drawn. The header comes from a fourth read,
 * the job projection: the current title is there and NOT in the log —
 * `trabalho.emendado` records only the name of the changed field, so
 * reconstructing the title from the events would give the OLD title.
 *
 * @param client Client of the public API.
 * @param jobId Job id.
 * @returns The job page, or 404 when it does not exist.
 */
export async function jobPage(
  client: ApiClient,
  jobId: number,
  scope: ProjectScope = DEFAULT_SCOPE,
): Promise<Page> {
  const project_id = scope.projectId;
  const [job, events, sessions, questions] = await Promise.all([
    client.getJob(jobId, { project_id }),
    client.jobEvents(jobId, { project_id }),
    client.listSessions({ job_id: jobId, project_id }),
    client.listQuestions({ job_id: jobId, project_id }),
  ]);

  if (job === null || events === null) {
    return errorPage(404, 'job not found', `There is no job #${jobId}.`);
  }

  const timeline = buildTimeline({ events, sessions, questions, completed: job.completed });
  const state = timeline.done
    ? 'done'
    : job.blocked
      ? `blocked — ${job.block_reason ?? 'no reason declared'}`
      : 'in progress';

  const execution =
    job.execution_id === null
      ? '<span class="vazio">no execution</span>'
      : `<a href="/executions/${job.execution_id}">#${job.execution_id}</a>`;

  const segments =
    timeline.segments.length === 0
      ? '<p class="vazio">Nothing has happened to this job yet.</p>'
      : `<ul class="linha-do-tempo">\n${timeline.segments.map(segmentHtml).join('\n')}\n</ul>`;

  // Mutually exclusive with the blocked state, the same way the board's unblock
  // form is: a job that is already held has nothing to block, and the way out of
  // it is on `/board` (t339).
  const hold = job.blocked ? '' : `<h2>hold this job</h2>\n${flagForm(job, 'block', 'why it should stop here')}`;

  return {
    status: 200,
    html: layout(
      job.title,
      `<h2>#${job.id} · ${escapeHtml(job.title)}</h2>
<p>current node <strong>${escapeHtml(job.current_node_id)}</strong> · execution ${execution} · ${escapeHtml(state)}</p>
${hold}
<h2>timeline</h2>
${segments}
<h2>totals</h2>
${totalsHtml(timeline)}`,
      scope,
    ),
  };
}

/**
 * An error page — the screen never returns a stack trace nor a lying 200.
 *
 * @param status HTTP code.
 * @param title Short line of what happened.
 * @param detail What to do next, when there is something to do.
 * @returns The error page.
 */
export function errorPage(status: number, title: string, detail: string): Page {
  return {
    status,
    html: layout(
      title,
      `<h2>${escapeHtml(title)}</h2>\n<p>${escapeHtml(detail)}</p>\n<p><a href="/board">back to the board</a></p>`,
    ),
  };
}
