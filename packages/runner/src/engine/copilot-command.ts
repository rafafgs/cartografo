/**
 * Building the command and the environment of the `copilot` CLI (t675).
 *
 * Pure on purpose, symmetric to `codex-command.ts`: no spawn, no state, no
 * clock, no randomness. It is the seam the conformance kit demands ("an adapter
 * that does not expose that seam is an adapter you cannot certify",
 * `docs/formats/engine-adapter.md`), and keeping it side-effect free is what
 * lets the argv be checked by unit test without the CLI and without a login.
 * The engine ref is therefore a PARAMETER: the adapter generates the UUID, and
 * `SessionSpec` is frozen v1, so the id cannot ride on it.
 *
 * Every fact below was measured against `@github/copilot@1.0.95` on 2026-10-12
 * (`npx -y @github/copilot@1.0.95`, binary `copilot`), by `copilot --help`,
 * `copilot help environment` / `permissions` / `providers`, and real headless
 * runs against a local stub provider (BYOK) — the credential-free path, since a
 * run against GitHub's own routing is refused on the founder's account.
 */

import { resolveCopilotPermissions } from './copilot-permission-policy.ts';
import { composeSingleArgument, type SessionSpec } from './types.ts';

/** The headless binary. Headless is a FLAG here (`-p`), not a subcommand. */
export const COPILOT_BINARY = 'copilot';

/**
 * `stdio` of the engine process: stdin on `/dev/null`, stdout and stderr piped.
 *
 * Invariant 6, exactly as for Codex: a piped stdin is a PROMPT SOURCE for this
 * CLI too. Measured: with no `-p`, piped text is the whole prompt (a 300 KB
 * payload arrived byte for byte); with `-p`, stdin is ignored.
 */
export const ENGINE_STDIO = ['ignore', 'pipe', 'pipe'] as const;

/**
 * The variable that names the model a `modelTier: 'trivial'` session runs on.
 *
 * No default beside it, for the reason `codex-command.ts` gives: nothing in
 * this repository establishes which model is the cheap one on a given
 * subscription, and a guessed identifier kills the session on an unknown model.
 * `--model auto` ("lets Copilot route") is NOT a default either: the runner
 * could no longer say which model a session ran on. Unset, the tier is recorded
 * on the job by the control plane and changes nothing here, and the test proves
 * it rather than assuming it.
 */
export const TRIVIAL_MODEL_VARIABLE = 'COPILOT_TRIVIAL_MODEL';

/**
 * Combined `instructions` + `prompt` byte size past which the composition
 * leaves the argv for stdin, off Windows.
 *
 * The same 64 KiB the other two adapters take, DUPLICATED for the reason their
 * headers record, and counted in bytes (an accented character is two bytes to
 * the kernel and one unit to JavaScript). It is what the kit's C11 asks for: a
 * channel off the argv, because Linux caps one argument at 128 KiB.
 */
export const ARGV_INLINE_LIMIT_POSIX_BYTES = 64 * 1024;

/**
 * The same limit on Windows (t684): `CreateProcess` caps the WHOLE command line
 * at 32,767 UTF-16 units, so a prompt of 30–64 KiB that was inlined made the
 * spawn fail. 12 KiB leaves room for the other flags and the working directory,
 * and it is conservative on purpose: bytes are always at least the unit count.
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
   * not fit in the argv. Absent means stdin stays closed (invariant 6).
   */
  readonly stdin?: string;
}

/**
 * Variables this adapter refuses to hand the engine, whoever set them.
 *
 * `CARTOGRAFO_TOKEN` (t684): the control plane's own credential. A worker has
 * no use for it and a model-driven session could print it; it is removed from
 * the base environment and from a node's `envOverrides` alike. The engine's own
 * credentials (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) are not on
 * this list.
 *
 * `COPILOT_ALLOW_ALL` (`copilot help environment`): exactly `true` "additionally
 * trusts the working directory and loads its hooks". The adapter says "no
 * prompts" with the `--allow-all-tools` FLAG and never with this variable,
 * because the variable grants more than the adapter ever asked for: a hook in a
 * repository a node works on would then run.
 */
const FORBIDDEN_VARIABLES = ['COPILOT_ALLOW_ALL', 'CARTOGRAFO_TOKEN'] as const;

/**
 * Assembles the argv of the headless session.
 *
 * ```
 * copilot -p <composed> --output-format json --allow-all-tools --disable-builtin-mcps
 *         --no-custom-instructions --no-ask-user
 *         --log-level none -C <workingDir> --session-id <engineRef>
 *         [--model <m>] [permission flags]
 * ```
 *
 * - **`-p <text>`** — "Execute a prompt in non-interactive mode (exits after
 *   completion)". The composition is `composeSingleArgument`, the
 *   specification's own function: there is NO system-prompt flag, and the
 *   alternatives (`--agent`, `init`) write files into the repository.
 * - **`--output-format json`** — JSONL, one object per line with a `type`.
 * - **`--allow-all-tools`** — "required for non-interactive mode"; a flag and
 *   never `COPILOT_ALLOW_ALL`.
 * - **`--disable-builtin-mcps`** — otherwise `github-mcp-server` and `githubiq`
 *   load into every session.
 * - **`--no-custom-instructions`** (t684) — the CLI would otherwise load
 *   `AGENTS.md` and the related repository instructions into the session, on top
 *   of the instructions the runner injected from the database.
 * - **`--no-ask-user`** (t684) — otherwise the model is offered the `ask_user`
 *   tool, which blocks a headless session on an answer nobody can give. A
 *   question goes through the `input-request` block instead.
 * - **`--log-level none`** — logs otherwise go to `~/.copilot/logs/`; measured,
 *   the per-process log file is created empty.
 * - **`-C <dir>`** — the working directory, which the CLI's path verification
 *   then treats as the workspace.
 * - **`--session-id <uuid>`** — "set the UUID for a new session". The stream has
 *   NO start frame (the id appears only in the final `result`), so the adapter
 *   chooses the id and reports it the moment the process is up.
 *
 * Two decisions beyond the plain shape, both measured:
 *
 * - **A composition that starts with `-` is joined to the flag, `-p=<text>`.**
 *   `copilot -p "-1 apples"` answers `error: Invalid command format.` and never
 *   opens, while `-p=-1 apples` delivers the text intact. Instructions are
 *   prose somebody else wrote, so a bullet list or a `---` line starting the
 *   text is ordinary. Still ONE argv element carrying the whole composition.
 * - **Past {@link argvInlineLimitBytes} the composition goes to stdin and
 *   `-p` goes away with it**: with no `-p`, piped stdin IS the prompt, and with
 *   `-p` it would be ignored — the two halves are one move. The kit's C11
 *   certifies that some channel off the argv exists.
 *
 * The permission flags come last and are spelled by
 * `copilot-permission-policy.ts`, resolved HERE a second time on the same spec
 * the adapter already asked about, so this function's argv depends on nothing
 * having run first. A refused policy adds nothing: the session was already
 * refused before this ran.
 *
 * @param spec The session being assembled.
 * @param engineRef The UUID the adapter generated for this session.
 * @param env The adapter's own environment (only {@link TRIVIAL_MODEL_VARIABLE}
 *   is read).
 * @param platform The platform whose command-line ceiling applies. Default
 *   `process.platform`.
 */
export function buildCommand(
  spec: SessionSpec,
  engineRef: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EngineCommand {
  const model = resolveModel(spec, env);
  const { permissionArgs } = resolveCopilotPermissions(spec.permissions);
  const composed = composeSingleArgument(spec);
  const inline =
    Buffer.byteLength(spec.instructions, 'utf8') + Buffer.byteLength(spec.prompt, 'utf8') <
    argvInlineLimitBytes(platform);

  const prompt = !inline ? [] : composed.startsWith('-') ? [`-p=${composed}`] : ['-p', composed];

  const args = [
    ...prompt,
    '--output-format',
    'json',
    '--allow-all-tools',
    '--disable-builtin-mcps',
    '--no-custom-instructions',
    '--no-ask-user',
    '--log-level',
    'none',
    '-C',
    spec.workingDir,
    '--session-id',
    engineRef,
    ...(model === undefined ? [] : ['--model', model]),
    ...permissionArgs,
  ];

  return inline ? { command: COPILOT_BINARY, args } : { command: COPILOT_BINARY, args, stdin: composed };
}

/**
 * The model this session pins: the node's own pin, else the tier's override.
 *
 * `spec.model` is what the GRAPH declared for the node and a triage heuristic
 * does not overrule it; a trivial tier resolves to `undefined` without
 * {@link TRIVIAL_MODEL_VARIABLE}, and a blank value is unset (an empty
 * `--model` would kill the session on a flag nobody typed).
 */
function resolveModel(spec: SessionSpec, env: NodeJS.ProcessEnv): string | undefined {
  if (spec.model !== undefined) return spec.model;
  if (spec.modelTier !== 'trivial') return undefined;

  const declared = env[TRIVIAL_MODEL_VARIABLE]?.trim();
  return declared ? declared : undefined;
}

/**
 * Environment of the engine process: the base, then `envOverrides`, then the
 * two settings a node may not change.
 *
 * - `COPILOT_AUTO_UPDATE=false`: the CLI self-updates outside CI, and a runner
 *   must never change engine version in the middle of a wave.
 * - `COPILOT_ALLOW_ALL` and `CARTOGRAFO_TOKEN` removed (see
 *   {@link FORBIDDEN_VARIABLES}).
 *
 * Credentials — `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, in that
 * precedence — ride along in the base untouched: this function neither reads,
 * copies nor logs their values. `COPILOT_HOME` is left alone unless an override
 * carries it.
 */
export function buildEnvironment(
  spec: SessionSpec,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, ...spec.envOverrides, COPILOT_AUTO_UPDATE: 'false' };
  for (const name of FORBIDDEN_VARIABLES) delete environment[name];
  return environment;
}

/** The preflight: `copilot --version` answers without network and spends no quota. */
export function buildProbeCommand(): EngineCommand {
  return { command: COPILOT_BINARY, args: ['--version'] };
}
