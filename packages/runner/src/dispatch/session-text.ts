/**
 * Turning what an engine PRINTED back into what the model SAID (t141, FR6/FR7).
 *
 * One function per engine, because the frame formats have nothing in common:
 * Claude Code streams Anthropic's `stream-json` (`type: "result"`,
 * `message.content[].text`), Codex streams its own thread/turn/item vocabulary.
 * They share only the contract this module publishes — `readonly string[]` of
 * the lines that reached `onOutput`, in, the text the session produced, out —
 * which is exactly what `ClaudeCodeDispatchOptions.engines` routes on.
 *
 * Why decoding is not optional: `parseInputRequest` looks for a fenced block,
 * and a real session prints FRAMES, so the block's own quotes arrive as `\"` and
 * its newlines as `\n`. Without this step no fenced JSON ever parses and the
 * escalation cycle silently never triggers. The fake engine of the suite prints
 * plain lines, which fall through untouched — which is precisely why that trap
 * survives CI and only a manual run against a real CLI catches it.
 *
 * Both decoders share one rule, and it is the rule that keeps noise out of the
 * parser: a line that IS a recognized frame contributes only its text, even when
 * that text is empty; a line that is not a frame at all passes through raw. The
 * second half is not sloppiness — plain-text runtime errors interleave with the
 * JSON on both engines (`docs/formats/engine-adapter.md`'s viability table
 * measured it on Codex), and dropping them would throw away the only account of
 * a session that died mid-stream.
 *
 * English per D18.
 */

/** One text block of a Claude Code assistant message frame. */
interface TextBlock {
  type: string;
  text: string;
}

const isTextBlock = (value: unknown): value is TextBlock =>
  typeof value === 'object' &&
  value !== null &&
  (value as TextBlock).type === 'text' &&
  typeof (value as TextBlock).text === 'string';

/** A line parsed as a JSON object, or `null` when it is not one. */
function asFrame(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;
  return frame as Record<string, unknown>;
}

/**
 * Joins what each line contributed.
 *
 * `null` means "not a frame of this engine" and puts the line back verbatim;
 * a list — including an empty one — means the line WAS a frame, and only its
 * text counts.
 */
function decode(lines: readonly string[], frameText: (line: string) => string[] | null): string {
  const parts: string[] = [];
  for (const line of lines) {
    const texts = frameText(line);
    if (texts === null) parts.push(line);
    else parts.push(...texts);
  }
  return parts.join('\n');
}

/**
 * The text a Claude Code `stream-json` frame carries, or `null` when the line is
 * not a frame this engine emits.
 */
function claudeCodeFrameText(line: string): string[] | null {
  const frame = asFrame(line);
  if (frame === null) return null;

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
 * The text a Codex `--json` frame carries, or `null` when the line is not one.
 *
 * Pinned on a REAL transcript, captured for t141/FR9 against `codex-cli 0.147.0`
 * with a credential — before this ficha nothing in this repo had ever seen this
 * engine emit model text, only the status frames of the uncredentialed 401 run
 * (`docs/formats/engine-adapter.md`'s viability table). What the real stream
 * showed, in order:
 *
 * ```
 * {"type":"thread.started","thread_id":"01a0…"}
 * {"type":"turn.started"}
 * {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
 * {"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[…]}}
 * {"type":"item.completed","item":{"id":"item_1","type":"file_change","status":"completed"}}
 * {"type":"turn.completed","usage":{…}}
 * ```
 *
 * So the model's own words live in exactly one place: an `item` of type
 * `agent_message`, in its `text`. Everything else is the engine narrating —
 * `file_change` reports work DONE, not something said, and a decoder that let it
 * through would hand the escalation parser a JSON blob describing a diff.
 *
 * The `type` check is what distinguishes "recognized frame with nothing to say"
 * from "not a frame": any object carrying a string `type` is Codex talking, and
 * its non-text frames are dropped rather than echoed.
 */
function codexFrameText(line: string): string[] | null {
  const frame = asFrame(line);
  if (frame === null) return null;
  if (typeof frame.type !== 'string') return null;

  const { item } = frame as { item?: unknown };
  if (typeof item === 'object' && item !== null) {
    const { type, text } = item as { type?: unknown; text?: unknown };
    if (type === 'agent_message' && typeof text === 'string') return [text];
  }

  // A frame of this engine that said nothing: recognized, and therefore dropped.
  return [];
}

/** Everything a Claude Code session said, with its frames decoded back to text. */
export function decodeClaudeCodeSessionText(lines: readonly string[]): string {
  return decode(lines, claudeCodeFrameText);
}

/** Everything a Codex session said, with its frames decoded back to text. */
export function decodeCodexSessionText(lines: readonly string[]): string {
  return decode(lines, codexFrameText);
}

/**
 * Everything a `shell` node printed, which is exactly what it printed (t332).
 *
 * The one decoder in this module with nothing to decode, and that is a fact
 * about the engine rather than a stub. There are no frames: what reached
 * `onOutput` is the command's own stdout and stderr, merged in arrival order,
 * and a program's output is already the text. Anything else here would be this
 * module inventing a format for somebody else's program.
 *
 * It exists as its own function rather than reusing one of the two above, and
 * for a reason a passing test would hide: both of those RECOGNIZE frames, and a
 * command that legitimately prints a JSON object — a `jq` filter, a `--json`
 * flag on some tool — would hit `claudeCodeFrameText`'s `type: "result"` branch
 * or `codexFrameText`'s "any object with a string `type` is this engine
 * talking" rule and have its own output rewritten, or dropped, on the way to the
 * report parser.
 */
export function decodeShellSessionText(lines: readonly string[]): string {
  return lines.join('\n');
}
