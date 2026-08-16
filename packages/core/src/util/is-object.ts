/**
 * The one `isObject` of this package (t210).
 *
 * Seventeen files defined this same three-line guard privately — routes, domain
 * validators, repositories and the CLI commands — with byte-identical bodies.
 * Nothing about it was ever local: it is the first question every hand-written
 * validator in `packages/core` asks of a JSON value that came off the wire.
 *
 * It lives under `src/util/` and not in `routes/common.ts` because `domain/`
 * uses it too, and the domain layer imports nothing from the layers above it
 * (it reaches only its own siblings and `node:` builtins). A leaf module with
 * zero imports of its own is the one shape both sides can depend on without
 * either one gaining a dependency on the other.
 *
 * `packages/core/test/no-duplicate-helpers.test.ts` is the gate that keeps the
 * eighteenth copy from being written.
 */

/**
 * Is this a plain JSON object — not `null`, not an array?
 *
 * The array case is the one that matters in practice: `typeof [] === 'object'`,
 * so a guard without the `Array.isArray` check would let a list through every
 * `body.field` read that follows it.
 *
 * @param value Anything, usually a parsed request body or a decoded column.
 * @returns Whether it can be read as a string-keyed record.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
