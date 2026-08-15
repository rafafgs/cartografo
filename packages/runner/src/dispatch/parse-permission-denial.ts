/**
 * The denied attempts a session made, read off the raw engine stream
 * (t125, FR6).
 *
 * Same posture as `parse-input-request.ts` — it never throws and ignores what
 * it does not recognize — over a different input: not the session's prose, but
 * the `stream-json` frames, which is where a refusal actually shows up.
 *
 * **Structure, never prose.** A denial is recognized by correlating a
 * `tool_use` (`id`, `name`) with the `tool_result` that answers it
 * (`tool_use_id`, `is_error`) — the same block decomposition
 * `dispatch-claude-code.ts` already does for text. The sentence the CLI writes
 * to explain a refusal changes between versions; the frame contract does not.
 *
 * **No false positive, by construction.** Only a tool THIS session denied is
 * even looked at. A `Read` that failed because the file does not exist is a
 * tool error, not a permission incident, and the difference is exactly what
 * this telemetry exists to preserve.
 *
 * What it cannot see: a denial the engine reports outside this correlation, and
 * anything `Bash` reaches by a path no denied pattern names — the residual gap
 * written down in `docs/formatos/engine-adapter.md`, "Permissões da sessão".
 * The tracker records what the gating caught; it does not close the gap.
 */

import { resourceOfDeniedTool } from '../engine/permission-policy.ts';

/** One attempt to use a tool this session's policy had denied. */
export interface PermissionDenial {
  /** Which axis of the policy answered for it. */
  readonly recurso: 'filesystem' | 'rede';
  /** The denied entry that matched, as it was handed to the engine. */
  readonly ferramenta: string;
  /** What the engine said, or the fallback below when it said nothing usable. */
  readonly motivo: string;
}

/** What is recorded when the engine's answer carries no readable text. */
export const DEFAULT_DENIAL_REASON =
  'the engine refused a tool this session denied, with no reason in the frame';

/** Ceiling for the reason kept from the engine's answer. */
const REASON_CEILING = 500;

/** A denied entry, already split into what to match against. */
interface DeniedEntry {
  /** The tool name, e.g. `Bash`. */
  readonly name: string;
  /** The argument pattern, when the entry carries one — e.g. `curl *`. */
  readonly pattern: RegExp | null;
  /** The entry as declared, which is what gets recorded. */
  readonly declared: string;
}

/** A call the engine announced and whose answer has not arrived yet. */
interface PendingCall {
  readonly entry: DeniedEntry;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A tool pattern (`curl *`) as a regular expression.
 *
 * Everything is escaped except `*`, which is the only wildcard the engine's own
 * examples use (`"Bash(git *)"`). Anchored on both ends: a pattern that matched
 * anywhere in the command would report `Bash(curl *)` for a `grep curl` and put
 * a fact in the log that never happened.
 */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, (char) => `\\${char}`))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/** Splits `Bash(curl *)` into name and pattern; `WebFetch` into name alone. */
function parseDeniedEntry(declared: string): DeniedEntry | null {
  const match = /^([A-Za-z0-9_-]+)(?:\((.*)\))?$/.exec(declared.trim());
  if (match === null) return null;

  const [, name, pattern] = match;
  if (name === undefined) return null;

  return {
    name,
    pattern: pattern === undefined ? null : patternToRegExp(pattern),
    declared,
  };
}

/**
 * The text of what a tool answered, whatever shape the block carries.
 *
 * `content` is a string in the simple case and a list of text blocks in the
 * rich one; anything else is treated as "said nothing readable".
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter((block): block is Record<string, unknown> => isObject(block))
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n')
    .trim();
}

/** The blocks of `message.content`, or an empty list when the line is not a frame. */
function frameBlocks(line: string): Record<string, unknown>[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return [];

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!isObject(frame)) return [];

  const { message } = frame;
  if (!isObject(message)) return [];

  const { content } = message;
  if (!Array.isArray(content)) return [];

  return content.filter((block): block is Record<string, unknown> => isObject(block));
}

/**
 * Correlates tool calls with their answers, for ONE session.
 *
 * Stateful because the two halves arrive in different lines and there is no
 * other place to hold the id in between. The state is bounded by what the
 * session itself does: only calls to denied tools are remembered, and each one
 * is dropped as soon as its answer arrives.
 */
export class PermissionDenialTracker {
  readonly #denied: DeniedEntry[];
  readonly #pending = new Map<string, PendingCall>();

  /**
   * @param deniedTools The entries this session denied, as
   *   `resolvePermissions` produced them. An empty list makes the tracker a
   *   no-op, which is the honest reading of "this session denied nothing".
   */
  constructor(deniedTools: readonly string[]) {
    this.#denied = deniedTools
      .map((entry) => parseDeniedEntry(entry))
      .filter((entry): entry is DeniedEntry => entry !== null);
  }

  /**
   * Reads one line of the engine's output.
   *
   * @param line A raw line, exactly as `onOutput` delivered it.
   * @returns The denials this line completed — usually none. Never throws.
   */
  observe(line: string): PermissionDenial[] {
    if (this.#denied.length === 0) return [];

    const found: PermissionDenial[] = [];

    for (const block of frameBlocks(line)) {
      if (block.type === 'tool_use') this.#remember(block);
      else if (block.type === 'tool_result') {
        const denial = this.#answer(block);
        if (denial !== null) found.push(denial);
      }
    }

    return found;
  }

  /** Keeps a call only when it names something this session denied. */
  #remember(block: Record<string, unknown>): void {
    const { id, name, input } = block;
    if (typeof id !== 'string' || typeof name !== 'string') return;

    const entry = this.#match(name, input);
    if (entry === null) return;

    this.#pending.set(id, { entry });
  }

  /** Closes a call; a denial only when the engine reported an error. */
  #answer(block: Record<string, unknown>): PermissionDenial | null {
    const id = block.tool_use_id;
    if (typeof id !== 'string') return null;

    const call = this.#pending.get(id);
    if (call === undefined) return null;
    // Answered once, gone: a repeated frame must not double the incident.
    this.#pending.delete(id);

    if (block.is_error !== true) return null;

    const resource = resourceOfDeniedTool(call.entry.declared);
    // Denied by this session but belonging to no axis: nothing to file it
    // under, and inventing a resource is worse than staying quiet.
    if (resource === null) return null;

    const said = resultText(block.content);
    return {
      recurso: resource,
      ferramenta: call.entry.declared,
      motivo: said === '' ? DEFAULT_DENIAL_REASON : said.slice(0, REASON_CEILING),
    };
  }

  /**
   * The denied entry a call matches, if any.
   *
   * A bare entry matches by name. An entry with a pattern also has to match the
   * command the call carries — `Bash(curl *)` is not "every `Bash`", and
   * treating it as one would report a denial for the `ls` that simply failed.
   */
  #match(name: string, input: unknown): DeniedEntry | null {
    const command = isObject(input) && typeof input.command === 'string' ? input.command : null;

    for (const entry of this.#denied) {
      if (entry.name !== name) continue;
      if (entry.pattern === null) return entry;
      if (command !== null && entry.pattern.test(command.trim())) return entry;
    }

    return null;
  }
}
