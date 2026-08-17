/**
 * Access to `segredo_gancho` — the key a hook REFERENCES (t194).
 *
 * Sibling of `src/repositories/webhooks.ts` in posture and of
 * `src/repositories/hooks.ts` in subject: a hook is declared by the graph
 * document, but its key is not, because a document that carries a credential is
 * a credential every reader of the document has. The document names it; this
 * module holds it.
 *
 * Three decisions are worth knowing before reading the code:
 *
 * - **The value leaves this module exactly once, and only downwards.** The
 *   public view (`HookSecret`) has no field for it, so no route can leak it by
 *   accident; the only reader is `resolveHookSecret`, which hands it to the
 *   enqueue. That is a stronger guarantee than remembering to strip a field in
 *   every response — the same one `Subscription` gives for
 *   `assinatura_webhook.segredo`.
 * - **Rotating writes a row; it never rewrites one.** `setHookSecret` revokes
 *   the live row and inserts a new one, in one transaction. `UPDATE valor`
 *   would erase the answer to "when did the old key stop being valid", which is
 *   the audit question the whole append-only discipline exists for (D15/D2).
 *   The migration's partial unique index is what makes "at most one live row per
 *   name" a property of the schema rather than of this file.
 * - **An unknown name and a revoked name are the same answer.** `undefined`,
 *   both times, for the same reason `verifyToken` refuses a revoked credential
 *   exactly like an unknown one: from the caller's side "this no longer works"
 *   and "this never worked" are one outcome.
 *
 * The value is stored in the clear, not hashed. That is not an oversight and
 * not a weaker posture than `credencial`: the signature is an HMAC, so the key
 * has to be REUSED on every delivery and a digest could never produce one. It is
 * exactly what `assinatura_webhook.segredo` does, and this ticket moves where
 * the key lives, not how it is kept.
 *
 * `now` is injectable (default: the real clock), like every other repository
 * here.
 *
 * The row field names mirror the migration's columns, so they stay in
 * Portuguese (t127, FR8).
 */

import type { Database } from '../db/connection.ts';
import { now } from './common.ts';

/** Injectable clock; without it, the real one. */
export interface ClockOptions {
  now?: () => string;
}

/**
 * A registration as the API shows it — deliberately without the value.
 *
 * This type IS the wire (t226, FR1): nothing inside the package reads it, so
 * there is no second, Portuguese projection to keep beside it. The COLUMNS it
 * comes from are still `nome`/`criada_em`/`revogada_em`, and `toHookSecret` is
 * where the two meet.
 */
export interface HookSecret {
  /** The name a hook's `destination.secret_ref` points at. */
  name: string;
  created_at: string;
  /** When this registration stopped being the live one; `null` while it is. */
  revoked_at: string | null;
}

/** The row as SQLite returns it, spelled by the untouched migration. */
interface HookSecretRow {
  nome: string;
  criada_em: string;
  revogada_em: string | null;
}

/** Row to wire: the one place the column names meet the API's. */
export function toHookSecret(row: HookSecretRow): HookSecret {
  return { name: row.nome, created_at: row.criada_em, revoked_at: row.revogada_em };
}

/** What the caller declares when registering or rotating a secret. */
export interface NewHookSecret {
  /** The name, as the route read it off the path (already validated). */
  nome: string;
  /** The raw HMAC key. Supplied by the caller; the server never generates one. */
  valor: string;
}

/** The registration that was just written, and whether the name is new. */
export interface RegisteredHookSecret {
  secret: HookSecret;
  /**
   * `true` when the name already had a registration — what makes the route
   * answer `200` instead of `201`.
   *
   * The question is "did this name ever exist", not "was one live": a name that
   * was registered and then revoked is still a resource `GET /v1/hook-secrets`
   * lists, so registering under it again is a rotation of that resource and not
   * the creation of a new one.
   */
  rotated: boolean;
}

/** Every column of the registration EXCEPT the value. */
const COLUMNS = 'nome, criada_em, revogada_em';

/**
 * Registers a secret under `nome`, revoking whatever was live there.
 *
 * Both writes are one transaction because they are one fact: "this name means
 * something else from now on". Doing them apart would leave a window with two
 * live rows — which the partial unique index refuses outright — or with none,
 * during which every hook pointing at the name would silently stop firing.
 *
 * @param db Open database.
 * @param data Name and raw value, already validated.
 * @param options Injectable clock.
 * @returns The registration, without the value, plus whether it was a rotation.
 */
export function setHookSecret(
  db: Database,
  data: NewHookSecret,
  options: ClockOptions = {},
): RegisteredHookSecret {
  const clock = options.now ?? now;

  return db.transaction((): RegisteredHookSecret => {
    const existing = db
      .prepare('SELECT 1 AS one FROM segredo_gancho WHERE nome = ? LIMIT 1')
      .get(data.nome) as { one: number } | undefined;

    const moment = clock();
    db.prepare(
      'UPDATE segredo_gancho SET revogada_em = ? WHERE nome = ? AND revogada_em IS NULL',
    ).run(moment, data.nome);
    db.prepare(
      'INSERT INTO segredo_gancho (nome, valor, criada_em) VALUES (?, ?, ?)',
    ).run(data.nome, data.valor, moment);

    const written = db
      .prepare(
        `SELECT ${COLUMNS} FROM segredo_gancho
          WHERE nome = ? AND revogada_em IS NULL`,
      )
      .get(data.nome) as HookSecretRow | undefined;
    if (written === undefined) throw new Error('the hook secret was not written');

    return { secret: toHookSecret(written), rotated: existing !== undefined };
  })();
}

/**
 * The live value behind a name — the one read the API has no path for.
 *
 * Called by `enqueueHookDeliveries`, at the same point `url` is copied out of
 * the document, and nowhere else. Resolution deliberately does NOT happen at
 * import time: `validateStructure`/`validarEstrutura` are pure and DB-free, and
 * kept in byte-for-byte parity with each other, so a structural check that
 * consulted a database would break that contract for one sibling and not the
 * other. It is the same timing `engine`, `model` and `escalation_policy` already
 * have (`docs/spec/grafo.md`): the document declares, the deployment resolves.
 *
 * @param db Open database.
 * @param name Name the document referenced.
 * @returns The raw key, or `undefined` when the name is unknown or revoked.
 */
export function resolveHookSecret(db: Database, name: string): string | undefined {
  const row = db
    .prepare('SELECT valor FROM segredo_gancho WHERE nome = ? AND revogada_em IS NULL')
    .get(name) as { valor: string } | undefined;
  return row?.valor;
}

/**
 * Every registration ever written, oldest first.
 *
 * One row per REGISTRATION and not one per name: a rotated name appears twice,
 * the revoked one and the live one, and that is the whole point of writing a row
 * instead of overwriting one. Collapsing them here would throw away the history
 * the table exists to keep.
 *
 * @param db Open database.
 * @returns The registrations, without their values.
 */
export function listHookSecretNames(db: Database): HookSecret[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM segredo_gancho ORDER BY id`)
    .all() as HookSecretRow[];
  return rows.map(toHookSecret);
}

/**
 * Revokes the live registration under a name.
 *
 * Calling it twice is not an error and does not move the instant of the first
 * call: revoked is a state, not an event to be counted (the reading
 * `deactivateSubscription` already froze). A name that was never registered is
 * `undefined`, which is what the route turns into a 404.
 *
 * Nothing that was already enqueued is touched. A delivery in flight carries its
 * own copy of the key, because it has to finish against what was declared when
 * it was queued — revoking stops the NEXT firing, never the one already out.
 *
 * @param db Open database.
 * @param name Name to revoke.
 * @param options Injectable clock.
 * @returns The latest registration under that name, or `undefined`.
 */
export function revokeHookSecret(
  db: Database,
  name: string,
  options: ClockOptions = {},
): HookSecret | undefined {
  const clock = options.now ?? now;

  return db.transaction((): HookSecret | undefined => {
    const latest = db
      .prepare(`SELECT ${COLUMNS} FROM segredo_gancho WHERE nome = ? ORDER BY id DESC LIMIT 1`)
      .get(name) as HookSecretRow | undefined;
    if (latest === undefined) return undefined;
    if (latest.revogada_em !== null) return toHookSecret(latest);

    const moment = clock();
    db.prepare(
      'UPDATE segredo_gancho SET revogada_em = ? WHERE nome = ? AND revogada_em IS NULL',
    ).run(moment, name);

    return toHookSecret({ ...latest, revogada_em: moment });
  })();
}
