/**
 * Building the command and the environment of the `codex` CLI.
 *
 * Pure on purpose, symmetric to `command.ts`: no spawn, no state, no clock. It
 * is the seam the conformance kit demands ("an adapter that does not expose that
 * seam is an adapter you cannot certify",
 * `docs/formatos/engine-adapter.md:363-366`), and keeping it side-effect free is
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

/** A command ready for `spawn`, with no shell in between. */
export interface EngineCommand {
  readonly command: string;
  readonly args: string[];
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
 * - **The composed argument is the LAST positional, never stdin.** Coherent
 *   with stdin closed, and it is what dodges the `<stdin>` block the CLI would
 *   otherwise append. `-m` (t166) therefore goes BEFORE it, like every other
 *   flag: a flag after the positional would either be read as part of the
 *   prompt or move the prompt out of last place, and one of those two is
 *   always true.
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
): EngineCommand {
  const model = resolveModel(spec, env);
  const { sandboxArgs } = resolveCodexPermissions(spec.permissions);

  return {
    command: CODEX_BINARY,
    args: [
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
      composeSingleArgument(spec),
    ],
  };
}

/**
 * The model this session pins, out of the node's own id and the work's tier.
 *
 * Same precedence as the first adapter's, for the same reason: `spec.model` is
 * what the GRAPH declared for this node (t166), `modelTier` is what the intake
 * said this work costs (t175), and a triage heuristic does not overrule a
 * decision somebody wrote into a graph document — quite apart from two `-m`
 * flags in one argv being a broken command.
 *
 * The difference from `command.ts` is the last line and it is the documented
 * gap: with no `CODEX_TRIVIAL_MODEL` there is nothing honest to return, so a
 * trivial tier resolves to `undefined` and this adapter changes nothing.
 *
 * @param spec The session being assembled.
 * @param env The adapter's own environment.
 * @returns The model id to pin, or `undefined` for the CLI's own default.
 */
function resolveModel(spec: SessionSpec, env: NodeJS.ProcessEnv): string | undefined {
  if (spec.model !== undefined) return spec.model;
  if (spec.modelTier !== 'trivial') return undefined;

  // Blank is unset: an empty `-m` would kill the session on a flag nobody typed.
  const declared = env[TRIVIAL_MODEL_VARIABLE]?.trim();
  return declared ? declared : undefined;
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
