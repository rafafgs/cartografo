/**
 * `{{input.<path>}}`, resolved against a node's input (t204, extracted in t332).
 *
 * The manifest format's own interpolation, and its own fail-closed rule: a path
 * that does not resolve does not become text — it aborts the dispatch
 * (`specs/formats/skill-manifest.md`). Until t332 all of it lived inside
 * `render-skill-instructions.ts`, because there was exactly one thing to
 * interpolate: the manifest's `instructions`.
 *
 * A shell skill has a second one. `command.argv` is the whole executed behaviour
 * of such a node, and the format says the same placeholders hold there — which
 * is what lets one registered skill run `radar.promote` for whichever date the
 * job is on, without a manifest per day. Two consumers of the same grammar is
 * exactly the moment an interpolation stops being a detail of its first caller: the
 * alternative was a second implementation beside the first, and two copies of a
 * fail-closed rule is one copy waiting to fail open.
 *
 * The move renames nothing and changes no behaviour. It also buys the room the
 * split needed: `src/dispatch/` has a 600-line-per-module budget that a test
 * enforces (`test/dispatch/file-size-budget.test.ts`), and the module this came
 * out of was at 595 — the same reason t202, t223, t268 and t272 each moved a
 * piece of that file out with the prose that belongs to it.
 *
 * Everything here is pure: no reads, no clock, no network.
 */

/**
 * Every `{{input.…}}` token of a manifest body, whatever is written inside it.
 *
 * Deliberately wider than the path grammar the format declares
 * (`[a-zA-Z0-9_]+` segments joined by `.`): what is NOT a valid path — a dash, a
 * space, an empty tail — is caught by {@link PATH} below and reported as
 * unresolved, instead of being left in the text because the regex did not
 * recognize it. A malformed placeholder is still a placeholder that reached the
 * model, which is the whole bug t204 closed.
 *
 * `[^{}]*` keeps the match inside one pair of braces, so a stray `{` cannot make
 * one token swallow the paragraph that follows it.
 */
const PLACEHOLDER = /\{\{input\.([^{}]*)\}\}/g;

/** The path grammar the manifest format declares. */
const PATH = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Nothing resolved: the value the walk hands back when a segment is missing. */
const UNRESOLVED = Symbol('unresolved');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks one dotted path through the node's input.
 *
 * A segment that the object being walked does not carry AS ITS OWN — and that
 * includes every segment past a value which is not a plain object, an array
 * among them — is unresolved. Inherited properties are not carriers either:
 * `{{input.constructor.name}}` resolves against nothing, because what the
 * manifest is allowed to name is data somebody put in the input, never the
 * prototype chain of the object holding it.
 *
 * @param input The already-validated input object of this node.
 * @param path A dotted path, already known to match the grammar.
 * @returns The value found, or {@link UNRESOLVED}.
 */
function walk(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;

  for (const segment of path.split('.')) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return UNRESOLVED;
    current = current[segment];
  }

  // A key present holding `undefined` cannot come out of parsed JSON, and it is
  // not a value that can be written into a prompt either — `String(undefined)`
  // in the middle of an instruction is exactly the silent wrongness this module
  // refuses. It counts as unresolved, which is the fail-closed answer.
  return current === undefined ? UNRESOLVED : current;
}

/**
 * What one resolved value looks like inside the rendered text.
 *
 * A string goes in verbatim, with no escaping and no quoting: the manifest is
 * reviewed at the import gate (D4), the text around the placeholder was written
 * to read as prose, and quoting it would be this module editing a reviewed
 * document. Anything else — number, boolean, `null`, array, object — goes in as
 * compact JSON, which is the one rendering that is unambiguous for a model to
 * read and never invents line breaks inside a paragraph.
 *
 * It holds unchanged for an argv element (t332), and the reason is the same one
 * read from the other side: `spawn` takes literal arguments, so a value quoted
 * here would arrive at the command with the quotes in it.
 *
 * @param value The value the walk found.
 * @returns The text that replaces the token.
 */
function substitute(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Resolves every placeholder of one string against this node's input.
 *
 * One pass, and the caller refuses at the END of all of them: a manifest missing
 * three fields reports three, because whoever is about to go assemble an input
 * discovering the gaps one dispatch at a time is a round trip per field. That is
 * why `unresolved` is an accumulator the caller owns rather than a return value
 * — since t332 there is more than one string per manifest to fill.
 *
 * @param text The template, as the registry has it.
 * @param input The already-validated input object of this node.
 * @param unresolved Accumulator, filled in first-occurrence order, deduplicated.
 * @returns The interpolated text — meaningless unless `unresolved` stayed empty.
 */
export function interpolate(
  text: string,
  input: Record<string, unknown>,
  unresolved: string[],
): string {
  return text.replace(PLACEHOLDER, (token, path: string) => {
    const value = PATH.test(path) ? walk(input, path) : UNRESOLVED;
    if (value !== UNRESOLVED) return substitute(value);

    if (!unresolved.includes(path)) unresolved.push(path);
    // Returned unchanged, and never read: the caller throws before this text
    // reaches anybody. Leaving the token in place is what keeps a half-rendered
    // body from ever looking like a rendered one while it is being inspected.
    return token;
  });
}
