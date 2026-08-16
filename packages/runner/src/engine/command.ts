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
 * `--resume` (t173) obeys the same ordering discipline, for the same reason
 * read from the other end: it goes BEFORE the denied list and before the
 * system-prompt trailer, because both of those swallow what follows them. A ref
 * landing inside either would arrive as a denied tool or as part of the prompt,
 * and the CLI would open a fresh session without anybody being told.
 */
export function buildCommand(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv = process.env,
): EngineCommand {
  const { deniedTools } = resolvePermissions(spec.permissions);

  return {
    command: CLAUDE_BINARY,
    args: [
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
      // Absent policy, absent flag: a session that declared nothing produces
      // exactly the argv it produced before this field existed.
      ...(deniedTools.length === 0 ? [] : [DISALLOWED_TOOLS_FLAG, ...deniedTools]),
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
