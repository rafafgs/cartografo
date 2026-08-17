/**
 * Access to the `credential` table (t124, FR2).
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
 * touches the driver (D1). The COLUMNS are English since D20's fourth child
 * (t229); {@link CredentialRow}'s field names are not, because `src/auth.ts`
 * reads them and that file is outside that ticket's surface — so every `SELECT`
 * aliases the renamed column back onto the field (t229, FR4).
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** What a credential is for. `runner` is issued at pairing (t143, FR1). */
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

const COLUMNS =
  'id, owner_type AS tipo, runner_id, hash, created_at AS criada_em, revoked_at AS revogada_em';

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
    .prepare('INSERT INTO credential (owner_type, runner_id, hash, created_at) VALUES (?, ?, ?, ?)')
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
    .prepare(`SELECT ${COLUMNS} FROM credential WHERE hash = ? AND revoked_at IS NULL`)
    .get(hashToken(rawToken)) as CredentialRow | undefined;

  return found ?? null;
}

/**
 * Revokes every live credential of one runner (t143, FR4).
 *
 * A date and not a `DELETE`: "when did it stop being valid" is an audit question
 * a removed row cannot answer, and nothing in this system is ever deleted
 * (D15/D2). `verifyToken` already treats revoked and never-existed identically,
 * so the very next request of a killed token gets the same `401` as garbage.
 *
 * Plural by design, even though FR1 mints at most one per runner: what the
 * operator asks for is "this machine stops having access", and a sweep that
 * stopped at the first row would leave that promise depending on how many rows
 * happen to be there.
 *
 * @param db Open database.
 * @param runnerId Runner whose credentials die.
 * @returns How many rows THIS call revoked — zero when there was nothing live,
 *   which is a legitimate answer and not an error (the route is idempotent).
 */
export function revokeRunnerCredentials(db: Database, runnerId: string): number {
  const result = db
    .prepare(
      "UPDATE credential SET revoked_at = ? WHERE owner_type = 'runner' AND runner_id = ? AND revoked_at IS NULL",
    )
    .run(now(), runnerId);

  return result.changes;
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
    .prepare('SELECT 1 AS one FROM credential WHERE owner_type = ? AND revoked_at IS NULL LIMIT 1')
    .get(tipo) as { one: number } | undefined;
  return row !== undefined;
}
