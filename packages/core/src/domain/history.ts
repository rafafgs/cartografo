/**
 * A traversal's history, as the portable file publishes it (t372, RF-41/RF-42).
 *
 * The format is JSON Lines: a header line with the map version's summary, then
 * one line per fact in `id` order. `docs/spec/history-export.md` is the contract
 * a reader is written from; this module is the merge that produces it, and
 * `cli/export-history.ts` is the fetching and the writing around it.
 *
 * A pure module with no `Database`, no `fetch` and no clock — `exported_at` is
 * handed in — in the spirit of `domain/context.ts`: everything here is fed by
 * responses somebody else already read, and half the cases worth testing (a
 * round that crossed two map versions, a session still open when the export
 * ran) are cases nobody can produce on demand against a live server.
 *
 * ## Why a merge exists at all
 *
 * Because `GET /v1/jobs/:id/events` deliberately excludes `session.finished`,
 * `input_request.answered` and `input_request.auto_resolved`: those payloads
 * carry no `job_id`, so the job's own stream cannot see them (`db/events.ts`,
 * "Whoever wants the session's end asks the session"). The screen was the first
 * consumer to close that gap for the job timeline, by reading three routes and
 * reconstructing client-side (`docs/spec/screen.md` §2); this is the second, and
 * it reads the same three.
 *
 * ## The rule, in one paragraph
 *
 * Every event passes through untranslated, except five. `session.opened` and
 * `input_request.created` are REPLACED, at the same event id, by the current
 * projection of the thing they opened — which is why a session still running
 * reads `status:"open"` instead of needing an ending that has not happened.
 * `session.finished`, `input_request.answered` and `input_request.auto_resolved`
 * are DROPPED, because their facts are already in that line. That is what makes
 * "ascending by id" hold with no tie to break: no line is ever added, only
 * enriched or removed, so the sequence is a strict subsequence of the log's own
 * order. The same algorithm serves both scopes — for an execution it is also
 * what keeps the round's stream, which really does carry the endings, from
 * putting the same fact in the file twice under two shapes.
 */

import { isObject } from '../util/is-object.ts';

/** The format's identity, written on every header line (FR2). */
export const HISTORY_FORMAT = 'cartografo-history/1';

/**
 * One envelope of the log, in the part the merge reads.
 *
 * Everything else rides along untouched, which is what "untranslated" means: an
 * event type this module has never heard of still reaches the file whole.
 */
export interface HistoryEvent {
  /** The log's own id — "the only total ordering there is". */
  id: number;
  type: string;
  entity: { type: string; id: number | string };
  [field: string]: unknown;
}

/** A session projection, as `GET /v1/sessions` answers it. */
export interface HistorySession {
  id: number;
  [field: string]: unknown;
}

/** An input-request projection, as `GET /v1/input-requests` answers it. */
export interface HistoryInputRequest {
  id: number;
  [field: string]: unknown;
}

/**
 * One line of the body of the file.
 *
 * `id` is the EVENT's id on every kind of line, because it is the ordering key
 * of the whole file. A projection's own `id` and `kind` would collide with the
 * two fields the line owns, so they are republished prefixed —
 * see {@link LINE_OWNED_FIELDS}.
 */
export interface HistoryLine {
  kind: 'event' | 'session' | 'input_request';
  id: number;
  [field: string]: unknown;
}

/** The three reads of a scope, already fetched. */
export interface HistoryLineSources {
  /** Every event of the scope; any order — this module sorts by `id`. */
  events: HistoryEvent[];
  /** Every session of the scope, as the projection stands right now. */
  sessions: HistorySession[];
  /** Every input request of the scope, likewise. */
  input_requests: HistoryInputRequest[];
}

/** What the export is about: one job, or one whole round. */
export type HistorySubject =
  | { kind: 'job'; job: Record<string, unknown> }
  | {
      kind: 'execution';
      /** `GET /v1/executions/:id`, verbatim. */
      execution: Record<string, unknown>;
      /** `GET /v1/jobs?execution_id=`, which is what decides the header's map. */
      jobs: Record<string, unknown>[];
    };

/** The map the header names, when one honestly stands for the whole scope. */
export interface HistoryGraphVersion {
  id: string;
  /** The lineage's class; the version carries none of its own. */
  class: string | null;
  problem_class: string | null;
  /** `parent_version`, under the name the format publishes. */
  parent: string | null;
  metadata: unknown;
}

/** The two reads behind {@link HistoryGraphVersion}, when the scope pins a version. */
export interface FetchedGraphVersion {
  /** `GET /v1/graph-versions/:id`'s `graph_version`. */
  version: Record<string, unknown>;
  /** `GET /v1/graphs/:graph_id`'s `graph`; `null` when the lineage is gone. */
  lineage: Record<string, unknown> | null;
}

/** Everything line 1 is built out of. */
export interface HistoryHeaderSources {
  /** When the export ran, ISO-8601. Handed in: this module holds no clock. */
  exported_at: string;
  project: { id: number; name: string };
  subject: HistorySubject;
  /** What the pinned version answered, or `null` when there is nothing to name. */
  graph: FetchedGraphVersion | null;
}

/** Line 1 of the file. */
export interface HistoryHeader {
  kind: 'header';
  format: string;
  exported_at: string;
  project: { id: number; name: string };
  /** Present on a job-scoped export, absent on a round-scoped one. */
  job?: Record<string, unknown>;
  /** The other way round. */
  execution?: Record<string, unknown>;
  graph_version: HistoryGraphVersion | null;
}

/** The five types the merge does not pass through. */
const REPLACED_BY_SESSION = 'session.opened';
const REPLACED_BY_INPUT_REQUEST = 'input_request.created';
const FOLDED_INTO_SESSION = ['session.finished'];
const FOLDED_INTO_INPUT_REQUEST = ['input_request.answered', 'input_request.auto_resolved'];

/** A string that says something, or `null`. */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The one map version that honestly stands for the whole scope, or `null` (FR2).
 *
 * For a job it is the job's own pin. For a round it is a version every job of
 * the round shares: a round can legitimately cross versions — that is why
 * `GET /v1/executions/:id/metrics-by-version` groups by version in the first
 * place — and one map cannot stand in for two. A round with no job at all, and
 * one where some jobs are pinned and others are not, read the same way: there
 * is no single map, so the header names none.
 *
 * @param subject The job, or the round and its jobs.
 * @returns The version id to resolve, or `null` when no single one applies.
 */
export function pinnedGraphVersionId(subject: HistorySubject): string | null {
  if (subject.kind === 'job') return textOrNull(subject.job.graph_version_id);

  const declared = new Set(subject.jobs.map((job) => textOrNull(job.graph_version_id)));
  if (declared.size !== 1) return null;
  return [...declared][0];
}

/**
 * Builds line 1 (FR2).
 *
 * The map is decided by {@link pinnedGraphVersionId} and never by what happened
 * to be fetched: a caller that resolved a version and then discovered the scope
 * crosses two of them still gets `null`, which is the only honest answer. Its
 * `id` is the pin itself for the same reason — the header names the version the
 * scope pins, not the one a response echoed back.
 *
 * A pinned version that no longer resolves reads exactly like a job with no map
 * at all: `null`. That is the reading `nodeInputOf` already gives the same case
 * (`routes/jobs.ts`), and inventing a second one would make a reader ask which
 * kind of nothing this is.
 *
 * @param sources The clock, the project, the subject and the fetched version.
 * @returns The header, ready to be written as one line.
 */
export function buildHistoryHeader(sources: HistoryHeaderSources): HistoryHeader {
  const { exported_at, project, subject, graph } = sources;
  const pin = pinnedGraphVersionId(subject);
  const snapshot = graph === null ? undefined : graph.version.snapshot;

  return {
    kind: 'header',
    format: HISTORY_FORMAT,
    exported_at,
    project: { id: project.id, name: project.name },
    ...(subject.kind === 'job' ? { job: subject.job } : { execution: subject.execution }),
    graph_version:
      pin === null || graph === null
        ? null
        : {
            id: pin,
            class: textOrNull(graph.lineage?.class),
            problem_class: isObject(snapshot) ? textOrNull(snapshot.problem_class) : null,
            parent: textOrNull(graph.version.parent_version),
            metadata: (isObject(snapshot) ? snapshot.metadata : undefined) ?? null,
          },
  };
}

/**
 * Merges the three reads of a scope into the body of the file (FR3).
 *
 * An event whose projection is NOT in the scope is passed through as an
 * ordinary event line rather than dropped — an ending nobody can fold is still
 * a fact, and losing it silently is the one failure this format cannot afford.
 * It is not a case a healthy export reaches: the three reads are taken of the
 * same scope, in the same breath.
 *
 * @param sources The events, sessions and input requests of the scope.
 * @returns One line per fact, ascending by event id.
 */
export function mergeHistoryLines(sources: HistoryLineSources): HistoryLine[] {
  const sessions = new Map(sources.sessions.map((session) => [session.id, session]));
  const requests = new Map(sources.input_requests.map((request) => [request.id, request]));

  const ordered = [...sources.events].sort((a, b) => a.id - b.id);
  const lines: HistoryLine[] = [];

  for (const event of ordered) {
    const entityId = event.entity.id;

    if (event.type === REPLACED_BY_SESSION) {
      const session = typeof entityId === 'number' ? sessions.get(entityId) : undefined;
      if (session !== undefined) {
        lines.push(enriched('session', event.id, session));
        continue;
      }
    }

    if (event.type === REPLACED_BY_INPUT_REQUEST) {
      const request = typeof entityId === 'number' ? requests.get(entityId) : undefined;
      if (request !== undefined) {
        lines.push(enriched('input_request', event.id, request));
        continue;
      }
    }

    if (FOLDED_INTO_SESSION.includes(event.type) && typeof entityId === 'number' && sessions.has(entityId)) {
      continue;
    }
    if (
      FOLDED_INTO_INPUT_REQUEST.includes(event.type) &&
      typeof entityId === 'number' &&
      requests.has(entityId)
    ) {
      continue;
    }

    lines.push({ kind: 'event', ...event });
  }

  return lines;
}

/**
 * The two names a line owns, and which no projection may take from it.
 *
 * `kind` says what the line is and `id` orders the file; a projection field of
 * the same name is republished PREFIXED with the line's kind rather than
 * dropped or allowed to win. It moves exactly two fields in this whole format —
 * a session's `id` becomes `session_id`, and an input request's `id` and `kind`
 * ("question", "approval") become `input_request_id` and `input_request_kind`.
 * Both are facts a reader needs: one to fetch the transcript, the other to know
 * what was being asked.
 */
const LINE_OWNED_FIELDS = ['id', 'kind'] as const;

/**
 * One enriched line: the projection, at the id of the event it replaces.
 *
 * The transcript is the one field left behind (Out of Scope): it is unredacted
 * text of unbounded size, and a whole history would become unreadable to carry
 * it. Its size and its truncation flag ride along, and the text itself stays a
 * per-session fetch at `GET /v1/sessions/:id/transcript`.
 *
 * @param kind The line's kind.
 * @param eventId The id of the replaced event, which is the file's ordering key.
 * @param projection The whole projection, as the API answers it.
 * @returns The line.
 */
function enriched(
  kind: 'session' | 'input_request',
  eventId: number,
  projection: Record<string, unknown>,
): HistoryLine {
  const line: HistoryLine = { kind, id: eventId };
  for (const field of LINE_OWNED_FIELDS) {
    if (field in projection) line[`${kind}_${field}`] = projection[field];
  }

  for (const [field, value] of Object.entries(projection)) {
    if (field === 'transcript' || (LINE_OWNED_FIELDS as readonly string[]).includes(field)) continue;
    line[field] = value;
  }

  return line;
}
