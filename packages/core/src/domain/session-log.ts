/**
 * Turning what an engine PRINTED back into what the model SAID, on the core
 * side (t368, FR4).
 *
 * A deliberate duplication of `packages/runner/src/dispatch/session-text.ts`,
 * not an import of it: `packages/runner` depends on `packages/core` and never
 * the other way around, so the runner's module cannot be reached from here.
 * D11 already settled which side grows when the screen needs something the API
 * does not give — "if the screen needs it, the API grows" — and this ticket's
 * own refinement log takes the same side for the decoder: it is ported into
 * `packages/core`, once, rather than reached across the dependency the wrong
 * way. The functions below are copied whole and unmodified from the runner's
 * module; only the entry point ({@link decodeSessionText}) is new.
 *
 * `GET /v1/sessions/:id/log` decodes the ROW's own (possibly capped) transcript
 * — `session.transcript`, split back into lines on `\n`, the same join
 * `packages/runner/src/dispatch/dispatch.ts` used to build it before POSTing.
 * A cap that lands mid-frame yields one unparsable "line" at the head of the
 * capped tail, which both decoders already handle: a line that is not a
 * recognized frame passes through raw, exactly as it would for a stream that
 * really did break off mid-write.
 *
 * English per the repository's language rule (D24).
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
 * The text a Claude Code `stream-json` frame carries, or `null` when the line
 * is not a frame this engine emits.
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
 * The model's own words live in exactly one place: an `item` of type
 * `agent_message`, in its `text`. Everything else is the engine narrating —
 * `file_change` reports work DONE, not something said — so it is dropped
 * rather than echoed. The `type` check is what distinguishes "recognized frame
 * with nothing to say" from "not a frame": any object carrying a string `type`
 * is Codex talking, and its non-text frames are dropped rather than passed
 * through raw.
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
 * Everything a `shell` node printed, which is exactly what it printed.
 *
 * The one decoder in this module with nothing to decode, and that is a fact
 * about the engine rather than a stub: there are no frames, what reached
 * `onOutput` is the command's own stdout and stderr, and a program's output is
 * already the text.
 */
export function decodeShellSessionText(lines: readonly string[]): string {
  return lines.join('\n');
}

/**
 * Decodes one session's stored transcript, routed by its `engine` (t368, FR4).
 *
 * `shell` and every engine this module does not recognize share one answer —
 * the passthrough — mirroring `session-text.ts`'s own default: a decoder that
 * only exists for the two engines that emit frames has nothing to do with a
 * program's raw stdout, or with an engine string nobody has taught it yet.
 *
 * @param engine The session's `engine` column.
 * @param text The stored transcript, exactly as the row holds it (the capped
 *   tail, when the session's own transcript overflowed).
 * @returns The decoded text.
 */
export function decodeSessionText(engine: string, text: string): string {
  const lines = text.split('\n');
  if (engine === 'claude-code') return decodeClaudeCodeSessionText(lines);
  if (engine === 'codex') return decodeCodexSessionText(lines);
  return decodeShellSessionText(lines);
}
