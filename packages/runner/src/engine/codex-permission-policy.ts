/**
 * Resolving a `SessionPermissions` into what the `codex` engine can actually
 * enforce (t195).
 *
 * Pure and I/O free, the same seam `codex-command.ts` is: what it decides can
 * be checked by unit test, with no CLI installed and nothing authenticated.
 *
 * **Why this is not `permission-policy.ts`.** That module is deliberately
 * `claude-code` vocabulary — it names TOOLS (`WebFetch`, `Bash(curl *)`),
 * because that engine has no OS sandbox and gates by tool name. This one has
 * `-s, --sandbox`, a real sandbox tier of a different and stronger nature, and
 * the two classifications have no common ground to share: "no writes" over
 * there is a list of three tool names, over here it is an entire sandbox mode.
 * Merging them would mean one module holding two engines' answers to the same
 * question, which is exactly the coupling the `command.ts` /
 * `codex-command.ts` split already refused once. The duplication is real, it
 * is a decision, and it follows the precedent `codex-adapter.ts`'s own header
 * records for the process lifecycle.
 *
 * **Where the boundary falls, and why this file crosses it further than its
 * sibling does.** `permission-policy.ts` names no flag at all; this one hands
 * back argv fragments. The reason is that the classification and the spelling
 * are not separable here — "closed writes plus an open network" is refusable
 * only because no `-s` tier expresses it, so the policy question and the flag
 * question are one question. Splitting them would leave a module deciding
 * `read-only` without being allowed to say `read-only`.
 *
 * **Three outcomes, never two.** `pass-through` and `enforce` are the obvious
 * ones; `refuse` exists because the third honest answer to "enforce this" is
 * "I cannot". A session opened as if it could would be enforcing less than
 * what was declared — silently, which is the one outcome a permission system
 * may never produce.
 *
 * **Measured, not assumed** (`codex-cli 0.147.0`, 2026-08-16, via
 * `codex sandbox`, which resolves the same configuration `codex exec` does):
 *
 * | `sandbox_mode`    | `network_access` | write   | network |
 * |-------------------|------------------|---------|---------|
 * | `read-only`       | `false`          | blocked | blocked |
 * | `read-only`       | `true`           | blocked | blocked |
 * | `workspace-write` | `false`          | allowed | blocked |
 * | `workspace-write` | `true`           | allowed | allowed |
 *
 * Row two is the one that shapes this module: the override has NO effect under
 * `read-only`, so closed writes with an open network is not a combination this
 * CLI can be asked for, and it is refused rather than approximated.
 *
 * What this buys and what it does not: this is a real OS sandbox, so it is a
 * harder guarantee than the first adapter's tool-name gating — but it is still
 * "sandbox where the engine allows"
 * (`notas/2026-08-14-extension-and-quality.md:44-45`), bounded by what the
 * CLI's own `-s`/`-c` surface offers, and not process isolation this runner
 * built itself.
 */

import type { SessionPermissions } from './types.ts';

/**
 * Prefix of every refusal for a policy this engine cannot express.
 *
 * The identical literal `claude-code-adapter.ts` exports under the same name,
 * REDECLARED rather than imported. Sharing it would be the one import between
 * two adapter modules that otherwise know nothing about each other, and the
 * string is part of each adapter's own contract with its callers — not a
 * common asset either one owns.
 */
export const PERMISSION_REFUSAL_PREFIX = 'permission policy unsupported: ';

/** The one write scope this adapter can honour without narrowing anything. */
export const WHOLE_WORKSPACE = '**';

/** The sandbox tier that grants no writes. */
export const READ_ONLY_SANDBOX = 'read-only';

/** The sandbox tier that makes the working root writable. */
export const WORKSPACE_WRITE_SANDBOX = 'workspace-write';

/** The dotted config path that opens the network inside `workspace-write`. */
export const NETWORK_ACCESS_KEY = 'sandbox_workspace_write.network_access';

/** Refusal of a write scope narrower than the workspace. */
export const NARROW_WRITE_SCOPE_REASON =
  'write scope narrower than the whole workspace is not supported by the codex adapter — ' +
  'declare `escrita: []` or `escrita: ["**"]`';

/** Refusal of an allowlist per domain: the sandbox opens the network or closes it, whole. */
export const DOMAIN_SCOPED_NETWORK_REASON =
  'domain-scoped network allow is not supported by the codex adapter — ' +
  'declare `rede` without `dominios`, or `rede.permitido: false`';

/**
 * Refusal of the one combination that is not a per-axis limitation.
 *
 * Both halves are individually expressible — `escrita: []` is `read-only`,
 * `rede.permitido: true` is `network_access=true` — and TOGETHER they are not,
 * because the override only exists inside `workspace-write`. The message says
 * why in those terms rather than blaming one of the two axes, which would send
 * a founder to fix a field that is not the problem.
 */
export const CLOSED_WRITE_OPEN_NETWORK_REASON =
  'no codex sandbox mode combines closed writes with an open network — ' +
  'declare `escrita: ["**"]`, or `rede.permitido: false`';

/** What can be done with a declared policy. */
export type CodexPermissionOutcome = 'pass-through' | 'enforce' | 'refuse';

/** The reading of a whole declared policy: what to pass to the CLI, or why not. */
export interface CodexPermissionDecision {
  readonly outcome: CodexPermissionOutcome;
  /** argv fragment to splice in. Empty unless the outcome is `enforce`. */
  readonly sandboxArgs: readonly string[];
  /** The reason of EVERY refused axis — never only the first. */
  readonly refusals: readonly string[];
}

const PASS_THROUGH: CodexPermissionDecision = Object.freeze({
  outcome: 'pass-through',
  sandboxArgs: Object.freeze([]),
  refusals: Object.freeze([]),
});

/**
 * One axis, once read.
 *
 * Either it landed on one of the two ends (`open` set, `reason` null) or it
 * could not (`open` null, `reason` set). Never both, never neither.
 */
interface Axis {
  readonly open: boolean | null;
  readonly reason: string | null;
}

const opened = (open: boolean): Axis => ({ open, reason: null });
const refused = (reason: string): Axis => ({ open: null, reason });

/**
 * Reads the filesystem axis.
 *
 * Only the two ends are expressible: everything or nothing. The sandbox tiers
 * are whole-workspace grants, so a glob in between has nowhere to land —
 * `--add-dir` widens the writable set, it does not narrow it.
 */
function readFilesystem(filesystem: SessionPermissions['filesystem']): Axis {
  if (filesystem.write.length === 0) return opened(false);
  if (filesystem.write.length === 1 && filesystem.write[0] === WHOLE_WORKSPACE) {
    return opened(true);
  }
  return refused(NARROW_WRITE_SCOPE_REASON);
}

/**
 * Reads the network axis.
 *
 * A closed network IGNORES `dominios`, which is the manifest format's own rule
 * ("`rede.permitido: false` closes the network; `dominios` is ignored in that
 * case", `especificacoes/formatos/skill-manifest.md`). Refusing there would
 * turn the safest declaration into an error.
 */
function readNetwork(network: SessionPermissions['network']): Axis {
  if (!network.allowed) return opened(false);
  if (network.domains === undefined || network.domains.length === 0) return opened(true);
  return refused(DOMAIN_SCOPED_NETWORK_REASON);
}

/**
 * Reads a whole declared policy into the argv it becomes, or the reasons it
 * cannot become one.
 *
 * The two axes are read INDEPENDENTLY first, exactly as `resolvePermissions`
 * does for the first adapter, so refusals from both add up: a session rejected
 * for one reason, fixed, and rejected again for the other is a round trip that
 * helps nobody. Only once both axes came back clean does the cross-axis check
 * run — a combination can only be judged when there are two ends to combine.
 *
 * `danger-full-access` is unreachable from here by construction (FR8): the
 * only tiers this function can return are the two named above, and no input
 * selects a third.
 *
 * @param permissions The declared policy, or `undefined` for a session that
 *   declared none — which resolves to no flags and no refusals, the behaviour
 *   of every session opened before this field was read. That is what keeps the
 *   argv byte-identical to what it was for a spec that says nothing.
 * @returns The flags to splice into the argv, or the reasons to refuse.
 */
export function resolveCodexPermissions(
  permissions: SessionPermissions | undefined,
): CodexPermissionDecision {
  if (permissions === undefined) return PASS_THROUGH;

  const filesystem = readFilesystem(permissions.filesystem);
  const network = readNetwork(permissions.network);

  const refusals = [filesystem, network]
    .map((axis) => axis.reason)
    .filter((reason): reason is string => reason !== null);
  if (refusals.length > 0) return { outcome: 'refuse', sandboxArgs: [], refusals };

  // Both axes resolved, so `open` is set on both: the ends are the only thing
  // left to read.
  const writable = filesystem.open === true;
  const networked = network.open === true;

  // The measured gap: the override lives inside `workspace-write` and does
  // nothing under `read-only`, so this pair has no tier to land on.
  if (!writable && networked) {
    return { outcome: 'refuse', sandboxArgs: [], refusals: [CLOSED_WRITE_OPEN_NETWORK_REASON] };
  }

  if (!writable) return { outcome: 'enforce', sandboxArgs: ['-s', READ_ONLY_SANDBOX], refusals: [] };

  // The `-c` goes even when it repeats the CLI's own default, for the reason
  // `codex-command.ts`'s comments already give elsewhere: one code path, not
  // two, and determinism over an external default that could change under us.
  return {
    outcome: 'enforce',
    sandboxArgs: [
      '-s',
      WORKSPACE_WRITE_SANDBOX,
      '-c',
      `${NETWORK_ACCESS_KEY}=${networked ? 'true' : 'false'}`,
    ],
    refusals: [],
  };
}
