/**
 * The one scanner both fenced-block parsers are built on (t161, FR9).
 *
 * A session closes its turn with a fenced JSON block, and this repository now
 * reads two of them: `input-request`, which asks a human something (t106), and
 * `resultado`, which names the edge a gate took. The two are different facts and
 * live in different modules, but the READING of them is one procedure with one
 * set of rules, inherited from flowpilot's
 * `app/services/flow/controller_parser.py` (D17 — flowpilot is the behaviour
 * reference, never a dependency):
 *
 * - **The block's extent comes from the JSON, never from a fence search.** A
 *   payload routinely quotes fenced code of its own — an escalation's `context`
 *   pastes a ticket body, a gate's evidence pastes the output of a command — and
 *   a naive scan for the next ``` cuts the block in half. Python has
 *   `raw_decode` for this; `JSON.parse` has no equivalent, so the extent is
 *   found by walking the value with a brace/quote scanner and parsing exactly
 *   what it delimits.
 * - **A malformed block is ignored, never raised.** Bad model output must not
 *   crash a dispatch. Nothing here throws.
 * - **The last valid block wins.** A final answer supersedes earlier scratch
 *   output, and only a VALID block supersedes an earlier one — garbage written
 *   after the answer cannot erase the answer.
 *
 * It is extracted rather than copied because two copies of these rules is two
 * parsers that drift, and the day they disagree is the day one of them throws
 * where the other returned `null` — which, on the routing side, is a dispatch
 * that dies instead of calling a human.
 */

/**
 * The index just past the JSON value that starts at `start`.
 *
 * Only objects are considered: every block's payload is `{...}` by contract, and
 * accepting a bare array or number here would just move the failure one step
 * later. Returns `null` when the value never closes — an unterminated block is
 * exactly the malformed case that must not throw.
 *
 * @param text The whole output being scanned.
 * @param start Index of the value's first character.
 * @returns The index just past the value, or `null` when it never closes.
 */
export function findValueEnd(text: string, start: number): number | null {
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
 * Reads the last valid block of one fence out of a session's output.
 *
 * @param output Everything the session printed, decoded into text.
 * @param fence The fence's info string — `input-request`, `resultado`.
 * @param build Turns a parsed payload into the caller's value, or `null` when
 *   the payload is present but unusable. A payload nobody can act on is not a
 *   block, and it may not supersede an earlier one that was.
 * @returns The last block `build` accepted, or `null`. Never throws.
 */
export function parseFencedJson<T>(
  output: string,
  fence: string,
  build: (payload: unknown) => T | null,
): T | null {
  let found: T | null = null;

  // Built here and not module-wide: a `RegExp` with `g` carries `lastIndex`
  // across calls, and a shared one would make two parses of the same text
  // disagree with each other.
  const opening = new RegExp('```' + fence + '[ \\t]*\\r?\\n?', 'g');

  for (let match = opening.exec(output); match !== null; match = opening.exec(output)) {
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

    const built = build(payload);
    if (built !== null) found = built;

    // Resume after the value, never after a fence we did not locate.
    opening.lastIndex = end;
  }

  return found;
}
