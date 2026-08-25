/**
 * The watcher itself: a finished round in, one JSON line per outcome out
 * (t247, FR3).
 *
 * This is D21's third child doing the only thing it was allowed to do — running
 * the two lenses that already existed, over an execution the control plane
 * itself declared over (t245), instead of over an id somebody typed. It applies
 * nothing, approves nothing, and answers no question: the human gate is
 * untouched, and the whole of "automatic" here is WHO calls the lens.
 *
 * Four rules shape the loop, and each one is a decision rather than an
 * implementation detail:
 *
 * - **one execution at a time, and one lens at a time inside it.** No overlap,
 *   no queue, no concurrency knob. That is how both lenses already run by hand
 *   — one round, one invocation — and running two flow sessions at once is a
 *   cost decision nobody has made. Somebody who wants throughput starts a
 *   second process: the control plane's deduplication is the only coordination
 *   two watchers need.
 * - **one lens failing is not the round failing.** A rejection becomes an
 *   `error` line and the next lens runs anyway. A watcher that stopped on the
 *   first bad round would be a watcher that is down by morning, and the round
 *   after it is the one nobody looked at.
 * - **the lenses are injected.** The defaults below build the real ones; the
 *   tests hand in callables. That seam is what lets the dispatch be proven
 *   without an agent session, and it is the only reason this module has no
 *   opinion about how a proposal is made.
 * - **`--dry-run` skips a lens outright** rather than running it and holding
 *   back the write. The flow lens is one atomic call — it opens a real session
 *   and posts in the same breath — so "analyse but do not post" has no seam to
 *   hang off, and inventing one would be a second, unscoped refactor. What a
 *   dry run buys is a cheap check that the plumbing is right.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ClaudeCodeAdapter } from '@cartografo/runner/engine/claude-code-adapter';
// `ControlPlaneClient` rides on the lens's own module rather than on a fourth
// entry of the runner's `exports`: the flow lens is what needs a client, and
// publishing the whole controller to buy one constructor would widen a surface
// this ticket deliberately keeps to three named subpaths.
import { ControlPlaneClient, proposeFlowImprovement } from '@cartografo/runner/surveyor/proposal';
import { evaluateExecution, withCredential } from '@cartografo/cost-surveyor/cli';

import { watchFinishedExecutions, type StreamMessage } from './stream.ts';

/** The two lenses, by the name a person types after `--lens`. */
export type LensName = 'flow' | 'cost';

/** What `--lens` accepts: one of them, or both. */
export type LensSelection = LensName | 'all';

/** Every value `--lens` understands, in the order the usage text lists them. */
export const LENS_SELECTIONS: readonly LensSelection[] = ['flow', 'cost', 'all'];

/** What became of one lens over one round. */
export type Outcome = 'posted' | 'deduped' | 'nothing' | 'error' | 'skipped';

/**
 * One line of output — the whole contract of this command's stdout.
 *
 * The first three fields are on every line, in this order, and the rest appear
 * only where there is news for them: `proposal_id` on the two outcomes that
 * have a proposal, `message` on an error, `reason` on a skip. A line that
 * carried every key with nulls in it would read as an answer to a question
 * nobody asked.
 */
export interface OutcomeLine {
  execution_id: number;
  lens: LensName;
  outcome: Outcome;
  proposal_id?: number;
  message?: string;
  reason?: string;
}

/** What one run of the flow lens reports back. */
export interface FlowRun {
  /** `null` when the round had no bottleneck: nothing was proposed. */
  proposal_id: number | null;
  /** `true` created, `false` deduplicated (t246), `null` nothing to propose. */
  created: boolean | null;
}

/** One candidate the cost lens raised, and what happened to it. */
export interface CostRun {
  proposal_id: number;
  /** `true` created, `false` matched a still-pending proposal (t246). */
  created: boolean;
}

/** What one `watch` needs to know. */
export interface WatchOptions {
  /** Base URL of the control plane. */
  url: string;
  /** Operator credential; both lenses and the stream present it. */
  token: string;
  /** Which lens to run. Default: both. */
  lens?: LensSelection;
  /** Report what each lens WOULD run, and run neither. Default: false. */
  dryRun?: boolean;
  /** The finished rounds. Default: a live subscription to the stream. */
  events?: AsyncIterable<StreamMessage>;
  /** The flow lens. Default: the real one, with a real engine. */
  runFlowLens?: (executionId: number) => Promise<FlowRun>;
  /** The cost lens. Default: the real one. */
  runCostLens?: (executionId: number) => Promise<CostRun[]>;
  /** Where a line goes. Default: stdout, one JSON object per line. */
  write?: (line: string) => void;
  /** Where diagnostics go. Default: nowhere. */
  log?: (message: string) => void;
  /** Stops the watcher: the stream is torn down and the loop ends. */
  signal?: AbortSignal;
  /** `fetch` implementation the default lenses use. Default: the global one. */
  doFetch?: typeof fetch;
}

/** What to put on an `error` line, whatever the failure turned out to be. */
function reasonOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The real flow lens: one agent session, one proposal, one scratch directory.
 *
 * The directory is fresh per round and removed afterwards. The session writes
 * its answer into it (`surveyor/proposal.ts`), and leaving those behind would
 * make a long-running watcher a slow leak in the temporary directory.
 */
function defaultFlowLens(options: WatchOptions): (executionId: number) => Promise<FlowRun> {
  const client = new ControlPlaneClient({
    urlBase: options.url,
    token: options.token,
    ...(options.doFetch === undefined ? {} : { fetchImpl: options.doFetch }),
  });

  return async (executionId) => {
    const workingDir = mkdtempSync(path.join(tmpdir(), 'cartografo-surveyor-'));
    try {
      const result = await proposeFlowImprovement({
        client,
        adapter: new ClaudeCodeAdapter(),
        executionId,
        workingDir,
      });
      return { proposal_id: result.proposta?.id ?? null, created: result.criada };
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  };
}

/**
 * The real cost lens: deterministic aggregation, zero or more proposals.
 *
 * No ceiling is declared, and there is no flag to declare one with: `watch` is
 * a trigger, not a calibration surface. What that leaves running is the tier
 * policy — the one that needs no number from a person — so a round whose graph
 * is too small for it to speak reports `nothing`, which is honest.
 */
function defaultCostLens(options: WatchOptions): (executionId: number) => Promise<CostRun[]> {
  const doFetch = withCredential(options.doFetch ?? fetch, options.token);

  return async (executionId) => {
    const candidates = await evaluateExecution({ url: options.url, executionId, doFetch });
    return candidates.map((candidate) => ({
      proposal_id: candidate.id,
      created: candidate.created,
    }));
  };
}

/** Does this selection include that lens? */
function runs(selection: LensSelection, lens: LensName): boolean {
  return selection === 'all' || selection === lens;
}

/**
 * Runs both lenses over every round that finishes, forever.
 *
 * @param options Control plane, credential, which lens, and how to stop.
 * @throws {StreamDeniedError} When the stream refuses the credential or the
 *   filter — the one failure that is not a line and not a retry.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const selection = options.lens ?? 'all';
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const flowLens = options.runFlowLens ?? defaultFlowLens(options);
  const costLens = options.runCostLens ?? defaultCostLens(options);
  const events =
    options.events ??
    watchFinishedExecutions({
      url: options.url,
      token: options.token,
      ...(options.doFetch === undefined ? {} : { doFetch: options.doFetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.log === undefined ? {} : { log: options.log }),
    });

  const report = (line: OutcomeLine): void => void write(JSON.stringify(line));

  const runFlow = async (executionId: number): Promise<void> => {
    if (options.dryRun === true) {
      report({ execution_id: executionId, lens: 'flow', outcome: 'skipped', reason: 'dry-run' });
      return;
    }
    try {
      const run = await flowLens(executionId);
      if (run.proposal_id === null) {
        report({ execution_id: executionId, lens: 'flow', outcome: 'nothing' });
        return;
      }
      report({
        execution_id: executionId,
        lens: 'flow',
        outcome: run.created === true ? 'posted' : 'deduped',
        proposal_id: run.proposal_id,
      });
    } catch (failure) {
      report({
        execution_id: executionId,
        lens: 'flow',
        outcome: 'error',
        message: reasonOf(failure),
      });
    }
  };

  const runCost = async (executionId: number): Promise<void> => {
    if (options.dryRun === true) {
      report({ execution_id: executionId, lens: 'cost', outcome: 'skipped', reason: 'dry-run' });
      return;
    }
    try {
      const candidates = await costLens(executionId);
      if (candidates.length === 0) {
        report({ execution_id: executionId, lens: 'cost', outcome: 'nothing' });
        return;
      }
      for (const candidate of candidates) {
        report({
          execution_id: executionId,
          lens: 'cost',
          outcome: candidate.created ? 'posted' : 'deduped',
          proposal_id: candidate.proposal_id,
        });
      }
    } catch (failure) {
      report({
        execution_id: executionId,
        lens: 'cost',
        outcome: 'error',
        message: reasonOf(failure),
      });
    }
  };

  for await (const message of events) {
    const executionId = message.envelope.execution_id;
    // A round is what both lenses read by; an event without one is not
    // addressable by either, and there is nothing to run it over.
    if (typeof executionId !== 'number') continue;

    if (runs(selection, 'flow')) await runFlow(executionId);
    if (runs(selection, 'cost')) await runCost(executionId);
  }
}
