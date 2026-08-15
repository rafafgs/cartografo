/**
 * The watchdog budget ceiling (t163, FR8).
 *
 * flowpilot's `min()` rule, generalized and given a name: a skill declares how
 * long it needs, the server declares how long anything may take, and the SHORTER
 * of the two wins. A skill can only ever shorten its own leash.
 *
 * It lives apart from both adapters and from the dispatch because it is the one
 * piece of this feature with no I/O, no timer and no engine in it — which is why
 * it is also the one piece with unit tests of its own. Whoever eventually reads
 * a registered skill's `orcamentos` into a `SessionSpec`
 * (`especificacoes/formatos/manifesto-skill.md`, "Estado hoje") calls this and
 * nothing else: the ceiling rule is decided here, once.
 */

/**
 * The budget a session actually runs with.
 *
 * @param declared What the skill asked for, if it asked for anything.
 * @param ceiling The server's own limit for this axis.
 * @returns `ceiling` when nothing usable was declared or the declaration is
 *   longer than the ceiling; `declared` otherwise.
 */
export function resolveBudget(declared: number | undefined, ceiling: number): number {
  // A non-positive declaration is "no override", NEVER "no watchdog". Reading a
  // `0` as "disable" would let a manifest turn off its own safety net through
  // an off-by-one, and the whole point of a budget nobody can raise is that
  // nobody can remove it either.
  if (declared === undefined || declared <= 0) return ceiling;
  return Math.min(declared, ceiling);
}
