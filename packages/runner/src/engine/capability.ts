/**
 * The neutral capability, resolved to a model and an effort (t1282).
 *
 * A graph and a node may say `general` or `advanced` — two words of THIS
 * project's vocabulary, which name no engine, no model and no effort. What they
 * buy is the installation's decision, made per engine in the ADAPTER'S OWN
 * environment, and this module is the one place that reads it, shared by the
 * three adapters that have a model flag (the shell adapter opens no session and
 * has none):
 *
 * - `<PREFIX>_MODEL_<LEVEL>` — required. `PREFIX` is `CLAUDE`, `CODEX` or
 *   `COPILOT`, `LEVEL` is `GENERAL` or `ADVANCED`;
 * - `<PREFIX>_EFFORT_<LEVEL>` — optional, and only for an engine with an effort
 *   flag (claude-code and codex; copilot has none known to this repository, so
 *   its variable is not read).
 *
 * **There is no default model in code, and that is the one place this field
 * differs from `modelTier`.** `command.ts` answers "what does a trivial tier
 * cost" with `claude-haiku-4-5` because the tier is a request for the cheap
 * model and somebody measured which one that is. A capability is a request for
 * a PINNED model, and a pin nobody wrote down is a guess: the runner cannot
 * know which models an installation can reach, and a guessed identifier does
 * not fail politely — it reaches the CLI and kills the session, or worse, runs
 * the work on a model nobody chose and records the capability as satisfied. So
 * an unmapped level is REFUSED, before any spawn, with the variable to set in
 * the message.
 *
 * Values are trimmed and a blank counts as unset (an empty `--model` would kill
 * the session on a flag nobody typed). The effort is otherwise passed through
 * untouched: the CLI refuses an unknown effort, as it refuses an unknown model,
 * and a list kept here would age the day an engine adds a level.
 *
 * English per D18.
 */

import { SessionStartError } from './types.ts';

/** The closed set, in the order the documents list it. */
export const CAPABILITY_LEVELS = ['general', 'advanced'] as const;

/** One of the two levels. */
export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

/**
 * Prefix of every refusal for a level the installation has not mapped (t1282).
 *
 * Stable on purpose, like `PERMISSION_REFUSAL_PREFIX`: it is what lets
 * `classifyPreSessionFailure` tell "this will never work until somebody maps the
 * level" from a spawn that failed and might heal. The message continues with
 * `<engine> <level>` and then the variable to set.
 */
export const CAPABILITY_REFUSAL_PREFIX = 'capability unmapped: ';

/** The environment variable that names the model of a level, for one adapter prefix. */
export const capabilityModelVariable = (prefix: string, level: string): string =>
  `${prefix}_MODEL_${level.toUpperCase()}`;

/** The environment variable that names the effort of a level, for one adapter prefix. */
export const capabilityEffortVariable = (prefix: string, level: string): string =>
  `${prefix}_EFFORT_${level.toUpperCase()}`;

/** A level resolved: the model to pin, and the effort when the engine has one and it is set. */
export interface ResolvedCapability {
  readonly model: string;
  readonly effort?: string;
}

/** What the resolver needs to know about one adapter. */
export interface CapabilityLookup {
  /** The adapter's `engineName`, as the refusal quotes it. */
  readonly engine: string;
  /** `CLAUDE`, `CODEX` or `COPILOT`. */
  readonly prefix: string;
  /** The level the spec asked for. */
  readonly level: string;
  /** The adapter's own environment. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether this engine has an effort flag. `false` means the effort variable is never read. */
  readonly hasEffort: boolean;
}

const isLevel = (value: string): value is CapabilityLevel =>
  (CAPABILITY_LEVELS as readonly string[]).includes(value);

/** A variable's trimmed value, or `undefined` when it is unset or blank. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolves a capability to the model and effort this installation pinned.
 *
 * @param lookup Which adapter, which level, and where to read.
 * @returns The model to pin, and the effort when there is one.
 * @throws {SessionStartError} With {@link CAPABILITY_REFUSAL_PREFIX} when the
 *   level has no model mapped, or is not one of the two levels at all. Thrown
 *   from the pure command builder, so it happens before any spawn.
 */
export function resolveCapabilityPin(lookup: CapabilityLookup): ResolvedCapability {
  const { engine, prefix, level, env, hasEffort } = lookup;

  if (!isLevel(level)) {
    // Registration is the refusal for a bad value and the dispatch drops one
    // before it gets here, so this is a spec built by hand. Still never a guess.
    throw new SessionStartError(`${CAPABILITY_REFUSAL_PREFIX}${engine} ${level}`);
  }

  const variable = capabilityModelVariable(prefix, level);
  const model = read(env, variable);
  if (model === undefined) {
    throw new SessionStartError(
      `${CAPABILITY_REFUSAL_PREFIX}${engine} ${level} (set ${variable})`,
    );
  }

  const effort = hasEffort ? read(env, capabilityEffortVariable(prefix, level)) : undefined;
  return effort === undefined ? { model } : { model, effort };
}
