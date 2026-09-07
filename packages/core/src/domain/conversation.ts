/**
 * The interview, read back as a conversation (t360, FR5).
 *
 * `factory-graphs/map-design` asks its questions through the ordinary
 * escalation grammar: one `input_request` per turn, the job blocked on the node
 * that asked, the map carried in the sessions' own structured `output`. That
 * is the right mechanism — it is the one every other node already uses — and it
 * is the wrong SHAPE for a page that has to read as a chat. Rebuilding the
 * exchange on the client would mean the screen joining a timeline against an
 * input-request listing against a session listing, three round trips deep, and
 * getting the ordering rule right on its own.
 *
 * So the projection lives here, and the page reads one route. Which also buys
 * the thing the recorded plan B needs: if the latency of one dispatch per
 * question turns out to be unbearable in real use, the mechanism underneath
 * changes to a dedicated chat with `resumeFrom` and the page does not, because
 * the page never saw the mechanism.
 *
 * A pure module, with no `Database` and no clock, in the spirit of
 * `domain/context.ts`: the merge is a structural question over four reads, and
 * keeping it here is what lets a test ask it without a server. Which rows feed
 * it is `routes/jobs.ts`'s decision, exactly as it is for `buildNodeInput`.
 *
 * ## The ordering rule, and why it is not one query
 *
 * The ORDER of the turns comes from the log and the ANSWER from the projection.
 * That split is not an optimization: `input_request.answered` carries no
 * `job_id`, so a job's own timeline structurally cannot show it
 * (`packages/core/src/db/events.ts`), while `input_request.created` is right
 * there in id order. It is the same idiom `docs/spec/human-escalation.md` §5
 * documents and `packages/runner/src/dispatch/prompt.ts` already implements to
 * build the `## What you already asked, and what came back` block — and the two
 * agreeing is what makes the page show what the next session will be told.
 *
 * ## `default` and not `default_answer`
 *
 * The one rename on this wire, and it is local to this projection: the fenced
 * block a session prints spells the field `default` (`ESCALATION_PROTOCOL`), a
 * chat page renders the block's own vocabulary, and `GET /v1/input-requests`
 * keeps `default_answer` untouched for every client it already has.
 *
 * English per D24. The one Portuguese key it could have carried —
 * `perguntas_respondidas` — is `domain/context.ts`'s, not this module's: nothing
 * here is a manifest field.
 */

import { isObject } from '../util/is-object.ts';

/** One event of the job's timeline, in the part this projection reads. */
export interface ProjectedTimelineEvent {
  type: string;
  /**
   * Which entity it is about.
   *
   * `string | number` because that is what the log's own envelope allows, and
   * narrowing it here would only mean the route casting on the way in: the
   * column is TEXT, and `db/events.ts` publishes whatever the payload declared.
   * The comparison below normalizes it once, with `Number`.
   */
  entity: { id: string | number };
}

/** One input request, in the part this projection reads. */
export interface ProjectedInputRequest {
  id: number;
  question: string;
  context: string | null;
  options: string[] | null;
  recommendation: string | null;
  default_answer: string | null;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

/** One session of the job, in the part this projection reads. */
export interface ProjectedSessionState {
  /**
   * The session's own id, spelled the way the row spells it.
   *
   * Not `session_id`: `routes/jobs.ts` hands `listSessions`'s rows over as they
   * come, and a second spelling here would mean the route mapping every field
   * of every session to satisfy a name only this file wanted.
   */
  id: number;
  status: string;
  output: Record<string, unknown> | null;
  /** When the session closed — the ordering key of the walk; `null` while it runs. */
  finished_at: string | null;
  /**
   * What the session is writing right now, decoded (t465, FR5).
   *
   * Read off the column and reported only for the session that is OPEN — the
   * closure clears it, so a finished row holds `null` anyway, and this
   * projection never has to decide whether an old draft is still true.
   */
  partial_text: string | null;
}

/** One closed exchange: what was asked, and what came back. */
export interface ConversationTurn {
  question: string;
  answer: string;
  /**
   * Who answered; `null` when nobody signed it.
   *
   * Free text, like the column: there is no identity system in this repository
   * to resolve it against, and an automatic resolution writes its own actor.
   */
  answered_by: string | null;
  /** When the answer landed; `null` for a row written before the column. */
  at: string | null;
}

/** The question still waiting, in the vocabulary the fenced block uses. */
export interface PendingQuestion {
  id: number;
  question: string;
  context: string | null;
  recommendation: string | null;
  options: string[] | null;
  default: string | null;
}

/** The whole exchange, as one page-sized answer. */
export interface Conversation {
  /** Closed turns, in the order the log recorded the questions. */
  turns: ConversationTurn[];
  /** The one open question, or `null` when nobody is being asked anything. */
  pending: PendingQuestion | null;
  /** A session is running and there is nothing to answer yet. */
  thinking: boolean;
  /**
   * What that session has written so far; `null` when there is nothing to show.
   *
   * The content behind {@link Conversation.thinking}, and it is reported under
   * exactly the same condition — the two are one fact seen twice, a flag and
   * the text that flag is about. `null` covers three different silences and the
   * page draws the same placeholder for all of them: nothing is running, the
   * session has written nothing yet, or there is a question waiting, which
   * outranks a session writing because it is the one that asks something of a
   * person.
   */
  partial: string | null;
  /**
   * The map every completed session settled between them; `null` when no
   * session has reported a `graph` yet.
   */
  draft: unknown;
  /** The traveller arrived: the job is standing on a final node it has run. */
  done: boolean;
}

/** Everything the route reads, handed over already sliced. */
export interface ConversationSources {
  /** The job's timeline, in log order — the only total ordering there is. */
  events: readonly ProjectedTimelineEvent[];
  /** The job's ANSWERED input requests. */
  answered: readonly ProjectedInputRequest[];
  /**
   * The job's PENDING input requests.
   *
   * A list and not one row, because that is what the repository answers; there
   * is at most one by construction — `createInputRequest` blocks the job in the
   * same transaction — and if a second one ever existed, the oldest is the one
   * a person is looking at.
   */
  pending: readonly ProjectedInputRequest[];
  /**
   * The job's sessions, in any order.
   *
   * The order the map is accumulated in is this module's own question, and it
   * sorts for it below — id order and closing order agree for every job that
   * ever ran one session at a time, and disagree exactly where it matters.
   */
  sessions: readonly ProjectedSessionState[];
  /** Whether the job has arrived, as `repositories/job.ts` already derives it. */
  done: boolean;
}

/** The event that records a question being raised. */
const QUESTION_RAISED = 'input_request.created';

/** The status of a session that is running right now. */
const SESSION_OPEN = 'open';

/** The status of a session that closed with a report. */
const SESSION_COMPLETED = 'completed';

/**
 * The keys the interview reports its map under, at the TOP of its output (t464).
 *
 * Two keys and not one wrapper, which is the whole of that ticket: the bucket
 * merge in `domain/context.ts` is per top-level key, so a turn that changed no
 * manifest can leave `skills` out and keep it — and this projection has to
 * answer the same way, or the page and the next dispatch would disagree about
 * what the interview has settled.
 */
const MAP_KEYS = ['graph', 'skills'] as const;

/**
 * The key whose absence means there is no map at all.
 *
 * `skills` alone is not a map — `register-map.ts` and `map-document.ts` both
 * start from `graph.nodes` — so a walk that never reported a graph reports
 * `null` here rather than a half object nothing downstream can draw.
 */
const GRAPH_KEY = 'graph';

/**
 * Orders two sessions by when they closed.
 *
 * The same rule and the same reason as `domain/context.ts`'s `byClosingTime`:
 * `finished_at` first, because that is the order the traversal really happened
 * in, and the id breaks a tie. Restated rather than imported — the two modules
 * are deliberately independent pure projections, and sharing a comparator would
 * be the first thread of a dependency neither of them wants.
 *
 * @param a One session.
 * @param b Another.
 * @returns Negative when `a` closed first.
 */
function byClosingTime(a: ProjectedSessionState, b: ProjectedSessionState): number {
  const left = a.finished_at ?? '';
  const right = b.finished_at ?? '';
  if (left !== right) return left < right ? -1 : 1;
  return a.id - b.id;
}

/**
 * Builds the conversation one job's interview amounts to.
 *
 * Five answers, each from exactly one source:
 *
 * 1. `turns` — the `input_request.created` events, in log order, each matched by
 *    entity id against the answered rows. A `created` event with no answered row
 *    is the currently open one, and it is reported as `pending` instead of being
 *    silently dropped into the history;
 * 2. `pending` — the open row, with `default_answer` renamed to `default`;
 * 3. `draft` — `graph` and `skills` accumulated ACROSS every completed session,
 *    in closing order, one independent key at a time (t464). Completed only: an
 *    unfinished session's report is not a fact yet, and a session that named
 *    neither key — `deliver`'s own `{bundle, checked, note}`, say — moves
 *    neither. Not the last session's own report: since the interview stopped
 *    reprinting its manifests every turn, "what the last turn printed" and
 *    "what the interview has settled" are two different answers, and the page
 *    owes the second one;
 * 4. `done` — passed through from the job's own projection;
 * 5. `thinking` — nothing to answer, not finished, and a session is open;
 * 6. `partial` — that same session's own `partial_text`, under exactly the
 *    condition `thinking` holds. There is at most one open session by the
 *    interview's one-dispatch-per-question mechanism, so "that session" is not
 *    a choice; and the two answers travelling together is what keeps the page
 *    from having to decide on its own whether the text it was handed is still
 *    about the state it is drawing.
 *
 * ## What `thinking` deliberately does NOT cover
 *
 * A lease granted with no session opened yet. That window is sub-second — a
 * session row is written as the engine starts — and closing it would mean
 * asking the lease table a question it has no filter for. On a page that
 * refreshes when somebody clicks, nobody observes it; a new query on a hot table
 * to describe a moment nobody sees is a worse trade than the gap.
 *
 * @param sources The timeline, both slices of the queue, the sessions and the
 *   job's own terminal flag.
 * @returns The conversation, ready to serialize.
 */
export function buildConversation(sources: ConversationSources): Conversation {
  const { events, answered, pending, sessions, done } = sources;

  const byId = new Map(answered.map((request) => [request.id, request]));

  const turns: ConversationTurn[] = [];
  for (const event of events) {
    if (event.type !== QUESTION_RAISED) continue;
    const request = byId.get(Number(event.entity.id));
    // The pending one has no answered row and lands below, as `pending`; a
    // `created` event whose row is gone is a log entry with no projection, and
    // a turn with no answer is not a turn.
    if (request === undefined || request.answer === null) continue;
    turns.push({
      question: request.question,
      answer: request.answer,
      answered_by: request.answered_by,
      at: request.answered_at,
    });
  }

  const open = pending[0];
  const question: PendingQuestion | null =
    open === undefined
      ? null
      : {
          id: open.id,
          question: open.question,
          context: open.context,
          recommendation: open.recommendation,
          options: open.options,
          default: open.default_answer,
        };

  // The map, accumulated forwards over the walk: each completed session
  // overwrites only the keys IT named, so the last turn that reported a `graph`
  // owns `graph` and the last turn that reported `skills` owns `skills`,
  // whether or not they are the same turn. This is `context.ts`'s bucket merge
  // narrowed to two keys, and the two agreeing is what makes the page show what
  // the next dispatch will be told.
  const map: Record<string, unknown> = {};
  for (const session of [...sessions].sort(byClosingTime)) {
    if (session.status !== SESSION_COMPLETED) continue;
    const output = session.output;
    if (!isObject(output)) continue;
    for (const key of MAP_KEYS) {
      // `undefined` is "this turn said nothing about it" and keeps what stands;
      // a `null` the session really reported is a value like any other, and
      // overwriting with it is what the turn asked for.
      if (output[key] === undefined) continue;
      map[key] = output[key];
    }
  }
  const draft: unknown = map[GRAPH_KEY] === undefined ? null : map;

  // One read, two answers. Deriving `thinking` from a `some()` and `partial`
  // from a separate `find()` would be two chances to disagree about which
  // session — and about whether there is one at all.
  const running = sessions.find((session) => session.status === SESSION_OPEN);
  const thinking = question === null && !done && running !== undefined;

  return {
    turns,
    pending: question,
    thinking,
    // `?? null` and not the column's own value: a session that has written
    // nothing yet is the static-placeholder case, and `undefined` is not a
    // value this projection publishes.
    partial: thinking ? (running?.partial_text ?? null) : null,
    draft,
    done,
  };
}
