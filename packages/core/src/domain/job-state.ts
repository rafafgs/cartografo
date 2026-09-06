/**
 * The six states of a job — derived, never stored (t415, RF-30).
 *
 * A board that shows `blocked` and `completed` shows two of the six things a
 * job can be doing, and it hides the difference that matters most to whoever is
 * looking at it: a job stopped because a PERSON has to answer something is not
 * the same as a job stopped and nobody was even asked, and a job an agent is
 * working on right now is not the same as one whose runner died with its lease
 * still reading `active`. None of those six is a column, and none of them can
 * be: every one is a fact of the log, of the lease table or of the graph
 * version, and a column caching them would go on reporting a state the log no
 * longer supports — the same reasoning `Job.completed` and
 * `ExecutionSummary.finished_at` are already built on.
 *
 * The six names are English because they were born in English (Rafael,
 * 2026-09-05); `docs/spec/glossary-wire.md` §2.7 registers them the way it
 * registers `runner` and `lease` — a row that says the word does not change.
 *
 * ## Pure, and deliberately so
 *
 * No `Database`, no clock, no HTTP: everything this module needs is handed in
 * by whoever read it, in the spirit of `domain/custom-fields.ts` and
 * `domain/graph.ts`. That is not tidiness for its own sake — it is what lets
 * the caller assemble the facts for a WHOLE board in a bounded number of
 * queries and then answer six times without touching the database again
 * (`repositories/job.ts`, `resolveJobStates`), and it is what lets
 * `test/domain-job-state.test.ts` state the priority order without a server.
 *
 * ## The order IS the specification
 *
 * The six overlap on purpose, and RF-30 names the two overlaps that a reader
 * would otherwise have to guess at:
 *
 * 1. A pending question outranks the blocked flag. Every real escalation is
 *    both — `POST /v1/input-requests` blocks the owning job in the same
 *    transaction that records the question (t106) — so a rule that read the
 *    flag first would file every escalation under "blocked" and nobody would
 *    ever be told that a person is what is missing.
 * 2. An open session under a lease is `running` even on a final node, and never
 *    `completed`. The last node of a graph is a step like any other while its
 *    skill is being run, and a board that called it done would hide the one
 *    session whose result decides the crossing (t262 found exactly that, as
 *    silence).
 */

/** The six states a job can be in, in the priority order {@link deriveJobState} applies. */
export type JobState =
  /** A person has to answer something: the job has a pending input request. */
  | 'awaiting_you'
  /** Stopped, with nothing pending: the flag is up and nobody was asked anything. */
  | 'blocked_unasked'
  /** An agent is working on it: an open session, under a lease still in date. */
  | 'running'
  /** An open session whose lease deadline passed. Nothing sweeps; nobody owns it. */
  | 'unowned'
  /** It arrived: a final node with nothing left to run on it. */
  | 'completed'
  /** None of the above: it is waiting for a dispatch. */
  | 'queued';

/**
 * Everything the derivation reads, as the caller already knows it.
 *
 * One object per job, assembled from batched reads — never from a query of its
 * own. The field names are this module's (camelCase, like every other pure
 * domain module); what goes on the wire is only {@link JobStateResult}.
 */
export interface JobStateFacts {
  /** The job's own flag, as the row carries it. */
  blocked: boolean;
  /** Where the job is standing. */
  currentNodeId: string;
  /** When the job was created — the fallback whenever the log says nothing. */
  createdAt: string;
  /** The instant the whole board is derived against. */
  now: string;
  /** The job's pending input request, if it has one. */
  pendingQuestion: { created_at: string } | null;
  /**
   * `occurred_at` of the most recent `job.blocked` of this job, or `null`.
   *
   * The MOST RECENT one is always the right one: a job can be blocked and
   * unblocked any number of times, and what `state_since` answers is "how long
   * has it been like this", which is the last time it BECAME so.
   */
  blockedAt: string | null;
  /**
   * The job's one active lease, if any.
   *
   * At most one is an invariant of the table and not an assumption here:
   * `grantLease` refuses a second one with `job_already_leased`.
   *
   * It carries the two instants and NOT the status, on purpose — see
   * {@link deriveJobState}'s note on `unowned`.
   */
  activeLease: { granted_at: string; expires_at: string } | null;
  /** Whether the job has a session still `open`. */
  hasOpenSession: boolean;
  /**
   * `final_nodes` of the job's version, or `null` when there is no version to
   * read.
   *
   * `null` covers the three silent cases `hasArrived` already accepts: a job
   * with no `graph_version_id`, an id that no longer resolves (the column is
   * loose text, not a foreign key), and a snapshot that declares nothing. A
   * graph nobody can read is not an arrival.
   */
  finalNodes: string[] | null;
  /** Whether the node the job stands on pins a `skill_ref`. */
  currentNodePinsSkill: boolean;
  /**
   * `finished_at` of a session on the current node that closed `completed` with
   * a non-null `output`, or `null`.
   *
   * That pair is one condition and not two: `finishSession` stores the reported
   * object only when it validated against the `output` schema of the pinned
   * skill, and a NULL for a report the schema refused (t253) — so this is
   * exactly D9's question, did the pinned capability run and produce what its
   * contract declares.
   */
  conformingFinishAt: string | null;
  /**
   * `occurred_at` of the job's most recent `job.transitioned`, or `null` when it
   * never moved.
   *
   * Arrival IS the last transition: `current_node_id` is always the `to_node_id`
   * of that event, so for a job standing on a final node this is the instant it
   * landed there.
   */
  lastTransitionAt: string | null;
}

/** What the projection publishes: the state, and when it started. */
export interface JobStateResult {
  state: JobState;
  /** Instant the job entered this state — always an instant something recorded. */
  state_since: string;
}

/**
 * Which of the six a job is in, and since when.
 *
 * The checks run in the order below and the first match wins; the ordering is
 * the whole of RF-30 and is restated in this module's header, with the reason
 * for each of the two overlaps.
 *
 * `state_since` is never invented: it is the instant of the fact that PUT the
 * job in this state — the question, the block event, the grant, the deadline,
 * the conforming finish, the arrival — and only where the log carries nothing at
 * all does it fall back to the job's own `created_at`. It is never `null`,
 * because "in this state since we do not know when" is not a thing the screen
 * can render.
 *
 * The deadline comparison is a plain string comparison of two ISO 8601 UTC
 * instants, which is the same order `expireOverdue`'s `expires_at < ?` gets out
 * of SQLite: whenever a sweep does come to exist, it will kill exactly the
 * leases this function already calls `unowned`, and not a set that differs by a
 * millisecond of parsing.
 *
 * @param facts Everything already known about this job.
 * @returns The state and the instant it began.
 */
export function deriveJobState(facts: JobStateFacts): JobStateResult {
  // 1. A person is what is missing. Outranks the flag it almost always comes
  //    with (ambiguity 1).
  if (facts.pendingQuestion !== null) {
    return { state: 'awaiting_you', state_since: facts.pendingQuestion.created_at };
  }

  // 2. Stopped, and nobody was asked anything. The fallback is the job's birth:
  //    a flag with no event behind it is a job blocked before the log recorded
  //    that kind of fact, not a job with an unknown history.
  if (facts.blocked) {
    return { state: 'blocked_unasked', state_since: facts.blockedAt ?? facts.createdAt };
  }

  // 3. Somebody took it AND opened a session on it. Both halves are required:
  //    a lease with no session is a dispatch that never started, and a session
  //    with no lease says nothing about who — if anyone — is working.
  //
  //    The `status` column is never consulted, only the deadline. There is no
  //    sweep (this ticket does not add one, by decision), so an abandoned job's
  //    row goes on reading `active` indefinitely; reading the column would
  //    report `running` for a job whose runner died hours ago, which is the
  //    precise failure `unowned` exists to make visible.
  //
  //    Checked BEFORE the final-node rule below, which is ambiguity 2.
  if (facts.activeLease !== null && facts.hasOpenSession) {
    return facts.activeLease.expires_at < facts.now
      ? { state: 'unowned', state_since: facts.activeLease.expires_at }
      : { state: 'running', state_since: facts.activeLease.granted_at };
  }

  // 4. It arrived — if there is anything left to run on the node, it has not.
  if (facts.finalNodes !== null && facts.finalNodes.includes(facts.currentNodeId)) {
    if (!facts.currentNodePinsSkill) {
      return { state: 'completed', state_since: facts.lastTransitionAt ?? facts.createdAt };
    }
    if (facts.conformingFinishAt !== null) {
      return { state: 'completed', state_since: facts.conformingFinishAt };
    }
    // A final node that pins a skill nobody has run yet: it is standing on the
    // last step, waiting for its dispatch like any other queued job.
  }

  // 5. Waiting. Since it arrived where it stands, or since it was born.
  return { state: 'queued', state_since: facts.lastTransitionAt ?? facts.createdAt };
}
