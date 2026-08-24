/**
 * The reference validator's pinned export names, frozen WHEREVER they appear
 * (t287, FR5).
 *
 * `packages/core/test/domain-graph.test.ts` imports `scripts/validar-grafo.mjs`
 * BY PATH and destructures it by these spellings, `deepEqual`ing its report
 * against `packages/core/src/domain/graph.ts` on every fixture in
 * `schema/exemplos/`; `validate-factory-bundle.mjs` imports `validarGrafo` from
 * the same module. Renaming one of the four turns core's suite red without a
 * line of core changing, so both D18 identifier sweeps mask them — moving them
 * is `scripts/`' own identifier migration, and that ticket does not exist yet.
 *
 * Masking the exact spellings, rather than the words `validar` and `grafo`
 * everywhere, is what keeps the exemption narrow: a NEW `validarAlgumaCoisa` in
 * either swept tree is still flagged.
 *
 * ## Why here, and not in `packages/test-support`
 *
 * The two consumers — `scripts/no-portuguese-identifiers.test.mjs` and
 * `tests/no-portuguese-identifiers.test.mjs` — are the root group of
 * `scripts/run-all-tests.mjs`, which runs them under a plain `node --test` with
 * no tsx loader. `packages/test-support` is TypeScript with no build step, so
 * reaching it from there would mean giving the whole root group a loader for the
 * sake of a four-entry array. Plain JavaScript, next to the sweep that needs it,
 * costs nothing and moves nothing.
 *
 * This is the only declaration of the array; `scripts/no-anti-portuguese-
 * duplication.test.mjs` is what keeps it that way.
 */

/** The four names `packages/core/test/domain-graph.test.ts` pins. */
export const FROZEN_IDENTIFIERS = Object.freeze([
  'validarEstrutura',
  'validarSoundness',
  'validarGrafo',
  'carregarGrafo',
]);
