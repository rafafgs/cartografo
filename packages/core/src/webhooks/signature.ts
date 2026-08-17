/**
 * The signature a webhook delivery carries (t142, FR5).
 *
 * One recipe, published in `docs/spec/webhooks-eventos.md` and implemented here:
 * HMAC-SHA256 of the RAW body, keyed with the subscription's secret, in
 * lowercase hex, prefixed by the algorithm.
 *
 * Two details that are the whole reason a consumer can verify anything:
 *
 * - **The raw body, not the re-serialized object.** Whoever receives has to
 *   compute the HMAC over the bytes that arrived, before parsing: `JSON.parse`
 *   followed by `JSON.stringify` is not guaranteed to give back the same bytes,
 *   and one different byte is a different digest. The delivery sends exactly the
 *   string it signed.
 * - **The `sha256=` prefix.** It costs nothing today and it is what lets a
 *   second algorithm be introduced later without a consumer having to guess
 *   which one it is looking at — the same shape GitHub and Stripe use, for the
 *   same reason.
 *
 * HMAC and not the plain digest of "secret + body": a bare hash is open to
 * length-extension, and HMAC is the construction that exists precisely to key a
 * hash properly. `node:crypto` is already the way this package hashes tokens
 * (`src/repositories/credentials.ts:56-58`); no dependency enters for this.
 */

import { createHmac } from 'node:crypto';

/**
 * Header the delivery carries the signature in.
 *
 * Lowercase because that is how every HTTP/2 and Node receiver sees it; the
 * public spec writes it `X-Cartografo-Signature`, which is the same header —
 * field names are case-insensitive.
 *
 * English since t255, and it is the last thing on this wire that was not: a
 * header name is as much published vocabulary as a JSON key, and no child of
 * D20 ever looked at one — the five surface tickets each swept keys, values,
 * routes and flags. `glossario-wire.md` §1.7 carries the row now, so the next
 * sweep sees it.
 */
export const SIGNATURE_HEADER = 'x-cartografo-signature';

/**
 * Signs the body of one delivery.
 *
 * @param secret The subscription's secret, as the caller supplied it.
 * @param rawBody The exact string that goes on the wire.
 * @returns `sha256=<hex>`, ready to be sent as the header's value.
 */
export function signPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}
