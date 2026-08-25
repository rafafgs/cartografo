// State reconstruction from the event log (t98 FR7).
//
// The executable proof of the quality non-negotiable "replayability by event
// sourcing": graph vN + log ⇒ final state, without consulting any other source.
// For as long as this function closes against `examples/expected-final-state.json`
// the log is sufficient — and the day a new event type carries a fact that no
// projection here knows how to fold, this file is where that shows up.
//
// It is not the control plane: it is the reference of what the control plane
// will have to reproduce once it exists (D6 puts the building after this ficha).

/**
 * The empty projections — the complete shape of the state, always present whole.
 * A job that never happened is an empty map, never a missing key.
 */
function emptyState() {
  return {
    jobs: {},
    sessions: {},
    input_requests: {},
    leases: {},
    current_graph_version: {},
    executions: {},
  };
}

/** A newly created job, before any transition. */
function newJob(entryNode) {
  return { current_node_id: entryNode, blocked: false, node_history: [entryNode] };
}

/**
 * Folds the log and returns the final state of everything it describes.
 *
 * The order is that of the `id` field (monotonic, assigned by the server — FR1),
 * not the order the events arrived in this list: whoever reads the log from a
 * file, from a paginated API response or from an out-of-order stream arrives at
 * the same state. `occurred_at` does not serve for that — two events can carry
 * the same stamp, and only the id is a total ordering.
 *
 * Events of an unknown type are ignored on purpose: an old client reading a new
 * log keeps reconstructing what it understands, which is what makes the taxonomy
 * extensible additively (the rule of two consumers is what will freeze the
 * format later).
 *
 * @param {Array<object>} events Events in the envelope's format.
 * @returns {{jobs: object, sessions: object, input_requests: object, leases: object, current_graph_version: object, executions: object}}
 */
export function reconstructState(events) {
  const state = emptyState();
  const sorted = [...events].sort((a, b) => a.id - b.id);

  for (const event of sorted) {
    const { type, data } = event;
    const id = event.entity.id;

    switch (type) {
      // --- job --------------------------------------------------------------
      case 'job.created':
        state.jobs[id] = newJob(data.entry_node_id);
        break;

      case 'job.transitioned': {
        const job = state.jobs[id];
        if (!job) break;
        job.current_node_id = data.to_node_id;
        job.node_history.push(data.to_node_id);
        break;
      }

      case 'job.blocked':
        if (state.jobs[id]) state.jobs[id].blocked = true;
        break;

      case 'job.unblocked':
        if (state.jobs[id]) state.jobs[id].blocked = false;
        break;

      // `job.amended` is a fact about content, not about flow: it changes the
      // job, not its position in the graph. No projection here moves — and that
      // is why it carries only the NAMES of the fields that changed.
      case 'job.amended':
        break;

      // --- session ----------------------------------------------------------
      // `open`, and not `aberta`: this is the only status the replay INVENTS
      // (the terminal ones come from the event's `data.status`), and the
      // projection it has to reproduce has written `open` since t235, which took
      // the database's values to the glossary's English. What holds the two
      // equal is `packages/core/test/replay-consistency.test.ts`.
      case 'session.opened':
        state.sessions[id] = { status: 'open', exit_code: null };
        break;

      case 'session.finished':
        state.sessions[id] = {
          status: data.status,
          // Absent and null are the same thing here: the engine did not report
          // an exit code. Never collapse into zero — zero is success.
          exit_code: data.exit_code ?? null,
        };
        break;

      // `session.permission_denied` is an incident, not an outcome: the session
      // stays exactly where it was, and no projection here moves. It is listed
      // instead of falling into the `default` because the difference between
      // "ignored on purpose" and "forgotten" is precisely what this file exists
      // to record. Whoever wants to count denials reads the log, which loses
      // nothing.
      case 'session.permission_denied':
        break;

      // --- input request ----------------------------------------------------
      case 'input_request.created':
        state.input_requests[id] = { status: 'pending', answer: null, answer_source: null };
        break;

      // The two types below collapse back into flowpilot's user/auto
      // `answer_source`: in the log the source is the type of the event, in the
      // projection it goes back to being a field, because whoever reads state
      // wants to compare, not to classify.
      case 'input_request.answered':
        state.input_requests[id] = {
          status: 'answered',
          answer: data.answer,
          answer_source: 'user',
        };
        break;

      case 'input_request.auto_resolved':
        state.input_requests[id] = {
          status: 'answered',
          answer: data.answer,
          answer_source: 'auto',
        };
        break;

      // --- lease ------------------------------------------------------------
      // `active`/`expired` for the same reason the session just above writes
      // `open`: they are statuses INVENTED by the replay (the event carries
      // none), and the projection they have to reproduce is the `lease.status`
      // column, which t235 took to English —
      // `packages/core/src/repositories/leases.ts` (`LEASE_STATUSES`) has the
      // three values that exist. What holds the two equal is
      // `packages/core/test/replay-consistency.test.ts`, since t196, which is
      // when somebody started writing both events.
      //
      // The table's third state, `released`, does not appear here: the taxonomy
      // does not declare `lease.released`, so the projection by events is blind
      // to a normal release. It is a known gap, noted in
      // `docs/spec/runner-and-controller.md` §7, not an oversight.
      case 'lease.granted':
        state.leases[id] = { status: 'active' };
        break;

      case 'lease.expired':
        state.leases[id] = { status: 'expired' };
        break;

      // --- graph version ----------------------------------------------------
      // Registering does NOT move the pointer: a version can exist in the
      // database without ever having held (D15 — applying is a separate act,
      // and it is the one that moves).
      case 'graph_version.registered':
        break;

      case 'graph_version.applied':
        state.current_graph_version[data.graph_id] = id;
        break;

      // A rollback moves the pointer back and erases nothing: the abandoned
      // version stays in the log and in the database, with its telemetry.
      case 'graph_version.reverted':
        state.current_graph_version[data.graph_id] = data.target_version;
        break;

      // --- execution --------------------------------------------------------
      // The end of the round (D21, t245). The key is `entity.id`, which here is
      // the `execution_id` itself, and the instant is the envelope's
      // `occurred_at` — the event carries no payload at all, and needs none:
      // when the round ended is the when of the fact.
      //
      // A round nobody declared finished is ABSENT from this map, never present
      // with `finished_at: null`. It is the same posture as `jobs`: a key exists
      // because there was a fact, and the control plane only asserts this one
      // once (`packages/core/src/repositories/job.ts`).
      case 'execution.finished':
        state.executions[id] = { finished_at: event.occurred_at };
        break;

      default:
        break;
    }
  }

  return state;
}

export default reconstructState;
