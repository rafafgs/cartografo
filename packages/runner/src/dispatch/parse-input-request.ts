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
 * reference, never a dependency), and its three rules are the whole design:
 *
 * - **The block's extent comes from the JSON, never from a fence search.** A
 *   `context` routinely quotes fenced code of its own, and a naive scan for the
 *   next ``` would cut the block in half. Python has `raw_decode` for this;
 *   `JSON.parse` has no equivalent, so the extent is found by walking the value
 *   with a brace/quote scanner and parsing exactly what it delimits.
 * - **A malformed block is ignored, never raised.** Bad model output must not
 *   crash a dispatch. Nothing here throws: the caller gets `null` and the work
 *   simply stays unblocked.
 * - **The last valid block wins.** A final answer supersedes earlier scratch
 *   output.
 */

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

/** The opening fence, and nothing else: the closing one is never searched for. */
const OPENING_FENCE = /```input-request[ \t]*\r?\n?/g;

/** Reads an optional non-empty string field; anything else is treated as absent. */
function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : value;
}

/**
 * The index just past the JSON value that starts at `start`.
 *
 * Only objects are considered: the block's payload is `{...}` by contract, and
 * accepting a bare array or number here would just move the failure one step
 * later. Returns `null` when the value never closes — an unterminated block is
 * exactly the malformed case that must not throw.
 */
function findValueEnd(text: string, start: number): number | null {
  if (text[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return null;
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
  let found: InputRequest | null = null;

  OPENING_FENCE.lastIndex = 0;
  for (let match = OPENING_FENCE.exec(output); match !== null; match = OPENING_FENCE.exec(output)) {
    // Whitespace between the fence and the value is the model's, not ours.
    let start = match.index + match[0].length;
    while (start < output.length && /\s/.test(output[start])) start += 1;

    const end = findValueEnd(output, start);
    if (end === null) continue;

    let payload: unknown;
    try {
      payload = JSON.parse(output.slice(start, end));
    } catch {
      // Present but unusable. Keep scanning: the next block may be the good one.
      continue;
    }

    const request = build(payload);
    // Only a VALID block supersedes an earlier one — garbage written after the
    // answer cannot erase the answer.
    if (request !== null) found = request;

    // Resume after the value, never after a fence we did not locate.
    OPENING_FENCE.lastIndex = end;
  }

  return found;
}
