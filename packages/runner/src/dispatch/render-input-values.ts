/**
 * The VALUES a session's input carries, rendered into its prompt (t267).
 *
 * Until this ficha, the only way a value reached a session was through a
 * `{{input.<caminho>}}` token the manifest author had remembered to write. That
 * makes the prompt's data surface a function of somebody's memory: the projection
 * can be carrying `entrada.fundamentos` in full and the session still opens
 * without it, because the body never named it. The second real crossing of the
 * bets graph is where that stopped being theoretical — `analise-assimetria`
 * escalated asking for two fields the control plane had already assembled
 * (`notas/2026-08-17-segunda-execucao-bets.md`).
 *
 * So the block below is not a convenience: it is the difference between a
 * session that can act on what it has and one that can only act on what a
 * template quoted. It renders the values the SKILL's `input` schema names —
 * which is the declaration of what this node is supposed to receive — and it
 * renders them whole, not summarized.
 *
 * ## Why it is a sibling module and not ten more lines next door
 *
 * `src/dispatch/` has a 600-line-per-module budget with a test behind it
 * (`test/dispatch/file-size-budget.test.ts`, t223), and
 * `render-skill-instructions.ts` is the module that keeps growing because it is
 * the one that composes. `escalation-protocol.ts` and `result-protocol.ts` are
 * the precedent: the piece that can be named separately moves out, carrying the
 * part of the argument that belongs to it. The composition stays over there.
 *
 * ## What this module deliberately does NOT do
 *
 * It never refuses. A key the schema declares and the resolved input does not
 * carry is left out of the block, silently, because the one refusal over missing
 * data is `UnresolvedPlaceholderError` — over a BODY that names it — and a second
 * gate here would block dispatches whose manifest asked for nothing of the sort.
 * The block reports what there is; it does not judge whether it is enough.
 *
 * English per D18. The rendered content stays Portuguese, like every other
 * prompt in this package.
 */

/**
 * The ceiling, in bytes, of the JSON this block fences.
 *
 * 16 KB, and the number is a decision rather than a limit somebody measured: the
 * precedent in this repository is `TRANSCRIPT_CAP_BYTES` at 1 MB
 * (`packages/core/src/repositories/session.ts`), and this cap is deliberately
 * three orders of magnitude under it because the two texts are paid for
 * differently. A transcript is written once to a row nobody re-reads; this block
 * is prepended to every turn of every session on the node, and a node whose
 * predecessor produced a large object would spend its whole context on a copy of
 * it before reading a word of its own instructions.
 *
 * Reversible, and expected to move: the number that survives is the one a real
 * traversal argues for.
 */
export const INPUT_VALUES_CAP_BYTES = 16_384;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The keys the skill's `input` declares, in the order of precedence D9 implies.
 *
 * `properties` first, because it is the wider of the two declarations: a schema
 * that lists five properties of which two are `required` is describing an input
 * of five fields, and showing only the two would hide the optional half of the
 * contract from the one party that has to work with it.
 *
 * `required` second, for the schema that declares nothing else — which is how
 * several manifests in this repository are written.
 *
 * Neither, and the answer is EVERYTHING. A skill that declares no shape has
 * given nothing to filter by, and an empty block would be strictly worse than
 * the whole object: the session would read "here is your input" over `{}` while
 * the projection was carrying six fields.
 *
 * @param declared The skill's `input`, as the registry projects it.
 * @param input The already-resolved input object of this node.
 * @returns The subset to render, in the order the key set gives.
 */
export function selectInputValues(
  declared: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const schema = isObject(declared) ? declared : {};

  let keys: string[] | null = null;
  if (isObject(schema.properties)) {
    keys = Object.keys(schema.properties);
  } else if (Array.isArray(schema.required)) {
    keys = schema.required.filter((key): key is string => typeof key === 'string');
  }

  if (keys === null) return { ...input };

  const selection: Record<string, unknown> = {};
  for (const key of keys) {
    // Own keys only, and the same reading the placeholder walk uses: what a
    // manifest may name is data somebody put in the input, never the prototype
    // chain of the object holding it.
    if (Object.hasOwn(input, key)) selection[key] = input[key];
  }
  return selection;
}

/** A byte count, grouped the way the rendered text is written (`16.384`). */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** What the cap left of the serialized input, and what it cost. */
interface CappedValues {
  /** The JSON text to fence. */
  text: string;
  /** Size in BYTES before the cap; equal to the text's own when it did not bite. */
  originalBytes: number;
  /** Whether the cap bit. Reported whether it did or not — silence is the bug. */
  truncated: boolean;
}

/**
 * Applies {@link INPUT_VALUES_CAP_BYTES} to the serialized selection.
 *
 * The HEAD survives, which is the opposite of `capTranscript`
 * (`packages/core/src/repositories/session.ts`) and for the opposite reason: the
 * end of a crashed stream is where the evidence is, while the beginning of a
 * JSON object is where its structure is. A session handed the tail of an object
 * gets a fragment with no keys in it.
 *
 * The cut walks BACKWARD off UTF-8 continuation bytes (`0b10xxxxxx`), so it
 * lands on the first byte of a whole character: slicing at an arbitrary byte and
 * decoding anyway prints a `U+FFFD` no node ever produced. It costs at most
 * three bytes. The technique is `capTranscript`'s, adapted rather than imported
 * — it lives in the other package, and core is not a dependency of the runner.
 *
 * @param selection The values chosen by {@link selectInputValues}.
 * @returns The text to fence, the original size, and whether it was cut.
 */
function capValues(selection: Record<string, unknown>): CappedValues {
  const whole = JSON.stringify(selection, null, 2);
  const bytes = Buffer.from(whole, 'utf8');
  if (bytes.byteLength <= INPUT_VALUES_CAP_BYTES) {
    return { text: whole, originalBytes: bytes.byteLength, truncated: false };
  }

  let end = INPUT_VALUES_CAP_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;

  return {
    text: bytes.subarray(0, end).toString('utf8'),
    originalBytes: bytes.byteLength,
    truncated: true,
  };
}

/**
 * The `### Valores de entrada` block, as lines ready to splice into the prompt.
 *
 * Fenced JSON, the same shape every other section of
 * `render-skill-instructions.ts` uses, and under the cap that is the whole of it
 * — a marker line with nothing to mark is one more sentence between the session
 * and its instructions.
 *
 * Over the cap there is exactly one extra line, right after the closing fence,
 * and it says three things: how much is shown, how much there was, and where the
 * rest still is. A truncated block with no marker is a prompt that lies by
 * omission — the session reads a complete-looking object, sees the JSON end
 * mid-token, and has no way to tell a cut from a malformed projection.
 *
 * @param declared The skill's `input`, as the registry projects it.
 * @param input The already-resolved input object of this node.
 * @returns The lines of the block, ending in a blank line like every sibling
 *   section.
 */
export function renderInputValues(
  declared: unknown,
  input: Record<string, unknown>,
): string[] {
  const capped = capValues(selectInputValues(declared, input));
  const lines = ['### Valores de entrada', '', '```json', capped.text, '```'];

  if (capped.truncated) {
    const shown = Buffer.byteLength(capped.text, 'utf8');
    lines.push(
      `Cortado no limite do prompt: mostrando os primeiros ${grouped(shown)} de ` +
        `${grouped(capped.originalBytes)} bytes. O objeto inteiro continua em ` +
        '`GET /v1/jobs/:id/context`.',
    );
  }

  lines.push('');
  return lines;
}
