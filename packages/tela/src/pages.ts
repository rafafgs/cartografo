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
 * exception 10), and so does every string that reaches the browser: the screen
 * is a Portuguese-language product surface (exception 9).
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
  ExecutionSummary,
  Job,
  Question,
  RunnerHealth,
  Session,
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
 * than admitting the gap — the `pergunta.respondida` event is an audit trail.
 */
export const DEFAULT_ANSWERED_BY = 'tela';

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem 2rem 4rem; }
  header.topo { display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  header.topo h1 { font-size: 1.1rem; margin: 0; letter-spacing: .02em; }
  nav a { margin-right: 1rem; }
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
  .linha-do-tempo { list-style: none; padding: 0; max-width: 52rem; }
  .segmento { display: grid; grid-template-columns: 11rem 1fr; gap: .8rem; padding: .35rem 0; border-bottom: 1px solid currentColor; }
  .segmento .balde { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  .vazio { opacity: .6; font-style: italic; }
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

/** The shared shell: same navigation on every page, so there is no dead end. */
function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · cartografo</title>
<style>${STYLE}</style>
</head>
<body>
<header class="topo">
  <h1>cartografo</h1>
  <nav>
    <a href="/board">quadro</a>
    <a href="/executions">execuções</a>
    <a href="/input-requests">perguntas</a>
    <a href="/runners">runners</a>
    <a href="/">propostas</a>
    <a href="/graph-editor.html">grafo</a>
  </nav>
</header>
${body}
</body>
</html>
`;
}

/** Readable duration: what matters is the order of magnitude, not the ms. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return 'em aberto';
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

function jobCard(job: Job): string {
  const classes = job.blocked ? 'cartao bloqueado' : 'cartao';
  const reason =
    job.blocked && job.block_reason !== null
      ? `<p class="motivo">⛔ ${escapeHtml(job.block_reason)}</p>`
      : job.blocked
        ? '<p class="motivo">⛔ bloqueado, sem motivo declarado</p>'
        : '';
  return `<article class="${classes}" data-trabalho="${job.id}">
      <div class="id">#${job.id}</div>
      <a href="/jobs/${job.id}">${escapeHtml(job.title)}</a>
      ${reason}
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
  if (jobs.length === 0) return '<p class="vazio">Nenhum trabalho por aqui ainda.</p>';

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
 */
function sessionsTable(sessions: Session[]): string {
  if (sessions.length === 0) return '<p class="vazio">Nenhuma sessão nesta execução.</p>';

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
      <td>${session.finished_at === null ? '<span class="vazio">em andamento</span>' : escapeHtml(session.finished_at)}</td>
      <td>${escapeHtml(usage)}</td>
      <td><a data-transcricao="${session.id}" href="/v1/sessions/${session.id}/transcript">ver saída</a></td>
    </tr>`;
  });

  return `<table>
  <thead><tr><th>sessão</th><th>trabalho</th><th>engine</th><th>status</th><th>aberta em</th><th>finalizada em</th><th>uso</th><th>transcrição</th></tr></thead>
  <tbody>
    ${rows.join('\n    ')}
  </tbody>
</table>`;
}

/** A question in read mode — the version with a form lives at `/input-requests`. */
function questionSummary(question: Question): string {
  return `<article class="pergunta" data-pergunta="${question.id}">
  <strong>${escapeHtml(question.question)}</strong>
  <p class="motivo">trabalho <a href="/jobs/${question.job_id}">#${question.job_id}</a> · desde ${escapeHtml(question.created_at)} · <a href="/input-requests">responder</a></p>
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
 * Pinned by `packages/tela/test/questions-answer-field.test.ts`; it is the same
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
    <dt>trabalho</dt><dd><a href="/jobs/${question.job_id}">#${question.job_id}</a></dd>
    ${field('criada em', question.created_at)}
    ${field('contexto', question.context)}
    ${field('recomendação', question.recommendation)}
    ${field('resposta padrão', question.default_answer)}
  </dl>
  <form method="post" action="/input-requests/${question.id}/answer">
    ${options}
    <label for="resposta-${question.id}">sua resposta</label>
    <textarea id="resposta-${question.id}" name="resposta" required placeholder="a resposta, como você a daria a uma pessoa">${escapeHtml(question.default_answer ?? '')}</textarea>
    <p>
      <label>quem responde <input name="respondido_por" value="${escapeHtml(DEFAULT_ANSWERED_BY)}"></label>
      <button type="submit">responder</button>
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
  const end = segment.end === null ? 'agora' : escapeHtml(segment.end);
  return `  <li class="segmento" data-segmento="${segment.category}" data-inicio="${escapeHtml(segment.start)}" data-fim="${segment.end === null ? '' : escapeHtml(segment.end)}">
    <span class="balde">${escapeHtml(label)}</span>
    <span>${escapeHtml(formatDuration(segment.durationMs))}${node}${detail}<br><span class="id">${escapeHtml(segment.start)} → ${end}</span></span>
  </li>`;
}

function totalsHtml(timeline: Timeline): string {
  return `<table>
  <thead><tr><th>balde</th><th>tempo fechado</th></tr></thead>
  <tbody>
    <tr><td>fila</td><td>${escapeHtml(formatDuration(timeline.totals.fila))}</td></tr>
    <tr><td>agente trabalhando</td><td>${escapeHtml(formatDuration(timeline.totals.agente_trabalhando))}</td></tr>
    <tr><td>esperando humano</td><td>${escapeHtml(formatDuration(timeline.totals.esperando_humano))}</td></tr>
  </tbody>
</table>`;
}

/**
 * `GET /board` — the whole board (FR5).
 *
 * @param client Client of the public API.
 * @returns The board page.
 */
export async function boardPage(client: ApiClient): Promise<Page> {
  const jobs = await client.listJobs();
  return {
    status: 200,
    html: layout('quadro', `<h2>quadro · ${jobs.length} trabalho(s)</h2>\n${jobBoard(jobs)}`),
  };
}

/**
 * `GET /executions` — the list of rounds (FR6).
 *
 * @param client Client of the public API.
 * @returns The executions list page.
 */
export async function executionsPage(client: ApiClient): Promise<Page> {
  const executions = await client.listExecutions();

  const row = (execution: ExecutionSummary): string => {
    const label =
      execution.execution_id === null
        ? '<span class="vazio">sem execução</span>'
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
      ? '<p class="vazio">Nenhuma execução ainda.</p>'
      : `<table>
  <thead><tr><th>execução</th><th>trabalhos</th><th>bloqueados</th><th>perguntas pendentes</th></tr></thead>
  <tbody>
    ${executions.map(row).join('\n    ')}
  </tbody>
</table>`;

  return { status: 200, html: layout('execuções', `<h2>execuções</h2>\n${body}`) };
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
export async function runnersPage(client: ApiClient): Promise<Page> {
  const runners = await client.listRunners();

  const missing = (what: string): string => `<span class="vazio">${escapeHtml(what)}</span>`;

  const row = (runner: RunnerHealth): string => {
    const expiration =
      runner.last_expiration === null
        ? missing('nenhuma')
        : escapeHtml(
            `trabalho #${runner.last_expiration.job_id} (${
              runner.last_expiration.expiration_reason ?? 'sem motivo declarado'
            }) às ${runner.last_expiration.expires_at}`,
          );

    return `<tr data-runner="${escapeHtml(runner.id)}">
      <td>${escapeHtml(runner.id)}</td>
      <td data-campo="nome">${runner.name === null ? missing('sem nome') : escapeHtml(runner.name)}</td>
      <td data-campo="leases_ativas">${runner.active_leases}</td>
      <td data-campo="ultimo_heartbeat">${runner.last_heartbeat === null ? missing('nunca') : escapeHtml(runner.last_heartbeat)}</td>
      <td data-campo="ultima_expiracao">${expiration}</td>
    </tr>`;
  };

  const body =
    runners.length === 0
      ? '<p class="vazio">Nenhum runner pareado ainda.</p>'
      : `<table>
  <thead><tr><th>runner</th><th>nome</th><th>leases ativas</th><th>último heartbeat</th><th>última expiração</th></tr></thead>
  <tbody>
    ${runners.map(row).join('\n    ')}
  </tbody>
</table>`;

  return { status: 200, html: layout('runners', `<h2>runners · ${runners.length}</h2>\n${body}`) };
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
export async function executionPage(client: ApiClient, executionId: number): Promise<Page> {
  const [jobs, sessions, questions] = await Promise.all([
    client.listJobs({ execution_id: executionId }),
    client.listSessions({ execution_id: executionId }),
    client.listQuestions({ execution_id: executionId, status: 'pending' }),
  ]);

  const questionQueue =
    questions.length === 0
      ? '<p class="vazio">Ninguém esperando resposta nesta execução.</p>'
      : questions.map(questionSummary).join('\n');

  return {
    status: 200,
    html: layout(
      `execução ${executionId}`,
      `<h2>execução #${executionId} · ${jobs.length} trabalho(s)</h2>
${jobBoard(jobs)}
<h2>sessões</h2>
${sessionsTable(sessions)}
<h2>perguntas pendentes</h2>
${questionQueue}`,
    ),
  };
}

/**
 * `GET /input-requests` — the escalation inbox, with inline answering (FR8).
 *
 * @param client Client of the public API.
 * @returns The question queue page.
 */
export async function questionsPage(client: ApiClient): Promise<Page> {
  const questions = await client.listQuestions({ status: 'pending' });

  const body =
    questions.length === 0
      ? '<p class="vazio">Ninguém esperando resposta. 🎉</p>'
      : `${questions.map(questionCard).join('\n')}\n${OPTIONS_SCRIPT}`;

  return {
    status: 200,
    html: layout('perguntas', `<h2>perguntas pendentes · ${questions.length}</h2>\n${body}`),
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
export async function jobPage(client: ApiClient, jobId: number): Promise<Page> {
  const [job, events, sessions, questions] = await Promise.all([
    client.getJob(jobId),
    client.jobEvents(jobId),
    client.listSessions({ job_id: jobId }),
    client.listQuestions({ job_id: jobId }),
  ]);

  if (job === null || events === null) {
    return errorPage(404, 'trabalho não encontrado', `Não existe trabalho #${jobId}.`);
  }

  const timeline = buildTimeline({ events, sessions, questions, completed: job.completed });
  const state = timeline.done
    ? 'concluído'
    : job.blocked
      ? `bloqueado — ${job.block_reason ?? 'sem motivo declarado'}`
      : 'em curso';

  const execution =
    job.execution_id === null
      ? '<span class="vazio">sem execução</span>'
      : `<a href="/executions/${job.execution_id}">#${job.execution_id}</a>`;

  const segments =
    timeline.segments.length === 0
      ? '<p class="vazio">Nada aconteceu com este trabalho ainda.</p>'
      : `<ul class="linha-do-tempo">\n${timeline.segments.map(segmentHtml).join('\n')}\n</ul>`;

  return {
    status: 200,
    html: layout(
      job.title,
      `<h2>#${job.id} · ${escapeHtml(job.title)}</h2>
<p>nó atual <strong>${escapeHtml(job.current_node_id)}</strong> · execução ${execution} · ${escapeHtml(state)}</p>
<h2>linha do tempo</h2>
${segments}
<h2>totais</h2>
${totalsHtml(timeline)}`,
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
      `<h2>${escapeHtml(title)}</h2>\n<p>${escapeHtml(detail)}</p>\n<p><a href="/board">voltar ao quadro</a></p>`,
    ),
  };
}
