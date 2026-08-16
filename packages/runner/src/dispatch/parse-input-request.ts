/**
 * The escalation block a session emits when it needs a human (t106, FR5).
 *
 * A session that cannot finish without a decision ends its turn with one fenced
 * block and stops — it does not sit alive waiting for an answer. This module is
 * the only thing that knows the block's shape; what to DO with it belongs to
 * the dispatch (`dispatch-claude-code.ts`) and, past the API, to the question
 * entity in the control plane.
 *
 * The behaviour contract is inherited from flowpilot's
 * `app/services/flow/controller_parser.py` (D17 — flowpilot is the behaviour
 * reference, never a dependency), and its three rules — extent from the JSON, a
 * malformed block ignored instead of raised, the last valid block winning —
 * live in `parse-fenced-json.ts` since t161, where the routing parser reads them
 * too. What is left here is the only thing that is this block's own: what a
 * payload has to carry to be an answerable question.
 */

import { parseFencedJson } from './parse-fenced-json.ts';

/** The fence a session opens when it needs a human. */
const FENCE = 'input-request';

/** What a session needs a human to decide. Only `question` is required. */
export interface InputRequest {
  /** What is being asked. */
  question: string;
  /** Background the human needs to answer it. */
  context?: string;
  /** Discrete choices, when the answer is a pick rather than prose. */
  options?: string[];
  /** What the agent would do, as an imperative action. */
  recommendation?: string;
  /** The answer that applies if the human simply accepts. */
  default?: string;
}

/** Reads an optional non-empty string field; anything else is treated as absent. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

/** Builds the request from a parsed payload, or `null` if it is not answerable. */
function build(payload: unknown): InputRequest | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const raw = payload as Record<string, unknown>;
  const question = optionalText(raw.question);
  // A block nobody can answer is not a block. Defaulting to "ask anyway" would
  // put an empty row in the human's queue and block the work behind it.
  if (question === undefined) return null;

  const request: InputRequest = { question: question.trim() };

  const context = optionalText(raw.context);
  if (context !== undefined) request.context = context;

  // A malformed `options` is dropped, not fatal: the question still stands, and
  // losing the shortcut list is cheaper than losing the escalation.
  if (Array.isArray(raw.options) && raw.options.every((item) => typeof item === 'string')) {
    request.options = [...(raw.options as string[])];
  }

  const recommendation = optionalText(raw.recommendation);
  if (recommendation !== undefined) request.recommendation = recommendation;

  const fallback = optionalText(raw.default);
  if (fallback !== undefined) request.default = fallback;

  return request;
}

/**
 * Extracts the escalation a session asked for, if it asked for one.
 *
 * @param output Everything the session printed, as accumulated by `onOutput`
 *   and joined with newlines.
 * @returns The last valid block, or `null` when there is none. Never throws.
 */
export function parseInputRequest(output: string): InputRequest | null {
  return parseFencedJson(output, FENCE, build);
}
