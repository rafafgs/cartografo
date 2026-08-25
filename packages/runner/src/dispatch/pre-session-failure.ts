/**
 * Which pre-session failures are worth blocking a work over, and with what
 * reason (t252, FR1/FR2; t272, FR1).
 *
 * A dispatch does five reads before it acquires a worktree — the work, the graph
 * version, the engine route, the executor environment and the pinned skill — and
 * six of them can throw an error that will reproduce IDENTICALLY on every retry:
 * a placeholder the input does not carry, a skill nobody registered, a pin that
 * stopped matching, an engine with no route, a `graph_version_id` the control
 * plane no longer has, and — since t270 — a test bench `git` cannot read. Until this ficha every one of them travelled up through `tick()` into
 * `cli/run.ts`, which logged one line and turned the loop again — and two
 * seconds later the same job was at the head of the same queue, being dispatched
 * into the same throw. Forever, with nothing a human could see, and with no
 * other job of the project ever tried, because the queue's head never moved.
 *
 * **The whole subject of this module is that boundary.** A reason means the work
 * gets blocked: it leaves the candidate list (`GET /v1/jobs` filters
 * `blocked === false`), somebody reads `block_reason` in the inbox, and the
 * existing `POST /v1/jobs/:id/unblocks` is how it comes back. `null` means the
 * failure is transient — a 5xx, a network timeout, a control plane restarting —
 * and for those the retry IS the right answer; blocking one would make a person
 * undo a hiccup by hand.
 *
 * So the seven are a CLOSED set, each matching a reproduction somebody actually
 * hit. Everything else classifies to `null`, including the two error families'
 * own siblings: a wider net here is a work blocked over something that would
 * have healed itself, which is the failure mode in the other direction. The set
 * grew twice, with t270 and t272, and both times it grew the way it is meant to
 * — a cause somebody reproduced arrived, its refusal reproduces on every retry,
 * and a cause nobody classifies is a loop nobody sees.
 *
 * **The seventh arrived with t272, and it is the first one from AFTER the
 * worktree.** The t109 game run put a real job through `desenvolvimento-de-
 * software`: `testar-alpha` declares a domain-scoped `network`,
 * `resolvePermissions` cannot express that on this engine, and
 * `ClaudeCodeAdapter.startSession` refuses before the spawn and before
 * `POST /v1/sessions` — 38 leases in two minutes, not one session opened. The
 * refusal is deterministic in the same strong sense the six above are: the same
 * skill hash resolves to the same policy, and the same policy gets the same
 * refusal on every tick. What is NOT in the set is the rest of
 * {@link SessionStartError}, which is one class for four causes — the two spawn
 * shapes carry nothing that tells a binary that is genuinely missing from an
 * `EMFILE`, so they keep classifying to `null` and get the weaker treatment
 * `pre-session-retry.ts` gives them: bounded, not blocked.
 *
 * The prefix is imported from the `claude-code` adapter and matches BOTH
 * adapters: `codex-permission-policy.ts` declares the identical literal
 * independently, and deduplicating the two is another ficha's (t272, Out of
 * Scope). If they ever drift, this classification silently stops recognizing
 * codex's half — which is the reason the duplication is written down here as
 * well as there.
 *
 * **Why an `ControlPlaneClientError` with `status === 404` can only be the graph
 * version.** The skill registry's 404 is translated into
 * {@link SkillNotRegisteredError} inside `renderSkillInstructions` before it can
 * reach this function, and the work's own read happens outside the window this
 * classifies. What is left in the window is `resolveNode`, which rethrows
 * whatever the read threw (`resolve-node.ts`) — so a raw 404 arriving here is a
 * dangling `graph_version_id` and nothing else.
 *
 * Pure by construction: no HTTP, no client, no state. Who posts the block is
 * `report.ts`, who decides to is `dispatch.ts`, and this module only answers what
 * happened — which is what makes the boundary testable without a server.
 *
 * English, the reasons included (D24, t309). They were Portuguese deliberately,
 * as "content a PERSON reads in the inbox" — which is the one argument in this
 * package that never rested on the prompt exemption, and it survives the
 * translation intact: they still speak in the voice `blockForUncommittedWork`
 * and `blockWithNobodyToAsk` write in, and they are still not the terse
 * `Error.message` these classes carry for a log. Only the language changed.
 */

import { ControlPlaneClientError } from '../controller/control-plane-client.ts';
import { PERMISSION_REFUSAL_PREFIX } from '../engine/claude-code-adapter.ts';
import { SessionStartError } from '../engine/types.ts';
import {
  SkillNotRegisteredError,
  SkillPinMismatchError,
  UnresolvedPlaceholderError,
} from './render-skill-instructions.ts';
import { UnknownEngineError } from './resolve-engine.ts';
import { ExecutorEnvironmentError } from './resolve-executor-environment.ts';

/**
 * The part of a work this classification names.
 *
 * Declared here rather than imported from `options.ts`, the same rule
 * `report.ts`'s {@link JobRef} follows: this module owes the orchestrator
 * nothing, and structural typing means the dispatch's own `Job` satisfies it
 * without either file naming the other.
 */
export interface PreSessionJob {
  /** The node the work is standing on. */
  current_node_id: string;
  /** The version it traverses, which is the one that may be dangling. */
  graph_version_id?: string | null;
}

/**
 * What the reason calls a graph version the work points at.
 *
 * The absent case cannot happen through `resolveNode` — a work with no version
 * resolves `null` without reading anything, so nothing 404s — and it is written
 * out anyway: a reason that renders `undefined` into the text a person reads is
 * worse than one that says out loud it has no id to show.
 */
function versionOf(job: PreSessionJob): string {
  const declared = job.graph_version_id;
  return declared === undefined || declared === null || declared === ''
    ? 'that the job does not declare'
    : '`' + declared + '`';
}

/**
 * Classifies an error thrown anywhere before a session exists — the window
 * between the work being read and the worktree being acquired, and, since t272,
 * the refusal `startSession` raises before it spawns anything.
 *
 * @param error Whatever the window threw, unopened.
 * @param job The work being dispatched.
 * @returns The block reason when the failure will reproduce on every retry;
 *   `null` when it will not, and the dispatch should keep throwing.
 */
export function classifyPreSessionFailure(error: unknown, job: PreSessionJob): string | null {
  if (error instanceof UnresolvedPlaceholderError) {
    return (
      `Skill \`${error.skillId}\` of node \`${error.nodeId}\` names input this dispatch ` +
      `does not carry: ${error.paths.join(', ')}. No session was opened — a placeholder ` +
      'that does not resolve never reaches the model as text, and nothing about that ' +
      'changes between one tick and the next. Assemble the input of the node (or fix the ' +
      'manifest) and unblock.'
    );
  }

  if (error instanceof SkillNotRegisteredError) {
    return (
      `Node \`${error.nodeId}\` pins skill \`${error.skillId}\`, which is not in the ` +
      'registry. No session was opened: a skill nobody registered does not become ' +
      'generic instruction (D4). Register the manifest and unblock.'
    );
  }

  if (error instanceof SkillPinMismatchError) {
    return (
      `Node \`${error.nodeId}\` pins skill \`${error.skillId}\` at hash ` +
      `\`${error.declared}\`, but the registry carries \`${error.registered}\`. No ` +
      'session was opened: a pin that stopped matching means the content moved ' +
      'underneath a graph somebody validated (D4). Check which of the two changed and ' +
      'unblock.'
    );
  }

  if (error instanceof UnknownEngineError) {
    const known = error.known.length === 0 ? 'none' : error.known.join(', ');
    return (
      `Node \`${error.nodeId}\` asks for engine \`${error.engine}\`, which has no route ` +
      `in this runner (registered: ${known}). No session was opened: dispatching on ` +
      'another engine would run the work on a motor nobody chose, and would record that ' +
      'motor as though the graph had asked for it. Configure the route (or fix the graph) ' +
      'and unblock.'
    );
  }

  // The PREFIX is what decides, and only it: the other three causes this one
  // class carries — a spawn that failed, a session that did not come up, a
  // codex resume nothing asks for yet — say nothing about whether a retry
  // would behave differently.
  if (error instanceof SessionStartError && error.message.startsWith(PERMISSION_REFUSAL_PREFIX)) {
    return (
      `Node \`${job.current_node_id}\` pins a permission policy this engine does not ` +
      `know how to apply, and it refused before opening: ${error.message}. No session ` +
      'was opened: an engine that cannot express the policy either refuses or runs ' +
      'enforcing less than was declared, and the second is the one outcome a permission ' +
      'system may never have (D4). The same skill, at the same hash, is refused again on ' +
      'every retry — fix what the message points at in the manifest and unblock.'
    );
  }

  // The status is what decides, and only this one: every other refusal is the
  // control plane having a bad day, and a bad day passes.
  if (error instanceof ControlPlaneClientError && error.status === 404) {
    return (
      `The job points at graph version ${versionOf(job)}, and the control plane ` +
      'answered 404: the reference is dangling. No session was opened — without the ' +
      'snapshot there is no node, no contract and no outgoing edge, and the read answers ' +
      'the same 404 on every retry. Point the job at a registered version and unblock.'
    );
  }

  // The bench read, which t270 brought in with the read that produces it. A
  // bench that `git` could not read is a
  // configuration error of THIS runner — a path that is not a repository, a
  // main branch that does not resolve, a checkout somebody moved — and it
  // answers identically on every retry. It is not the control plane having a
  // bad day, so it never heals itself, and leaving it unclassified would have
  // reopened t252's loop for the one failure mode this ficha invented.
  if (error instanceof ExecutorEnvironmentError) {
    return (
      `The runner could not read the execution environment of this node: ` +
      `\`${error.command}\` failed (${error.stderr === '' ? 'no output' : error.stderr}). ` +
      'No session was opened — the test bench path and the reference commit are ' +
      'configuration of THIS process, and a bench that does not answer answers the same ' +
      'way on every retry. Fix the bench configuration (`--test-bench-path`, ' +
      '`--reference-repo`, `--main-branch`) and unblock.'
    );
  }

  return null;
}
