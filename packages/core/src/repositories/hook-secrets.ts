/**
 * Access to `hook_secret` — the key a hook REFERENCES (t194).
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
 *   `webhook_subscription.secret`.
 * - **Rotating writes a row; it never rewrites one.** `setHookSecret` revokes
 *   the live row and inserts a new one, in one transaction. `UPDATE value`
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
 * not a weaker posture than `credential`: the signature is an HMAC, so the key
 * has to be REUSED on every delivery and a digest could never produce one. It is
 * exactly what `webhook_subscription.secret` does, and this ticket moves where
 * the key lives, not how it is kept.
 *
 * `now` is injectable (default: the real clock), like every other repository
 * here.
 *
 * The COLUMNS are English since D20's fourth child (t229), and since t289 so is
 * everything above them: {@link HookSecret} IS the row, {@link NewHookSecret}
 * takes the column's own two words, and no `SELECT` here carries an alias.
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
 * This type IS the wire (t226, FR1) AND the row (t289): its three fields are
 * `name`, `created_at` and `revoked_at`, which is what the columns have been
 * called since t229, so {@link COLUMNS} selects them and the reads cast straight
 * onto this. There used to be a `HookSecretRow` beside it spelling the same three
 * fields in Portuguese, and a `toHookSecret` translating between them; both are
 * gone, because a projection whose only job was to rename a column back is a step
 * nobody outside this file could see.
 */
export interface HookSecret {
  /** The name a hook's `destination.secret_ref` points at. */
  name: string;
  created_at: string;
  /** When this registration stopped being the live one; `null` while it is. */
  revoked_at: string | null;
}

/** What the caller declares when registering or rotating a secret. */
export interface NewHookSecret {
  /** The name, as the route read it off the path (already validated). */
  name: string;
  /** The raw HMAC key. Supplied by the caller; the server never generates one. */
  value: string;
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
const COLUMNS = 'name, created_at, revoked_at';

/**
 * Registers a secret under `name`, revoking whatever was live there.
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
    // The column is unnamed on purpose: the only question here is whether a row
    // came back at all, and naming a constant nobody reads would be the one
    // alias this file still wrote.
    const existing: unknown = db
      .prepare('SELECT 1 FROM hook_secret WHERE name = ? LIMIT 1')
      .get(data.name);

    const moment = clock();
    db.prepare(
      'UPDATE hook_secret SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL',
    ).run(moment, data.name);
    db.prepare('INSERT INTO hook_secret (name, value, created_at) VALUES (?, ?, ?)').run(
      data.name,
      data.value,
      moment,
    );

    const written = db
      .prepare(
        `SELECT ${COLUMNS} FROM hook_secret
          WHERE name = ? AND revoked_at IS NULL`,
      )
      .get(data.name) as HookSecret | undefined;
    if (written === undefined) throw new Error('the hook secret was not written');

    return { secret: written, rotated: existing !== undefined };
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
    .prepare('SELECT value FROM hook_secret WHERE name = ? AND revoked_at IS NULL')
    .get(name) as { value: string } | undefined;
  return row?.value;
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
  return db.prepare(`SELECT ${COLUMNS} FROM hook_secret ORDER BY id`).all() as HookSecret[];
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
      .prepare(`SELECT ${COLUMNS} FROM hook_secret WHERE name = ? ORDER BY id DESC LIMIT 1`)
      .get(name) as HookSecret | undefined;
    if (latest === undefined) return undefined;
    if (latest.revoked_at !== null) return latest;

    const moment = clock();
    db.prepare(
      'UPDATE hook_secret SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL',
    ).run(moment, name);

    return { ...latest, revoked_at: moment };
  })();
}
