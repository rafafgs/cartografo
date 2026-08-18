/**
 * The surface `dispatch.ts` has always had, re-exported from the files that own
 * each piece now (t202, t223, t268).
 *
 * Every name below was DECLARED in `dispatch.ts` at some point and is imported
 * from there by `cli/run.ts`, by the spikes and by this package's tests.
 * Re-exporting rather than asking each caller to follow the declaration is the
 * rule every split of this directory has run under: a refactor that renames
 * nothing may not make anybody edit an import. Each one now lives next to what
 * it is about — the three refusals next to the renderer that raises them, the
 * taxonomy table next to the write that uses it, the escalation paragraph and
 * the policy next to the field they read, the routing decisions next to
 * `resolve-node.ts`'s answer, and 250 lines of configuration out of the way of
 * the sequence.
 *
 * The list moved HERE with t268, and for the reason the budget itself gives
 * (`test/dispatch/file-size-budget.test.ts`: "Split it"): `dispatch.ts` was at
 * 599 of its 600 lines, and what that ficha adds to it is the SEQUENCE — a
 * fifth way for a work to stop, and the precedence between it and the two that
 * were already there. A list of re-exports is the one thing in that file that
 * is not the sequence and never was: it is a passenger, in a file whose whole
 * job is the order things happen in. `dispatch.ts` re-exports it whole, so no
 * name changed and no caller edits an import — the same rule, one more time.
 *
 * English per D18.
 */

export {
  SkillNotRegisteredError,
  SkillPinMismatchError,
  UnresolvedPlaceholderError,
} from './render-skill-instructions.ts';
export { ESCALATION_PROTOCOL } from './escalation-protocol.ts';
export { TAXONOMY_STATUS } from './report.ts';
export {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_MAX_CONSECUTIVE_PRE_SESSION_FAILURES,
  DEFAULT_SILENCE_SECONDS,
  type ClaudeCodeDispatchOptions,
  type Job,
} from './options.ts';
export { DEFAULT_ENGINE, UnknownEngineError, type EngineRoute } from './resolve-engine.ts';
export { DispatchError, type DispatchOutcome } from './outcome.ts';
export { resolveEscalationPolicy, DEFAULT_ESCALATION_POLICY } from './resolve-node.ts';
export type { EscalationPolicy } from './resolve-node.ts';

/**
 * Everything the session said, with Claude Code's frames decoded back into text.
 *
 * @deprecated Moved to `./session-text.ts` as `decodeClaudeCodeSessionText`
 * (t141, FR6) — one decoder per engine. Re-exported unchanged all the same, and
 * from here since t272: a deprecated alias for a function another module owns is
 * the exact thing this file was cut to hold.
 */
export { decodeClaudeCodeSessionText as sessionText } from './session-text.ts';
