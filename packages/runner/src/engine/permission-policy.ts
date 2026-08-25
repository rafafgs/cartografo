/**
 * Resolving a `SessionPermissions` into what the `claude-code` engine can
 * actually enforce (t125, FR2).
 *
 * Pure and I/O free, the same seam `command.ts` is: what it decides can be
 * checked by unit test, with no CLI installed and nothing authenticated.
 *
 * **Where the boundary falls.** This module names TOOLS (`WebFetch`,
 * `Bash(curl *)`) and never a FLAG: assembling `--disallowedTools` is
 * `command.ts`'s business, and everything above the adapter keeps speaking only
 * `SessionPermissions` (boundary 1 of the specification). The middle ground is
 * deliberate — the classification of what is enforceable is policy, the
 * spelling of the argv is engine vocabulary, and putting the two in one file
 * would make the policy untestable without a command.
 *
 * **Three outcomes, never two.** `pass-through` and `enforce` are the obvious
 * ones; `refuse` exists because the third honest answer to "enforce this" is "I
 * cannot". An engine with no OS sandbox cannot scope network by domain nor
 * writing by path, and a session opened as if it could would be enforcing less
 * than what was declared — silently, which is the one outcome a permission
 * system may never produce.
 *
 * What this buys and what it does not: `Bash` remains a way out to the network
 * and to the disk that no list of names closes completely (the residual gap is
 * written down in `docs/formats/engine-adapter.md`, "The session's permissions").
 * This is best-effort in what the engine offers — "sandbox where the engine
 * allows" (`notes/2026-08-14-extension-and-quality.md:44-45`) — not process
 * isolation.
 */

import type { SessionPermissions } from './types.ts';

/** What can be done with one axis of a declared policy. */
export type PermissionOutcome = 'pass-through' | 'enforce' | 'refuse';

/** The reading of one axis: what to deny, or why it cannot be honoured. */
export interface PermissionDecision {
  readonly outcome: PermissionOutcome;
  /** Tool entries to deny. Empty unless the outcome is `enforce`. */
  readonly deniedTools: readonly string[];
  /** Why the policy cannot be expressed. `null` unless the outcome is `refuse`. */
  readonly reason: string | null;
}

/**
 * The network tools denied when the policy closes the network.
 *
 * Two native ones plus the shell utilities that are the usual way out. The list
 * is deliberately short and boring: every entry has to be a name the engine
 * recognizes, and a longer list of guesses would buy the illusion of coverage
 * without buying coverage.
 */
export const NETWORK_TOOLS: readonly string[] = Object.freeze([
  'WebFetch',
  'WebSearch',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(nc *)',
  'Bash(netcat *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(telnet *)',
]);

/** The tools denied when the policy grants no writing at all. */
export const WRITE_TOOLS: readonly string[] = Object.freeze(['Edit', 'Write', 'NotebookEdit']);

/** The one write scope this adapter can honour without narrowing anything. */
export const WHOLE_WORKSPACE = '**';

/** Refusal of an allowlist per domain: it would take an egress proxy. */
export const DOMAIN_SCOPED_NETWORK_REASON =
  'domain-scoped network allow is not supported by the claude-code adapter — ' +
  'declare `rede` without `dominios`, or `rede.permitido: false`';

/** Refusal of a write scope narrower than the workspace. */
export const NARROW_WRITE_SCOPE_REASON =
  'write scope narrower than the whole workspace is not supported by the claude-code adapter — ' +
  'declare `escrita: []` or `escrita: ["**"]`';

const PASS_THROUGH: PermissionDecision = Object.freeze({
  outcome: 'pass-through',
  deniedTools: Object.freeze([]),
  reason: null,
});

const enforce = (deniedTools: readonly string[]): PermissionDecision => ({
  outcome: 'enforce',
  deniedTools,
  reason: null,
});

const refuse = (reason: string): PermissionDecision => ({
  outcome: 'refuse',
  deniedTools: Object.freeze([]),
  reason,
});

/**
 * Reads the network axis.
 *
 * A closed network IGNORES `dominios`, which is the manifest format's own rule
 * ("`rede.permitido: false` closes the network; `dominios` is ignored in that
 * case", `specs/formats/skill-manifest.md`). Refusing there would
 * turn the safest declaration into an error.
 *
 * @param network The network half of the declared policy.
 * @returns What to deny, or why it cannot be honoured.
 */
export function resolveNetworkPolicy(
  network: SessionPermissions['network'],
): PermissionDecision {
  if (!network.allowed) return enforce(NETWORK_TOOLS);
  if (network.domains === undefined || network.domains.length === 0) return PASS_THROUGH;
  return refuse(DOMAIN_SCOPED_NETWORK_REASON);
}

/**
 * Reads the filesystem axis.
 *
 * Only the two ends are expressible: everything or nothing. A glob in between
 * would have to become a fine-grained tool rule, and there is no honest
 * translation — `Bash` alone writes anywhere the process can reach.
 *
 * @param filesystem The filesystem half of the declared policy.
 * @returns What to deny, or why it cannot be honoured.
 */
export function resolveFilesystemPolicy(
  filesystem: SessionPermissions['filesystem'],
): PermissionDecision {
  if (filesystem.write.length === 0) return enforce(WRITE_TOOLS);
  if (filesystem.write.length === 1 && filesystem.write[0] === WHOLE_WORKSPACE) {
    return PASS_THROUGH;
  }
  return refuse(NARROW_WRITE_SCOPE_REASON);
}

/** Both axes of one session, already read. */
export interface ResolvedPermissions {
  /** Everything to deny, filesystem first, then network. */
  readonly deniedTools: readonly string[];
  /** The reason of EVERY refused axis — never only the first. */
  readonly refusals: readonly string[];
}

const NOTHING_RESOLVED: ResolvedPermissions = Object.freeze({
  deniedTools: Object.freeze([]),
  refusals: Object.freeze([]),
});

/**
 * Reads a whole declared policy, axis by axis.
 *
 * The refusals ADD UP on purpose (FR3): a session rejected for one reason,
 * fixed, and rejected again for the other is a round trip that helps nobody.
 *
 * @param permissions The declared policy, or `undefined` for a session that
 *   declared none — which resolves to nothing denied and nothing refused, the
 *   behaviour of every session opened before the field existed.
 * @returns The tools to deny and the reasons to refuse.
 */
export function resolvePermissions(
  permissions: SessionPermissions | undefined,
): ResolvedPermissions {
  if (permissions === undefined) return NOTHING_RESOLVED;

  const decisions = [
    resolveFilesystemPolicy(permissions.filesystem),
    resolveNetworkPolicy(permissions.network),
  ];

  return {
    deniedTools: decisions.flatMap((decision) => [...decision.deniedTools]),
    refusals: decisions
      .map((decision) => decision.reason)
      .filter((reason): reason is string => reason !== null),
  };
}

/**
 * Which resource a denied entry answers for — the `dados.recurso` of the
 * telemetry event.
 *
 * Returns `null` for anything this adapter did not deny, instead of guessing.
 * That is what keeps the denial log free of invention: a tool error unrelated
 * to the policy has no resource to be filed under, and filing it anyway would
 * make the log answer a question it was never asked.
 *
 * @param entry A denied tool entry, as it was handed to the engine.
 * @returns The resource, or `null` when the entry is not one of ours.
 */
export function resourceOfDeniedTool(entry: string): 'filesystem' | 'rede' | null {
  if (WRITE_TOOLS.includes(entry)) return 'filesystem';
  if (NETWORK_TOOLS.includes(entry)) return 'rede';
  return null;
}
