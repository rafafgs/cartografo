/**
 * Building the command and the environment of the `codex` CLI.
 *
 * Pure on purpose, symmetric to `command.ts`: no spawn, no state, no clock. It
 * is the seam the conformance kit demands ("an adapter that does not expose that
 * seam is an adapter you cannot certify",
 * `docs/formats/engine-adapter.md:363-366`), and keeping it side-effect free is
 * what lets the argv be checked by unit test without a real CLI and without
 * authentication.
 *
 * All of the adapter's engine vocabulary lives here: the binary name, the
 * subcommand and the flags. None of it crosses the boundary upwards (boundary 1
 * of the specification).
 *
 * The one interesting difference from the first adapter is the injection of the
 * instructions, and it is a difference the specification predicted and priced:
 * `codex exec` has NO system-prompt flag (`engine-adapter.md:122, 405`). Of the
 * three paths the document lists, this module takes the one the document itself
 * exports a function for.
 */

import { resolveCapabilityPin } from './capability.ts';
import { resolveCodexPermissions } from './codex-permission-policy.ts';
import { composeSingleArgument, type SessionSpec } from './types.ts';

/** The headless binary. */
export const CODEX_BINARY = 'codex';

/**
 * The headless subcommand: "Run Codex non-interactively".
 *
 * A dedicated subcommand instead of a flag is why this CLI was picked over the
 * Gemini one for the second adapter — "a smaller and more stable flag surface
 * for an adapter" (`engine-adapter.md:392-396`).
 */
export const CODEX_SUBCOMMAND = 'exec';

/**
 * `stdio` of the engine process: stdin on `/dev/null`, stdout and stderr piped.
 *
 * Invariant 6 of the specification, and this is the engine that produced it:
 * running `codex exec` with a non-TTY stdin printed `Reading additional input
 * from stdin...` before starting, and `codex exec --help` confirms that "if
 * stdin is piped and a prompt is also provided, stdin is appended as a
 * `<stdin>` block". An open pipe nobody writes to leaves the engine waiting for
 * EOF forever — "the timeout does fire, but the cost is a whole session lost to
 * a library default" (`engine-adapter.md:436-445`).
 */
export const ENGINE_STDIO = ['ignore', 'pipe', 'pipe'] as const;

/**
 * The flag that pins the model of one session.
 *
 * The short form, because it is the one `codex exec --help` documents first:
 * `-m, --model <MODEL>` — "Model the agent should use". Measured against
 * codex-cli 0.147.0, the same version the specification's feasibility review
 * cites.
 */
export const MODEL_FLAG = '-m';

/**
 * The config override that sets the reasoning effort of one session (t1282).
 *
 * `codex exec` has no effort flag of its own; the way in is its generic
 * `-c, --config <key=value>` ("Override a configuration value that would
 * otherwise be loaded from `~/.codex/config.toml`... The `value` portion is
 * parsed as TOML"), and the key is `model_reasoning_effort`. Measured against
 * codex-cli 0.147.0: `codex exec --help` documents `-c`, and the binary's own
 * config schema lists `model_reasoning_effort`. Two argv elements — `-c`, then
 * `model_reasoning_effort="<value>"` — with the value quoted so TOML reads a
 * string. Passed through untouched: the CLI refuses an effort it does not know.
 */
export const EFFORT_CONFIG_FLAG = '-c';
export const EFFORT_CONFIG_KEY = 'model_reasoning_effort';

/** What this adapter calls itself in a capability refusal: its `engineName`. */
const CODEX_ENGINE_NAME = 'codex';

/** The prefix of its capability variables: `CODEX_MODEL_GENERAL`, `CODEX_EFFORT_ADVANCED`, ... */
const CAPABILITY_PREFIX = 'CODEX';

/**
 * The variable that names the model a `modelTier: 'trivial'` session runs on.
 *
 * **And there is deliberately no default beside it**, which is where this
 * adapter parts company with the first one. `command.ts` can answer "what does
 * trivial cost here" with `claude-haiku-4-5` because that is a fact about a
 * CLI somebody measured; nothing in this repository establishes which OpenAI
 * model is the cheap one, and a guessed identifier does not fail politely — it
 * reaches the CLI and kills the session on an unknown model.
 *
 * So the tier is still RECORDED on the job by the control plane, and this
 * adapter simply makes no argv change until an operator names the model here.
 * That is a gap, it is written down as one, and `codex-command.test.ts` proves
 * it rather than assuming it — the same honesty `origin: 'catalog'` carries in
 * `listModels()`, and the opposite of a no-op dressed up as success.
 */
export const TRIVIAL_MODEL_VARIABLE = 'CODEX_TRIVIAL_MODEL';

/**
 * End-of-options marker, immediately before the trailing composed positional.
 *
 * Measured against `codex-cli 0.147.0`: `codex exec "-1 apples"` answers
 * `error: unexpected argument '-1' found` and never opens; the same call with
 * `--` before the positional succeeds. The composition starts with the node's
 * instructions, which are prose somebody else wrote — a bullet list is enough.
 */
const END_OF_OPTIONS = '--';

/**
 * Combined `instructions` + `prompt` byte size past which the composition
 * leaves the argv.
 *
 * The same 64 KiB the first adapter takes, and DUPLICATED rather than shared,
 * which is this pair of modules' standing precedent (`codex-adapter.ts:12-17`):
 * with two adapters there is still no evidence of what the shared abstraction
 * should look like, and the number is a margin against an operating-system
 * ceiling, not a contract between the two files. It bites harder here than
 * there — this engine has no system-prompt flag, so the two fields travel
 * composed in ONE argv element, and that element is what meets Linux's 128 KiB
 * `MAX_ARG_STRLEN` first.
 *
 * Bytes and never `.length`, for the reason `command.ts` records: the content
 * is Portuguese, and an accented character is two bytes to the kernel and one
 * unit to JavaScript.
 */
export const ARGV_INLINE_LIMIT_POSIX_BYTES = 64 * 1024;

/**
 * The same limit on Windows (t957): `CreateProcess` caps the WHOLE command line
 * at 32,767 UTF-16 units, so a composition of 30–64 KiB that was inlined made
 * the spawn fail with `ENAMETOOLONG`. 12 KiB leaves room for the other flags
 * and the working directory, and it is conservative on purpose: bytes are
 * always at least the unit count. It bites here too — the whole composition is
 * ONE argv element.
 */
export const ARGV_INLINE_LIMIT_WIN32_BYTES = 12 * 1024;

/** The inline limit for a platform: Windows is the only one with the low ceiling. */
export function argvInlineLimitBytes(platform: NodeJS.Platform): number {
  return platform === 'win32' ? ARGV_INLINE_LIMIT_WIN32_BYTES : ARGV_INLINE_LIMIT_POSIX_BYTES;
}

/** The inline limit of the platform this process runs on. */
export const ARGV_INLINE_LIMIT_BYTES = argvInlineLimitBytes(process.platform);

/** A command ready for `spawn`, with no shell in between. */
export interface EngineCommand {
  readonly command: string;
  readonly args: string[];
  /**
   * What the adapter writes to the process's stdin, when the composition did
   * not fit in the argv. Absent means stdin stays closed, which is invariant
   * 6's default and what every session below the limit gets.
   */
  readonly stdin?: string;
}

/**
 * Assembles the argv of the headless session.
 *
 * Three decisions worth reading before editing:
 *
 * - **`--skip-git-repo-check` goes unconditionally.** The kit's workdirs are
 *   not git repositories (`conformance-kit.ts:148-161` initializes none) and
 *   the flag is harmless against a real worktree. One code path, not two — a
 *   conditional would be a branch nothing in CI ever exercises.
 * - **The composition is `composeSingleArgument`, the specification's own
 *   function** for "engine with no native system prompt: the adapter
 *   concatenates internally" (`engine-adapter.md:129-136`). Rewriting the
 *   concatenation here would satisfy the same assertion while quietly forking
 *   the format; using the document's function makes the normative rule hold by
 *   construction. The other two paths the document lists were weighed and left:
 *   an ephemeral `AGENTS.md` risks colliding with a real one in the target
 *   repository, and `-c base_instructions=…` depends on a configuration key
 *   whose full effect was never measured against the binary.
 * - **The composed argument is the LAST positional, never stdin — while it
 *   fits.** Coherent with stdin closed, and it is what dodges the `<stdin>`
 *   block the CLI would otherwise append. `-m` (t166) therefore goes BEFORE it,
 *   like every other flag: a flag after the positional would either be read as
 *   part of the prompt or move the prompt out of last place, and one of those
 *   two is always true.
 *
 *   Past {@link argvInlineLimitBytes} (by platform) it goes to stdin instead, and the
 *   positional goes away WITH it (t203). The two halves are one move, not two:
 *   `codex exec --help` says stdin is appended as a `<stdin>` block "if stdin
 *   is piped **and a prompt is also provided**", so keeping both would deliver
 *   the content twice, one of them wrapped in a marker nobody asked for.
 *   Omitting the positional entirely was measured reading the prompt clean,
 *   with no artifact — which is exactly the shape the same help documents for
 *   `-`. The composition is still `composeSingleArgument`, byte for byte; only
 *   its destination changed.
 * - **The sandbox flags come from the declared policy, resolved HERE** (t195).
 *   The classification is `codex-permission-policy.ts`'s business and the
 *   spelling is this module's; `resolveCodexPermissions` is called a second
 *   time, on the same spec the adapter already asked about, exactly as
 *   `command.ts` does with `resolvePermissions`. Threading the decision in from
 *   the adapter would make this function's argv depend on a caller having run
 *   something first, and it is the one thing keeping it pure. A refused policy
 *   adds nothing here — the session was already refused before this ran.
 */
export function buildCommand(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EngineCommand {
  const { model, effort } = resolveModelAndEffort(spec, env);
  const { sandboxArgs } = resolveCodexPermissions(spec.permissions);
  const composed = composeSingleArgument(spec);
  const inline =
    Buffer.byteLength(spec.instructions, 'utf8') + Buffer.byteLength(spec.prompt, 'utf8') <
    argvInlineLimitBytes(platform);

  const args = [
    CODEX_SUBCOMMAND,
    '--json',
    '--skip-git-repo-check',
    // Before `-C`: the tier and its override configure the sandbox the
    // working root will live inside, and reading the argv in that order is
    // how a person checks it against `codex exec --help`. Absent policy,
    // absent flags — the argv of a spec that declares nothing is the one it
    // had before this field was ever read.
    ...sandboxArgs,
    '-C',
    spec.workingDir,
    // Absent model and no trivial model to fall back on, absent flag: the CLI
    // resolves its own default, and the argv is what it was before either
    // field existed. Exactly one flag, whatever the two say.
    ...(model === undefined ? [] : [MODEL_FLAG, model]),
    // Only a capability brings an effort, right after the model it belongs to.
    ...(effort === undefined ? [] : [EFFORT_CONFIG_FLAG, `${EFFORT_CONFIG_KEY}="${effort}"`]),
    // Above the limit the two go away together, and the marker goes with the
    // positional it guards: there is nothing left after it to be misread.
    ...(inline ? [END_OF_OPTIONS, composed] : []),
  ];

  return inline ? { command: CODEX_BINARY, args } : { command: CODEX_BINARY, args, stdin: composed };
}

/**
 * The model and effort this session pins, out of the node's own id, its
 * capability and the work's tier (t1282).
 *
 * Same precedence as the first adapter's, for the same reason: `spec.model` is
 * what the GRAPH declared for this node (t166) and wins entirely — no effort,
 * no refusal; then `spec.capability`, the neutral level, which reads
 * `CODEX_MODEL_<LEVEL>` and `CODEX_EFFORT_<LEVEL>` and never the tier variable;
 * then `modelTier` (t175), which a triage heuristic must not let overrule a
 * decision somebody wrote into a graph document — quite apart from two `-m`
 * flags in one argv being a broken command.
 *
 * The difference from `command.ts` on the tier is the documented gap: with no
 * `CODEX_TRIVIAL_MODEL` there is nothing honest to return, so a trivial tier
 * resolves to `undefined` and this adapter changes nothing. A capability does
 * NOT get that softness: an unmapped level is refused, before the spawn.
 *
 * @param spec The session being assembled.
 * @param env The adapter's own environment.
 * @returns The model id to pin and the effort, each `undefined` when not asked.
 * @throws {SessionStartError} When the capability's level is unmapped.
 */
function resolveModelAndEffort(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv,
): { model: string | undefined; effort: string | undefined } {
  if (spec.model !== undefined) return { model: spec.model, effort: undefined };
  if (spec.capability !== undefined) {
    const pinned = resolveCapabilityPin({
      engine: CODEX_ENGINE_NAME,
      prefix: CAPABILITY_PREFIX,
      level: spec.capability,
      env,
      hasEffort: true,
    });
    return { model: pinned.model, effort: pinned.effort };
  }
  if (spec.modelTier !== 'trivial') return { model: undefined, effort: undefined };

  // Blank is unset: an empty `-m` would kill the session on a flag nobody typed.
  const declared = env[TRIVIAL_MODEL_VARIABLE]?.trim();
  return { model: declared ? declared : undefined, effort: undefined };
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
