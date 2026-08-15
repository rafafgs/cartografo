/**
 * Skill manifest: the field vocabulary and the content hash (t117, FR2).
 *
 * This module exists because the same procedure now has TWO callers that must
 * never disagree: the bundle check of `cartografo import` (which refuses a
 * broken pin before anything is sent over the network) and the registry's own
 * validator (which re-verifies the pin at registration, D4). Two copies of a
 * hash procedure is two hashes waiting to drift, and a pin that can drift is not
 * a pin.
 *
 * Nothing here reaches the database or the network — it is pure computation over
 * an already-parsed manifest, which is what lets the CLI (an unprivileged HTTP
 * client, D1/D11) and the control plane share it without sharing anything else.
 *
 * The field names are the skill-manifest format's own, and they are English
 * since the 2026-08-15 amendment to D18 (`DECISOES.md`, D18 amendment): the
 * original decision carved data-format keys out of the rename, and that
 * amendment closed the gap. `packages/core/test/domain-manifest-fields.test.ts`
 * pins the list below against the schema's own `required`, so the port cannot
 * drift from the format it ports.
 */

import { createHash } from 'node:crypto';

import { canonicalize, HASH_PREFIX } from './hash.ts';

/** Fields every manifest declares (`required` of the t97 schema). */
export const MANIFEST_FIELDS = [
  'id',
  'version',
  'hash',
  'role',
  'description',
  'input',
  'output',
  'preconditions',
  'checks',
  'permissions',
  'instructions',
  'origin',
];

/** `id` is kebab-case and unique in the registry. */
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `version` is semver, three numeric parts. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** `hash` is the algorithm prefix plus 64 hex characters — the pin's shape (D4). */
export const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `role`: produces an artifact, or checks another node's artifact. */
export const MANIFEST_ROLES = ['work', 'gate'];

/**
 * Content hash of a skill manifest, by the procedure of
 * `especificacoes/formatos/manifesto-skill.md`: sha256 of the canonical JSON of
 * `{instructions, input, output, checks, permissions, budgets}`.
 *
 * It covers only that subset — and not the whole manifest, as the graph version
 * hash does — because catalogue metadata (`id`, `version`, `description`,
 * `origin`) must not invalidate a pin: renaming the skill does not change what
 * it does. The practical consequence at the import gate is worth stating: the
 * reviewer's signature (`origin.reviewed_by`) lands OUTSIDE the hash, so signing
 * an approved manifest never invalidates the pin the reviewer just approved.
 *
 * `budgets` joined the subset in t163 for the reason `permissions` was always in
 * it: a watchdog budget is a declaration of behaviour, and behaviour may not
 * move without the pin moving with it. Growing the subset costs nothing to the
 * manifests already registered — an absent key serializes to nothing, because
 * `JSON.stringify` drops a key whose value is `undefined` — so only a manifest
 * that actually declares budgets gets a different hash than it had.
 *
 * The KEY NAMES are part of what is hashed, so t178's rename moved every pin in
 * the repository at once. That is the mechanical, expected consequence of
 * renaming a key in a content-addressed format, and the reason every hash in
 * both factory bundles was recomputed in the same commit.
 *
 * @param manifest Already parsed manifest.
 * @returns `sha256:` followed by 64 hex characters.
 */
export function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
}
