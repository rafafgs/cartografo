/**
 * The timeline of a job, in three buckets (t107, FR10).
 *
 * It is the "generic time" of flowpilot's t81, the lesson recorded in
 * `notes/2026-08-14-learning.md`: a job's total time says nothing; what does
 * say something is HOW it splits between waiting in the queue, having an agent
 * working on it, and waiting for a human. Those three curves are the surveyor's
 * raw material — without them, proposing a graph mutation is guesswork.
 *
 * ## Why this lives in the screen
 *
 * Because no route hands it over ready-made, and because building it means
 * crossing three answers the control plane deliberately keeps apart:
 *
 * | Source | What only it has |
 * |---|---|
 * | `GET /v1/jobs/:id/events` | the transitions — where the job has been |
 * | `GET /v1/sessions?trabalho_id=` | the END of the sessions |
 * | `GET /v1/input-requests?trabalho_id=` | the END of the waits |
 *
 * The events route leaves out `session.finished` and `input_request.answered`
 * because those payloads carry no `trabalho_id` — the link was declared when
 * they opened, and repeating it would be duplicated data in the log
 * (`packages/core/src/db/eventos.ts`). "Whoever wants the end of the session
 * asks the session", says the comment over there; that is exactly what this
 * module does.
 *
 * ## The rules, one sentence each
 *
 * - **`agente_trabalhando`** is `[opened_at, finished_at]` of each session.
 * - **`esperando_humano`** is `[created_at, answered_at]` of each question.
 * - **`fila`** is the COMPLEMENT: every interval with no open session and no
 *   pending question. A transition CUTS the queue in two, even with nothing
 *   happening in between — "two days parked in refinement and an hour in
 *   implementation" and "parked two days and an hour" are different diagnoses.
 * - What **did not finish stays open** (`end: null`) and does not enter the
 *   totals: closing a segment with the clock of whoever opened the page would
 *   invent a fact the log does not have.
 *
 * **A finished job** is the control plane's `completed` AND nothing open AND no
 * block (t152). The flag is the real terminal signal — the job's current node is
 * a final node of its own graph version — and it comes READ from
 * `GET /v1/jobs/:id`, because `final_nodes` lives in the graph snapshot and the
 * screen has no way to reach it. The other two conditions are what the screen
 * does know and the projection does not: an open session or a pending question
 * keeps a job open however terminal its node is. Until t152 the flag did not
 * exist and the derivation was "nothing open and no block" alone — which any
 * job one event old satisfies, and which is why a job that had barely been
 * created was reported here as finished.
 *
 * That criterion — and only it — closes the last queue segment.
 *
 * The function is pure and never looks at the clock: same three answers, same
 * timeline, today and a month from now. That is what makes it testable without
 * real time.
 *
 * The three bucket names stay in Portuguese on purpose: they are written into
 * the page as `data-segmento` values and rendered as the visible label of each
 * row, so they are screen content, not identifiers (t133, exceptions 9 and 10).
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
  /** Short label for the screen (engine and status, or the question text). */
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
  /**
   * `completed` of `GET /v1/jobs/:id` — the server's answer, not a guess here.
   *
   * Required, and not optional with a default: a caller that forgets it would
   * silently get back the old heuristic's verdict, and this field exists
   * precisely because that verdict was wrong (t152).
   */
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

  // The server says the job arrived; the screen says nobody is holding it. Both
  // halves are needed: a session still open on a final node is an agent that has
  // not handed the work back yet (t152).
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

    // The cuts: the start, each transition, and each occupancy edge. Between
    // two neighbouring cuts nothing changes — either the stretch is busy all
    // through, or it is queue all through. That is what lets the bucket be
    // decided by a simple comparison.
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

    // The open end: the job is not finished and nobody has it. It happens with
    // a blocked job — and it is exactly the time nobody wants to see growing
    // without an explanation.
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
