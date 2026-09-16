/**
 * The seven read subcommands that give the CLI board parity (t542, D26).
 *
 * `jobs`, `job <id>`, `executions`, `execution <id>`, `sessions`,
 * `transcript <session-id>` and `input-requests` are HTTP clients like every
 * other subcommand (D1, D11): they open no database and speak only `/v1/*`,
 * scoped by `--project` the same way `status` already is. Each one has a
 * human table/card and a `--json` form that either forwards the wire body
 * untouched or, where a subcommand aggregates several calls into one report
 * (`job`, `execution`), a declared multi-key object of those untouched
 * bodies — there being no single wire route for either aggregate to mirror.
 *
 * `buildTimeline` and the transcript cut helpers (`lastNonBlankLineIndex`,
 * `failedLineIndex`, and the new `tailLines`) are COPIED from
 * `packages/screen/src/timeline.ts` and `packages/screen/src/pages.ts`, not
 * imported: `packages/core` has never depended on `packages/screen`, and D11's
 * direction (the screen depends on nothing from core) does not reverse just
 * because this reader moved. The screen's own copies are untouched and are
 * deleted only when the screen itself retires (D26). The three bucket names
 * stay in Portuguese, per the exemption the original file records.
 */

import { isObject } from '../util/is-object.ts';
import { UsageError, requestJson } from './url.ts';

/* ------------------------------------------------------------- job state */

/**
 * The six words RF-30 defines for "what is this job doing right now".
 *
 * Computed server-side and read, never recomputed here — the same posture
 * `packages/screen/src/client.ts`'s `JobState` documents. Mirrored as a local
 * type because `packages/core` does not import `packages/screen` (D11).
 */
export const JOB_STATES = [
  'awaiting_you',
  'blocked_unasked',
  'running',
  'unowned',
  'completed',
  'queued',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/* -------------------------------------------------------- wire projections */

/** A job, in the fields these subcommands read off `GET /v1/jobs` and `/jobs/:id`. */
export interface JobRead {
  id: number;
  execution_id: number | null;
  title: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  completed: boolean;
  state: JobState;
}

/** A session, in the fields these subcommands read off `GET /v1/sessions`. */
export interface SessionRead {
  id: number;
  job_id: number | null;
  execution_id: number | null;
  node_id: string | null;
  engine: string;
  status: string;
  exit_code: number | null;
  opened_at: string;
  finished_at: string | null;
}

/** An input request, in the fields these subcommands read off `GET /v1/input-requests`. */
export interface QuestionRead {
  id: number;
  job_id: number;
  execution_id: number | null;
  kind: string;
  question: string;
  status: string;
  created_at: string;
  answered_at: string | null;
}

/** An artifact, in the fields `job <id>` reads off `GET /v1/jobs/:id/artifacts`. */
export interface ArtifactRead {
  id: number;
  session_id: number;
  node_id: string | null;
  name: string;
  size: number;
  created_at: string;
}

/** One row of `GET /v1/executions`. */
export interface ExecutionSummaryRead {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
}

/** `GET /v1/sessions/:id/log`'s answer — the decoded session log. */
export interface SessionLogRead {
  session_id: number;
  node_id: string | null;
  engine: string;
  exit_code: number | null;
  text: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
  transcript_artifact_id: number | null;
}

/* --------------------------------------------------------------- timeline */
/*
 * Copied from `packages/screen/src/timeline.ts` (t107, FR10). The rules, one
 * sentence each:
 *
 * - `agente_trabalhando` is `[opened_at, finished_at]` of each session.
 * - `esperando_humano` is `[created_at, answered_at]` of each question.
 * - `fila` is the COMPLEMENT: every interval with no open session and no
 *   pending question. A transition cuts the queue in two, even with nothing
 *   happening in between.
 * - What did not finish stays open (`end: null`) and does not enter the
 *   totals.
 *
 * A finished job is the control plane's `completed` AND nothing open AND no
 * block (t152): the flag is the real terminal signal, read off `GET
 * /v1/jobs/:id` rather than guessed, and the other two conditions are what
 * this reader knows and the projection does not.
 *
 * The function is pure and never looks at the clock: same three answers, same
 * timeline, today and a month from now.
 */

/** The three buckets. */
export type SegmentCategory = 'fila' | 'agente_trabalhando' | 'esperando_humano';

/** An event, in the slice the reconstruction reads. */
export interface TimelineEvent {
  id: number;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** A session, in the slice the reconstruction reads. */
export interface TimelineSession {
  id: number;
  engine: string;
  status: string;
  opened_at: string;
  finished_at: string | null;
}

/** A question, in the slice the reconstruction reads. */
export interface TimelineQuestion {
  id: number;
  status: string;
  question: string;
  created_at: string;
  answered_at: string | null;
}

/** A slice of the job's life, in one of the three buckets. */
export interface Segment {
  category: SegmentCategory;
  start: string;
  /** `null` = still open at the instant the sources were read. */
  end: string | null;
  /** `null` while the segment is open: a duration is not yet a fact. */
  durationMs: number | null;
  /** Node the job was on when the segment started. */
  nodeId: string | null;
  /** Id of the session or question that produced it; `null` for the queue. */
  ref: number | null;
  /** Short label (engine and status, or the question text). */
  detail: string | null;
}

/** Closed time accumulated in each bucket, in milliseconds. */
export interface BucketTotals {
  fila: number;
  agente_trabalhando: number;
  esperando_humano: number;
}

/** What `buildTimeline` returns. */
export interface Timeline {
  segments: Segment[];
  totals: BucketTotals;
  /** Block flag, reduced from the log (not read from the projection). */
  blocked: boolean;
  /** Arrived at a final node, with no open session, no pending question and no block. */
  done: boolean;
}

/** The three HTTP answers all of this comes from, plus the terminal flag. */
export interface TimelineSources {
  events: TimelineEvent[];
  sessions: TimelineSession[];
  questions: TimelineQuestion[];
  /** `completed` of `GET /v1/jobs/:id` — the server's answer, not a guess here. */
  completed: boolean;
}

/** Tie-break order when two segments start at the same instant. */
const CATEGORY_ORDER: Record<SegmentCategory, number> = {
  fila: 0,
  agente_trabalhando: 1,
  esperando_humano: 2,
};

/** An instant, with the original text kept so it can go out on the page. */
interface Instant {
  text: string;
  ms: number;
}

/** An interval taken by someone — a session or a wait. */
interface Occupancy {
  start: Instant;
  end: Instant | null;
}

function instant(text: string): Instant {
  return { text, ms: Date.parse(text) };
}

function instantOrNull(text: string | null): Instant | null {
  return text === null ? null : instant(text);
}

/** The current node at each moment, in the order the job visited them. */
interface Milestone {
  at: Instant;
  nodeId: string | null;
}

/**
 * The points where the queue is cut: creation and each transition.
 *
 * Blocking and unblocking do NOT cut: they are a flag, not movement — the job
 * does not leave the node, and the wait goes on being the same wait.
 */
function nodeMilestones(events: TimelineEvent[]): Milestone[] {
  const milestones: Milestone[] = [];
  for (const event of events) {
    if (event.type === 'job.created') {
      milestones.push({
        at: instant(event.occurred_at),
        nodeId: textOrNull(event.data.entry_node_id),
      });
    } else if (event.type === 'job.transitioned') {
      milestones.push({
        at: instant(event.occurred_at),
        nodeId: textOrNull(event.data.to_node_id),
      });
    }
  }
  return milestones.sort((a, b) => a.at.ms - b.at.ms);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The node the job was on at an instant — the last milestone up to there. */
function nodeAt(milestones: Milestone[], ms: number): string | null {
  let current: string | null = null;
  for (const milestone of milestones) {
    if (milestone.at.ms > ms) break;
    current = milestone.nodeId;
  }
  return current;
}

/** The block flag, reduced from the log in the order of the facts. */
function blockedAtEnd(events: TimelineEvent[]): boolean {
  let blocked = false;
  for (const event of events) {
    if (event.type === 'job.blocked') blocked = true;
    if (event.type === 'job.unblocked') blocked = false;
  }
  return blocked;
}

function makeSegment(
  category: SegmentCategory,
  start: Instant,
  end: Instant | null,
  extras: { nodeId: string | null; ref: number | null; detail: string | null },
): Segment {
  return {
    category,
    start: start.text,
    end: end?.text ?? null,
    durationMs: end === null ? null : end.ms - start.ms,
    ...extras,
  };
}

/**
 * Builds the timeline of ONE job from the three API answers.
 *
 * @param sources The job's events, its sessions and its questions.
 * @returns Segments in chronological order, totals per bucket and the derived
 *   state (blocked, done).
 */
export function buildTimeline(sources: TimelineSources): Timeline {
  const milestones = nodeMilestones(sources.events);
  const blocked = blockedAtEnd(sources.events);

  const occupancies: Occupancy[] = [
    ...sources.sessions.map((session) => ({
      start: instant(session.opened_at),
      end: instantOrNull(session.finished_at),
    })),
    ...sources.questions.map((question) => ({
      start: instant(question.created_at),
      end: instantOrNull(question.answered_at),
    })),
  ];

  const segments: Segment[] = [
    ...sources.sessions.map((session) => {
      const start = instant(session.opened_at);
      return makeSegment('agente_trabalhando', start, instantOrNull(session.finished_at), {
        nodeId: nodeAt(milestones, start.ms),
        ref: session.id,
        detail: `${session.engine} · ${session.status}`,
      });
    }),
    ...sources.questions.map((question) => {
      const start = instant(question.created_at);
      return makeSegment('esperando_humano', start, instantOrNull(question.answered_at), {
        nodeId: nodeAt(milestones, start.ms),
        ref: question.id,
        detail: question.question,
      });
    }),
  ];

  // The server says the job arrived; the reader says nobody is holding it.
  const hasOpen = occupancies.some((occupancy) => occupancy.end === null);
  const done = sources.completed && !hasOpen && !blocked;

  const known = [
    ...sources.events.map((event) => instant(event.occurred_at)),
    ...occupancies.flatMap((occupancy) =>
      occupancy.end === null ? [occupancy.start] : [occupancy.start, occupancy.end],
    ),
  ].sort((a, b) => a.ms - b.ms);

  if (known.length > 0) {
    const first = known[0];
    const last = done ? known[known.length - 1] : null;

    const cuts = new Map<number, Instant>();
    const cut = (point: Instant): void => {
      if (point.ms < first.ms) return;
      if (last !== null && point.ms > last.ms) return;
      if (!cuts.has(point.ms)) cuts.set(point.ms, point);
    };
    cut(first);
    for (const milestone of milestones) cut(milestone.at);
    for (const occupancy of occupancies) {
      cut(occupancy.start);
      if (occupancy.end !== null) cut(occupancy.end);
    }
    if (last !== null) cut(last);

    const ordered = [...cuts.values()].sort((a, b) => a.ms - b.ms);
    const isBusy = (from: Instant, to: Instant): boolean =>
      occupancies.some(
        (occupancy) =>
          occupancy.start.ms <= from.ms && (occupancy.end === null || occupancy.end.ms >= to.ms),
      );

    for (let index = 0; index + 1 < ordered.length; index += 1) {
      const from = ordered[index];
      const to = ordered[index + 1];
      if (from.ms === to.ms || isBusy(from, to)) continue;
      segments.push(
        makeSegment('fila', from, to, { nodeId: nodeAt(milestones, from.ms), ref: null, detail: null }),
      );
    }

    const latest = ordered[ordered.length - 1];
    if (last === null && !hasOpen) {
      segments.push(
        makeSegment('fila', latest, null, {
          nodeId: nodeAt(milestones, latest.ms),
          ref: null,
          detail: null,
        }),
      );
    }
  }

  segments.sort((a, b) => {
    const byStart = Date.parse(a.start) - Date.parse(b.start);
    if (byStart !== 0) return byStart;
    return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  });

  const totals: BucketTotals = { fila: 0, agente_trabalhando: 0, esperando_humano: 0 };
  for (const segment of segments) {
    totals[segment.category] += segment.durationMs ?? 0;
  }

  return { segments, totals, blocked, done };
}

/* ---------------------------------------------------------- transcript cut */
/*
 * Copied from `packages/screen/src/pages.ts` (t368, FR5), plus `tailLines`,
 * new here.
 */

/**
 * The last non-blank line of a decoded log, 0-based.
 *
 * @param lines The decoded text, already split on `\n`.
 * @returns The index, or `null` when every line is blank.
 */
export function lastNonBlankLineIndex(lines: readonly string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() !== '') return index;
  }
  return null;
}

/**
 * Which line a session's own failure marks.
 *
 * Only a non-null, non-zero `exit_code` marks anything — a session that ran to
 * completion, or one still open, has nothing to point at.
 *
 * @param lines The decoded text, already split on `\n`.
 * @param exitCode The session's own `exit_code`.
 * @returns The index to mark, or `null` when nothing should be.
 */
export function failedLineIndex(lines: readonly string[], exitCode: number | null): number | null {
  if (exitCode === null || exitCode === 0) return null;
  return lastNonBlankLineIndex(lines);
}

/** The slice `--tail N` shows, and where it starts in the full array. */
export interface TailWindow {
  start: number;
  lines: string[];
}

/**
 * The last `count` lines, counting back from the last non-blank line.
 *
 * Trailing blank lines are dropped from the count first, the same convention
 * {@link lastNonBlankLineIndex} uses — so a failed session's tail always ends
 * on its own marked line, never on a blank line after it.
 *
 * @param lines The decoded text, already split on `\n`.
 * @param count How many lines to keep.
 * @returns The window: where it starts in `lines`, and the lines themselves.
 */
export function tailLines(lines: readonly string[], count: number): TailWindow {
  const lastIndex = lastNonBlankLineIndex(lines);
  const end = lastIndex === null ? lines.length : lastIndex + 1;
  const start = Math.max(0, end - count);
  return { start, lines: lines.slice(start, end) };
}

/* ----------------------------------------------------------------- reads */

/** Builds a query string, skipping any parameter left `undefined`. */
function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/** The array under `key` in a response body, or `[]` when it is not there. */
function listOf<T>(body: unknown, key: string): T[] {
  const record = isObject(body) ? body : {};
  return Array.isArray(record[key]) ? (record[key] as T[]) : [];
}

/** A plain-text table: a header row and one row per entry, columns aligned. */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  const body = rows.length === 0 ? ['(none)'] : rows.map(renderRow);
  return [renderRow(headers), ...body].join('\n');
}

function jobsTable(jobs: JobRead[]): string {
  return table(
    ['id', 'state', 'current_node_id', 'execution_id', 'blocked', 'title'],
    jobs.map((job) => [
      String(job.id),
      job.state,
      job.current_node_id,
      job.execution_id === null ? '-' : String(job.execution_id),
      String(job.blocked),
      job.title,
    ]),
  );
}

function sessionsTable(sessions: SessionRead[]): string {
  return table(
    ['id', 'job_id', 'execution_id', 'node_id', 'engine', 'status', 'exit_code', 'opened_at', 'finished_at'],
    sessions.map((session) => [
      String(session.id),
      session.job_id === null ? '-' : String(session.job_id),
      session.execution_id === null ? '-' : String(session.execution_id),
      session.node_id ?? '-',
      session.engine,
      session.status,
      session.exit_code === null ? '-' : String(session.exit_code),
      session.opened_at,
      session.finished_at ?? '-',
    ]),
  );
}

function artifactsTable(artifacts: ArtifactRead[]): string {
  return table(
    ['id', 'session_id', 'node_id', 'name', 'size', 'created_at'],
    artifacts.map((artifact) => [
      String(artifact.id),
      String(artifact.session_id),
      artifact.node_id ?? '-',
      artifact.name,
      String(artifact.size),
      artifact.created_at,
    ]),
  );
}

function questionsTable(questions: QuestionRead[]): string {
  return table(
    ['id', 'job_id', 'execution_id', 'kind', 'question', 'status', 'created_at'],
    questions.map((question) => [
      String(question.id),
      String(question.job_id),
      question.execution_id === null ? '-' : String(question.execution_id),
      question.kind,
      question.question.replaceAll('\n', ' '),
      question.status,
      question.created_at,
    ]),
  );
}

/* ------------------------------------------------------------------ jobs */

/** Options of `jobs`. */
export interface JobsOptions {
  url: string;
  projectId: number;
  /** Value of `--state`, verbatim; filtered client-side (`GET /v1/jobs` has no server-side filter). */
  state?: string;
  executionId?: number;
  json: boolean;
}

/**
 * Runs `cartografo jobs`.
 *
 * @throws {UsageError} When `--state` names a value RF-30 does not define.
 */
export async function runJobs(options: JobsOptions): Promise<number> {
  if (options.state !== undefined && !(JOB_STATES as readonly string[]).includes(options.state)) {
    throw new UsageError(
      `jobs --state: unknown state "${options.state}" (expected one of ${JOB_STATES.join(', ')})`,
    );
  }

  const response = await requestJson(
    `${options.url}/v1/jobs${queryString({
      project_id: options.projectId,
      execution_id: options.executionId,
    })}`,
  );
  const jobs = listOf<JobRead>(response.body, 'jobs');
  const filtered = options.state === undefined ? jobs : jobs.filter((job) => job.state === options.state);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ jobs: filtered })}\n`);
    return 0;
  }

  process.stdout.write(`${jobsTable(filtered)}\n`);
  return 0;
}

/* -------------------------------------------------------------------- job */

/** Options of `job <id>`. */
export interface JobOptions {
  url: string;
  projectId: number;
  id: number;
  json: boolean;
}

/**
 * Runs `cartografo job <id>` — `jobPage`'s own content (FR10), never the
 * board's map position and never a raw event list.
 */
export async function runJob(options: JobOptions): Promise<number> {
  const { url, projectId, id } = options;
  const query = queryString({ project_id: projectId });
  const jobResponse = await requestJson(`${url}/v1/jobs/${id}${query}`);

  if (jobResponse.status === 404) {
    process.stderr.write(`cartografo: no job #${id} in this project\n`);
    return 1;
  }

  const job = jobResponse.body as JobRead;

  const [eventsResponse, sessionsResponse, questionsResponse, artifactsResponse] = await Promise.all([
    requestJson(`${url}/v1/jobs/${id}/events${query}`),
    requestJson(`${url}/v1/sessions${queryString({ project_id: projectId, job_id: id })}`),
    requestJson(`${url}/v1/input-requests${queryString({ project_id: projectId, job_id: id })}`),
    requestJson(`${url}/v1/jobs/${id}/artifacts${query}`),
  ]);

  const events = listOf<TimelineEvent>(eventsResponse.body, 'events');
  const sessions = listOf<SessionRead>(sessionsResponse.body, 'sessions');
  const questions = listOf<QuestionRead>(questionsResponse.body, 'input_requests');
  const artifacts = listOf<ArtifactRead>(artifactsResponse.body, 'artifacts');

  const timeline = buildTimeline({
    events,
    sessions: sessions.map((session) => ({
      id: session.id,
      engine: session.engine,
      status: session.status,
      opened_at: session.opened_at,
      finished_at: session.finished_at,
    })),
    questions: questions.map((question) => ({
      id: question.id,
      status: question.status,
      question: question.question,
      created_at: question.created_at,
      answered_at: question.answered_at,
    })),
    completed: job.completed,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        job,
        events: eventsResponse.body,
        sessions: sessionsResponse.body,
        questions: questionsResponse.body,
        artifacts: artifactsResponse.body,
        timeline,
      })}\n`,
    );
    return 0;
  }

  const state = timeline.done
    ? 'done'
    : job.blocked
      ? `blocked — ${job.block_reason ?? 'no reason declared'}`
      : 'in progress';

  const lines: string[] = [];
  lines.push(
    `#${job.id} · ${job.title} · current node ${job.current_node_id} · execution ${
      job.execution_id === null ? 'none' : `#${job.execution_id}`
    } · ${state}`,
  );
  lines.push('');
  lines.push('timeline:');
  if (timeline.segments.length === 0) {
    lines.push('  (nothing has happened to this job yet)');
  } else {
    for (const segment of timeline.segments) {
      const detail = segment.detail === null ? '' : ` detail=${segment.detail}`;
      lines.push(
        `segment: category=${segment.category} ref=${segment.ref ?? 'null'} node=${
          segment.nodeId ?? 'null'
        } start=${segment.start} end=${segment.end ?? 'null'} durationMs=${
          segment.durationMs ?? 'null'
        }${detail}`,
      );
    }
  }
  lines.push('');
  lines.push(
    `totals: fila=${timeline.totals.fila} agente_trabalhando=${timeline.totals.agente_trabalhando} esperando_humano=${timeline.totals.esperando_humano}`,
  );
  lines.push('');
  lines.push('artifacts:');
  lines.push(artifacts.length === 0 ? '  (none)' : artifactsTable(artifacts));
  lines.push('');
  lines.push('sessions:');
  lines.push(sessions.length === 0 ? '  (none)' : sessionsTable(sessions));

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/* ------------------------------------------------------------- executions */

/** Options of `executions`. */
export interface ExecutionsOptions {
  url: string;
  projectId: number;
  json: boolean;
}

/** Runs `cartografo executions`. */
export async function runExecutions(options: ExecutionsOptions): Promise<number> {
  const response = await requestJson(
    `${options.url}/v1/executions${queryString({ project_id: options.projectId })}`,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const executions = listOf<ExecutionSummaryRead>(response.body, 'executions');
  process.stdout.write(
    `${table(
      ['execution', 'jobs', 'blocked', 'pending_questions'],
      executions.map((execution) => [
        execution.execution_id === null ? 'none' : `#${execution.execution_id}`,
        String(execution.jobs),
        String(execution.blocked_jobs),
        String(execution.pending_input_requests),
      ]),
    )}\n`,
  );
  return 0;
}

/* -------------------------------------------------------------- execution */

/** Options of `execution <id>`. */
export interface ExecutionOptions {
  url: string;
  projectId: number;
  id: number;
  json: boolean;
}

/**
 * Runs `cartografo execution <id>`.
 *
 * Never a 404: an execution is an opaque grouper, not a row, and an id
 * nobody wrote a job under is a round with zero jobs.
 */
export async function runExecution(options: ExecutionOptions): Promise<number> {
  const { url, projectId, id } = options;
  const [jobsResponse, sessionsResponse, questionsResponse] = await Promise.all([
    requestJson(`${url}/v1/jobs${queryString({ execution_id: id, project_id: projectId })}`),
    requestJson(`${url}/v1/sessions${queryString({ execution_id: id, project_id: projectId })}`),
    requestJson(
      `${url}/v1/input-requests${queryString({ execution_id: id, status: 'pending', project_id: projectId })}`,
    ),
  ]);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        jobs: jobsResponse.body,
        sessions: sessionsResponse.body,
        questions: questionsResponse.body,
      })}\n`,
    );
    return 0;
  }

  const jobs = listOf<JobRead>(jobsResponse.body, 'jobs');
  const sessions = listOf<SessionRead>(sessionsResponse.body, 'sessions');
  const questions = listOf<QuestionRead>(questionsResponse.body, 'input_requests');

  const lines: string[] = [];
  lines.push(`execution #${id} · ${jobs.length} job(s)`);
  lines.push('');
  lines.push('jobs:');
  lines.push(jobs.length === 0 ? '  (none)' : jobsTable(jobs));
  lines.push('');
  lines.push('sessions:');
  lines.push(sessions.length === 0 ? '  (none)' : sessionsTable(sessions));
  lines.push('');
  lines.push('pending questions:');
  lines.push(
    questions.length === 0
      ? '  (nobody waiting for an answer)'
      : questions
          .map((question) => `  - #${question.id} (job #${question.job_id}) ${question.question}`)
          .join('\n'),
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/* --------------------------------------------------------------- sessions */

/** Options of `sessions`. */
export interface SessionsOptions {
  url: string;
  projectId: number;
  jobId?: number;
  executionId?: number;
  json: boolean;
}

/** Runs `cartografo sessions`. */
export async function runSessions(options: SessionsOptions): Promise<number> {
  const response = await requestJson(
    `${options.url}/v1/sessions${queryString({
      job_id: options.jobId,
      execution_id: options.executionId,
      project_id: options.projectId,
    })}`,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const sessions = listOf<SessionRead>(response.body, 'sessions');
  process.stdout.write(`${sessionsTable(sessions)}\n`);
  return 0;
}

/* -------------------------------------------------------------- transcript */

/** Options of `transcript <session-id>`. */
export interface TranscriptOptions {
  url: string;
  projectId: number;
  id: number;
  /** Value of `--tail`, already validated as a positive integer by the router. */
  tail?: number;
  json: boolean;
}

/**
 * Runs `cartografo transcript <session-id>` — `sessionLogPage`'s cut rule,
 * in plain text (FR7).
 */
export async function runTranscript(options: TranscriptOptions): Promise<number> {
  const { url, projectId, id } = options;
  const response = await requestJson(`${url}/v1/sessions/${id}/log${queryString({ project_id: projectId })}`);

  if (response.status === 404) {
    process.stderr.write(`cartografo: no session #${id} in this project\n`);
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const log = response.body as SessionLogRead;
  const lines = (log.text ?? '').split('\n');
  const failedIndex = failedLineIndex(lines, log.exit_code);
  const window = options.tail === undefined ? { start: 0, lines } : tailLines(lines, options.tail);

  const printed = window.lines
    .map((line, relativeIndex) => {
      const absoluteIndex = window.start + relativeIndex;
      return absoluteIndex === failedIndex ? `>>> ${line}` : line;
    })
    .join('\n');

  const notice = !log.transcript_truncated
    ? ''
    : `\ntranscript cut at 1 MiB · ${log.transcript_original_size ?? 0} bytes in the original${
        log.transcript_artifact_id === null
          ? ''
          : ` · the whole thing is artifact #${log.transcript_artifact_id}`
      }`;

  process.stdout.write(`${printed}${notice}\n`);
  return 0;
}

/* --------------------------------------------------------- input requests */

/** Options of `input-requests`. */
export interface InputRequestsOptions {
  url: string;
  projectId: number;
  /** Defaults to `'pending'`, mirroring `questionsPage`'s own default. */
  status: string;
  json: boolean;
}

/** Runs `cartografo input-requests`. */
export async function runInputRequests(options: InputRequestsOptions): Promise<number> {
  const response = await requestJson(
    `${options.url}/v1/input-requests${queryString({
      status: options.status,
      project_id: options.projectId,
    })}`,
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(response.body)}\n`);
    return 0;
  }

  const questions = listOf<QuestionRead>(response.body, 'input_requests');
  process.stdout.write(`${questionsTable(questions)}\n`);
  return 0;
}
