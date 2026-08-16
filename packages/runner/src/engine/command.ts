/**
 * Building the command and the environment of the `claude` CLI.
 *
 * Pure on purpose: no spawn, no state, no clock. It is the seam the conformance
 * kit demands ("an adapter that does not expose that seam is an adapter you
 * cannot certify", `docs/formatos/engine-adapter.md:363-366`), and keeping it
 * side-effect free is what lets the argv be checked by unit test without a real
 * CLI and without authentication.
 *
 * All of the adapter's engine vocabulary lives here: the binary name, the flags
 * and the permission-mode environment variable. None of it crosses the boundary
 * upwards (boundary 1 of the specification).
 */

import { resolvePermissions } from './permission-policy.ts';
import { composeWithSystemPromptFlag, type SessionSpec } from './types.ts';

/** The headless binary. */
export const CLAUDE_BINARY = 'claude';

/**
 * Default permission mode.
 *
 * `bypassPermissions` because the session is non-interactive and runs in an
 * isolated worktree — there is nobody there to approve anything, and a session
 * that hangs asking for permission is a session lost. Same trade-off the
 * flowpilot already takes.
 *
 * It is the mode for what the session is NOT forbidden to do, and it stays: the
 * tension this comment used to record — the `SessionSpec` having nowhere to
 * express a policy — was resolved by `spec.permissions` (t125). The two do not
 * compete. `--permission-mode` says "do not stop to ask"; `--disallowedTools`
 * below says "and these you do not get at all", which is the half that survives
 * having nobody to answer a prompt.
 */
export const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

/**
 * The one permission-mode override, read from the ADAPTER'S OWN environment.
 *
 * Deliberately neither a `SessionSpec` field nor an `envOverrides` key: the
 * MODE is engine configuration and stays below the boundary. What comes from
 * above is the POLICY (`spec.permissions`), in the interface's vocabulary and
 * never in this CLI's — which is the whole difference between the two.
 */
export const PERMISSION_MODE_VARIABLE = 'CLAUDE_PERMISSION_MODE';

/** The flag that denies tools by name, one argv element per entry. */
export const DISALLOWED_TOOLS_FLAG = '--disallowedTools';

/**
 * The flag that continues an earlier session, by the id the engine gave it.
 *
 * `claude --help` spells it `-r, --resume [value]` — the value is OPTIONAL
 * there, which is precisely why the position of the flag in the argv is not a
 * matter of taste: with no value of its own, it takes whatever token follows.
 * Confirmed against `claude 2.1.233`, the version the specification's own
 * real-CLI proofs used.
 */
export const RESUME_FLAG = '--resume';

/**
 * The flag that pins the model of one session.
 *
 * `--model <model>`, measured against the CLI's own help: it takes "an alias
 * for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full
 * name (e.g. 'claude-fable-5')". Nothing here interprets which of the two a
 * node declared — resolving an alias is the CLI's business, and a runner that
 * expanded one would be pinning a model the graph did not ask for.
 */
export const MODEL_FLAG = '--model';

/**
 * The model a `modelTier: 'trivial'` session runs on, when nothing overrides it.
 *
 * A constant HERE and not on the `SessionSpec` side, which is the whole point of
 * the tier crossing the boundary instead of the model id: which model is the
 * cheap one is this CLI's business, and the runner above this line has no way to
 * know it (invariant 1). `spec.model` still has no default and must not get one
 * — there the caller named an id, and inventing one for silence would put a
 * choice nobody made into the telemetry. Here the caller named a TIER, which is
 * a request for whatever the cheap one is, so answering it is the honest move.
 *
 * `claude-haiku-4-5`: the cheapest model of the current family, and an alias
 * rather than a dated snapshot on purpose — the CLI's own help documents both
 * forms, and a pinned date is a constant that rots on the next release.
 */
export const DEFAULT_TRIVIAL_MODEL = 'claude-haiku-4-5';

/**
 * The one trivial-model override, read from the ADAPTER'S OWN environment.
 *
 * Same shape and same reason as `PERMISSION_MODE_VARIABLE` above: what comes
 * from the layer above is the TIER, in the interface's vocabulary; the model id
 * that tier resolves to is engine configuration and stays below the boundary.
 * An operator whose installation cannot reach the default model changes it here
 * without any graph, ficha or spec learning a model name.
 */
export const TRIVIAL_MODEL_VARIABLE = 'CLAUDE_TRIVIAL_MODEL';

/**
 * `stdio` of the engine process: stdin on `/dev/null`, stdout and stderr piped.
 *
 * Invariant 6 of the specification, and the only one in the document that came
 * out of running the CLIs instead of reading documentation: an open pipe nobody
 * writes to leaves the engine waiting for EOF forever — "the timeout does fire,
 * but the cost is a whole session lost to a library default"
 * (`docs/formatos/engine-adapter.md:436-445`).
 */
export const ENGINE_STDIO = ['ignore', 'pipe', 'pipe'] as const;

/**
 * End-of-options marker, immediately before the trailing prompt positional.
 *
 * The whole fix for a bug that costs a session and explains nothing: measured
 * against `claude 2.1.233`, `claude --print "-1 apples remain"` answers
 * `error: unknown option '-1 apples remain'` and never opens. A node's
 * instructions are prose written by somebody else — a bullet list, a diff, a
 * negative number — and there is no rule of ours that keeps a `-` out of the
 * first column. After `--` the CLI stops looking for flags, which is the only
 * version of this the caller cannot get wrong.
 *
 * It goes ONLY here, immediately before the positional. Every flag of this argv
 * (`--resume`, `--model`, `--disallowedTools`, `--system-prompt`) is assembled
 * before it and is unaffected — verified against the real CLI for each one.
 */
const END_OF_OPTIONS = '--';

/**
 * Combined `instructions` + `prompt` byte size past which the content leaves
 * the argv.
 *
 * 64 KiB, with room on both sides of the two real ceilings: Linux caps a SINGLE
 * argv element at 128 KiB (`MAX_ARG_STRLEN`) and macOS caps the whole argv+envp
 * block (`ARG_MAX`). The margin is for everything else in the block — the other
 * flags, and an environment this adapter merges but does not control.
 *
 * **Bytes, never `.length`.** The content this project produces is Portuguese
 * prose: every accented character is two bytes in UTF-8 and one UTF-16 unit in
 * JavaScript, so a `.length` check undercounts by up to half, on exactly the
 * input that matters. What the kernel copies is bytes.
 *
 * Past it, nothing fails and nothing is truncated: `instructions` and `prompt`
 * take a channel with no practical ceiling. The limit is where the mechanism
 * changes, not where the session stops working.
 */
export const ARGV_INLINE_LIMIT_BYTES = 64 * 1024;

/**
 * Name of the ephemeral file the oversized path writes under `spec.workingDir`.
 *
 * Dotted and namespaced because it lands in a directory somebody else's work
 * lives in: this is the runner's file, it exists for the length of one session,
 * and the adapter removes it at the end. `--system-prompt-file` is what reads
 * it — a flag `claude --help` does not list on its own, but which `--bare`'s own
 * description cites (`--system-prompt[-file]`) and which was measured working
 * against `claude 2.1.233`.
 */
export const SYSTEM_PROMPT_FILE_NAME = '.cartografo-system-prompt';

/** The flag that reads the system prompt from a file instead of from the argv. */
export const SYSTEM_PROMPT_FILE_FLAG = '--system-prompt-file';

/** A command ready for `spawn`, with no shell in between. */
export interface EngineCommand {
  readonly command: string;
  readonly args: string[];
  /**
   * What the adapter writes to the process's stdin, when the content did not
   * fit in the argv. Absent means stdin stays closed, which is invariant 6's
   * default and what every session below the limit gets.
   */
  readonly stdin?: string;
  /**
   * A file the adapter writes under `spec.workingDir` before spawning and
   * removes when the session ends. Absent on every path but the oversized one.
   */
  readonly ephemeralFile?: { readonly relativePath: string; readonly content: string };
}

/** The permission mode in force: the environment variable, or the default. */
export function resolvePermissionMode(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env[PERMISSION_MODE_VARIABLE]?.trim();
  return declared ? declared : DEFAULT_PERMISSION_MODE;
}

/**
 * The model this session pins, out of the node's own id and the work's tier.
 *
 * The precedence is the interesting half and it only has one honest answer:
 * `spec.model` is what the GRAPH declared for this node (t166), `modelTier` is
 * what the intake said this work costs (t175), and a triage heuristic does not
 * overrule a decision somebody wrote into a graph document. It is also not a
 * matter of taste — returning both would put two `--model` flags in one argv,
 * which is a command the CLI refuses.
 *
 * `'standard'` resolves to `undefined` alongside absence, on purpose: it says
 * "the engine's default is fine", and the honest way to ask for an engine's
 * default is to assemble no flag at all.
 *
 * The blank guard on the override is `resolveModel`'s, on the dispatch side,
 * for the same reason: a `CLAUDE_TRIVIAL_MODEL=" "` would otherwise reach the
 * CLI as an empty `--model` and kill the session on a flag nobody typed.
 *
 * @param spec The session being assembled.
 * @param env The adapter's own environment.
 * @returns The model id to pin, or `undefined` for the engine's own default.
 */
export function resolveModel(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (spec.model !== undefined) return spec.model;
  if (spec.modelTier !== 'trivial') return undefined;

  const declared = env[TRIVIAL_MODEL_VARIABLE]?.trim();
  return declared ? declared : DEFAULT_TRIVIAL_MODEL;
}

/**
 * Assembles the argv of the headless session.
 *
 * The last three positions come out of `composeWithSystemPromptFlag` — the
 * specification's own function for "engine with a native flag: the instructions
 * become the system prompt and the prompt goes through untouched"
 * (`engine-adapter.md:138-144`). Using the document's function instead of
 * rewriting it here is what makes the normative rule (`instructions` and
 * `prompt` NEVER concatenated) hold by construction, and not by the discipline
 * of whoever edits this file next.
 *
 * Two things about the denied list, both of them scars:
 *
 * - **one argv element per entry.** `--disallowedTools <tools...>` is variadic
 *   and the CLI's own help spells an entry with a space inside it
 *   (`"Bash(git *) Edit"`); joining them by hand is how `Bash(curl *)` arrives
 *   split in half. It comes BEFORE `--system-prompt` so that the flag that
 *   follows closes the variadic — after the prompt, it would swallow it.
 * - **`--add-dir` is never assembled, on any path** (invariant 7). An extra
 *   directory hands back, in one flag, the write scope the policy just closed.
 *
 * `--resume` (t173) and `--model` (t166) obey the same ordering discipline, for
 * the same reason read from the other end: both go BEFORE the denied list and
 * before the system-prompt trailer, because both of those swallow what follows
 * them. A ref landing inside either would arrive as a denied tool or as part of
 * the prompt, and the CLI would open a fresh session without anybody being
 * told; a model id landing there would be read as one more denied tool, or as a
 * trailing positional the composition owns. Before both, each flag closes on
 * its own value and changes nothing else.
 *
 * **The trailer has two shapes since t203, chosen by SIZE and by nothing else.**
 * Below {@link ARGV_INLINE_LIMIT_BYTES} it is the one it always was, plus the
 * `--` guard; at or above it, `instructions` becomes an ephemeral file and
 * `prompt` becomes stdin, and no positional is assembled at all. Both shapes
 * come out of `composeWithSystemPromptFlag` — the specification's own function
 * — so the normative rule (`instructions` and `prompt` NEVER concatenated)
 * still holds by construction on both, and the caller above the boundary
 * cannot tell which one ran. That is the whole point, and the specification
 * says so itself: each adapter decides how it injects — the engine's flag, its
 * stdin, or an ephemeral file (`engine-adapter.md:277-279`).
 */
export function buildCommand(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv = process.env,
): EngineCommand {
  const { deniedTools } = resolvePermissions(spec.permissions);
  const model = resolveModel(spec, env);
  // The document's own function, on both branches: rewriting the triple here
  // would satisfy the same assertions while quietly forking the format.
  const composed = composeWithSystemPromptFlag(spec);
  const inline = combinedBytes(spec) < ARGV_INLINE_LIMIT_BYTES;

  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    resolvePermissionMode(env),
    // Absent field, absent flag — and an empty ref counts as absent: a bare
    // `--resume` would take the next token as its value, which is the exact
    // accident the position below exists to prevent.
    ...(spec.resumeFrom ? [RESUME_FLAG, spec.resumeFrom] : []),
    // Absent model AND no trivial tier, absent flag: the engine resolves its
    // own default, and the argv is what it was before either field existed.
    // Exactly one flag, whatever the two fields say — see `resolveModel`.
    ...(model === undefined ? [] : [MODEL_FLAG, model]),
    // Absent policy, absent flag: a session that declared nothing produces
    // exactly the argv it produced before this field existed.
    ...(deniedTools.length === 0 ? [] : [DISALLOWED_TOOLS_FLAG, ...deniedTools]),
    ...(inline
      ? // `--system-prompt`, the instructions, the guard, the prompt. Sliced
        // rather than indexed so the `--` can only ever land between the flag's
        // VALUE and the positional, never between the flag and its value.
        [...composed.slice(0, 2), END_OF_OPTIONS, ...composed.slice(2)]
      : // No trailing positional at all: with `-p` and nothing positional, the
        // CLI reads the whole prompt from stdin (measured, `claude 2.1.233`).
        // Leaving an empty positional behind would be the one shape that breaks
        // it — the CLI would take the empty string as the prompt and never read
        // the pipe.
        [SYSTEM_PROMPT_FILE_FLAG, SYSTEM_PROMPT_FILE_NAME]),
  ];

  if (inline) return { command: CLAUDE_BINARY, args };

  return {
    command: CLAUDE_BINARY,
    args,
    stdin: spec.prompt,
    ephemeralFile: { relativePath: SYSTEM_PROMPT_FILE_NAME, content: spec.instructions },
  };
}

/**
 * What the two fields weigh together, in the unit the kernel counts.
 *
 * Together and not one at a time: the ceiling that matters on macOS is on the
 * whole block, and measuring only the larger of the two would let a pair of
 * 40 KiB fields through as if they were 40 KiB.
 */
function combinedBytes(spec: SessionSpec): number {
  return Buffer.byteLength(spec.instructions, 'utf8') + Buffer.byteLength(spec.prompt, 'utf8');
}

/**
 * Environment of the engine process: the base environment with `envOverrides`
 * on top.
 *
 * `envOverrides` is opaque by the interface's own definition ("what the keys
 * mean is the engine's business"), so nothing is interpreted here — only merged.
 */
export function buildEnvironment(
  spec: SessionSpec,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, ...spec.envOverrides };
}
