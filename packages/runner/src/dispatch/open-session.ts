/**
 * The one write that OPENS a session, as a module of its own (t370, extracted
 * from `dispatch.ts`).
 *
 * `report.ts` already owns every write the runner owes once an outcome is
 * known; this is the write that happens before there is an outcome at all, and
 * it stayed inline while `dispatch.ts` had room for it. It moves for the reason
 * every earlier split of this directory moved something — `escalation-protocol`,
 * `result-protocol`, `interpolate-input`, `render-input-values`, and the two
 * t272 took: the file is at its 600-line budget
 * (`test/dispatch/file-size-budget.test.ts`), and what the ficha adding to it
 * needs room for is SEQUENCE. This is not sequence. It is one `POST` with one
 * argument to make, and the argument travels with it.
 *
 * WHEN it happens stays in the orchestrator, where it has always been: right
 * after `startSession` resolves and inside the block that cancels the session if
 * anything between the process coming up and its outcome fails. Nothing was
 * renamed and no behaviour changed, which is the rule every split of this
 * directory has run under.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API (D1, D11).
 */

import type { ControlPlaneCall } from './control-plane-client.ts';

/** A session, as `POST /v1/sessions` gives it back. */
export interface Session {
  id: number;
}

/** The part of a work this write names — structurally typed, like `report.ts`'s. */
export interface OpeningJob {
  id: number;
  current_node_id: string;
}

/** The part of a `SessionSpec` that is recorded on the row. */
export interface OpeningSpec {
  workingDir: string;
  prompt: string;
  timeoutSeconds?: number;
  silenceSeconds?: number;
}

/**
 * Records that a session is up, with whatever the engine has said by then.
 *
 * `engineSessionRef` may be `null`, and that is not a degraded write: there is
 * no endpoint to fill it in later (out of scope), so `null` means "the engine
 * had not said it yet" and never "this engine has no ref". Some engines print
 * their identifier in the first frame and some print it never; the row is
 * written the moment the process is alive either way, because a session nobody
 * recorded is a session nobody can stop.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work the session was opened for.
 * @param engine The adapter's own `engineName`, as it is persisted.
 * @param engineSessionRef The engine's own id for the session, if it gave one.
 * @param spec What the session was opened with.
 * @returns The session row, which is what everything downstream binds to.
 */
export async function openSession(
  call: ControlPlaneCall,
  job: OpeningJob,
  engine: string,
  engineSessionRef: string | null,
  spec: OpeningSpec,
): Promise<Session> {
  return await call<Session>('/v1/sessions', 'POST', {
    job_id: job.id,
    node_id: job.current_node_id,
    engine,
    engine_session_ref: engineSessionRef,
    working_dir: spec.workingDir,
    prompt: spec.prompt,
    timeout_seconds: spec.timeoutSeconds,
    silence_seconds: spec.silenceSeconds,
  });
}
