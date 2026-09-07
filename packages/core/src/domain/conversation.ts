/**
 * The interview, read back as a conversation (t360, FR5).
 *
 * `factory-graphs/map-design` asks its questions through the ordinary
 * escalation grammar: one `input_request` per turn, the job blocked on the node
 * that asked, the draft carried in the session's own structured `output`. That
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
  status: string;
  output: Record<string, unknown> | null;
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
  /** The draft the last completed session reported; `null` when there is none. */
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
  /** The job's sessions, in id order. */
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

/** The key the interview reports its map under, inside the session's output. */
const DRAFT_KEY = 'draft';

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
 * 3. `draft` — the `draft` of the LAST completed session's output. Completed
 *    only: an unfinished session's report is not a fact yet, and a session that
 *    reported nothing structured leaves the previous draft standing rather than
 *    erasing it;
 * 4. `done` — passed through from the job's own projection;
 * 5. `thinking` — nothing to answer, not finished, and a session is open.
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

  // The LAST completed session, read for its draft. The listing is already in
  // id order, so walking it backwards is walking the traversal backwards — and
  // it is the last one that counts, not the last one that happened to report:
  // a turn that closed without a draft is a turn that lost the map, which is
  // exactly what this node's own check exists to catch, and hiding it behind an
  // older draft would make the page disagree with the log.
  let draft: unknown = null;
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index];
    if (session.status !== SESSION_COMPLETED) continue;
    draft = isObject(session.output) ? (session.output[DRAFT_KEY] ?? null) : null;
    break;
  }

  return {
    turns,
    pending: question,
    thinking:
      question === null && !done && sessions.some((session) => session.status === SESSION_OPEN),
    draft,
    done,
  };
}
