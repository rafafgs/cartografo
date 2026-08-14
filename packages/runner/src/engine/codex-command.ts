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
 *   otherwise append.
 */
export function buildCommand(spec: SessionSpec): EngineCommand {
  return {
    command: CODEX_BINARY,
    args: [
      CODEX_SUBCOMMAND,
      '--json',
      '--skip-git-repo-check',
      '-C',
      spec.workingDir,
      composeSingleArgument(spec),
    ],
  };
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
