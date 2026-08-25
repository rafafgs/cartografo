/**
 * Everything the engine needs to open the session, read and assembled in one
 * place (t223).
 *
 * Two reads and one object. It came out of `dispatch.ts` because it is the last
 * stretch of that file that was not orchestration: the timeline and the answered
 * questions are fetched, `buildPrompt` turns them into text, and the result is
 * packed into the `SessionSpec` the adapter is handed. Nothing here decides
 * anything the sequence depends on — no write happens, and a failure is an
 * ordinary rejection the caller's `catch` already covers, on the path where the
 * worktree is retained and no session exists yet.
 *
 * It runs AFTER the worktree is acquired and the caller keeps it there, which is
 * why `workingDir` is a parameter and not something this module could find out:
 * the directory a session runs in is its entire write scope
 * (`docs/formats/engine-adapter.md`, invariant 7), and a module that could
 * choose one would be a second place able to choose one.
 *
 * **The conditional spreads are the content of this file.** `model`,
 * `modelTier`, `envOverrides` and `permissions` are all "absent or a value",
 * never "present holding nothing": `buildCommand` reads absence, not falsiness,
 * so a `model: undefined` key that survived into the spec would reach the CLI as
 * an empty `--model` and kill the session on a flag nobody typed.
 *
 * English per D18.
 */

import type { SessionPermissions, SessionSpec } from '../engine/types.ts';
import type { ControlPlaneCall } from './control-plane-client.ts';
import type { Job } from './options.ts';
import { buildPrompt, type Event, type Question } from './prompt.ts';
import { resolveModel } from './resolve-engine.ts';
import type { ResolvedNode } from './resolve-node.ts';

/** What the caller has already resolved by the time a spec can be built. */
export interface SessionSpecConfig {
  /** The worktree this session may write in, and nothing outside it. */
  workingDir: string;
  /** The node's rendered skill, or the dispatch's fallback text. */
  instructions: string;
  /** Wall-clock limit, already resolved against its default. */
  timeoutSeconds: number;
  /** Silence limit, already resolved against the server ceiling. */
  silenceSeconds: number;
  /** Opaque additions to the engine's environment, when the wiring passes any. */
  envOverrides?: Readonly<Record<string, string>>;
  /** The manifest's policy when there is one, the dispatch's otherwise. */
  permissions?: SessionPermissions;
}

/**
 * Reads what the prompt needs and packs the session's whole specification.
 *
 * The two reads are the work's own timeline and every question already asked AND
 * answered for it. That second block is what keeps a re-dispatch from asking the
 * same thing forever: engine-native resume is out of scope for the v0 adapter,
 * so "resuming" is always a fresh session that was told what happened
 * (`docs/formats/engine-adapter.md`, "Fora de escopo (v0)").
 *
 * The answered questions are fetched for every work and filtered down to this
 * one here rather than in the query: `GET /v1/input-requests` takes a `status`
 * and no work id, and inventing a filter the API does not have would be a
 * dispatch that quietly depends on a route nobody wrote.
 *
 * @param call The dispatch's one control-plane client.
 * @param job The work being dispatched.
 * @param resolved The node it stands on, or `null` for a work with no graph.
 * @param config What the caller resolved before the session could be specified.
 * @returns The spec to hand `EngineAdapter.startSession`.
 */
export async function buildSessionSpec(
  call: ControlPlaneCall,
  job: Job,
  resolved: ResolvedNode | null,
  config: SessionSpecConfig,
): Promise<SessionSpec> {
  const { events } = await call<{ events: Event[] }>(`/v1/jobs/${job.id}/events`, 'GET');
  // `?status=` is a QUERY PARAMETER of the read side, which t226 translated: the
  // route maps `answered` back to the column's `respondida` at its own boundary.
  const { input_requests: questions } = await call<{ input_requests: Question[] }>(
    '/v1/input-requests?status=answered',
    'GET',
  );

  const prompt = buildPrompt(
    job,
    events,
    questions.filter((question) => question.job_id === job.id),
  );

  // Read from the SAME resolved node the engine came from.
  const model = resolveModel(resolved);

  // The tier comes off the WORK, not off the node — it is a property of what is
  // being done, not of the step doing it, so it is set once and travels to
  // whichever engine this node resolved to. Which model that buys is the
  // adapter's answer, below boundary 1, where model names live. `null` is the
  // ordinary "nobody triaged this", and it reaches the adapters as an absent key
  // rather than a present one holding nothing.
  const modelTier = job.tier ?? undefined;

  return {
    workingDir: config.workingDir,
    instructions: config.instructions,
    prompt,
    timeoutSeconds: config.timeoutSeconds,
    silenceSeconds: config.silenceSeconds,
    ...(model === undefined ? {} : { model }),
    ...(modelTier === undefined ? {} : { modelTier }),
    ...(config.envOverrides === undefined ? {} : { envOverrides: config.envOverrides }),
    ...(config.permissions === undefined ? {} : { permissions: config.permissions }),
  };
}
