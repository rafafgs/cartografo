/**
 * Content address of a graph version (t101, FR3).
 *
 * `grafo_versao.id` is `sha256:` followed by the sha256 of the canonical JSON
 * serialization of the **whole** document — not of a subset. That is the
 * deliberate difference from the skill manifest hash
 * (`especificacoes/formatos/manifesto-skill.md`), which only covers
 * `{instrucoes, entrada, saida, checks, permissoes}` because there catalogue
 * metadata must not invalidate the pin. Here the opposite holds: the snapshot of
 * a version is the whole document (`docs/spec/grafo.md` §7), and changing the
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
