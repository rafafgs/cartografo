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
 * Where the policy *should* come from is a recorded and still open tension: the
 * v0 `SessionSpec` has nowhere to express it, and when D4 leaves the page
 * (permissions declared in the skill manifest, pinned by hash) exactly this
 * field will be missing (`docs/formatos/engine-adapter.md:515-532`). Until
 * then the default belongs to the adapter, and the only override is the
 * variable below.
 */
export const DEFAULT_PERMISSION_MODE = 'bypassPermissions';

/**
 * The one permission-mode override, read from the ADAPTER'S OWN environment.
 *
 * Deliberately neither a `SessionSpec` field nor an `envOverrides` key: no
 * engine configuration may come from above the adapter's boundary while D4 has
 * not decided who answers for the policy.
 */
export const PERMISSION_MODE_VARIABLE = 'CLAUDE_PERMISSION_MODE';

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

/** A command ready for `spawn`, with no shell in between. */
export interface EngineCommand {
  readonly command: string;
  readonly args: string[];
}

/** The permission mode in force: the environment variable, or the default. */
export function resolvePermissionMode(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env[PERMISSION_MODE_VARIABLE]?.trim();
  return declared ? declared : DEFAULT_PERMISSION_MODE;
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
 */
export function buildCommand(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv = process.env,
): EngineCommand {
  return {
    command: CLAUDE_BINARY,
    args: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      resolvePermissionMode(env),
      ...composeWithSystemPromptFlag(spec),
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
