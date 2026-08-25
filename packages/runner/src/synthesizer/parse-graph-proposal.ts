/**
 * The graph document a synthesis session emits (t115, FR6).
 *
 * Port of the scanner in `dispatch/parse-input-request.ts`, under a fence of
 * its own. The three rules come across unchanged, because they were never about
 * escalation — they are about reading a fenced JSON value out of a stream of
 * model prose:
 *
 * - **The block's extent comes from the JSON, never from a fence search.** A
 *   proposed graph is full of prose written by a model, and prose about graphs
 *   quotes fenced examples of graphs; a naive scan for the next ``` would cut
 *   the document in half. `JSON.parse` has no `raw_decode`, so the extent is
 *   found by walking the value with a brace/quote scanner.
 * - **A malformed block is ignored, never raised.** Bad model output must not
 *   crash the command. Nothing here throws: the caller gets `null`, and FR7
 *   turns that into exit 1 with the raw output printed and nothing written.
 * - **The last valid block wins.** A session that sketches, reconsiders and
 *   answers has answered with its last document.
 *
 * The fence is `grafo-proposto` and not a reuse of `input-request` on purpose.
 * Both blocks can appear in the same stream — a synthesis session is as free to
 * escalate as any other — and two contracts sharing one fence name is how a
 * dispatch ends up reading a question as a graph.
 *
 * This module does NOT validate the document. Structure and soundness are the
 * gate of `cartografo import` (t108), which is where the human's edited draft
 * goes; duplicating that judgement here would give the person two verdicts to
 * reconcile, and the ficha's whole point is that the human edit IS the gate
 * (D10).
 */

/**
 * A proposed graph document, in the shape of `schema/graph.schema.json`.
 *
 * Deliberately untyped past "it is an object": this module's contract is that
 * the payload parsed and is a document, not that it is a *valid* one. Naming
 * the seven keys here would be a second, weaker copy of the schema, and the
 * first one to drift.
 */
export type GraphProposal = Record<string, unknown>;

/** The opening fence, and nothing else: the closing one is never searched for. */
const OPENING_FENCE = /```grafo-proposto[ \t]*\r?\n?/g;

/**
 * The index just past the JSON value that starts at `start`.
 *
 * Only objects are considered: the payload is a graph document by contract, and
 * accepting a bare array here would just move the failure one step later.
 * Returns `null` when the value never closes — an unterminated block is exactly
 * the malformed case that must not throw.
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

/**
 * Extracts the graph the session proposed, if it proposed one.
 *
 * @param output Everything the session printed, as accumulated by `onOutput`
 *   and joined with newlines.
 * @returns The last valid block, or `null` when there is none. Never throws.
 */
export function parseGraphProposal(output: string): GraphProposal | null {
  let found: GraphProposal | null = null;

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

    // Only a VALID block supersedes an earlier one — garbage written after the
    // answer cannot erase the answer.
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      found = payload as GraphProposal;
    }

    // Resume after the value, never after a fence we did not locate.
    OPENING_FENCE.lastIndex = end;
  }

  return found;
}
