/**
 * Building the command and the environment of a `shell` node (t332).
 *
 * Pure on purpose, symmetric to `command.ts` and `codex-command.ts`: no spawn,
 * no state, no clock. It is the seam the conformance kit demands ("an adapter
 * that does not expose that seam is an adapter you cannot certify",
 * `docs/formats/engine-adapter.md`), and keeping it side-effect free is what
 * lets both halves be checked by unit test without a process.
 *
 * What it does NOT contain is the interesting half. The other two modules are
 * almost entirely engine vocabulary — a binary name, a subcommand, six flags,
 * a permission mode variable — because their job is to translate a
 * `SessionSpec` into one CLI's dialect. There is no dialect here. The argv this
 * module hands over was written by whoever wrote the skill manifest, and the
 * only thing between them and `spawn` is the placeholder interpolation that
 * already happened one layer up. Two decisions are left, and both are this
 * file's:
 *
 * - **A missing command refuses, and refuses HERE.** A `shell` node whose skill
 *   declares no `command` block has nothing to run. Falling back to anything —
 *   the instructions, a no-op, an empty argv — would be a node that reports
 *   success for work nobody did. Because the refusal lives in the pure seam, it
 *   happens before the adapter has spawned anything at all.
 * - **The environment is closed by default** (FR4). `README.md` records, as a
 *   known and accepted risk, that an agent session "inherits your whole shell
 *   environment" through the other two `buildEnvironment`s. That is a
 *   compatibility decision about sessions that existed before the risk was
 *   written down; a shell node has no such history, so it starts from nothing
 *   and reads only what its manifest named. A skill therefore either spells an
 *   absolute path in `argv[0]` or allowlists `PATH` itself — which is a real
 *   constraint, and the honest price of not handing a subprocess every
 *   credential the operator happens to be carrying.
 */

import { SessionStartError, type SessionSpec } from './types.ts';

/** Stable identifier of this engine, on the session row and in a node's `engine`. */
export const SHELL_ENGINE_NAME = 'shell';

/**
 * `stdio` of the child: stdin on `/dev/null`, stdout and stderr piped.
 *
 * Invariant 6, inherited whole from the two adapters that made it normative. It
 * costs nothing here and buys the same thing: a command that reads stdin — a
 * `cat`, a `while read` loop, a CLI that prompts — would otherwise wait for an
 * EOF nobody is going to send, and the session would be lost to a default
 * instead of to anything the node did.
 */
export const ENGINE_STDIO = ['ignore', 'pipe', 'pipe'] as const;

/**
 * What a spec with nothing to run is told, prefix-shaped.
 *
 * Same discipline as the other adapters' refusal messages: a caller has to be
 * able to tell "the session did not come up" from "this session was never going
 * to come up, and here is the field to fix".
 */
export const MISSING_COMMAND_MESSAGE =
  'nothing to run: a node on the "shell" engine needs a `command.argv` on its skill ' +
  'manifest, and this session spec carries none — the manifest\'s `instructions` are ' +
  'documentation for whoever reads the registry, never the thing that executes';

/** A command ready for `spawn`, with no shell in between. */
export interface ShellCommand {
  readonly command: string;
  readonly args: string[];
}

/**
 * Splits the declared argv into the binary and its arguments.
 *
 * No quoting, no escaping, no `shell: true`, and no interpretation of any kind:
 * `argv[0]` is a path or a name the operating system resolves, and everything
 * after it is a literal argument. That is the whole difference between this
 * engine and running the same line through `sh -c`, and it is the reason a
 * skill can pass a file path with a space in it, or a JSON document, without
 * anybody having to think about quoting.
 *
 * @param spec The session being assembled.
 * @returns The binary and its arguments.
 * @throws {SessionStartError} The spec declares no command, or an empty argv.
 */
export function buildCommand(spec: SessionSpec): ShellCommand {
  const argv = spec.command?.argv;
  if (argv === undefined || argv.length === 0) {
    throw new SessionStartError(MISSING_COMMAND_MESSAGE);
  }

  const [command, ...args] = argv;
  if (command === undefined || command === '') {
    throw new SessionStartError(MISSING_COMMAND_MESSAGE);
  }

  return { command, args };
}

/**
 * Environment of the child: the allowlist read out of the base, with
 * `envOverrides` on top.
 *
 * Three properties, in the order they matter:
 *
 * - **the base is empty.** Not `process.env` minus a denylist — a denylist has
 *   to be right about every variable that exists, and an allowlist only has to
 *   be right about the ones the skill asked for.
 * - **an allowlisted name the runner does not carry contributes no key at all.**
 *   A present key holding `undefined` is not the same object as an absent one:
 *   `child_process` spreads it into the child's environ as an empty value, and
 *   an empty `PATH` behaves differently from an unset one.
 * - **`envOverrides` wins.** It is what the DISPATCH layered on for this one
 *   session; the operator's shell is the fallback, not the authority.
 *
 * @param spec The session being assembled.
 * @param base The runner's own environment.
 * @returns The environment the child process gets, whole.
 */
export function buildEnvironment(
  spec: SessionSpec,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};

  for (const name of spec.command?.envAllowlist ?? []) {
    const value = base[name];
    if (value !== undefined) inherited[name] = value;
  }

  return { ...inherited, ...spec.envOverrides };
}
