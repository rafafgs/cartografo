/**
 * Where a node's `{{input.<path>}}` resolves against, in production (t259, FR1).
 *
 * The seam t204 opened and could not fill. `renderSkillInstructions` has failed
 * closed on an unresolved placeholder since then, and the input it was handed
 * was `{}` — honestly, because nothing in this system carried a node's
 * structured output, so nothing could assemble the object the next node's
 * `input` schema declares. Every skill with a placeholder blocked, which was the
 * loud version of a bug that used to be silent: the same skill once opened a
 * session with `{{input.tese_triada.titulo}}` in the prompt and nobody the
 * wiser.
 *
 * t253 built the assembly and published it at `GET /v1/jobs/:id/context`: the
 * job's own identity at `input.job`, the class's static config at
 * `input.project`, every completed session's report merged into the bucket its
 * node's `contract.produces` names, and the answered escalations at
 * `input.perguntas_respondidas` (`packages/core/src/domain/context.ts`). This
 * module is the one call that was missing.
 *
 * **The projection belongs to the control plane, and that is D1, not a
 * convenience.** It is assembled out of four reads of tables only the server
 * writes; a runner that rebuilt it from public routes would be a second author
 * of the same fact, drifting the day either side changed. So the runner asks,
 * and hands over exactly what came back.
 *
 * **A refusal from that route is not caught, and not reclassified.** It is none
 * of the five patterns `pre-session-failure.ts` recognizes, so it travels up
 * through the dispatch's own catch, the tick rejects and the loop retries —
 * which is the right handler for a 5xx and for a control plane that is
 * restarting. Nothing here softens it into an empty input: a dispatch that
 * resolved `{}` because a read failed would render a prompt with the
 * placeholders that happened to be missing, and open a session on it.
 *
 * English per D18; the route and the `input` envelope key are wire vocabulary.
 */

import type { ControlPlaneCall } from './control-plane-client.ts';
import type { Job } from './options.ts';

/** The envelope `GET /v1/jobs/:id/context` answers with. */
interface ContextEnvelope {
  input: Record<string, unknown>;
}

/**
 * Builds the production default of `ClaudeCodeDispatchOptions.resolveInput`.
 *
 * @param call The dispatch's control-plane client — the SAME one every other
 *   route of the dispatch goes through, so that the credential has one owner.
 * @returns A function of the work that answers its node's input.
 */
export function createNodeInputResolver(
  call: ControlPlaneCall,
): (job: Job) => Promise<Record<string, unknown>> {
  return async (job: Job): Promise<Record<string, unknown>> =>
    (await call<ContextEnvelope>(`/v1/jobs/${job.id}/context`, 'GET')).input;
}
