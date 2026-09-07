/**
 * The escalation block a session emits when it needs a human (t106, FR5).
 *
 * A session that cannot finish without a decision ends its turn with one fenced
 * block and stops — it does not sit alive waiting for an answer. This module is
 * the only thing that knows the block's shape; what to DO with it belongs to
 * the dispatch (`dispatch.ts`) and, past the API, to the question
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

/**
 * One control of a batched question (t480).
 *
 * `options` began as one-click labels for ONE decision, and for one decision it
 * stays exactly that. A step of the interview asks several things at once —
 * measured at seventeen turns for four of seven steps — and a step's worth of
 * decisions is a form: an ordered list of named controls, answered as a single
 * JSON document keyed by each field's `id`.
 *
 * The two shapes travel on the same key and are told apart by what the items
 * are, which is why they can both be permanent: nothing has to be migrated, and
 * a reader that only knows labels sees a list it does not recognise rather than
 * a key that vanished.
 */
export interface Field {
  /** The key this field's value carries in the answer document. */
  id: string;
  /** What the person reads beside the control. */
  label: string;
  /** choice: pick one. multi: pick any number. free_text: type it. */
  kind: 'choice' | 'multi' | 'free_text';
  /** What there is to pick from, for a `choice` or a `multi`. */
  options?: string[];
  /** What the agent would pick. `postSessionQuestion` derives the default from these. */
  recommended?: string | string[];
}

/** The three controls a field may be. */
const FIELD_KINDS: readonly string[] = ['choice', 'multi', 'free_text'];

/** What a session needs a human to decide. Only `question` is required. */
export interface InputRequest {
  /** What is being asked. */
  question: string;
  /** Background the human needs to answer it. */
  context?: string;
  /**
   * What is being decided: discrete choices for one decision, or the fields of
   * a whole step asked at once (t480).
   */
  options?: string[] | Field[];
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

/** Reads a list of non-empty strings, or `undefined` when it is not one. */
function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === 'string' && item.trim() !== '')) return undefined;
  return [...(value as string[])];
}

/**
 * Reads one item as a field, or `null` when it is not one (t480, FR3).
 *
 * The three keys that make a field answerable — a name for the value, a label
 * to read, a kind of control — are required, and an item missing any of them is
 * not something a form can draw. The two decorations are not: a malformed
 * `options` or `recommended` costs the field those keys and nothing more,
 * because a control with no shortcut list is still a control.
 */
function buildField(item: unknown): Field | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;

  const raw = item as Record<string, unknown>;
  const id = optionalText(raw.id);
  const label = optionalText(raw.label);
  const kind = optionalText(raw.kind);
  if (id === undefined || label === undefined || kind === undefined) return null;
  if (!FIELD_KINDS.includes(kind)) return null;

  const field: Field = { id: id.trim(), label: label.trim(), kind: kind as Field['kind'] };

  const options = optionalStringList(raw.options);
  if (options !== undefined) field.options = options;

  const recommended = optionalText(raw.recommended) ?? optionalStringList(raw.recommended);
  if (recommended !== undefined) field.recommended = recommended;

  return field;
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
  // losing the shortcut list is cheaper than losing the escalation. Since t480
  // the same rule applies one level down — an unusable FIELD is dropped and its
  // siblings survive — and `options` only disappears when nothing in it did.
  if (Array.isArray(raw.options)) {
    if (raw.options.every((item) => typeof item === 'string')) {
      // The empty array lands here too, and keeps landing here: it has always
      // been kept rather than dropped, and it is a list of labels with nothing
      // in it, never a form with no fields.
      request.options = [...(raw.options as string[])];
    } else {
      const fields = raw.options.map(buildField).filter((field) => field !== null);
      if (fields.length > 0) request.options = fields;
    }
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
