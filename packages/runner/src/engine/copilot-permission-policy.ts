/**
 * Resolving a `SessionPermissions` into what the `copilot` engine can actually
 * enforce (t675).
 *
 * Pure and I/O free, the same seam `copilot-command.ts` is, and symmetric to
 * `codex-permission-policy.ts`: same three outcomes, same refusal prefix, same
 * rule that an adapter which cannot express a policy refuses the session before
 * opening it and never enforces less than was asked (t195).
 *
 * **What this engine is not: a sandbox.** `codex` has `-s, --sandbox`, an OS
 * tier. `copilot` has only rules of its own — tool rules (`--allow-tool`,
 * `--deny-tool`), URL rules (`--allow-url`, `--deny-url`, `--allow-all-urls`)
 * and path verification (`--allow-all-paths`, `--add-dir`). Everything below is
 * TOOL-LEVEL GATING. It stops the model's own file tools and URL-aware tools
 * when they are asked to cross the line; it does not stop a program the model
 * runs through `shell`. Measured, not assumed (see the table): a `python3`
 * one-liner run by `shell` wrote a file outside the working directory under
 * `--deny-tool write`, and reached a loopback host under `--deny-tool url`
 * because the URL was assembled at run time. A founder who needs isolation
 * still has to run the runner somewhere that provides it.
 *
 * **Measured against `@github/copilot@1.0.95`, 2026-10-12**, with a local stub
 * provider (BYOK, `COPILOT_PROVIDER_BASE_URL`) that answers a scripted tool call
 * and a local HTTP target that counts its hits. Every row ran under
 * `--allow-all-tools --disable-builtin-mcps -C <dir>`, the base the adapter
 * always uses:
 *
 * | flags added                                  | tool call                    | result              |
 * |----------------------------------------------|------------------------------|---------------------|
 * | none                                         | shell `curl` of the target   | hit                 |
 * | `--deny-url '*'`                             | shell `curl` of the target   | HIT: accepted, no effect |
 * | `--deny-url '*'`                             | `web_fetch` of a public URL  | fetched: no effect  |
 * | `--deny-url '*://*'`                         | —                            | `Invalid URL pattern` |
 * | `--deny-url http://127.0.0.1:18082` (exact)  | shell `curl` of the target   | denied, no hit      |
 * | `--deny-url 127.0.0.1` (no protocol)         | shell `curl` of http target  | hit (defaults to https) |
 * | `--deny-tool url` (kind, argument omitted)   | shell `curl` of the target   | denied, no hit      |
 * | `--deny-tool url`                            | `web_fetch` of a public URL  | denied              |
 * | `--deny-tool url`                            | shell `python3` building URL | HIT: tool-level only |
 * | `--allow-url http://example.invalid`         | shell `curl` of the target   | hit: allow restricts nothing |
 * | `--allow-url <target> --deny-tool url`       | shell `curl` of the target   | denied: deny wins   |
 * | `--allow-url <target> --deny-url '*'`        | shell `curl` of the target   | hit (the glob is inert) |
 * | `--allow-all-urls`                           | shell `curl` of the target   | hit                 |
 * | none (path verification)                     | `create` outside `-C`        | denied              |
 * | none                                         | `create` inside `-C`         | created             |
 * | `--deny-tool write`                          | shell `echo x > <outside>`   | denied              |
 * | `--deny-tool write`                          | shell `python3` open(<outside>) | WRITTEN: tool-level only |
 *
 * What the table decides:
 *
 * - **Closed network is `--deny-tool url`, not `--deny-url '*'`.** The ticket
 *   named the glob and said to use it only if measured to work. It parses and
 *   does nothing, so it is not used. `copilot help permissions` documents the
 *   kind that works: "`url(domain-or-url?)` … If omitted, matches all URLs", and
 *   "Denial rules always take precedence over allow rules, even
 *   --allow-all-tools" — which is why it holds under `--allow-all-tools`.
 * - **A domain allowlist has no spelling, and is refused.** `--allow-url` alone
 *   restricts nothing under `--allow-all-tools` (the base of every session, and
 *   the flag non-interactive mode requires), and the only rule that closes the
 *   rest of the network also beats the allow. "Closed network plus these
 *   domains" is therefore not expressible, and approximating it with either half
 *   would be the silent less-than-asked this module exists to prevent.
 * - **Open network is `--allow-all-urls`.** Explicit, although under
 *   `--allow-all-tools` the CLI already let every URL through: determinism over
 *   an external default that could change under us, the reasoning
 *   `codex-command.ts` gives for its own explicit flag.
 * - **Whole-workspace write is NO path flag.** `copilot help permissions`: "By
 *   default, file access is restricted to paths within the current working
 *   directory and its subdirectories, plus the system temporary directory". The
 *   adapter passes `-C <workingDir>`, which is the workspace, so the CLI's own
 *   verification already confines its file tools there (a `create` outside it
 *   was denied above). `--allow-all-paths` ("Disable file path verification and
 *   allow access to any path") would undo that and is never emitted, nor is
 *   `--allow-all`/`--yolo`, which imply it. The system temporary directory stays
 *   reachable: `--disallow-temp-dir` exists, and is left off because builds and
 *   test runners write there and the policy language has no word for it.
 * - **A narrower write scope is refused, and so is an empty one.** The CLI has
 *   no per-path write allowlist to map a glob onto. The empty scope looks like
 *   the easy case ("deny every write tool") and is not: `shell` writes
 *   regardless of any `--deny-tool write` (last row), so "no writes" cannot be
 *   honoured and saying so beats pretending.
 */

import type { SessionPermissions } from './types.ts';

/**
 * Prefix of every refusal for a policy this engine cannot express.
 *
 * The identical literal the other two adapters export under the same name,
 * REDECLARED rather than imported: it is part of each adapter's own contract
 * with its callers, not a common asset either one owns.
 */
export const PERMISSION_REFUSAL_PREFIX = 'permission policy unsupported: ';

/** The one write scope this adapter can honour without narrowing anything. */
export const WHOLE_WORKSPACE = '**';

/**
 * The rule that closes every URL: the `url` tool kind with its argument omitted
 * ("If omitted, matches all URLs", `copilot help permissions`).
 */
export const CLOSED_NETWORK_FLAGS: readonly string[] = Object.freeze(['--deny-tool', 'url']);

/** The flag that lets every URL through. */
export const OPEN_NETWORK_FLAGS: readonly string[] = Object.freeze(['--allow-all-urls']);

/** Refusal of a write scope narrower than the workspace. */
export const NARROW_WRITE_SCOPE_REASON =
  'write scope narrower than the whole workspace is not supported by the copilot adapter — ' +
  'the CLI has no per-path write allowlist; declare `escrita: ["**"]`';

/** Refusal of an empty write scope: closing the write tools does not close `shell`. */
export const EMPTY_WRITE_SCOPE_REASON =
  'an empty write scope is not supported by the copilot adapter — `shell` can write ' +
  'regardless of any tool deny, so no writes cannot be enforced; declare `escrita: ["**"]`';

/** Refusal of an allowlist per domain: allow rules restrict nothing, and a deny beats them. */
export const DOMAIN_SCOPED_NETWORK_REASON =
  'domain-scoped network allow is not supported by the copilot adapter — `--allow-url` alone ' +
  'restricts nothing and the rule that closes the rest also beats it; ' +
  'declare `rede` without `dominios`, or `rede.permitido: false`';

/** What can be done with a declared policy. */
export type CopilotPermissionOutcome = 'pass-through' | 'enforce' | 'refuse';

/** The reading of a whole declared policy: what to pass to the CLI, or why not. */
export interface CopilotPermissionDecision {
  readonly outcome: CopilotPermissionOutcome;
  /** argv fragment to splice in. Empty unless the outcome is `enforce`. */
  readonly permissionArgs: readonly string[];
  /** The reason of EVERY refused axis — never only the first. */
  readonly refusals: readonly string[];
}

const PASS_THROUGH: CopilotPermissionDecision = Object.freeze({
  outcome: 'pass-through',
  permissionArgs: Object.freeze([]),
  refusals: Object.freeze([]),
});

/** The filesystem axis: only the whole workspace is expressible. */
function filesystemRefusal(filesystem: SessionPermissions['filesystem']): string | null {
  if (filesystem.write.length === 0) return EMPTY_WRITE_SCOPE_REASON;
  if (filesystem.write.length === 1 && filesystem.write[0] === WHOLE_WORKSPACE) return null;
  return NARROW_WRITE_SCOPE_REASON;
}

/**
 * The network axis.
 *
 * A closed network IGNORES `dominios`, which is the manifest format's own rule
 * ("`rede.permitido: false` closes the network; `dominios` is ignored in that
 * case"); refusing there would turn the safest declaration into an error.
 */
function networkRefusal(network: SessionPermissions['network']): string | null {
  if (!network.allowed) return null;
  if (network.domains === undefined || network.domains.length === 0) return null;
  return DOMAIN_SCOPED_NETWORK_REASON;
}

/**
 * Reads a whole declared policy into the argv it becomes, or the reasons it
 * cannot become one.
 *
 * The two axes are read INDEPENDENTLY first, so refusals from both add up (a
 * session rejected for one reason, fixed, and rejected again for the other is a
 * round trip that helps nobody). There is no cross-axis refusal as in the Codex
 * policy: the URL rules and the path rules are separate mechanisms here.
 *
 * @param permissions The declared policy, or `undefined` for a session that
 *   declared none — which resolves to no flags and no refusals, the argv of
 *   every session opened before the field was read.
 * @returns The flags to splice in, or the reasons to refuse.
 */
export function resolveCopilotPermissions(
  permissions: SessionPermissions | undefined,
): CopilotPermissionDecision {
  if (permissions === undefined) return PASS_THROUGH;

  const refusals = [
    filesystemRefusal(permissions.filesystem),
    networkRefusal(permissions.network),
  ].filter((reason): reason is string => reason !== null);
  if (refusals.length > 0) return { outcome: 'refuse', permissionArgs: [], refusals };

  return {
    outcome: 'enforce',
    permissionArgs: permissions.network.allowed ? OPEN_NETWORK_FLAGS : CLOSED_NETWORK_FLAGS,
    refusals: [],
  };
}
