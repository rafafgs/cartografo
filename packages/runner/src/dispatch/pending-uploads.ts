/**
 * A completed session whose only failure was the artifact upload keeps its
 * result, and the runner retries the upload instead of the node (t1340).
 *
 * Until this module, a store that refused the file of an `x-artifact` property
 * threw out of `uploadArtifacts`, the dispatch closed the session `failed`
 * (t1313) and the node ran again — a whole paid session to rebuild a file that
 * already existed. In the t1311 incident one job stored the same package as
 * artifacts 2 to 14.
 *
 * Two halves, both called from `dispatch.ts` at one line each:
 *
 * - {@link PendingUploads.hold}, right after the upload and BEFORE the tree is
 *   released: the files the store refused go to the runner's spool
 *   (`artifact-spool.ts`), and the dispatch is told which names to declare
 *   pending on the closure (`pending_artifacts`, t1339). The closure is then the
 *   ordinary `completed` one, with the report exactly as reported.
 * - {@link PendingUploads.resume}, at the top of the next dispatch of the same
 *   job, before anything is resolved or opened: it waits out the backoff, asks
 *   the control plane what is still pending, uploads only that, records each
 *   settlement, and then advances the job from the session's stored text — the
 *   same `advance()` call a normal dispatch ends with. No second session, no
 *   second artifact.
 *
 * **The server is the authority on what is pending.** The spool only holds
 * bytes. An entry whose node is no longer the job's, or whose session the
 * server shows nothing declared on (the closure never landed), is stale and is
 * discarded; and a crash between the settlement and the transition is safe,
 * because the retry finds the name already settled and goes straight to the
 * advance. Every write it repeats is idempotent: the upload by
 * (session, name, sha256) since t1338, the settlement by its exact repeat.
 *
 * **The cap and the backoff are the runner's own.** The core's t1312 cap counts
 * `open` sessions with no lease, and this session is `completed`, so it would
 * never see it. The count lives in the spool's marker, which survives a
 * restart; after the cap one block is posted, the count starts over and the
 * bytes are kept, so an unblock is a fresh round.
 *
 * **What it does not do.** A different runner taking over this machine's spool,
 * retrying a refused declaration, or retrying anything that is not the upload —
 * a decoder, transition or release failure keeps t1313's `failed` closure.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API (D1).
 */

import os from 'node:os';
import path from 'node:path';

import { createExternalOutputWriter, type ExternalOutputWriter } from '../mcp/write-external-outputs.ts';
import { ArtifactSpool, backoffAfter, resolveMaxArtifactUploadAttempts, type SpoolEntry } from './artifact-spool.ts';
import { blockForArtifactUploadExhausted } from './blocks.ts';
import { describeFailure } from './close-after-failure.ts';
import { withProject, type ControlPlaneCall } from './control-plane-client.ts';
import {
  DEFAULT_ARTIFACT_SPOOL_DIR,
  DEFAULT_MCP_CALL_TIMEOUT_MS,
  type ClaudeCodeDispatchOptions,
  type Job,
} from './options.ts';
import type { DispatchOutcome } from './outcome.ts';
import { parseInputRequest } from './parse-input-request.ts';
import { advance } from './report.ts';
import { UnknownEngineError, resolveEngine, type EngineRoute } from './resolve-engine.ts';
import { resolveNode, type GraphVersionBody } from './resolve-node.ts';
import { uploadOne, type UploadArtifactsResult } from './upload-artifacts.ts';

/** What `hold` decided for one session's closure. */
export interface HeldUploads {
  /** The names to declare as `pending_artifacts`. Empty when nothing is held. */
  names: string[];
  /** The report to send on the closure. */
  output: Record<string, unknown> | undefined;
  /** The spool entry, when something is held. */
  entry: SpoolEntry | null;
  /** Why the dispatch stops here, when something is held. */
  reason: string | null;
}

/** The two halves this module gives `dispatch.ts`. */
export interface PendingUploads {
  /**
   * Spools what the store refused, or, when the session also asked a question,
   * holds nothing and strips the pending keys from the report.
   *
   * @throws Whatever writing the spool threw: an ordinary dispatch failure, with
   *   the files still in the worktree.
   */
  hold(job: Job, sessionId: number, outputText: string, uploaded: UploadArtifactsResult): HeldUploads;
  /** Forgets a held entry: the control plane refused the report it rides on. */
  drop(held: HeldUploads): void;
  /** Settles a held upload of this job, or `null` when there is none to resume. */
  resume(job: Job): Promise<DispatchOutcome | null>;
}

/** What `GET /v1/sessions/:id/artifact-settlements` answers. */
interface Settlements {
  pending: string[];
  settled: Array<{ name: string; artifact_id: number }>;
}

/**
 * The MCP window's OUT direction for one engine route (t371), built the same
 * way for the end of a normal dispatch and for a resumed one.
 */
export function externalOutputWriterFor(
  route: EngineRoute,
  options: ClaudeCodeDispatchOptions,
): ExternalOutputWriter {
  return createExternalOutputWriter({
    adapter: route.adapter,
    callTimeoutMs: options.mcpCallTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.maxOutputWriteAttempts === undefined
      ? {}
      : { maxAttempts: options.maxOutputWriteAttempts }),
    ...(options.outputWriteBackoffMs === undefined ? {} : { backoffMs: options.outputWriteBackoffMs }),
  });
}

/** Whether an error is the control plane's 404. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  );
}

/**
 * Builds the held-upload policy of one `createClaudeCodeDispatch`.
 *
 * @param options The dispatch's options: the spool root, the cap, the ladder,
 *   the clock, and what the advance needs.
 * @param call The dispatch's own control-plane client.
 */
export function createPendingUploads(
  options: ClaudeCodeDispatchOptions,
  call: ControlPlaneCall,
): PendingUploads {
  const now = options.now ?? Date.now;
  const spool = new ArtifactSpool({
    root: options.artifactSpoolRoot ?? path.join(os.tmpdir(), DEFAULT_ARTIFACT_SPOOL_DIR),
    now,
    ...(options.artifactUploadBackoffMs === undefined ? {} : { backoffMs: options.artifactUploadBackoffMs }),
  });
  const cap = resolveMaxArtifactUploadAttempts(options.maxArtifactUploadAttempts);
  const uploadOptions = {
    urlBase: options.urlBase,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.doFetch === undefined ? {} : { doFetch: options.doFetch }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  };

  const names = (entry: SpoolEntry): string => entry.state.names.map((name) => '`' + name + '`').join(', ');
  const waitReason = (entry: SpoolEntry, why: string): string =>
    `${why} Session ${String(entry.state.session_id)} of node \`${entry.state.node_id}\` completed, ` +
    `and its declared file ${names(entry)} waits in the runner's spool: attempt ` +
    `${String(entry.state.attempts)} of ${String(cap)}, next attempt at ` +
    `${new Date(entry.state.next_attempt_at).toISOString()}.`;

  return {
    hold(job, sessionId, outputText, uploaded) {
      const pending = uploaded.pending ?? [];
      if (pending.length === 0) return { names: [], output: uploaded.output, entry: null, reason: null };

      // A question wins over holding: the node reruns after the answer, so a
      // path into a released tree may not ride on the report.
      if (parseInputRequest(outputText) !== null) {
        const output = { ...uploaded.output };
        for (const held of pending) delete output[held.name];
        return { names: [], output, entry: null, reason: null };
      }

      const entry = spool.hold({
        jobId: job.id,
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        sessionId,
        nodeId: job.current_node_id,
        output: outputText,
        files: pending.map(({ name, file }) => ({ name, file })),
      });
      const lastError = pending.map((held) => held.error).join('; ');
      return {
        names: entry.state.names,
        output: uploaded.output,
        entry,
        reason: waitReason(entry, `The artifact store refused the upload (${lastError}).`),
      };
    },

    drop(held) {
      spool.discard(held.entry);
    },

    async resume(job) {
      let entry = spool.find(job.id, options.projectId);
      if (entry === null) return null;

      // The job moved on (or back) since: whatever the entry held is not this
      // node's to settle any more.
      if (entry.state.node_id !== job.current_node_id) {
        spool.discard(entry);
        return null;
      }

      const instant = now();
      if (instant < entry.state.next_attempt_at) {
        return { blocked: true, reason: waitReason(entry, 'Waiting to retry an artifact upload.') };
      }

      const sessionRoute = `/v1/sessions/${String(entry.state.session_id)}/artifact-settlements`;
      let state: Settlements;
      try {
        state = await call<Settlements>(withProject(sessionRoute, options.projectId), 'GET');
      } catch (error) {
        if (!isNotFound(error)) throw error;
        spool.discard(entry);
        return null;
      }
      // The closure that declared them never landed: nothing to settle.
      if (state.pending.length === 0 && state.settled.length === 0) {
        spool.discard(entry);
        return null;
      }

      let lastError: string | null = null;
      for (const name of state.pending) {
        try {
          if (!entry.state.names.includes(name)) {
            throw new Error(`the spool holds no file for "${name}"`);
          }
          const id = await uploadOne(uploadOptions, entry.state.session_id, name, spool.fileOf(entry, name));
          await call(sessionRoute, 'POST', { name, artifact_id: Number(id) });
        } catch (error) {
          lastError = describeFailure(error);
        }
      }

      if (lastError !== null) {
        const attempts = entry.state.attempts + 1;
        if (attempts >= cap) {
          // Block first, reset after: a block that failed to post must leave
          // the count at the cap, so the next attempt tries to post it again.
          const reason = await blockForArtifactUploadExhausted(call, job, {
            sessionId: entry.state.session_id,
            nodeId: entry.state.node_id,
            names: entry.state.names,
            attempts,
            lastError,
            spoolDir: entry.dir,
          });
          spool.recordAttempt(entry, { attempts: 0, next_attempt_at: instant });
          return { blocked: true, reason };
        }
        entry = spool.recordAttempt(entry, {
          attempts,
          next_attempt_at: instant + backoffAfter(spool.backoffMs, attempts),
        });
        return { blocked: true, reason: waitReason(entry, `The artifact upload failed again (${lastError}).`) };
      }

      // Everything is settled on the server: advance exactly as the end of a
      // normal dispatch does. A throw leaves the entry for the next dispatch,
      // which finds nothing pending and comes straight back here.
      const resolved = await resolveNode(job, (route) =>
        call<GraphVersionBody>(withProject(route, options.projectId), 'GET'),
      );
      let stopped: string | null = null;
      if (resolved !== null) {
        const engineName = resolveEngine(resolved);
        const route = options.engines[engineName];
        if (route === undefined) {
          throw new UnknownEngineError(engineName, job.current_node_id, Object.keys(options.engines));
        }
        stopped = await advance(
          call,
          job,
          resolved,
          entry.state.session_id,
          entry.output,
          options.advanceMainLine,
          externalOutputWriterFor(route, options),
        );
      }
      spool.discard(entry);
      return stopped === null ? { blocked: false } : { blocked: true, reason: stopped };
    },
  };
}
