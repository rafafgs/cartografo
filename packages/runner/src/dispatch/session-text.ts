/**
 * Turning what an engine PRINTED back into what the model SAID (t141, FR6/FR7).
 *
 * One function per engine, because the frame formats have nothing in common:
 * Claude Code streams Anthropic's `stream-json` (`type: "result"`,
 * `message.content[].text`), Codex streams its own thread/turn/item vocabulary
 * and Copilot streams a dotted event vocabulary (`assistant.message`,
 * `assistant.message_delta`, `result`). They share only the contract this module publishes — `readonly string[]` of
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
 * All three decoders share one rule, and it is the rule that keeps noise out of
 * the parser: a line that IS a recognized frame contributes only its text, even when
 * that text is empty; a line that is not a frame at all passes through raw. The
 * second half is not sloppiness — plain-text runtime errors interleave with the
 * JSON on every engine (`docs/formats/engine-adapter.md`'s viability table
 * measured it on Codex, and the `Error: Access denied by policy settings` line
 * of a GitHub-routed Copilot run is another), and dropping them would throw away the only account of
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
 *
 * What makes a line this engine's is structural, and it is one field: every
 * `stream-json` line `claude` prints carries a string `type`. The two shapes
 * read below — the terminal `result` and an assistant `message.content[]` — are
 * the only ones that carry TEXT, and they are a subset. Everything else with a
 * `type` is the engine's own session envelope, recognized here and dropped.
 *
 * Recognized-and-textless is not a hypothetical (t485): the founder watched an
 * interview render `system/init` (tools, MCP servers, model id, permission mode,
 * slash commands, worktree and socket paths), `rate_limit_event` and
 * `system/thinking_tokens` as the running turn's answer, because none of them
 * has a `message` key and this function used to return `null` for all three —
 * the same `null` it returns for a line that is not JSON at all. `decode()` has
 * no way to tell those two apart, so the envelope went to the screen as prose.
 *
 * Deliberately NOT a list of the three types seen so far: the next frame kind
 * `claude` adds would leak the same way. Only a line that fails to parse as
 * JSON, or parses to an object with no `type`, is genuinely not a frame — and
 * that line still passes through raw, because a plain-text runtime error is the
 * only account left of a session that died mid-stream.
 */
function claudeCodeFrameText(line: string): string[] | null {
  const frame = asFrame(line);
  if (frame === null) return null;

  const { type, result, message } = frame as {
    type?: unknown;
    result?: unknown;
    message?: unknown;
  };

  if (typeof type !== 'string') return null;

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

  // A frame of this engine that said nothing: recognized, and therefore dropped.
  return [];
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
 *
 * That rule needed no change for t485, which is the whole of t485's fix on the
 * other side: `claudeCodeFrameText` now discriminates the same way, and the two
 * functions are meant to be read as a pair.
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

/**
 * The text a Copilot `--output-format json` frame carries, or `null` when the
 * line is not one (t676).
 *
 * Pinned on a REAL capture against `@github/copilot@1.0.95`
 * (`test/fixtures/copilot-frames.jsonl`). The model's words live in exactly one
 * place, an `assistant.message` frame's `data.content`, which holds the WHOLE
 * message. The `assistant.message_delta` frames before it carry the same text in
 * pieces (`data.deltaContent`), so a decoder that read both would print every
 * answer twice and, worse, split a fenced block across two fragments.
 *
 * Everything else the CLI prints as JSON is its own envelope — `session.*`,
 * `user.message`, `assistant.turn_*`, `model.call_*`, the terminal `result` — and
 * is recognized and dropped, not echoed: `session.mcp_servers_loaded` lists the
 * machine's servers and `result` carries a session id and usage, none of which
 * the model said. An `assistant.message` whose `data.content` is not a string (a
 * tool-call-only turn carries `toolRequests` and an empty one) is that same
 * recognized-textless case.
 *
 * The test for "this is a frame" is the one the other two use: a JSON object
 * with a string `type`. A line that is not JSON, or an object with no `type`,
 * passes through raw — which is what keeps the interleaved plain-text errors.
 */
function copilotFrameText(line: string): string[] | null {
  const frame = asFrame(line);
  if (frame === null) return null;
  if (typeof frame.type !== 'string') return null;

  if (frame.type === 'assistant.message') {
    const { data } = frame as { data?: unknown };
    if (typeof data === 'object' && data !== null) {
      const { content } = data as { content?: unknown };
      if (typeof content === 'string') return [content];
    }
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

/** Everything a Copilot session said, with its frames decoded back to text. */
export function decodeCopilotSessionText(lines: readonly string[]): string {
  return decode(lines, copilotFrameText);
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
 * It exists as its own function rather than reusing one of the three above, and
 * for a reason a passing test would hide: all of those RECOGNIZE frames, and a
 * command that legitimately prints a JSON object — a `jq` filter, a `--json`
 * flag on some tool — would hit `claudeCodeFrameText`'s `type: "result"` branch
 * or the "any object with a string `type` is this engine talking" rule of the
 * Codex and Copilot ones, and have its own output rewritten, or dropped, on the
 * way to the report parser.
 */
export function decodeShellSessionText(lines: readonly string[]): string {
  return lines.join('\n');
}
