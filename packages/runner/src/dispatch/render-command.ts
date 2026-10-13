/**
 * A shell skill's `command` block, rendered against this node's input (t332,
 * moved out of `render-skill-instructions.ts` in t689).
 *
 * The move changes no behaviour. `src/dispatch/` has a 600-line-per-module
 * budget that a test enforces (`test/dispatch/file-size-budget.test.ts`), and
 * the module this came out of was at 598 when t689 needed room for the file
 * placeholder and the command-line guard — the same reason t202, t223, t268,
 * t272 and t332 each moved a piece of that file out with the prose that belongs
 * to it.
 *
 * English per D18.
 */

import { interpolate, type InputFileCollector } from './interpolate-input.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every entry of a list of strings, or an empty list when it is not one. */
function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * The command of a shell skill, rendered — in the ENGINE interface's spelling.
 *
 * The manifest is a product format and spells its keys `snake_case`
 * (`command.env_allowlist`); `SessionSpec` is the adapter's vocabulary and
 * spells them `camelCase`. This is the one place the two meet, exactly as
 * {@link resolveSkillPermissions} is for `permissions` — and for the same
 * reason: a manifest key that leaked into the interface would make every
 * third-party adapter learn a format it has no business reading.
 */
export interface RenderedCommand {
  readonly argv: readonly string[];
  readonly envAllowlist?: readonly string[];
}

/**
 * Resolves a shell skill's `command` block against this node's input (t332).
 *
 * Three decisions, each with a plausible opposite:
 *
 * - **Every argv element goes through the SAME interpolation the body goes through**
 *   (`interpolate-input.ts`), so the grammar, the substitution rules and the
 *   fail-closed refusal are one implementation and not two. Element by element,
 *   never over the joined string: a token that spans two elements is not a token
 *   this format has, and joining to interpolate would be inventing a quoting
 *   problem this engine exists to avoid.
 * - **`env_allowlist` is data, and is NOT interpolated.** Its entries are names
 *   of environment variables; a manifest that wrote a placeholder there would be
 *   naming a variable that cannot exist, and resolving it would let a node's
 *   input decide which of the operator's secrets the child may read — a
 *   permission chosen at run time by whoever fed the projection.
 * - **A malformed block is dropped, never guessed at.** The registry validates
 *   the manifest's shape at the door (`skill-manifest.schema.json`), so a
 *   `command` that is not an object with a string argv is a projection that
 *   changed underneath us. Absent is the safe reading: a `shell` node then meets
 *   the adapter's own refusal, with a message naming the field, instead of
 *   running an argv this function repaired.
 *
 * @param declared The manifest's `command` block, as the registry has it.
 * @param input The already-validated input object of this node.
 * @param unresolved Accumulator shared with the body's own pass.
 * @param files Collector for `{{input_file.<path>}}` (t689), shared with the
 *   body's own pass so one path is one file.
 * @returns The rendered command and the argv as the manifest DECLARED it, index
 *   for index — which is what lets the command-line guard name the placeholders
 *   of the element it refuses — or `undefined` when the skill declares none.
 */
export function renderCommand(
  declared: unknown,
  input: Record<string, unknown>,
  unresolved: string[],
  files?: InputFileCollector,
): { command: RenderedCommand; templates: readonly string[] } | undefined {
  if (!isObject(declared)) return undefined;

  const argv = Array.isArray(declared.argv)
    ? declared.argv.filter((element): element is string => typeof element === 'string')
    : [];
  if (argv.length === 0) return undefined;

  const allowlist = textList(declared.env_allowlist);

  return {
    command: {
      argv: argv.map((element) => interpolate(element, input, unresolved, files)),
      ...(allowlist.length === 0 ? {} : { envAllowlist: allowlist }),
    },
    templates: argv,
  };
}
