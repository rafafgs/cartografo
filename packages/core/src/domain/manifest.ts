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
 * The field names are the skill-manifest format's own, and the D18 rename
 * explicitly leaves data-format keys out (`DECISOES.md:153-155`): the code
 * around them is English, the keys are not.
 */

import { createHash } from 'node:crypto';

import { canonicalize, HASH_PREFIX } from './hash.ts';

/** Fields every manifest declares (`required` of the t97 schema). */
export const MANIFEST_FIELDS = [
  'id',
  'versao',
  'hash',
  'papel',
  'descricao',
  'entrada',
  'saida',
  'pre_condicoes',
  'checks',
  'permissoes',
  'instrucoes',
  'origem',
];

/** `id` is kebab-case and unique in the registry. */
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `versao` is semver, three numeric parts. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** `hash` is the algorithm prefix plus 64 hex characters — the pin's shape (D4). */
export const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `papel`: produces an artifact, or checks another node's artifact. */
export const MANIFEST_ROLES = ['fazer', 'portao'];

/**
 * Content hash of a skill manifest, by the procedure of
 * `especificacoes/formatos/manifesto-skill.md`: sha256 of the canonical JSON of
 * `{instrucoes, entrada, saida, checks, permissoes}`.
 *
 * It covers only that subset — and not the whole manifest, as the graph version
 * hash does — because catalogue metadata (`id`, `versao`, `descricao`, `origem`)
 * must not invalidate a pin: renaming the skill does not change what it does.
 * The practical consequence at the import gate is worth stating: the reviewer's
 * signature (`origem.revisado_por`) lands OUTSIDE the hash, so signing an
 * approved manifest never invalidates the pin the reviewer just approved.
 *
 * @param manifest Already parsed manifest.
 * @returns `sha256:` followed by 64 hex characters.
 */
export function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instrucoes: manifest.instrucoes,
    entrada: manifest.entrada,
    saida: manifest.saida,
    checks: manifest.checks,
    permissoes: manifest.permissoes,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
}
