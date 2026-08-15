/**
 * Decoding the `stream-json` frames a Claude Code session prints (t148).
 *
 * It lived inside `dispatch/dispatch-claude-code.ts` until the synthesizer
 * shipped the exact bug it exists to prevent: `synthesize.ts` handed
 * `parseGraphProposal` the raw lines, every fake-engine test stayed green, and
 * every real run exited 1 with `sem um bloco grafo-proposto válido`. A decoder
 * private to the one caller that already knew about the trap is a decoder the
 * next caller cannot find.
 *
 * It sits under `engine/` and not under either caller's directory on purpose:
 * this is knowledge about what the ENGINE emits, next to `claude-code-adapter.ts`
 * which emits it, and neither the dispatcher nor the synthesizer owns it.
 *
 * Scope is this engine's frames and only them. `CodexAdapter` is structurally
 * different — `thread_id`, no `result` field — and pretending one function reads
 * both would produce a decoder that quietly reads neither (rule of two
 * consumers: two adapters before freezing anything shared).
 *
 * English per D18; the frame field names (`type`, `result`, `message.content`)
 * are the engine's wire format and stay as the engine spells them.
 */

/** One text block of an assistant message frame. */
interface TextBlock {
  type: string;
  text: string;
}

const isTextBlock = (value: unknown): value is TextBlock =>
  typeof value === 'object' &&
  value !== null &&
  (value as TextBlock).type === 'text' &&
  typeof (value as TextBlock).text === 'string';

/**
 * The text a `stream-json` frame carries, or `null` when the line is not a
 * frame this engine emits.
 *
 * Without this step the parser would be reading JSON-ESCAPED text: a real
 * Claude Code session prints frames, so the block's own quotes arrive as `\"`
 * and its newlines as `\n`, and no fenced JSON would ever parse. The fake
 * engine of the suite prints plain lines, which fall through untouched — which
 * is exactly why this trap survives CI and only the manual spike catches it.
 */
function frameText(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;

  const { type, result, message } = frame as {
    type?: unknown;
    result?: unknown;
    message?: unknown;
  };

  // The final frame carries the whole last answer; it is the most reliable
  // place the block shows up whole.
  if (type === 'result' && typeof result === 'string') return [result];

  if (typeof message === 'object' && message !== null) {
    const { content } = message as { content?: unknown };
    // An assistant turn with only tool calls yields an empty list — and an
    // empty list is still a recognized frame, so the raw JSON is dropped
    // instead of being fed to the parser as if it were prose.
    if (Array.isArray(content)) return content.filter(isTextBlock).map((block) => block.text);
  }

  return null;
}

/**
 * Everything the session said, with engine frames decoded back into text.
 *
 * @param lines Every line `onOutput` delivered, in the order it delivered them.
 * @returns The readable stream: frames decoded, everything else verbatim.
 */
export function sessionText(lines: readonly string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const texts = frameText(line);
    if (texts === null) parts.push(line);
    else parts.push(...texts);
  }
  return parts.join('\n');
}
