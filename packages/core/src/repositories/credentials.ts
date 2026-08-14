/**
 * Access to the `credencial` table (t124, FR2).
 *
 * Two functions, and the asymmetry between them IS the design: issuing is the
 * only moment the raw token exists, and verifying never sees a stored one. What
 * goes to disk is the SHA-256 digest, so the answer to "what is the token of
 * credential 3?" is, and stays, "nobody knows anymore".
 *
 * Hashing and not a slow KDF: these are 32 random bytes, not a password someone
 * chose. A KDF buys resistance to guessing, and there is nothing here to guess.
 *
 * Like the other repositories, it receives the already-open database and never
 * touches the driver (D1). The row's field names mirror the untouched migration
 * columns, so they stay in Portuguese (t127, FR8).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** What a credential is for. `runner` is issued at pairing — the next ticket. */
export type CredentialType = 'usuario' | 'runner';

/** A credential, as the table holds it — the raw token is not part of it. */
export interface CredentialRow {
  id: number;
  tipo: CredentialType;
  runner_id: string | null;
  hash: string;
  criada_em: string;
  revogada_em: string | null;
}

/** The one and only time the raw token is available. */
export interface IssuedCredential {
  id: number;
  /**
   * The raw token, to be handed to whoever will present it. It is NOT stored:
   * losing it means issuing another one, never recovering this one.
   */
  token: string;
}

const COLUMNS = 'id, tipo, runner_id, hash, criada_em, revogada_em';

/** Bytes of entropy per token. 32 is the size of the digest that hides it. */
const TOKEN_BYTES = 32;

/**
 * The stored form of a token.
 *
 * @param rawToken Token as it travels in the `Authorization` header.
 * @returns SHA-256 digest, in lowercase hex.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Mints a credential and returns the raw token exactly once.
 *
 * @param db Open database.
 * @param data Type and, for a runner credential, the runner it belongs to.
 * @returns The id of the row and the raw token — which this call is the last
 *   place in the system to see.
 */
export function issueCredential(
  db: Database,
  data: { tipo: CredentialType; runnerId?: string | null },
): IssuedCredential {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const result = db
    .prepare('INSERT INTO credencial (tipo, runner_id, hash, criada_em) VALUES (?, ?, ?, ?)')
    .run(data.tipo, data.runnerId ?? null, hashToken(token), now());

  return { id: Number(result.lastInsertRowid), token };
}

/**
 * Resolves a presented token into the credential behind it.
 *
 * A revoked credential resolves to `null`, exactly like one that never existed:
 * from the caller's side "this no longer works" and "this never worked" are the
 * same refusal, and telling them apart would only help whoever is guessing.
 *
 * The lookup is by digest, not by scanning and comparing: the token itself is
 * never compared to anything, because there is nothing stored to compare it to.
 *
 * @param db Open database.
 * @param rawToken Token as it came on the wire.
 * @returns The live credential, or `null`.
 */
export function verifyToken(db: Database, rawToken: string): CredentialRow | null {
  if (rawToken === '') return null;

  const found = db
    .prepare(`SELECT ${COLUMNS} FROM credencial WHERE hash = ? AND revogada_em IS NULL`)
    .get(hashToken(rawToken)) as CredentialRow | undefined;

  return found ?? null;
}

/**
 * Is there a live credential of this type?
 *
 * It is what the startup asks before minting the bootstrap credential (FR4):
 * the answer decides between "print the token" and "print `null`", and it has
 * to be a question about the DATABASE, not about the process — otherwise every
 * restart would mint one more.
 *
 * @param db Open database.
 * @param tipo Type to look for.
 * @returns `true` when at least one non-revoked credential of that type exists.
 */
export function hasLiveCredential(db: Database, tipo: CredentialType): boolean {
  const row = db
    .prepare('SELECT 1 AS one FROM credencial WHERE tipo = ? AND revogada_em IS NULL LIMIT 1')
    .get(tipo) as { one: number } | undefined;
  return row !== undefined;
}
