/**
 * Content address of a graph version (t101, FR3).
 *
 * `grafo_versao.id` is `sha256:` followed by the sha256 of the canonical JSON
 * serialization of the **whole** document — not of a subset. That is the
 * deliberate difference from the skill manifest hash
 * (`especificacoes/formatos/skill-manifest.md`), which only covers
 * `{instructions, input, output, checks, permissions}` because there catalogue
 * metadata must not invalidate the pin. Here the opposite holds: the snapshot of
 * a version is the whole document (`docs/spec/graph.md` §7), and changing the
 * graph description IS a new version.
 *
 * Canonicalizing is the part of RFC 8785 these formats use: keys sorted
 * recursively. Key order and JSON formatting carry no meaning in a graph
 * document — two documents differing only in that have to have the same hash, or
 * reordering a key would become a new version. Same function as
 * `scripts/validar-bundle-fabrica.mjs`.
 */

import { createHash } from 'node:crypto';

/** Algorithm prefix, explicit in the value (as in the skill pin, D4). */
export const HASH_PREFIX = 'sha256:';

/**
 * Sorts keys recursively.
 *
 * @param value Already parsed JSON value.
 * @returns The same value with every object rewritten in key order.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const original = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(original).sort()) {
      sorted[key] = canonicalize(original[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical serialization of the document — this is what goes to the `snapshot` column.
 *
 * @param document Already parsed graph document.
 * @returns JSON with sorted keys and no superfluous whitespace.
 */
export function canonicalSerialize(document: unknown): string {
  return JSON.stringify(canonicalize(document));
}

/**
 * Content hash of the snapshot.
 *
 * @param document Already parsed graph document.
 * @returns `sha256:` followed by 64 hex characters.
 */
export function hashSnapshot(document: unknown): string {
  const digest = createHash('sha256').update(canonicalSerialize(document), 'utf8').digest('hex');
  return `${HASH_PREFIX}${digest}`;
}

/**
 * Deduplication key of a proposal (t246, FR1 / D21).
 *
 * D21 asks that a repeated signal strengthen the pending proposal instead of
 * cloning it, and that needs a deterministic name for "the same signal". This is
 * it: the sha256 of the canonicalized `[lens, targetVersion, operations]` triple,
 * built exactly like {@link hashSnapshot} so that two structurally identical
 * diffs hash identically no matter what order their keys were written in.
 *
 * Three things about the triple, each a decision:
 *
 * - `graph_id` is deliberately absent. `targetVersion` is the content hash of ONE
 *   version of ONE graph, so it already scopes the key by itself.
 * - the **order** of `operations` is significant and is not normalized. Order
 *   decides which intermediate document is valid mid-apply, so collapsing it
 *   would conflate diffs that are not actually equivalent (FR7).
 * - `lens` is part of the key, so two DIFFERENT lenses that happen to propose
 *   byte-identical operations stay two proposals: the reasoning behind them is
 *   different evidence even when the resulting diff coincides. `null` is a bucket
 *   like any other, and it is where everything that declares no lens lands.
 *
 * @param lens Which lens is proposing, or `null` when the evidence names none.
 * @param targetVersion The `graph_version.id` the proposal is written against.
 * @param operations The semantic diff, in the order it was received.
 * @returns `sha256:` followed by 64 hex characters.
 */
export function proposalDedupeKey(
  lens: string | null,
  targetVersion: string,
  operations: unknown,
): string {
  const digest = createHash('sha256')
    .update(canonicalSerialize([lens, targetVersion, operations]), 'utf8')
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
}
